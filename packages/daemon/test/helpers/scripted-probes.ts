/**
 * s8 Sc15 — `DoctorProbes` whose answers are read from a mutable object the
 * test owns.
 *
 * `bootFixtureDaemon` takes `probes` ONCE, at boot, and spreads them into
 * the daemon's options. That is the right shape for a fixture that has one
 * posture for the whole of a test, and it is the wrong shape for an
 * onboarding wizard: the entire product claim of a permission step is that
 * an operator goes to System Settings, flips a switch OUT OF BAND, and the
 * card in front of them changes without a relaunch. A probe that cannot
 * change its answer between two calls cannot express that at all, and a
 * test that restarts the daemon to change it has proved something about a
 * restart instead.
 *
 * So the functions here are stable and the ANSWERS are not: each probe reads
 * the field it is named after off `script` at call time. Flipping
 * `script.fda = 'ok'` is exactly the operator's trip to System Settings, and
 * the next `GET /v1/doctor` sees it.
 *
 * `calls` is the second half, and it is what makes "the wizard asks exactly
 * when it is asked to, and never on a timer" an OBSERVATION. The request tee
 * can count `GET /v1/doctor` at the wire; this counts how many times the
 * daemon actually asked the OS, which is the number that would still move if
 * a cache were ever introduced between the two. Both are flat between two
 * gestures, because this app owns one timer and it is not here.
 *
 * `explode` makes every probe throw. `runDoctor` has no catch, so this is
 * the report-could-not-be-read case end to end — the one the Permissions
 * pane renders as four NOT CHECKED cards rather than four passes, and the
 * one a wizard is most tempted to render as "still checking…" forever.
 */
import type { FdaProbeResult } from '@wemessage/ingest';
import type { AutomationProbeResult } from '@wemessage/sendkit';
import type { DoctorProbes } from '@wemessage/daemon';

/** How many times each probe has been asked, since boot. */
export interface ProbeCalls {
  osMajor: number;
  fda: number;
  automation: number;
  messagesRunning: number;
}

/** The mutable answer sheet. Every field is read at call time, never cached. */
export interface ProbeScript {
  osMajor: number;
  fda: FdaProbeResult;
  automation: AutomationProbeResult;
  messagesRunning: boolean;
  /** When true every probe throws, so the whole report fails to be read. */
  explode: boolean;
  readonly calls: ProbeCalls;
}

export interface ScriptedProbes {
  script: ProbeScript;
  probes: DoctorProbes;
}

/** A healthy Mac: supported OS, both grants, Messages up. */
const DEFAULTS = {
  osMajor: 15,
  fda: 'ok',
  automation: 'ok',
  messagesRunning: true,
  explode: false,
} satisfies Omit<ProbeScript, 'calls'>;

export function scriptedProbes(
  initial: Partial<Omit<ProbeScript, 'calls'>> = {},
): ScriptedProbes {
  const script: ProbeScript = {
    ...DEFAULTS,
    ...initial,
    calls: { osMajor: 0, fda: 0, automation: 0, messagesRunning: 0 },
  };
  const bang = (): never => {
    throw new Error('probe-exploded');
  };
  return {
    script,
    probes: {
      osMajor: () => {
        script.calls.osMajor += 1;
        if (script.explode) return bang();
        return script.osMajor;
      },
      fda: () => {
        script.calls.fda += 1;
        if (script.explode) return Promise.reject(new Error('probe-exploded'));
        return Promise.resolve(script.fda);
      },
      automation: () => {
        script.calls.automation += 1;
        if (script.explode) return Promise.reject(new Error('probe-exploded'));
        return Promise.resolve(script.automation);
      },
      messagesRunning: () => {
        script.calls.messagesRunning += 1;
        if (script.explode) return Promise.reject(new Error('probe-exploded'));
        return Promise.resolve(script.messagesRunning);
      },
    },
  };
}
