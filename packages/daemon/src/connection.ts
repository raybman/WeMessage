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
import { basename } from 'node:path';

export type { Supervisor } from './launchd/contract.js';
import { rmSync } from 'node:fs';
import type { AuditSink } from './audit-sink.js';
import {
  asLaunchAgentLabel,
  type LaunchAgentLabel,
  type ServiceManagerRun,
  type Supervisor,
} from './launchd/contract.js';
import { readServiceState } from './launchd/service.js';
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
  | 'launchd-unload'
  | 'purge';

/**
 * `scheduled` is new in S9 Sc 4, and it exists because the other three words
 * would all have been lies.
 *
 * The unload cannot run before the response: a successful `bootout` of our
 * own job ends this process, and the operator would see a connection reset
 * instead of the report they asked for. So it runs after the response is
 * flushed -- which means that at the moment this report is built, launchd
 * has not been asked anything yet.
 *
 * `done` would claim an action that has not happened. `skipped` and `failed`
 * would both be false. `scheduled` says exactly what is true: everything
 * that could be checked has been checked, the audit row is written, and the
 * request is armed. Whether launchd honours it is not knowable from here,
 * by construction, because the process that would report it is the process
 * being unloaded.
 */
export type DisconnectStepStatus = 'done' | 'skipped' | 'failed' | 'scheduled';

export interface DisconnectStep {
  id: DisconnectStepId;
  status: DisconnectStepStatus;
  detail?: string;
  /** Present only on `launchd-unload`, and only when a purge removed it. */
  plistRemoved?: boolean;
}

/** Who, if anyone, is keeping this process alive. */

export interface SupervisionDeps {
  readonly supervisor: Supervisor;
  /** The label from the environment. NOT trusted; validated in phase A. */
  readonly label: string | null;
  /** The guarded runner, or null when nothing supervises us. */
  readonly run: ServiceManagerRun | null;
  /** Where `service.json` lives, read BEFORE a purge can delete it. */
  readonly serviceDir: string;
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
  /** §1.6: who supervises us, and how to ask them to stop. */
  supervision: SupervisionDeps;
  /**
   * Where a deferred unload's failure goes.
   *
   * It cannot go into the report -- the report was sent before the unload
   * ran -- and it cannot go into the audit log, because under `purge` the
   * store is already closed. So the caller decides: the daemon logs it.
   */
  onUnloadError(e: unknown): void;
}

/**
 * What `disconnectDaemon` returns now that one of its steps outlives it.
 *
 * `afterResponse` is `null`, never absent, and never optional: under
 * `exactOptionalPropertyTypes` an optional member would let a caller that
 * forgot to arm it typecheck, and forgetting to arm it is precisely the bug
 * that would leave a supervised daemon running after the operator was told
 * it would stop.
 */
export interface DisconnectOutcome {
  report: DisconnectReport;
  afterResponse: (() => Promise<void>) | null;
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
): DisconnectOutcome {
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

  /*
   * 5. launchd-unload. TWO PHASES, and the split is forced, not stylistic.
   *
   * Everything that can be CHECKED happens here, synchronously, before the
   * response: the supervisor, the label, the label's validity, and whether
   * the label in the environment is the one this config directory actually
   * installed. Every one of those can fail, and every one of those failure
   * modes must reach the operator -- so they must be decided while there is
   * still a response to put them in.
   *
   * The `bootout` itself cannot happen here. It ends this process, and the
   * operator would get a reset socket instead of the report. So it is armed
   * as a thunk the route fires after the response is flushed.
   *
   * The audit row is appended in THIS phase, which makes "audited before the
   * side effect" structurally true rather than merely true today: the row is
   * committed by a synchronous transaction that has already returned before
   * the thunk exists.
   */
  let afterResponse: (() => Promise<void>) | null = null;
  /*
   * The extra line of MANUAL_REVOCATION, when there is one.
   *
   * A plist that survives this disconnect is not a leftover file, it is a
   * job that comes back at the next login: `RunAtLoad` and `KeepAlive` are
   * both true. So the operator is told, by name, what is still on disk and
   * the one command that removes it -- but ONLY when that is actually the
   * situation. A line that appeared after a purge had already deleted the
   * file would be instructions to fix a thing that is not broken, which is
   * how honest copy becomes noise the operator learns to skip.
   */
  let unloadRemainder: string | null = null;
  const sup = deps.supervision;

  const unloadFailed = (detail: string): void => {
    steps.push({ id: 'launchd-unload', status: 'failed', detail });
  };

  if (sup.supervisor !== 'launchd') {
    steps.push({
      id: 'launchd-unload',
      status: 'skipped',
      detail: `not supervised by launchd (supervisor: ${sup.supervisor})`,
    });
  } else if (sup.label === null) {
    unloadFailed('supervised by launchd but no label in the environment');
  } else if (sup.run === null) {
    unloadFailed('supervised by launchd but no service runner is available');
  } else {
    // The label arrives from the environment, so it is a string until this
    // proves otherwise. A refusal here is a FAILED STEP, never a throw: a
    // bad env must not be able to block a disconnect (row 4).
    let branded: LaunchAgentLabel | null = null;
    let refusal: string | null = null;
    try {
      branded = asLaunchAgentLabel(sup.label);
    } catch (e) {
      refusal = e instanceof Error ? e.message : String(e);
    }

    if (branded === null) {
      unloadFailed(refusal ?? 'the label in the environment was refused');
    } else {
      /*
       * AND IT MUST BE OUR OWN. The prefix guard proves the label belongs to
       * this project; it does not prove it belongs to THIS INSTALLATION. The
       * state file does, because `service install` wrote it. A daemon that
       * unloaded whatever label its environment happened to name could be
       * pointed at a sibling install by an env var alone.
       *
       * Read BEFORE the purge step, which deletes the directory it lives in.
       */
      const state = readServiceState(sup.serviceDir);
      if (state === null) {
        unloadFailed('no service state in this config directory');
      } else if (state.label !== sup.label) {
        unloadFailed(
          'the label in the environment is not the one this directory installed',
        );
      } else {
        const label = branded;
        deps.sink.append({ type: 'service.unload_requested', label }, actor);

        /*
         * The plist outlives the process, so a purge that left it behind
         * would bring the daemon back at the next login: the job is
         * `RunAtLoad` and `KeepAlive`. Removing it is therefore part of
         * purging, not part of unloading.
         *
         * The basename check is the same "launchd obeys the file" caution as
         * the installer's: only a file this label would have written is a
         * file this label may delete.
         */
        let plistRemoved = false;
        if (opts.purge && basename(state.plistPath) === `${label}.plist`) {
          try {
            rmSync(state.plistPath, { force: true });
            plistRemoved = true;
          } catch {
            plistRemoved = false;
          }
        }

        steps.push({
          id: 'launchd-unload',
          status: 'scheduled',
          detail: 'unload requested; it runs once this response is sent',
          ...(plistRemoved ? { plistRemoved: true } : {}),
        });

        if (!plistRemoved)
          unloadRemainder =
            `The launch agent is still installed at ${state.plistPath}, ` +
            `and it will start the gateway again at your next login. ` +
            `Run \`wemessaged service uninstall\` to remove it.`;

        const run = sup.run;
        afterResponse = async (): Promise<void> => {
          // NOTHING IN HERE TOUCHES THE STORE. By the time this runs, a
          // purge has closed it, and an append would throw into a context
          // with no response left to carry the error.
          try {
            await run('bootout', label, {});
          } catch (e) {
            deps.onUnloadError(e);
          }
        };
      }
    }
  }

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

  return {
    report: {
      state: 'disconnected',
      steps,
      manualRevocation:
        unloadRemainder === null
          ? MANUAL_REVOCATION
          : [...MANUAL_REVOCATION, unloadRemainder],
    },
    afterResponse,
  };
}

export interface ConnectDeps {
  store: Store;
  sink: Pick<AuditSink, 'append' | 'broadcast'>;
  clock: Clock;
  probes: DoctorProbes;
  /** Re-arms the watch trigger + runs a catch-up scan when doctor allows it. */
  rearmWatcher(): Promise<void>;
  /** s9 Sc4: the reconnect's doctor report says who supervises us too. */
  supervisor: Supervisor;
}

export async function connectDaemon(deps: ConnectDeps): Promise<DoctorReport> {
  deps.store.setSetting(SETTING_USER_DISCONNECTED, '0');
  const report = await runDoctor({
    probes: deps.probes,
    store: deps.store,
    sink: deps.sink,
    clock: deps.clock,
    supervisor: deps.supervisor,
  });
  if (report.state === 'fully-connected' || report.state === 'read-only') {
    await deps.rearmWatcher();
  }
  return report;
}
