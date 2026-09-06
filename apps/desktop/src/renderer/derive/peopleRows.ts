/**
 * The people screen's rows, and the words in them.
 *
 * One claim runs through every function here: with no `ContactPolicy` row
 * the gate DENIES. `evaluateGate` reads
 *
 *     if (ctx.rule !== null || agentOrigin) {
 *       if (ctx.contact === null || ctx.contact.mode === 'deny') {
 *         return { allow: false, reason: 'contact-denied' };
 *       }
 *
 * so absence and a stored DENY reach the same refusal, through the same
 * branch, and neither of them is "no policy yet". A grid whose policy column
 * were blank for a handle with no row would be drawing the strictest state
 * this product has as the ABSENCE of a state, and the operator waiting for a
 * reply that the daemon refused before it ever reached an agent would have no
 * way to find out from this screen. So the cell is never empty. `modeCell`
 * has no branch that returns `''`, and a unit row asserts it over every row
 * the grid can build.
 *
 * The rows are the UNION of two catalogues, which is the second half of the
 * same point. `GET /v1/contacts` returns handles somebody has already decided
 * about; the handles an operator is looking for are the ones nobody has, and
 * those exist only as the counterparty of a draft in the queue.
 *
 * Everything here is pure and takes the instant it needs as an argument. No
 * clock, no bridge, no fetch: an arch row proves it for the whole of
 * `derive/`.
 */
import type { ContactMode, ContactPolicyPayload } from '@wemessage/client';
import type { RespondMode } from './scopeLadder.js';

/** The chat-guid infix that makes a thread a ROOM rather than a person. */
const GROUP_INFIX = ';+;';
/** …and the one that separates a service from a handle on a 1:1 thread. */
const DIRECT_INFIX = ';-;';

/**
 * What the screen knows about the wire a handle was last seen on.
 *
 * `unknown` is a real answer and is NOT collapsed into `imessage`. The SMS
 * clamp is "not iMessage" rather than "is SMS" (`smsAutoForbidden`), so a
 * handle we have never observed a message for might well be clamped, and
 * guessing the permissive side is how a screen promises autonomy the daemon
 * will withhold.
 */
export type PersonService = 'imessage' | 'sms' | 'unknown';

export interface PersonRow {
  /** The grid's identity: the handle, or the guid for a room. */
  readonly key: string;
  /** Empty for a room: INV-5 says a room has no single counterparty. */
  readonly handle: string;
  /** The daemon's stored name, never one this screen invented. */
  readonly displayName: string;
  /** `null` when NO policy row exists, which is not the same as `deny`. */
  readonly mode: ContactMode | null;
  readonly service: PersonService;
  readonly isGroup: boolean;
  /** The last thread this handle was observed on, or `null`. */
  readonly chatGuid: string | null;
  /** How many drafts for this row are in the queue right now. */
  readonly queued: number;
}

export interface PeopleInput {
  readonly contacts: readonly ContactPolicyPayload[];
  /** Drafts, cut to the two fields this screen is entitled to see. */
  readonly drafts: readonly {
    readonly id: string;
    readonly chatGuid: string;
  }[];
  /**
   * Handles an operator has NAMED on this screen and which are in neither
   * catalogue yet.
   *
   * A handle nobody has messaged and nobody has decided about has no row in
   * `ContactPolicy` and no draft pointing at it, so there is nowhere to set
   * a policy before the first message arrives — and the first message is
   * precisely the one the gate refuses. These rows are LOCAL and carry no
   * mode: they are drawn exactly as any other handle with no policy is,
   * which is to say as denied for rules and agents, and they become real
   * the moment a mode is stored.
   */
  readonly named?: readonly string[];
}

/**
 * The sentence for a handle with no row of its own.
 *
 * Scoped, because the gate's branch is scoped: the deny is guarded by
 * `ctx.rule !== null || agentOrigin`, and `dispatchApproved` re-gates a
 * human-minted draft with a null rule and no agent origin. A human may still
 * approve for this handle. The one word this may never be is empty.
 */
export const UNKNOWN_MODE_SENTENCE = 'NO POLICY · DENIED FOR RULES AND AGENTS';

/** The chip bar. Four values, and the fourth is the absence of the other three. */
export const MODES = ['auto', 'draft-only', 'deny', 'none'] as const;
export type ModeFilter = (typeof MODES)[number];

/**
 * §2.4.3 and §1.7, split into the three things they actually are.
 *
 * Kept as three arrays rather than one string because the split is the fact
 * an operator needs. A DENY is evaluated before autonomy is even considered
 * — `if (!gate.allow) return gateDeny(...)` runs ahead of
 * `if (isAutoApproval)` in `dispatchApproved` — so it binds a human exactly
 * as hard as it binds the machine. A CLAMP lives inside the auto-approval
 * branch and binds nobody but the machine. One flat list would erase the
 * distinction that decides whether an operator can do anything about it.
 *
 * An arch row reads `CLAMP_ORDER` against the `clampedBy` assignments in
 * `evaluateGate`, in source order, so this cannot drift from the daemon's
 * else-if chain without failing the build.
 */
export const DENY_ORDER = ['KILL', 'LINK', 'CONTACT DENY'] as const;
export const NARROW_ORDER = ['GLOBAL', 'RULE', 'CONTACT', 'GROUP'] as const;
export const CLAMP_ORDER = [
  'WINDOW',
  'RATE CAP',
  'CIRCUIT',
  'LOOP',
  'SMS',
] as const;

/** The footer, as one line, with who each half binds. */
export const PRECEDENCE_LINE = `${[
  ...DENY_ORDER,
  ...NARROW_ORDER,
  ...CLAMP_ORDER,
].join(
  ' > ',
)} · DENIES BIND EVERYONE INCLUDING YOU · CLAMPS BIND ONLY AUTONOMY, SO YOU CAN STILL APPROVE`;

/* ── building the rows ────────────────────────────────────────────────── */

function isGroupGuid(guid: string): boolean {
  return guid.includes(GROUP_INFIX);
}

/** The counterparty of a 1:1 thread, or `null` for anything else. */
export function handleOf(guid: string): string | null {
  if (isGroupGuid(guid)) return null;
  const at = guid.indexOf(DIRECT_INFIX);
  if (at === -1) return null;
  const handle = guid.slice(at + DIRECT_INFIX.length);
  return handle.length > 0 ? handle : null;
}

function serviceOf(guid: string): PersonService {
  const at = guid.indexOf(';');
  if (at <= 0) return 'unknown';
  return guid.slice(0, at).toLowerCase() === 'imessage' ? 'imessage' : 'sms';
}

interface Draft {
  readonly key: string;
  readonly guid: string;
}

/**
 * Every handle the daemon knows about, from both directions.
 *
 * Sorted by key, so the grid's order is a property of the data rather than of
 * which catalogue happened to answer first — which matters more than it
 * sounds, because a bulk gesture issues one request per row IN THIS ORDER and
 * the typed confirm has to be able to name what is about to happen.
 */
export function peopleRows(input: PeopleInput): readonly PersonRow[] {
  const drafts: Draft[] = [];
  for (const draft of input.drafts) {
    const handle = handleOf(draft.chatGuid);
    drafts.push({ key: handle ?? draft.chatGuid, guid: draft.chatGuid });
  }
  const keys = new Set<string>();
  for (const contact of input.contacts) keys.add(contact.handle);
  for (const draft of drafts) keys.add(draft.key);
  for (const named of input.named ?? []) if (named !== '') keys.add(named);
  const byHandle = new Map(input.contacts.map((row) => [row.handle, row]));
  const rows: PersonRow[] = [];
  for (const key of [...keys].sort()) {
    const seen = drafts.filter((draft) => draft.key === key);
    const guid = seen[0]?.guid ?? null;
    const group = guid !== null && isGroupGuid(guid);
    const stored = byHandle.get(key);
    rows.push({
      key,
      handle: group ? '' : key,
      displayName: stored?.displayName ?? '',
      // A room has no counterparty, so it has no policy and never gains one:
      // INV-5 makes group threads observe-only, and a mode here would be a
      // control that writes a row the gate would never consult.
      mode: group ? null : (stored?.mode ?? null),
      service: guid === null ? 'unknown' : serviceOf(guid),
      isGroup: group,
      chatGuid: guid,
      queued: seen.length,
    });
  }
  return rows;
}

/**
 * The policy column, which is never blank.
 *
 * Four outcomes and no fifth: a room is observed and cannot be answered, a
 * stored mode is printed as the word it is, and the absence of a row gets the
 * sentence that says what the gate will do about it.
 */
export function modeCell(row: PersonRow): string {
  if (row.isGroup) return 'OBSERVE-ONLY · A ROOM IS NEVER ANSWERED';
  if (row.mode === null) return UNKNOWN_MODE_SENTENCE;
  return row.mode.toUpperCase();
}

export interface PeopleFilter {
  readonly search: string;
  /** `''` is every row; `'none'` is the rows with no policy at all. */
  readonly mode: ModeFilter | '';
}

/**
 * Search and the chips, LOCALLY.
 *
 * Both catalogues are already in hand, so narrowing them is a filter rather
 * than a request. A screen that refetched per keystroke would put a request
 * storm behind a text field, and an e2e row asserts the request log is
 * untouched while this runs.
 */
export function filterRows(
  rows: readonly PersonRow[],
  filter: PeopleFilter,
): readonly PersonRow[] {
  const needle = filter.search.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter.mode === 'none' && row.mode !== null) return false;
    if (
      filter.mode !== '' &&
      filter.mode !== 'none' &&
      row.mode !== filter.mode
    )
      return false;
    if (needle === '') return true;
    return (
      row.key.toLowerCase().includes(needle) ||
      row.displayName.toLowerCase().includes(needle)
    );
  });
}

/* ── the words the screen says around the grid ────────────────────────── */

/**
 * The empty state.
 *
 * Not "no contacts yet". An empty `ContactPolicy` table is a CONFIGURATION,
 * and it is the strictest one available: every rule and every agent is
 * refused at §2.4.3 step 3 for every handle. The sentence says that, because
 * the operator staring at an empty grid wondering why the agent they just
 * wired up answers nobody is the exact person this screen is for.
 */
export const EMPTY_SENTENCE =
  'NO CONTACT HAS A POLICY · EVERY HANDLE IS DENIED FOR RULES AND AGENTS UNTIL ONE IS SET HERE';

/**
 * …and the scope of that deny, which the sentence above would over-claim
 * without.
 *
 * `evaluateGate` guards step 3 with `ctx.rule !== null || agentOrigin`, and
 * `dispatchApproved` re-gates a human-minted draft with a null rule and no
 * agent origin. An operator who read "DENIED" full stop would stop
 * approving drafts that would have gone out perfectly well.
 */
export const DENY_NOTE =
  'THIS DENY BINDS RULES AND AGENTS · A HUMAN CAN STILL APPROVE A DRAFT FOR A HANDLE WITH NO ROW';

/** The phrase a bulk AUTO makes the operator type. Exact, case and all. */
export const BULK_AUTO_PHRASE = 'AUTO';

/**
 * How many rows are drawn at once.
 *
 * A window, and the screen says so rather than pretending the book is this
 * short. Two thousand policies is an ordinary number for a hotel and two
 * thousand rows of segmented controls is six thousand buttons; the honest
 * fix is to draw a page and make search reach the rest, which an e2e row
 * proves by finding a row the page does not contain.
 */
export const PAGE = 50;

/** The banner over the grid: the rung above every row on this screen. */
export function bannerOf(global: RespondMode): string {
  return `GLOBAL IS ${global.toUpperCase()} · ⌘6 SETTINGS CHANGES IT · NO ROW BELOW MAY WIDEN IT`;
}

/** What the window is hiding, and how to reach it. */
export function moreLine(drawn: number, total: number): string {
  return `SHOWING ${String(drawn)} OF ${String(total)} · SEARCH TO REACH THE REST`;
}

/** What a bulk AUTO is about to do, counted in ROWS and in REQUESTS. */
export function bulkBody(count: number): string {
  const contacts = `${String(count)} CONTACT${count === 1 ? '' : 'S'}`;
  const requests = `${String(count)} REQUEST${count === 1 ? '' : 'S'}`;
  return `SETTING ${contacts} TO AUTO IS ${requests}, ONE PER CONTACT: THERE IS NO BULK ROUTE FOR CONTACTS, SO THE DAEMON DECIDES THEM ONE AT A TIME AND MAY REFUSE ANY OF THEM. NOTHING ALREADY IN THE QUEUE IS RE-DECIDED. TYPE THE SENTENCE TO CONFIRM.`;
}

/** The row's `data-mode`, where the absence of a policy is a value. */
export function modeAttr(row: PersonRow): ModeFilter {
  return row.mode ?? 'none';
}

/* ── the AUTO-SENDS column ────────────────────────────────────────────── */

export interface AutoCell {
  /** `data-auto`: a count, or a hyphen when there is no count to give. */
  readonly value: string;
  readonly text: string;
  /** `data-held`: a `GateDenyReason`, or `''` when nothing is holding it. */
  readonly held: string;
}

export interface AutoCellInput {
  readonly isGroup: boolean;
  /** The LADDER's answer, not the stored mode. */
  readonly effective: ContactMode;
  readonly service: PersonService;
  readonly count: number;
  /** `heldBy(tally, caps) !== null`, decided against the daemon's caps. */
  readonly capped: boolean;
}

/**
 * The column, and the gate's order inside it.
 *
 * A hyphen rather than `0` wherever autonomy is not on the table at all: a
 * room (INV-5), a deny, or anything the ladder resolved below AUTO. Zero is
 * a count, and a count implies that one more would have been possible.
 *
 * When autonomy IS on the table, the clamps are reported in §1.7's order —
 * `overRateCap` is the third branch of the else-if chain and
 * `smsAutoForbidden` is the last, so a handle that is both over its cap and
 * on SMS is reported as over its cap, which is what the daemon would have
 * said. And a service nobody has observed says so, rather than guessing
 * iMessage: the clamp is "not iMessage", and the permissive guess is the
 * one that would make it invisible.
 */
export function autoCell(input: AutoCellInput): AutoCell {
  const n = String(input.count);
  if (input.isGroup || input.effective !== 'auto')
    return { value: '-', text: '-', held: '' };
  if (input.capped)
    return { value: n, text: `${n} · HELD · RATE CAP`, held: 'rate-limited' };
  if (input.service === 'sms')
    return {
      value: n,
      text: `${n} · HELD · SMS, NOT IMESSAGE`,
      held: 'sms-auto-forbidden',
    };
  if (input.service === 'unknown')
    return {
      value: n,
      text: `${n} · LAST HOUR · SERVICE NOT OBSERVED`,
      held: '',
    };
  return { value: n, text: `${n} · LAST HOUR`, held: '' };
}
