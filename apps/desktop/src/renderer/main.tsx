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
import ScheduleScreen from './screens/schedule/index.js';
import type {
  ScheduleDetailProps,
  ScheduleInUse,
  WindowEntry,
} from './screens/schedule/Detail.js';
import type { Gesture, GridProps } from './screens/schedule/Grid.js';
import type { BlockView } from './screens/schedule/Window.js';
import type { ScheduleRow } from './screens/schedule/List.js';
import { TypedConfirm } from './components/TypedConfirm.js';
import {
  acceptForm,
  editForm,
  formOf,
  formPatch,
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
import {
  contactLadder,
  globalModeOf,
  scopeLadder,
} from './derive/scopeLadder.js';
import PeopleScreen, {
  type ChipView,
  type PeopleScreenProps,
} from './screens/people/index.js';
import type { PeopleGridRow } from './screens/people/Grid.js';
import type { PeopleScopeProps } from './screens/people/Scope.js';
import {
  BULK_AUTO_PHRASE,
  DENY_NOTE,
  EMPTY_SENTENCE,
  MODES,
  PAGE,
  PRECEDENCE_LINE,
  autoCell,
  bannerOf,
  bulkBody,
  filterRows,
  modeAttr,
  modeCell,
  moreLine,
  peopleRows,
  type ModeFilter,
  type PersonRow,
} from './derive/peopleRows.js';
import { autoSendsPerHour, capsOf, heldBy } from './derive/autoSendsPerHour.js';
import { bindPeople, type PeopleBinding } from './store/people.js';
import {
  blocksOf,
  hhmmOf,
  hostZone,
  mergeWindows,
  minutesOf,
  noteTitle,
  nowInZone,
  orderedDays,
  scheduleProblems,
  weekFromDate,
  windowNote,
  type ScheduleValue,
  type WeekDay,
} from './derive/projectWindow.js';
import { bindStore, type StoreBinding } from './store/index.js';
import { bindRules, REPLAY_LIMIT, type RulesBinding } from './store/rules.js';
import { bindSchedule, type ScheduleBinding } from './store/schedule.js';
import type {
  ContactMode,
  SchedulePayload,
  ScheduleInput,
  ScheduleWindowPayload,
} from '@wemessage/client';
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
 * Only `queue`, `rules`, `schedule` and `people` have a surface in this
 * slice. A stroke for one of the other two is INERT rather than navigating
 * to a blank pane: an empty document with `data-screen="audit"` is a screen
 * that claims to exist, and the next scenario is the honest place to build
 * it.
 */
let screen: Screen = DEFAULT_SCREEN;
const MOUNTED: ReadonlySet<Screen> = new Set<Screen>([
  'queue',
  'rules',
  'schedule',
  'people',
]);

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
/**
 * WHICH irreversible thing the open confirm is about.
 *
 * One mount, three questions. The dialog owns `role="dialog"` for the whole
 * renderer and a second mount would be a second modal — so the phrase, the
 * title and the verb are chosen from this, and the `onGo` that runs is the
 * one that belongs to the sentence on screen. A single flag rather than
 * three nullable strings, because "two confirms open" is a state that must
 * not be spellable.
 */
let confirmIntent: 'auto' | 'delete-schedule' | 'bulk-auto' = 'auto';
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
    confirmIntent = 'auto';
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

/* ── the schedule editor ───────────────────────────────────────────────── */

/**
 * The third binding, and the third screen.
 *
 * Its own object again, and for the sharpest version of the reason: a
 * schedule is the most tempting place in this GUI to acquire a send path,
 * because "the window is open now" reads like an instruction. It is not.
 * `SCHEDULE_CHANNELS` is four channels, none of which can carry a draft id,
 * so "editing a schedule is not an approval" is a key set rather than a
 * promise — and an arch row scans every identifier in the binding for the
 * approval vocabulary in case somebody tries to write one anyway.
 */
const schedules: ScheduleBinding = bindSchedule(window.wm);

/**
 * The zone this DEVICE is in, read ONCE.
 *
 * Not per paint: it cannot change while the process is running, and reading
 * it in a component would put an environment lookup inside a render. It is
 * here for exactly one purpose — to say, in words, when the schedule an
 * operator is editing is not in the zone they are living in.
 */
const HOST_ZONE = hostZone();

/**
 * The app's ONE clock read for the schedule grid, and the marker's instant.
 *
 * A live NOW line is the obvious thing to build here and it is the wrong
 * thing. A timer is banned (Sc5) and a CSS keyframe sweep was considered and
 * rejected on the record: a linear twenty-four-hour animation is wrong by up
 * to an hour on exactly the two days a year this screen is about, which
 * would make the one moving thing on the grid lie on the only days the grid
 * has anything interesting to say.
 *
 * So the marker is a READING. It is stamped with the instant it was taken,
 * published as `data-now-iso` so the projection beside it can be checked
 * exactly, and it moves when an operator asks it to and at no other time.
 */
let nowIso = new Date().toISOString();

let scheduleId: string | null = null;
let scheduleForm: Form<ScheduleValue> | null = null;
/** The daemon's own complaints from the last refused write. */
let scheduleIssues: readonly FieldIssue[] = [];
/** The daemon's own error code from the last refused write. */
let scheduleRefusal: string | null = null;
/** The 409's count, plus the names this screen's own catalogue supplies. */
let scheduleInUse: ScheduleInUse | null = null;
let scheduleBusy = false;
/**
 * Any local date in the week the grid is showing, or `null` for "the one
 * the marker is in". Null rather than a date computed at open time, so the
 * default follows the clock instead of freezing whichever instant the screen
 * happened to be entered at.
 */
let scheduleWeek: string | null = null;

const DELETE_SCHEDULE = 'DELETE SCHEDULE';

/** The three fields this editor writes, off a row the daemon answered with. */
function valueOfSchedule(row: SchedulePayload): ScheduleValue {
  return { name: row.name, timezone: row.timezone, windows: row.windows };
}

function closeScheduleForm(): void {
  scheduleId = null;
  scheduleForm = null;
  scheduleIssues = [];
  scheduleRefusal = null;
  scheduleInUse = null;
  scheduleWeek = null;
  confirmTyped = null;
}

/**
 * Open a schedule from the list. No request, for Sc10's reason: the row is
 * already in hand and a GET per selection would be a round trip whose only
 * effect is to redraw the same fields.
 */
function openSchedule(id: string): void {
  const row = schedules.data().schedules.find((s) => s.id === id);
  if (row === undefined) return;
  closeScheduleForm();
  scheduleId = id;
  scheduleForm = formOf(valueOfSchedule(row));
  paint();
}

/** The seven local days the grid is drawn over, in the schedule's zone. */
function scheduleWeekDays(zone: string): WeekDay[] {
  const anchor = scheduleWeek ?? nowInZone(nowIso, zone)?.date ?? null;
  return anchor === null ? [] : weekFromDate(anchor, zone);
}

/**
 * One window, as a sentence, INCLUDING what this week does to it.
 *
 * The note is a property of the DAY rather than of the window, so it is
 * recomputed per visible week: the same 02:30 window is ordinary in June and
 * is a window that never opens on the second Sunday in March. §3.10 in its
 * strictest form — the hatching on the grid is a pattern, a pattern is a
 * colour with extra steps, and this is the word that carries the same state.
 */
function windowEntries(
  windows: readonly ScheduleWindowPayload[],
  week: readonly WeekDay[],
): WindowEntry[] {
  return windows.map((window, index) => {
    const days = orderedDays(window.days);
    const label = `${days
      .map((day) => day.toUpperCase())
      .join(' ')} ${window.start}–${window.end}`;
    const start = minutesOf(window.start);
    const end = minutesOf(window.end);
    if (start === null || end === null) return { index, text: label };
    const to = end <= start ? 1440 : end;
    const notes: string[] = [];
    for (const day of days) {
      const column = week.find((wd) => wd.day === day);
      if (column === undefined || column.shift === null) continue;
      const note = windowNote(start, to, column.shift);
      if (note.kind !== 'none' && !notes.includes(note.words))
        notes.push(note.words);
    }
    return {
      index,
      text: notes.length === 0 ? label : `${label} · ${notes.join(' · ')}`,
    };
  });
}

/** The rectangles, per column, with the day's seam applied to each. */
function scheduleGrid(
  value: ScheduleValue,
  week: readonly WeekDay[],
): GridProps {
  const zone = value.timezone;
  const blocks = blocksOf(value.windows);
  const at = nowInZone(nowIso, zone);
  return {
    zone,
    columns: week.map((column) => ({
      day: column.day,
      date: column.date,
      shift: column.shift,
      blocks: blocks
        .filter((block) => block.day === column.day)
        .map((block): BlockView => ({
          index: block.index,
          from: block.from,
          to: block.to,
          wraps: block.wraps,
          tail: block.tail,
          note: windowNote(block.from, block.to, column.shift).kind,
          title: noteTitle(block.from, block.to, column.shift, column.date),
          label: `${hhmmOf(block.from)}–${hhmmOf(block.to)}`,
        })),
    })),
    now:
      at === null
        ? null
        : {
            iso: nowIso,
            zone,
            date: at.date,
            day: at.day,
            minutes: at.minutes,
          },
    onGesture: onScheduleGesture,
  };
}

/**
 * A completed pointer gesture, applied to the DRAFT and to nothing else.
 *
 * Every path ends in `mergeWindows`, which is the GUI's promise and not the
 * daemon's: `canonicalWindows` dedupes and week-orders `days` INSIDE a
 * window and merges nothing, so two windows that overlap are stored as two
 * overlapping windows. Drawing them as two stacked bars would be drawing the
 * storage rather than the behaviour, and the behaviour is what the operator
 * is deciding about.
 *
 * Nothing here asks the daemon anything. A drag is an edit exactly as a
 * keystroke in the name field is; SAVE is the decision.
 */
function onScheduleGesture(gesture: Gesture): void {
  const form = scheduleForm;
  if (form === null || scheduleBusy) return;
  const current = form.draft.windows;
  let next: ScheduleWindowPayload[];
  if (gesture.kind === 'create') {
    next = [
      ...current,
      {
        days: [gesture.day],
        start: hhmmOf(gesture.from % 1440),
        // A window drawn to the bottom of a column closes at `00:00`, which
        // is the daemon's own spelling for the far end of a day.
        end: hhmmOf(gesture.to % 1440),
      },
    ];
  } else {
    const target = current[gesture.index];
    if (target === undefined) return;
    const start = minutesOf(target.start);
    const end = minutesOf(target.end);
    if (start === null || end === null) return;
    // Unwrapped into a monotonic pair first: a window that crosses a
    // midnight is one interval, and arithmetic on `end < start` in place
    // would make a drag on the tail move the head the wrong way.
    const finish = end <= start ? end + 1440 : end;
    let from = start;
    let to = finish;
    if (gesture.kind === 'resize') {
      if (gesture.edge === 'start') from = gesture.minute;
      else to = gesture.minute;
    } else {
      from = start + gesture.delta;
      to = finish + gesture.delta;
    }
    // A resize that inverts the window is not a window. Refused rather than
    // normalised: swapping the ends would silently turn "shrink this to
    // nothing" into a twenty-two-hour window nobody drew.
    if (to <= from) return;
    const wrap = (minute: number): string =>
      hhmmOf(((minute % 1440) + 1440) % 1440);
    next = current.map((window, index) =>
      index === gesture.index
        ? { days: [...window.days], start: wrap(from), end: wrap(to) }
        : window,
    );
  }
  scheduleForm = editForm(form, 'windows', mergeWindows(next));
  // The daemon's complaint was about the array as it stood. Keeping it on
  // screen over an array that has since been redrawn is a claim nobody made.
  scheduleIssues = [];
  scheduleRefusal = null;
  paint();
}

function removeScheduleWindow(index: number): void {
  const form = scheduleForm;
  if (form === null || scheduleBusy) return;
  scheduleForm = editForm(
    form,
    'windows',
    form.draft.windows.filter((_, at) => at !== index),
  );
  scheduleIssues = [];
  scheduleRefusal = null;
  paint();
}

function revertSchedule(): void {
  const form = scheduleForm;
  if (form === null) return;
  scheduleForm = revertForm(form);
  scheduleIssues = [];
  scheduleRefusal = null;
  scheduleInUse = null;
  paint();
}

/**
 * SAVE: one PATCH, carrying the WHOLE `windows` array.
 *
 * Not a diff of rectangles. `patchBody` is `scheduleFields.partial()`, so a
 * `windows` key REPLACES the array; a partial one would delete every day it
 * failed to mention, which is the kind of bug that looks like a rendering
 * glitch until somebody notices Thursday stopped answering.
 *
 * Note what the body cannot contain. `ScheduleValue` has three fields, all
 * of them schedule columns; there is no draft id, no approval and no
 * dispatch in the shape, and the binding reaches no channel that would take
 * one. Opening a window changes what AUTONOMY may do NEXT and says nothing
 * about work a human has already been asked to decide.
 */
async function saveSchedule(): Promise<void> {
  const form = scheduleForm;
  const id = scheduleId;
  if (form === null || id === null || scheduleBusy) return;
  const changed = formPatch(form);
  const body: Partial<ScheduleInput> = {};
  if (changed.name !== undefined) body.name = changed.name;
  if (changed.timezone !== undefined) body.timezone = changed.timezone;
  if (changed.windows !== undefined)
    body.windows = changed.windows.map((window) => ({
      days: [...window.days],
      start: window.start,
      end: window.end,
    }));
  scheduleIssues = [];
  scheduleRefusal = null;
  scheduleInUse = null;
  scheduleBusy = true;
  paint();
  const answer = await schedules.write(id, body);
  if (answer.ok) {
    // Rebaselined onto the row the DAEMON stored, never onto the body that
    // was sent: `canonicalWindows` week-orders `days` inside each window, so
    // a form that rebaselined onto its own request would say "no unsaved
    // changes" about an array the daemon had reordered underneath it.
    scheduleForm = acceptForm(form, valueOfSchedule(answer.schedule));
  } else {
    scheduleIssues = answer.issues;
    scheduleRefusal = answer.reason;
  }
  scheduleBusy = false;
  paint();
}

/** DELETE, which is a question this screen refuses to answer for itself. */
function askDeleteSchedule(): void {
  if (scheduleId === null || scheduleBusy) return;
  confirmIntent = 'delete-schedule';
  confirmTyped = '';
  paint();
}

/**
 * …and the ask, once the sentence has been typed.
 *
 * The request is MADE even though this screen holds the rules catalogue and
 * could pre-check it. Guessing is how a GUI ends up refusing something the
 * daemon would have allowed; the 409 is the daemon's answer and the count in
 * it is the daemon's count. Only the NAMES are local, because "which two" is
 * the question a person actually has and the wire does not carry it.
 */
async function deleteSchedule(): Promise<void> {
  const id = scheduleId;
  if (id === null || scheduleBusy) return;
  confirmTyped = null;
  scheduleInUse = null;
  scheduleBusy = true;
  paint();
  const answer = await schedules.remove(id);
  if (answer.ok) closeScheduleForm();
  else {
    const named = schedules
      .data()
      .rules.filter((rule) => rule.scheduleId === id)
      .map((rule) => rule.name.toUpperCase());
    scheduleInUse = { count: answer.rules ?? named.length, names: named };
  }
  scheduleBusy = false;
  paint();
}

/** The list, with the two numbers that say how much a schedule decides. */
function scheduleRows(): readonly ScheduleRow[] {
  const data = schedules.data();
  return data.schedules.map((row) => ({
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    enabled: row.enabled,
    windows: row.windows.length,
    rules: data.rules.filter((rule) => rule.scheduleId === row.id).length,
  }));
}

/**
 * What a shut window COSTS, counted by what each rule asked for.
 *
 * F-69: a stored `queue` degrades to `draft-only`, so it is counted with the
 * drafters rather than shown as a third thing that does not exist at
 * runtime. "IGNORES" is not pluralised because it is the verb.
 */
function scheduleFootnote(id: string): string {
  const rows = schedules.data().rules.filter((rule) => rule.scheduleId === id);
  const ignores = rows.filter((rule) => rule.outsideWindow === 'ignore').length;
  return `${String(rows.length)} RULE${rows.length === 1 ? '' : 'S'} · ${String(
    rows.length - ignores,
  )} STILL DRAFT · ${String(ignores)} IGNORES`;
}

/** Everything the detail pane renders, or `null` when nothing is open. */
function scheduleDetail(): ScheduleDetailProps | null {
  const form = scheduleForm;
  const id = scheduleId;
  if (form === null || id === null) return null;
  const zone = form.draft.timezone;
  const week = scheduleWeekDays(zone);
  const dirty = isDirty(form);
  const problems = scheduleProblems(form.draft);
  return {
    scheduleId: id,
    name: form.draft.name,
    zone,
    hostZone: HOST_ZONE,
    week: scheduleWeek ?? week[0]?.date ?? '',
    grid: scheduleGrid(form.draft, week),
    windows: windowEntries(form.draft.windows, week),
    dirty,
    saveDisabled: scheduleBusy || problems.length > 0 || !dirty,
    busy: scheduleBusy,
    // The daemon's issues FIRST. `issuesByPath` is first-wins, and
    // `scheduleProblems` is deliberately incomplete, so a field the
    // validator refused shows the validator's own sentence.
    issues: issuesByPath([...scheduleIssues, ...problems]),
    refusal: scheduleRefusal,
    inUse: scheduleInUse,
    armed: armingGlance(stream.armed),
    footnote: scheduleFootnote(id),
    onName: (next) => {
      if (scheduleForm === null) return;
      scheduleForm = editForm(scheduleForm, 'name', next);
      scheduleIssues = [];
      scheduleRefusal = null;
      paint();
    },
    onZone: (next) => {
      if (scheduleForm === null) return;
      scheduleForm = editForm(scheduleForm, 'timezone', next);
      scheduleIssues = [];
      scheduleRefusal = null;
      paint();
    },
    onWeek: (next) => {
      scheduleWeek = next;
      paint();
    },
    onNow: () => {
      nowIso = new Date().toISOString();
      paint();
    },
    onRemoveWindow: removeScheduleWindow,
    onSave: () => {
      void saveSchedule();
    },
    onRevert: revertSchedule,
    onDelete: askDeleteSchedule,
  };
}

/* ── contacts and policies ─────────────────────────────────────────────── */

/**
 * The fourth binding, and the fourth screen.
 *
 * Its own object again, and this is the screen where that matters most.
 * "This person is set to AUTO" reads like an instruction about the queue,
 * and it is not one: a contact policy governs what AUTONOMY may do NEXT and
 * says nothing at all about work a human has already been asked to decide.
 * `PEOPLE_CHANNELS` is five channels, exactly one of which writes, and none
 * of the five can carry a draft id — so "editing a policy is not an
 * approval" is a key set rather than a promise, and an arch row scans every
 * identifier in the binding for the approval vocabulary in case somebody
 * tries to write one anyway.
 */
const people: PeopleBinding = bindPeople(window.wm);

/**
 * The instant the AUTO-SENDS column is counted back from.
 *
 * Read HERE, once per visit, and handed down as an argument — never read in
 * the cell that draws the number. An hour window computed inside a render
 * would make the count a property of when Preact happened to paint, would
 * move without anything having happened, and would make the rate-cap row
 * untestable without racing a real clock (C-11). An arch row bans
 * `Date.now()` and `new Date()` under `screens/` and `derive/` precisely so
 * this stays the only place it can be read.
 *
 * Separate from `nowIso`, which belongs to the schedule marker and whose
 * contract is that it moves ONLY when an operator presses a button. Sharing
 * one variable would have silently given each screen the other's rule.
 */
let peopleNow = new Date().toISOString();

/** The narrowing an operator has typed, LOCALLY. Never a request. */
let peopleSearch = '';
/** The chip filter, where `'none'` is "has no policy row at all". */
let peopleMode: ModeFilter | '' = '';
/** The handle whose ladder is open, or `null`. */
let peopleScope: string | null = null;
/**
 * Handles named on this screen that are in neither catalogue.
 *
 * Local, and deliberately so: naming a handle is not deciding about one.
 * These rows draw exactly as any other handle with no policy does — denied
 * for rules and agents — until a mode is stored, at which point the daemon's
 * own row replaces them.
 */
let peopleNamed: readonly string[] = [];
/** The bulk selection, by key. */
const peoplePicked = new Set<string>();
let peopleBusy = false;
/** The DAEMON's own words from the last refused write. */
let peopleRefusal = '';
/** The rows the OPEN typed confirm is about, in the order they will be written. */
let peopleBulk: readonly string[] = [];

function closePeople(): void {
  peopleSearch = '';
  peopleMode = '';
  peopleScope = null;
  peopleNamed = [];
  peoplePicked.clear();
  peopleBusy = false;
  peopleRefusal = '';
  peopleBulk = [];
  confirmTyped = null;
}

/** Enter the screen: stamp the window's instant, then fetch. */
function loadPeople(): void {
  peopleNow = new Date().toISOString();
  void people.load();
}

/** Every handle the daemon knows about, plus the ones just named here. */
function peopleAll(): readonly PersonRow[] {
  const data = people.data();
  return peopleRows({
    contacts: data.contacts,
    drafts: data.drafts,
    named: peopleNamed,
  });
}

/**
 * THE write, and the only one this screen has.
 *
 * The stored name travels BACK with every policy change on purpose:
 * `PUT /v1/contacts/:handle` REPLACES the row and its handler spreads
 * `displayName` only when the body carries one, so a mode-only write would
 * quietly erase a name somebody typed on an earlier visit. The route is the
 * authority on that, not this comment — the binding merges on the handle the
 * daemon answers with, because the route normalizes it.
 */
async function writePolicy(key: string, mode: ContactMode): Promise<void> {
  const row = peopleAll().find((person) => person.key === key);
  // A room has no counterparty and therefore no policy (INV-5). There is no
  // control on screen that could ask for this, and it refuses anyway.
  if (row === undefined || row.isGroup) return;
  peopleBusy = true;
  peopleRefusal = '';
  paint();
  const outcome =
    row.displayName === ''
      ? await people.put(key, mode)
      : await people.put(key, mode, row.displayName);
  peopleBusy = false;
  // The daemon's sentence, letter for letter. `formProblems` has no
  // counterpart here because there is nothing to validate locally: the mode
  // comes from a closed set of three buttons.
  peopleRefusal = outcome.ok
    ? ''
    : [
        outcome.reason,
        ...outcome.issues.map((issue) => `${issue.path}: ${issue.message}`),
      ].join(' · ');
  paint();
}

/**
 * N writes, in the grid's order, one at a time.
 *
 * Sequential rather than parallel, and that is the honest shape: there is
 * no bulk route for contacts, the daemon decides each one separately and may
 * refuse any of them, and the typed confirm says so in the number of
 * REQUESTS. A `Promise.all` would land them in whatever order the socket
 * chose and make a partial failure impossible to describe.
 */
async function applyBulk(
  keys: readonly string[],
  mode: ContactMode,
): Promise<void> {
  for (const key of keys) await writePolicy(key, mode);
  peoplePicked.clear();
  peopleBulk = [];
  paint();
}

/**
 * A bulk gesture, and the one direction that has to be typed.
 *
 * DENY and DRAFT-ONLY narrow; AUTO is the only value on this screen that
 * takes autonomy away from a human, so it is the only one that asks. And it
 * asks for ONE row as readily as for forty: "it is only one" is exactly the
 * reasoning that turns a deliberate decision into a select that fires.
 */
function askBulk(mode: ContactMode): void {
  const keys = peopleAll()
    .filter((row) => peoplePicked.has(row.key) && !row.isGroup)
    .map((row) => row.key);
  if (keys.length === 0) return;
  if (mode !== 'auto') {
    void applyBulk(keys, mode);
    return;
  }
  peopleBulk = keys;
  confirmIntent = 'bulk-auto';
  confirmTyped = '';
  paint();
}

/** One drawn row, with the ladder and the hour window folded into it. */
function peopleGridRows(rows: readonly PersonRow[]): PeopleGridRow[] {
  const data = people.data();
  const global = globalModeOf(data.settings);
  const caps = capsOf(data.settings);
  const tallies = autoSendsPerHour(data.autoRows, data.draftRows, peopleNow);
  return rows.map((row) => {
    // The LADDER's answer, not the stored mode: a row set to AUTO under a
    // `draft-only` global may not auto-send, and a column that counted
    // against the stored value would be advertising autonomy the daemon
    // will withhold.
    const effective = contactLadder({ global, contact: row.mode }).effective;
    const tally = tallies.get(row.key) ?? { last2Min: 0, lastHour: 0 };
    const cell = autoCell({
      isGroup: row.isGroup,
      effective,
      service: row.service,
      count: tally.lastHour,
      capped: heldBy(tally, caps) !== null,
    });
    return {
      key: row.key,
      // A room's only name is its guid, so the guid is what is shown.
      handle: row.isGroup ? row.key : row.handle,
      // Uppercased HERE rather than in CSS: `text-transform` changes what is
      // painted and not what is read, and the e2e reads.
      name: row.displayName.toUpperCase(),
      modeAttr: modeAttr(row),
      mode: row.mode,
      modeText: modeCell(row),
      service: row.service,
      isGroup: row.isGroup,
      auto: cell.value,
      autoText: cell.text,
      held: cell.held,
      dim: row.isGroup || row.mode === 'deny',
      selected: peoplePicked.has(row.key),
      queued: row.queued,
    };
  });
}

function peopleView(): PeopleScreenProps {
  const data = people.data();
  const all = peopleAll();
  const shown = filterRows(all, { search: peopleSearch, mode: peopleMode });
  // A WINDOW, and the screen says so below it. Two thousand policies is an
  // ordinary number for a hotel and two thousand segmented controls is six
  // thousand buttons.
  const page = shown.slice(0, PAGE);
  const global = globalModeOf(data.settings);
  const open = all.find((row) => row.key === peopleScope) ?? null;
  let scope: PeopleScopeProps | null = null;
  if (open !== null && !open.isGroup) {
    const ladder = contactLadder({ global, contact: open.mode });
    scope = {
      rowKey: open.key,
      name: open.displayName.toUpperCase(),
      rungs: ladder.rungs.map((rung) => ({
        label: rung.label,
        value: rung.value,
      })),
      effective: ladder.effective,
      narrowed: ladder.narrowedBy.join(' > '),
      sentence: ladder.sentence,
      note: ladder.note,
    };
  }
  return {
    status: data.status,
    banner: bannerOf(global),
    globalMode: global,
    denyNote: DENY_NOTE,
    precedence: PRECEDENCE_LINE,
    // The sentence is about the BOOK, not about the filter: an empty result
    // for a search is not a claim about the gate.
    empty: all.length === 0 ? EMPTY_SENTENCE : '',
    search: peopleSearch,
    chips: MODES.map((mode): ChipView => ({
      mode,
      state: peopleMode === mode ? 'ON' : 'OFF',
    })),
    rows: peopleGridRows(page),
    total: shown.length,
    more: page.length < shown.length ? moreLine(page.length, shown.length) : '',
    picked: peoplePicked.size,
    scope,
    refusal: peopleRefusal,
    busy: peopleBusy,
    onSearch: (next) => {
      peopleSearch = next;
      paint();
    },
    onChip: (mode) => {
      // Matched against the closed set rather than cast into it: `MODES` is
      // the vocabulary, and a string that is not in it is not a filter.
      const picked = MODES.find((known) => known === mode) ?? null;
      if (picked === null) return;
      peopleMode = peopleMode === picked ? '' : picked;
      paint();
    },
    onAdd: () => {
      const handle = peopleSearch.trim();
      if (handle === '' || peopleNamed.includes(handle)) return;
      peopleNamed = [...peopleNamed, handle];
      paint();
    },
    onOpen: (key) => {
      peopleScope = peopleScope === key ? null : key;
      paint();
    },
    onPick: (key) => {
      if (peoplePicked.has(key)) peoplePicked.delete(key);
      else peoplePicked.add(key);
      paint();
    },
    onMode: (key, mode) => {
      // The ladder opens with the write, because the write is the moment an
      // operator most needs to be told that AUTO here may resolve to
      // DRAFT-ONLY. Silence would read as agreement.
      peopleScope = key;
      void writePolicy(key, mode);
    },
    onBulk: askBulk,
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
  closeScheduleForm();
  // RESET, then load. The catalogue held from a previous visit is a set of
  // claims about contacts, settings and counts that may all have moved; a
  // screen that painted `ready` from it would answer a harness's readiness
  // wait with last visit's facts.
  closePeople();
  rules.reset();
  schedules.reset();
  people.reset();
  if (next === 'rules') void rules.load(midnightIso());
  if (next === 'schedule') void schedules.load();
  if (next === 'people') loadPeople();
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
      ) : screen === 'people' ? (
        <PeopleScreen {...peopleView()} />
      ) : screen === 'schedule' ? (
        <ScheduleScreen
          status={schedules.data().status}
          list={{
            rows: scheduleRows(),
            selectedId: scheduleId,
            busy: scheduleBusy,
            onSelect: openSchedule,
          }}
          detail={scheduleDetail()}
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
      {confirmTyped === null ? null : confirmIntent === 'delete-schedule' ? (
        <TypedConfirm
          phrase={DELETE_SCHEDULE}
          title="DELETE THIS SCHEDULE"
          body="EVERY RULE THAT NAMES THIS SCHEDULE LOSES ITS WINDOW, AND THE DAEMON REFUSES WHILE ANY RULE STILL DOES. NOTHING ALREADY DRAFTED IS RE-DECIDED. TYPE THE SENTENCE TO CONFIRM."
          typed={confirmTyped}
          onType={(next) => {
            confirmTyped = next;
            paint();
          }}
          onGo={() => {
            void deleteSchedule();
          }}
        />
      ) : confirmIntent === 'bulk-auto' ? (
        <TypedConfirm
          phrase={BULK_AUTO_PHRASE}
          title="TURN ON AUTO REPLIES FOR THESE CONTACTS"
          body={bulkBody(peopleBulk.length)}
          typed={confirmTyped}
          onType={(next) => {
            confirmTyped = next;
            paint();
          }}
          onGo={() => {
            // The list is read BEFORE the dialog closes, because closing it
            // is what makes the screen redraw and the selection is what the
            // redraw is about.
            const keys = peopleBulk;
            confirmTyped = null;
            void applyBulk(keys, 'auto');
          }}
        />
      ) : (
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
  // The people screen's readiness idiom. The UNFILTERED total, because it is
  // a fact about the daemon's catalogues; what the grid draws is a window on
  // it and `#people-more` says so.
  if (screen === 'people')
    html.dataset['peopleRows'] = String(peopleAll().length);
  else delete html.dataset['peopleRows'];
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
schedules.subscribe(schedulePaint);
people.subscribe(schedulePaint);
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
