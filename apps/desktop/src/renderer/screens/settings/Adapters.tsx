/**
 * The adapters table, and the one place in this GUI where a credential is
 * created.
 *
 * What is NOT here is the design. There is no reveal, because there is
 * nothing to reveal: the daemon mints a token once, stores a scrypt hash of
 * it and exposes no route that reads one back, so `hasToken` is a boolean
 * and the column is SET or NONE. And there is no COPY CONNECT COMMAND,
 * because the daemon builds that command as `--token <plaintext>`, argv is
 * world-readable through `ps`, and a button that copied it would be teaching
 * the unsafe carriage of the very secret this pane exists to protect. The
 * adapter test kit documents the opposite convention for the same
 * credential: the token travels by environment, never by argv.
 *
 * So a rotation ends in a RECEIPT rather than in a secret. Main mints,
 * writes the plaintext to the OS clipboard, and answers with the adapter it
 * was for, where the value went, the environment variable that carries it,
 * and a run line with the credential elided out of it. The plaintext never
 * crosses the bridge, so there is nothing in this process for the runtime
 * sweep to find — in the DOM, in either web storage, in a performance entry
 * or on `window` — before dismissal or after it.
 *
 * The disclosure is two steps and is NOT a modal. `role="dialog"` has one
 * owner in this renderer and a second focus trap on a screen that already
 * has a typed confirm would be a second Escape handler racing the first.
 * ARM is the step that says what rotation costs: the old credential stops
 * working after a short carry-over, and every process still using it will
 * start failing.
 */
import type { VNode } from 'preact';

export interface AdapterRowView {
  readonly id: string;
  readonly name: string;
  readonly health: string;
  readonly glyph: string;
  readonly word: string;
  /** `SET` or `NONE`. A boolean is the whole read surface there is. */
  readonly token: string;
  readonly dev: boolean;
  readonly note: string;
}

/** What main answers a rotation with. There is no field for a secret. */
export interface MintReceiptView {
  readonly adapter: string;
  readonly delivered: string;
  readonly variable: string;
  readonly run: string;
  /** Where the value went and that it is gone from here. */
  readonly note: string;
}

export interface AdaptersPaneProps {
  readonly rows: readonly AdapterRowView[];
  /** The adapter whose ARM step is open, or `null`. */
  readonly arming: string | null;
  /** What ARM warns about, before anything is minted. */
  readonly armNote: string;
  readonly receipt: MintReceiptView | null;
  readonly onArm: (id: string) => void;
  readonly onCancelArm: () => void;
  readonly onMint: (id: string) => void;
  readonly onDismiss: () => void;
}

export function AdaptersPane(props: AdaptersPaneProps): VNode {
  return (
    <section id="set-adapters" class="set-pane">
      <h2 class="set-pane-title">AGENTS</h2>
      {props.rows.map((row) => (
        <div
          key={row.id}
          class="adp-row"
          data-adapter={row.id}
          data-health={row.health}
          data-dev={String(row.dev)}
        >
          <span class="adp-glyph">{row.glyph}</span>
          <span class="adp-word">{row.word}</span>
          <span class="adp-name">{row.name}</span>
          <span class="adp-token">{row.token}</span>
          <button
            type="button"
            class="adp-rotate"
            data-adapter={row.id}
            onClick={() => {
              props.onArm(row.id);
            }}
          >
            ROTATE CREDENTIAL
          </button>
          <p class="adp-note">{row.note}</p>
        </div>
      ))}

      {props.arming === null ? null : (
        <div id="adp-arm" class="adp-arm" data-adapter={props.arming}>
          <p class="set-note">{props.armNote}</p>
          <button
            id="adp-arm-go"
            type="button"
            class="set-button"
            onClick={() => {
              if (props.arming !== null) props.onMint(props.arming);
            }}
          >
            MINT A NEW CREDENTIAL
          </button>
          <button
            id="adp-arm-cancel"
            type="button"
            class="set-button"
            onClick={props.onCancelArm}
          >
            CANCEL
          </button>
        </div>
      )}

      {props.receipt === null ? null : (
        <div
          id="adp-receipt"
          class="adp-receipt"
          data-adapter={props.receipt.adapter}
          data-delivered={props.receipt.delivered}
        >
          <p class="adp-receipt-line">
            <span class="adp-receipt-label">READ IT FROM</span>
            <span id="adp-receipt-var" class="adp-receipt-var">
              {props.receipt.variable}
            </span>
          </p>
          <p id="adp-receipt-run" class="adp-receipt-run">
            {props.receipt.run}
          </p>
          <p id="adp-receipt-note" class="set-note">
            {props.receipt.note}
          </p>
          <button
            id="adp-dismiss"
            type="button"
            class="set-button"
            onClick={props.onDismiss}
          >
            DISMISS
          </button>
        </div>
      )}
    </section>
  );
}
