/**
 * The launchd VOCABULARY: the label brand, the op set, and the shapes a
 * service-manager invocation is allowed to have.
 *
 * WHY THIS FILE EXISTS, and why it is not simply part of the runner.
 *
 * `launchctl.ts` is the one module in this repository permitted to name the
 * service manager, and `test/arch.spec.ts` pins that as an equality over the
 * source tree. An import specifier is source, so every module that reached
 * for the runner's types by importing `./launchctl.js` would have become a
 * second module naming the tool — and the guard would have been failed by the
 * installer, the CLI and the entrypoint doing exactly what they are supposed
 * to do. Splitting the vocabulary out is what lets the guard stay an
 * equality: the words live here, the spawn lives there, and `launchctl.ts`
 * re-exports this file so Sc 1's spec keeps reading as it was written.
 *
 * THE BINARY'S NAME IS A TYPE HERE, NOT A STRING. `ServiceManagerFile` is a
 * branded string with no public constructor, so an invocation cannot be built
 * by any module that has not obtained the brand from the runner. That is the
 * same trick the label uses, aimed one level lower: the runner is the only
 * place the value can come from, so the type system now agrees with the arch
 * guard rather than merely coexisting with it.
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
 * The namespace tests install under, and the only one a test lane may
 * mutate. A strict extension of the prefix above, so everything true of
 * "ours" is true of it.
 */
export const LAUNCH_AGENT_TEST_LABEL_PREFIX = 'sh.wemessage.test.';

/**
 * The two prefixes this product installs under, and nothing else.
 *
 * `sh.wemessage.staging.` is inside the namespace and is not on this list:
 * "ours" is necessary and not sufficient, because the test prefix is the one
 * the sweeps are allowed to delete and a third prefix would silently be
 * outside every sweep.
 */
export const INSTALLABLE_LABEL_PREFIXES = [
  LAUNCH_AGENT_LABEL_PREFIX,
  LAUNCH_AGENT_TEST_LABEL_PREFIX,
] as const;
export type InstallableLabelPrefix =
  (typeof INSTALLABLE_LABEL_PREFIXES)[number];

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

/** Is this string a label this project owns? The one definition. */
export function isLaunchAgentLabel(raw: string): boolean {
  return LABEL_RE.test(raw);
}

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
 * Thrown when the ARGUMENT VECTOR does not agree with the label (s9 Sc3 G1).
 *
 * Separate from `LaunchdLabelRefused` because they are different failures
 * with different fixes. "That label is not ours" is a caller passing the
 * wrong name. "That label is ours and the file you handed me declares
 * somebody else's" is a caller who would have loaded a foreign agent under a
 * legitimate-looking name, and the second sentence is the one worth reading
 * twice.
 */
export class LaunchdInvocationRefused extends Error {
  readonly code = 'LAUNCHD_INVOCATION_REFUSED' as const;
  readonly detail: string;
  constructor(detail: string) {
    super(`refusing to run the service manager: ${detail}`);
    this.name = 'LaunchdInvocationRefused';
    this.detail = detail;
  }
}

/**
 * The five scoped verbs, in the order the service lifecycle uses them.
 *
 * Frozen and exported so the arch spec can assert the vocabulary rather than
 * trust it, and so a sixth cannot appear quietly.
 */
export const LAUNCHCTL_OPS = [
  'bootstrap',
  'bootout',
  'enable',
  'disable',
  'print',
] as const;
export type LaunchctlOp = (typeof LAUNCHCTL_OPS)[number];

/**
 * The service manager's own name, as a type no module but the runner can
 * produce a value of.
 */
declare const SERVICE_MANAGER_FILE: unique symbol;
export type ServiceManagerFile = string & {
  readonly [SERVICE_MANAGER_FILE]: 'service-manager-file';
};

/** Exactly what the runner would hand to `child_process`, and nothing more. */
export interface ServiceManagerInvocation {
  readonly file: ServiceManagerFile;
  readonly args: readonly string[];
}

export interface ServiceManagerResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The spawn. Injected everywhere, and typed to accept only an invocation the
 * runner built — a caller cannot smuggle an argv past the guard by supplying
 * a spawn that ignores it.
 */
export type ServiceManagerSpawn = (
  i: ServiceManagerInvocation,
) => Promise<ServiceManagerResult>;

export interface ServiceManagerRunOptions {
  /** The GUI domain's uid. Defaults to this process's; never another's. */
  readonly uid?: number;
  /** Required by `bootstrap`, meaningless to every other op. */
  readonly plistPath?: string;
}

/**
 * The runner, as the shape every consumer receives it as.
 *
 * `service.ts`, `cli.ts` and the test lane all take one of these rather than
 * importing the runner, which is what keeps the tool's name in one file.
 */
export type ServiceManagerRun = (
  op: LaunchctlOp,
  label: LaunchAgentLabel,
  options: ServiceManagerRunOptions,
) => Promise<ServiceManagerResult>;

/**
 * Mint a label, or refuse.
 *
 * The ONE supported way to obtain a `LaunchAgentLabel`.
 */
export function asLaunchAgentLabel(raw: string): LaunchAgentLabel {
  if (!isLaunchAgentLabel(raw)) throw new LaunchdLabelRefused(raw);
  return raw as LaunchAgentLabel;
}
