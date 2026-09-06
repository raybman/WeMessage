/**
 * s8 Scenario 15 — the onboarding wizard's exit states, as a total map.
 *
 * **The wizard's only real claim is that it cannot lie.** Every other
 * surface in this app is read by somebody who already trusts the product;
 * this one is read by somebody deciding whether to. So the rule the rest of
 * the slice keeps re-learning is absolute here: a step distinguishes
 * VERIFIED GOOD from NOT YET CHECKED from CHECKED AND FAILED, and the last
 * screen does not say the product is ready unless the daemon says so.
 *
 * **The vocabulary is not this module's.** `WizardExit` is
 * `link:${DownReason} | daemon:${ConnectionState}` — the desktop's four
 * link failures (`main/policy.ts`) crossed with the daemon's four connection
 * verdicts (`@wemessage/client`, mirroring core, narrowed at the wire by
 * `packages/daemon/src/doctor.ts`). `WIZARD_EXIT_SPEC` is a
 * `Readonly<Record<WizardExit, ExitSpec>>`, which rejects a missing key and
 * an extra one, so a fifth `DownReason` upstream is a COMPILE error in this
 * file rather than a wizard step that renders blank. `WIZARD_EXITS` is
 * `Object.keys` of it: the runtime list is derived and is never written down
 * a second time where the two could drift.
 *
 * Two words the S8 plan uses do not exist and this file is where that is
 * settled. There is no `auth` down-reason — the two auth failures are
 * `token-rejected` and `stream-refused` — and there is no `connected`
 * connection state; the daemon's healthy verdict is `fully-connected`. An
 * unknown word off the wire lands on `null`, which renders NOT CHECKED, and
 * never on a fabricated key.
 *
 * **NOT CHECKED is a state, not an absence.** {@link NOT_CHECKED_EXIT} is a
 * datum of its own — the link is up and the report could not be read — and
 * it is deliberately not a member of the exit vocabulary, because it is the
 * absence of a verdict rather than one. A wizard that rendered it as a pass,
 * or as a permanent spinner, would be the same lie in two costumes.
 *
 * **The states and glyphs are Sc14's.** OK / WARN / FAIL / NOT CHECKED and
 * the four glyphs come from `derive/permissionCards.ts` unchanged. The
 * instruction was explicit: do not mint a second permission vocabulary.
 *
 * No clock, no timer, no listener. Everything here is a pure function of a
 * link glance and a doctor report.
 */
import type { ConnectionState, DoctorReportPayload } from '@wemessage/client';
import type { DownReason } from '../../main/policy.js';
import { WIZARD_STEPS, type WizardStep } from '../router.js';
import {
  CARD_GLYPH,
  NOT_CHECKED,
  permissionCards,
  type CardState,
  type CheckId,
} from './permissionCards.js';

/**
 * Every way the wizard can be looking at the world, named once.
 *
 * A template-literal union rather than a hand-written list, so that the
 * cross product is computed by the compiler out of two unions this GUI does
 * not own. That is the whole mechanism behind "totality by type".
 */
export type WizardExit = `link:${DownReason}` | `daemon:${ConnectionState}`;

/** The link is up and the report could not be read. Not an exit. */
export const NOT_CHECKED_EXIT = 'not-checked';

/**
 * What an operator reads, per exit.
 *
 * `state` is Sc14's card state and may never be NOT CHECKED: an exit is by
 * construction a check that ANSWERED, and NOT CHECKED is what happens when
 * none did. `word` is the uppercase carrier §1.7 requires, and it is unique
 * across the eight so the exit is legible without the paragraph.
 */
export interface ExitSpec {
  readonly state: Exclude<CardState, typeof NOT_CHECKED>;
  readonly word: string;
  readonly title: string;
  readonly detail: string;
  /** Whether this exit may say the product is ready. Exactly one does. */
  readonly ready: boolean;
}

/**
 * The eight, in full, and the only place an exit literal is spelled.
 *
 * Every remedy here is something the operator can actually do. macOS TCC is
 * not grantable by an application, and neither is a rotated credential
 * recoverable by one, so the copy says what to go and do rather than
 * offering a button that would fail.
 */
export const WIZARD_EXIT_SPEC: Readonly<Record<WizardExit, ExitSpec>> = {
  'link:no-token': {
    state: 'FAIL',
    word: 'NOT SET UP',
    title: 'Nothing has run on this Mac yet',
    ready: false,
    detail:
      'The daemon mints its credential the first time it starts, and this ' +
      'app reads it from disk. Start it once from a terminal, then relaunch.',
  },
  'link:token-rejected': {
    state: 'FAIL',
    word: 'CREDENTIAL REFUSED',
    title: 'The daemon did not accept this app’s credential',
    ready: false,
    detail:
      'Something answered, and it refused what was presented. The usual ' +
      'cause is a rotation after this app read the file — disconnecting ' +
      'rotates it deliberately. Restart the daemon, then relaunch this app.',
  },
  'link:unreachable': {
    state: 'FAIL',
    word: 'NOT ANSWERING',
    title: 'Nothing is listening on that port',
    ready: false,
    detail:
      'The daemon is not running, or this app is pointed somewhere it is ' +
      'not. Start it, or point the app at the port it is actually on.',
  },
  'link:stream-refused': {
    state: 'FAIL',
    word: 'VERSION MISMATCH',
    title: 'The daemon refused the event subscription',
    ready: false,
    detail:
      'The credential was accepted and the subscription was not, which is ' +
      'what a version skew looks like from here. Update whichever of the ' +
      'two is older, then relaunch.',
  },
  'daemon:unsupported': {
    state: 'FAIL',
    word: 'UNSUPPORTED MACOS',
    title: 'This version of macOS is below the floor',
    ready: false,
    detail:
      'The database layout this product reads is not the one this release ' +
      'of macOS ships. Nothing else was checked, because nothing else ' +
      'would mean anything until this is fixed.',
  },
  'daemon:disconnected': {
    state: 'FAIL',
    word: 'NO DISK ACCESS',
    title: 'The daemon cannot read the message database',
    ready: false,
    detail:
      'Full Disk Access is granted by a person in System Settings and by ' +
      'nothing else — no application can grant it, including this one. ' +
      'Open the pane, add the daemon, then come back and re-check.',
  },
  'daemon:read-only': {
    state: 'WARN',
    word: 'READ ONLY',
    title: 'The daemon can send, but it cannot read',
    ready: false,
    detail:
      'Outgoing messages will work. Incoming ones will not be seen, so ' +
      'nothing will ever land in the queue for you to approve.',
  },
  'daemon:fully-connected': {
    state: 'OK',
    word: 'READY',
    title: 'The daemon is connected and reading',
    ready: true,
    detail:
      'Every check the daemon runs came back clean at the last probe. ' +
      'This is the daemon’s own verdict, not this app’s.',
  },
};

/**
 * The runtime list, derived. Sorted for a stable `data-exits`, which the
 * e2e reads as the app's own statement of what it is total over.
 */
export const WIZARD_EXITS = Object.keys(
  WIZARD_EXIT_SPEC,
).sort() as WizardExit[];

const EXIT_SET: ReadonlySet<string> = new Set<string>(WIZARD_EXITS);

/** Whether a word off the wire names an exit this build knows. */
function isExit(value: string): value is WizardExit {
  return EXIT_SET.has(value);
}

/** The two facts main pushes, as this module needs to read them. */
export interface LinkGlance {
  readonly state: string;
  readonly reason: string | null;
}

/**
 * The exit the app is in, or `null` for "nobody has established anything".
 *
 * Order matters and is the honest one: a dead link outranks any report,
 * because a report in hand while the socket is down is a memory of a probe
 * rather than a probe. A link that is neither up nor down — `reconnecting`
 * — is not an exit either; it is the in-flight state, and the wizard
 * renders that as NOT CHECKED with `data-probing`.
 */
export function exitFor(
  link: LinkGlance,
  report: DoctorReportPayload | null,
): WizardExit | null {
  if (link.state === 'down') {
    const key = `link:${link.reason ?? ''}`;
    return isExit(key) ? key : null;
  }
  if (link.state !== 'connected' || report === null) return null;
  const key = `daemon:${report.state}`;
  return isExit(key) ? key : null;
}

/** Everything a screen needs to render one exit, including none. */
export interface ExitView {
  readonly exit: WizardExit | typeof NOT_CHECKED_EXIT;
  readonly state: CardState;
  readonly word: string;
  readonly glyph: string;
  readonly title: string;
  readonly detail: string;
  readonly ready: boolean;
}

/**
 * Total over the exits AND over their absence.
 *
 * The `null` arm is the load-bearing one. It is why no screen in this flow
 * needs an `if` for the case where the report has not arrived: the absence
 * has a glyph, an uppercase word and a datum of its own, so "we do not know
 * yet" renders as a first-class answer rather than as a blank.
 */
export function exitView(exit: WizardExit | null): ExitView {
  if (exit === null)
    return {
      exit: NOT_CHECKED_EXIT,
      state: NOT_CHECKED,
      word: NOT_CHECKED,
      glyph: CARD_GLYPH[NOT_CHECKED],
      title: 'Nothing has been established yet',
      detail:
        'The daemon has not answered a probe this app could read, so no ' +
        'claim is being made about this Mac in either direction. Press ' +
        'RE-CHECK to ask again.',
      ready: false,
    };
  const spec = WIZARD_EXIT_SPEC[exit];
  return {
    exit,
    state: spec.state,
    word: spec.word,
    glyph: CARD_GLYPH[spec.state],
    title: spec.title,
    detail: spec.detail,
    ready: spec.ready,
  };
}

/**
 * Whether the operator may be told the product is ready.
 *
 * The whole scenario in one line, and the reason it reads the SPEC and not
 * the step list: five completed steps is a fact about the operator. The
 * only sentence worth printing is a quotation of the daemon's own verdict,
 * and `WIZARD_EXIT_SPEC` is where that verdict is turned into one.
 */
export function readyToFinish(exit: WizardExit | null): boolean {
  return exit !== null && WIZARD_EXIT_SPEC[exit].ready;
}

/**
 * How bad each state is, with the deliberate inversion in the middle.
 *
 * NOT CHECKED ranks ABOVE WARN. A warning is a thing somebody looked at; an
 * unchecked permission is a thing nobody did, and it can turn out to be a
 * failure. Ordering them the other way would let a step that probed nothing
 * present itself as milder than one that probed and found a nit.
 */
export const VERDICT_RANK: Readonly<Record<CardState, number>> = {
  OK: 0,
  WARN: 1,
  [NOT_CHECKED]: 2,
  FAIL: 3,
};

/** The worst of several states. Nothing to judge is OK, not unknown. */
export function worstOf(states: readonly CardState[]): CardState {
  let worst: CardState = 'OK';
  for (const state of states)
    if (VERDICT_RANK[state] > VERDICT_RANK[worst]) worst = state;
  return worst;
}

/** The step's heading, uppercase because §1.7 says status lines are. */
export const STEP_TITLE: Readonly<Record<WizardStep, string>> = {
  welcome: 'BEFORE WE START',
  'full-disk': 'FULL DISK ACCESS',
  automation: 'AUTOMATION',
  optional: 'OPTIONAL EXTRAS',
  'send-test': 'SEND A TEST',
};

/**
 * Which of the daemon's four checks each step is answerable for.
 *
 * A PARTITION, and the unit row proves it: the union is exactly `CHECK_IDS`
 * and no check appears twice. That is the structural half of "the wizard
 * cannot quietly drop a check the daemon reports" — a fifth check upstream
 * widens `CheckId`, and this record stops covering it.
 *
 * `welcome` owns the two that are facts about the machine rather than
 * grants: the OS version, and whether Messages is actually running. The two
 * TCC grants get a step each, because each has its own pane and its own
 * instructions. The last two steps own no check at all — there is nothing
 * for the daemon to say about "would you like notifications" — so they are
 * gated by the exit rather than by a verdict, which is why `worstOf([])` is
 * OK and not unknown.
 */
export const STEP_CHECKS: Readonly<Record<WizardStep, readonly CheckId[]>> = {
  welcome: ['os', 'messages'],
  'full-disk': ['fda'],
  automation: ['automation'],
  optional: [],
  'send-test': [],
};

/**
 * How this step is doing, from the daemon's report and nothing else.
 *
 * Routed through `permissionCards` rather than reading `report.checks`
 * directly, so the short-circuit semantics are Sc14's single implementation:
 * a check the daemon never reached is absent from `checks`, and absent means
 * NOT CHECKED, and NOT CHECKED is never OK.
 */
export function stepVerdict(
  step: WizardStep,
  report: DoctorReportPayload | null,
): CardState {
  const wanted: ReadonlySet<string> = new Set<string>(STEP_CHECKS[step]);
  return worstOf(
    permissionCards(report)
      .filter((card) => wanted.has(card.id))
      .map((card) => card.state),
  );
}

/**
 * `STEP 2 OF 5 · FULL DISK ACCESS`.
 *
 * Numbered off the router's list in both places, so a sixth step renumbers
 * every line rather than leaving a "STEP 5 OF 5" in the middle of six.
 */
export function progressLine(step: WizardStep): string {
  const index = WIZARD_STEPS.indexOf(step);
  return `STEP ${String(index + 1)} OF ${String(WIZARD_STEPS.length)} · ${STEP_TITLE[step]}`;
}
