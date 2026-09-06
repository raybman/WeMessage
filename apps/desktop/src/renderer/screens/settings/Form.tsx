/**
 * The settings form: the daemon's own closed key list, rendered whole.
 *
 * This is the first surface in the GUI that has to be TOTAL over a list
 * somebody else owns. Every other screen draws the rows the daemon happens
 * to have; this one draws a fixed form, and a key missing from it is a knob
 * the operator cannot reach while the daemon goes on enforcing it. The list
 * lives in `derive/settingsFields.ts` as a compile-time-total record, and an
 * arch row ties it back to `packages/daemon/src/settings/schema.ts` so the
 * two cannot drift.
 *
 * Three shapes, and the difference between them is a fact about the wire:
 *
 *  - **Writable keys get a control.** Eleven of them, grouped by what the
 *    number protects rather than by key prefix.
 *  - **Read-only keys get a POINTER and no control at all.** Four of them.
 *    Each already has a route that does MORE than move a value, so a box
 *    here would be offering the half of the operation that is not the
 *    dangerous part. The pointer prints the daemon's OWN `use` string, so
 *    the route named beside the value is the one the daemon nominated and
 *    not one this screen remembered.
 *  - **The LLM endpoint gets a sentence.** F-112: it is not configurable in
 *    v1, and a disabled box would imply it will be, from a screen with no
 *    Keychain anywhere near it.
 *
 * SAVE issues exactly one `PATCH` carrying only what moved, and a clean SAVE
 * issues nothing at all — not a quiet request, no request. The refusal is
 * rendered in the DAEMON's words: `planPatch` answers a structure (an error
 * name and a bound), C-3 says that is deliberate, and inventing a friendlier
 * sentence here would put a second validation vocabulary in front of an
 * operator who will read the daemon's in a support thread.
 */
import type { VNode } from 'preact';

/** One writable key, projected. `kind` decides the control, not the value. */
export interface SettingFieldView {
  readonly key: string;
  readonly group: string;
  readonly label: string;
  readonly note: string;
  /** `int`, `bool`, or `absent` when the daemon answered no such key. */
  readonly kind: string;
  /** What the box shows: the draft, as text. */
  readonly value: string;
  readonly checked: boolean;
  /** Whether the daemon could honour a change to this right now. */
  readonly dimmed: boolean;
  /** The daemon's own complaint about THIS key, or `''`. */
  readonly issue: string;
}

/** One read-only key: a value, and the route that owns it. */
export interface SettingPointerView {
  readonly key: string;
  readonly label: string;
  readonly note: string;
  readonly use: string;
  readonly value: string;
}

export interface FormPaneProps {
  /** `auto`, `draft-only`, or `unknown`. */
  readonly mode: string;
  /** What AUTO would mean, said before it is chosen. */
  readonly modeNote: string;
  /** When this screen read the daemon, as the instant main handed down. */
  readonly loaded: string;
  readonly dirty: boolean;
  readonly saveDisabled: boolean;
  readonly groups: readonly string[];
  readonly fields: readonly SettingFieldView[];
  readonly pointers: readonly SettingPointerView[];
  /** A refusal the daemon attached to no key, or `''`. */
  readonly failure: string;
  readonly onMode: (next: string) => void;
  readonly onEdit: (key: string, text: string) => void;
  readonly onToggle: (key: string, on: boolean) => void;
  readonly onSave: () => void;
  readonly onRevert: () => void;
}

function Control(props: {
  readonly field: SettingFieldView;
  readonly onEdit: (key: string, text: string) => void;
  readonly onToggle: (key: string, on: boolean) => void;
}): VNode {
  const { field } = props;
  if (field.kind === 'bool')
    return (
      <input
        class="set-input"
        data-key={field.key}
        type="checkbox"
        checked={field.checked}
        aria-label={field.label}
        onChange={(event) => {
          props.onToggle(field.key, event.currentTarget.checked);
        }}
      />
    );
  if (field.kind === 'absent')
    return (
      <input
        class="set-input"
        data-key={field.key}
        type="text"
        value=""
        readOnly
        aria-label={field.label}
        placeholder="NOT ANSWERED"
      />
    );
  return (
    <input
      class="set-input"
      data-key={field.key}
      type="number"
      value={field.value}
      aria-label={field.label}
      onInput={(event) => {
        props.onEdit(field.key, event.currentTarget.value);
      }}
    />
  );
}

export function FormPane(props: FormPaneProps): VNode {
  return (
    <section id="set-form" class="set-pane">
      <h2 class="set-pane-title">HOW REPLIES ARE DECIDED</h2>

      <div id="mode" class="set-mode" data-mode={props.mode}>
        <button
          id="mode-draft-only"
          type="button"
          class="set-mode-choice"
          aria-pressed={props.mode === 'draft-only'}
          onClick={() => {
            props.onMode('draft-only');
          }}
        >
          DRAFT ONLY
        </button>
        <button
          id="mode-auto"
          type="button"
          class="set-mode-choice"
          aria-pressed={props.mode === 'auto'}
          onClick={() => {
            props.onMode('auto');
          }}
        >
          AUTO
        </button>
        <p class="set-note">{props.modeNote}</p>
      </div>

      <div class="set-form-bar">
        <p id="set-loaded" class="set-loaded">
          {props.loaded}
        </p>
        <p id="set-dirty" class="set-dirty" data-dirty={String(props.dirty)}>
          {props.dirty ? 'UNSAVED CHANGES' : 'NOTHING TO SAVE'}
        </p>
        {/* `aria-disabled` and never `disabled`. A disabled SAVE is a button
            an operator cannot reach to find out why it is disabled; this one
            is reachable, says so to assistive technology, and does nothing
            when there is nothing to do — including issuing no request. */}
        <button
          id="set-save"
          type="button"
          class="set-button"
          aria-disabled={props.saveDisabled ? 'true' : 'false'}
          onClick={props.onSave}
        >
          SAVE
        </button>
        <button
          id="set-revert"
          type="button"
          class="set-button"
          aria-disabled={props.saveDisabled ? 'true' : 'false'}
          onClick={props.onRevert}
        >
          REVERT
        </button>
      </div>

      {props.failure === '' ? null : (
        <p id="set-failure" class="set-failure">
          {props.failure}
        </p>
      )}

      {props.groups.map((group) => (
        <div key={group} class="set-group" data-group={group}>
          <h3 class="set-group-title">{group}</h3>
          {props.fields
            .filter((field) => field.group === group)
            .map((field) => (
              <div
                key={field.key}
                class="set-field"
                data-key={field.key}
                data-group={field.group}
                aria-disabled={field.dimmed ? 'true' : 'false'}
              >
                <span class="set-label">{field.label}</span>
                <Control
                  field={field}
                  onEdit={props.onEdit}
                  onToggle={props.onToggle}
                />
                <p class="set-note">{field.note}</p>
                {field.issue === '' ? null : (
                  <p class="set-issue" data-key={field.key}>
                    {field.issue}
                  </p>
                )}
              </div>
            ))}
        </div>
      ))}

      <div class="set-group" data-group="OWNED ELSEWHERE">
        <h3 class="set-group-title">OWNED ELSEWHERE</h3>
        {props.pointers.map((pointer) => (
          <div
            key={pointer.key}
            class="set-pointer"
            data-key={pointer.key}
            aria-disabled="true"
          >
            <span class="set-label">{pointer.label}</span>
            <span class="set-value">{pointer.value}</span>
            {/* The daemon's own nomination, verbatim and not uppercased: it
                is a route, and a route is case-sensitive. */}
            <span class="set-use">{pointer.use}</span>
            <p class="set-note">{pointer.note}</p>
          </div>
        ))}
      </div>

      {/* F-112. No control of any kind, which is the whole claim. */}
      <div id="set-endpoint" class="set-endpoint">
        <h3 class="set-group-title">MODEL ENDPOINT</h3>
        <p class="set-note">
          NOT IN V1. THE DAEMON NEVER CALLS A MODEL: AN ADAPTER DOES, IN ITS OWN
          PROCESS, WITH ITS OWN CREDENTIAL. THERE IS NOTHING TO CONFIGURE HERE
          AND NO SECRET OF YOURS IS STORED BY THIS APP.
        </p>
      </div>
    </section>
  );
}
