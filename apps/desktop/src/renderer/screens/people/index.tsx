/**
 * Contacts and policies: the screen where the product's default is the
 * strictest thing it can do.
 *
 * A LAYOUT and nothing else, on the same terms as the two editors before
 * it. No state, no bridge member, no derivation and no clock: every string
 * below arrived as a prop, decided in `derive/` where it can be proved
 * without a browser.
 *
 * The one thing this screen may never do is draw an empty policy cell.
 * §2.4.3 step 3 refuses a rule or an agent for any handle with no
 * `ContactPolicy` row, so a blank column would be rendering the strictest
 * configuration this product has as the ABSENCE of a configuration — and
 * the operator staring at it, waiting for a reply the daemon already
 * refused, is exactly who this screen is for. Hence the banner, the empty
 * sentence, the per-row words and the scoped note under them, all of which
 * say what the gate will do rather than leaving it to be inferred.
 *
 * The note is as load-bearing as the sentence. The gate guards its deny
 * with `ctx.rule !== null || agentOrigin`, and `dispatchApproved` re-gates a
 * human-minted draft with a null rule and no agent origin, so a person can
 * still approve a draft for a handle with no row. A screen that said
 * "DENIED" full stop would be over-claiming, and an operator who believed
 * it would stop approving perfectly good drafts.
 */
import type { VNode } from 'preact';
import type { ContactMode } from '@wemessage/client';
import { PeopleGrid, type PeopleGridRow } from './Grid.js';
import { PeopleScope, type PeopleScopeProps } from './Scope.js';

export interface ChipView {
  /** A `ModeFilter`, `none` included: the absence of a policy is a value. */
  readonly mode: string;
  readonly state: 'ON' | 'OFF';
}

export interface PeopleScreenProps {
  /** The binding's own word for where the four catalogue reads got to. */
  readonly status: string;
  /** The rung above every row here, in words, naming the stroke that moves it. */
  readonly banner: string;
  /** `draft-only` or `auto`, read from `send.globalMode`. */
  readonly globalMode: string;
  readonly denyNote: string;
  readonly precedence: string;
  /** What an empty grid MEANS. Rendered only when the book is empty. */
  readonly empty: string;
  readonly search: string;
  readonly chips: readonly ChipView[];
  /** The page that is drawn. */
  readonly rows: readonly PeopleGridRow[];
  /** The size of the book after narrowing. */
  readonly total: number;
  /** What the window is hiding; `''` when it hides nothing. */
  readonly more: string;
  /** How many rows a bulk gesture would write, or `0` for none selected. */
  readonly picked: number;
  readonly scope: PeopleScopeProps | null;
  /** The DAEMON's own words from the last refused write; `''` for none. */
  readonly refusal: string;
  readonly busy: boolean;
  readonly onSearch: (next: string) => void;
  readonly onChip: (mode: string) => void;
  readonly onAdd: () => void;
  readonly onOpen: (key: string) => void;
  readonly onPick: (key: string) => void;
  readonly onMode: (key: string, mode: ContactMode) => void;
  readonly onBulk: (mode: ContactMode) => void;
}

/** The bulk select's options. `''` is the resting position, not a mode. */
const BULK: readonly ContactMode[] = ['deny', 'draft-only', 'auto'];

function isMode(value: string): value is ContactMode {
  return (BULK as readonly string[]).includes(value);
}

export default function PeopleScreen(props: PeopleScreenProps): VNode {
  return (
    <div id="people" class="people" data-people={props.status}>
      <header class="people-head">
        <p
          id="people-default"
          class="people-banner"
          data-global={props.globalMode}
        >
          {props.banner}
        </p>
        {/* Always, not only when the grid is empty: the scope of the deny is
            a fact about every row on this screen, and it is the fact an
            operator is most likely to over-read. */}
        <p id="people-deny-note" class="people-note">
          {props.denyNote}
        </p>
      </header>

      <div class="people-tools">
        <input
          id="people-search"
          class="people-search"
          type="text"
          value={props.search}
          placeholder="HANDLE OR NAME"
          aria-label="NARROW BY HANDLE OR NAME"
          onInput={(event) => {
            props.onSearch(event.currentTarget.value);
          }}
        />
        {/* Local, both of them. Every row is already in hand, so narrowing
            is a filter rather than a request; an e2e row asserts the
            request log is untouched while an operator types. */}
        <span class="people-chips">
          {props.chips.map((chip) => (
            <button
              key={chip.mode}
              type="button"
              class="people-chip"
              data-mode={chip.mode}
              data-state={chip.state}
              aria-pressed={chip.state === 'ON'}
              onClick={() => {
                props.onChip(chip.mode);
              }}
            >
              {chip.mode.toUpperCase()}
            </button>
          ))}
        </span>
        {/* A handle nobody has messaged and nobody has decided about has no
            row in either catalogue. This puts one on screen so a policy can
            be set BEFORE the first message rather than after the gate has
            already refused it. It writes nothing by itself. */}
        <button
          type="button"
          id="people-add"
          class="people-add"
          disabled={props.busy || props.search.trim() === ''}
          onClick={props.onAdd}
        >
          ADD THIS HANDLE
        </button>
      </div>

      {props.picked === 0 ? null : (
        <div
          id="people-bulk"
          class="people-bulk"
          data-count={String(props.picked)}
        >
          <span class="people-bulk-count">
            {props.picked} SELECTED · ONE REQUEST EACH
          </span>
          <select
            id="people-bulk-mode"
            class="people-bulk-mode"
            aria-label="SET EVERY SELECTED CONTACT TO"
            value=""
            disabled={props.busy}
            onChange={(event) => {
              const next = event.currentTarget.value;
              if (isMode(next)) props.onBulk(next);
            }}
          >
            <option value="">SET SELECTED TO…</option>
            {BULK.map((mode) => (
              <option key={mode} value={mode}>
                {mode.toUpperCase()}
              </option>
            ))}
          </select>
        </div>
      )}

      <PeopleGrid
        rows={props.rows}
        total={props.total}
        busy={props.busy}
        onOpen={props.onOpen}
        onPick={props.onPick}
        onMode={props.onMode}
      />

      {props.empty === '' ? null : (
        <p id="people-empty" class="people-empty">
          {props.empty}
        </p>
      )}
      {props.more === '' ? null : (
        <p id="people-more" class="people-more">
          {props.more}
        </p>
      )}
      {props.refusal === '' ? null : (
        <p id="people-refusal" class="people-refusal">
          {props.refusal}
        </p>
      )}

      {props.scope === null ? null : <PeopleScope {...props.scope} />}

      {/* The gate's order, both halves, and who each half binds. The plan's
          footer had the mode ladder AFTER the clamps and two clamps rather
          than five; an arch row ties the clamp half to the `clampedBy`
          assignments in `evaluateGate` so it cannot drift again. */}
      <footer id="people-precedence" class="people-precedence">
        {props.precedence}
      </footer>
    </div>
  );
}
