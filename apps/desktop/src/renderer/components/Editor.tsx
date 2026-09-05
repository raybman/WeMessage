/**
 * The one editable control in the application.
 *
 * It exists as its own component, under `components/` beside `Listbox.tsx`,
 * for the reason `Listbox.tsx` does: an arch row pins the element to exactly
 * this file. A textarea is a TAB STOP, and Sc7 established that this window
 * has exactly one of those — on the listbox, so that a virtualized option
 * scrolling out from under a roving `tabIndex` can never drop focus to
 * `<body>` and swallow the next keystroke. A second one is a second place
 * the operator's focus can be, so there is exactly one place that can mint
 * it and exactly one moment it is mounted.
 *
 * MOUNTED, never hidden. A hidden textarea is still focusable, still in the
 * tab order and still a place focus can be left behind — which is precisely
 * the teeth mutation this scenario is measured against. Not being in the
 * document is the only version of "not focusable" that cannot be got wrong.
 *
 * It is also OUTSIDE the listbox, which is why it is not literally inside
 * the card it edits. An `<option>` containing a focusable child is an ARIA
 * violation and gives the listbox a second focus owner, so the editor is a
 * sibling panel that names the card it is editing. That is the strongest
 * form of "edit in place" the accessibility contract allows.
 *
 * Focus is taken on mount by the ref callback below and handed back by the
 * composition root after the editor unmounts. No timer, either side: the
 * mount IS the moment, and a deferred focus is a race with the next
 * keystroke.
 */
import type { VNode } from 'preact';

export interface EditorProps {
  /** The body as it stands, which is the draft's until somebody types. */
  readonly value: string;
  /** What a screen reader is told this box is for. */
  readonly label: string;
  readonly onInput: (next: string) => void;
  readonly onKeyDown: (event: KeyboardEvent) => void;
}

export function Editor(props: EditorProps): VNode {
  return (
    <div id="queue-editor" class="editor">
      <p class="editor-legend">⌘↩ SEND EDITED · ESC CANCEL</p>
      <textarea
        id="queue-editor-text"
        class="editor-text"
        aria-label={props.label}
        value={props.value}
        onInput={(event) => {
          props.onInput(event.currentTarget.value);
        }}
        onKeyDown={props.onKeyDown}
        ref={(el) => {
          if (el === null) return;
          el.focus();
          // The caret at the END, not over a selection. An operator who
          // pressed E to add three words to a draft they have just read
          // would otherwise replace the whole body with the first character
          // they typed, which is a destructive default for a key whose
          // entire purpose is a small correction.
          el.setSelectionRange(el.value.length, el.value.length);
        }}
      />
    </div>
  );
}
