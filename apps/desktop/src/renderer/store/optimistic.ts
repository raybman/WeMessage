/**
 * The queue, as the renderer believes it to be.
 *
 * A pure reducer over four inputs: a SNAPSHOT (the daemon's list, which
 * always replaces), an EVENT (the daemon's news), an ACK (the daemon's answer
 * to something we asked for), and a HYPOTHESIS (what the operator just did,
 * before anyone has confirmed it). Everything the queue screen renders is
 * derived here, and nothing here can act.
 *
 * INV-2, structurally. This module imports two type-only modules and nothing
 * else: it has no bridge, no client, no transport, no timer. `approve()`
 * writes a row in a Map and returns; the request is `store/index.ts`'s job
 * and the SEND is the daemon's, reachable only through `dispatchApproved`
 * behind an approval the daemon itself recorded. A card that reads `approved`
 * on this screen is a display fact — the strongest thing it can possibly be
 * from in here, because the only way to make it a dispatch would be to add an
 * import this file would fail its arch row for having.
 *
 * The three-layer read (`stateOf`) is the whole design:
 *
 *     pending.hypothesis   what we just did, unconfirmed
 *     observed.state       what the daemon told us happened
 *     server.state         the row as last fetched
 *
 * `server` is only ever written by a fetch (a snapshot or an ack), never by
 * an event. `draft.approved` carries a `draftId` and an `actor` and no
 * `stateChangedAt`; a store that folded it into the payload would be
 * inventing an instant and then displaying it. So an event moves the row by
 * recording what it OBSERVED, and the payload stays the last thing the
 * daemon actually sent.
 */
import type { BulkResult, DraftPayload, DraftState } from '@wemessage/client';
import type { GatewayEventPayload } from '@wemessage/protocol';

/**
 * The verbs a CARD offers, one at a time.
 *
 * `retry` is Scenario 9's and is deliberately not in `BulkAction` below: the
 * bulk route's own enum is `z.enum(['approve','recall','reject'])`, so a
 * fourth verb posted there is a 400. Keeping the two unions separate makes
 * that a compile error instead of a round trip, and it also encodes a
 * product decision — retrying twelve failed sends with one keystroke is a
 * way to hammer a Messages bridge that is already unwell.
 */
export type QueueAction = 'approve' | 'recall' | 'reject' | 'retry';

/** The three verbs Sc3's bulk route takes. A strict subset of the above. */
export type BulkAction = Exclude<QueueAction, 'retry'>;

export type ConnState = 'connected' | 'reconnecting' | 'down';

/** What the operator did, and what we expect it to mean. */
export interface Pending {
  readonly action: QueueAction;
  /** When the keystroke happened, which is what a snapshot is compared to. */
  readonly at: string;
  readonly hypothesis: DraftState;
  /** Present when the hypothesis came from a selection, not one card. */
  readonly batchToken?: string;
}

/**
 * Why a card is wearing a badge. Three kinds, one per way a hypothesis can
 * end badly: somebody else moved it, the gate refused it, or the request
 * never landed.
 */
export type Chip =
  | { readonly kind: 'changed-elsewhere'; readonly state: DraftState }
  | {
      readonly kind: 'denied';
      readonly reason: string;
      readonly retryAfter?: string;
    }
  | { readonly kind: 'error'; readonly reason: string }
  /**
   * The daemon said no, in its own words, about a rule of its own.
   *
   * Distinct from `changed-elsewhere` because they are different facts and
   * one of them was being reported as the other. `POST /recall` answers 409
   * for TWO reasons: `illegal-transition` (the draft is not approved any
   * more — somebody or something moved it) and `grace-elapsed` (nobody moved
   * anything; the undo window closed). Folding the second into the first
   * tells an operator their draft was changed elsewhere, which is false, and
   * sends them looking for a second terminal that does not exist.
   */
  | { readonly kind: 'refused'; readonly reason: string };

export interface Row {
  /** The last payload a FETCH produced. Never written by an event. */
  readonly server: DraftPayload;
  /** The last state an EVENT reported, with the instant we heard it. */
  readonly observed?: { readonly state: DraftState; readonly at: string };
  readonly pending?: Pending;
}

/**
 * One inbound message this app watched arrive, kept for context.
 *
 * OBSERVED, never fetched, and the distinction is structural rather than a
 * preference: `GET /v1/drafts/:id` answers with the draft and its approvals
 * and carries no conversation, and S8 adds no route (F-107). What the queue
 * can honestly show beside a draft is what the daemon broadcast while this
 * window was listening. A window opened five minutes ago has five minutes of
 * context and says so by having less of it, which is the truthful failure
 * mode; the alternative is a screen that implies it has the whole thread.
 *
 * Only inbound: `message.received` is the only turn event, so every row here
 * is from THEM. Ours is the draft, which is pinned separately and aligned
 * against these.
 */
export interface Turn {
  readonly guid: string;
  readonly text: string;
  readonly at: string;
}

/**
 * What this app has watched happen in one conversation.
 *
 * `total` counts everything observed; `recent` holds the tail. They differ
 * because a screen renders a window and a long-lived session must not grow a
 * list without a ceiling — but the COUNT is what the operator is told, so it
 * is kept exactly rather than reported as the length of a truncated array.
 */
export interface Conversation {
  readonly total: number;
  readonly recent: readonly Turn[];
}

const NO_CONVERSATION: Conversation = { total: 0, recent: [] };

/**
 * How many turns per conversation stay in memory.
 *
 * The right pane renders a window of forty and a card expands to three, so
 * two hundred is five windows of scrollback and a hard bound on a Map that
 * would otherwise grow for as long as the app is open. It is deliberately
 * not the render window: a ceiling equal to what is on screen is a ceiling
 * that turns into a bug the first time the window grows.
 */
const TURN_CEILING = 200;

/**
 * The names behind the ids a draft carries.
 *
 * Fetched once at mount and held here so that every card reads a name the
 * same way. A card that resolved its own would be a card that can fetch,
 * and the whole point of Sc5's arch row is that a card cannot.
 *
 * Absence is meaningful in both: a handle with no contact row has no display
 * name and must render as the raw handle plus a signpost, never as a guess,
 * and a draft with no rule was made by a person.
 *
 * There is no adapter catalogue, and that is a boundary decision rather than
 * an omission. The store's reach is an allowlist of bridge members that a
 * guard asserts exactly, so every entry here is a channel somebody opened on
 * purpose — and an adapter's DISPLAY name buys a card nothing its id does not
 * already say. The card renders the id.
 */
export interface Catalogue {
  readonly contacts: ReadonlyMap<string, string>;
  readonly rules: ReadonlyMap<string, string>;
  /**
   * The names of the rules that are currently ENABLED, in fetch order.
   *
   * Not derivable from `rules`, which is an id index built for lookup and
   * deliberately keeps every rule so that a draft made by a rule somebody
   * has since switched off still renders its name. This is the other
   * question — "if I walk away, what will still be drafting?" — and it is
   * the only honest thing an empty queue has to say. A screen that answered
   * it from `rules.size` would tell an operator who disabled everything
   * last night that six rules are watching.
   */
  readonly watching: readonly string[];
  /**
   * The daemon's settings, flattened to `key -> value as a string`.
   *
   * s8 Scenario 9. The batch card owes an operator one footnote after a
   * partial failure — whether a send that failed over iMessage will be
   * retried over SMS — and that is a daemon setting, not a fact about the
   * draft. It is catalogue-shaped in every way that matters: read once, tiny,
   * changed by somebody else's window, and never worth a round trip per card.
   *
   * Values are STRINGS, uniformly, including the booleans and the numbers.
   * Not laziness: the payload's values are `number | boolean | string | null`
   * and this map is read by a component that renders words, so parsing them
   * back into three types here would be inventing a schema for a screen that
   * only ever prints them. `derive/batch.ts` compares against the spelling.
   */
  readonly settings: ReadonlyMap<string, string>;
}

export const EMPTY_CATALOGUE: Catalogue = {
  contacts: new Map(),
  rules: new Map(),
  watching: [],
  settings: new Map(),
};

/**
 * Why a verb never left the renderer.
 *
 * Four, and the fourth is the interesting one. `wrong-state` is a refusal
 * the DAEMON would also make — approving an expired draft is a 409 — caught
 * one layer earlier so that the operator is told before the round trip
 * rather than after it. It is not an optimisation. An edge state is where a
 * second dispatch would hide, and the cheapest way to prove no recovery path
 * becomes one is for the request never to be made: the e2e counts approve
 * POSTs in the daemon's own request log and expects zero.
 */
export type Refusal = 'offline' | 'unknown-draft' | 'in-flight' | 'wrong-state';

/**
 * The state each verb is legal FROM, mirroring §1.7's human rows.
 *
 * Narrower than the daemon's table on purpose: `reject` is legal from
 * `approved` there, but only for a SYSTEM actor with a recorded reason (a
 * kill switch, a dropped link, an open circuit). A human recalls an approved
 * draft; they do not reject it. Encoding the human subset is what makes a
 * local refusal honest rather than a guess at the daemon's answer.
 */
const STARTABLE: Readonly<Record<QueueAction, ReadonlySet<DraftState>>> = {
  approve: new Set<DraftState>(['pending']),
  reject: new Set<DraftState>(['pending']),
  recall: new Set<DraftState>(['approved']),
  // Exactly one state, and it is the whole reason retry is a separate verb
  // rather than a second `approve`. A failed card is NOT pending, so `a`
  // would be refused on it locally with `wrong-state` — which is correct and
  // also useless to an operator looking at a send that did not verify. And
  // `recalled` is terminal (there is no row out of it in the transition
  // table), so a card the operator undid stays undone: retry is not a way
  // back in either.
  retry: new Set<DraftState>(['failed']),
};

export type Started =
  { readonly ok: true } | { readonly ok: false; readonly refused: Refusal };

export type BulkStarted =
  | {
      readonly ok: true;
      readonly batchToken: string;
      readonly started: readonly string[];
    }
  | { readonly ok: false; readonly refused: Refusal };

/**
 * s8 Scenario 9. The one act the operator performed, as opposed to the N
 * things the world did about it.
 *
 * A bulk is non-atomic all the way down: one shared `batchId` on every
 * Approval row, one `draft.rejected`-shaped frame PER draft carrying it,
 * per-id `refused` entries, and no rollback. The cards render the N; this
 * renders the one, and the whole reason it exists is that an operator who
 * pressed ⇧A once and then watched two cards go quiet and one go red has no
 * way to know whether the third belonged to the thing they did.
 *
 * `token` and `batchId` are BOTH here, and the order matters. The token is
 * minted at the keystroke, locally, before anything has left the app; the
 * `batchId` is the daemon's and arrives with the HTTP answer, which is
 * strictly after the first `draft.sent` frame can already have landed. A
 * model that could only name the batch once the answer came back would drop
 * that first frame on the floor. `batchId` is therefore `null` — not absent
 * — for the window between the two, because "we have not been told yet" is a
 * state this card has to be able to render.
 *
 * `counts` is `Record<string, number>` rather than a `BatchReport`, and that
 * is not laziness. Sc5's arch row bans any identifier matching `/send/i`
 * anywhere under the store root, and `BatchReport` has a `sending` key: a
 * store that destructured it by name would trip a guard that exists to stop
 * this layer from growing a send path. The store keeps the numbers;
 * `derive/batch.ts` is where they get their names back.
 */
export interface BatchFacts {
  /** Minted locally, at the keystroke. Stable for the life of the batch. */
  readonly token: string;
  /** The daemon's name for it. `null` until the HTTP answer says. */
  readonly batchId: string | null;
  readonly action: BulkAction;
  /**
   * The ids that are actually IN the batch, which is not the ids the
   * operator picked. A card the daemon refused produced no Approval row, so
   * it carries no `batchId`, so it can never appear in `GET /v1/batches/:id`
   * — counting it here would give the batch card tallies that never add up
   * to the number beside them.
   */
  readonly ids: readonly string[];
  readonly refused: readonly { readonly id: string; readonly error: string }[];
  readonly counts?: Readonly<Record<string, number>>;
}

export interface OptimisticStore {
  subscribe(listener: () => void): () => void;
  rows(): readonly Row[];
  row(id: string): Row | undefined;
  stateOf(id: string): DraftState | undefined;
  chip(id: string): Chip | undefined;
  streamState(): ConnState;
  /** What this app has watched happen in `chatGuid`. */
  conversation(chatGuid: string): Conversation;
  catalogue(): Catalogue;
  /**
   * The clamp the LIVE frame reported for a draft, if we ever saw one.
   *
   * `DraftSummary.clampedBy` rides the `draft.created` frame (F-108, an
   * in-process Map in the daemon) and is NOT on `DraftPayload`, the REST
   * record. So a card's clamp is knowable for a draft this window watched
   * arrive and unknowable for the same draft after a refetch — and a queue
   * that read it straight off whatever it last received would show the badge,
   * lose it on the next resync, and show it again on the one after that.
   *
   * The answer is a SIDECAR: the fact is recorded when the frame carries it
   * and survives every snapshot, because a snapshot is silent about clamps
   * rather than contradicting them. It is dropped when the draft leaves the
   * queue, because then there is no card to badge. The badge therefore never
   * flickers, and it never claims a clamp for a draft nobody told us about —
   * a window that missed the frame renders no badge, which is honest: it does
   * not know.
   */
  clampOf(id: string): string | undefined;
  /**
   * The error CODE the live `draft.failed` frame carried, if we heard one.
   *
   * A second sidecar, for a reason that is nearly the clamp's and not quite.
   * `draft.failed` is `{draftId, error}`: the frame knows exactly why the
   * dispatcher refused, and `server.error` on the row beside it is whatever
   * the last FETCH said, which for a draft that failed after we listed it is
   * nothing at all. An event may not write `server` (that rule is the whole
   * three-layer design), so the code is recorded here instead and the card
   * reads whichever of the two it has.
   *
   * It differs from the clamp in what a snapshot means. `DraftPayload` HAS
   * an `error` field, so a refetch is not silent about failure the way it is
   * about clamps — it is authoritative, and the card prefers it. This holds
   * the window between the frame and the next fetch, which for a draft that
   * is never refetched is the whole life of the card.
   */
  failureOf(id: string): string | undefined;
  /** True when we know our map is stale and a refetch is owed. */
  needsSnapshot(): boolean;
  /** Audit rows written while we were disconnected, per the last resync. */
  missed(): number;
  syncedAt(): string | undefined;

  setStream(state: ConnState): void;
  /**
   * Declare the map stale from outside the reducer.
   *
   * The wiring's own gap detector — a hole in the IPC frame sequence — is
   * arithmetic about frames rather than a fact about drafts, so it cannot be
   * derived in here. It still means exactly what an unknown draft id means,
   * and it is owed exactly the same refetch.
   */
  markStale(): void;
  setCatalogue(next: Catalogue): void;
  snapshot(
    drafts: readonly DraftPayload[],
    meta: { at: string; missed: number },
  ): void;
  event(payload: GatewayEventPayload): void;

  /**
   * The newest terminal outcome this window WATCHED happen, or `undefined`.
   *
   * For the live region, and for nothing else. A send is the one thing on
   * this screen that happens without the operator doing anything, and the
   * list's own `aria-activedescendant` cannot announce it because the cursor
   * did not move. Recorded rather than derived, because "the card is now
   * sent" is a state and "a draft has just been sent" is an event, and only
   * the second one is worth interrupting somebody to say.
   */
  outcome(): 'sent' | 'failed' | undefined;

  /**
   * The one batch this window is showing, or `undefined`.
   *
   * ONE, singular, and replaced by the next bulk rather than appended to.
   * There is one batch card on the screen, so a second batch in the model
   * would be a fact with nowhere to be rendered — and an operator who
   * performed a second act is asking about the second act.
   */
  batch(): BatchFacts | undefined;
  /**
   * Which batch a card belongs to, if it belongs to one.
   *
   * The index that makes a frame about ONE draft find the batch it should
   * refresh, without the wiring scanning an array on every event. Answers
   * with the TOKEN, because the frame can arrive before the `batchId` does.
   */
  batchMemberOf(id: string): string | undefined;
  /**
   * Hold the counts somebody else fetched, for the batch named.
   *
   * Named rather than implicit: `GET /v1/batches/:id` is in flight while the
   * operator can already have started another batch, and a late answer to a
   * question that has been replaced must not overwrite the one on screen.
   */
  setBatchCounts(
    batchId: string,
    counts: Readonly<Record<string, number>>,
  ): void;

  approve(id: string): Started;
  reject(id: string): Started;
  recall(id: string): Started;
  /** The one verb a failed card has. Legal only from `failed` (F-99). */
  retry(id: string): Started;
  bulk(ids: readonly string[], action: BulkAction): BulkStarted;
  ack(id: string, answer: { draft: DraftPayload }): void;
  applyBulk(result: BulkResult): void;
  conflict(id: string, answer: { from: DraftState }): void;
  denied(id: string, answer: { reason: string; retryAfter?: string }): void;
  /** A 409 whose code names a rule rather than a state change. */
  refused(id: string, answer: { reason: string }): void;
  failed(id: string, answer: { reason: string }): void;
}

export interface OptimisticDeps {
  now(): string;
}

/** What a verb claims about a card while nobody has confirmed it. */
const HYPOTHESIS: Readonly<Record<QueueAction, DraftState>> = {
  approve: 'approved',
  recall: 'recalled',
  reject: 'rejected',
  // `POST /v1/drafts/:id/retry` puts the draft back to `approved` with a
  // FRESH grace window, so the card goes back to ringing. Not 'sending':
  // Sc8 considered minting a `draft.sending` state and declined on the
  // record, and a hypothesis has to name a state that exists.
  retry: 'approved',
};

export function createOptimisticStore(deps: OptimisticDeps): OptimisticStore {
  let map = new Map<string, Row>();
  let chips = new Map<string, Chip>();
  let stream: ConnState = 'down';
  let stale = false;
  let gap = 0;
  let syncedAt: string | undefined;
  let lastOutcome: 'sent' | 'failed' | undefined;
  let batches = 0;
  let batch: BatchFacts | undefined;
  let batchOf = new Map<string, string>();
  let turns = new Map<string, Conversation>();
  let clamps = new Map<string, string>();
  let failures = new Map<string, string>();
  let catalogue: Catalogue = EMPTY_CATALOGUE;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const put = (id: string, row: Row): void => {
    map = new Map(map);
    map.set(id, row);
  };

  const drop = (id: string): void => {
    map = new Map(map);
    map.delete(id);
  };

  const setChip = (id: string, chip: Chip): void => {
    chips = new Map(chips);
    chips.set(id, chip);
  };

  const clearChip = (id: string): void => {
    if (!chips.has(id)) return;
    chips = new Map(chips);
    chips.delete(id);
  };

  /**
   * Drop the hypothesis, keeping the key ABSENT rather than undefined.
   *
   * Rebuilt rather than destructured: `exactOptionalPropertyTypes` makes
   * "absent" and "undefined" different types, and a rest-spread that drops
   * one key is a lint error for an unused binding here.
   */
  const settled = (row: Row): Row => ({
    server: row.server,
    ...(row.observed === undefined ? {} : { observed: row.observed }),
  });

  /**
   * Record what an event says happened, and say whether anything changed.
   *
   * Idempotence lives here: the same frame twice is the same state once, so
   * a redelivery after a reconnect cannot double-notify a screen or
   * resurrect a hypothesis the first copy already ended.
   */
  const observe = (id: string, state: DraftState): boolean => {
    const row = map.get(id);
    if (!row) {
      stale = true;
      return true;
    }
    if (row.pending === undefined && row.observed?.state === state)
      return false;
    put(id, {
      ...settled(row),
      observed: { state, at: deps.now() },
    });
    return true;
  };

  const start = (id: string, action: QueueAction, token?: string): Started => {
    if (stream !== 'connected') return { ok: false, refused: 'offline' };
    const row = map.get(id);
    if (!row) {
      stale = true;
      return { ok: false, refused: 'unknown-draft' };
    }
    if (row.pending !== undefined) return { ok: false, refused: 'in-flight' };
    // The three-layer read WITHOUT the hypothesis layer, because there is no
    // hypothesis: the line above proved that. What is left is the daemon's
    // news if we heard any, else the row as last fetched — which is exactly
    // the state the daemon would compare against, so a refusal here and a
    // 409 there disagree only in how long the operator waited to hear it.
    const state = row.observed?.state ?? row.server.state;
    if (!STARTABLE[action].has(state)) {
      // The chip carries the daemon's own word for where the card actually
      // is. Not a sentence about what was refused: the card is already
      // wearing that state's glyph and word, and the chip's job is to say
      // that the keystroke landed and was answered, not to re-describe the
      // row underneath it.
      setChip(id, { kind: 'error', reason: state });
      return { ok: false, refused: 'wrong-state' };
    }
    put(id, {
      ...row,
      pending: {
        action,
        at: deps.now(),
        hypothesis: HYPOTHESIS[action],
        ...(token === undefined ? {} : { batchToken: token }),
      },
    });
    clearChip(id);
    return { ok: true };
  };

  /** End a hypothesis and leave the card exactly as the daemon has it. */
  /**
   * Repaint iff the attempt changed something an operator can see.
   *
   * A refusal is USUALLY not a change. Two are. `unknown-draft` learned the
   * map is stale and the wiring has to be told so it can go and fix it;
   * `wrong-state` wrote a chip, and a chip nobody repaints is a keystroke
   * that vanished — which on this screen reads as the app having done the
   * thing silently.
   *
   * Shared by all three verbs rather than written out three times: an
   * `approve` that repainted on a refusal and a `reject` that did not would
   * be the same key behaving differently for no reason the operator could
   * ever discover.
   */
  const began = (outcome: Started): Started => {
    if (
      outcome.ok ||
      outcome.refused === 'unknown-draft' ||
      outcome.refused === 'wrong-state'
    )
      notify();
    return outcome;
  };

  const rollback = (id: string, chip: Chip): void => {
    const row = map.get(id);
    if (!row) return;
    put(id, settled(row));
    setChip(id, chip);
    notify();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    rows: () => [...map.values()],
    row: (id) => map.get(id),
    stateOf(id) {
      const row = map.get(id);
      if (!row) return undefined;
      return row.pending?.hypothesis ?? row.observed?.state ?? row.server.state;
    },
    chip: (id) => chips.get(id),
    streamState: () => stream,
    conversation: (chatGuid) => turns.get(chatGuid) ?? NO_CONVERSATION,
    catalogue: () => catalogue,
    clampOf: (id) => clamps.get(id),
    failureOf: (id) => failures.get(id),
    batch: () => batch,
    batchMemberOf: (id) => batchOf.get(id),
    needsSnapshot: () => stale,
    missed: () => gap,
    syncedAt: () => syncedAt,

    markStale() {
      if (stale) return;
      stale = true;
      notify();
    },

    setCatalogue(next) {
      catalogue = next;
      notify();
    },

    setBatchCounts(batchId, counts) {
      // Two guards, one condition. No batch is the trivial case; a batch
      // with a different name is the real one — the operator has moved on
      // and this is an answer to the previous question arriving late.
      if (batch === undefined || batch.batchId !== batchId) return;
      batch = { ...batch, counts };
      notify();
    },

    setStream(next) {
      if (stream === next) return;
      stream = next;
      notify();
    },

    /**
     * The snapshot REPLACES. A merge would leave a card on screen that the
     * daemon has already dropped, and a queue that only ever grows is the
     * one bug an operator cannot see: everything present is correct, and
     * what is wrong is invisible.
     *
     * The one thing carried across is a hypothesis NEWER than the refetch,
     * because the answer left the daemon before the keystroke happened and
     * so cannot be describing it. Anything older is superseded: the fetch
     * is the better witness.
     */
    snapshot(drafts, meta) {
      const at = Date.parse(meta.at);
      const next = new Map<string, Row>();
      for (const server of drafts) {
        const previous = map.get(server.id);
        const pending =
          previous?.pending !== undefined &&
          Date.parse(previous.pending.at) > at
            ? previous.pending
            : undefined;
        const observed =
          previous?.observed !== undefined &&
          Date.parse(previous.observed.at) > at
            ? previous.observed
            : undefined;
        next.set(server.id, {
          server,
          ...(observed === undefined ? {} : { observed }),
          ...(pending === undefined ? {} : { pending }),
        });
      }
      map = next;
      // A badge belongs to a card. When the card is gone, so is the badge.
      const kept = new Map<string, Chip>();
      for (const [id, chip] of chips) if (map.has(id)) kept.set(id, chip);
      chips = kept;
      // The clamp sidecar is pruned the same way and for the same reason,
      // and is otherwise UNTOUCHED by a snapshot. A snapshot is silent about
      // clamps rather than denying them: `DraftPayload` has no `clampedBy`
      // field, so a refetch that cleared the sidecar would be treating the
      // absence of a field for the absence of a fact, and the badge would
      // blink out on every resync of a draft that is still clamped.
      const clampsKept = new Map<string, string>();
      for (const [id, why] of clamps) if (map.has(id)) clampsKept.set(id, why);
      clamps = clampsKept;
      // The failure sidecar is pruned by id for the same reason, and then
      // deliberately left alone: a fetched payload that carries its own
      // `error` simply wins at the card, and one that does not has nothing
      // to say about a failure this window watched happen.
      const failuresKept = new Map<string, string>();
      for (const [id, code] of failures)
        if (map.has(id)) failuresKept.set(id, code);
      failures = failuresKept;
      gap = meta.missed;
      syncedAt = meta.at;
      stale = false;
      notify();
    },

    event(payload) {
      switch (payload.event) {
        case 'draft.approved':
        case 'draft.rejected':
        case 'draft.recalled': {
          const state: DraftState =
            payload.event === 'draft.approved'
              ? 'approved'
              : payload.event === 'draft.rejected'
                ? 'rejected'
                : 'recalled';
          if (observe(payload.draftId, state)) notify();
          return;
        }
        case 'draft.sent':
          // Recorded even when the state did not move (a card this window
          // already believed was sent), because the live region is about the
          // EVENT: an operator who was told nothing when the send landed
          // has no way to know the queue is finished with it.
          if (observe(payload.draftId, 'sent') || lastOutcome !== 'sent') {
            lastOutcome = 'sent';
            notify();
          }
          return;
        case 'draft.failed': {
          // The dispatcher's own word, kept because the row's `server.error`
          // is the last FETCH's answer and an event may not overwrite it.
          const spoke = lastOutcome !== 'failed';
          lastOutcome = 'failed';
          const moved = observe(payload.draftId, 'failed');
          const known = failures.get(payload.draftId) === payload.error.code;
          if (!known) {
            failures = new Map(failures);
            failures.set(payload.draftId, payload.error.code);
          }
          if (moved || !known || spoke) notify();
          return;
        }
        case 'draft.expired':
          if (observe(payload.draftId, 'expired')) notify();
          return;
        case 'draft.requeued': {
          // Back in the queue is back to no verdict. A requeued draft still
          // wearing the last attempt's error code would be telling the
          // operator about a decision that has been taken back.
          const moved = observe(payload.draftId, 'pending');
          const had = failures.has(payload.draftId);
          if (had) {
            failures = new Map(failures);
            failures.delete(payload.draftId);
          }
          if (moved || had) notify();
          return;
        }
        case 'draft.superseded':
          // The card is terminal AND a newer draft exists that we have never
          // seen. The first half is a state change; the second is a hole.
          observe(payload.draftId, 'superseded');
          stale = true;
          notify();
          return;
        case 'draft.redrafted':
          // The old card is not in a new state, it is GONE — the queue holds
          // its replacement instead, and we have never seen that one.
          drop(payload.draftId);
          clearChip(payload.draftId);
          if (clamps.has(payload.draftId)) {
            clamps = new Map(clamps);
            clamps.delete(payload.draftId);
          }
          if (failures.has(payload.draftId)) {
            failures = new Map(failures);
            failures.delete(payload.draftId);
          }
          stale = true;
          notify();
          return;
        case 'message.received': {
          // The only turn event there is, and the only source of context this
          // screen can honestly claim. Attachments-only messages have a null
          // text and are still turns — something happened in that thread and
          // a gap in the transcript would be a lie of omission — so they are
          // recorded with the word the operator would see in Messages.
          const { message } = payload;
          const previous = turns.get(message.chatGuid) ?? NO_CONVERSATION;
          const next = [
            ...previous.recent,
            {
              guid: message.guid,
              text: message.content.text ?? '[ATTACHMENT]',
              at: message.receivedAt,
            },
          ];
          turns = new Map(turns);
          turns.set(message.chatGuid, {
            total: previous.total + 1,
            recent: next.slice(-TURN_CEILING),
          });
          notify();
          return;
        }
        case 'draft.created':
          // The clamp rides THIS frame and no other (F-108): it is an
          // in-process fact in the daemon and is not on the REST record, so
          // the only chance this app will ever get to learn it is here.
          if (payload.draft.clampedBy !== undefined) {
            clamps = new Map(clamps);
            clamps.set(payload.draft.id, payload.draft.clampedBy);
          }
          // The frame carries a `DraftSummary`, which is not a `DraftPayload`:
          // no `stateChangedAt`, no `inboundGuid`, no `idempotencyKey`, no
          // `originalBody`. Inserting one means inventing four fields, so the
          // store asks for the row it can actually have.
          stale = true;
          notify();
          return;
        case 'gate.denied': {
          // A denial is not a state change, so it never makes the map stale.
          // It is a badge, and only for a card we are holding.
          const id = payload.draftId;
          if (id === undefined || !map.has(id)) return;
          setChip(id, { kind: 'denied', reason: payload.reason });
          notify();
          return;
        }
        default:
          // Arrivals, rule matches, previews, toggles, adapter health, the
          // link state and the arming badge. None of them are this queue.
          return;
      }
    },

    outcome: () => lastOutcome,

    approve: (id) => began(start(id, 'approve')),
    reject: (id) => began(start(id, 'reject')),
    recall: (id) => began(start(id, 'recall')),
    retry: (id) => began(start(id, 'retry')),

    bulk(ids, action) {
      if (stream !== 'connected') return { ok: false, refused: 'offline' };
      batches += 1;
      const token = `b${batches}`;
      const started: string[] = [];
      for (const id of ids) if (start(id, action, token).ok) started.push(id);
      // Recorded HERE, at the keystroke, and provisionally: `batchId` is
      // null until the answer names it, and membership covers only the ids
      // that actually started. A card the keymap let through but the store
      // refused locally (an expired draft, a card somebody rejected from
      // another terminal) never reaches the wire, so it is in no batch — and
      // the batch card must not count it.
      batch = {
        token,
        batchId: null,
        action,
        ids: started,
        refused: [],
      };
      batchOf = new Map(started.map((id) => [id, token]));
      notify();
      return { ok: true, batchToken: token, started };
    },

    /**
     * The HTTP answer. Server truth about the row, and NOT the end of the
     * hypothesis: `approve` returns once the daemon has recorded an
     * approval, which is strictly before the send. The card stays optimistic
     * until the event says otherwise.
     */
    ack(id, answer) {
      const row = map.get(id);
      if (!row) return;
      put(id, { ...row, server: answer.draft });
      notify();
    },

    /**
     * Sc3's bulk is not atomic — one batch, one frame per draft, per-id
     * refusals, no rollback — so this mirrors it exactly. Rolling the whole
     * selection back on a partial refusal would show cards moving that the
     * daemon in fact moved.
     */
    applyBulk(result) {
      for (const { id, error } of result.refused) {
        const row = map.get(id);
        if (!row) continue;
        put(id, settled(row));
        // NOT overwritten if something got here first, and the something is
        // a `gate.denied` frame carrying the same refusal in better words.
        // The socket and the HTTP answer race: the frame names the specific
        // gate reason, which tells an operator when to try again, and the
        // route's per-id entry says `gate-denied`, which tells them only
        // that something said no. Whichever lands second must not be the one
        // that wins. (The specific reason is deliberately not spelled here:
        // S6's dormant-deny-literal guard counts a quoted mention in a
        // comment as a naming, and this renderer does not name it.) Clearing the hypothesis is unconditional — this is
        // about the WORDS on the card, not about leaving it claiming it was
        // approved.
        if (!chips.has(id)) setChip(id, { kind: 'denied', reason: error });
      }
      // Promote the provisional batch to the daemon's name for it, and drop
      // the ids that produced no Approval row.
      if (batch !== undefined) {
        const token = batch.token;
        batch = {
          ...batch,
          batchId: result.batchId,
          ids: result.appliedIds,
          refused: result.refused,
        };
        batchOf = new Map(result.appliedIds.map((id) => [id, token]));
      }
      notify();
    },

    conflict(id, answer) {
      const row = map.get(id);
      if (!row) return;
      put(id, {
        ...settled(row),
        observed: { state: answer.from, at: deps.now() },
      });
      setChip(id, { kind: 'changed-elsewhere', state: answer.from });
      notify();
    },

    refused(id, answer) {
      rollback(id, { kind: 'refused', reason: answer.reason });
    },

    denied(id, answer) {
      rollback(id, {
        kind: 'denied',
        reason: answer.reason,
        ...(answer.retryAfter === undefined
          ? {}
          : { retryAfter: answer.retryAfter }),
      });
    },

    failed(id, answer) {
      rollback(id, { kind: 'error', reason: answer.reason });
    },
  };
}
