/**
 * The rules editor: a list on the left, one rule on the right.
 *
 * This file is a LAYOUT and nothing else. It holds no state, reaches no
 * bridge member and derives nothing — every value it renders arrived as a
 * prop from the composition root, which is the same discipline the queue
 * screen follows and the reason the arch guard can say "no file under
 * `screens/rules` names `window.wm`" without that being a coincidence.
 *
 * The detail pane is nullable on purpose. Landing on the screen selects
 * nothing: the first thing an operator sees is the ORDER, because first
 * match wins and the order is the part of a rule set that is invisible in
 * any single rule.
 */
import type { VNode } from 'preact';
import { RulesList, type RulesListProps } from './List.js';
import { RuleDetail, type RuleDetailProps } from './Detail.js';
import { DryRunPanel, type DryRunPanelProps } from './DryRun.js';

export interface RulesScreenProps {
  /** The binding's own word for where the catalogue reads got to. */
  readonly status: string;
  readonly list: RulesListProps;
  readonly detail: RuleDetailProps | null;
  readonly dryRun: DryRunPanelProps | null;
}

export default function RulesScreen(props: RulesScreenProps): VNode {
  return (
    <div id="rules" class="rules" data-rules={props.status}>
      <RulesList {...props.list} />
      <div class="rules-detail">
        {props.detail === null ? (
          <p id="rules-none" class="rule-hint">
            PICK A RULE, OR WRITE A NEW ONE
          </p>
        ) : (
          <RuleDetail {...props.detail} />
        )}
        {props.dryRun === null ? null : <DryRunPanel {...props.dryRun} />}
      </div>
    </div>
  );
}
