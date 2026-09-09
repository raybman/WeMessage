/**
 * s8 Scenario 15 — the onboarding wizard, and the only surface in this app
 * guaranteed to run while something is already wrong.
 *
 * **Everything here is about not lying.** Every other screen is read by
 * somebody who already trusts the product; this one is read by somebody
 * deciding whether to. So the three-way distinction the rest of the slice
 * keeps re-learning is absolute here and it is carried in the DOM rather
 * than in prose: VERIFIED GOOD, NOT YET CHECKED, and CHECKED AND FAILED are
 * three different `data-state` values on the exit, on the step verdict and
 * on each of the four cards, and NOT YET CHECKED is never drawn as a pass.
 *
 * **The readiness claim is a quotation.** `data-ready` comes from
 * `readyToFinish`, which reads `WIZARD_EXIT_SPEC`, which carries `ready` on
 * exactly one exit, which is minted only from a report the DAEMON returned.
 * Five completed steps is a fact about the operator; this screen is not
 * allowed to confuse the two, and an arch row asserts that any file
 * rendering that datum derives it that way.
 *
 * **No timer, no clock, no listener.** "Checking…" is `data-probing`, which
 * is the lifetime of a promise and not a scheduled callback, so a spinner
 * cannot outlive the request it is reassuring somebody about. There is no
 * poll and no re-probe on advance: one report answers all four checks, and
 * asking again is a GESTURE — the operator grants the permission in the
 * pane a card opened, comes back, and presses RE-CHECK.
 *
 * **It grants nothing.** macOS TCC is not writable by an application, by
 * the OS's design. The most this screen may offer for a refused permission
 * is to put the operator in front of the pane they have to act in, and it
 * does that by handing main a pane NAME off a closed allowlist. There is no
 * URL here, no `shell`, and no navigation: the window refuses those anyway
 * (Sc 4), and a wizard that needed one would be a wizard asking to be the
 * exception.
 *
 * **It is a MODE, not a destination.** It is not in `SCREENS`, so it has no
 * ⌘-digit and does not add a tab stop to the surface whose one-tab-stop
 * claim Sc8's checkpoint rests on. It arrives on its own when the link goes
 * down, and is asked for by name from the Permissions pane when it has not.
 * It is left by the one control at the bottom right — which is rendered
 * only while there is a link, because with no daemon there is nowhere for
 * that control to go and a button that does nothing is the same lie in a
 * quieter costume.
 */
import type { ComponentChildren, VNode } from 'preact';
import { CARD_GLYPH, type CardState } from '../../derive/permissionCards.js';
import {
  exitView,
  progressLine,
  readyToFinish,
  VERDICT_RANK,
  WIZARD_EXITS,
  type WizardExit,
} from '../../derive/wizardExits.js';
import { WIZARD_STEPS, type WizardStep } from '../../router.js';
import { NotFoundCard, type Down } from './NotFound.js';

/** One permission card, flattened to what the DOM needs. Sc14's vocabulary. */
export interface WizardCardView {
  readonly check: string;
  readonly state: string;
  readonly glyph: string;
  readonly word: string;
  readonly detail: string;
  /** A pane NAME off main's closed allowlist, or `null` for no remedy. */
  readonly pane: string | null;
}

export interface WizardScreenProps {
  readonly step: WizardStep;
  /** The exit the app is in, or `null` for "nobody has established anything". */
  readonly exit: WizardExit | null;
  /** How THIS step's own checks came back. Never better than the worst. */
  readonly verdict: CardState;
  readonly cards: readonly WizardCardView[];
  /** A probe is in the air. The whole of "checking…", and it needs no clock. */
  readonly probing: boolean;
  /** The link's own card, when there is no link. */
  readonly down: Down | null;
  readonly handle: string;
  /** Four hex characters, minted by MAIN. This screen only displays them. */
  readonly code: string | null;
  readonly outcome: CardState;
  readonly failure: string;
  readonly onBack: () => void;
  readonly onContinue: () => void;
  readonly onRecheck: () => void;
  readonly onFinish: () => void;
  readonly onHandle: (next: string) => void;
  readonly onSend: () => void;
  readonly onOpenPane: (pane: string) => void;
}

/**
 * What each step tells the operator to go and do, total over the step list.
 *
 * A `Readonly<Record<WizardStep, …>>` for the same reason `STEP_TITLE` is: a
 * new step is a compile error here rather than a step that renders its
 * heading over an empty panel. It did exactly that when s9 Sc7 added
 * `keep-running`, which is why this record has a sixth entry now, and a
 * SEVENTH step would stop the build the same way.
 *
 * The copy never says a permission was granted, never says this app granted
 * one, and never says a check passed that was not run. Those three sentences
 * are the ones a setup flow reaches for, and all three are refused by the
 * checkpoint's own honesty assertion.
 */
const STEP_BODY: Readonly<Record<WizardStep, readonly string[]>> = {
  welcome: [
    'This app approves replies; the daemon does the reading and the sending. Setup is four questions about what the daemon can see on this Mac, and one message you send to yourself at the end.',
    'Nothing on these screens changes a permission. Every state below is the daemon answering, quoted, and a check nobody has run is shown as such rather than as a pass.',
  ],
  'full-disk': [
    'The daemon reads your message history out of a database macOS protects. Only a person can open that up, in System Settings, and only for the daemon binary itself.',
    'Open the pane from the card below, add wemessaged under Privacy & Security, restart it, then come back here and press RE-CHECK. This screen will keep saying what it last heard until you do.',
  ],
  automation: [
    'Sending goes through Messages, and macOS asks you once, on the first send, whether the daemon may drive it. A refusal is remembered until it is reset.',
    'The card below carries the daemon’s own instructions for resetting that answer, word for word, because it is the same sentence the command line prints in a support thread.',
  ],
  optional: [
    'Notifications and accessibility are worth having and neither is required. This app works with both switched off, and the daemon does not probe either of them.',
    'So there is no card here and no button: a screen that reported on a check nobody ran would be doing the one thing this flow exists not to do. Turn them on in System Settings whenever you like.',
  ],
  'keep-running': [
    'A reply can only be drafted while the daemon is running. Installed as a background service it starts at login and starts again if it stops, so a message that arrives while this app is closed is still waiting in the queue when you open it.',
    'It is a recommendation and not a requirement: running the daemon by hand from a terminal works exactly as well. This screen reports on nothing, because there is nothing here that anybody has checked. When you want the service, the daemon installs it for you with `wemessaged service install`.',
  ],
  'send-test': [
    'One message, to a handle you can read on this Mac, to prove the pipe end to end. It takes the ordinary path: the daemon writes a draft, records an approval against it, logs both, and only then hands it to the sender.',
    'This app does not choose what is said. The four characters below are minted by the part of the app the browser cannot reach, and the daemon is told to refuse anything else.',
  ],
};

/** Whether the step's own checks are good enough to move past. */
function mayContinue(verdict: CardState, probing: boolean): boolean {
  return !probing && VERDICT_RANK[verdict] <= VERDICT_RANK.WARN;
}

function Bar({ children }: { children: ComponentChildren }): VNode {
  return <div class="wiz-bar">{children}</div>;
}

export function WizardScreen(props: WizardScreenProps): VNode {
  const view = exitView(props.exit);
  const ready = readyToFinish(props.exit);
  const index = WIZARD_STEPS.indexOf(props.step);
  const first = index <= 0;
  const last = index === WIZARD_STEPS.length - 1;
  const canContinue = mayContinue(props.verdict, props.probing);
  const canSend =
    props.down === null &&
    props.handle.trim().length > 0 &&
    props.outcome !== 'OK';
  return (
    <section
      id="wizard"
      data-step={props.step}
      data-exit={view.exit}
      data-state={view.state}
      data-ready={ready ? 'yes' : 'no'}
      data-probing={props.probing ? 'yes' : 'no'}
      /* The app's own statement of what it is total over, published so the
         checkpoint can assert set equality against what it observed rather
         than against a list somebody typed into the test. */
      data-exits={WIZARD_EXITS.join(' ')}
    >
      <h1 id="wizard-progress">{progressLine(props.step)}</h1>

      <Bar>
        {first ? null : (
          <button
            id="wizard-back"
            type="button"
            class="wiz-button"
            aria-disabled="false"
            onClick={props.onBack}
          >
            BACK
          </button>
        )}
        <button
          id="wizard-recheck"
          type="button"
          class="wiz-button"
          aria-disabled={
            props.down === null && !props.probing ? 'false' : 'true'
          }
          onClick={() => {
            if (props.down === null && !props.probing) props.onRecheck();
          }}
        >
          RE-CHECK
        </button>
      </Bar>

      {/* The exit, as a first-class answer INCLUDING its absence. Glyph and
          uppercase word and datum, so hue carries nothing that is not
          already written twice. */}
      <div id="wizard-exit" data-exit={view.exit} data-state={view.state}>
        <span class="wiz-exit-glyph">{view.glyph}</span>
        <span class="wiz-exit-word">{view.word}</span>
        <h2 class="wiz-exit-title">{view.title}</h2>
        <p class="wiz-exit-detail">{view.detail}</p>
      </div>

      <p id="wizard-verdict" data-state={props.verdict}>
        <span class="wiz-verdict-glyph">{CARD_GLYPH[props.verdict]}</span>
        <span class="wiz-verdict-word">{props.verdict}</span>
        <span class="wiz-verdict-note">ON THIS STEP</span>
      </p>

      <div class="wiz-cards">
        {props.cards.map((card) => (
          <div
            key={card.check}
            class="wiz-card"
            data-check={card.check}
            data-state={card.state}
          >
            <span class="wiz-card-glyph">{card.glyph}</span>
            <span class="wiz-card-word">{card.word}</span>
            <span class="wiz-card-name">{card.check.toUpperCase()}</span>
            <p class="wiz-card-detail">{card.detail}</p>
            {/* A remedy only where there is something to fix AND a pane to
                fix it in. The button carries the pane's NAME; main holds the
                allowlist, because opening an arbitrary string from the least
                trusted process in the app is a code-execution primitive. */}
            {card.pane === null ? null : (
              <button
                type="button"
                class="wiz-card-pane"
                data-pane={card.pane}
                aria-disabled="false"
                onClick={() => {
                  if (card.pane !== null) props.onOpenPane(card.pane);
                }}
              >
                OPEN SYSTEM SETTINGS
              </button>
            )}
          </div>
        ))}
      </div>

      <div class="wiz-body">
        {STEP_BODY[props.step].map((line) => (
          <p key={line} class="wiz-para">
            {line}
          </p>
        ))}
        {props.down === null ? null : <NotFoundCard stream={props.down} />}
        {!last ? null : (
          <div class="wiz-test">
            <input
              id="wizard-handle"
              class="wiz-input"
              type="text"
              value={props.handle}
              aria-label="THE HANDLE THE TEST IS SENT TO"
              aria-disabled={props.outcome === 'OK' ? 'true' : 'false'}
              onInput={(event) => {
                props.onHandle(event.currentTarget.value);
              }}
            />
            <button
              id="wizard-send"
              type="button"
              class="wiz-button"
              aria-disabled={canSend ? 'false' : 'true'}
              onClick={() => {
                if (canSend) props.onSend();
              }}
            >
              SEND THE TEST
            </button>
            <p id="wizard-send-state" data-state={props.outcome}>
              <span class="wiz-send-glyph">{CARD_GLYPH[props.outcome]}</span>
              <span class="wiz-send-word">{props.outcome}</span>
            </p>
          </div>
        )}
        {/* The receipt, and it OUTLIVES the step that produced it.
            Onboarding's one side effect is a real message to a real handle;
            a screen that erased the four characters it sent the moment the
            operator moved on would be hiding the only thing here that
            cannot be undone. It is a quotation of what main minted, so it
            is rendered wherever the flow is, and it is absent — rather than
            blank — until there is something true to put in it. */}
        {props.code === null ? null : (
          <p class="wiz-receipt">
            <span class="wiz-receipt-label">THE CODE THIS APP SENT</span>
            <span id="wizard-code" class="wiz-code">
              {props.code}
            </span>
          </p>
        )}
        {props.failure === '' ? null : (
          <p id="wizard-failure" class="wiz-failure">
            {props.failure.toUpperCase()}
          </p>
        )}
      </div>

      <Bar>
        {last ? null : (
          <button
            id="wizard-continue"
            type="button"
            class="wiz-button"
            aria-disabled={canContinue ? 'false' : 'true'}
            onClick={() => {
              if (canContinue) props.onContinue();
            }}
          >
            CONTINUE
          </button>
        )}
        {/* Rendered only while there is a link. With no daemon there is no
            queue to leave for, and a control that goes nowhere offered at
            the moment somebody is deciding whether to trust the product is
            the same class of lie as a RECONNECT that cannot reconnect. */}
        {props.down === null ? (
          <button
            id="wizard-finish"
            type="button"
            class="wiz-button"
            aria-disabled="false"
            onClick={props.onFinish}
          >
            {ready ? 'FINISH' : 'LEAVE SETUP'}
          </button>
        ) : null}
      </Bar>
    </section>
  );
}

export default WizardScreen;
