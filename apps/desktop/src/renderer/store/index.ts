/**
 * The wiring: the only part of the renderer that talks to the bridge.
 *
 * Deliberately thin, and deliberately narrow. It subscribes to the two
 * pushes, NARROWS them (a renderer that trusts its input shape is one bad
 * push away from a blank window), hands them to the reducer, and turns a
 * keystroke into exactly one request. It holds no policy: the reconnect
 * ladder is main's, the queue's meaning is the reducer's, and the daemon
 * owns everything either of them is about.
 *
 * INV-2's compile-time half lives on the next line but one. `StoreBridge` is
 * a `Pick` of the five request channels below plus the push subscription, so
 * the send-test channel is not merely unreachable from this module, it is
 * not in this module's type. Naming it
 * is a type error rather than a convention somebody has to notice in review,
 * and no amount of optimism in the reducer can turn a displayed `approved`
 * into a dispatch: the request this file makes is `approve`, the daemon
 * answers it by recording an `Approval`, and the send happens inside the
 * daemon in `dispatchApproved` or not at all.
 *
 * The SECOND gap detector is here (the first is main's audit count). Frames
 * carry a monotonic sequence number that survives reconnects, so a frame
 * that never arrived — a push dropped on a window that was mid-reload, a
 * renderer that missed a beat — is arithmetic rather than a guess. The
 * recovery is the same as main's: refetch through a real route, never
 * reconstruct.
 */
import type {
  ContactPolicyPayload,
  DraftPayload,
  RulePayload,
} from '@wemessage/client';
import type { GatewayEventPayload } from '@wemessage/protocol';
import type { StreamFrame } from '../../main/event-stream.js';
import type { WmBridge } from '../../preload/api.js';
import {
  createOptimisticStore,
  type BulkAction,
  type Catalogue,
  type ConnState,
  type OptimisticStore,
  type Started,
} from './optimistic.js';

/**
 * The ten request channels the queue may reach, sorted.
 *
 * A list rather than a comment, so `store-wiring.spec.ts` can assert that
 * none of them matches the send pattern and that the set has not grown by
 * accident. s8 Sc6 grew it from three to five, on purpose: a card that
 * renders a rule NAME and a contact's DISPLAY name needs the two catalogues
 * those names live in. s8 Sc8 grew it to seven for the undo verb and the
 * edited approve; s8 Sc9 grows it to ten, for `batch` (the tallies of one
 * bulk), `retry` (the one verb a failed card has) and `settings` (the one
 * value the retry footnote reads).
 *
 * Every one of the three was already declared in `ipc-channels.ts` and
 * already had a handler in `main/gateway.ts`. S8 adds no route and opens
 * nothing at the IPC boundary (F-107): what widens is the queue's REACH, and
 * the arch row over this file moves in the same diff and says so out loud.
 */
export const STORE_CHANNELS = [
  'approve',
  'batch',
  'bulk',
  'contacts',
  'drafts',
  'recall',
  'reject',
  'retry',
  'rules',
  'settings',
] as const;

/**
 * The tallies the batch card renders, and the only keys kept off a report.
 *
 * An ALLOWLIST, not a filter over whatever came back, and the reason is a
 * guard rather than taste: `BatchReport` has a `sending` key, and an arch
 * row bans every identifier matching `/send/i` anywhere under this root —
 * including inside string literals, because the scanner strips comments and
 * keeps strings. So the store cannot name that field even to exclude it.
 * Naming the four it DOES render sidesteps that entirely, and has the
 * better property anyway: a key added to the report upstream cannot appear
 * on a card until somebody decides what it means.
 */
const TALLIES = ['approved', 'sent', 'failed', 'recalled'] as const;

/**
 * The bridge, cut down to what the queue needs.
 *
 * `Pick` and not a structural copy: the keys are checked against the real
 * bridge type, so a channel that is renamed in `ipc-channels.ts` breaks this
 * line rather than silently becoming a call to a channel that no longer
 * exists.
 */
export type StoreBridge = Pick<
  WmBridge,
  | 'approve'
  | 'batch'
  | 'bulk'
  | 'contacts'
  | 'drafts'
  | 'on'
  | 'recall'
  | 'reject'
  | 'retry'
  | 'rules'
  | 'settings'
>;

export interface StoreBinding {
  readonly store: OptimisticStore;
  /**
   * Approve, optionally with the body the operator retyped.
   *
   * One method and not two, because `bridge.approve(` is pinned to a single
   * call site by an arch row and a second entry point would need a second
   * one. The edited body is an OPTION on the same verb for the same reason
   * the daemon models it that way: an edited approval is an approval, and
   * the `Approval` row is what carries the difference.
   */
  approve(id: string, editedBody?: string): Promise<void>;
  reject(id: string): Promise<void>;
  /** Recall an approved draft while the daemon's grace window is open. */
  recall(id: string): Promise<void>;
  bulk(ids: readonly string[], action: BulkAction): Promise<void>;
  /**
   * Retry a failed send.
   *
   * Singular, and there is no bulk twin. `POST /v1/drafts/bulk` takes
   * `z.enum(['approve','recall','reject'])`, so a fourth verb there is a
   * 400 — and retrying twelve failed sends with one keystroke is a way to
   * hammer a Messages bridge that has already told us it is unwell.
   */
  retry(id: string): Promise<void>;
  /**
   * Fetch the two name catalogues, once.
   *
   * Deliberately NOT part of the connect path. `bindStore` is asserted to
   * make no request until something asks it to, and four unit rows pin the
   * exact channel sequence a reconnect produces; a catalogue fetch wired
   * into `onStream` would appear in all four and turn "the store fetched
   * the drafts it was owed" into "the store fetched three things, one of
   * which was the drafts". The composition root calls this once, at mount,
   * which is also the truth about the data: rules and contacts change on a
   * human timescale and this screen is not their editor.
   *
   * Never rejects. A catalogue that will not load costs the cards their
   * names, which they already know how to render without.
   */
  loadCatalogue(): Promise<void>;
  /** Resolves when every request this binding started has finished. */
  settled(): Promise<void>;
  dispose(): void;
}

export interface BindOptions {
  now(): string;
}

/* ── narrowing ────────────────────────────────────────────────────────── */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  return value as Record<string, unknown>;
}

function asFrame(payload: unknown): StreamFrame | null {
  const p = asRecord(payload);
  if (p === null || typeof p['seq'] !== 'number') return null;
  if (p['kind'] === 'event') {
    const event = asRecord(p['event']);
    if (event === null || typeof event['event'] !== 'string') return null;
    return {
      kind: 'event',
      seq: p['seq'],
      event: event as unknown as GatewayEventPayload,
    };
  }
  if (p['kind'] === 'snapshot') {
    if (typeof p['at'] !== 'string' || typeof p['missed'] !== 'number')
      return null;
    if (!Array.isArray(p['drafts'])) return null;
    return {
      kind: 'snapshot',
      seq: p['seq'],
      at: p['at'],
      missed: p['missed'],
      drafts: p['drafts'] as readonly DraftPayload[],
    };
  }
  return null;
}

function asConnState(payload: unknown): ConnState | null {
  const p = asRecord(payload);
  const state = p?.['state'];
  return state === 'connected' || state === 'reconnecting' || state === 'down'
    ? state
    : null;
}

/** The three answers a draft action can come back with, as DATA. */
interface Refusals {
  conflict?: { from?: string; code?: string };
  denied?: { reason: string; retryAfter?: string };
}

/**
 * The 409 codes that are NOT somebody else moving the draft.
 *
 * A conflict answers two questions at once — where the draft is now, and
 * which rule refused the transition — and only one of those is "changed
 * elsewhere". `grace-elapsed` means the undo window closed while the card
 * sat exactly where the operator left it, so reporting it as a change would
 * be an accusation the daemon never made.
 */
const NOT_A_MOVE = new Set(['grace-elapsed']);

function refusalOf(answer: unknown): Refusals | null {
  const a = asRecord(answer);
  if (a === null) return null;
  if (a['refused'] === 'conflict')
    return {
      conflict: {
        // `from` is OPTIONAL, and its absence is a fact rather than a hole.
        // The daemon answers 409 for two different kinds of thing: "the
        // draft is somewhere else now", which carries the state it is in,
        // and "you may not do that again", which carries no state because
        // nothing moved. `retry-limit` is the second kind. Reporting it as
        // a move would tell the operator somebody else touched their draft.
        ...(typeof a['from'] === 'string' ? { from: a['from'] } : {}),
        ...(typeof a['code'] === 'string' ? { code: a['code'] } : {}),
      },
    };
  if (a['refused'] === 'denied' && typeof a['reason'] === 'string')
    return {
      denied: {
        reason: a['reason'],
        ...(typeof a['retryAfter'] === 'string'
          ? { retryAfter: a['retryAfter'] }
          : {}),
      },
    };
  return null;
}

/**
 * Index a list of records by one string field, keyed to another.
 *
 * Narrowed row by row rather than cast: these two answers cross the bridge
 * as `unknown`, and a row missing its key or its name is DROPPED instead of
 * indexed under `undefined`. A card that finds no entry renders the raw
 * handle and a signpost, which is the correct outcome for a row we could not
 * read as well as for a row that does not exist.
 */
function nameMap(
  rows: unknown,
  key: keyof RulePayload | keyof ContactPolicyPayload,
  name: keyof RulePayload | keyof ContactPolicyPayload,
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(rows)) return out;
  for (const row of rows as readonly unknown[]) {
    const record = asRecord(row);
    if (record === null) continue;
    const id = record[key];
    const label = record[name];
    if (typeof id === 'string' && typeof label === 'string' && label !== '')
      out.set(id, label);
  }
  return out;
}

/**
 * The names of the rules that are switched ON, in the order they came back.
 *
 * A second pass over the same answer rather than a field on `nameMap`,
 * because they are different questions with different failure modes: an
 * unreadable row costs the id index one name, and costs this list one
 * WATCHER — and a watcher we could not read must be omitted rather than
 * counted, since the empty queue's whole claim is that these are the rules
 * that will still be drafting after the operator walks away.
 */
function watchedRules(rows: unknown): readonly string[] {
  const out: string[] = [];
  if (!Array.isArray(rows)) return out;
  for (const row of rows as readonly unknown[]) {
    const record = asRecord(row);
    if (record === null) continue;
    const name = record['name'];
    if (record['enabled'] === true && typeof name === 'string' && name !== '')
      out.push(name);
  }
  return out;
}

/**
 * Flatten the settings payload to `key -> value`, as strings.
 *
 * GENERIC, one entry at a time, and that is a constraint rather than a
 * style. `SettingsPayload` is `Record<string, {value, default, version,
 * type, readOnly, floor?, ceiling?, use?}>` and the one setting this screen
 * cares about is named after the thing this module is forbidden to name — an
 * arch row rejects any identifier matching `/send/i` under this root, and
 * the scanner keeps string literals. So the narrowing knows about `value`
 * and about nothing else; `derive/batch.ts` is where a key gets its meaning.
 *
 * An entry that is not a record, or that carries no `value`, is DROPPED
 * rather than stored as an empty string: absence is what a caller checks,
 * and a blank would read as a setting that exists and says nothing.
 */
function settingValues(payload: unknown): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const rows = asRecord(payload);
  if (rows === null) return out;
  for (const [key, entry] of Object.entries(rows)) {
    const record = asRecord(entry);
    if (record === null) continue;
    const value = record['value'];
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    )
      out.set(key, String(value));
  }
  return out;
}

function reasonOf(error: unknown): string {
  return error instanceof Error && error.message !== ''
    ? error.message
    : 'daemon-unavailable';
}

/* ── the binding ──────────────────────────────────────────────────────── */

export function bindStore(
  bridge: StoreBridge,
  options: BindOptions,
): StoreBinding {
  // `() => options.now()` and not `options.now`: handing a method to a
  // constructor detaches it from its object, and the store's clock is the
  // one dependency every ordering decision below is made against.
  const store = createOptimisticStore({ now: () => options.now() });
  const inflight = new Set<Promise<unknown>>();
  let lastSeq: number | null = null;
  let refetching = false;
  /**
   * A refetch that was asked for while one was already in flight.
   *
   * Remembered rather than dropped. See `refetch` below for what dropping it
   * costs; the flag is the trailing edge of a leading-plus-trailing coalesce,
   * and it is the same flag `main/tray.ts` has carried since s8.
   */
  let refetchAgain = false;

  /**
   * Remember a request until it finishes, so `settled()` can be a real wait
   * rather than a count of microtasks. The tracked copy swallows the
   * rejection — the caller still gets the original promise and still has to
   * handle it — because a bookkeeping handle that rejects is an unhandled
   * rejection nobody asked for.
   */
  function track<T>(work: Promise<T>): Promise<T> {
    const done: Promise<void> = work.then(
      () => undefined,
      () => undefined,
    );
    inflight.add(done);
    void done.then(() => inflight.delete(done));
    return work;
  }

  /**
   * The recovery, and the only thing that clears `needsSnapshot`.
   *
   * One at a time: two unknown ids in the same tick are one hole in one map,
   * and a refetch per event would turn a reconnect burst into a stampede.
   * That was the original rule and it is still the rule. What changed is
   * what happens to the request that arrives DURING a flight.
   *
   * s9 F-144. It used to be dropped, and dropping it loses rows. Nothing in
   * this module inserts a draft from an event: `draft.created` carries a
   * `DraftSummary`, which is four fields short of a `DraftPayload`, so the
   * reducer marks the map stale and waits for the row it can actually have
   * (`optimistic.ts`, `case 'draft.created'`). The refetch IS the insert. So
   * the sequence below, all of it ordinary, lost one:
   *
   *   draft.created #19  -> stale -> refetch starts, daemon answers 19
   *   draft.created #20  -> stale -> refetch DROPPED, no request is made
   *   the 19-row answer lands -> `snapshot()` sets `stale = false`
   *   nothing ever asks again
   *
   * leaving the queue permanently one row short while reporting itself in
   * sync. `draft.redrafted` is worse than short: it `drop()`s the old card
   * first and depends entirely on this refetch to deliver the replacement,
   * so a dropped request there removes a card the operator was looking at
   * and puts nothing in its place. For a product whose whole promise is that
   * a human sees every message before it sends, a silently missing row is
   * the one defect that must not ship.
   *
   * The fix is the trailing edge, and it is not new machinery: this is
   * `main/tray.ts`'s `inFlight`/`again`/`finish()` shape, verbatim. Still one
   * request at a time, still never one per event — a burst of any length
   * costs two requests, not N — and the last asker is always answered.
   *
   * The trailing call is deliberately UNCONDITIONAL rather than guarded by
   * `needsSnapshot()`. Two of the four callers do not refetch because the
   * map is stale: the `unknown-draft` refusal, and the bulk approve, whose
   * refetch is the only source of the undo ring's `sendNotBefore`. Guarding
   * on staleness would reinstate the drop for exactly those two.
   */
  function refetch(): void {
    if (refetching) {
      refetchAgain = true;
      return;
    }
    refetching = true;
    refetchAgain = false;
    /*
     * When the answer was ASKED for, not when it arrived, which is what
     * `main/event-stream.ts` already does for main's own resync. Stamping at
     * response time makes `syncedAt` claim a freshness the answer cannot
     * have, and `snapshot()` keeps a pending hypothesis only while
     * `pending.at > at` — so an operator who hits approve while this request
     * is in flight would have their keystroke discarded by an answer that
     * could not possibly have known about it. Request time errs the other
     * way, keeping a hypothesis the daemon already knew, which the next ack
     * supersedes anyway. Keeping is recoverable; dropping is not.
     */
    const at = options.now();
    void track(
      bridge
        .drafts()
        .then((answer) => {
          if (Array.isArray(answer))
            store.snapshot(answer as readonly DraftPayload[], {
              at,
              missed: 0,
            });
        })
        .catch(() => {
          // The map stays marked stale, so the next frame or the next
          // reconnect tries again. Silence here is the alternative to a
          // spin, and main's stream is already telling the operator that
          // the daemon is unreachable.
        })
        .finally(() => {
          finishRefetch();
        }),
    );
  }

  /**
   * The way out of a refetch, and the only place `refetching` is cleared.
   *
   * Cannot spin. `refetchAgain` is set only by a caller of `refetch`, and
   * the self-call below takes the request branch (`refetching` is false by
   * then), which clears the flag before issuing. One remembered request
   * costs exactly one GET; a daemon that is down rejects, nothing re-arms
   * the flag, and the loop stops. Not recursion either: `.finally` runs as a
   * microtask, so even a synchronously-resolving bridge trampolines.
   */
  function finishRefetch(): void {
    refetching = false;
    if (refetchAgain) {
      refetchAgain = false;
      refetch();
    }
  }

  /** How many batch reads have been asked for, and the newest applied. */
  let batchAsks = 0;
  let batchApplied = 0;

  /**
   * Re-read the batch tallies, because one of its drafts has just ended.
   *
   * Fetched on the ENDING and on nothing else, which is the whole design.
   * There is no interval here — this renderer owns no timers at all, and a
   * poll would be one — and there is no fetch on the frames that merely move
   * a card along, because a batch's tallies cannot have changed until one of
   * its drafts is finished. So the request rate is bounded by the size of
   * the batch: N drafts, at most N gets, and then silence.
   *
   * Narrowed by VALUE against an allowlist of names. The answer crosses the
   * bridge as `unknown` and a field that came back as a string must not
   * become `NaN` on a card, so each key is taken only if it is a number.
   */
  function refreshBatch(batchId: string): void {
    // Answers applied in the order they were ASKED FOR, not the order they
    // came back in. Three drafts ending in quick succession put three reads
    // in flight at once, and a slow first answer landing after a fast third
    // would repaint the card with a report that is a draft or two behind —
    // a summary that goes backwards in front of somebody watching it.
    const asked = (batchAsks += 1);
    void track(
      bridge
        .batch(batchId)
        .then((answer) => {
          if (asked < batchApplied) return;
          batchApplied = asked;
          const report = asRecord(answer);
          if (report === null) return;
          const counts: Record<string, number> = {};
          for (const key of TALLIES) {
            const value = report[key];
            if (typeof value === 'number') counts[key] = value;
          }
          store.setBatchCounts(batchId, counts);
        })
        .catch(() => {
          // A report that will not load costs the tallies and nothing else.
          // The cards are the queue; this line is a summary of them.
        }),
    );
  }

  /**
   * True for the two frames that END a draft's journey through a batch.
   *
   * `draft.sent` and `draft.failed`, and deliberately not `draft.approved`:
   * approval is what the bulk itself did, so a report fetched on it would
   * describe the batch a millisecond after it was created and tell the
   * operator nothing they did not just watch happen.
   */
  function isTerminalFrame(event: GatewayEventPayload): boolean {
    return event.event === 'draft.sent' || event.event === 'draft.failed';
  }

  function onFrame(payload: unknown): void {
    const frame = asFrame(payload);
    if (frame === null) return;
    // Arithmetic, not a guess: sequence numbers survive reconnects, so a
    // hole is a frame that was pushed and never arrived.
    const gap = lastSeq !== null && frame.seq !== lastSeq + 1;
    lastSeq = frame.seq;
    if (frame.kind === 'snapshot')
      store.snapshot(frame.drafts, { at: frame.at, missed: frame.missed });
    else store.event(frame.event);
    if (gap) store.markStale();
    if (store.needsSnapshot()) refetch();
    if (frame.kind === 'event' && isTerminalFrame(frame.event)) {
      // Membership is asked of the STORE rather than tested against an array
      // here, and it answers for the ids that actually started: a card the
      // operator picked but the daemon refused produced no Approval row, so
      // it is in no report. A single-card approve is in no batch either, and
      // a `GET /v1/batches/:id` over one would be a request for a page that
      // does not exist.
      const batchId = store.batch()?.batchId;
      const draftId = (frame.event as { draftId?: string }).draftId;
      if (
        batchId !== undefined &&
        batchId !== null &&
        draftId !== undefined &&
        store.batchMemberOf(draftId) !== undefined
      )
        refreshBatch(batchId);
    }
  }

  function onStream(payload: unknown): void {
    const state = asConnState(payload);
    if (state === null) return;
    store.setStream(state);
    // A renderer that has NEVER seen the queue is stale by definition, and
    // the moment there is a connection is the moment it can do something
    // about it. This is not belt-and-braces: main pushes its first snapshot
    // as soon as the socket opens, and a window that was still loading its
    // own JavaScript when that happened would otherwise sit empty until the
    // next reconnect. The stream state is REPLAYED to a window that finishes
    // loading, so this arrives even when everything else was missed.
    if (state === 'connected' && store.syncedAt() === undefined) {
      store.markStale();
      refetch();
    }
  }

  /**
   * One keystroke, one request, and one place that decides what came back.
   *
   * Written once and shared by all three write verbs rather than copied
   * three times. The three differ only in which hypothesis the store wrote
   * and which channel carries it; everything after the await — the two
   * refusals, the honest 409, the failure, the acknowledgement — is the same
   * decision, and three copies of it is three places for one of them to
   * drift into reporting a refusal as a success.
   *
   * The hypothesis was already written by the caller, BEFORE this is
   * entered, so the card moves in the same frame as the key that moved it.
   * Everything below is server truth replacing a guess.
   */
  async function settle(
    id: string,
    started: Started,
    request: () => Promise<unknown>,
  ): Promise<void> {
    if (!started.ok) {
      if (started.refused === 'unknown-draft') refetch();
      return;
    }
    try {
      const answer = await track(request());
      const refusal = refusalOf(answer);
      if (refusal?.conflict !== undefined) {
        const { code, from } = refusal.conflict;
        // The daemon distinguished these; so does the card. A window that
        // collapsed them would tell the operator their draft was changed
        // elsewhere when in fact nothing changed and the clock ran out.
        //
        // Two ways to be "not a move" and they compose. A named code on the
        // list is one (`grace-elapsed`); a conflict with no `from` at all is
        // the other, and it is the general case — a 409 that names no state
        // is a 409 about a rule, and `retry-limit` is the first of them.
        // Falling through to `conflict` there would hand `undefined` to a
        // card as the state somebody else moved the draft to.
        if (from === undefined || (code !== undefined && NOT_A_MOVE.has(code)))
          store.refused(id, { reason: code ?? 'conflict' });
        else store.conflict(id, { from: from as DraftPayload['state'] });
        return;
      }
      if (refusal?.denied !== undefined) {
        store.denied(id, refusal.denied);
        return;
      }
      const draft = asRecord(asRecord(answer)?.['draft']);
      if (draft !== null)
        store.ack(id, { draft: draft as unknown as DraftPayload });
    } catch (error) {
      store.failed(id, { reason: reasonOf(error) });
    }
  }

  const offEvent = bridge.on('event', onFrame);
  const offStream = bridge.on('stream', onStream);

  return {
    store,

    /**
     * One keystroke, one request.
     *
     * The hypothesis is written BEFORE the await, so the card moves in the
     * same frame as the key that moved it. Everything after the await is
     * server truth replacing a guess: an answer, a refusal, or a failure.
     */
    async approve(id, editedBody) {
      // `bridge.approve(` appears ONCE in this repo, which is the arch row
      // Sc7 landed and the reason the optional body is spread into the
      // argument list rather than branching into a second call. Under
      // `exactOptionalPropertyTypes` an omitted key and an `undefined` one
      // are different things, and the daemon's `strictObject` refuses the
      // second, so the option is built by presence.
      const args: readonly unknown[] =
        editedBody === undefined ? [id] : [id, { editedBody }];
      await settle(id, store.approve(id), () => bridge.approve(...args));
    },

    async reject(id) {
      await settle(id, store.reject(id), () => bridge.reject(id));
    },

    async recall(id) {
      await settle(id, store.recall(id), () => bridge.recall(id));
    },

    async retry(id) {
      await settle(id, store.retry(id), () => bridge.retry(id));
    },

    /**
     * One request for the whole selection, and per-id outcomes applied
     * exactly as the route reports them. Sc3's bulk is not atomic, so a
     * client that rolled the selection back on a partial refusal would be
     * showing a queue the daemon does not have.
     */
    async bulk(ids, action) {
      const started = store.bulk(ids, action);
      if (!started.ok) return;
      try {
        const result = await track(
          bridge.bulk(action, { ids: [...started.started] }),
        );
        const r = asRecord(result);
        if (r !== null && Array.isArray(r['refused']))
          store.applyBulk(
            r as unknown as Parameters<typeof store.applyBulk>[0],
          );
      } catch {
        for (const id of started.started)
          store.failed(id, { reason: 'daemon-unavailable' });
      } finally {
        // ONE refetch, in the `finally`, never one per card — and ONLY for
        // approve.
        //
        // WHY IT IS NEEDED AT ALL. `BulkResult` carries no draft payloads:
        // it is ids and counts. The `draft.approved` frame carries no
        // payload either — it is `{event, draftId, actor}` — so neither
        // source supplies `sendNotBefore` or the new `stateChangedAt`, and
        // those two instants ARE the undo ring. Without this the cards the
        // operator just approved would sit there with no indication of how
        // long they have to change their mind, which is the one thing an
        // approval owes them. A single approve does not need it because the
        // route answers with the draft itself.
        //
        // WHY ONLY APPROVE. A resync is not free: `snapshot` REPLACES, and
        // the daemon's default listing excludes the terminal states, so
        // every re-read prunes the cards that have finished. That is the
        // right rule and it has been the rule since Sc7 — the queue is what
        // the daemon says it is — but it means a refetch after a bulk
        // REJECT would take the three cards the operator just rejected off
        // the screen the instant they acted on them, in exchange for
        // learning nothing: a rejected draft is terminal, it has no
        // deadline, and there is no second instant to go and fetch. Recall
        // is the same. So the re-read happens exactly where it buys
        // something.
        //
        // In the `finally` rather than the happy path because the case that
        // most needs the queue re-read is the one where the answer was LOST:
        // the renderer then knows least about what the daemon did.
        if (action === 'approve') refetch();
      }
    },

    async loadCatalogue(): Promise<void> {
      // Three parallel reads and ONE entry point, rather than a second
      // `loadSettings` beside it. They have the same lifetime, the same
      // failure mode and the same answer to "when is this refetched?"
      // (never), so a second method would be a second thing the composition
      // root has to remember to call at mount.
      const [rules, contacts, settings] = await Promise.all([
        track(bridge.rules()).catch(() => []),
        track(bridge.contacts()).catch(() => []),
        track(bridge.settings()).catch(() => ({})),
      ]);
      const next: Catalogue = {
        rules: nameMap(rules, 'id', 'name'),
        contacts: nameMap(contacts, 'handle', 'displayName'),
        watching: watchedRules(rules),
        settings: settingValues(settings),
      };
      store.setCatalogue(next);
    },

    async settled(): Promise<void> {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },

    dispose(): void {
      offEvent();
      offStream();
    },
  };
}
