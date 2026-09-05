/**
 * s7-execution Scenario 6 — the kit's command line (plan §1.7, F-86).
 *
 * This exists so that one sentence elsewhere in the product is true. When
 * `wemessage adapters test <id>` refuses (s7 Sc5), it prints
 * `run: npx @wemessage/adapter-testkit --cmd "<your adapter>"`. That refusal
 * is deliberate — the daemon CLI must not import or spawn the kit, because
 * conformance is the adapter author's business and not a daemon subcommand —
 * but a pointer at a command that does not resolve is worse than no pointer,
 * so the kit ships a bin under the name `npx` resolves for this package.
 *
 * Exit codes are the contract, not the output format: 0 conformant, 1 not
 * conformant, 2 usage. A CI job wires the first two and never parses prose.
 * No colour, on any surface (C-9).
 */
import { basename, extname } from 'node:path';
import { badgeLine, formatJson, formatTap } from './report.js';
import { parseCommand, runConformanceSpawned } from './spawn.js';

export const EXIT_OK = 0;
export const EXIT_NOT_CONFORMANT = 1;
export const EXIT_USAGE = 2;

const USAGE = `usage: wemessage-adapter-testkit --cmd "<command to run your adapter>"

  --cmd <string>      required; the adapter to run, split without a shell
  --format <fmt>      tap (default) | json | badge
  --timeout <ms>      per-check wall clock (default 10000)
  --transport <name>  ws (default); the only transport this kit speaks

The adapter is spawned as a child process and dialled back over a loopback
websocket. Your adapter reads five environment variables:

  WEMESSAGE_GATEWAY_URL      ws://127.0.0.1:<port>/v1/agent
  WEMESSAGE_ADAPTER_TOKEN    a synthetic wm_<64 hex>, fresh every run
  WEMESSAGE_ADAPTER_ID       the id to echo back in your hello frame
  WEMESSAGE_BACKOFF_MS       0
  WEMESSAGE_MAX_ATTEMPTS     3

The token is passed by environment and never by argv. Exit 0 conformant,
1 not conformant, 2 usage.`;

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

interface Parsed {
  cmd: string;
  format: 'tap' | 'json' | 'badge';
  timeoutMs?: number;
}

class UsageError extends Error {}

function parseArgv(argv: readonly string[]): Parsed {
  let cmd: string | undefined;
  let format: 'tap' | 'json' | 'badge' = 'tap';
  let timeoutMs: number | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--cmd':
        if (value === undefined) throw new UsageError('--cmd needs a value');
        cmd = value;
        i += 1;
        break;
      case '--format':
        if (value !== 'tap' && value !== 'json' && value !== 'badge')
          throw new UsageError(`unknown format: ${String(value)}`);
        format = value;
        i += 1;
        break;
      case '--timeout': {
        const ms = Number(value);
        if (!Number.isFinite(ms) || ms <= 0)
          throw new UsageError(`--timeout needs a positive number of ms`);
        timeoutMs = ms;
        i += 1;
        break;
      }
      case '--transport':
        // `ws` is the only transport, and is accepted as a no-op alias so the
        // documented spelling from the plan keeps working. Anything else is
        // refused loudly rather than silently ignored: an operator who asked
        // for stdio and got ws would be reading a report about the wrong run.
        if (value !== 'ws')
          throw new UsageError(`unsupported transport: ${String(value)}`);
        i += 1;
        break;
      case '--help':
      case '-h':
        throw new UsageError('');
      default:
        throw new UsageError(`unknown flag: ${String(flag)}`);
    }
  }

  if (cmd === undefined) throw new UsageError('--cmd is required');
  return { cmd, format, ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
}

export async function main(
  argv: readonly string[],
  io: CliIo,
): Promise<number> {
  let parsed: Parsed;
  let words: string[];
  try {
    parsed = parseArgv(argv);
    words = parseCommand(parsed.cmd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== '') io.err(message);
    io.err(USAGE);
    return EXIT_USAGE;
  }

  const [executable, ...rest] = words;
  if (executable === undefined) {
    io.err('--cmd was empty');
    io.err(USAGE);
    return EXIT_USAGE;
  }

  // The badge names the adapter, so it names the file the operator typed
  // rather than the interpreter that happened to run it: `node foo.mjs` is a
  // report about `foo`, not a report about node.
  const named = rest.at(-1) ?? executable;
  const report = await runConformanceSpawned({
    cmd: executable,
    args: rest,
    name: basename(named, extname(named)),
    ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
  });

  if (parsed.format === 'json') io.out(formatJson(report));
  else if (parsed.format === 'badge') io.out(badgeLine(report));
  else io.out(formatTap(report));

  return report.conformant ? EXIT_OK : EXIT_NOT_CONFORMANT;
}
