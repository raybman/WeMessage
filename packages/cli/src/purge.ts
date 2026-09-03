/**
 * `wemessage disconnect --purge` confirmation logic (s3-execution
 * Scenario 10, §1.3.7 step 6; Fable design consult). Split out from bin.ts
 * so the one piece of actual logic here — matching the typed phrase — is
 * unit-testable without importing bin.ts, which runs
 * `program.parseAsync(process.argv)` as a module side effect the instant
 * it's imported (every existing CLI test in this repo spawns the compiled
 * bin as a subprocess for exactly this reason; none imports it directly).
 *
 * The interactive TTY prompt itself is NOT unit-tested anywhere in this
 * repo: `child_process.spawn` never gives a child a real TTY stdin (no pty
 * dependency exists here — Gate 4 forbids new package.json deps), so "type
 * the phrase at a real terminal" can only be exercised by hand.
 * `--yes-really-purge` is the sanctioned script/CI path around that gap.
 */
export const PURGE_PHRASE = 'delete my data';

export function matchesPurgePhrase(input: string): boolean {
  return input.trim() === PURGE_PHRASE;
}

export interface ConfirmPurgeDeps {
  isTTY: boolean;
  ask(): Promise<string>;
}

/**
 * Non-TTY stdin (piped/redirected — cron, CI, a script) refuses outright:
 * there is no human to prompt, and reading the phrase off a pipe would let
 * `echo "delete my data" | wemessage disconnect --purge` defeat the entire
 * point of a typed confirmation. `--yes-really-purge` is the sanctioned
 * bypass (bin.ts checks that flag before ever calling this function).
 */
export async function confirmPurge(deps: ConfirmPurgeDeps): Promise<boolean> {
  if (!deps.isTTY) return false;
  const answer = await deps.ask();
  return matchesPurgePhrase(answer);
}
