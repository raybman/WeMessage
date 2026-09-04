/**
 * Doctor probes + degradation engine (s3-execution Scenario 7, §2.2.3;
 * Fable design consult, coordinator-confirmed). Derives `ConnectionState`
 * from four capability probes, persists/emits it only on change, and
 * produces the exact `DoctorReport` shape Scenario 8's `GET /v1/doctor`
 * route serves verbatim.
 *
 * `DoctorProbes` is daemon-local (per C-5: not a new port — the daemon
 * composes sendkit/ingest probe fns itself). It is a REQUIRED field on
 * `StartDaemonOptions` (daemon.ts), matching the `clock`/`watcher`
 * explicit-injection convention: unlike `createAuditSink`'s optional
 * production default (touches only SQLite, no external side effect), a
 * "production default" DoctorProbes would need to invoke sendkit's real
 * `probeAutomation`/`isMessagesRunning`, which shell out to the real
 * AppleScript runner binary (sendkit's exclusive literal, per test/arch.spec.ts
 * gate (a)) — a non-negotiable never-in-tests violation (gate (a)/(b)).
 * Requiring the field means every test call site must pass an explicit
 * fake, structurally closing that hole; `main.ts` composes the real four.
 */
import type { AutomationProbeResult, ExecFn } from '@wemessage/sendkit';
import { isMessagesRunning, probeAutomation } from '@wemessage/sendkit';
import type { FdaProbeResult } from '@wemessage/ingest';
import { probeChatDbReadable } from '@wemessage/ingest';
import type {
  AuditEvent,
  Clock,
  ConnectionState,
  Store,
} from '@wemessage/core';
import {
  SETTING_AUTO_LAUNCH_MESSAGES,
  SETTING_CONNECTION_STATE,
  systemActor,
} from '@wemessage/core';
import type { AuditSink } from './audit-sink.js';

/** Daemon-local capability probe seam (NOT a @wemessage/core port — C-5). */
export interface DoctorProbes {
  /** Sync, no I/O. Production default: macOsMajorFromRelease(os.release()). */
  osMajor(): number;
  fda(): Promise<FdaProbeResult>;
  automation(): Promise<AutomationProbeResult>;
  messagesRunning(): Promise<boolean>;
}

export interface DoctorSnapshot {
  osMajor: number;
  fda: FdaProbeResult;
  automation: AutomationProbeResult;
  messagesRunning: boolean;
  autoLaunch: boolean;
}

export interface DoctorCheck {
  id: 'os' | 'fda' | 'automation' | 'messages';
  status: 'ok' | 'warn' | 'fail';
  detail?: string;
  remediation?: string;
}

export interface DoctorReport {
  state: ConnectionState;
  checks: DoctorCheck[];
  probedAt: string;
}

// Exact remediation/detail copy (Fable design consult point 4) — asserted
// verbatim in doctor.spec.ts. No em dashes, no "green"/"greenlight".
const CHATDB_SCHEMA_HONESTY =
  'chat.db schema verified stable through macOS 26; newer releases may change it without notice.';
const MESSAGES_WARN_3A =
  'Messages is not running; the gateway will launch it automatically on the next send.';
const MESSAGES_FAIL_3B =
  'Messages must be running to send; open Messages, or enable send.autoLaunchMessages to let the gateway launch it.';
// Exported (s3-execution Scenario 9): `connection.ts`'s manual-revocation
// remainder reuses these two verbatim — the disconnect response tells the
// operator what a `POST /v1/disconnect` cannot do for them (revoke OS-level
// grants), and that copy must never drift from what GET /v1/doctor already
// tells them for the same failure.
export const AUTOMATION_DENIED =
  'Automation permission denied; run tccutil reset AppleEvents sh.wemessage.gateway and approve the prompt on the next send. Running unpackaged: grants attach to your terminal/node binary, not sh.wemessage.gateway.';
export const FDA_EPERM =
  'Full Disk Access is not reaching the daemon; on macOS 26, FDA does not propagate to background items. Grant Full Disk Access to wemessaged in System Settings > Privacy & Security, then restart the agent. Running unpackaged: grants attach to your terminal/node binary, not sh.wemessage.gateway.';
const FDA_ENOENT =
  'No Messages history found at the chat.db path; this is not a permission failure. Sign in to Messages and send or receive a message to create it.';
const UNSUPPORTED_OS =
  'This macOS version is unsupported; the gateway requires macOS 13 or newer.';

const MIN_SUPPORTED_MACOS = 13;

/**
 * Darwin-major -> macOS-major (formula, not table): 25+ -> darwin+1 (25 ->
 * 26 Tahoe, 26 -> 27 assumed); 20-24 -> darwin-9 (22 -> 13 Ventura, 23 -> 14
 * Sonoma, 24 -> 15 Sequoia); anything else (incl. non-Darwin / NaN) -> 0,
 * fail-closed to 'unsupported'. Tests feed synthetic release strings; never
 * call real os.release() here (that belongs to main.ts's production wiring).
 */
export function macOsMajorFromRelease(release: string): number {
  const darwinMajor = Number.parseInt(release.split('.')[0] ?? '', 10);
  if (!Number.isFinite(darwinMajor)) return 0;
  if (darwinMajor >= 25) return darwinMajor + 1;
  if (darwinMajor >= 20 && darwinMajor <= 24) return darwinMajor - 9;
  return 0;
}

/**
 * Pure derivation, §2.2.3 precedence: os (handled by the caller, never
 * reached here below the floor) > fda (eperm|error -> disconnected; enoent
 * -> read-only, not a permission failure) > automation (anything not 'ok'
 * -> read-only) > messages (check-only unless autoLaunch is off and
 * Messages isn't running, which forces read-only — row 3b).
 *
 * TEETH #1 lives in the fda branch below: inverting the eperm/error case to
 * 'read-only' makes row 5 (macOS 26 FDA eperm) assert the wrong state.
 */
export function evaluateDoctor(snapshot: DoctorSnapshot): {
  state: ConnectionState;
  checks: DoctorCheck[];
} {
  if (snapshot.osMajor < MIN_SUPPORTED_MACOS) {
    return {
      state: 'unsupported',
      checks: [
        {
          id: 'os',
          status: 'fail',
          detail: `detected macOS ${snapshot.osMajor || 'unknown'}`,
          remediation: UNSUPPORTED_OS,
        },
      ],
    };
  }

  const osCheck: DoctorCheck = {
    id: 'os',
    status: 'ok',
    detail: CHATDB_SCHEMA_HONESTY,
  };

  // fda takes precedence over everything below it: eperm/error and enoent
  // both short-circuit without consulting automation/messages at all (row
  // 5, row 6). TEETH #1: inverting the eperm/error arm to 'read-only' makes
  // row 5 (macOS 26 FDA eperm) assert the wrong state.
  if (snapshot.fda === 'eperm' || snapshot.fda === 'error') {
    return {
      state: 'disconnected',
      checks: [osCheck, { id: 'fda', status: 'fail', remediation: FDA_EPERM }],
    };
  }
  if (snapshot.fda === 'enoent') {
    return {
      state: 'read-only',
      checks: [osCheck, { id: 'fda', status: 'warn', remediation: FDA_ENOENT }],
    };
  }
  const fdaCheck: DoctorCheck = { id: 'fda', status: 'ok' };

  if (snapshot.automation !== 'ok') {
    return {
      state: 'read-only',
      checks: [
        osCheck,
        fdaCheck,
        { id: 'automation', status: 'fail', remediation: AUTOMATION_DENIED },
      ],
    };
  }
  const automationCheck: DoctorCheck = { id: 'automation', status: 'ok' };

  if (!snapshot.messagesRunning) {
    if (!snapshot.autoLaunch) {
      return {
        state: 'read-only',
        checks: [
          osCheck,
          fdaCheck,
          automationCheck,
          { id: 'messages', status: 'fail', remediation: MESSAGES_FAIL_3B },
        ],
      };
    }
    return {
      state: 'fully-connected',
      checks: [
        osCheck,
        fdaCheck,
        automationCheck,
        { id: 'messages', status: 'warn', remediation: MESSAGES_WARN_3A },
      ],
    };
  }

  return {
    state: 'fully-connected',
    checks: [
      osCheck,
      fdaCheck,
      automationCheck,
      { id: 'messages', status: 'ok' },
    ],
  };
}

export interface RunDoctorDeps {
  probes: DoctorProbes;
  store: Store;
  sink: Pick<AuditSink, 'append' | 'broadcast'>;
  clock: Clock;
}

/**
 * Orchestrates: os check first (short-circuits, never calls the other three
 * probes when unsupported — matrix row 7's "-" columns are literal);
 * otherwise resolves all probes + autoLaunch setting, derives, stamps
 * `probedAt`, persists/emits per the only-on-change rule below, returns.
 *
 * Only-on-change (no in-memory cache, Fable design consult point 6): reads
 * the persisted raw string, compares to the derived state; equal -> return
 * without any store/sink write (TEETH #2: deleting this comparison makes
 * every probe emit, breaking the only-on-change assertion). Different
 * (including the first-ever null -> X) -> setSetting -> append -> broadcast,
 * in that order ("the log is the record, the event is the courtesy").
 */
export async function runDoctor(deps: RunDoctorDeps): Promise<DoctorReport> {
  const { probes, store, sink, clock } = deps;

  const osMajor = probes.osMajor();
  let derived: { state: ConnectionState; checks: DoctorCheck[] };
  if (osMajor < MIN_SUPPORTED_MACOS) {
    derived = evaluateDoctor({
      osMajor,
      fda: 'ok',
      automation: 'ok',
      messagesRunning: false,
      autoLaunch: true,
    });
  } else {
    const [fda, automation, messagesRunning] = await Promise.all([
      probes.fda(),
      probes.automation(),
      probes.messagesRunning(),
    ]);
    const autoLaunchRaw = store.getSetting(SETTING_AUTO_LAUNCH_MESSAGES);
    const autoLaunch = autoLaunchRaw !== '0';
    derived = evaluateDoctor({
      osMajor,
      fda,
      automation,
      messagesRunning,
      autoLaunch,
    });
  }

  const previousRaw = store.getSetting(SETTING_CONNECTION_STATE);
  if (previousRaw !== derived.state) {
    store.setSetting(SETTING_CONNECTION_STATE, derived.state);
    const previous: ConnectionState | null = isConnectionState(previousRaw)
      ? previousRaw
      : null;
    const event: AuditEvent = {
      type: 'connection.state-changed',
      from: previous,
      to: derived.state,
    };
    sink.append(event, systemActor('capability-probe'));
    sink.broadcast({ event: 'connection.state', state: derived.state });
  }

  return {
    state: derived.state,
    checks: derived.checks,
    probedAt: clock.now(),
  };
}

function isConnectionState(value: string | null): value is ConnectionState {
  return (
    value === 'fully-connected' ||
    value === 'read-only' ||
    value === 'disconnected' ||
    value === 'unsupported'
  );
}

/**
 * daemon.ts's replacement for the old in-memory `scanHealthy` flag:
 * `getStatus()` and the WS greeting both read the doctor-persisted setting
 * directly, fail-closed to 'disconnected' on unset/unrecognized (same
 * default as readGateSettings) rather than re-deriving anything.
 */
export function readConnectionState(
  store: Pick<Store, 'getSetting'>,
): ConnectionState {
  const raw = store.getSetting(SETTING_CONNECTION_STATE);
  return isConnectionState(raw) ? raw : 'disconnected';
}

/** Production composition (main.ts) — the only place daemon-side code may
 * construct a real ExecFn for sendkit's automation/messages probes; the
 * AppleScript-runner literal itself never appears outside
 * packages/sendkit/src (test/arch.spec.ts gate (a)). */
export function createRealDoctorProbes(deps: {
  osRelease: () => string;
  chatDbPath: string;
  exec: ExecFn;
}): DoctorProbes {
  return {
    osMajor: () => macOsMajorFromRelease(deps.osRelease()),
    fda: () => probeChatDbReadable(deps.chatDbPath),
    automation: () => probeAutomation(deps.exec),
    messagesRunning: () => isMessagesRunning(deps.exec),
  };
}
