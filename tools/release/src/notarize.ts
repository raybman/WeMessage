/**
 * THE NOTARIZATION STATE MACHINE (s9 Sc 8, F-127).
 *
 * Apple's notary service is a submit-then-poll API. `xcrun notarytool` will
 * do the polling itself if given `--wait`, and this module deliberately does
 * not use it, for one reason that is worth stating plainly:
 *
 *   `--wait` couples "how long am I willing to wait" to "have I submitted".
 *   When it gives up, the caller has a non-zero exit and no submission id,
 *   and the only thing a caller can do with that is guess. Guessing wrong in
 *   the obvious direction means submitting again. A second submission of the
 *   same bytes is a SECOND TICKET in Apple's review queue: it does not
 *   replace the first, it does not cancel it, and it doubles the load for
 *   every release that ever times out. F-127 makes this the single hard rule
 *   of this module: `submit` is called exactly once per artefact, and there
 *   is no code path, including every error path, that calls it again.
 *
 * So the poll loop is ours. Timing out yields `NotarizationTimeout` CARRYING
 * THE ID, so an operator can run `notarytool info <id>` an hour later and
 * find out what actually happened, which is the answer `--wait` cannot give.
 *
 * WHY IT SHELLS A TOOL PATH RATHER THAN CALLING `xcrun` DIRECTLY. `tool` and
 * `stapler` are parameters. In production they are `xcrun notarytool` and
 * `xcrun stapler`; in `test/release/notarize.spec.ts` they are two POSIX sh
 * scripts under `fixtures/src/release/` that log every argv they were handed.
 * That is what makes "submit was called exactly once" an assertion about an
 * observed fact rather than about the code's shape, and it is why the rule
 * above can be tested at all without a certificate and a network.
 *
 * THE `tools/` FENCE. Nothing under `tools/` imports a workspace package,
 * not even a type. `node:*` and relative paths are the whole permitted set,
 * which is why the error classes are declared here rather than shared.
 */
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';

/* ── the shapes a credential may take ───────────────────────────────── */

/**
 * The two closed shapes, and the one that is missing on purpose.
 *
 * Apple's `notarytool` accepts a third form: `--apple-id <email>
 * --password <app-specific-password> --team-id <id>`. It is not supported
 * here and never will be, because supporting it means a password on an argv,
 * and an argv is visible to every other process on the machine via `ps`, is
 * echoed by most CI log collectors, and is captured verbatim by the very
 * argv log this module is tested against. There is no way to accept that
 * shape carefully. The App Store Connect API key is a FILE, so the only
 * secret that reaches argv is a path, and a path is not a credential.
 */
export type NotaryKeyArgs = readonly string[];

const API_KEY_SHAPE = ['--key', '--key-id', '--issuer'] as const;
const PROFILE_SHAPE = ['--keychain-profile'] as const;

export class NotaryKeyArgsInvalid extends Error {
  override readonly name = 'NotaryKeyArgsInvalid';
  constructor(readonly given: NotaryKeyArgs) {
    super(
      `keyArgs must be ['--key', <p8>, '--key-id', <id>, '--issuer', <id>] ` +
        `or ['--keychain-profile', <name>]; got ${JSON.stringify(given)}`,
    );
  }
}

/**
 * Reject anything that is not one of the two shapes, by POSITION and not by
 * membership. `keyArgs.includes('--apple-id')` would be the tempting check
 * and it is the wrong one: it enumerates what is forbidden, so it is wrong
 * again the day Apple adds a fourth flag. This enumerates what is allowed,
 * so a new flag is refused until someone decides it should not be.
 */
export function assertKeyArgs(
  keyArgs: NotaryKeyArgs,
): asserts keyArgs is readonly string[] {
  const flagsAt = (shape: readonly string[]): boolean =>
    keyArgs.length === shape.length * 2 &&
    shape.every((flag, i) => keyArgs[i * 2] === flag) &&
    shape.every((_, i) => {
      const v = keyArgs[i * 2 + 1];
      return typeof v === 'string' && v.length > 0 && !v.startsWith('--');
    });
  if (!flagsAt(API_KEY_SHAPE) && !flagsAt(PROFILE_SHAPE))
    throw new NotaryKeyArgsInvalid(keyArgs);
}

/* ── what can go wrong, as types ────────────────────────────────────── */

export interface NotaryIssue {
  readonly severity: string;
  readonly path: string;
  readonly message: string;
  readonly architecture?: string;
}

export class NotarizationSubmitFailed extends Error {
  override readonly name = 'NotarizationSubmitFailed';
  constructor(
    readonly artifact: string,
    readonly stderr: string,
  ) {
    super(`notarytool submit failed for ${artifact}: ${stderr.trim()}`);
  }
}

export class NotarizationRejected extends Error {
  override readonly name = 'NotarizationRejected';
  constructor(
    readonly id: string,
    readonly status: 'Invalid' | 'Rejected',
    readonly issues: readonly NotaryIssue[],
    readonly logPath: string,
  ) {
    super(
      `notarization ${status.toLowerCase()} (${id}); ${String(issues.length)} ` +
        `issue(s), full log at ${logPath}:\n` +
        issues.map((i) => `  - ${i.message} (${i.path})`).join('\n'),
    );
  }
}

/**
 * Carries the id, and that is the entire point of this class existing rather
 * than a plain `Error`. A timeout here does NOT mean the submission failed;
 * it means we stopped watching. The artefact is still in Apple's queue and
 * will still be accepted or rejected. An operator holding this id can find
 * out which; an operator holding "notarization timed out" can only resubmit,
 * which is the one thing F-127 forbids.
 */
export class NotarizationTimeout extends Error {
  override readonly name = 'NotarizationTimeout';
  constructor(
    readonly id: string,
    readonly polls: number,
    readonly waitedMs: number,
  ) {
    super(
      `notarization ${id} was still In Progress after ${String(polls)} polls ` +
        `over ${String(waitedMs)}ms. It has NOT been resubmitted and must not ` +
        `be: run \`notarytool info ${id}\` to see how it finished.`,
    );
  }
}

/**
 * Carries `output`, not `stderr`, and the difference is the whole diagnostic.
 *
 * `xcrun stapler` writes everything it has to say on STDOUT and leaves stderr
 * empty, even when it fails. Measured on 2026-09-09:
 *
 *     $ xcrun stapler staple foo.zip 2>&1 1>/dev/null ; echo $?
 *     66
 *     $ xcrun stapler staple foo.zip 2>/dev/null
 *     Processing: /private/tmp/stapletest/foo.zip
 *     Stapler is incapable of working with ZIP archive files.
 *
 * An earlier version of this class took `stderr`, so every failure it could
 * ever report would have read "stapler exited 66" and then nothing at all.
 * The one line naming the actual problem was being thrown away by the error
 * type whose only job is to carry it.
 */
export class StapleFailed extends Error {
  override readonly name = 'StapleFailed';
  constructor(
    readonly artifact: string,
    readonly code: number,
    readonly output: string,
  ) {
    super(
      `stapler exited ${String(code)} for ${artifact}. Exit 65 usually means ` +
        `the ticket has not reached Apple's CDN yet; wait and staple again. ` +
        `Do NOT resubmit.\n${output.trim()}`,
    );
  }
}

/* ── running a child, as data ───────────────────────────────────────── */

interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * `execFile` and never a shell. Every argument here is either a path chosen
 * by the caller or a submission id printed by Apple, and a shell would give
 * both of them a chance to be something else.
 *
 * A non-zero exit is DATA, not a throw: every caller below has a different
 * and specific thing to say about a failure, and none of them is served by
 * an `Error` whose message is "Command failed".
 */
async function run(
  cmd: string,
  args: readonly string[],
  onDebug?: (line: string) => void,
): Promise<Ran> {
  onDebug?.(`$ ${cmd} ${args.join(' ')}`);
  return await new Promise<Ran>((resolve) => {
    execFile(
      cmd,
      [...args],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code =
          err === null
            ? 0
            : typeof (err as { code?: unknown }).code === 'number'
              ? ((err as { code: number }).code ?? 1)
              : 1;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

/* ── the state machine ──────────────────────────────────────────────── */

export interface NotarizeOptions {
  /** The file to submit. Never opened by this module; only its path is used. */
  readonly artifact: string;
  /** `notarytool`, or the fake. */
  readonly tool: string;
  /** `stapler`, or the fake. */
  readonly stapler: string;
  readonly keyArgs: NotaryKeyArgs;
  /**
   * Budget for POLLING. `submit` is not on this clock, and the guarantee is
   * "no new wait is scheduled past this point", not "this function returns
   * by this point": one `info` call may already be in flight when the budget
   * runs out, and against Apple that call can take seconds. `waitedMs` on
   * the resulting `NotarizationTimeout` is the real elapsed time.
   */
  readonly deadlineMs: number;
  /**
   * First back-off. Doubles, capped at `pollMaxMs`. Real notarization takes
   * minutes, so the production default is coarse; the spec passes something
   * small because it is measuring the SHAPE of the back-off, not its size.
   */
  readonly pollBaseMs?: number;
  readonly pollMaxMs?: number;
  /**
   * Where the runner narrates. It logs the `--key` PATH, because that is what
   * it was given, and it never opens that file, so nothing from inside it can
   * reach here. Sc 8 row 9 plants a sentinel in the p8 and greps every file
   * this run produced.
   */
  readonly onDebug?: (line: string) => void;
  /**
   * Staple the ticket into the artefact after it is Accepted. Defaults to
   * true, and `notarizeRelease` turns it off for exactly one artefact.
   *
   * It is an option rather than something derived from the file extension
   * because the caller knows which artefact is the one users will keep, and
   * a rule inferred from a suffix is a rule nobody can see at the call site.
   * `stapler` accepts `.app`, `.dmg` and `.pkg`, and refuses a zip outright:
   *
   *     $ xcrun stapler staple foo.zip
   *     Stapler is incapable of working with ZIP archive files.   # exit 66
   */
  readonly staple?: boolean;
  /** Injected for the spec. Real code has no reason to pass this. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface NotarizeResult {
  readonly id: string;
  readonly status: 'Accepted';
  readonly polls: number;
  /**
   * Whether the ticket is now INSIDE the artefact. False means the artefact
   * is notarized but still needs a network round trip to Gatekeeper on first
   * launch, which is a real difference to a user who is offline, so it is
   * reported rather than left to be inferred from the options.
   */
  readonly stapled: boolean;
}

interface SubmitJson {
  readonly id?: unknown;
  readonly status?: unknown;
}

const asString = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;

function parseJson(what: string, text: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error(`${what}: not JSON: ${text.slice(0, 200)}`);
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    throw new Error(`${what}: not a JSON object: ${text.slice(0, 200)}`);
  return v as Record<string, unknown>;
}

const defaultSleep = async (ms: number): Promise<void> => {
  await new Promise<void>((ok) => {
    setTimeout(ok, ms);
  });
};

/**
 * Submit one artefact, poll to a terminal state, staple it, validate it.
 *
 * The order of the four is the contract, and three of the transitions are
 * one-way:
 *
 *   submit ──▶ In Progress ──▶ Accepted ──▶ staple ──▶ validate
 *                  │  ▲            │
 *                  └──┘            └─▶ Invalid/Rejected ──▶ log ──▶ throw
 *                back-off                                (never staples)
 *
 * Nothing returns to `submit`. That is the whole diagram.
 */
export async function notarize(
  opts: NotarizeOptions,
): Promise<NotarizeResult> {
  const {
    artifact,
    tool,
    stapler,
    keyArgs,
    deadlineMs,
    pollBaseMs = 15_000,
    pollMaxMs = 60_000,
    onDebug,
    staple = true,
    sleep = defaultSleep,
  } = opts;
  assertKeyArgs(keyArgs);

  /* ── submit. Once. ─────────────────────────────────────────────────── */
  const submitted = await run(
    tool,
    ['submit', artifact, '--output-format', 'json', ...keyArgs],
    onDebug,
  );
  if (submitted.code !== 0)
    throw new NotarizationSubmitFailed(artifact, submitted.stderr);
  const subJson = parseJson('submit', submitted.stdout) as SubmitJson;
  const id = asString(subJson.id);
  if (id === null)
    throw new Error(`submit returned no id: ${submitted.stdout.slice(0, 200)}`);
  onDebug?.(`submitted ${artifact} as ${id}`);

  /* ── poll to a terminal state ──────────────────────────────────────── */
  const started = Date.now();
  let polls = 0;
  let wait = pollBaseMs;
  let status = asString(subJson.status) ?? 'In Progress';

  // The submit response can already be terminal (the `accepted` scenario, and
  // the real service when a resubmission of identical bytes is deduplicated),
  // but its status is not authoritative, so it is confirmed by an `info`
  // rather than trusted. That is why `polls` is at least 1 in every scenario.
  for (;;) {
    const info = await run(
      tool,
      ['info', id, '--output-format', 'json', ...keyArgs],
      onDebug,
    );
    polls += 1;
    if (info.code !== 0)
      throw new Error(
        `notarytool info failed for ${id}: ${info.stderr.trim()}`,
      );
    status = asString(parseJson('info', info.stdout).status) ?? 'In Progress';
    if (status !== 'In Progress') break;

    /*
     * THE DEADLINE BOUNDS WHEN WE STOP SCHEDULING, NOT WHEN WE RETURN, and
     * the difference is worth being precise about because the first version
     * of this loop got it wrong in both directions at once.
     *
     * It threw as soon as `elapsed + wait` would exceed the budget. That
     * abandoned up to one full back-off interval of time the caller had
     * granted: with 100 ms left and a 400 ms interval pending it gave up at
     * 1900 rather than polling once more at 2000. And it still overshot,
     * because the `info` call after the last sleep takes time of its own,
     * which is a few milliseconds against the fake and can be several
     * SECONDS against Apple.
     *
     * So the sleep is clamped to what is left instead. The loop now spends
     * the whole budget and gets one more answer out of it, and the only
     * overshoot left is the duration of a single in-flight `info` — which
     * cannot be avoided without cancelling a request whose answer we want.
     * `waitedMs` reports the truth either way, so nobody has to infer it.
     */
    const elapsed = Date.now() - started;
    const remaining = deadlineMs - elapsed;
    if (remaining <= 0) throw new NotarizationTimeout(id, polls, elapsed);
    await sleep(Math.min(wait, remaining));
    wait = Math.min(wait * 2, pollMaxMs);
  }

  /* ── a terminal state that is not Accepted ─────────────────────────── */
  if (status === 'Invalid' || status === 'Rejected') {
    // Fetch the full log BEFORE throwing, and write it beside the artefact.
    // A rejection whose reasons live only in Apple's database is a rejection
    // an operator has to go and re-fetch by hand, on a CI runner that no
    // longer exists.
    const body = await run(
      tool,
      ['log', id, '--output-format', 'json', ...keyArgs],
      onDebug,
    );
    const logPath = `${artifact}.notarization-log.json`;
    writeFileSync(logPath, body.stdout, 'utf8');
    const parsed =
      body.code === 0 ? parseJson('log', body.stdout) : { issues: [] };
    const raw = Array.isArray(parsed.issues) ? parsed.issues : [];
    const issues: NotaryIssue[] = raw.map((i) => {
      const o = (typeof i === 'object' && i !== null ? i : {}) as Record<
        string,
        unknown
      >;
      return {
        severity: asString(o.severity) ?? 'error',
        path: asString(o.path) ?? '',
        message: asString(o.message) ?? '',
        ...(asString(o.architecture) === null
          ? {}
          : { architecture: asString(o.architecture) as string }),
      };
    });
    throw new NotarizationRejected(id, status, issues, logPath);
  }
  if (status !== 'Accepted')
    throw new Error(`unknown notarization status for ${id}: ${status}`);

  /* ── staple, then validate ─────────────────────────────────────────── */
  if (!staple) {
    onDebug?.(`accepted ${artifact} as ${id}; not stapled, by request`);
    return { id, status: 'Accepted', polls, stapled: false };
  }
  // `${stdout}${stderr}` and not one or the other: stapler uses stdout today,
  // and a future version that switched to stderr would silently empty this
  // message. Concatenating costs nothing and cannot be wrong.
  const stapledRun = await run(stapler, ['staple', artifact], onDebug);
  if (stapledRun.code !== 0)
    throw new StapleFailed(
      artifact,
      stapledRun.code,
      `${stapledRun.stdout}${stapledRun.stderr}`,
    );
  const validated = await run(stapler, ['validate', artifact], onDebug);
  if (validated.code !== 0)
    throw new StapleFailed(
      artifact,
      validated.code,
      `${validated.stdout}${validated.stderr}`,
    );

  return { id, status: 'Accepted', polls, stapled: true };
}

/* ── the two-artefact release sequence ──────────────────────────────── */

export interface NotarizeReleaseOptions
  extends Omit<NotarizeOptions, 'artifact'> {
  readonly zip: string;
  readonly dmg: string;
}

export interface NotarizeReleaseResult {
  readonly zip: NotarizeResult;
  readonly dmg: NotarizeResult;
}

/**
 * Two submissions per release, in this order, and the second only if the
 * first succeeded.
 *
 * The order is not arbitrary. The zip is what a Homebrew cask downloads and
 * what CI uploads first; the DMG is what a human double-clicks. Notarizing
 * the zip first means a failure costs one submission instead of two, and the
 * failure it most often catches (an unsigned helper, a missing entitlement)
 * is a property of the app, which both artefacts contain.
 *
 * SEQUENTIAL AND NOT `Promise.all`, deliberately. Two concurrent submissions
 * of the same app would both be in Apple's queue before either result came
 * back, so a rejection would have already cost two tickets. `await` in
 * sequence is the cheap version of the rule F-127 is about.
 *
 * ONLY THE DMG IS STAPLED, and that asymmetry is forced, not chosen:
 *
 *     $ xcrun stapler staple foo.zip
 *     Processing: /private/tmp/stapletest/foo.zip
 *     Stapler is incapable of working with ZIP archive files.
 *     $ echo $?
 *     66
 *
 * measured on 2026-09-09. An earlier version of this function stapled both,
 * and every row here passed, because the fake stapler exited 0 for anything.
 * Against the real tool that release would have died AFTER Apple accepted
 * it, at the exact moment when the tempting recovery is to submit again.
 * `fixtures/src/release/fake-stapler.sh` now refuses a zip the way the real
 * one does, so this cannot be rewritten back without a red test.
 *
 * WHAT THAT COSTS, AND WHO PAYS IT OFF. The zip's ticket is therefore not
 * inside the zip. Gatekeeper will still clear it, by asking Apple on first
 * launch, so an ONLINE user sees no difference and an offline one sees a
 * refusal. The fix is the one the plan described: unzip, staple the `.app`,
 * re-zip. That is not here, because re-zipping needs `ditto` to preserve the
 * bundle's symlinks and xattrs, `ditto` is macOS-only, and this spec runs on
 * Linux CI too. More to the point, re-archiving is a PACKAGING concern that
 * belongs beside the pack lane that produced the archive, not inside a
 * function whose one job is to talk to Apple correctly. Sc 9's `pack-macos`
 * job owns staple-then-re-zip; this owns the state machine, and reports
 * `stapled: false` on the zip so Sc 9 has something to assert against.
 */
export async function notarizeRelease(
  opts: NotarizeReleaseOptions,
): Promise<NotarizeReleaseResult> {
  const { zip, dmg, ...rest } = opts;
  assertKeyArgs(rest.keyArgs);
  const zipResult = await notarize({ ...rest, artifact: zip, staple: false });
  const dmgResult = await notarize({ ...rest, artifact: dmg, staple: true });
  return { zip: zipResult, dmg: dmgResult };
}
