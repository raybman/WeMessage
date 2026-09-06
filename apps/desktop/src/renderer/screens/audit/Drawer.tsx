/**
 * One audit row, raw.
 *
 * The title is the contract: WHAT YOU SEE IS WHAT WAS HASHED. The two panes
 * below render `eventJson` and `actorJson` as the STORED strings, never as a
 * re-serialisation of a parsed value — key order, spacing and unicode
 * escapes all move under `JSON.parse` + `JSON.stringify`, and a pane that
 * showed a normalised copy would be showing bytes whose hash nobody can
 * check against the chain. The projection carries the strings through
 * untouched and this component puts them on screen untouched.
 *
 * An `<aside>`, not a dialog. `role="dialog"` has exactly one home in this
 * renderer and a pane over an append-only log has no business being modal:
 * the table behind it stays readable, the keymap stays live, and there is
 * nothing here to confirm. The two panes are clamped to 40vh in the sheet,
 * so a `draft.created` row carrying a whole message cannot push the row it
 * belongs to off the screen.
 *
 * COPY FULL JSON hands over the WHOLE row — the two verbatim strings, the
 * seq and both hashes — because a fragment of a hash chain is not evidence
 * of anything. What was copied is published on the button so a test, and an
 * operator who does not trust their clipboard, can both see it.
 */
import type { VNode } from 'preact';

export interface AuditDrawerProps {
  readonly seq: number;
  readonly at: string;
  readonly prevHash: string;
  readonly hash: string;
  /** Byte for byte as stored. Never re-serialised. */
  readonly eventJson: string;
  readonly actorJson: string;
  /** What the last copy handed over, or `''` before anybody asked. */
  readonly copied: string;
  readonly onCopy: () => void;
  readonly onClose: () => void;
}

export function AuditDrawer(props: AuditDrawerProps): VNode {
  return (
    <aside
      id="audit-drawer"
      class="audit-drawer"
      data-seq={String(props.seq)}
      aria-label="THE STORED ROW"
    >
      <h2 id="audit-drawer-title" class="audit-drawer-title">
        WHAT YOU SEE IS WHAT WAS HASHED
      </h2>
      <dl class="audit-chain">
        <dt>SEQ</dt>
        <dd id="audit-drawer-seq">{String(props.seq)}</dd>
        <dt>AT</dt>
        <dd id="audit-drawer-at">{props.at}</dd>
        <dt>PREV HASH</dt>
        <dd id="audit-drawer-prev">{props.prevHash}</dd>
        <dt>HASH</dt>
        <dd id="audit-drawer-hash">{props.hash}</dd>
      </dl>
      <p class="audit-drawer-note">EVENT, AS STORED</p>
      <pre id="audit-drawer-event" class="audit-json">
        {props.eventJson}
      </pre>
      <p class="audit-drawer-note">ACTOR, AS STORED</p>
      <pre id="audit-drawer-actor" class="audit-json">
        {props.actorJson}
      </pre>
      <div class="audit-drawer-acts">
        <button
          id="audit-copy"
          type="button"
          class="audit-button"
          data-copied={props.copied}
          onClick={props.onCopy}
        >
          COPY FULL JSON
        </button>
        <button
          id="audit-drawer-close"
          type="button"
          class="audit-button"
          onClick={props.onClose}
        >
          CLOSE
        </button>
      </div>
    </aside>
  );
}
