/**
 * The typed confirmation — §1.7's "type the exact phrase" gate.
 *
 * One component, one `role="dialog"` in the whole renderer, for the same
 * reason `Listbox.tsx` owns `role="listbox"`: a modal has an ARIA contract
 * that only holds while ONE thing owns it, and the way it breaks is a second
 * dialog appearing behind the first with focus split between them. An arch
 * row pins the role to this file; `alert` and `alertdialog` stay banned
 * renderer-wide (Sc7), because a refusal that shouts is a refusal an
 * operator learns to dismiss.
 *
 * Three properties are the point, and each one is a defence against a
 * different way an irreversible switch gets flipped by accident:
 *
 *  - **The phrase is EXACT.** Case, spacing and all. A near-miss leaves the
 *    button disabled, so the gesture cannot be completed by muscle memory or
 *    by an autocomplete that helpfully lowercased it.
 *  - **Return does not mean yes.** Everywhere else in this app ↩ is
 *    confirmation; here it CANCELS, and so does Escape. That asymmetry is
 *    deliberate: the operator has just typed a sentence into a text field,
 *    and ↩ at the end of typing is a reflex. A dialog that armed on that
 *    reflex would be a dialog that asked nothing.
 *  - **Nothing has happened yet.** The dialog is rendered BEFORE any
 *    request. Cancelling leaves the form dirty and the daemon untouched,
 *    which the e2e checks by reading the request log rather than the screen.
 *
 * The two strokes are claimed at the composition root, where the app's one
 * `addEventListener` lives, rather than on the input here: Escape must work
 * while focus is on the button that opened this, and a handler bound to the
 * text field would only see it while the caret was inside.
 */
import type { VNode } from 'preact';

export interface TypedConfirmProps {
  /** The sentence that has to be typed, verbatim. Also the button's label. */
  readonly phrase: string;
  readonly title: string;
  /** What is about to become true, in one sentence, in the operator's terms. */
  readonly body: string;
  readonly typed: string;
  readonly onType: (next: string) => void;
  readonly onGo: () => void;
}

export function TypedConfirm(props: TypedConfirmProps): VNode {
  const armed = props.typed === props.phrase;
  return (
    <div id="typed-confirm-scrim" class="confirm-scrim">
      <div
        id="typed-confirm"
        class="confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="typed-confirm-title"
        aria-describedby="typed-confirm-body"
        // The phrase as DATA as well as as text: a test that read it out of
        // the paragraph would pass against a dialog whose button compared
        // against something else.
        data-phrase={props.phrase}
        data-armed={armed ? 'yes' : 'no'}
      >
        <h2 id="typed-confirm-title" class="confirm-title">
          {props.title}
        </h2>
        <p id="typed-confirm-body" class="confirm-body">
          {props.body}
        </p>
        <p class="confirm-legend">
          TYPE <b>{props.phrase}</b> TO CONFIRM · ESC OR RETURN CANCELS
        </p>
        <input
          id="typed-confirm-input"
          class="confirm-input"
          type="text"
          // No autocomplete, no spellcheck, no autocapitalise. The whole
          // mechanism is that the operator typed these characters; a browser
          // that offered to finish the sentence would be defeating it.
          autocomplete="off"
          autocorrect="off"
          spellcheck={false}
          aria-label={`TYPE ${props.phrase} TO CONFIRM`}
          value={props.typed}
          onInput={(event) => {
            props.onType(event.currentTarget.value);
          }}
        />
        <button
          id="typed-confirm-go"
          class="confirm-go"
          type="button"
          disabled={!armed}
          onClick={props.onGo}
        >
          {props.phrase}
        </button>
      </div>
    </div>
  );
}
