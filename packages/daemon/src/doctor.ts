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
import type { Supervisor } from './launchd/contract.js';

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

/**
 * s9 Sc5: which JavaScript runtime answered this report. v2 S2b: and which
 * host it answered for.
 *
 * "Am I running under the signed app" is the difference between a daemon
 * whose TCC grants attach to `sh.wemessage.gateway` and one whose grants
 * attach to whatever terminal launched it. That distinction is already the
 * subject of two remediation strings below ("Running unpackaged: grants
 * attach to your terminal/node binary"), and until Sc5 the report asserted
 * it nowhere.
 *
 * Still TAGGED on `kind`, with one kind left. v2 S6d removed the v1 desktop
 * host's variant along with the app (CHANGELOG, "doctor: runtime kind ...
 * removed"). The tag stays on the wire because every reader already
 * narrows on it, and because a reader that meets a kind it does not know
 * refuses the report rather than guessing at its members; dropping the tag
 * would make the next host a silent change instead of a loud one.
 */
export interface DoctorRuntime {
  kind: 'node';
  /** Who launched this Node. One host, so one literal. */
  host: 'swift';
  /** The Node the Swift app ships, pinned by tools/swift/node.lock.json. */
  node: string;
  /**
   * `process.versions.modules`, the native ABI. This is the number a
   * mismatched prebuild would disagree with, so it is reported as the
   * number it is rather than as a boolean somebody would have to trust.
   */
  abi: number;
}

/** Exactly the two `process.versions` keys `describeRuntime` reads. */
export interface RuntimeVersions {
  node: string;
  modules: string;
}

/** v2 S2b: the environment `describeRuntime` is handed, which it reads ONE variable of. */
export interface RuntimeEnv {
  WEMESSAGE_HOST?: string | undefined;
}

/**
 * Plain Node cannot see who launched it, so the Swift host says so in the
 * environment, `WEMESSAGE_HOST=swift`, the same variable the node-flavour
 * bundle refuses to start without. It is matched exactly: an empty, padded
 * or differently cased value is not the Swift host. Without it the field is
 * genuinely omitted rather than set to a null, or to a guess, that a client
 * would have to decide how to read.
 */
export function describeRuntime(
  v: RuntimeVersions,
  env: RuntimeEnv,
): DoctorRuntime | undefined {
  if (env.WEMESSAGE_HOST !== 'swift') return undefined;
  return { kind: 'node', host: 'swift', node: v.node, abi: Number(v.modules) };
}

export interface DoctorReport {
  state: ConnectionState;
  checks: DoctorCheck[];
  probedAt: string;
  /**
   * s9 Sc4: who is supervising the daemon this report describes.
   *
   * REQUIRED, WITH NO DEFAULT, and that is deliberate. Every other field
   * here is derived from a probe that actually ran; a `supervisor` that
   * defaulted to `'none'` when the caller forgot to pass one would be the
   * single field in this report asserting something nobody measured, and it
   * would assert it most confidently in exactly the case that matters -- a
   * launchd-supervised daemon whose wiring was dropped would report itself
   * unsupervised, and the operator would be told there is no job to unload
   * when there is one running.
   *
   * The remediation copy below already turns on this distinction: the fix
   * for a permission failure is different for a background item launchd
   * restarts than for a binary someone ran in a terminal.
   */
  supervisor: Supervisor;
  /**
   * Present iff a host can be named, which today means the Swift app,
   * declared (see `describeRuntime`). The key is ABSENT, not null, when
   * neither holds: a client reading this over the wire and a caller reading
   * it in process then see the same thing, and neither has to learn that one
   * of them spells "no host I can name" differently.
   */
  runtime?: DoctorRuntime;
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
/*
 * s9 F-142: the second sentence, and why it is not "restart the app".
 *
 * TCC identifies an unsigned app by a hash of the binary, and that hash
 * moves on every build even from byte-identical source, because the Mach-O
 * carries a per-build UUID. So after an update the row in System Settings
 * still says WeMessage and still shows a filled toggle, while the grant it
 * represents belongs to a binary that no longer exists. Full Disk Access
 * has no runtime consent dialog to re-ask, so nothing prompts and nothing
 * looks wrong: reads of chat.db just return EPERM.
 *
 * The remediation therefore has to say REMOVE the existing entry before
 * adding it back. Telling an operator to "grant Full Disk Access" when the
 * toggle is already on reads as a bug in the instructions, and toggling it
 * off and on again re-adds the same dead hash. That is the whole reason
 * this clause is here rather than in the docs only, and it is the cost the
 * unsigned lane actually charges, which the README, the install page and
 * the release notes are each required to state in their own words.
 */
export const FDA_EPERM =
  'Full Disk Access is not reaching the daemon; on macOS 26, FDA does not propagate to background items, and after an update to an unsigned build the existing entry stays switched on while no longer matching this binary. Grant Full Disk Access to WeMessage in System Settings > Privacy & Security > Full Disk Access, removing the entry already listed first if there is one, then restart the agent. Running unpackaged: grants attach to your terminal/node binary, not sh.wemessage.gateway.';
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
 * Messages isn't running, which forces read-only, row 3b). Precedence
 * picks the state; it no longer truncates the checks (s10 Slice 5).
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

  // s10 Slice 5: every check is reported; precedence decides only the
  // STATE. All three probes already ran in parallel (runDoctor), so stopping
  // at the first failure discarded answers we had, and an operator fixing
  // Full Disk Access met the Automation denial only on the next run.
  const fdaCheck: DoctorCheck =
    snapshot.fda === 'eperm' || snapshot.fda === 'error'
      ? { id: 'fda', status: 'fail', remediation: FDA_EPERM }
      : snapshot.fda === 'enoent'
        ? { id: 'fda', status: 'warn', remediation: FDA_ENOENT }
        : { id: 'fda', status: 'ok' };
  const automationCheck: DoctorCheck =
    snapshot.automation !== 'ok'
      ? { id: 'automation', status: 'fail', remediation: AUTOMATION_DENIED }
      : { id: 'automation', status: 'ok' };
  const messagesCheck: DoctorCheck = snapshot.messagesRunning
    ? { id: 'messages', status: 'ok' }
    : snapshot.autoLaunch
      ? { id: 'messages', status: 'warn', remediation: MESSAGES_WARN_3A }
      : { id: 'messages', status: 'fail', remediation: MESSAGES_FAIL_3B };

  const checks = [osCheck, fdaCheck, automationCheck, messagesCheck];

  // State, by precedence. TEETH #1: inverting the eperm/error arm to
  // 'read-only' makes row 5 (macOS 26 FDA eperm) assert the wrong state.
  // enoent is read-only, not a permission failure (row 6). A messages warn
  // (3a, autoLaunch on) does not degrade; a messages fail (3b) does.
  if (snapshot.fda === 'eperm' || snapshot.fda === 'error') {
    return { state: 'disconnected', checks };
  }
  if (
    snapshot.fda === 'enoent' ||
    automationCheck.status !== 'ok' ||
    messagesCheck.status === 'fail'
  ) {
    return { state: 'read-only', checks };
  }
  return { state: 'fully-connected', checks };
}

export interface RunDoctorDeps {
  probes: DoctorProbes;
  /**
   * s7 Sc1: narrowed from the full `Store` to the two settings methods
   * `runDoctor` actually calls — the same idiom `sink` below and
   * `readConnectionState` further down already use. It was declared wide
   * only by habit, and the seven doctor.spec.ts rows that had been passing
   * a two-method fake were type errors nobody could see until this slice
   * turned typechecking on for packages/daemon.
   */
  store: Pick<Store, 'getSetting' | 'setSetting'>;
  sink: Pick<AuditSink, 'append' | 'broadcast'>;
  clock: Clock;
  /**
   * s9 Sc4. Required for the reason `DoctorReport.supervisor` is: this is
   * the only place the value can enter, so an optional one here would put
   * the unmeasured default back in by another door.
   */
  supervisor: Supervisor;
  /**
   * s9 Sc5. OPTIONAL, and the asymmetry with `supervisor` directly above is
   * the point: this one has a correct answer available in-process, so the
   * default is a measurement rather than an assumption. Same idiom as
   * `acquireInstanceLock`'s `opts.pid ?? process.pid`. Tests pass a literal
   * to exercise every branch without needing a second runtime.
   */
  versions?: RuntimeVersions;
  /**
   * v2 S2b. Optional for the same reason as `versions`: the default is the
   * real environment, which is exactly where the Swift host puts
   * `WEMESSAGE_HOST`. Tests pass a literal, so the node variant needs no
   * second process either.
   */
  env?: RuntimeEnv;
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
  const runtime = describeRuntime(
    deps.versions ?? process.versions,
    deps.env ?? process.env,
  );

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
    // Passed straight through, never probed. The daemon cannot discover its
    // own supervisor honestly -- a ppid of 1 means launchd OR an orphan --
    // so this reports what the supervisor itself put in the environment.
    supervisor: deps.supervisor,
    // Spread, not `runtime: maybeUndefined`. Under exactOptionalPropertyTypes
    // the second is a type error, and it would also put a key on the object
    // that JSON.stringify silently drops, so the in-process report and the
    // wire report would disagree about their own shape.
    ...(runtime ? { runtime } : {}),
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
