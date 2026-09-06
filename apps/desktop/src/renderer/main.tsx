/**
 * The renderer's entry point, and the app's composition root.
 *
 * Everything that is not a pure function lives here, on purpose and in one
 * place: the bridge subscriptions, the queue's cursor, the paint schedule
 * and the `<html>` attributes the e2e waits on. An arch row asserts that no
 * file under `components/`, `screens/`, `keys/` or `derive/` names
 * `window.wm` or a bridge member, so "the view cannot fetch" is a property
 * of the tree rather than a habit — and the other half of that bargain is
 * that this file holds the state those views render.
 *
 * The `<html>` attributes are the contract with the test suite. `data-conn`
 * is the ONLY connection wait primitive the desktop e2e has and is written
 * from the same value the strip renders, so a harness that proceeds and a UI
 * that is lying about the connection cannot happen at the same time.
 * `data-store-*` is the same idea for the queue.
 *
 * Every payload arriving over the bridge is narrowed before it is used. It
 * comes from our own main process today, but the renderer is the process
 * that handles untrusted content, and a renderer that trusts its input shape
 * is one bad push away from a blank window with an empty console.
 *
 * NO TIMER. The app owns exactly one `setTimeout` and it is main's reconnect
 * backoff; an arch row proves the renderer has none. A burst of frames —
 * five hundred `message.received` in one ingest poll — is coalesced on a
 * MICROTASK instead, which is not a timer and cannot be tuned into a
 * debounce that hides a slow render.
 */
import { render } from 'preact';
import type { VNode } from 'preact';
import './theme/tokens.css';
import './app.css';
import { StateStrip } from './components/StateStrip.js';
import { armingGlance } from './derive/armingGlance.js';
import { batchOf } from './derive/batch.js';
import { byAge, cardOf, type CardModel } from './derive/queue.js';
import { moveTo, type QueueVerb } from './keys/index.js';
import { screenFor } from './keys/screens.js';
import { DEFAULT_SCREEN, type Screen } from './router.js';
import QueueScreen from './screens/queue/index.js';
import RulesScreen from './screens/rules/index.js';
import type { NamedOption, RuleDetailProps } from './screens/rules/Detail.js';
import type { ServerVerdict } from './screens/rules/Matcher.js';
import type { RuleRow } from './screens/rules/List.js';
import type { DryRunPanelProps } from './screens/rules/DryRun.js';
import WizardScreen from './screens/wizard/index.js';
import { TypedConfirm } from './components/TypedConfirm.js';
import {
  acceptForm,
  editForm,
  formOf,
  isDirty,
  issuesByPath,
  revertForm,
  type FieldIssue,
  type Form,
} from './derive/form.js';
import {
  AUTO_EVERYONE,
  NEW_RULE,
  formProblems,
  needsTypedConfirm,
  regexProblem,
  rulePatchOf,
  ruleInputOf,
  valueOf,
  type MatcherKind,
  type OutsideWindowChoice,
  type RespondChoice,
  type RuleFormValue,
} from './derive/ruleForm.js';
import {
  dryRunView,
  mirrorHits,
  shadowMap,
  type ShadowReplay,
} from './derive/dryRun.js';
import { rulesToday } from './derive/rulesToday.js';
import { globalModeOf, scopeLadder } from './derive/scopeLadder.js';
import { bindStore, type StoreBinding } from './store/index.js';
import { bindRules, REPLAY_LIMIT, type RulesBinding } from './store/rules.js';
import type { Conversation } from './store/optimistic.js';
import { applyTheme, asTheme } from './theme/theme.js';
import type { StreamPayload } from '../main/gateway.js';

const mount = document.getElementById('root');
if (mount === null) throw new Error('the document has no #root');
/**
 * Re-declared with the narrowed type rather than relying on the check above.
 * `paint` is a hoisted function declaration, and TypeScript will not carry a
 * control-flow narrowing into one; typing the binding says the same thing in
 * a way the compiler can use everywhere.
 */
const root: HTMLElement = mount;

/**
 * The state before main has said anything.
 *
 * `unreachable` rather than `no-token`: at this instant the app genuinely
 * does not know why, and guessing the friendlier of the two reasons would
 * mean flashing a card that tells the operator to go and look at a file that
 * may be perfectly fine.
 */
let stream: StreamPayload = {
  state: 'down',
  reason: 'unreachable',
  tokenPath: '',
  demo: false,
  armed: null,
  adapters: [],
};

function asStream(payload: unknown): StreamPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const state = p['state'];
  if (state === 'connected' || state === 'reconnecting' || state === 'down')
    return payload as StreamPayload;
  return null;
}

/* ── the queue's own state ────────────────────────────────────────────── */

/**
 * The cursor, held as an ID rather than as an index.
 *
 * An index is a claim about a list that changes underneath it: a draft
 * expiring two rows above the cursor would silently move the cursor onto a
 * different card, and the operator's next `a` would approve something they
 * were not looking at. An id survives that — the card either is still in the
 * queue or is not, and "is not" is resolved once, visibly, at derive time.
 */
let activeId: string | null = null;
/** The draft whose context turns are open inline, or none. */
let expandedId: string | null = null;
/**
 * The marked cards, by draft id (s8 Sc9).
 *
 * A mutable Set held here rather than derived, because a selection is the
 * one piece of queue state that is PURELY the operator's: nothing the daemon
 * says creates or removes a mark, and a selection recomputed from the rows
 * would be a selection that quietly changed every time a draft arrived.
 *
 * Insertion order is the order the operator picked, and it is the order the
 * bulk request names them in. That costs nothing and means a `refused` entry
 * can be read against the sequence the person actually performed.
 *
 * It is PRUNED at paint time, not here. A card that has left the queue
 * cannot be acted on, so a mark on it would make the header's count a
 * promise about drafts that are gone.
 */
const selected = new Set<string>();
/**
 * The body being edited, or `null` when the editor is closed, and the draft
 * it belongs to.
 *
 * Two variables rather than one object because they answer two questions the
 * app asks at different moments: the screen needs the TEXT to render, and the
 * commit stroke needs the ID to approve — and an id read out of the cursor at
 * commit time would approve whatever the list had moved to underneath a slow
 * typist.
 */
let editing: string | null = null;
let editingId: string | null = null;
/**
 * The draft `Z` takes back, remembered rather than searched for.
 *
 * The alternative is to look for the newest approved card, which is wrong the
 * instant the daemon sends one: undo would silently retarget to a different
 * draft than the one the operator just acted on. This names the exact card,
 * and `recall` refuses on the wire if its window has closed.
 */
let lastApprovedId: string | null = null;
/** So the catalogue is fetched when a link exists, and once per link. */
let catalogueFor: 'none' | 'connected' = 'none';

const binding: StoreBinding = bindStore(window.wm, {
  now: () => new Date().toISOString(),
});

/**
 * The queue handle the e2e drives.
 *
 * Not on `window.wm`: that object's key set is asserted against the channel
 * registry, and neither a debugging affordance nor a test hook has any
 * business widening the bridge. What is exposed here is the binding, whose
 * whole reachable surface is the five channels in `STORE_CHANNELS` — so a
 * renderer holding this handle can approve a draft and can no more send a
 * message than the keymap on top of it.
 */
declare global {
  interface Window {
    __wmQueue: StoreBinding;
  }
}
window.__wmQueue = binding;

/** Everything the queue screen renders, derived fresh from the store. */
interface QueueView {
  readonly cards: readonly CardModel[];
  readonly activeIndex: number;
  readonly thread: Conversation;
  readonly pending: number;
}

/**
 * Rows in, cards out. Pure with respect to the store, and cheap enough to
 * run again inside a key handler rather than being cached into a variable
 * that can go stale between a keystroke and the paint it caused.
 */
function derive(): QueueView {
  const store = binding.store;
  const catalogue = store.catalogue();
  const now = new Date().toISOString();
  const cards = store
    .rows()
    .map((row) => row.server)
    .sort(byAge)
    .map((draft) =>
      cardOf(draft, {
        catalogue,
        // The three-layer read, in the one place entitled to do it. A card
        // shows what we just did, else what we were told, else what we last
        // fetched — and every one of those is a display fact.
        state: store.stateOf(draft.id) ?? draft.state,
        chip: store.chip(draft.id),
        clampedBy: store.clampOf(draft.id),
        failedWith: store.failureOf(draft.id),
        now,
      }),
    );
  // An id that is no longer in the queue resolves to the top rather than to
  // nothing: the draft it named is gone, and a cursor pointing at a card
  // that does not exist is how `a` ends up doing nothing at all.
  const found =
    activeId === null ? -1 : cards.findIndex((c) => c.draftId === activeId);
  const activeIndex = cards.length === 0 ? -1 : found === -1 ? 0 : found;
  const active = activeIndex === -1 ? undefined : cards[activeIndex];
  return {
    cards,
    activeIndex,
    thread:
      active === undefined
        ? { total: 0, recent: [] }
        : binding.store.conversation(active.chatGuid),
    // What the operator still owes a decision on, which is not the length of
    // the list: a card that has been approved and is waiting on the daemon
    // is on screen and is no longer work.
    pending: cards.filter((card) => card.state === 'pending').length,
  };
}

/**
 * What assistive technology is told, and the whole of it.
 *
 * The size of the queue's REMAINING WORK and nothing else. Not the number
 * of cards: a card that has been approved is on screen and is no longer
 * something the operator owes a decision on, and a count that included it
 * would tell a person who has just cleared the queue that twenty drafts are
 * still waiting for them. The listbox announces its own
 * active option through `aria-activedescendant`, so a live region that also
 * described the cursor would make every `j` speak twice and make the
 * twenty-in-a-minute run unlistenable. What it cannot announce is a change
 * the operator did not cause — a draft arriving, a draft expiring — and that
 * is exactly what this says. Because the sentence is derived, the text node
 * only changes when the number does, so the region is silent between them.
 */
function announcementFor(view: QueueView): string {
  const size =
    view.cards.length === 0
      ? 'NO DRAFTS WAITING'
      : `${String(view.pending)} DRAFTS WAITING`;
  // The one thing the operator cannot see: a card that left. Prefixed rather
  // than announced separately so the region holds ONE sentence — two regions
  // race, and a screen reader reading them in schedule order would tell a
  // fast operator the count before the outcome that changed it.
  const outcome = binding.store.outcome();
  if (outcome === undefined) return size;
  return `${outcome === 'sent' ? 'DRAFT SENT' : 'DRAFT FAILED'} · ${size}`;
}

/**
 * A verb, applied. The only place the queue's state moves.
 *
 * Navigation clears the expansion. The inline turns are the ACTIVE
 * conversation's, so an expanded card left behind by the cursor would be
 * showing somebody else's messages under its own body — which is the single
 * worst thing this screen could do.
 */
function onVerb(verb: QueueVerb): void {
  const view = derive();
  const current = view.cards[view.activeIndex];
  if (verb === 'cancel-edit') {
    editing = null;
    editingId = null;
    schedulePaint();
    return;
  }
  if (verb === 'approve-edited') {
    // The id captured when the editor OPENED, and the text as it stands. A
    // commit that read the cursor here would approve whatever arrived while
    // the operator was typing.
    const id = editingId;
    const body = editing;
    editing = null;
    editingId = null;
    if (id !== null && body !== null) {
      lastApprovedId = id;
      void binding.approve(id, body);
      advancePast(view, id);
    }
    schedulePaint();
    return;
  }
  if (verb === 'clear-selection') {
    selected.clear();
    schedulePaint();
    return;
  }
  if (verb === 'bulk-approve' || verb === 'bulk-reject') {
    // Nothing selected is not a bulk. The keymap already refuses the stroke,
    // and this is the second half of the same statement: a shifted verb must
    // never quietly become its unshifted twin over the card under the cursor.
    if (selected.size === 0) return;
    const ids = [...selected];
    // Spent, and cleared BEFORE the request rather than after it. The act is
    // over the instant the keystroke is taken; a selection left standing
    // while the answer is in flight is a selection a second ⇧A could spend
    // twice.
    selected.clear();
    void binding.bulk(ids, verb === 'bulk-approve' ? 'approve' : 'reject');
    // The cursor deliberately does not move. A batch has no single "next
    // card" to advance to, and staying put is also what makes `z`
    // immediately afterwards mean the card the operator is looking at.
    schedulePaint();
    return;
  }
  if (verb === 'undo') {
    // The single-approve case names its card exactly; the BULK case has no
    // single card to name, so `Z` falls back to the one under the cursor —
    // which, because a bulk does not advance the cursor, is the card the
    // operator is looking at. The fallback is guarded on `approved` rather
    // than offered blindly: a recall of a pending or sent card is a refusal
    // the operator would have to read to understand.
    const id =
      lastApprovedId ??
      (current?.state === 'approved' ? current.draftId : null);
    if (id === null) return;
    void binding.recall(id);
    // Back to the card that was taken back. The operator's next keystroke is
    // about THAT draft — an undo that left the cursor two rows down would
    // make the following `a` approve a stranger.
    activeId = id;
    schedulePaint();
    return;
  }
  if (current === undefined) return;
  if (verb === 'select') {
    // Toggle, and only ever the card under the cursor. The cursor does not
    // move: an operator picking three cards out of twenty is READING each
    // one, and a jump after `x` would put the next `x` somewhere they were
    // not looking.
    if (!selected.delete(current.draftId)) selected.add(current.draftId);
    schedulePaint();
    return;
  }
  if (verb === 'approve') {
    // One key, two verbs, decided by the card rather than by the operator
    // remembering a second binding. A failed card cannot be approved —
    // `STARTABLE.approve` is `{pending}` — so `A` on one would be refused
    // locally with `wrong-state`, which is correct and useless to somebody
    // looking at a send that did not verify. `retry` is the verb that state
    // actually has, and the legend on the card says so.
    const retrying = current.state === 'failed';
    lastApprovedId = current.draftId;
    void (retrying
      ? binding.retry(current.draftId)
      : binding.approve(current.draftId));
    advancePast(view, current.draftId);
    schedulePaint();
    return;
  }
  if (verb === 'reject') {
    void binding.reject(current.draftId);
    advancePast(view, current.draftId);
    schedulePaint();
    return;
  }
  if (verb === 'edit') {
    editing = current.body;
    editingId = current.draftId;
    schedulePaint();
    return;
  }
  if (verb === 'expand') {
    expandedId = expandedId === current.draftId ? null : current.draftId;
    schedulePaint();
    return;
  }
  const next = view.cards[moveTo(verb, view.activeIndex, view.cards.length)];
  if (next === undefined) return;
  if (next.draftId !== current.draftId) expandedId = null;
  activeId = next.draftId;
  schedulePaint();
}

/**
 * The cursor step an ACTION makes, which the keymap deliberately does not.
 *
 * `moveTo` is a pure function of the verb and the list, and it returns the
 * same index for every action verb; the step belongs here because it is a
 * fact about this queue rather than about the keys. Acted-on cards STAY on
 * screen — approved, rejected and recalled all keep rendering — so the
 * cursor has to move past them explicitly or twenty `a` presses would all
 * land on the same card. The last card clamps: there is nowhere to go, and
 * jumping backwards would put an already-decided card under the next
 * keystroke.
 */
function advancePast(view: QueueView, id: string): void {
  const at = view.cards.findIndex((card) => card.draftId === id);
  if (at === -1) return;
  const next = view.cards[Math.min(at + 1, view.cards.length - 1)];
  if (next === undefined) return;
  if (next.draftId !== id) expandedId = null;
  activeId = next.draftId;
}

/**
 * Every keystroke inside the editor, straight into the module's state.
 *
 * Uncontrolled would be less code and would lose the text on any paint the
 * store causes underneath the operator — an arriving draft re-renders this
 * tree, and a textarea that is not told its value would be re-mounted empty.
 */
function onEdit(next: string): void {
  editing = next;
  schedulePaint();
}

/* ── the rules editor ──────────────────────────────────────────────────── */

/**
 * The second binding, and the second screen.
 *
 * It is a SEPARATE object from the queue's for the same reason the arch row
 * insists on it: the queue binding reaches `approve`, `bulk`, `recall`,
 * `reject` and `retry`, and a rules editor holding that object would be one
 * autocomplete away from being a second path to a dispatch. `RULES_CHANNELS`
 * is the whole of what this screen can reach and it contains one write —
 * `ruleWrite` — which cannot carry a draft id. That is INV-2 expressed as a
 * key set rather than as a promise.
 */
const rules: RulesBinding = bindRules(window.wm);

/**
 * The screen the ⌘-digit keymap last chose.
 *
 * Only `queue` and `rules` have a surface in this slice. A stroke for one of
 * the other four is INERT rather than navigating to a blank pane: an empty
 * document with `data-screen="audit"` is a screen that claims to exist, and
 * the next scenario is the honest place to build it.
 */
let screen: Screen = DEFAULT_SCREEN;
const MOUNTED: ReadonlySet<Screen> = new Set<Screen>(['queue', 'rules']);

/**
 * The rule being edited: `null` for none, `''` for one that is not stored.
 *
 * Three states rather than two because "no rule open" and "a new rule open"
 * are different screens, and a new rule has no id to ask the daemon about —
 * which is why DRY RUN is disabled until the first SAVE.
 */
let ruleId: string | null = null;
let ruleForm: Form<RuleFormValue> | null = null;
/** The daemon's own complaints from the last refused write. */
let ruleIssues: readonly FieldIssue[] = [];
let ruleServer: ServerVerdict | null = null;
let ruleBusy = false;
/** What has been typed into the confirm, or `null` when it is closed. */
let confirmTyped: string | null = null;
let dryRun: DryRunPanelProps | null = null;

/**
 * Local midnight, as the lower bound for "today".
 *
 * F-109: the per-rule count is DERIVED from `rule.matched` audit rows and is
 * never stored, so the day boundary is the operator's, in their timezone,
 * computed from the same clock the rest of the renderer reads.
 */
function midnightIso(): string {
  const now = new Date();
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).toISOString();
}

/** Close the editor without touching the catalogue. */
function closeRuleForm(): void {
  ruleId = null;
  ruleForm = null;
  ruleIssues = [];
  ruleServer = null;
  confirmTyped = null;
  dryRun = null;
}

/**
 * Open a rule from the list.
 *
 * Deliberately NO request. The row is already in hand — the list rendered
 * it — and a `GET /v1/rules/:id` per selection would be a round trip whose
 * only effect is to redraw the same fields. It would also make arrowing
 * down a list of forty rules forty requests.
 */
function openRule(id: string): void {
  const row = rules.data().rules.find((rule) => rule.id === id);
  if (row === undefined) return;
  closeRuleForm();
  ruleId = id;
  ruleForm = formOf(valueOf(row));
  paint();
}

/**
 * A rule that does not exist yet.
 *
 * The agent defaults to the FIRST one rather than to empty: the picker has
 * no empty option, so an empty default would render a select showing agent
 * one while the form believed nothing was chosen, and SAVE would stay
 * disabled with the complaint pointing at a field that looks filled in.
 */
function newRule(): void {
  closeRuleForm();
  ruleId = '';
  ruleForm = formOf({
    ...NEW_RULE,
    adapterId: rules.data().adapters[0]?.id ?? '',
  });
  paint();
}

function editRule<K extends keyof RuleFormValue>(
  key: K,
  value: RuleFormValue[K],
): void {
  if (ruleForm === null) return;
  ruleForm = editForm(ruleForm, key, value);
  // A field the operator changed invalidates the daemon's verdict about the
  // one before it. Stale is worse than absent here: a green MATCH under a
  // pattern that has since been retyped is a claim nobody made.
  ruleServer = null;
  paint();
}

function revertRule(): void {
  if (ruleForm === null) return;
  ruleForm = revertForm(ruleForm);
  ruleIssues = [];
  ruleServer = null;
  paint();
}

/**
 * SAVE.
 *
 * `armed` is the second half of the typed confirm: the first call arrives
 * with it false, opens the modal and returns having written nothing; the
 * modal's own button calls back with it true. There is no third path, so a
 * matcher that needs the sentence cannot be saved without it.
 *
 * Note what the body CANNOT contain. `rulePatchOf` derives from
 * `RuleFormValue`, whose every field is a rules column; there is no draft
 * id, no approval and no dispatch in the shape, and the binding reaches no
 * channel that would accept one. Editing a rule is not an approval.
 */
async function saveRule(armed: boolean): Promise<void> {
  const form = ruleForm;
  const id = ruleId;
  if (form === null || id === null || ruleBusy) return;
  if (!armed && needsTypedConfirm(form.draft)) {
    confirmTyped = '';
    paint();
    return;
  }
  const stored = rules.data().rules.find((rule) => rule.id === id);
  const body =
    id === ''
      ? ruleInputOf(form.draft)
      : stored === undefined
        ? null
        : rulePatchOf(form, stored);
  if (body === null) return;
  confirmTyped = null;
  ruleIssues = [];
  ruleBusy = true;
  paint();
  const answer = await rules.write(id === '' ? null : id, body);
  if (answer.ok) {
    ruleId = answer.rule.id;
    ruleForm = acceptForm(form, valueOf(answer.rule));
    // The replay described the rule as it WAS. Keeping it on screen next to
    // a saved change would be a preview of the wrong rule.
    dryRun = null;
    await rules.load(midnightIso());
  } else {
    ruleIssues =
      answer.issues.length > 0
        ? answer.issues
        : [{ path: 'rule', message: answer.reason }];
  }
  ruleBusy = false;
  paint();
}

/**
 * Ask the daemon what it thinks of the text in the pattern box.
 *
 * The only v1 route that scores anything is `POST /v1/rules/:id/test`, and
 * it scores the SAVED rule against a string. So this asks exactly that
 * question and the panel labels it as exactly that answer: it is not a
 * preview of the unsaved pattern, and pretending otherwise would be a green
 * tick over a rule that does not exist yet.
 *
 * On BLUR rather than as-you-type. Not a debounce — there is no timer and no
 * delay — the event simply is the operator finishing with the field.
 */
async function probePattern(): Promise<void> {
  const form = ruleForm;
  const id = ruleId;
  if (form === null || id === null || id === '') return;
  if (form.draft.kind !== 'regex') return;
  const pattern = form.draft.pattern;
  if (pattern.length === 0 || regexProblem(pattern) !== null) return;
  const matched = await rules.probe(id, pattern);
  ruleServer =
    matched === null
      ? { state: 'UNKNOWN', text: 'THE DAEMON DID NOT ANSWER' }
      : {
          state: matched ? 'MATCH' : 'NO-MATCH',
          text: matched
            ? 'THE RULE AS SAVED MATCHES THIS TEXT'
            : 'THE RULE AS SAVED DOES NOT MATCH THIS TEXT',
        };
  paint();
}

/**
 * The dry run, plus as many replays as it takes to explain a shadow.
 *
 * §1.7 stops at the first matching rule, so a row a higher-priority rule
 * takes is a row this rule never sees. Nothing on the wire can say that:
 * `DryRunRow` carries no rule id and the route scores ONE rule. So the
 * shadow is a join over guid across one replay per candidate.
 *
 * The candidates are filtered by a LOCAL mirror of each matcher first,
 * which is why the common case is one request rather than N. The mirror
 * fails open — an unmirrorable matcher is replayed — so it can cost a round
 * trip and can never hide a shadow.
 */
async function runDryRun(): Promise<void> {
  const form = ruleForm;
  const id = ruleId;
  if (form === null || id === null || id === '' || ruleBusy) return;
  const all = rules.data().rules;
  const self = all.find((rule) => rule.id === id);
  if (self === undefined) return;
  ruleBusy = true;
  paint();
  const result = await rules.replay(id);
  if (result !== null) {
    const hits = result.rows.filter((row) => row.matched);
    const replays: ShadowReplay[] = [];
    const above = all
      .filter(
        (rule) =>
          rule.id !== id &&
          rule.enabled &&
          (rule.priority < self.priority ||
            (rule.priority === self.priority && rule.id < self.id)),
      )
      .sort(
        (a, b) =>
          a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    if (hits.length > 0)
      for (const candidate of above) {
        if (!mirrorHits(hits, valueOf(candidate))) continue;
        const replay = await rules.replay(candidate.id);
        if (replay === null) continue;
        replays.push({
          id: candidate.id,
          name: candidate.name,
          priority: candidate.priority,
          rows: replay.rows,
        });
      }
    dryRun = {
      total: result.total,
      matched: result.matched,
      limit: REPLAY_LIMIT,
      rows: dryRunView(result.rows, form.draft, shadowMap(replays)),
    };
  }
  ruleBusy = false;
  paint();
}

/**
 * Move one rule to where another one is.
 *
 * The multiset of priorities is PRESERVED and reassigned positionally, so a
 * reorder touches only the rules whose number actually changed — three
 * PATCHes for a four-rule move, not four — and cannot invent a priority the
 * operator never chose.
 *
 * Sequential, and the list is NOT painted optimistically. An optimistic
 * first row would let a harness proceed on the new order while the writes
 * were still in flight, and the order on screen would be a claim about a
 * daemon that had not answered yet. The reload at the end is what makes the
 * order true.
 */
async function reorderRules(fromId: string, toId: string): Promise<void> {
  if (ruleBusy) return;
  const current = rules.data().rules;
  const from = current.findIndex((rule) => rule.id === fromId);
  const to = current.findIndex((rule) => rule.id === toId);
  const moved = current[from];
  if (from === -1 || to === -1 || from === to || moved === undefined) return;
  const next = [...current.slice(0, from), ...current.slice(from + 1)];
  next.splice(to, 0, moved);
  const slots = current.map((rule) => rule.priority).sort((a, b) => a - b);
  ruleBusy = true;
  paint();
  for (const [index, rule] of next.entries()) {
    const priority = slots[index];
    if (priority === undefined || priority === rule.priority) continue;
    await rules.write(rule.id, { priority });
  }
  await rules.load(midnightIso());
  ruleBusy = false;
  paint();
}

/** The list, with F-109's count attached. */
function ruleRows(): readonly RuleRow[] {
  const data = rules.data();
  const today = rulesToday(data.audit, new Date().toISOString());
  return data.rules.map((rule) => ({
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    respond: !rule.enabled
      ? 'OFF'
      : rule.respondMode === 'auto'
        ? 'AUTO'
        : 'DRAFT-ONLY',
    today: today.get(rule.id) ?? 0,
    priority: rule.priority,
  }));
}

function namedOptions(
  rows: readonly { id: string; name?: string; displayName?: string }[],
): readonly NamedOption[] {
  return rows.map((row) => ({
    id: row.id,
    label: row.displayName ?? row.name ?? row.id,
  }));
}

/** Everything the detail pane renders, or `null` when nothing is open. */
function ruleDetail(): RuleDetailProps | null {
  const form = ruleForm;
  const id = ruleId;
  if (form === null || id === null) return null;
  const data = rules.data();
  const problems = formProblems(form.draft);
  const dirty = isDirty(form);
  return {
    ruleId: id,
    value: form.draft,
    dirty,
    // A stored rule with nothing changed has nothing to save. A NEW rule is
    // clean by construction until the first keystroke and still needs a
    // reachable SAVE, so only the stored branch consults dirtiness.
    saveDisabled: ruleBusy || problems.length > 0 || (id !== '' && !dirty),
    busy: ruleBusy,
    // The daemon's issues FIRST. `issuesByPath` is first-wins, so a field
    // the validator refused shows the validator's own sentence and the
    // renderer's guess about the same field never overwrites it.
    issues: issuesByPath([...ruleIssues, ...problems]),
    adapters: namedOptions(data.adapters),
    schedules: namedOptions(data.schedules),
    ladder: scopeLadder({
      global: globalModeOf(data.settings),
      rule: form.draft.respond === 'AUTO' ? 'auto' : 'draft-only',
      policies: data.contacts.length,
    }),
    // Drafts this rule already minted. Saving does not re-decide them, and
    // the pane says so: see `#rule-inflight`.
    inflight:
      id === '' ? 0 : data.live.filter((draft) => draft.ruleId === id).length,
    patternProblem:
      form.draft.kind !== 'regex'
        ? null
        : form.draft.pattern.length === 0
          ? 'A PATTERN IS REQUIRED'
          : regexProblem(form.draft.pattern),
    serverVerdict: ruleServer,
    onName: (next) => {
      editRule('name', next);
    },
    onKind: (kind: MatcherKind) => {
      editRule('kind', kind);
    },
    onKeywords: (next) => {
      editRule('keywords', next);
    },
    onMode: (mode) => {
      editRule('mode', mode);
    },
    onFlag: (flag, next) => {
      if (flag === 'case') editRule('caseSensitive', next);
      else if (flag === 'word') editRule('wholeWord', next);
      else editRule('allowGroupDrafts', next);
    },
    onPattern: (next) => {
      editRule('pattern', next);
    },
    onPatternBlur: () => {
      void probePattern();
    },
    onHandles: (next) => {
      editRule('handles', next);
    },
    onAdapter: (adapter) => {
      editRule('adapterId', adapter);
    },
    onRespond: (choice: RespondChoice) => {
      editRule('respond', choice);
    },
    onSchedule: (schedule) => {
      editRule('scheduleId', schedule);
    },
    onOutside: (choice: OutsideWindowChoice) => {
      editRule('outsideWindow', choice);
    },
    onTtl: (minutes) => {
      editRule('draftTtlMinutes', minutes);
    },
    onSave: () => {
      void saveRule(false);
    },
    onRevert: revertRule,
    onDryRun: () => {
      void runDryRun();
    },
  };
}

/**
 * The app's ONE window-level key listener.
 *
 * One, and an arch row proves it: a second `addEventListener` anywhere under
 * `apps/desktop/src` fails the build. Two listeners is how a modal ends up
 * with a navigation stroke firing underneath it.
 *
 * There is no click listener. Every clickable thing in the tree is a real
 * `<button>` with an `onClick` prop, which is what makes it reachable by
 * keyboard as well as by pointer; delegating clicks from `window` would put
 * behaviour on elements that never announce they have any.
 */
function onWindowKey(event: KeyboardEvent): void {
  // ESCAPE and ENTER both CANCEL while the confirm is up. Enter especially:
  // the whole point of a typed confirm is that the sentence is typed and
  // then the button is chosen, and an Enter that submitted would put the
  // most reflexive keystroke on the keyboard in charge of arming autonomy.
  if (confirmTyped !== null) {
    if (event.key !== 'Escape' && event.key !== 'Enter') return;
    event.preventDefault();
    confirmTyped = null;
    paint();
    return;
  }
  const next = screenFor(event);
  if (next === null || !MOUNTED.has(next)) return;
  event.preventDefault();
  if (next === screen) return;
  screen = next;
  closeRuleForm();
  // RESET, then load. The catalogue held from a previous visit is a set of
  // claims about contacts, settings and counts that may all have moved; a
  // screen that painted `ready` from it would answer a harness's readiness
  // wait with last visit's facts.
  rules.reset();
  if (next === 'rules') void rules.load(midnightIso());
  paint();
}

function Shell({
  stream: current,
  view,
}: {
  stream: StreamPayload;
  view: QueueView;
}): VNode {
  return (
    <div id="app">
      <StateStrip
        stream={current}
        pending={view.pending}
        syncedAt={binding.store.syncedAt()}
        now={new Date().toISOString()}
      />
      {current.state === 'down' ? (
        <WizardScreen stream={current} />
      ) : screen === 'rules' ? (
        <RulesScreen
          status={rules.data().status}
          list={{
            rows: ruleRows(),
            selectedId: ruleId,
            onSelect: openRule,
            onReorder: (fromId, toId) => {
              void reorderRules(fromId, toId);
            },
            onNew: newRule,
            busy: ruleBusy,
          }}
          detail={ruleDetail()}
          dryRun={dryRun}
        />
      ) : (
        <QueueScreen
          cards={view.cards}
          activeIndex={view.activeIndex}
          expandedId={expandedId}
          selected={selected}
          batch={batchOf(binding.store.batch(), binding.store.catalogue())}
          thread={view.thread}
          demo={current.demo}
          // From the STORE, not from `current`. Both are narrowed from the
          // same push, but this is the value that decides whether a
          // keystroke reaches the wire, and a screen that said `connected`
          // while the reducer refused would be the exact lie this scenario
          // exists to make impossible.
          link={binding.store.streamState()}
          attempt={current.state === 'reconnecting' ? current.attempt : 0}
          stale={binding.store.needsSnapshot()}
          syncedAt={binding.store.syncedAt()}
          arming={armingGlance(current.armed)}
          watching={binding.store.catalogue().watching}
          announcement={announcementFor(view)}
          editing={editing}
          onEdit={onEdit}
          onVerb={onVerb}
        />
      )}
      {/* Outside the screen branch on purpose: the modal belongs to the
          document, not to the pane underneath it, and mounting it inside
          the detail pane would put a dialog inside a form. */}
      {confirmTyped === null ? null : (
        <TypedConfirm
          phrase={AUTO_EVERYONE}
          title="TURN ON AUTO REPLIES"
          body="THIS RULE WILL ANSWER BY ITSELF, FOR EVERY MESSAGE IT MATCHES, UNTIL SOMEBODY TURNS IT OFF. TYPE THE SENTENCE TO CONFIRM."
          typed={confirmTyped}
          onType={(next) => {
            confirmTyped = next;
            paint();
          }}
          onGo={() => {
            void saveRule(true);
          }}
        />
      )}
    </div>
  );
}

/* ── painting ─────────────────────────────────────────────────────────── */

/**
 * The store's own facts, as attributes.
 *
 * The readiness idiom the whole desktop suite waits on. Written from the
 * same store read the screen renders from, in the same paint, so a harness
 * that proceeds on `data-store-rows` and a list that has not drawn those
 * rows yet cannot happen.
 */
function paintStore(): void {
  const html = document.documentElement;
  const store = binding.store;
  html.dataset['storeRows'] = String(store.rows().length);
  html.dataset['storeMissed'] = String(store.missed());
  html.dataset['storeStale'] = store.needsSnapshot() ? 'yes' : 'no';
  const at = store.syncedAt();
  if (at === undefined) delete html.dataset['storeSyncedAt'];
  else html.dataset['storeSyncedAt'] = at;
}

function paint(): void {
  const html = document.documentElement;
  html.dataset['conn'] = stream.state;
  if (stream.state === 'down') {
    html.dataset['screen'] = 'wizard';
    html.dataset['wizardStep'] = 'welcome';
  } else {
    html.dataset['screen'] = screen;
    delete html.dataset['wizardStep'];
  }
  // The rules screen's readiness idiom, written in the same paint that
  // renders the rows it counts, for the same reason `data-store-rows` is.
  if (screen === 'rules')
    html.dataset['rulesRows'] = String(rules.data().rules.length);
  else delete html.dataset['rulesRows'];
  const view = derive();
  // Written back so the cursor SURVIVES the resolution above. A queue whose
  // active card expired keeps re-resolving to the top on every paint; naming
  // the card it landed on makes the next `j` move from there.
  activeId = view.cards[view.activeIndex]?.draftId ?? null;
  // A mark on a card that has left the queue is a promise about a draft that
  // is gone: `⇧A` could not act on it, and the header's count would be
  // describing a selection the operator cannot see. Pruned against the rows
  // that are actually on screen, in the same paint that renders them.
  if (selected.size > 0) {
    const present = new Set(view.cards.map((card) => card.draftId));
    for (const id of selected) if (!present.has(id)) selected.delete(id);
  }
  paintStore();
  const wasEditing = painted;
  painted = editing;
  render(<Shell stream={stream} view={view} />, root);
  // Focus handed BACK, in the same paint the editor unmounted in. Preact has
  // already removed the textarea by the time this runs, and a removed element
  // takes the focus to `<body>` with it — where the listbox's key handler is
  // not, so the next `a` would vanish with no visible cause. This is the one
  // imperative focus move in the app and it exists because the alternative
  // silently breaks the keyboard.
  if (wasEditing !== null && editing === null) {
    document.getElementById('queue-list')?.focus();
  }
}

/** What the LAST paint rendered, so the unmount above can be detected. */
let painted: string | null = null;

/**
 * One paint per microtask, however many facts changed.
 *
 * Five hundred `message.received` frames arrive from one ingest poll as five
 * hundred synchronous `notify()` calls, and painting each would be five
 * hundred renders of a list that ends in one state. Coalescing on a
 * microtask is the version of that fix which needs no timer, cannot be
 * "tuned" into a delay that hides a slow render, and still guarantees the
 * DOM is correct before control returns to the event loop — which is what
 * lets the e2e assert on the very next tick.
 */
let painting = false;
function schedulePaint(): void {
  if (painting) return;
  painting = true;
  queueMicrotask(() => {
    painting = false;
    paint();
  });
}

binding.store.subscribe(schedulePaint);
rules.subscribe(schedulePaint);
window.addEventListener('keydown', onWindowKey);

window.wm.on('stream', (payload: unknown) => {
  const next = asStream(payload);
  if (next === null) return;
  stream = next;
  // The catalogue is fetchable only while there is a daemon to fetch it
  // from, so the composition root asks on the edge INTO `connected` rather
  // than at mount: at mount the request is guaranteed to fail, and a name
  // catalogue that is empty because nobody was listening is indistinguishable
  // on screen from one that is empty because there are no contacts.
  //
  // On the edge and not on every push: `stream` fires for every reconnect
  // attempt, and a fetch per attempt would put a request storm behind a
  // flapping socket. `bindStore` itself never does this — four unit rows pin
  // the exact channel sequence its connect path produces — because the
  // decision about when names are worth a round trip belongs to the root.
  const linked = next.state === 'connected' ? 'connected' : 'none';
  if (linked !== catalogueFor) {
    catalogueFor = linked;
    if (linked === 'connected') void binding.loadCatalogue().then(paint, paint);
  }
  paint();
});

window.wm.on('theme', (payload: unknown) => {
  const theme = asTheme(payload);
  if (theme !== null) applyTheme(theme);
});

paint();
