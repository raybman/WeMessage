/**
 * The Permissions pane: four things it can REPORT, and nothing it can grant.
 *
 * macOS TCC is not programmatically grantable. There is no API, and that is
 * the OS's design rather than an omission — so the honest maximum a pane
 * like this can offer is to say what the daemon found and put the operator
 * in front of the System Settings pane they have to act in. Every button
 * here opens a window; not one of them changes a permission.
 *
 * Three distinguishable states, and the distinction is the point:
 *
 *  - **Granted.** The daemon probed it and it answered.
 *  - **Not granted.** The daemon probed it and it refused, and the detail is
 *    the daemon's OWN remediation string, verbatim, because the operator
 *    will read the same sentence from the CLI in a support thread.
 *  - **Not yet checked.** `evaluateDoctor` SHORT-CIRCUITS: an fda failure
 *    returns two checks and never probes automation or messages at all. So
 *    "absent from `checks`" is a state the daemon really produces, and a
 *    card that painted it as fine would be claiming a result for a probe
 *    that never ran. The same word covers the case where the probe itself
 *    threw and the whole report is missing — a check that exploded is not a
 *    check that passed.
 *
 * There is no fourth state for "granted but the file moved": the daemon
 * already answers that one as `warn` with its own sentence (no Messages
 * history at the chat.db path, which is not a permission failure), and a
 * vocabulary this screen invented for it would be a vocabulary the daemon
 * cannot produce.
 *
 * §1.7 throughout: a glyph AND an uppercase word AND `data-state`, so
 * colour carries nothing that is not already said twice.
 */
import type { VNode } from 'preact';

export interface PermCardView {
  readonly check: string;
  readonly state: string;
  readonly glyph: string;
  readonly word: string;
  readonly detail: string;
  /** A pane NAME off main's closed allowlist, or `null` for no remedy. */
  readonly pane: string | null;
}

export interface PermsPaneProps {
  /** When the daemon last looked, in the daemon's own instant. */
  readonly probed: string;
  readonly cards: readonly PermCardView[];
  /** What a reconnect would do, said before it is asked for. */
  readonly relinkNote: string;
  readonly onRerun: () => void;
  readonly onRelink: () => void;
  /**
   * Enter the setup flow.
   *
   * The flow is a MODE, not a screen: it is absent from `SCREENS` and from
   * the ⌘-digit table, so it has no stroke of its own and adds no tab stop
   * to any surface that counts them. It arrives by itself when there is no
   * daemon, and this is the one place it can be asked for when there is.
   */
  readonly onWizard: () => void;
  readonly onOpenPane: (pane: string) => void;
}

export function PermsPane(props: PermsPaneProps): VNode {
  return (
    <section id="set-perms" class="set-pane">
      <h2 class="set-pane-title">PERMISSIONS</h2>
      <div class="set-form-bar">
        <p id="perms-probed" class="set-loaded">
          {props.probed}
        </p>
        <button
          id="perms-rerun"
          type="button"
          class="set-button"
          onClick={props.onRerun}
        >
          RE-RUN CHECKS
        </button>
        <button
          id="perms-relink"
          type="button"
          class="set-button"
          onClick={props.onRelink}
        >
          RECONNECT
        </button>
        <button
          id="set-perms-wizard"
          type="button"
          class="set-button"
          onClick={props.onWizard}
        >
          RUN SETUP AGAIN
        </button>
      </div>
      <p class="set-note">{props.relinkNote}</p>
      {props.cards.map((card) => (
        <div
          key={card.check}
          class="perm-card"
          data-check={card.check}
          data-state={card.state}
        >
          <span class="perm-glyph">{card.glyph}</span>
          <span class="perm-word">{card.word}</span>
          <span class="perm-name">{card.check.toUpperCase()}</span>
          <p class="perm-detail">{card.detail}</p>
          {/* A remedy only where there is something to fix AND a pane to fix
              it in. The button carries the pane's NAME; main holds the URL
              allowlist, because `shell.openExternal` on a string this
              process chose would be a code-execution primitive in the least
              trusted process in the app. */}
          {card.pane === null ? null : (
            <button
              type="button"
              class="perm-grant"
              data-pane={card.pane}
              onClick={() => {
                if (card.pane !== null) props.onOpenPane(card.pane);
              }}
            >
              OPEN SYSTEM SETTINGS
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
