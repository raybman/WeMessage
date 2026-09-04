/**
 * s6 Scenario 12 — the S6 operator surface of the CLI, as pure functions.
 *
 * Split out of `bin.ts` for the reason every renderer in this package is
 * split out of it: `bin.ts` runs `program.parseAsync(process.argv)` as a
 * module side effect the instant it is imported, so nothing in it can be
 * unit-tested (see `purge.ts`'s header, and `adapters.ts`, and `watch.ts`).
 * What lives here is everything about `windows`, `pause`, `resume`, `mode`
 * and the armed line on `status` that is a function of a payload rather
 * than of a socket.
 *
 * Two rules govern the whole file.
 *
 * **No colour, at all (C-9).** The wireframe renders armed as a GREEN
 * filled dot (`ui-design-integration.md` §2.3). A terminal transcript here
 * gets no ANSI whatsoever, so the translation is: the dot carries the
 * state (● armed, ○ held) and UPPERCASE carries the emphasis the wireframe
 * gets from weight. `windows-cli.spec.ts › status transcript contains no
 * ANSI escape` is the guard, and it sweeps every posture the renderer can
 * reach, because a colour reintroduced on one branch is still a colour.
 *
 * **One verb, one HTTP call.** The CLI is a thin client (§2.5) and reaches
 * the daemon only through `@wemessage/client`, whose every method is a
 * single request. `resume` is the ONE composed verb in the CLI, and it is
 * composed here, in the open, with its cost asserted at both ends.
 */
import type {
  ArmingStatePayload,
  AuditRowPayload,
  KillSwitchResult,
  PauseResult,
  RespondMode,
  SchedulePayload,
  ScheduleWindowPayload,
  StatusPayload,
  Weekday,
} from '@wemessage/client';

/** §3.8 house style: a 12-column label, one space, the value. */
function field(label: string, value: string): string {
  return `${`${label}:`.padEnd(12)} ${value}`;
}

/** What `/v1/status` reports when a server has no store to derive from. */
const UNREPORTED = '(not reported)';

// ---------------------------------------------------------------------------
// windows (the CLI noun) / schedules (the resource) — F-76
// ---------------------------------------------------------------------------

const WEEK_ORDER: readonly Weekday[] = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
];

/**
 * One window, on one line, always.
 *
 * `end < start` is a window that crosses midnight — ONE window, per §2.3 and
 * the wireframe's single-window model — and it is rendered as one span with
 * an explicit `(+1d)` marker rather than split into a 22:00-24:00 leg and a
 * 00:00-02:00 leg. The split version reads as two rules an operator can edit
 * independently, which is a lie about a row they cannot.
 */
export function renderWindow(window: ScheduleWindowPayload): string {
  const wraps = window.end < window.start;
  return `${window.days.join(',')} ${window.start}-${window.end}${
    wraps ? ' (+1d)' : ''
  }`;
}

export function renderWindows(
  windows: readonly ScheduleWindowPayload[],
): string {
  return windows.map(renderWindow).join('; ');
}

const COLUMNS = ['ID', 'NAME', 'TZ', 'ENABLED', 'WINDOWS'] as const;

/**
 * Fixed-width columns with two-space gutters — the same shape as `drafts
 * list` and `adapters list`, and deliberately NOT markdown pipes: every
 * table this CLI prints is read in a terminal, where alignment is the only
 * thing that makes a column a column.
 */
export function renderScheduleTable(
  schedules: readonly SchedulePayload[],
): string {
  if (schedules.length === 0) return 'no windows';
  const rows = schedules.map((schedule) => [
    schedule.id,
    schedule.name,
    schedule.timezone,
    schedule.enabled ? 'yes' : 'no',
    renderWindows(schedule.windows),
  ]);
  const widths = COLUMNS.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, i) =>
        i === cells.length - 1 ? cell : cell.padEnd(widths[i] ?? 0),
      )
      .join('  ');
  return [line([...COLUMNS]), ...rows.map(line)].join('\n');
}

/** Single-schedule detail, for `windows add`/`edit`'s human output. */
export function renderSchedule(schedule: SchedulePayload): string {
  return [
    field('id', schedule.id),
    field('name', schedule.name),
    field('timezone', schedule.timezone),
    field('enabled', schedule.enabled ? 'yes' : 'no'),
    field('windows', renderWindows(schedule.windows)),
  ].join('\n');
}

export type WindowSpec =
  { ok: true; window: ScheduleWindowPayload } | { ok: false; message: string };

const WINDOW_RE = /^(\S+)\s+(\d{2}:\d{2})-(\d{2}:\d{2})$/;

/**
 * `--window "mon,tue,wed 09:00-17:00"`.
 *
 * Parsed here rather than on the wire because a malformed spec is a USAGE
 * error (§3.8 exit 2, "every validation not expressible as a daemon 400
 * lives here"): the route's `invalid-window` 400 answers a different
 * question (is this a legal window?), and it cannot see the string the
 * operator actually typed. Both messages quote that string back, because
 * "invalid window" on its own sends somebody hunting through four flags.
 */
export function parseWindowSpec(raw: string): WindowSpec {
  const match = WINDOW_RE.exec(raw.trim());
  if (match === null) {
    return {
      ok: false,
      message: `--window "${raw}": expected "<days> HH:MM-HH:MM", e.g. "mon,tue 09:00-17:00"`,
    };
  }
  const [, rawDays = '', start = '', end = ''] = match;
  const days: Weekday[] = [];
  for (const token of rawDays.split(',')) {
    if (!(WEEK_ORDER as readonly string[]).includes(token)) {
      return {
        ok: false,
        message: `--window "${raw}": unknown day "${token}" (use ${WEEK_ORDER.join(',')})`,
      };
    }
    if (!days.includes(token as Weekday)) days.push(token as Weekday);
  }
  return { ok: true, window: { days, start, end } };
}

// ---------------------------------------------------------------------------
// the armed line on `status` — row 5
// ---------------------------------------------------------------------------

/**
 * How long until this posture next changes, in the two coarsest units that
 * still say something. `now` rather than a negative number for a horizon
 * that has already passed: the daemon derives arming per request, so a
 * lapsed deadline means the next read will differ, not that time ran
 * backwards.
 */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return 'now';
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return '<1m';
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${String(days)}d ${String(hours)}h`;
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`;
  return `${String(minutes)}m`;
}

/**
 * ● ARMED / ○ HELD, plus the reason and a countdown when there is a real
 * horizon to count to.
 *
 * `null` is the store-less server (Sc 11) and renders as unreported, not as
 * a hold: naming a hold that does not exist is the one thing this line must
 * never do. And a hold with `until: null` prints no countdown at all rather
 * than a fabricated one — "kill switch, indefinitely" is the truth.
 */
export function renderArmed(
  armed: ArmingStatePayload | null,
  nowMs: number,
): string {
  if (armed === null) return UNREPORTED;
  const horizon =
    armed.until === null
      ? ''
      : ` until ${armed.until} (${formatCountdown(Date.parse(armed.until) - nowMs)})`;
  return armed.armed
    ? `● ARMED${horizon}`
    : `○ HELD: ${armed.reason}${horizon}`;
}

export function renderStatus(status: StatusPayload, nowMs: number): string {
  const cursor = status.cursor
    ? `rowid ${String(status.cursor.lastRowid)} @ ${status.cursor.lastScanAt}`
    : 'none';
  return [
    field('connection', status.connectionState),
    field('armed', renderArmed(status.armed, nowMs)),
    field(
      'kill switch',
      status.killSwitch === null
        ? UNREPORTED
        : status.killSwitch
          ? 'on'
          : 'off',
    ),
    field('cursor', cursor),
    field('today', `${String(status.counts.messagesToday)} message(s)`),
    field('adapters', String(status.adapters.length)),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// the global mode — row 4a
// ---------------------------------------------------------------------------

const RESPOND_MODES: readonly RespondMode[] = ['draft-only', 'auto'];

export function isRespondMode(raw: string): raw is RespondMode {
  return (RESPOND_MODES as readonly string[]).includes(raw);
}

/**
 * The current `send.globalMode`, READ from the audit log.
 *
 * F-77 ratified exactly one route for this setting, a POST, and deferred the
 * general settings API to S7 — so there is no GET to ask. The audit log is
 * not a workaround here, it is the complete record: `send.globalMode` has
 * precisely one writer in the entire system (`POST /v1/toggles/global-mode`)
 * and that writer appends `arming.mode-changed` on every success, before it
 * answers. So the newest such row IS the setting, and no row at all means
 * the S1 default the setting shipped with and nothing has ever changed.
 *
 * A row it cannot read falls back to `draft-only` rather than guessing:
 * every wrong answer here is a claim about how much autonomy the daemon has,
 * and only one direction of that mistake is safe.
 */
export function resolveGlobalMode(
  rows: readonly AuditRowPayload[],
): RespondMode {
  for (const row of rows) {
    let event: { type?: unknown; mode?: unknown };
    try {
      event = JSON.parse(row.eventJson) as { type?: unknown; mode?: unknown };
    } catch {
      continue;
    }
    if (event.type !== 'arming.mode-changed') continue;
    if (typeof event.mode === 'string' && isRespondMode(event.mode)) {
      return event.mode;
    }
  }
  return 'draft-only';
}

export function renderMode(mode: RespondMode): string {
  return field('mode', mode);
}

// ---------------------------------------------------------------------------
// typed confirmations — rows 6 and 4a
// ---------------------------------------------------------------------------

/**
 * The phrase for `contacts set <handle> auto` is the HANDLE itself.
 *
 * §2.4.3: opting a contact into `auto` grants that sender indirect access to
 * an agent, so the ceremony has to be specific to the sender. Typing "yes"
 * proves you pressed a key; typing the handle proves you read which
 * conversation you were about to hand over.
 */
export function contactAutoPhrase(handle: string): string {
  return handle;
}

export function contactAutoPrompt(handle: string): string {
  return `auto lets an agent answer ${handle} without you. Type "${handle}" to confirm: `;
}

/**
 * The global mode has a larger blast radius than any single contact: it is
 * the top rung of §2.4.3's ladder, and until it says `auto` no contact and
 * no rule can reach `auto` either (F-77). So it gets its own phrase rather
 * than sharing the contact one.
 */
export const GLOBAL_AUTO_PHRASE = 'enable auto';
export const GLOBAL_AUTO_PROMPT =
  'auto lets an agent answer every auto contact and rule without you. ' +
  `Type "${GLOBAL_AUTO_PHRASE}" to confirm: `;

export interface ConfirmDeps {
  isTTY: boolean;
  ask(): Promise<string>;
}

/**
 * Non-TTY stdin refuses outright and does not even ask, the same rule
 * `confirmPurge` follows and for the same reason: reading the phrase off a
 * pipe would let `echo "enable auto" | wemessage mode auto` defeat the
 * entire point. `--yes` is the sanctioned scripting path, and callers check
 * it before ever reaching this function.
 */
export async function confirmTyped(
  deps: ConfirmDeps,
  phrase: string,
): Promise<boolean> {
  if (!deps.isTTY) return false;
  return (await deps.ask()).trim() === phrase;
}

// ---------------------------------------------------------------------------
// resume — the one composed verb (row 8)
// ---------------------------------------------------------------------------

export interface ResumeClient {
  status(): Promise<StatusPayload>;
  setKillSwitch(
    on: boolean,
    opts?: { circuit?: boolean },
  ): Promise<KillSwitchResult>;
  resume(): Promise<PauseResult>;
}

export interface ResumeReport {
  /** The post-condition, always: after `resume` the kill switch is off. */
  on: false;
  /** Whether THIS command lifted it, as opposed to finding it already off. */
  killSwitchCleared: boolean;
  pauseCleared: boolean;
  /** `null` when `--circuit` was not asked for: the breaker was not looked at. */
  circuitCleared: boolean | null;
  /** Always empty — lifting the switch revives nothing (toggles.ts). */
  cancelled: string[];
}

/**
 * Clear every operator hold that is SET, and only those.
 *
 * §1.7: "clearing a hold that was not set is a no-op that writes nothing, so
 * the verb is idempotent and produces no audit noise." The daemon does not
 * offer that for free — `POST /v1/toggles/kill-switch {on:false}` audits
 * `toggle.changed` even when the switch was already off, and
 * `POST /v1/toggles/pause {until:null}` audits `arming.resumed` even when
 * nothing was paused. So the quiet version has to be built here: read the
 * posture first, then write only what that read justifies. One read plus at
 * most two writes is the whole budget, and with nothing held it is one read
 * and no writes at all.
 *
 * `--circuit` is the exception inside the exception and always spends its
 * call. §1.3.6 collapses to ONE winning reason, so a tripped breaker sitting
 * under any other hold is simply not visible in `/v1/status`; skipping the
 * call on a posture that cannot show it would silently do nothing on exactly
 * the day it mattered. An explicit flag is an explicit request.
 *
 * KNOWN LIMIT, and it is a property of the same precedence: `kill-switch`
 * outranks `paused`, so a pause set while the switch is on does not appear
 * in the status read either. `resume` clears every hold it can SEE and never
 * invents one it cannot; a second `resume` finishes the job, quietly.
 */
export async function resumeHolds(
  client: ResumeClient,
  opts: { circuit: boolean },
): Promise<ResumeReport> {
  const status = await client.status();
  const killSwitchOn = status.killSwitch === true;
  const paused = status.armed?.reason === 'paused';

  const killResult =
    killSwitchOn || opts.circuit
      ? await client.setKillSwitch(false, opts.circuit ? { circuit: true } : {})
      : null;
  if (paused) await client.resume();

  return {
    on: false,
    killSwitchCleared: killSwitchOn,
    pauseCleared: paused,
    circuitCleared: opts.circuit ? (killResult?.circuitCleared ?? false) : null,
    cancelled: killResult?.cancelled ?? [],
  };
}

/**
 * Only the holds the operator asked about. A plain `resume` never mentions
 * the breaker: it did not look at it, and reporting on a hold you did not
 * inspect is how an operator ends up believing they fixed something.
 */
export function renderResume(report: ResumeReport): string {
  const lines = [field('kill switch', 'off')];
  if (report.pauseCleared) lines.push(field('pause', 'cleared'));
  if (report.circuitCleared !== null) {
    lines.push(
      field('circuit', report.circuitCleared ? 'reset' : 'was not open'),
    );
  }
  return lines.join('\n');
}

/** `pause`'s human output: the deadline, then what became of the daemon. */
export function renderPause(result: PauseResult, nowMs: number): string {
  return [
    field('paused', result.until === null ? 'no' : `until ${result.until}`),
    field('armed', renderArmed(result.armed, nowMs)),
  ].join('\n');
}
