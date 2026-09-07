/**
 * The daemon's error taxonomy (C-6).
 *
 * Until s9 Sc2 there was one error class in this package with a `code` on it
 * (`LaunchdLabelRefused`, minted by Sc1) and nothing that said what the set of
 * codes WAS. That is fine for one class and stops being fine at three: the
 * entrypoint has to decide, for an arbitrary thrown value, whether this is a
 * condition it understands well enough to report in one line and exit, or a
 * defect that deserves a stack trace. "Understands" has to be a set, and a set
 * a reader can enumerate.
 *
 * The shape is the one this project uses wherever a union has to stay in step
 * with a table: a `readonly` tuple of codes, a union derived FROM the tuple,
 * and `Readonly<Record<DaemonErrorCode, DaemonErrorSpec>>` over that union.
 * TypeScript then rejects both halves of the drift — a code with no spec, and
 * a spec for a code that is not in the union — so the totality is structural
 * rather than a list somebody keeps up to date.
 *
 * The half the compiler cannot do is a NEW class, somewhere else in this
 * package, pinning its own code as a const-asserted literal field. That
 * compiles, and it is invisible here. `lock.spec.ts` closes that gap by
 * scanning the package's source for that declaration and requiring the codes
 * it finds to equal the tuple above, so the taxonomy is a fact about the code
 * rather than about memory. That scan reads raw bytes, comments included,
 * which is why this paragraph describes the declaration instead of quoting
 * it: a guard that a comment can trip is doing its job, and the fix for
 * tripping it is to reword, never to narrow what it reads.
 *
 * Every code exits 1. That is not a placeholder for a richer scheme: these are
 * all "this daemon will not start, and here is the sentence that says why",
 * and an operator scripting `wemessage || echo failed` should not have to
 * learn a numbering. If a future condition needs a different exit status it
 * gets a spec that says so, and the spec is the only place to look.
 */

/**
 * Every condition this daemon can refuse to start for, and nothing else.
 *
 * Order is alphabetical so the exhaustive assertions in the spec can compare
 * sorted lists without a note explaining why the order is what it is.
 */
export const DAEMON_ERROR_CODES = [
  'ALREADY_RUNNING',
  'LAUNCHD_LABEL_REFUSED',
  'LOCK_DIR_UNWRITABLE',
  'PORT_IN_USE',
] as const;

export type DaemonErrorCode = (typeof DAEMON_ERROR_CODES)[number];

export interface DaemonErrorSpec {
  /** Process exit status when this reaches the entrypoint uncaught. */
  readonly exitCode: number;
  /** What the condition IS, for a reader of this table rather than a user. */
  readonly summary: string;
}

export const DAEMON_ERROR_SPECS: Readonly<
  Record<DaemonErrorCode, DaemonErrorSpec>
> = {
  ALREADY_RUNNING: {
    exitCode: 1,
    summary:
      'another daemon holds the instance lock in this directory and is alive',
  },
  LAUNCHD_LABEL_REFUSED: {
    exitCode: 1,
    summary: 'a launchd label outside this project’s prefix was addressed',
  },
  LOCK_DIR_UNWRITABLE: {
    exitCode: 1,
    summary: 'the configured directory cannot hold the instance lock',
  },
  PORT_IN_USE: {
    exitCode: 1,
    summary: 'the local API port is bound by something that is not us',
  },
};

/**
 * A second daemon, in a directory that already has a live one.
 *
 * The message is the entire operator-facing output of that case: one line,
 * naming the pid, so the answer to "why will it not start" and "what do I
 * stop" are the same sentence.
 */
export class AlreadyRunningError extends Error {
  readonly code = 'ALREADY_RUNNING' as const;
  readonly pid: number;
  constructor(pid: number) {
    super(`already running (pid ${String(pid)})`);
    this.name = 'AlreadyRunningError';
    this.pid = pid;
  }
}

/**
 * The lock was ours and the port was not.
 *
 * Deliberately NOT folded into `AlreadyRunningError`. They look alike from the
 * inside — both are "something else got here first" — and they are opposite
 * instructions on the outside. "Already running" says stop the other daemon;
 * this one says the daemon is not running and something unrelated has the
 * port. Collapsing them sends an operator hunting for a process that is not
 * there.
 */
export class PortInUseError extends Error {
  readonly code = 'PORT_IN_USE' as const;
  readonly port: number;
  constructor(port: number) {
    super(
      `port ${String(port)} is already in use on 127.0.0.1 (not by a wemessage daemon)`,
    );
    this.name = 'PortInUseError';
    this.port = port;
  }
}

/**
 * The configured directory will not take the lock file.
 *
 * The directory is named in the message because it is the only actionable
 * thing about this failure, and it is carried as a field because the spec
 * asserts on it and parsing it back out of a sentence would be a second
 * definition of the same fact.
 */
export class LockDirUnwritableError extends Error {
  readonly code = 'LOCK_DIR_UNWRITABLE' as const;
  readonly dir: string;
  constructor(dir: string, cause?: unknown) {
    super(
      `cannot write the instance lock in ${dir}: the directory is not writable`,
    );
    this.name = 'LockDirUnwritableError';
    this.dir = dir;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Is this a condition the entrypoint knows how to report in one line?
 *
 * Structural rather than `instanceof`, because `LaunchdLabelRefused` lives
 * next to the launchctl wrapper it belongs to and pulling it here to satisfy a
 * type guard would move code for the guard's convenience. The membership test
 * is against the tuple, so a code that is not in the taxonomy is not in the
 * taxonomy no matter which class threw it.
 */
export function isDaemonError(
  err: unknown,
): err is Error & { readonly code: DaemonErrorCode } {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return (
    typeof code === 'string' &&
    (DAEMON_ERROR_CODES as readonly string[]).includes(code)
  );
}
