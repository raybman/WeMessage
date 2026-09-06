/**
 * The rules editor's binding — the SECOND file in this app that reaches the
 * bridge, and the reason Sc5's flat allow-list became a partition.
 *
 * `store/index.ts` is the queue's wiring and this is the editor's. They are
 * separate on purpose rather than merged for convenience:
 *
 *  - the queue is a RECONCILER. It subscribes to a push, folds frames into
 *    an optimistic store and never refetches unless it has proved it missed
 *    something. This binding does none of that and deliberately declares no
 *    `on`: an editor that rendered a rule from a stream would eventually
 *    render a row somebody else was halfway through changing.
 *  - the queue's write surface is the approval verbs. This one's is a rule
 *    body, which has no field that could authorise anything. Two files means
 *    the arch row can say that per file instead of over a union, which is
 *    what makes "the editor cannot reach the approval channels" a fact about
 *    the type rather than a fact about the current call sites.
 *
 * INV-2, twice over: `RulesBridge` is a `Pick` of ten channels and none of
 * them is an approval or the wizard's one exception, and an arch row scans
 * every identifier in this file for that vocabulary. Editing a rule is not
 * an approval; nothing here can make it one.
 *
 * Everything crosses the bridge as `unknown` and is narrowed here, row by
 * row, exactly as the queue's wiring does it. A renderer that trusts main's
 * shapes is one bad payload away from a blank window.
 */
import type {
  AdapterPayload,
  AuditRowPayload,
  ContactPolicyPayload,
  DryRunResult,
  RuleInput,
  RulePayload,
  SchedulePayload,
  SettingsPayload,
} from '@wemessage/client';
import type { WmBridge } from '../../preload/api.js';
import { errorText, refusalBody } from './refusal.js';

/**
 * The ten request channels the editor may reach, sorted.
 *
 * Nine reads and one write. `ruleWrite` is the write, it is invoked from
 * exactly one place below, and `ruleDelete` — a real channel with a real
 * handler that the CLI uses — is deliberately absent: this GUI offers no
 * delete, because a rule that is drafting for somebody is not a row to
 * remove behind a keystroke. OFF is the reversible answer.
 *
 * No `on`. The editor is request/response and refetches after every write,
 * so it cannot render a stale rule as a live one.
 */
export const RULES_CHANNELS = [
  'adapters',
  'audit',
  'contacts',
  'drafts',
  'ruleDryRun',
  'ruleTest',
  'ruleWrite',
  'rules',
  'schedules',
  'settings',
] as const;

/**
 * The bridge, cut to what the editor needs.
 *
 * `Pick` rather than a structural copy, for the same reason the queue's
 * binding does it: a channel renamed in `ipc-channels.ts` breaks this line
 * instead of silently becoming a call to a channel that no longer exists.
 */
export type RulesBridge = Pick<
  WmBridge,
  | 'adapters'
  | 'audit'
  | 'contacts'
  | 'drafts'
  | 'ruleDryRun'
  | 'ruleTest'
  | 'ruleWrite'
  | 'rules'
  | 'schedules'
  | 'settings'
>;

/** §1.6 route 7's window, and the number the URL is asserted to carry. */
export const REPLAY_LIMIT = 50;

/**
 * A live draft, projected down to the two fields the editor may know about.
 *
 * The full DTO carries a body, a chat guid and a dispatch schedule, and the
 * editor has no business holding any of it: all it needs to say is "this
 * rule already has work in the queue, and saving changes none of it". A
 * projection makes that a shape rather than a promise.
 */
export interface LiveDraft {
  readonly id: string;
  readonly ruleId: string | null;
}

/** Everything the screen renders, as the daemon last answered it. */
export interface RulesData {
  readonly status: 'idle' | 'loading' | 'ready' | 'failed';
  readonly rules: readonly RulePayload[];
  readonly adapters: readonly AdapterPayload[];
  readonly schedules: readonly SchedulePayload[];
  readonly contacts: readonly ContactPolicyPayload[];
  readonly settings: SettingsPayload;
  readonly audit: readonly AuditRowPayload[];
  readonly live: readonly LiveDraft[];
}

/** One complaint the DAEMON made, in the daemon's own words. */
export interface RuleIssue {
  /** A zod path, joined with dots: `matcher.keywords`. */
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
export type RuleWriteOutcome =
  | { readonly ok: true; readonly rule: RulePayload }
  | {
      readonly ok: false;
      readonly issues: readonly RuleIssue[];
      /** The daemon's own `error` code when it named one. */
      readonly reason: string;
    };

export interface RulesBinding {
  data(): RulesData;
  subscribe(listener: () => void): () => void;
  /**
   * Fetch the nine catalogues, in parallel.
   *
   * `sinceAt` is passed in rather than computed: "today" is the RENDERER's
   * local midnight and the clock belongs to the composition root, which is
   * the only place in this app entitled to read one.
   */
  load(sinceAt: string): Promise<void>;
  /** Back to `idle`, so a re-entry cannot render the last visit's rows. */
  reset(): void;
  /** Create when `id` is null, patch otherwise. The one write. */
  write(id: string | null, body: Partial<RuleInput>): Promise<RuleWriteOutcome>;
  /** The daemon's own verdict on a saved rule, for one piece of text. */
  probe(id: string, text: string): Promise<boolean | null>;
  /** §1.6 route 7: a read-only replay of the last {@link REPLAY_LIMIT}. */
  replay(id: string): Promise<DryRunResult | null>;
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
 * blank option: a select whose entries have no value is a control that
 * cannot be used, and an empty menu is at least honest about it.
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

function contactRows(answer: unknown): readonly ContactPolicyPayload[] {
  if (!Array.isArray(answer)) return [];
  const out: ContactPolicyPayload[] = [];
  for (const row of answer as readonly unknown[]) {
    const record = asRecord(row);
    if (record !== null && typeof record['handle'] === 'string')
      out.push(record as unknown as ContactPolicyPayload);
  }
  return out;
}

function auditRows(answer: unknown): readonly AuditRowPayload[] {
  if (!Array.isArray(answer)) return [];
  const out: AuditRowPayload[] = [];
  for (const row of answer as readonly unknown[]) {
    const record = asRecord(row);
    if (record !== null && typeof record['eventJson'] === 'string')
      out.push(record as unknown as AuditRowPayload);
  }
  return out;
}

/** The two fields of a live draft, and deliberately not the rest. */
function liveDrafts(answer: unknown): readonly LiveDraft[] {
  if (!Array.isArray(answer)) return [];
  const out: LiveDraft[] = [];
  for (const row of answer as readonly unknown[]) {
    const record = asRecord(row);
    if (record === null || typeof record['id'] !== 'string') continue;
    const rule = record['ruleId'];
    out.push({
      id: record['id'],
      ruleId: typeof rule === 'string' ? rule : null,
    });
  }
  return out;
}

function settingsOf(answer: unknown): SettingsPayload {
  const record = asRecord(answer);
  if (record === null) return {};
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record))
    if (asRecord(entry) !== null) out[key] = entry;
  return out as SettingsPayload;
}

/**
 * The daemon's refusal, recovered from the exception it arrived as.
 *
 * The cutting is `refusal.ts`'s, shared with the settings screen since S8
 * Sc14; what the cut object MEANS is this file's and stays here. A rule is
 * refused by zod and answers with PROSE, so the `message` a field is shown
 * is the validator's own and nothing here paraphrases it. A setting is
 * refused by `planPatch`, which answers with a structure and no sentence at
 * all — a reader that tried to serve both would have to invent one.
 */
function refusalOf(error: unknown): {
  issues: readonly RuleIssue[];
  reason: string;
} {
  const text = errorText(error);
  const body = refusalBody(error);
  if (body === null) return { issues: [], reason: text };
  const named = body['error'];
  const reason = typeof named === 'string' ? named : text;
  const rows = asRecord(body['detail'])?.['issues'];
  if (!Array.isArray(rows)) return { issues: [], reason };
  const issues: RuleIssue[] = [];
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
  return { issues, reason };
}

/* ── the binding ──────────────────────────────────────────────────────── */

const EMPTY: RulesData = {
  status: 'idle',
  rules: [],
  adapters: [],
  schedules: [],
  contacts: [],
  settings: {},
  audit: [],
  live: [],
};

export function bindRules(bridge: RulesBridge): RulesBinding {
  let data: RulesData = EMPTY;
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

  async function fetchAll(sinceAt: string): Promise<RulesData> {
    const [rules, adapters, schedules, contacts, settings, audit, live] =
      await Promise.all([
        bridge.rules(),
        bridge.adapters(),
        bridge.schedules(),
        bridge.contacts(),
        bridge.settings(),
        // The `N today` column is a count of `rule.matched` rows since local
        // midnight (F-109). It is DERIVED and never stored: there is no
        // route that answers "how many times did this rule fire today", and
        // inventing one would have been a schema change to render a number.
        bridge.audit({ since: sinceAt, event: 'rule.matched', limit: 1000 }),
        bridge.drafts(),
      ]);
    return {
      status: 'ready',
      rules: rowsWithId<RulePayload>(rules),
      adapters: rowsWithId<AdapterPayload>(adapters),
      schedules: rowsWithId<SchedulePayload>(schedules),
      contacts: contactRows(contacts),
      settings: settingsOf(settings),
      audit: auditRows(audit),
      live: liveDrafts(live),
    };
  }

  return {
    data: () => data,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async load(sinceAt) {
      data = { ...data, status: data.status === 'ready' ? 'ready' : 'loading' };
      notify();
      try {
        data = await track(fetchAll(sinceAt));
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
        // THE one write in this screen, and the only `ruleWrite` call site
        // in the renderer. A create and a patch are the same channel because
        // they are the same decision — "store this rule" — and a second
        // entry point is how a typed confirmation gets bypassed by a path
        // that never learned to ask.
        const answer = await track(bridge.ruleWrite(id, body));
        const rule = asRecord(asRecord(answer)?.['rule']);
        if (rule === null || typeof rule['id'] !== 'string')
          return { ok: false, issues: [], reason: 'unreadable-answer' };
        return { ok: true, rule: rule as unknown as RulePayload };
      } catch (error) {
        const refusal = refusalOf(error);
        return { ok: false, issues: refusal.issues, reason: refusal.reason };
      }
    },
    async probe(id, text) {
      try {
        const answer = await track(bridge.ruleTest(id, { text }));
        const matched = asRecord(answer)?.['matched'];
        return typeof matched === 'boolean' ? matched : null;
      } catch {
        return null;
      }
    },
    async replay(id) {
      try {
        const answer = await track(bridge.ruleDryRun(id, REPLAY_LIMIT));
        const record = asRecord(answer);
        if (
          record === null ||
          typeof record['total'] !== 'number' ||
          typeof record['matched'] !== 'number' ||
          !Array.isArray(record['rows'])
        )
          return null;
        return record as unknown as DryRunResult;
      } catch {
        return null;
      }
    },
    async settled() {
      while (inflight.size > 0) await Promise.all([...inflight]);
    },
  };
}
