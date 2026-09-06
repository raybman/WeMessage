/**
 * The audit log: the one screen in this product whose whole job is to be
 * BELIEVED, and the only one that is a reader and nothing else.
 *
 * A LAYOUT and nothing else, on the same terms as the four screens before
 * it. No state, no bridge member, no derivation and no clock: every string
 * below arrived as a prop, decided in `derive/auditRows.ts` where it can be
 * proved without a browser, and an arch row asserts that nothing under this
 * directory names a bridge member at all.
 *
 * Three decisions are visible in the markup and each of them is the answer
 * to a way this screen could quietly lie:
 *
 *  - **There is no destructive verb anywhere on it.** The log is append-only
 *    as an API property: the Store exposes no update or delete path for
 *    `audit_log`, and the daemon registers nothing on the audit path but
 *    GETs. A greyed bin glyph would still teach an operator that the record
 *    is editable, and a record an operator believes is editable is not
 *    evidence to them or to anybody they show it to. An arch row bans the
 *    vocabulary under this directory outright.
 *
 *  - **The window says what it is, and the ceiling says what it cannot
 *    reach.** `GET /v1/audit` has no upper bound — `since` is an inclusive
 *    LOWER bound under `ORDER BY seq DESC` — so there is no backward pager
 *    to write and LOAD MORE raises the LIMIT to the route's cap and then
 *    disappears. Older rows are reached by NARROWING, which is what the
 *    ceiling sentence says in words. A LOAD MORE that stayed on screen
 *    doing nothing would be telling an auditor they had seen everything.
 *
 *  - **The filter bar says which side of the wire each control is on.** The
 *    event type and the date are route parameters and cost a request; the
 *    actor chips and the free-text box are local and cost nothing, and the
 *    scope line says so rather than leaving an operator to wonder whether a
 *    search they typed reached the whole log or only the page in front of
 *    them.
 */
import type { VNode } from 'preact';
import type { AuditRowView } from '../../derive/auditRows.js';
import { AuditDrawer, type AuditDrawerProps } from './Drawer.js';

/** One actor filter, where state is carried by a word and not by a hue. */
export interface AuditChipView {
  /** `HUMAN`, `AGENT` or `SYSTEM`, as the projection spells them. */
  readonly actor: string;
  readonly state: 'ON' | 'OFF';
}

/** The chain walk's answer, or the absence of one. Never a default. */
export interface AuditVerdictView {
  readonly state: 'unknown' | 'ok' | 'broken';
  /** Glyph, uppercase words, and the numbers. Colour carries nothing. */
  readonly text: string;
}

export interface AuditExportView {
  /** `''` before anybody asked; otherwise `written`, `canceled` or `failed`. */
  readonly state: string;
  readonly text: string;
}

export interface AuditScreenProps {
  /** The binding's own word for where the one read got to. */
  readonly status: string;
  /** The instant every age on this screen was computed from. */
  readonly nowIso: string;
  /** How many rows the DAEMON answered with. */
  readonly loaded: number;
  /** The limit those rows were fetched under. */
  readonly limit: number;
  /** The `since` the loaded rows were fetched under, `''` for none. */
  readonly since: string;
  /** What is in the box, which may not have been asked for yet. */
  readonly sinceTyped: string;
  /** The `event` the loaded rows were fetched under, `''` for every type. */
  readonly event: string;
  readonly eventChosen: string;
  readonly search: string;
  /** The DRAWN window: the newest slice of what the filters match. */
  readonly rows: readonly AuditRowView[];
  /** The types the loaded rows actually contain, so every option selects. */
  readonly types: readonly string[];
  readonly chips: readonly AuditChipView[];
  /** That the chips and the box are local, and over how many rows. */
  readonly scope: string;
  /** What the drawn window is hiding; `''` when it hides nothing. */
  readonly window: string;
  /** The route's ceiling, in words; `''` until the load is at the cap. */
  readonly ceiling: string;
  /** The LOAD MORE label; `''` removes the control entirely. */
  readonly more: string;
  /** What an empty LOG means. A statement about the daemon. */
  readonly empty: string;
  /** What an empty FILTER means. A statement about the filter. */
  readonly none: string;
  readonly verify: AuditVerdictView;
  /** EXPORT REPORT exists once there is a verdict to export. */
  readonly exportable: boolean;
  readonly exported: AuditExportView;
  readonly drawer: AuditDrawerProps | null;
  readonly onEvent: (next: string) => void;
  readonly onSince: (next: string) => void;
  readonly onSearch: (next: string) => void;
  readonly onChip: (actor: string) => void;
  readonly onMore: () => void;
  readonly onVerify: () => void;
  readonly onExport: () => void;
  readonly onOpen: (seq: number) => void;
}

export default function AuditScreen(props: AuditScreenProps): VNode {
  return (
    <div
      id="audit"
      class="audit"
      data-audit={props.status}
      data-now-iso={props.nowIso}
      data-loaded={String(props.loaded)}
      data-drawn={String(props.rows.length)}
      data-limit={String(props.limit)}
      data-since={props.since}
      data-event={props.event}
      data-search={props.search}
    >
      <div class="audit-tools">
        {/* The DAEMON's two filters, first, because they cost a request. */}
        <select
          id="audit-event"
          class="audit-select"
          aria-label="EVENT TYPE, FILTERED BY THE DAEMON"
          value={props.eventChosen}
          onChange={(event) => {
            props.onEvent(event.currentTarget.value);
          }}
        >
          <option value="">EVERY EVENT TYPE</option>
          {props.types.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
        <input
          id="audit-since"
          class="audit-input"
          type="text"
          value={props.sinceTyped}
          placeholder="YYYY-MM-DD"
          aria-label="ON OR AFTER THIS DAY, FILTERED BY THE DAEMON"
          onInput={(event) => {
            props.onSince(event.currentTarget.value);
          }}
        />
        {/* …then ours, which cost nothing and say so. */}
        <input
          id="audit-search"
          class="audit-input"
          type="text"
          value={props.search}
          placeholder="ANY WORD ON A ROW"
          aria-label="NARROW THE LOADED ROWS, HERE"
          onInput={(event) => {
            props.onSearch(event.currentTarget.value);
          }}
        />
        <span class="audit-chips">
          {props.chips.map((chip) => (
            <button
              key={chip.actor}
              type="button"
              class="audit-chip"
              data-actor={chip.actor}
              data-state={chip.state}
              aria-pressed={chip.state === 'ON'}
              onClick={() => {
                props.onChip(chip.actor);
              }}
            >
              {`${chip.actor} ${chip.state}`}
            </button>
          ))}
        </span>
        <p id="audit-scope" class="audit-scope">
          {props.scope}
        </p>
      </div>

      <div class="audit-chain-bar">
        <button
          id="audit-verify"
          type="button"
          class="audit-button"
          onClick={props.onVerify}
        >
          VERIFY CHAIN
        </button>
        {/* A verdict, never a default. Landing on this screen verifies
            nothing, and the resting text says exactly that. */}
        <p
          id="audit-verdict"
          class="audit-verdict"
          data-verify={props.verify.state}
        >
          {props.verify.text}
        </p>
        {props.exportable ? (
          <button
            id="audit-export"
            type="button"
            class="audit-button"
            onClick={props.onExport}
          >
            EXPORT REPORT
          </button>
        ) : null}
        <p
          id="audit-export-note"
          class="audit-export-note"
          data-export={props.exported.state}
        >
          {props.exported.text}
        </p>
      </div>

      <div id="audit-table" class="audit-table">
        <table>
          <thead>
            <tr>
              <th>SEQ</th>
              <th>AGE</th>
              <th>EVENT</th>
              <th>WHAT</th>
              <th>WHO</th>
              <th>DENY</th>
              <th>ROW</th>
            </tr>
          </thead>
          <tbody>
            {props.rows.map((view) => (
              <tr
                key={view.seq}
                data-seq={String(view.seq)}
                data-kind={view.kind}
                data-actor={view.actor}
                data-deny={view.deny?.reason ?? ''}
              >
                <td class="audit-seq">{String(view.seq)}</td>
                <td class="audit-age" title={view.at}>
                  {view.age}
                </td>
                <td class="audit-kind">{view.kind}</td>
                <td class="audit-summary">{view.summary}</td>
                <td class="audit-actor">{view.actorLabel}</td>
                <td>
                  {view.deny === null ? null : (
                    <span
                      class="audit-deny"
                      data-reason={view.deny.reason}
                      data-state={view.deny.state}
                    >
                      {`${view.deny.glyph} ${view.deny.word}`}
                    </span>
                  )}
                </td>
                <td>
                  <button
                    type="button"
                    class="audit-open"
                    data-seq={String(view.seq)}
                    onClick={() => {
                      props.onOpen(view.seq);
                    }}
                  >
                    OPEN
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p id="audit-window" class="audit-window">
        {props.window}
      </p>
      <p id="audit-ceiling" class="audit-ceiling">
        {props.ceiling}
      </p>
      {props.more === '' ? null : (
        <button
          id="audit-more"
          type="button"
          class="audit-button"
          onClick={props.onMore}
        >
          {props.more}
        </button>
      )}
      {props.empty === '' ? null : (
        <p id="audit-empty" class="audit-empty">
          {props.empty}
        </p>
      )}
      {props.none === '' ? null : (
        <p id="audit-none" class="audit-empty">
          {props.none}
        </p>
      )}

      {props.drawer === null ? null : <AuditDrawer {...props.drawer} />}
    </div>
  );
}
