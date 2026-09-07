/**
 * THE ONLY MODULE IN THIS REPOSITORY THAT MAY SPAWN macOS' SERVICE MANAGER.
 *
 * s9 Sc 1 rows 5 and 6; the type-level half of F-120. Sc 3 gives this file
 * real work (install, load, unload the gateway's LaunchAgent); at Sc 1 it
 * exists so that the guards which pin "exactly one spawner" and "a foreign
 * label is refused before any spawn" have something to be true about.
 *
 * THE RULE THIS ENCODES, in one sentence: a process that can spawn a service
 * manager must never be able to reach the agent supervising it.
 *
 * The machine this project is developed on runs other people's launchd
 * agents — an editor's helper, a backup daemon, the operator's own assistant
 * — and every one of them is one mistyped label away from being stopped by
 * this code. `launchctl bootout` does not ask, does not confirm, and does not
 * distinguish "the service I wrote" from "the service watching me write it".
 * So the label is not a string. It is a BRAND that only `asLaunchAgentLabel`
 * can mint, minted only for this project's own reverse-DNS namespace.
 *
 * AND THE BRAND IS NOT ENOUGH, which is the whole reason the runtime
 * re-check below exists. A brand is a compile-time fiction: `foo as
 * LaunchAgentLabel` erases it, and the compiler is happy. That cast is not a
 * hypothetical — the shapes that produce one are a label read out of a plist,
 * out of a config file, or out of `process.argv`, all three of which Sc 3
 * will have. So `runLaunchctl` asks again, at runtime, on the near side of
 * `child_process`, and throws before a process is ever created.
 *
 * The throw is SYNCHRONOUS even though the function returns a promise. An
 * `async function` would have made the refusal a rejection, and an unawaited
 * rejected promise is a warning printed on stderr rather than a stopped
 * program. That is not good enough for the last thing standing between this
 * code and somebody else's daemon.
 *
 * WHAT IS ABSENT, ON PURPOSE. The deprecated whole-domain verbs are not in
 * `LAUNCHCTL_OPS`, so no caller can name one without a cast, and the arch
 * spec's launchd sweep makes writing one down anywhere in the tree a failing
 * diff. Every op here is scoped to a target in the CALLER's GUI domain;
 * root's domain is never addressed, and this module never spawns anything
 * whose argv it did not build itself from that closed union.
 *
 * The spawn is INJECTED rather than imported. Not for testability as such —
 * for the stronger property that the tests which prove this guard bites have
 * no way to reach a real service manager even by accident.
 */

/**
 * A launchd label this project owns.
 *
 * Nominal, not structural: the private symbol means a bare `string` will not
 * satisfy it, so the only supported way to obtain one is `asLaunchAgentLabel`.
 */
declare const LAUNCH_AGENT_LABEL: unique symbol;
export type LaunchAgentLabel = string & {
  readonly [LAUNCH_AGENT_LABEL]: 'launch-agent-label';
};

/** This project's reverse-DNS namespace. The one definition of "ours". */
export const LAUNCH_AGENT_LABEL_PREFIX = 'sh.wemessage.';

/**
 * `sh.wemessage.` followed by at least one dot-separated component of
 * lowercase alphanumerics and hyphens.
 *
 * Anchored at BOTH ends and matched on component boundaries, which is what
 * separates it from the `startsWith` a hurried version of this file would
 * have used: `sh.wemessageX.gateway` starts with neither, and
 * `xsh.wemessage.gateway` starts with the wrong thing entirely.
 */
const LABEL_RE = /^sh\.wemessage(?:\.[a-z0-9-]+)+$/;

/** Thrown for a label this project does not own. Never carries a spawn. */
export class LaunchdLabelRefused extends Error {
  readonly code = 'LAUNCHD_LABEL_REFUSED' as const;
  readonly label: string;
  constructor(label: string) {
    super(
      `refusing to address launchd label ${JSON.stringify(label)}: ` +
        `only labels under ${LAUNCH_AGENT_LABEL_PREFIX} belong to this project`,
    );
    this.name = 'LaunchdLabelRefused';
    this.label = label;
  }
}

/**
 * The five scoped verbs, in the order the service lifecycle uses them.
 *
 * Frozen and exported so the arch spec can assert the vocabulary rather than
 * trust it, and so Sc 3 cannot quietly grow a sixth.
 */
export const LAUNCHCTL_OPS = [
  'bootstrap',
  'bootout',
  'enable',
  'disable',
  'print',
] as const;
export type LaunchctlOp = (typeof LAUNCHCTL_OPS)[number];

/** Exactly what this module would hand to `child_process`, and nothing more. */
export interface LaunchctlInvocation {
  readonly file: 'launchctl';
  readonly args: readonly string[];
}

export interface LaunchctlResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface LaunchctlOptions {
  /**
   * The spawn. Injected, and typed to accept only an invocation this module
   * built — a caller cannot smuggle an argv past the guard by supplying a
   * spawn that ignores it.
   */
  readonly spawn: (i: LaunchctlInvocation) => Promise<LaunchctlResult>;
  /** The GUI domain's uid. Defaults to this process's. Never a root domain. */
  readonly uid?: number;
  /** Required by `bootstrap`, meaningless to every other op. */
  readonly plistPath?: string;
}

/**
 * Mint a label, or refuse.
 *
 * The ONE supported way to obtain a `LaunchAgentLabel`.
 */
export function asLaunchAgentLabel(raw: string): LaunchAgentLabel {
  if (!LABEL_RE.test(raw)) throw new LaunchdLabelRefused(raw);
  return raw as LaunchAgentLabel;
}

/**
 * Run one scoped `launchctl` op against a label this project owns.
 *
 * Returns a promise; THROWS synchronously if the label does not survive the
 * re-check, or if `bootstrap` was asked for without a plist. Nothing is
 * spawned on either path.
 */
export function runLaunchctl(
  op: LaunchctlOp,
  label: LaunchAgentLabel,
  options: LaunchctlOptions,
): Promise<LaunchctlResult> {
  // THE RE-CHECK. Before the domain is computed, before the argv is built,
  // before anything is spawned. `label` arrives branded, and the brand is
  // erased by a cast, so the value is asked the same question a second time
  // at the only moment when the answer can still prevent a process.
  if (!LABEL_RE.test(label)) throw new LaunchdLabelRefused(label);

  const uid = options.uid ?? process.getuid?.() ?? 501;
  const domain = `gui/${String(uid)}`;

  let args: readonly string[];
  if (op === 'bootstrap') {
    // `bootstrap` takes a DOMAIN and a path, not a target. Without the path
    // the argv would be `bootstrap gui/501`, which launchd reads as a
    // domain-wide operation — the exact class of accident this file exists
    // to prevent, so it is refused rather than shipped.
    if (options.plistPath === undefined || options.plistPath.length === 0)
      throw new Error(
        'launchctl bootstrap requires a plistPath: a bootstrap without one ' +
          'addresses the whole domain rather than this project’s agent',
      );
    args = [op, domain, options.plistPath];
  } else {
    args = [op, `${domain}/${label}`];
  }

  return options.spawn({ file: 'launchctl', args });
}
