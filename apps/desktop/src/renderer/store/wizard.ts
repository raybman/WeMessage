/**
 * The onboarding wizard's binding — the SEVENTH file in this app that
 * reaches the bridge, and the only one that can put a message on a wire.
 *
 * Four channels, and the shape of the list is the argument.
 *
 * **`doctor`** is the only read. Onboarding asks the daemon what it can see
 * and renders the answer; it holds no catalogue, no draft and no settings
 * table, because every one of those would be a fact this screen could go on
 * showing after it stopped being true.
 *
 * **`openSystemSettings`** reaches no daemon at all. macOS TCC is not
 * grantable through any API — the OS's design, not an omission — so the
 * honest maximum a setup flow can offer for a refused permission is to put
 * the operator in front of the pane they have to act in. It takes a pane
 * NAME off main's closed allowlist, never a URL.
 *
 * **`wizardArm` and `sendTest` are one gesture split in half**, and the
 * split is the whole guard. INV-2 says there is exactly one call site of
 * the send port in the whole repo, reachable only through
 * `dispatchApproved` with a validated `Approval` row. (The port's type name
 * is not spelled here: the capability sweep that keeps that allowlist at
 * fifteen files reads raw text, so a comment naming it would make this
 * renderer file the sixteenth.) The wizard's step 5
 * does not go around that: it calls `POST /v1/send`, which mints a real
 * Draft, mints a real Approval through `humanApiActor()`, appends both
 * audit rows and only then dispatches. So the answer to "does onboarding
 * send a test message" is ROUTED, not refused — it is THE send path, taken
 * by a human pressing a button.
 *
 * What the halves add is that this process chooses neither end of it. Main
 * mints a four-hex code, remembers it beside the handle the operator typed,
 * and refuses any send whose recipient or body is not that exact pair. A
 * renderer that has been fully compromised can invoke both channels and
 * still cannot deliver anything the operator did not read off the screen.
 *
 * **`connect` is deliberately absent**, and Sc14 called this shot. The S8
 * plan's Scenario 14 says the app "then shows the wizard WELCOME step with
 * RECONNECT" after the danger zone disconnects. Half right: the app does
 * land here, but `disconnectDaemon` ROTATES the daemon's own credential, so
 * the bearer this process is holding is dead the instant that call returns.
 * A RECONNECT button on the welcome step would be a control that cannot
 * work, rendered at the exact moment an operator is deciding whether to
 * trust the product. The welcome step offers what is actually true instead:
 * where the credential lives, and a relaunch.
 *
 * **`on` is deliberately absent too.** The link state arrives as a prop
 * from `main.tsx`'s single stream subscription. A second subscriber would
 * be a second opinion about whether the daemon is there, and this screen is
 * entirely about there being one.
 *
 * **Nothing here persists anything.** There is no `localStorage`, no
 * settings write and no file. Quitting halfway through and reopening
 * RESTARTS, and it restarts because there is nowhere to resume from — a
 * wizard that reopened on step four because a counter said so would be
 * asserting three passes it has not re-established, and the premise of any
 * of them may have changed while the app was closed.
 */
import type { DoctorReportPayload } from '@wemessage/client';
import type { WmBridge } from '../../preload/api.js';
import { NOT_CHECKED, type CardState } from '../derive/permissionCards.js';
import { errorText } from './refusal.js';
import { reportOf } from './settings.js';

/** The four channels this flow may reach, sorted. */
export const WIZARD_CHANNELS = [
  'doctor',
  'openSystemSettings',
  'sendTest',
  'wizardArm',
] as const;

/**
 * The bridge, cut to what onboarding needs.
 *
 * `Pick` rather than a structural copy, for the same reason every other
 * binding does it: a channel renamed in `ipc-channels.ts` breaks this line
 * instead of quietly becoming a call to a channel that no longer exists.
 */
export type WizardBridge = Pick<
  WmBridge,
  'doctor' | 'openSystemSettings' | 'sendTest' | 'wizardArm'
>;

/**
 * Everything the flow renders, as the daemon last answered it.
 *
 * `report` is `null` when the probe threw, and that is a STATE rather than
 * an absence: four cards derived from `null` read NOT CHECKED, which is the
 * one thing a setup screen must never render as a pass.
 */
export interface WizardData {
  /** The daemon's last readable answer, or `null` if there is not one. */
  readonly report: DoctorReportPayload | null;
  /**
   * Whether a probe is in the air right now.
   *
   * This is the "checking…" state, and it needs no clock: it is the
   * lifetime of a promise. An app-wide arch row proves the renderer owns no
   * timer at all, so a spinner that could outlive its request — and go on
   * reassuring somebody about a probe that died — cannot be written here.
   */
  readonly probing: boolean;
  /** The four hex characters main minted, once it has minted them. */
  readonly code: string | null;
  /** How the test went, in the card vocabulary. NOT CHECKED until asked. */
  readonly outcome: CardState;
  /** The last failure, in the daemon's own words. */
  readonly failure: string;
}

export interface WizardBinding {
  data(): WizardData;
  subscribe(listener: () => void): () => void;
  /** `GET /v1/doctor`, and nothing else. */
  probe(): Promise<void>;
  /** Open a System Settings pane by NAME. Grants nothing; asks nobody. */
  reveal(pane: string): Promise<void>;
  /** Arm main, then take the one send path. Nothing else may call this. */
  sendTest(to: string): Promise<void>;
  /** Back to the resting state, so a re-entry renders no stale answer. */
  reset(): void;
  settled(): Promise<void>;
}

const EMPTY: WizardData = {
  report: null,
  probing: false,
  code: null,
  outcome: NOT_CHECKED,
  failure: '',
};

/**
 * The code main answered, or `null`.
 *
 * Narrowed rather than trusted, exactly as every other answer that crosses
 * this boundary is. A main that regressed into answering nothing would give
 * this screen no code to show, and a step that showed no code would refuse
 * to arm rather than send something the operator never saw.
 */
function codeOf(answer: unknown): string | null {
  if (typeof answer !== 'object' || answer === null) return null;
  const value = (answer as Record<string, unknown>)['code'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function bindWizard(bridge: WizardBridge): WizardBinding {
  let data: WizardData = EMPTY;
  const listeners = new Set<() => void>();
  const inflight = new Set<Promise<unknown>>();

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function track<T>(work: Promise<T>): Promise<T> {
    const done: Promise<void> = work.then(
      () => undefined,
      () => undefined,
    );
    inflight.add(done);
    void done.then(() => inflight.delete(done));
    return work;
  }

  return {
    data: () => data,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async probe() {
      // Painted BEFORE the request leaves, so `data-probing="yes"` is true
      // for the whole time it is true and not for the tail of it.
      data = { ...data, probing: true };
      notify();
      try {
        data = { ...data, report: reportOf(await track(bridge.doctor())) };
      } catch (error) {
        // A probe that threw leaves NO report, which renders as four NOT
        // CHECKED cards. The alternative — keeping the last report — would
        // let a screen go on showing a pass it can no longer establish.
        data = { ...data, report: null, failure: errorText(error) };
      }
      data = { ...data, probing: false };
      notify();
    },
    async reveal(pane) {
      try {
        await track(bridge.openSystemSettings(pane));
      } catch (error) {
        data = { ...data, failure: errorText(error) };
        notify();
      }
    },
    async sendTest(to) {
      try {
        const code = codeOf(await track(bridge.wizardArm(to)));
        if (code === null) {
          data = {
            ...data,
            outcome: 'FAIL',
            failure: 'the app was not given a code to show you',
          };
          notify();
          return;
        }
        // Shown before it is used. The operator is about to compare four
        // characters on this screen against four on a phone, and a code
        // that only appeared afterwards would be a code they could not
        // have checked.
        data = { ...data, code, failure: '' };
        notify();
        await track(bridge.sendTest(to, code));
        data = { ...data, outcome: 'OK' };
      } catch (error) {
        data = { ...data, outcome: 'FAIL', failure: errorText(error) };
      }
      notify();
    },
    reset() {
      data = EMPTY;
      notify();
    },
    async settled() {
      while (inflight.size > 0) await Promise.all([...inflight]);
    },
  };
}
