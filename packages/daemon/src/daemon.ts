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
import type { Message, Clock, FsWatcher, SendBackend } from '@wemessage/core';
import {
  runStartupRecovery,
  type StartupRecoveryResult,
} from '@wemessage/core';
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
  bootLog.push('recovery');

  // ---- phase 2: watch trigger + scan loop (Scenarios 8/10) ----
  const sockets = new Set<WebSocket>();
  const broadcast = (payload: GatewayEventPayload): void => {
    const frame = JSON.stringify(payload);
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send(frame);
    }
  };

  const scanLoop = createScanLoop({
    chatDbPath: options.chatDbPath,
    store,
    clock: options.clock,
    onMessage: (message) => {
      broadcast(toGatewayEvent(message));
    },
  });
  let scanHealthy = false;
  const scan = async (): Promise<void> => {
    await scanLoop.scanOnce();
    scanHealthy = true;
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
    rules: { store, clock: options.clock },
    getStatus: () => ({
      // S1 can read but not send: read-only once a scan has succeeded (§3.4).
      connectionState: scanHealthy ? 'read-only' : 'disconnected',
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
          state: scanHealthy ? 'read-only' : 'disconnected',
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
