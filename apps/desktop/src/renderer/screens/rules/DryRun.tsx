/**
 * The dry run: what this rule WOULD have done, and nothing else.
 *
 * §1.6 route 7 replays the last N inbound messages against one stored rule
 * and answers `matched` per row. It writes nothing, drafts nothing and
 * dispatches nothing, and the panel says so in words rather than leaving the
 * operator to infer it from the absence of a confirmation — a preview that
 * looks like an action is how somebody discovers it was one.
 *
 * Two things on each row are derived rather than fetched, and both are
 * honest about their limits (`derive/dryRun.ts` carries the argument):
 *
 *  - the HIGHLIGHT is a client-side mirror of the matcher. The daemon owns
 *    `matched`; the mirror only ever subtracts, so a row the daemon matched
 *    and the mirror cannot locate is rendered as a match with no span lit
 *    and a word saying where the highlight went.
 *  - SHADOWING is a join over guid across the replays of the rules above
 *    this one, because `DryRunRow` carries no rule ids and nothing on the
 *    wire can name a rule other than the one asked about. §1.7 evaluates in
 *    priority order and stops at the first match, so a row a higher rule
 *    takes is a row this rule never sees, however well it matches.
 */
import type { VNode } from 'preact';
import type { DryRunViewRow } from '../../derive/dryRun.js';

export interface DryRunPanelProps {
  readonly total: number;
  readonly matched: number;
  readonly limit: number;
  readonly rows: readonly DryRunViewRow[];
}

function verdictOf(row: DryRunViewRow): string {
  if (!row.matched) return 'NO MATCH';
  if (row.shadowedBy !== null) return `SHADOWED · ${row.shadowedBy}`;
  return 'WINS';
}

export function DryRunPanel(props: DryRunPanelProps): VNode {
  return (
    <section
      id="dryrun"
      class="dryrun"
      aria-label="DRY RUN"
      data-total={String(props.total)}
      data-matched={String(props.matched)}
    >
      <p id="dryrun-count" class="dryrun-count">
        {`${String(props.matched)} / ${String(props.total)} MATCHED`}
      </p>
      <p id="dryrun-note" class="rule-hint">
        READ-ONLY REPLAY · NOTHING DRAFTS, NOTHING GOES OUT, NOTHING IS APPROVED
        BY LOOKING
      </p>
      {props.matched === 0 ? (
        <p id="dryrun-empty" class="rule-hint">
          {`THIS RULE MATCHED NOTHING IN THE LAST ${String(
            props.limit,
          )} MESSAGES · THAT IS ADVICE, NOT A REFUSAL`}
        </p>
      ) : null}
      <ul class="dryrun-rows">
        {props.rows.map((row) => (
          <li
            key={row.guid}
            class="dryrun-row"
            data-guid={row.guid}
            data-matched={row.matched ? 'yes' : 'no'}
            // Always present, empty when nothing shadows it: an attribute
            // that appears only on the interesting rows makes "absent" and
            // "not shadowed" the same observation.
            data-shadowed={row.shadowedBy ?? ''}
          >
            <span class="dryrun-verdict">{verdictOf(row)}</span>
            <span class="dryrun-handle">{row.handle}</span>
            <span class="dryrun-preview">
              {row.preview.length === 0 ? (
                <span data-hit="no">(NO TEXT ON THIS MESSAGE)</span>
              ) : (
                row.preview.map((span, index) => (
                  <span
                    key={`${String(index)}:${span.text}`}
                    data-hit={span.hit ? 'yes' : 'no'}
                  >
                    {span.text}
                  </span>
                ))
              )}
            </span>
            {row.matched && !row.hitVisible ? (
              <span class="dryrun-where">
                MATCHED ON SOMETHING THIS PREVIEW CANNOT SHOW
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
