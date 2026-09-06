/**
 * The schedule editor's binding — the THIRD file in this app that reaches
 * the bridge, and the entry the Sc10 partition row was written to demand.
 *
 * Three reads and two writes, and both halves of that are arguments.
 *
 * `rules` is a READ here because a schedule is only ever ABOUT rules. The
 * footnote counts what each rule on this schedule does outside the window
 * (F-69), and the 409 that refuses a delete says how many rules still point
 * at it — a number the operator can do nothing with unless somebody names
 * them. So the catalogue is held, and the names come from it.
 *
 * `scheduleDelete` is here, unlike the rules editor's deliberately absent
 * `ruleDelete`, because the DAEMON refuses a delete that would strand a
 * rule: `DELETE /v1/schedules/:id` answers 409 `schedule-in-use` ahead of
 * the foreign key (F-75). An affordance the server already guards is an
 * affordance the GUI may offer. One it does not, is not.
 *
 * No `on`, for the same reason the rules binding declares none: this editor
 * is request/response and refetches after every write, so it cannot render a
 * schedule somebody else is halfway through changing as a live one.
 *
 * INV-2, twice over. `ScheduleBridge` is a `Pick` of four channels and none
 * of them can carry a draft id, and an arch row scans every identifier in
 * this file for the approval vocabulary. Editing a schedule changes what
 * AUTONOMY may do next; it says nothing at all about work a human has
 * already been asked to decide, and nothing here could make it say
 * otherwise.
 *
 * Everything crosses the bridge as `unknown` and is narrowed here, exactly
 * as the other two bindings do it.
 */
import type {
  RulePayload,
  SchedulePayload,
  ScheduleInput,
} from '@wemessage/client';
import type { WmBridge } from '../../preload/api.js';

/**
 * The four request channels this editor may reach, sorted.
 *
 * Two reads that render the screen, and two writes that are the screen's
 * only two decisions. There is no fifth: a schedule cannot be tested, dry
 * run, or applied to anything from here.
 */
export const SCHEDULE_CHANNELS = [
  'rules',
  'scheduleDelete',
  'scheduleWrite',
  'schedules',
] as const;

/**
 * The bridge, cut to what the editor needs.
 *
 * `Pick` rather than a structural copy: a channel renamed in
 * `ipc-channels.ts` breaks this line instead of silently becoming a call to
 * a channel that no longer exists.
 */
export type ScheduleBridge = Pick<
  WmBridge,
  'rules' | 'scheduleDelete' | 'scheduleWrite' | 'schedules'
>;

/** Everything the screen renders, as the daemon last answered it. */
export interface ScheduleData {
  readonly status: 'idle' | 'loading' | 'ready' | 'failed';
  readonly schedules: readonly SchedulePayload[];
  readonly rules: readonly RulePayload[];
}

/** One complaint the DAEMON made, in the daemon's own words. */
export interface ScheduleIssue {
  /** A zod path, joined with dots: `windows.0.days`. */
  readonly path: string;
  readonly message: string;
}

/**
 * The answer to a write.
 *
 * A refusal is DATA, not a throw. The daemon's 400 carries a typed error
 * code and a zod issue list, and a screen that had to regex an exception
 * string to find the field would be reconstructing the validator's
 * vocabulary from prose — which is exactly how a parallel client-side
 * vocabulary gets invented and then drifts.
 */
export type ScheduleWriteOutcome =
  | { readonly ok: true; readonly schedule: SchedulePayload }
  | {
      readonly ok: false;
      readonly issues: readonly ScheduleIssue[];
      /** The daemon's own `error` code when it named one. */
      readonly reason: string;
    };

/**
 * The answer to a delete.
 *
 * `rules` is the count off the 409's `detail`, and it is the DAEMON's count:
 * this binding holds the rules catalogue and could have derived one, and
 * guessing is how a GUI ends up refusing something the daemon would have
 * allowed, or promising something it would not.
 */
export type ScheduleDeleteOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly rules: number | null;
    };

export interface ScheduleBinding {
  data(): ScheduleData;
  subscribe(listener: () => void): () => void;
  /** Fetch the two catalogues, in parallel. */
  load(): Promise<void>;
  /** Back to `idle`, so a re-entry cannot render the last visit's rows. */
  reset(): void;
  /** Create when `id` is null, patch otherwise. The one write. */
  write(
    id: string | null,
    body: Partial<ScheduleInput>,
  ): Promise<ScheduleWriteOutcome>;
  /** The other one. Refused by the daemon while any rule points at it. */
  remove(id: string): Promise<ScheduleDeleteOutcome>;
  settled(): Promise<void>;
}

/* ── narrowing ────────────────────────────────────────────────────────── */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  return value as Record<string, unknown>;
}

/**
 * Rows that carry a string `id`, and nothing weaker.
 *
 * A catalogue row we could not read is DROPPED rather than rendered as a
 * blank option: a list whose entries have no value is a control that cannot
 * be used, and an empty list is at least honest about it.
 */
function rowsWithId<T>(answer: unknown): readonly T[] {
  if (!Array.isArray(answer)) return [];
  const out: T[] = [];
  for (const row of answer as readonly unknown[]) {
    const record = asRecord(row);
    if (record !== null && typeof record['id'] === 'string')
      out.push(record as unknown as T);
  }
  return out;
}

/**
 * The daemon's refusal, recovered from the exception it arrived as.
 *
 * An `Error` crossing IPC arrives with its message wrapped twice — once by
 * the client (`daemon request failed (HTTP 400): <body>`) and once by
 * Electron. The BODY is still in there verbatim, so the JSON is cut out
 * between its outermost braces and read as what it is. Nothing here
 * paraphrases: the `message` a field is shown is the validator's own, letter
 * for letter, which is what keeps this screen from growing a second opinion
 * about what a schedule may be.
 */
function refusalOf(error: unknown): {
  issues: readonly ScheduleIssue[];
  reason: string;
  rules: number | null;
} {
  const text = error instanceof Error ? error.message : String(error);
  const open = text.indexOf('{');
  const close = text.lastIndexOf('}');
  if (open === -1 || close <= open)
    return { issues: [], reason: text, rules: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(open, close + 1));
  } catch {
    return { issues: [], reason: text, rules: null };
  }
  const body = asRecord(parsed);
  const named = body?.['error'];
  const reason = typeof named === 'string' ? named : text;
  const detail = asRecord(body?.['detail']);
  const count = detail?.['rules'];
  const rules = typeof count === 'number' ? count : null;
  const rows = detail?.['issues'];
  if (!Array.isArray(rows)) return { issues: [], reason, rules };
  const issues: ScheduleIssue[] = [];
  for (const row of rows as readonly unknown[]) {
    const record = asRecord(row);
    if (record === null) continue;
    const parts: string[] = [];
    const path = record['path'];
    if (Array.isArray(path))
      for (const part of path as readonly unknown[]) {
        if (typeof part === 'string') parts.push(part);
        else if (typeof part === 'number') parts.push(String(part));
      }
    const message = record['message'];
    if (parts.length > 0 && typeof message === 'string')
      issues.push({ path: parts.join('.'), message });
  }
  return { issues, reason, rules };
}

/* ── the binding ──────────────────────────────────────────────────────── */

const EMPTY: ScheduleData = { status: 'idle', schedules: [], rules: [] };

export function bindSchedule(bridge: ScheduleBridge): ScheduleBinding {
  let data: ScheduleData = EMPTY;
  const listeners = new Set<() => void>();
  const inflight = new Set<Promise<unknown>>();

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function track<T>(work: Promise<T>): Promise<T> {
    const done: Promise<void> = work.then(
      () => undefined,
      () => undefined,
    );
    inflight.add(done);
    void done.then(() => inflight.delete(done));
    return work;
  }

  async function fetchAll(): Promise<ScheduleData> {
    const [schedules, rules] = await Promise.all([
      bridge.schedules(),
      bridge.rules(),
    ]);
    return {
      status: 'ready',
      schedules: rowsWithId<SchedulePayload>(schedules),
      rules: rowsWithId<RulePayload>(rules),
    };
  }

  return {
    data: () => data,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async load() {
      data = { ...data, status: data.status === 'ready' ? 'ready' : 'loading' };
      notify();
      try {
        data = await track(fetchAll());
      } catch {
        // A catalogue that will not load leaves the screen saying so rather
        // than rendering half of one. The link state is already on screen.
        data = { ...EMPTY, status: 'failed' };
      }
      notify();
    },
    reset() {
      data = EMPTY;
      notify();
    },
    async write(id, body) {
      try {
        // THE one write in this screen, and the only `scheduleWrite` call
        // site in the renderer. A create and a patch are the same channel
        // because they are the same decision — "store this schedule" — and a
        // second entry point is how a confirmation gets bypassed by a path
        // that never learned to ask.
        const answer = await track(bridge.scheduleWrite(id, body));
        // The CLIENT already unwrapped the route's `{schedule}` envelope, so
        // what arrives here is the row itself. Narrowed rather than trusted:
        // this crossed an IPC boundary as `unknown` and the renderer is the
        // process that handles untrusted content.
        const schedule = asRecord(answer);
        if (schedule === null || typeof schedule['id'] !== 'string')
          return { ok: false, issues: [], reason: 'unreadable-answer' };
        const stored = schedule as unknown as SchedulePayload;
        data = {
          ...data,
          schedules: data.schedules.some((row) => row.id === stored.id)
            ? data.schedules.map((row) => (row.id === stored.id ? stored : row))
            : [...data.schedules, stored],
        };
        notify();
        return { ok: true, schedule: stored };
      } catch (error) {
        const refusal = refusalOf(error);
        return { ok: false, issues: refusal.issues, reason: refusal.reason };
      }
    },
    async remove(id) {
      try {
        await track(bridge.scheduleDelete(id));
        data = {
          ...data,
          schedules: data.schedules.filter((row) => row.id !== id),
        };
        notify();
        return { ok: true };
      } catch (error) {
        const refusal = refusalOf(error);
        return { ok: false, reason: refusal.reason, rules: refusal.rules };
      }
    },
    async settled() {
      while (inflight.size > 0) await Promise.all([...inflight]);
    },
  };
}
