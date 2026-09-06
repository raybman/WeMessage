/**
 * The people screen's binding — the FOURTH file in this app that reaches the
 * bridge, and the entry the Sc10 partition row was written to demand.
 *
 * Four reads and one write, and every one of the five is an argument.
 *
 *  - `contacts` is the catalogue this screen edits.
 *  - `drafts` is here because the handles an operator opens this screen to
 *    find are precisely the ones NOT in that catalogue. A grid built from
 *    `GET /v1/contacts` alone would have no row at all for the person whose
 *    message the gate just refused, which is the one row that matters.
 *  - `audit` is here because `auto.approved` carries no handle. The
 *    AUTO-SENDS column is a JOIN against `draft.created`, and the join is
 *    not optional: the alternative is one machine-wide number wearing a
 *    per-person label next to a per-person cap.
 *  - `settings` is here because the GLOBAL rung and the two rate caps are
 *    stored values, not constants. A screen that hard-coded either would be
 *    making a claim about the daemon's configuration on the operator's
 *    behalf, and would keep making it after the configuration changed.
 *
 * `rules` is DELIBERATELY absent. The middle rung of §2.4.3 is per-message —
 * §1.7 picks one rule first-match-wins and that rule's own mode narrows
 * further — so there is no rule-scope value to show for a CONTACT, and the
 * rung says `PER RULE` rather than a number this binding could have fetched
 * and then had to explain away.
 *
 * `contactDelete` is DELIBERATELY absent too, and that one is load-bearing.
 * `DELETE /v1/contacts/:handle` removes the row; the gate then treats the
 * handle as unknown, which refuses exactly as DENY does. The two are
 * indistinguishable in behaviour and completely different in the audit
 * trail: `contact.policy-changed` with `to: null` says "the decision was
 * withdrawn", `to: 'deny'` says "the decision is no". An operator reaching
 * for the strict answer wants the second, and a delete button next to a
 * DENY segment is an invitation to pick the one that erases the record. An
 * arch row asserts this file names no such call, against a registry that
 * really does declare the channel.
 *
 * INV-2, twice over. `PeopleBridge` is a `Pick` of five channels and none of
 * them can carry a draft id, and an arch row scans every identifier in this
 * file for the approval vocabulary. Editing a policy changes what AUTONOMY
 * may do NEXT. It says nothing about work a human has already been asked to
 * decide, and nothing here could make it say otherwise: there is no channel
 * on this object that would accept a draft.
 *
 * Everything crosses the bridge as `unknown` and is narrowed here, exactly
 * as the other three bindings do it.
 */
import type {
  AuditRowPayload,
  ContactMode,
  ContactPolicyPayload,
  SettingsPayload,
} from '@wemessage/client';
import type { WmBridge } from '../../preload/api.js';

/**
 * The five request channels this screen may reach, sorted.
 *
 * Four reads that render it and one write that is its only decision. There
 * is no sixth: a policy cannot be tested, previewed, or applied to anything
 * already in the queue from here.
 */
export const PEOPLE_CHANNELS = [
  'audit',
  'contactSet',
  'contacts',
  'drafts',
  'settings',
] as const;

/**
 * The bridge, cut to what this screen needs.
 *
 * `Pick` rather than a structural copy: a channel renamed in
 * `ipc-channels.ts` breaks this line instead of silently becoming a call to
 * a channel that no longer exists.
 */
export type PeopleBridge = Pick<
  WmBridge,
  'audit' | 'contactSet' | 'contacts' | 'drafts' | 'settings'
>;

/** A draft, cut to the two fields this screen is entitled to see. */
export interface QueuedDraft {
  readonly id: string;
  readonly chatGuid: string;
}

/** Everything the screen renders, as the daemon last answered it. */
export interface PeopleData {
  readonly status: 'idle' | 'loading' | 'ready' | 'failed';
  readonly contacts: readonly ContactPolicyPayload[];
  readonly drafts: readonly QueuedDraft[];
  /** `auto.approved` rows: WHEN autonomy acted, but never for whom. */
  readonly autoRows: readonly AuditRowPayload[];
  /** `draft.created` rows: the only place the handle behind one exists. */
  readonly draftRows: readonly AuditRowPayload[];
  readonly settings: SettingsPayload;
}

/** One complaint the DAEMON made, in the daemon's own words. */
export interface PeopleIssue {
  /** A zod path, joined with dots: `mode`. */
  readonly path: string;
  readonly message: string;
}

/**
 * The answer to a write.
 *
 * A refusal is DATA, not a throw, on the same terms as the other two
 * editors. `PUT /v1/contacts/:handle` answers 400 `invalid-contact-policy`
 * with a zod issue list, and a screen that had to regex an exception string
 * to find the field would be reconstructing the validator's vocabulary from
 * prose.
 */
export type PeopleWriteOutcome =
  | { readonly ok: true; readonly contact: ContactPolicyPayload }
  | {
      readonly ok: false;
      readonly issues: readonly PeopleIssue[];
      /** The daemon's own `error` code when it named one. */
      readonly reason: string;
    };

export interface PeopleBinding {
  data(): PeopleData;
  subscribe(listener: () => void): () => void;
  /** Fetch the four catalogues, in parallel. */
  load(): Promise<void>;
  /** Back to `idle`, so a re-entry cannot render the last visit's rows. */
  reset(): void;
  /**
   * Store one policy. The one write, and one handle at a time.
   *
   * There is no bulk route for contacts, and this deliberately does not
   * pretend otherwise: a screen that offered one gesture over N rows and
   * hid N round trips behind it would be describing an atomic decision that
   * the daemon will make one at a time and may refuse halfway through.
   */
  put(
    handle: string,
    mode: ContactMode,
    displayName?: string,
  ): Promise<PeopleWriteOutcome>;
  settled(): Promise<void>;
}

/* ── narrowing ────────────────────────────────────────────────────────── */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  return value as Record<string, unknown>;
}

/** Policy rows that carry a string `handle`, and nothing weaker. */
function policies(answer: unknown): readonly ContactPolicyPayload[] {
  if (!Array.isArray(answer)) return [];
  const out: ContactPolicyPayload[] = [];
  for (const row of answer as readonly unknown[]) {
    const record = asRecord(row);
    if (record !== null && typeof record['handle'] === 'string')
      out.push(record as unknown as ContactPolicyPayload);
  }
  return out;
}

/**
 * Drafts, PROJECTED rather than passed along.
 *
 * The bodies are on the wire and this screen has no business rendering one:
 * it draws handles and policies. Cutting the rows to `{id, chatGuid}` here
 * means a body cannot reach the grid even by accident.
 */
function queued(answer: unknown): readonly QueuedDraft[] {
  if (!Array.isArray(answer)) return [];
  const out: QueuedDraft[] = [];
  for (const row of answer as readonly unknown[]) {
    const record = asRecord(row);
    if (record === null) continue;
    const id = record['id'];
    const chatGuid = record['chatGuid'];
    if (typeof id === 'string' && typeof chatGuid === 'string')
      out.push({ id, chatGuid });
  }
  return out;
}

/** Audit rows that carry the two fields the join needs. */
function ledger(answer: unknown): readonly AuditRowPayload[] {
  if (!Array.isArray(answer)) return [];
  const out: AuditRowPayload[] = [];
  for (const row of answer as readonly unknown[]) {
    const record = asRecord(row);
    if (
      record !== null &&
      typeof record['at'] === 'string' &&
      typeof record['eventJson'] === 'string'
    )
      out.push(record as unknown as AuditRowPayload);
  }
  return out;
}

function keyed(answer: unknown): SettingsPayload {
  const record = asRecord(answer);
  return record === null ? {} : (record as unknown as SettingsPayload);
}

/**
 * The daemon's refusal, recovered from the exception it arrived as.
 *
 * Identical in shape to the rules and schedule editors', and identical on
 * purpose: the message a field is shown is the validator's own, letter for
 * letter, so this screen cannot grow a second opinion about what a policy
 * may be. The daemon runs zod 4, whose wording differs from zod 3's; that
 * is exactly why nothing here paraphrases.
 */
function refusalOf(error: unknown): {
  issues: readonly PeopleIssue[];
  reason: string;
} {
  const text = error instanceof Error ? error.message : String(error);
  const open = text.indexOf('{');
  const close = text.lastIndexOf('}');
  if (open === -1 || close <= open) return { issues: [], reason: text };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(open, close + 1));
  } catch {
    return { issues: [], reason: text };
  }
  const body = asRecord(parsed);
  const named = body?.['error'];
  const reason = typeof named === 'string' ? named : text;
  const detail = asRecord(body?.['detail']);
  const rows = detail?.['issues'];
  if (!Array.isArray(rows)) return { issues: [], reason };
  const issues: PeopleIssue[] = [];
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

/**
 * How far back the ledger reads.
 *
 * The hour window needs an hour of `auto.approved` rows and every
 * `draft.created` they point at, and the daemon caps `limit` at 1000 and
 * answers newest-first. Two FILTERED reads rather than one wide one:
 * `event` is an exact type filter, and an unfiltered page of a thousand
 * would be mostly `message.received` on a busy machine — the join would
 * then miss rows for reasons that have nothing to do with the window.
 */
const LEDGER_PAGE = 1000;

const EMPTY: PeopleData = {
  status: 'idle',
  contacts: [],
  drafts: [],
  autoRows: [],
  draftRows: [],
  settings: {},
};

export function bindPeople(bridge: PeopleBridge): PeopleBinding {
  let data: PeopleData = EMPTY;
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

  async function fetchAll(): Promise<PeopleData> {
    const [contacts, drafts, autoRows, draftRows, settings] = await Promise.all(
      [
        bridge.contacts(),
        bridge.drafts(),
        bridge.audit({ event: 'auto.approved', limit: LEDGER_PAGE }),
        bridge.audit({ event: 'draft.created', limit: LEDGER_PAGE }),
        bridge.settings(),
      ],
    );
    return {
      status: 'ready',
      contacts: policies(contacts),
      drafts: queued(drafts),
      autoRows: ledger(autoRows),
      draftRows: ledger(draftRows),
      settings: keyed(settings),
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
        // than drawing an empty grid — which on THIS screen would read as
        // "nobody has a policy", the strictest claim the product can make,
        // asserted because a fetch failed.
        data = { ...EMPTY, status: 'failed' };
      }
      notify();
    },
    reset() {
      data = EMPTY;
      notify();
    },
    async put(handle, mode, displayName) {
      try {
        // THE one write in this screen, and the only `contactSet` call site
        // in the renderer. A second entry point is how a confirmation gets
        // bypassed by a path that never learned to ask.
        //
        // `displayName` is carried BACK because the route replaces the row:
        // `putBody` treats it as optional and the handler spreads it only
        // when present, so a mode change that omitted it would silently
        // erase a name the operator typed on a different visit.
        const answer = await track(
          bridge.contactSet(
            handle,
            mode,
            displayName === undefined || displayName === ''
              ? {}
              : { displayName },
          ),
        );
        // The CLIENT already unwrapped the route's `{contact}` envelope, so
        // what arrives here is the row itself. Narrowed rather than trusted:
        // this crossed an IPC boundary as `unknown`.
        const record = asRecord(answer);
        if (record === null || typeof record['handle'] !== 'string')
          return { ok: false, issues: [], reason: 'unreadable-answer' };
        const stored = record as unknown as ContactPolicyPayload;
        // Keyed on the DAEMON's handle, not the one that was typed: the
        // route normalizes, so `(555) 000-0007` and `+15550000007` are one
        // row and a merge on the typed spelling would draw two.
        data = {
          ...data,
          contacts: data.contacts.some((row) => row.handle === stored.handle)
            ? data.contacts.map((row) =>
                row.handle === stored.handle ? stored : row,
              )
            : [...data.contacts, stored],
        };
        notify();
        return { ok: true, contact: stored };
      } catch (error) {
        const refusal = refusalOf(error);
        return { ok: false, issues: refusal.issues, reason: refusal.reason };
      }
    },
    async settled() {
      while (inflight.size > 0) await Promise.all([...inflight]);
    },
  };
}
