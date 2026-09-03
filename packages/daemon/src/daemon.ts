/**
 * Daemon composition (Scenario 11, spec Part 2 #11): the full tail pipeline
 * watcher -> scan -> normalize -> store mirror -> WS event emission, plus
 * startup T-9.3 recovery.
 *
 * Boot order (§2.5 "runs cursor + send-ledger recovery before serving"):
 *   1. recovery  — cursor healing + send-ledger reconciliation (Scenario 9)
 *   2. watcher   — watch trigger armed (Scenario 10) + initial catch-up scan
 *   3. listen    — HTTP/WS starts serving only after 1 and 2
 *
 * F-1: foreground process, no launchd packaging in S1.
 */
import type {
  AuditEvent,
  Clock,
  CursorHealReason,
  DraftError,
  FsWatcher,
  Message,
  MessageGuid,
  RecoveryAuditEvent,
  Rule,
  SendBackend,
  Store,
} from '@wemessage/core';
import {
  evaluateRules,
  runStartupRecovery,
  systemActor,
  type StartupRecoveryResult,
} from '@wemessage/core';
import {
  createAuditSink as defaultCreateAuditSink,
  type AuditSink,
} from './audit-sink.js';
import {
  createChatDbReader,
  createScanLoop,
  createWatchTrigger,
  type WakeSignal,
} from '@wemessage/ingest';
import type { GatewayEventPayload } from '@wemessage/protocol';
import { SqliteStore } from '@wemessage/store';
import type { WebSocket } from 'ws';
import { sanitizeInbound } from './sanitize.js';
import { buildServer, startServer, type DaemonServer } from './server.js';
import { readConnectionState, runDoctor, type DoctorProbes } from './doctor.js';

export interface StartDaemonOptions {
  /** Config dir: token file + our SQLite store live here (§2.6, §2.3). */
  configDir: string;
  /** Path to the chat.db to tail (fixture in tests, ~/Library/Messages live). */
  chatDbPath: string;
  clock: Clock;
  /** FsWatcher port — fake in tests, createNodeFsWatcher in production. */
  watcher: FsWatcher;
  /** Optional WakeSignal (F-9); production uses createClockSkewWakeSignal. */
  wake?: WakeSignal;
  /** Fixed port (default: ephemeral). Production passes 47100 (§2.6). */
  port?: number;
  /** Pipeline errors (scan failures etc.); loop stays alive regardless. */
  onError?: (error: unknown) => void;
  /**
   * §1.8 chokepoint factory — test seam (Scenario 9 asserts append-before-
   * broadcast via an injected recording sink). Production omits it.
   */
  createAuditSink?: (deps: { store: Store; clock: Clock }) => AuditSink;
  /**
   * Doctor's capability-probe seam (s3-execution Scenario 7). REQUIRED, not
   * optional-with-a-production-default: unlike createAuditSink's default
   * (SQLite only), a "default" DoctorProbes would need to invoke sendkit's
   * real probeAutomation/isMessagesRunning, which shell out to the real
   * AppleScript runner binary — never allowed in a test (test/arch.spec.ts
   * gate (a)/(b)).
   * Requiring this field forces every call site (including every existing
   * test) to pass an explicit fake; main.ts composes the real four.
   */
  doctorProbes: DoctorProbes;
}

/**
 * S1's in-memory recovery trail -> the persisted §2.4.4 audit vocabulary
 * (Scenario 9, S1 deviation #1). Field shapes are pinned by the push sites
 * in core/drafts/recovery.ts; the casts narrow that structural contract.
 */
function toRecoveryAuditEvent(entry: RecoveryAuditEvent): AuditEvent {
  const detail = entry.detail;
  if (entry.event === 'cursor.recovery') {
    return {
      type: 'recovery.cursor',
      reason: detail['reason'] as CursorHealReason,
      lastRowid: detail['lastRowid'] as number,
    };
  }
  const draftId = detail['draftId'] as string;
  if (detail['outcome'] === 'sent') {
    return {
      type: 'recovery.draft',
      draftId,
      outcome: 'sent',
      sentMessageGuid: detail['sentMessageGuid'] as MessageGuid,
    };
  }
  return {
    type: 'recovery.draft',
    draftId,
    outcome: 'failed',
    code: detail['code'] as DraftError['code'],
  };
}

export interface RunningDaemon {
  server: DaemonServer;
  port: number;
  store: SqliteStore;
  /** Boot phases in execution order — must be recovery, watcher, listen. */
  bootLog: string[];
  /** T-9.3 result (§2.5: recovery runs before serving). */
  recovery: StartupRecoveryResult;
  stop(): Promise<void>;
}

/** S1 has no sendkit: recovery consumes SendBackend as a must-not-call fake (F-2). */
const mustNotCallSendBackend: SendBackend = {
  isAvailable: () => {
    throw new Error('SendBackend must never be called in S1 (INV-2, F-2)');
  },
  send: () => {
    throw new Error('SendBackend must never be called in S1 (INV-2, F-2)');
  },
};

/** Domain Message -> §3.4 wire event, sanitized at the boundary (§2.4.5). */
export function toGatewayEvent(message: Message): GatewayEventPayload {
  if (message.kind === 'edit') {
    return {
      event: 'message.edited',
      guid: message.guid,
      newText: message.text,
    };
  }
  if (message.kind === 'unsend') {
    return { event: 'message.unsent', guid: message.guid };
  }
  return { event: 'message.received', message: sanitizeInbound(message) };
}

export async function startDaemon(
  options: StartDaemonOptions,
): Promise<RunningDaemon> {
  const bootLog: string[] = [];
  const store = new SqliteStore({
    dir: options.configDir,
    clock: options.clock,
  });
  // ONE §1.8 chokepoint for the whole daemon: recovery trail, pipeline
  // events, and the rule CRUD routes all append/broadcast through it.
  const sink = (options.createAuditSink ?? defaultCreateAuditSink)({
    store,
    clock: options.clock,
  });

  // ---- phase 1: recovery (T-9.3) before anything serves (§2.5) ----
  const recoveryReader = createChatDbReader(options.chatDbPath, {
    clock: options.clock,
  });
  let recovery: StartupRecoveryResult;
  try {
    recovery = await runStartupRecovery({
      store,
      reader: recoveryReader,
      sendBackend: mustNotCallSendBackend,
      clock: options.clock,
    });
  } finally {
    recoveryReader.close();
  }
  // Persist the S1 in-memory trail NOW — phase 1, before the watcher arms
  // and before listen (§2.5; S1 deviation #1 resolved). F-16 system actor.
  for (const entry of recovery.audit) {
    sink.append(toRecoveryAuditEvent(entry), systemActor('recovery'));
  }
  bootLog.push('recovery');

  // ---- doctor: capability probes (Scenario 7, §2.2.3) ----
  // Runs after recovery, before the watcher/listen phases — connection
  // state must be known before anything downstream (gate, status route)
  // consults it. Does not add its own bootLog entry (S1's three-phase
  // bootLog is pinned by audit-persistence.spec.ts).
  await runDoctor({
    probes: options.doctorProbes,
    store,
    sink,
    clock: options.clock,
  });

  // ---- phase 2: watch trigger + scan loop (Scenarios 8/10) ----
  // sockets tracked here only for the greeting frame + stop(); event fan-out
  // goes through the sink (whose client set the server populates).
  const sockets = new Set<WebSocket>();

  // Scenario 9 match pipeline. Rules load per burst from store.listRules()
  // (recorded decision: no cache layer — small table, zero invalidation
  // bugs). F-15: in-process (ruleId, guid) seen-set; a restart may re-audit
  // a match (accepted in S2).
  let burstRules: Rule[] = [];
  const seenMatches = new Set<string>();
  const emitWinner = (message: Message): void => {
    // F-12: core returns the FULL ordered list (priority ASC, id ASC);
    // the daemon enforces single winner by taking the head.
    const winner = evaluateRules(burstRules, message, {
      // §1.3.8 edit re-match predicate; drafts do not exist until S4.
      hasDraftForMessage: () => false,
    })[0];
    if (winner === undefined) return;
    const seenKey = `${winner.id}\u0000${message.guid}`;
    if (seenMatches.has(seenKey)) return;
    seenMatches.add(seenKey);
    // §1.8: the log is the record, the event is the courtesy — append first.
    sink.append(
      {
        type: 'rule.matched',
        guid: message.guid,
        ruleId: winner.id,
        adapterId: winner.adapterId,
        ruleName: winner.name,
      },
      systemActor('rule-engine'),
    );
    sink.broadcast({
      event: 'rule.matched',
      guid: message.guid,
      ruleId: winner.id,
      adapterId: winner.adapterId,
    });
  };
  // Both ingest paths (new rows + Scenario 8 mutation sweep) deliver here.
  const deliver = (message: Message): void => {
    const payload = toGatewayEvent(message);
    // §2.4.4: mutation occurrences are audit material now that audit exists.
    if (payload.event === 'message.edited') {
      sink.append(
        { type: 'message.edited', guid: message.guid },
        systemActor('ingest'),
      );
    } else if (payload.event === 'message.unsent') {
      sink.append(
        { type: 'message.unsent', guid: message.guid },
        systemActor('ingest'),
      );
    }
    sink.broadcast(payload);
    emitWinner(message);
  };

  const scanLoop = createScanLoop({
    chatDbPath: options.chatDbPath,
    store,
    clock: options.clock,
    onMessage: deliver,
    onMutation: deliver,
    onDecodeFailed: (signal) => {
      // §2.2.1 degrade signal, persisted since Scenario 9 (S1 deviation #1).
      sink.append(
        {
          type: 'ingest.decode-failed',
          guid: signal.guid,
          sourceRowid: signal.sourceRowid,
          reason: signal.reason,
        },
        systemActor('ingest'),
      );
    },
  });
  const scan = async (): Promise<void> => {
    burstRules = store.listRules();
    try {
      await scanLoop.scanOnce();
    } catch (err) {
      // §2.2.3: a scan hitting EPERM/EACCES means FDA was revoked mid-run
      // (or never propagated, macOS 26) — re-probe immediately rather than
      // waiting for the next GET /v1/doctor / POST /v1/connect. The scan
      // error still propagates to onError afterward; the loop keeps going.
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'EPERM' || code === 'EACCES') {
        await runDoctor({
          probes: options.doctorProbes,
          store,
          sink,
          clock: options.clock,
        });
      }
      throw err;
    }
  };
  const trigger = createWatchTrigger({
    chatDbPath: options.chatDbPath,
    scan,
    watcher: options.watcher,
    clock: options.clock,
    ...(options.wake ? { wake: options.wake } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
  });
  trigger.start();
  // catch-up scan: rows written while the daemon was down (§1.3.8 restart)
  await scan();
  bootLog.push('watcher');

  // ---- phase 3: HTTP/WS listen ----
  const utcMidnight = (): string => {
    const now = new Date(options.clock.now());
    now.setUTCHours(0, 0, 0, 0);
    return now.toISOString();
  };
  const server = await buildServer({
    configDir: options.configDir,
    // S2 Scenario 7: rule CRUD + test routes on the composed daemon.
    rules: { store, clock: options.clock, sink },
    getStatus: () => ({
      // s3 Scenario 7: probe-derived, persisted state (was the in-memory
      // scanHealthy flag through S1/S2).
      connectionState: readConnectionState(store),
      cursor: store.getCursor(),
      counts: {
        messagesToday: store.countInboundMessagesSince(utcMidnight()),
      },
      adapters: [], // Open flag F-5: adapter health lands S5
      killSwitch: null, // S4
      armed: null, // S6
    }),
    onEventsClient: (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      // greeting frame (§3.4 connection.state): proves the stream is live
      socket.send(
        JSON.stringify({
          event: 'connection.state',
          state: readConnectionState(store),
        } satisfies GatewayEventPayload),
      );
    },
  });
  const port = await startServer(
    server,
    options.port === undefined ? undefined : { port: options.port },
  );
  bootLog.push('listen');

  return {
    server,
    port,
    store,
    bootLog,
    recovery,
    stop: async () => {
      trigger.stop();
      for (const socket of sockets) socket.close();
      await server.app.close();
      store.close();
    },
  };
}
