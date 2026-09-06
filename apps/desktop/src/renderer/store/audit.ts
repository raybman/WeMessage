/**
 * The audit log's binding — the FIFTH file in this app that reaches the
 * bridge, and the first whose whole reason for existing is that it READS.
 *
 * Two reads and one write, and the write does not leave this machine.
 *
 * The log is append-only as an API property rather than as a convention:
 * the Store exposes no update or delete path for `audit_log`, and the daemon
 * registers nothing on the audit path but the two GETs. So a binding over it
 * that could change a row would be a binding whose capability exceeded the
 * thing it is looking at, and `AUDIT_CHANNELS` is what makes that a key set
 * instead of a promise.
 *
 * `auditVerify` is its own channel rather than a field of the list because
 * it is a full chain walk on every call and is never cached (§2.3). It is an
 * ACT the operator performs, and giving it a channel is what lets an arch
 * row assert it is asked for exactly once.
 *
 * `exportReport` reaches no daemon at all. Main opens a save dialog, writes
 * the JSON and hands back the BASENAME, so no absolute home path ever
 * crosses the bridge into a document an operator might screenshot. It is
 * still declared a WRITE in the store partition, because it is the only
 * channel in this GUI that writes bytes outside this process.
 *
 * No `on`, deliberately, and this is the strongest of the four bindings'
 * reasons for declaring none. A log that redrew itself under the operator
 * would move the row they were reading; worse, a chain walk answered at
 * 09:00 is a claim about a log of a particular length, and a stream that
 * grew it afterwards would leave a card on screen vouching for rows nobody
 * checked. The screen says what it loaded, and reloads when asked.
 *
 * INV-2: three channels, none of which can carry a draft id, and an arch row
 * scans every identifier in this file for the approval vocabulary. Reading
 * the record of a decision is not making one.
 *
 * Everything crosses the bridge as `unknown` and is narrowed here, exactly
 * as the other four bindings do it.
 */
import type { AuditRowPayload, AuditVerifyResult } from '@wemessage/client';
import type { WmBridge } from '../../preload/api.js';

/**
 * The three request channels this screen may reach, sorted.
 *
 * There is no fourth, and there is no route for one: the two GETs are the
 * entire audit surface the daemon has.
 */
export const AUDIT_CHANNELS = ['audit', 'auditVerify', 'exportReport'] as const;

/**
 * The bridge, cut to what the reader needs.
 *
 * `Pick` rather than a structural copy: a channel renamed in
 * `ipc-channels.ts` breaks this line instead of silently becoming a call to
 * a channel that no longer exists.
 */
export type AuditBridge = Pick<
  WmBridge,
  'audit' | 'auditVerify' | 'exportReport'
>;

/**
 * The first page, and the route's own cap.
 *
 * `GET /v1/audit` takes `since`, `event` and `limit`, and NOTHING that
 * bounds a page from above. `sinceAt` is an inclusive LOWER bound under
 * `ORDER BY seq DESC`, so re-fetching with the oldest loaded instant
 * returns the same page: there is no backward pager to write. The honest
 * affordance is to raise the limit to the cap the route enforces and then
 * say, in words, that narrowing is how you reach older rows.
 */
export const PAGE_LIMIT = 500;
export const MAX_LIMIT = 1000;

/** The three parameters the DAEMON filters on, in the order the URL carries. */
export interface AuditQuery {
  /** A local date, `YYYY-MM-DD`, or `''` for no lower bound. */
  readonly since: string;
  /** An exact audit event type, or `''` for every type. */
  readonly event: string;
  readonly limit: number;
}

export const EMPTY_QUERY: AuditQuery = {
  since: '',
  event: '',
  limit: PAGE_LIMIT,
};

/** Where the one local write got to. A cancel is an outcome, not an error. */
export type ExportOutcome =
  | { readonly state: 'written'; readonly name: string }
  | { readonly state: 'canceled' }
  | { readonly state: 'failed'; readonly reason: string };

/** Everything the screen renders, as the daemon last answered it. */
export interface AuditData {
  readonly status: 'idle' | 'loading' | 'ready' | 'failed';
  readonly rows: readonly AuditRowPayload[];
  readonly query: AuditQuery;
  /** `null` until somebody asks. Never a default, never a cache. */
  readonly verify: AuditVerifyResult | null;
  readonly exported: ExportOutcome | null;
}

/** What an operator mails to somebody who does not have the database. */
export interface AuditReport {
  readonly verify: AuditVerifyResult;
  /** The row the walk stopped at, and its two neighbours, or `null`. */
  readonly broken: AuditRowPayload | null;
  readonly before: AuditRowPayload | null;
  readonly after: AuditRowPayload | null;
  /** The instant the chain was walked, supplied by the composition root. */
  readonly probedAt: string;
}

export interface AuditBinding {
  data(): AuditData;
  subscribe(listener: () => void): () => void;
  /** Fetch one page under the daemon's three filters. */
  load(query: AuditQuery): Promise<void>;
  /** Back to `idle`, so a re-entry cannot render the last visit's rows. */
  reset(): void;
  /** Walk the chain, once, and hold the answer as an answer. */
  check(): Promise<void>;
  /** Write the report to a file the operator chooses. Reaches no daemon. */
  save(report: AuditReport): Promise<void>;
  settled(): Promise<void>;
}

/* ── narrowing ────────────────────────────────────────────────────────── */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  return value as Record<string, unknown>;
}

/**
 * Rows that carry every column the chain is made of, and nothing weaker.
 *
 * A row we could not read is DROPPED rather than rendered half-blank. This
 * is not the same as the projection's tolerance for an unreadable `event`
 * column: that one is a real stored row whose CONTENT was doctored, and it
 * must be drawn. This is a payload that did not arrive in the shape the
 * transport promises, which is a bug on the wire and not evidence of
 * anything.
 */
function chainRows(answer: unknown): readonly AuditRowPayload[] {
  if (!Array.isArray(answer)) return [];
  const out: AuditRowPayload[] = [];
  for (const row of answer as readonly unknown[]) {
    const record = asRecord(row);
    if (record === null) continue;
    if (typeof record['seq'] !== 'number') continue;
    if (typeof record['at'] !== 'string') continue;
    if (typeof record['eventJson'] !== 'string') continue;
    if (typeof record['actorJson'] !== 'string') continue;
    if (typeof record['prevHash'] !== 'string') continue;
    if (typeof record['hash'] !== 'string') continue;
    out.push(record as unknown as AuditRowPayload);
  }
  return out;
}

/**
 * The chain walk's verdict, narrowed rather than trusted.
 *
 * `ok` decides which arm this is, and an answer that does not carry a
 * boolean `ok` is not a verdict at all — it is left as `null`, which the
 * screen renders as NOT VERIFIED. A card that said VERIFIED because a
 * malformed answer happened to be falsy in the right place is the one lie
 * this screen cannot survive.
 */
function verdictOf(answer: unknown): AuditVerifyResult | null {
  const record = asRecord(answer);
  if (record === null || typeof record['ok'] !== 'boolean') return null;
  if (typeof record['length'] !== 'number') return null;
  if (record['ok'] === true) return { ok: true, length: record['length'] };
  if (typeof record['brokenAtSeq'] !== 'number') return null;
  const reason = record['reason'];
  if (
    reason !== 'seq-gap' &&
    reason !== 'link-broken' &&
    reason !== 'hash-mismatch'
  )
    return null;
  return {
    ok: false,
    brokenAtSeq: record['brokenAtSeq'],
    reason,
    length: record['length'],
  };
}

/** The name main handed back, which is a basename and never a path. */
function outcomeOf(answer: unknown): ExportOutcome {
  const record = asRecord(answer);
  if (record === null) return { state: 'failed', reason: 'unreadable-answer' };
  if (record['canceled'] === true) return { state: 'canceled' };
  const name = record['name'];
  if (typeof name !== 'string' || name === '')
    return { state: 'failed', reason: 'unreadable-answer' };
  return { state: 'written', name };
}

/* ── the binding ──────────────────────────────────────────────────────── */

const EMPTY: AuditData = {
  status: 'idle',
  rows: [],
  query: EMPTY_QUERY,
  verify: null,
  exported: null,
};

export function bindAudit(bridge: AuditBridge): AuditBinding {
  let data: AuditData = EMPTY;
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

  return {
    data: () => data,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async load(query) {
      // `data.query` describes the rows in `data.rows`, and is therefore
      // moved only when an answer lands. Publishing the REQUESTED query at
      // the top would put `data-event` on the screen while the request that
      // justifies it is still in flight, and anything waiting on that
      // attribute — a test, or an operator reading the filter bar — would be
      // reading the previous page's rows under the new page's label.
      data = {
        ...data,
        status: data.status === 'ready' ? 'ready' : 'loading',
      };
      notify();
      // The local date becomes an instant HERE rather than in the screen,
      // because the wire shape is this file's business and `since` is an
      // ISO-8601 lower bound on the route. Midnight UTC, which is what the
      // box says: a day boundary in the operator's own zone would silently
      // move the window by hours depending on where they are sitting.
      const params: { since?: string; event?: string; limit: number } = {
        limit: query.limit,
      };
      if (query.since !== '') params.since = `${query.since}T00:00:00.000Z`;
      if (query.event !== '') params.event = query.event;
      try {
        const answer = await track(bridge.audit(params));
        data = { ...data, status: 'ready', query, rows: chainRows(answer) };
      } catch {
        // A log that will not load leaves the screen saying so rather than
        // rendering half of one. The link state is already on screen.
        data = { ...data, status: 'failed', query, rows: [] };
      }
      notify();
    },
    reset() {
      data = EMPTY;
      notify();
    },
    async check() {
      try {
        const answer = await track(bridge.auditVerify());
        data = { ...data, verify: verdictOf(answer), exported: null };
      } catch {
        data = { ...data, verify: null, exported: null };
      }
      notify();
    },
    async save(report) {
      try {
        const answer = await track(bridge.exportReport(report));
        data = { ...data, exported: outcomeOf(answer) };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        data = { ...data, exported: { state: 'failed', reason } };
      }
      notify();
    },
    async settled() {
      while (inflight.size > 0) await Promise.all([...inflight]);
    },
  };
}
