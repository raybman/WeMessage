/**
 * s3-execution Scenario 9 (§1.3.7, §2.4.1; Fable design consult,
 * independently re-verified against auth.ts/server.ts/daemon.ts/doctor.ts/
 * store.ts/protocol/audit before a line of this file was written): the
 * `disconnect`/`connect` orchestration a human triggers via
 * `POST /v1/disconnect` / `POST /v1/connect` (routes/connection.ts).
 *
 * Ordering (§1.3.7, RED row 8's ordering-recorder assertion):
 *   1. watcher-stop   — stop the tail pipeline first; nothing new ingests
 *      during disconnect (row 1's drain-window guarantee).
 *   2. state          — persist `connection.state = 'disconnected'` +
 *      the `SETTING_USER_DISCONNECTED` latch, audit `connection.state-
 *      changed` (reused from Scenario 7, actor swapped to humanApiActor()
 *      since this transition is human-initiated, not probe-driven).
 *   3. adapter-tokens — `store.clearAdapterTokens()`, audit
 *      `gateway.disconnected` with the count, broadcast the WS twin, THEN
 *      close every connected WS client — in that order, so the frame
 *      reliably lands before the socket closes (row 3;
 *      `AuditSink.broadcast` iterates synchronously before this function's
 *      next line runs closeEventClients()).
 *   4. token-rotation — always rotates, even under `purge` (the freshly
 *      rotated file is deleted a step later when purge runs; §1.3.7's
 *      order holds regardless).
 *   5. launchd        — always 'skipped' in S3 (F-25 honesty: no launchd
 *      packaging exists yet, F-1).
 *   6. purge (optional) — closes the store and deletes the whole config
 *      dir. `server.ts`'s injected `purge()` sets its own `purged` latch
 *      FIRST, before doing the real delete, so every subsequent request
 *      503s even if the delete itself throws partway.
 *
 * `connectDaemon` is the inverse: clear the latch, re-run the Scenario 7
 * doctor engine (which persists/audits/broadcasts on change, same as
 * boot), and re-arm the watcher when the resulting state can send or
 * ingest (`fully-connected` or `read-only`). Idempotent by construction: a
 * second call clears an already-clear latch (no-op), the doctor's own
 * only-on-change rule skips the audit/broadcast on an unchanged state, and
 * `rearmWatcher`'s own armed-guard (daemon.ts) no-ops on an already-armed
 * watcher.
 */
import type {
  AuditEvent,
  Clock,
  ConnectionState,
  Store,
} from '@wemessage/core';
import {
  SETTING_CONNECTION_STATE,
  SETTING_USER_DISCONNECTED,
  humanApiActor,
} from '@wemessage/core';
import type { AuditSink } from './audit-sink.js';
import {
  AUTOMATION_DENIED,
  FDA_EPERM,
  runDoctor,
  type DoctorProbes,
  type DoctorReport,
} from './doctor.js';

export type DisconnectStepId =
  | 'watcher-stop'
  | 'state'
  | 'adapter-tokens'
  | 'token-rotation'
  | 'launchd'
  | 'purge';

export interface DisconnectStep {
  id: DisconnectStepId;
  status: 'done' | 'skipped' | 'failed';
  detail?: string;
}

/**
 * §1.3.7: `POST /v1/disconnect` cannot revoke OS-level TCC grants (Full
 * Disk Access, Automation) on the operator's behalf — those live outside
 * anything this process can touch. Reusing doctor.ts's exact remediation
 * copy verbatim (never reinvented prose) keeps the "how do I actually
 * revoke this at the OS level" story identical wherever the operator reads
 * it (GET /v1/doctor's failing checks, or this response).
 */
export const MANUAL_REVOCATION: readonly string[] = [
  AUTOMATION_DENIED,
  FDA_EPERM,
];

export interface DisconnectReport {
  state: 'disconnected';
  steps: DisconnectStep[];
  manualRevocation: readonly string[];
}

export interface DisconnectDeps {
  store: Pick<Store, 'getSetting' | 'setSetting' | 'clearAdapterTokens'>;
  sink: Pick<AuditSink, 'append' | 'broadcast'>;
  /** Stops the watch trigger + scan loop (daemon.ts closure). Idempotent. */
  stopWatcher(): void;
  /** Closes every connected WS /v1/events client (daemon.ts's `sockets` set). */
  closeEventClients(): void;
  /** Daemon-internal rotation (auth.ts's rotateToken), injected for testability. */
  rotateToken(): string | null;
  /** Closes the store + deletes the config dir. Only invoked when `purge` is requested. */
  purge(): void;
}

function asConnectionState(value: string | null): ConnectionState | null {
  return value === 'fully-connected' ||
    value === 'read-only' ||
    value === 'disconnected' ||
    value === 'unsupported'
    ? value
    : null;
}

export function disconnectDaemon(
  deps: DisconnectDeps,
  opts: { purge: boolean },
): DisconnectReport {
  const actor = humanApiActor();
  const steps: DisconnectStep[] = [];

  // 1. watcher-stop
  deps.stopWatcher();
  steps.push({ id: 'watcher-stop', status: 'done' });

  // 2. state
  const previous = asConnectionState(
    deps.store.getSetting(SETTING_CONNECTION_STATE),
  );
  deps.store.setSetting(SETTING_CONNECTION_STATE, 'disconnected');
  deps.store.setSetting(SETTING_USER_DISCONNECTED, '1');
  const stateEvent: AuditEvent = {
    type: 'connection.state-changed',
    from: previous,
    to: 'disconnected',
  };
  deps.sink.append(stateEvent, actor);
  deps.sink.broadcast({ event: 'connection.state', state: 'disconnected' });
  steps.push({ id: 'state', status: 'done' });

  // 3. adapter-tokens: revoke, audit, broadcast the WS twin, THEN close
  // sockets — in that order (row 3: the frame must land before close()).
  const revokedAdapterTokens = deps.store.clearAdapterTokens();
  deps.sink.append(
    {
      type: 'gateway.disconnected',
      reason: 'user-disconnect',
      revokedAdapterTokens,
      purge: opts.purge,
    },
    actor,
  );
  deps.sink.broadcast({
    event: 'gateway.disconnected',
    reason: 'user-disconnect',
  });
  deps.closeEventClients();
  steps.push({
    id: 'adapter-tokens',
    status: 'done',
    detail: `revoked ${revokedAdapterTokens} adapter token(s)`,
  });

  // 4. token-rotation
  const rotated = deps.rotateToken();
  steps.push(
    rotated !== null
      ? { id: 'token-rotation', status: 'done' }
      : {
          id: 'token-rotation',
          status: 'failed',
          detail: 'could not rewrite the token file',
        },
  );

  // 5. launchd (F-25 honesty: no launchd packaging exists in S3, F-1)
  steps.push({
    id: 'launchd',
    status: 'skipped',
    detail: 'not running under launchd (dev mode)',
  });

  // 6. purge (optional, always last)
  if (opts.purge) {
    deps.purge();
    steps.push({
      id: 'purge',
      status: 'done',
      detail: 'store closed, config directory deleted',
    });
  } else {
    steps.push({
      id: 'purge',
      status: 'skipped',
      detail: 'purge not requested',
    });
  }

  return { state: 'disconnected', steps, manualRevocation: MANUAL_REVOCATION };
}

export interface ConnectDeps {
  store: Store;
  sink: Pick<AuditSink, 'append' | 'broadcast'>;
  clock: Clock;
  probes: DoctorProbes;
  /** Re-arms the watch trigger + runs a catch-up scan when doctor allows it. */
  rearmWatcher(): Promise<void>;
}

export async function connectDaemon(deps: ConnectDeps): Promise<DoctorReport> {
  deps.store.setSetting(SETTING_USER_DISCONNECTED, '0');
  const report = await runDoctor({
    probes: deps.probes,
    store: deps.store,
    sink: deps.sink,
    clock: deps.clock,
  });
  if (report.state === 'fully-connected' || report.state === 'read-only') {
    await deps.rearmWatcher();
  }
  return report;
}
