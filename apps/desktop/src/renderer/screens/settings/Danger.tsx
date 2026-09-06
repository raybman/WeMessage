/**
 * The danger zone: one act, counted, typed and irreversible.
 *
 * There is exactly one destructive control here, and an arch row asserts
 * that — `#set-danger` may hold one button and it is this one. A second
 * would need its own count and its own confirm, and a zone with two buttons
 * is a zone where the operator learns to click past the first.
 *
 * What it destroys is stated as NUMBERS, from the daemon, before anything
 * is armed: how many adapter credentials it revokes and how many drafts it
 * abandons. "This cannot be undone" with no quantity in it is the shape
 * this exists to refuse, and Sc12's `TN-bulk-auto-silently` is the same
 * lesson from the other side — a confirm that skips itself when it judges
 * the work small is a confirm that is missing exactly when the count is
 * wrong. The five consequences are rendered every time, at every count.
 *
 * There is deliberately NO control here that reaches the audit log. Sc13
 * pinned, at the source and at `ROUTE_TABLE`, that no route mutates it, and
 * the daemon's own teardown reports its log-bearing step as SKIPPED unless
 * asked for on the wire. This screen never asks: `bridge.disconnect()` is
 * called with no argument at all, so the option cannot be set by a mistake
 * in this file. A GUI that could erase the record of what it did would make
 * every other guarantee in this app unverifiable after the fact.
 *
 * The report is the daemon's, rendered as data. Every step keeps the
 * daemon's own id and status, and `manualRevocation` is printed verbatim:
 * the two things a teardown cannot do for you are the two things most
 * likely to be forgotten.
 */
import type { VNode } from 'preact';

export interface DangerStepView {
  readonly id: string;
  readonly state: string;
  readonly text: string;
}

export interface DangerReportView {
  readonly steps: readonly DangerStepView[];
  readonly manual: readonly string[];
  readonly manualTitle: string;
}

export interface DangerPaneProps {
  readonly counts: string;
  readonly bullets: readonly string[];
  readonly report: DangerReportView | null;
  readonly onDisconnect: () => void;
}

export function DangerPane(props: DangerPaneProps): VNode {
  return (
    <section id="set-danger" class="set-pane set-pane-danger">
      <h2 class="set-pane-title">DISCONNECT</h2>
      <p id="danger-counts" class="danger-counts">
        {props.counts}
      </p>
      <ul class="danger-bullets">
        {props.bullets.map((bullet, index) => (
          <li key={String(index)} class="danger-bullet">
            {bullet}
          </li>
        ))}
      </ul>
      <button
        id="danger-disconnect"
        type="button"
        class="danger-button"
        onClick={props.onDisconnect}
      >
        DISCONNECT THIS MAC
      </button>

      {props.report === null ? null : (
        <div id="danger-report" class="danger-report">
          <h3 class="danger-report-title">WHAT THE DAEMON DID</h3>
          <ul class="danger-steps">
            {props.report.steps.map((step) => (
              <li
                key={step.id}
                class="danger-step"
                data-step={step.id}
                data-state={step.state}
              >
                {step.text}
              </li>
            ))}
          </ul>
          <h3 class="danger-report-title">{props.report.manualTitle}</h3>
          <ul class="danger-manuals">
            {props.report.manual.map((line, index) => (
              <li key={String(index)} class="danger-manual">
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
