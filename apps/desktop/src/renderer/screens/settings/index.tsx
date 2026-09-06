/**
 * The settings screen: five panes, one of which can stop the product and
 * one of which can end it.
 *
 * A LAYOUT and nothing else, on the same terms as the five screens before
 * it. Every string arrived as a prop; nothing under this directory names a
 * bridge member, reads a clock or holds state, and arch rows assert all
 * three. What is worth arguing here is the ORDER, because on a screen this
 * dangerous the order is a safety property:
 *
 *  1. **KILL SWITCH** first, because it is the control an operator comes
 *     here in a hurry to find. It is a DENY: it refuses a human approval
 *     too, not just autonomy, and the pane says so in words rather than
 *     letting "kill switch" imply a pause.
 *  2. **BEHAVIOUR**, the settings form, which is the closed key list as
 *     data — total over it in both directions, at compile time.
 *  3. **PERMISSIONS**, which reports and never grants.
 *  4. **AGENTS**, where a credential can be minted.
 *  5. **DISCONNECT**, last, because a destructive control at the top of a
 *     screen is a destructive control somebody reaches by accident.
 *
 * The panes are separate files because they are separate arguments, not
 * because this one got long: each carries the reasoning for one hazard, and
 * a reviewer who wants to know why there is no COPY CONNECT COMMAND should
 * not have to read past the kill switch to find out.
 */
import type { VNode } from 'preact';
import { AdaptersPane, type AdaptersPaneProps } from './Adapters.js';
import { DangerPane, type DangerPaneProps } from './Danger.js';
import { FormPane, type FormPaneProps } from './Form.js';
import { KillPane, type KillPaneProps } from './Kill.js';
import { PermsPane, type PermsPaneProps } from './Perms.js';

export interface SettingsScreenProps {
  /** `idle` | `loading` | `ready` | `failed`, straight off the binding. */
  readonly status: string;
  /**
   * The instant this window was opened, read ONCE in `main.tsx` and handed
   * down. Nothing on this screen counts: a "paused until 14:30" that ticked
   * would need a timer, and this app has exactly one.
   */
  readonly nowIso: string;
  readonly kill: KillPaneProps;
  readonly form: FormPaneProps;
  readonly perms: PermsPaneProps;
  readonly adapters: AdaptersPaneProps;
  readonly danger: DangerPaneProps;
}

export default function SettingsScreen(props: SettingsScreenProps): VNode {
  return (
    <div
      id="settings"
      class="settings"
      data-settings={props.status}
      data-now-iso={props.nowIso}
    >
      <KillPane {...props.kill} />
      <FormPane {...props.form} />
      <PermsPane {...props.perms} />
      <AdaptersPane {...props.adapters} />
      <DangerPane {...props.danger} />
    </div>
  );
}
