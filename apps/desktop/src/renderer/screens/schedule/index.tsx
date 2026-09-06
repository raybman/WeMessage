/**
 * The schedule editor: the schedules on the left, one week on the right.
 *
 * A LAYOUT and nothing else, on the same terms as the rules screen. No state,
 * no bridge member, no derivation, and — the one this screen adds — no clock.
 * Every instant it draws arrived as a prop, which is what lets an arch row
 * say that nothing under `screens/` reads `Date.now()` and have that be a
 * property of the build rather than a habit.
 *
 * The detail pane is nullable for the same reason it is on the rules screen:
 * landing here selects nothing. What an operator should see first is HOW MANY
 * schedules there are and which rules point at each, because a second
 * schedule nobody remembers writing is the failure this screen exists to make
 * visible.
 */
import type { VNode } from 'preact';
import { ScheduleList, type ScheduleListProps } from './List.js';
import { ScheduleDetail, type ScheduleDetailProps } from './Detail.js';

export interface ScheduleScreenProps {
  /** The binding's own word for where the catalogue reads got to. */
  readonly status: string;
  readonly list: ScheduleListProps;
  readonly detail: ScheduleDetailProps | null;
}

export default function ScheduleScreen(props: ScheduleScreenProps): VNode {
  return (
    <div id="schedule" class="schedule" data-schedule={props.status}>
      <ScheduleList {...props.list} />
      <div class="sched-pane">
        {props.detail === null ? (
          <p id="sched-none" class="rule-hint">
            PICK A SCHEDULE · WINDOWS ARE IN THE SCHEDULE&apos;S OWN ZONE, NOT
            THIS DEVICE&apos;S
          </p>
        ) : (
          <ScheduleDetail {...props.detail} />
        )}
      </div>
    </div>
  );
}
