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
import { rmSync } from 'node:fs';
import type {
  AuditEvent,
  ChatDbReader,
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
  Ulid,
} from '@wemessage/core';
import {
  dispatchApproved,
  type DispatchGateDenied,
  runStartupRecovery,
  systemActor,
  SETTING_KILL_SWITCH,
  SETTING_USER_DISCONNECTED,
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
  type IngestChatDbReader,
  type ScanLoopOptions,
  type WakeSignal,
} from '@wemessage/ingest';
import type { GatewayEventPayload } from '@wemessage/protocol';
import { SqliteStore } from '@wemessage/store';
import type { WebSocket } from 'ws';
import { sanitizeInbound } from './sanitize.js';
import { createInboundDispatch } from './adapters/dispatch.js';
import type { AdapterTransportHandle } from './adapters/transport.js';
import type { AgentRequests } from './adapters/submit.js';
import { createScheduler } from './scheduler.js';
import { resolveArming } from './arming.js';
import { buildServer, startServer, type DaemonServer } from './server.js';
import { readConnectionState, runDoctor, type DoctorProbes } from './doctor.js';
import { rotateToken as rotateTokenOnDisk } from './auth.js';

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
  /**
   * s3-execution Scenario 8: the SendBackend `POST /v1/send` dispatches
   * through. REQUIRED for the same reason doctorProbes is: no safe
   * production default exists (a real backend shells out to the real
   * AppleScript runner binary, exactly the class of risk test/arch.spec.ts's
   * gate (a)/(b) forbid in a test), and main.ts always has a real one to
   * pass anyway.
   */
  backend: SendBackend;
  /** Named alongside backend (audit `send.attempted` rows record it). */
  backendName: string;
  /** Injected sleep for dispatchApproved's verify-poll; defaults to real setTimeout. */
  delay?: (ms: number) => Promise<void>;
  /**
   * s3-execution Scenario 11 test seam: overrides the scan loop's reader
   * factory so a test can start a scan burst healthy and later switch it to
   * throw EPERM mid-run (§2.2.3 row 1, "FDA revoked mid-run"). Mirrors the
   * existing `openReader` seam `createScanLoop` already exposes to
   * ingest-level tests (cursor-scan.spec.ts, mutation-scan.spec.ts) — this
   * just threads it one level up so a real `startDaemon()` can be driven the
   * same way. Unset in production: `createScanLoop` falls back to the real
   * `createChatDbReader`.
   */
  scanOpenReader?: ScanLoopOptions['openReader'];
}

const realDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
  /**
   * s4 Scenario 6: run the grace/TTL sweep once, now. Exposed so tests can
   * drive time by hand instead of racing a real interval — production also
   * calls exactly this, on a loop.
   */
  tick(): Promise<void>;
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

/**
 * s3-execution Scenario 9: `routes/send.ts` holds a single `reader:
 * ChatDbReader` reference captured once at `buildServer()` time, but
 * `disconnectDaemon`/`connectDaemon` need to close and reopen the
 * long-lived chat.db handle mid-lifecycle. This wrapper gives the route a
 * STABLE `ChatDbReader`-shaped object that delegates to a swappable
 * `current` underneath; invoking it while closed throws loudly (mirrors
 * `createUnusedChatDbReader`'s throw-not-misbehave convention) rather than
 * silently returning stale/empty data — in practice unreachable in
 * production since the gate denies sends while disconnected, but a real
 * invariant violation should never fail silently.
 */
function createReaderHandle(factory: () => IngestChatDbReader): {
  reader: ChatDbReader;
  close(): void;
  reopen(): void;
} {
  let current: IngestChatDbReader | null = factory();
  const live = (): IngestChatDbReader => {
    if (current === null) {
      throw new Error(
        'chat.db reader used while disconnected (invariant violated: the gate must deny sends before this is ever reached)',
      );
    }
    return current;
  };
  return {
    reader: {
      readSince: (lastRowid) => live().readSince(lastRowid),
      readMutatedSince: (sinceNs) => live().readMutatedSince(sinceNs),
      resolveChat: (handle) => live().resolveChat(handle),
      findOutboundMessage: (q) => live().findOutboundMessage(q),
      readChatTurns: (q) => live().readChatTurns(q),
    },
    close: () => {
      current?.close();
      current = null;
    },
    reopen: () => {
      if (current !== null) return; // already open — idempotent
      current = factory();
    },
  };
}

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

  // Long-lived reader for POST /v1/send (Scenario 8): distinct from
  // recoveryReader above (opened, used, closed within phase 1). This one
  // lives for the daemon's process lifetime (closed in stop() below), but
  // Scenario 9's disconnect/connect can also close/reopen it mid-lifecycle
  // via the handle wrapper — routes/send.ts keeps the stable `.reader`.
  const sendReaderHandle = createReaderHandle(() =>
    createChatDbReader(options.chatDbPath, { clock: options.clock }),
  );

  // s3-execution Scenario 9: a prior run's user-initiated disconnect must
  // survive a restart (RED row 2). Recorded decision: still open the
  // sendReaderHandle above even when latched (harmless — the gate denies
  // sends before it's ever touched) to keep this boot path minimal; only
  // the doctor probe and the watcher/scan below are skipped.
  const userDisconnected = store.getSetting(SETTING_USER_DISCONNECTED) === '1';

  // ---- doctor: capability probes (Scenario 7, §2.2.3) ----
  // Runs after recovery, before the watcher/listen phases — connection
  // state must be known before anything downstream (gate, status route)
  // consults it. Does not add its own bootLog entry (S1's three-phase
  // bootLog is pinned by audit-persistence.spec.ts). Skipped when a human
  // disconnected before this restart: an unconditional probe here would
  // silently reconnect them the moment the daemon comes back up.
  if (!userDisconnected) {
    await runDoctor({
      probes: options.doctorProbes,
      store,
      sink,
      clock: options.clock,
    });
  }

  // ---- phase 2: watch trigger + scan loop (Scenarios 8/10) ----
  // sockets tracked here only for the greeting frame + stop(); event fan-out
  // goes through the sink (whose client set the server populates).
  const sockets = new Set<WebSocket>();

  // Scenario 9 match pipeline. Rules load per burst from store.listRules()
  // (recorded decision: no cache layer — small table, zero invalidation
  // bugs). F-15: in-process (ruleId, guid) seen-set; a restart may re-audit
  // a match (accepted in S2).
  let burstRules: Rule[] = [];
  // s5 Scenario 6: matching AND adapter dispatch now live in one place
  // (`adapters/dispatch.ts`), so the daemon composes it rather than
  // re-implementing single-winner policy here. The transport is reached
  // through a late-bound indirection because `buildServer` (phase 3) owns it
  // and the catch-up scan (phase 2) runs first — during that window nobody is
  // connected, and `adapter.unreachable` is the honest record of it.
  // (a one-field ref rather than a `let`: the closures below capture it
  // before `buildServer` returns, and a `let` assigned exactly once reads as
  // a `const` to the linter even though it cannot be one.)
  const agentTransport: { current: AdapterTransportHandle | undefined } = {
    current: undefined,
  };
  // s5 Scenario 7, same late-bound reason: the issued-correlation registry is
  // built by `buildServer` alongside the socket that reads it.
  const agentRequests: { current: AgentRequests | undefined } = {
    current: undefined,
  };
  const dispatcher = createInboundDispatch({
    store,
    clock: options.clock,
    sink,
    reader: sendReaderHandle.reader,
    transport: {
      isConnected: (id) => agentTransport.current?.isConnected(id) ?? false,
      sendTo: (id, frame) => agentTransport.current?.sendTo(id, frame) ?? false,
    },
    issueRequest: (req) => agentRequests.current?.issue(req),
  });
  const emitWinner = (message: Message): void => {
    // Fire-and-forget on purpose: reading conversation context is I/O, and
    // the ingest loop must not block on a third party's socket. Everything
    // §1.8 cares about (append, then broadcast) happens synchronously inside
    // emitWinner before its first await.
    void dispatcher.emitWinner(message, burstRules).catch((err: unknown) => {
      options.onError?.(
        err instanceof Error ? err : new Error(`dispatch: ${String(err)}`),
      );
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
    ...(options.scanOpenReader ? { openReader: options.scanOpenReader } : {}),
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
        const report = await runDoctor({
          probes: options.doctorProbes,
          store,
          sink,
          clock: options.clock,
        });
        // s3-execution Scenario 11 (§2.2.3 row 1): a scan-time EPERM that
        // resolves to a state the daemon can't usefully tail from must stop
        // the watcher — otherwise every subsequent fs event re-tries the
        // same doomed scan burst forever. 'read-only' keeps tailing (the
        // failure was e.g. automation/messages, not chat.db access).
        if (report.state === 'disconnected' || report.state === 'unsupported') {
          stopWatcher();
        }
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

  // s3-execution Scenario 9: `watcherArmed` tracks whether the tail
  // pipeline is currently live, independent of `createWatchTrigger`'s own
  // start()/stop() idempotency (confirmed directly: safe to call
  // repeatedly) — this guard exists so `connectDaemon`'s idempotent
  // second call doesn't re-run an unnecessary catch-up scan, and so a
  // latched boot can leave the trigger un-started at all.
  let watcherArmed = !userDisconnected;
  const stopWatcher = (): void => {
    if (!watcherArmed) return;
    trigger.stop();
    sendReaderHandle.close();
    watcherArmed = false;
  };
  const rearmWatcher = async (): Promise<void> => {
    if (watcherArmed) return;
    sendReaderHandle.reopen();
    trigger.start();
    await scan();
    watcherArmed = true;
  };
  const closeEventClients = (): void => {
    for (const socket of sockets) socket.close();
  };

  if (!userDisconnected) {
    trigger.start();
    // catch-up scan: rows written while the daemon was down (§1.3.8 restart)
    await scan();
  }
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
    // s4-execution Scenario 5: the draft review surface, same shared sink.
    drafts: { store, clock: options.clock, sink },
    // s5 Scenario 6: the composed daemon serves the adapter registry and the
    // `/v1/agent` socket, which is what makes the dispatch above reachable at
    // all — without it every match would audit `adapter.unreachable` forever.
    adapters: {
      store,
      clock: options.clock,
      sink,
      // s5 Scenario 8: the F-40 redraft re-ask needs conversation context,
      // which is the same chat.db reader POST /v1/send already holds.
      reader: sendReaderHandle.reader,
      ...(options.port !== undefined ? { port: options.port } : {}),
    },
    // s3-execution Scenario 8: doctor/send routes, same shared sink.
    send: {
      store,
      reader: sendReaderHandle.reader,
      backend: options.backend,
      backendName: options.backendName,
      clock: options.clock,
      delay: options.delay ?? realDelay,
      doctorProbes: options.doctorProbes,
      sink,
    },
    // s3-execution Scenario 9: connect/disconnect routes, same shared sink.
    connection: {
      store,
      clock: options.clock,
      sink,
      probes: options.doctorProbes,
      stopWatcher,
      closeEventClients,
      rotateToken: () => rotateTokenOnDisk(options.configDir),
      purge: () => {
        store.close();
        rmSync(options.configDir, { recursive: true, force: true });
      },
      rearmWatcher,
    },
    getStatus: () => ({
      // s3 Scenario 7: probe-derived, persisted state (was the in-memory
      // scanHealthy flag through S1/S2).
      connectionState: readConnectionState(store),
      cursor: store.getCursor(),
      counts: {
        messagesToday: store.countInboundMessagesSince(utcMidnight()),
      },
      // s5 Sc14: F-5's adapter list, filled in by the slice that made
      // adapter health a real column. `AdapterRecord` carries `hasToken`
      // and no hash of any kind (F-43), so the status payload cannot leak
      // credential material by construction.
      adapters: store.listAdapters(),
      // s6 Scenario 11: the last two F-5 placeholders. Both are DERIVED at
      // request time from the same rows the gate reads — the switch is one
      // settings row, the posture is a function of five of them — so a status
      // payload can never disagree with the decision the daemon would make a
      // millisecond later. Neither is cached and neither is a column.
      killSwitch: store.getSetting(SETTING_KILL_SWITCH) === '1',
      armed: resolveArming({ store, clock: options.clock }),
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
  agentTransport.current = server.agentTransport;
  agentRequests.current = server.agentRequests;
  // s4-execution Scenario 6: the grace scheduler. It owns WHEN; the core
  // dispatcher owns HOW, so it gets a dispatch closure rather than the
  // backend. No interval is armed here — startDaemon's caller drives
  // `tick()`, which keeps the deadline where it belongs (the DB) and keeps
  // tests off wall-clock time.
  // s5 Scenario 8: the send path's outcome becomes `draft.feedback` through
  // this daemon-side wrapper. Core still knows nothing about adapters
  // (INV-1) — it returns a DispatchOutcome, and the daemon decides who, if
  // anyone, is told about it.
  const rawDispatch = (draftId: Ulid, approvalId: Ulid) =>
    dispatchApproved(
      {
        store,
        reader: sendReaderHandle.reader,
        backend: options.backend,
        backendName: options.backendName,
        clock: options.clock,
        delay: options.delay ?? realDelay,
        emit: (event: DispatchGateDenied) => {
          for (const socket of sockets) {
            socket.send(
              JSON.stringify({
                event: 'gate.denied',
                reason: event.reason,
                draftId: event.draftId,
                chatGuid: store.getDraft(event.draftId)?.chatGuid ?? '',
              } satisfies GatewayEventPayload),
            );
          }
        },
      },
      draftId,
      approvalId,
    );
  const scheduler = createScheduler({
    store,
    clock: options.clock,
    sink,
    dispatch: server.agentFeedback?.observeDispatch(rawDispatch) ?? rawDispatch,
    onExpired: (draftId) =>
      server.agentFeedback?.emit({
        draftId,
        kind: 'draft_expired',
        actor: systemActor('expiry'),
      }),
    onError: (draftId, err) => {
      options.onError?.(
        err instanceof Error
          ? err
          : new Error(`scheduler: draft ${draftId}: ${String(err)}`),
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
    tick: () => scheduler.tick(),
    stop: async () => {
      trigger.stop();
      for (const socket of sockets) socket.close();
      await server.app.close();
      // Idempotent: a prior `purge:true` disconnect may have already closed
      // both (better-sqlite3's close() tolerates a double call, confirmed
      // directly; the reader handle's close() no-ops when already closed).
      sendReaderHandle.close();
      store.close();
    },
  };
}
