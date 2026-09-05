/**
 * s7-execution Scenario 6 — the spawn transport (plan §1.7).
 *
 * Every adapter S7 ships after this file is verified through it: the Python
 * plugin (Sc 7), the Hermes HTTP adapter (Sc 8), Luna (Sc 9) and the OpenClaw
 * stdio shim (Sc 10). None of them is JavaScript we can `import`, so the kit
 * needs a way to run the SAME six checks against a process instead of a
 * closure. That is all this file is: a real `ws` listener, a child dialled
 * back to it, and a bridge that hands each of the child's frames to the same
 * `MockGateway` the in-process path uses. The checks do not know which they
 * are looking at, which is the property that makes a spawned CONFORMANT badge
 * mean the same thing as an in-process one.
 *
 * Three design decisions are load-bearing and are argued here rather than in
 * a doc, because a stranger implements against them:
 *
 *  1. **The token travels by environment, never by argv.** `ps(1)` shows any
 *     user on the box the full argv of every process; it does not show them
 *     another user's environment. An adapter token is `wm_<64 hex>`, is
 *     scrypt-hashed at rest and is displayed exactly once at mint time, so
 *     putting one on a command line would undo all three properties at once.
 *     `SPAWN_ENV_KEYS` is therefore the whole channel, and the kit mints a
 *     fresh synthetic token per run so that a real one is never in play here
 *     even by accident.
 *  2. **Readiness is the greeting, death is the exit event, and they are
 *     different things.** The kit never sleeps waiting for a child to come
 *     up: it waits for `hello` on the wire, which is the first thing the
 *     protocol says an adapter emits. When `hello` does not arrive, the kit
 *     asks whether the process is still there. Still running is `timeout`;
 *     gone is `crashed`, with the exit code. Reporting one for the other
 *     sends an adapter author to the wrong file, so the distinction is a row.
 *  3. **The bridge is a pipe AND an observer.** It relays bytes verbatim so
 *     the mock gateway remains the single judge, and it independently parses
 *     every frame with `parseAgentFrame` — the direction-AWARE parser — to
 *     label refusals with the daemon's own taxonomy (C-6). A replayed
 *     `draft.request` is a real frame type that an agent may simply never
 *     originate; `parseFrame` would launder it and `parseAgentFrame` catches
 *     it. For a spawned foreign adapter the report is the only feedback its
 *     author gets, and `adapter.no-send-frame:draft.request` is exactly what
 *     the daemon would have audited.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { basename } from 'node:path';
import { parseAgentFrame, type ParseError } from '@wemessage/protocol';
import { WebSocket as WsSocket, WebSocketServer } from 'ws';
import { DEFAULT_CHECK_ENV, type CheckEnv } from './checks.js';
import type {
  ConformanceReport,
  SpawnBudgets,
  SpawnDiagnostics,
} from './report.js';
import { runConformance } from './runner.js';
import type {
  AdapterHandle,
  AdapterStartContext,
  AdapterUnderTest,
  TestkitSocket,
} from './types.js';

/**
 * The child environment contract, in full and in order. This list IS the
 * public API a stranger implements against; anything not on it is inherited
 * from the parent and is not a promise the kit makes.
 *
 *  - `WEMESSAGE_GATEWAY_URL`   `ws://127.0.0.1:<ephemeral>/v1/agent`
 *  - `WEMESSAGE_ADAPTER_TOKEN` a synthetic `wm_<64 hex>`, fresh per run
 *  - `WEMESSAGE_ADAPTER_ID`    the id the child must echo in `hello`
 *  - `WEMESSAGE_BACKOFF_MS`    `0`; the kit cannot inject `delay` into a
 *                              foreign process, so this is its only lever
 *  - `WEMESSAGE_MAX_ATTEMPTS`  `3`; the ceiling check 5 measures
 */
export const SPAWN_ENV_KEYS: readonly string[] = [
  'WEMESSAGE_GATEWAY_URL',
  'WEMESSAGE_ADAPTER_TOKEN',
  'WEMESSAGE_ADAPTER_ID',
  'WEMESSAGE_BACKOFF_MS',
  'WEMESSAGE_MAX_ATTEMPTS',
];

export const DEFAULT_SPAWN_BUDGETS: SpawnBudgets = {
  checkMs: 10_000,
  transcriptBytes: 65_536,
  maxFrames: 1_000,
  maxFrameBytes: 262_144,
};

/** What replaces a `wm_<64 hex>` anywhere the kit is about to print it. */
export const TOKEN_REDACTION = 'wm_<redacted>';

/** Any adapter token shape, ours or a real one the child happens to hold. */
const TOKEN_PATTERN = /wm_[0-9a-f]{64}/g;

/** The path the daemon serves and therefore the path a child must dial. */
const AGENT_PATH = '/v1/agent';

/** `wm_` plus 64 hex. The carry a chunked transcript must hold back. */
const TOKEN_TEXT_LENGTH = 67;

/**
 * Macrotask drain before a NEGATIVE assertion, sized for a real socket. It is
 * not a readiness sleep: every POSITIVE fact in this kit is still awaited on
 * the wire. It is the bounded "nothing else is coming" pause the in-process
 * path already had, with a loopback round trip's worth of slack added.
 */
const SPAWN_SETTLE_TICKS = 120;

/** Redact before anything reaches a terminal, a CI log or the report. */
export function redactTokens(text: string): string {
  return text.replace(TOKEN_PATTERN, TOKEN_REDACTION);
}

/**
 * A fresh synthetic credential per run. Two runs in one process must not be
 * able to share one, and no run may ever be handed a real one: the kit runs
 * code it did not write, and the blast radius of a leak is bounded to a
 * string that authenticates nothing anywhere.
 */
export function mintAdapterToken(): string {
  return `wm_${randomBytes(32).toString('hex')}`;
}

/** Provably-different-per-run, provably-not-a-credential. */
function fingerprint(token: string): string {
  return `fp:${createHash('sha256').update(token).digest('hex').slice(0, 16)}`;
}

export interface ChildEnvOptions {
  base: Readonly<Record<string, string | undefined>>;
  url: string;
  token: string;
  adapterId: string;
  maxAttempts: number;
  /** Caller-supplied extras. May not name a reserved key. */
  extra?: Readonly<Record<string, string>>;
}

/**
 * Build the child's environment: the parent's, plus the five keys, with the
 * kit's values winning.
 *
 * The precedence is the security property. An operator with a REAL
 * `WEMESSAGE_ADAPTER_TOKEN` exported in their shell must not be able to hand
 * it to a stranger's adapter merely by running the kit in that shell, so an
 * inherited value is overwritten rather than respected. `extra` is refused
 * outright when it names a reserved key: a caller that wants to override the
 * contract is not overriding it, it is breaking it for every check downstream.
 */
export function buildChildEnv(opts: ChildEnvOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(opts.base))
    if (value !== undefined) env[key] = value;

  for (const [key, value] of Object.entries(opts.extra ?? {})) {
    if (SPAWN_ENV_KEYS.includes(key))
      throw new Error(
        `${key} is a reserved key of the child environment contract and cannot be overridden`,
      );
    env[key] = value;
  }

  env['WEMESSAGE_GATEWAY_URL'] = opts.url;
  env['WEMESSAGE_ADAPTER_TOKEN'] = opts.token;
  env['WEMESSAGE_ADAPTER_ID'] = opts.adapterId;
  env['WEMESSAGE_BACKOFF_MS'] = '0';
  env['WEMESSAGE_MAX_ATTEMPTS'] = String(opts.maxAttempts);
  return env;
}

/**
 * The daemon's taxonomy, mirrored (C-6).
 *
 * A frame the protocol does not have, or one an agent may not originate, is
 * `adapter.no-send-frame` — the adapter reached for a send path that does not
 * exist (INV-2). Anything else is `adapter.protocol-violation` labelled with
 * the parser's own kind. It is NEVER `gate.denied`: that is a closed union
 * about approval decisions and has nothing to say about a frame that never
 * reached the gate. See `packages/daemon/src/adapters/transport.ts`.
 */
export function classifyRefusal(
  kind: ParseError['kind'],
  type: unknown,
): string {
  if (
    (kind === 'direction' || kind === 'unknown-type') &&
    typeof type === 'string'
  )
    return `adapter.no-send-frame:${type}`;
  return `adapter.protocol-violation:${kind}`;
}

/**
 * Split a `--cmd` string into argv WITHOUT a shell.
 *
 * `shell: true` would hand a user string to `/bin/sh`, which is a command
 * injection surface in a tool whose entire job is running commands people
 * paste from READMEs. Quoting is supported because adapter paths have spaces;
 * substitution, globbing and pipelines are not, because they are not needed
 * to run one program.
 */
export function parseCommand(cmd: string): string[] {
  const argv: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of cmd) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (has) argv.push(current);
      current = '';
      has = false;
      continue;
    }
    current += ch;
    has = true;
  }
  if (quote !== null) throw new Error(`unbalanced quote in --cmd: ${cmd}`);
  if (has) argv.push(current);
  if (argv.length === 0) throw new Error('--cmd was empty');
  return argv;
}

/* ── process registry ──────────────────────────────────────────────────── */

/**
 * Every child the kit has started and not yet buried. A run reaps its own in
 * a `finally`, but a test that throws mid-assertion must not be able to leave
 * a process attached to a vitest worker, so the registry is module-level and
 * sweepable from an `afterEach`.
 */
const REGISTRY = new Set<ChildProcess>();

export function liveChildren(): number {
  return REGISTRY.size;
}

export async function killAllChildren(): Promise<void> {
  await Promise.all([...REGISTRY].map((child) => reap(child)));
}

/** SIGTERM, then SIGKILL, then wait for the exit event. Never a bare kill. */
async function reap(child: ChildProcess): Promise<void> {
  if (!REGISTRY.has(child)) return;
  const done = once(child, 'exit');
  try {
    child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  const hard = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }, 500);
  hard.unref();
  try {
    await done;
  } catch {
    /* already gone */
  } finally {
    clearTimeout(hard);
    REGISTRY.delete(child);
  }
}

/* ── the run ───────────────────────────────────────────────────────────── */

export interface SpawnedRunOptions {
  /** The executable. Never a shell string; use `parseCommand` for those. */
  cmd: string;
  args?: readonly string[];
  /** Reported as `adapter`. Defaults to the basename of `cmd`. */
  name?: string;
  /** Per-check wall clock, and the ceiling on any single wait. */
  timeoutMs?: number;
  /** Extra child environment. May not name a reserved key. */
  env?: Readonly<Record<string, string>>;
  budgets?: Partial<SpawnBudgets>;
}

/** Mutable observation state shared by every session of one run. */
class SpawnRun {
  readonly argv: string[];
  readonly token: string;
  readonly budgets: SpawnBudgets;
  children = 0;
  lastExit: { code: number | null; signal: string | null } = {
    code: null,
    signal: null,
  };
  transcript = '';
  transcriptTruncated = false;
  /** Children this run started, so `orphans` counts ours and not a neighbour's. */
  readonly own = new Set<ChildProcess>();
  /** Output held back until a newline, so a token cannot be split past the redactor. */
  private pending = '';
  readonly violations: string[] = [];
  readonly trips: string[] = [];
  /** The session the checks are currently talking to, for `diagnose`. */
  current: SpawnSession | null = null;

  constructor(argv: string[], token: string, budgets: SpawnBudgets) {
    this.argv = argv;
    this.token = token;
    this.budgets = budgets;
  }

  trip(name: string): void {
    if (!this.trips.includes(name)) this.trips.push(name);
  }

  violation(label: string): void {
    if (!this.violations.includes(label)) this.violations.push(label);
  }

  /**
   * Relay child output, redacted and capped. A stranger's process may print
   * anything, including its own token and a megabyte of it; neither belongs
   * in an operator's terminal.
   */
  record(chunk: string): void {
    if (this.transcriptTruncated) return;
    this.pending += chunk;
    // Redact whole lines only. A chunk boundary can fall in the middle of a
    // `wm_<64 hex>`, and a regex that ran on the halves would relay both.
    const nl = this.pending.lastIndexOf('\n');
    let cut = nl + 1;
    if (cut === 0 && this.pending.length > 4_096)
      cut = this.pending.length - TOKEN_TEXT_LENGTH;
    if (cut <= 0) return;
    const complete = this.pending.slice(0, cut);
    this.pending = this.pending.slice(cut);
    this.append(redactTokens(complete));
  }

  /** Flush whatever the child never terminated with a newline. */
  flush(): void {
    if (this.transcriptTruncated || this.pending.length === 0) return;
    const rest = this.pending;
    this.pending = '';
    this.append(redactTokens(rest));
  }

  private append(clean: string): void {
    const room = this.budgets.transcriptBytes - this.transcript.length;
    if (clean.length <= room) {
      this.transcript += clean;
      return;
    }
    this.transcript += `${clean.slice(0, Math.max(0, room))}\n[transcript truncated at ${String(this.budgets.transcriptBytes)} bytes]\n`;
    this.transcriptTruncated = true;
    this.trip('transcript-bytes');
  }

  diagnose(): string | undefined {
    return this.current?.death;
  }
}

/**
 * One check's worth of adapter: a listener, a child, and the bridge between
 * the child's socket and the mock gateway. Each check gets a fresh one, for
 * the same reason the in-process path builds a fresh closure: a check must
 * not pass because of state a previous check left behind.
 */
class SpawnSession {
  /** Set when the subject is known unusable. `undefined` means "still fine". */
  death: string | undefined;
  private server: WebSocketServer | null = null;
  private child: ChildProcess | null = null;
  private closing = false;
  private frames = 0;
  /**
   * The in-flight teardown, so that `stop()` (which is synchronous by the
   * `AdapterHandle` contract) and the run's own `finally` await the SAME
   * reap. Without this the fire-and-forget from `stop()` was still delivering
   * a SIGTERM when the run counted its orphans, and a child that had been
   * asked to die but had not finished dying was reported as a leak.
   */
  private teardown: Promise<void> | null = null;

  constructor(
    private readonly run_: SpawnRun,
    private readonly opts: SpawnedRunOptions,
  ) {}

  handle(ctx: AdapterStartContext): AdapterHandle {
    return {
      run: () => this.launch(ctx),
      stop: () => {
        this.closing = true;
        void this.shutdown();
      },
    };
  }

  private async launch(ctx: AdapterStartContext): Promise<number> {
    const server = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      path: AGENT_PATH,
    });
    this.server = server;
    try {
      await once(server, 'listening');
    } catch (error) {
      this.death = `listen failed: ${String(error)}`;
      return 127;
    }
    const address = server.address();
    if (address === null || typeof address === 'string') {
      this.death = 'listen failed: no ephemeral port';
      return 127;
    }
    const url = `ws://127.0.0.1:${String(address.port)}${AGENT_PATH}`;

    server.on('connection', (conn: WsSocket) => {
      // Paused synchronously, resumed once the bridge is listening. Between
      // the handshake and the first `await` a child can already have written
      // its `hello`, and a dropped greeting would read as a hung adapter.
      conn.pause();
      void this.bridge(ctx, conn);
    });

    const env = buildChildEnv({
      base: process.env,
      url,
      token: this.run_.token,
      adapterId: ctx.adapterId,
      maxAttempts: ctx.maxAttempts,
      ...(this.opts.env !== undefined ? { extra: this.opts.env } : {}),
    });

    return await new Promise<number>((resolve) => {
      let settled = false;
      const finish = (code: number): void => {
        if (settled) return;
        settled = true;
        resolve(code);
      };

      let child: ChildProcess;
      try {
        // No `shell`, ever: the kit runs commands people paste from READMEs.
        child = spawn(this.opts.cmd, [...(this.opts.args ?? [])], {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        this.death = `spawn failed: ${(error as Error).message}`;
        finish(127);
        return;
      }
      this.child = child;
      this.run_.children += 1;
      this.run_.own.add(child);
      REGISTRY.add(child);

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        this.run_.record(chunk);
      });
      child.stderr?.on('data', (chunk: string) => {
        this.run_.record(chunk);
      });

      child.on('error', (error: Error) => {
        // ENOENT lands here, not as a throw: a typo'd `--cmd` is a report the
        // author can read, not a stack trace from inside the kit.
        this.death = `spawn failed: ${error.message}`;
        REGISTRY.delete(child);
        finish(127);
      });

      child.on('exit', (code, signal) => {
        REGISTRY.delete(child);
        this.run_.lastExit = { code, signal };
        if (!this.closing && this.death === undefined && code !== 0)
          this.death = `crashed: the child exited before the kit closed it (exit ${String(code ?? signal)})`;
        finish(code ?? 1);
      });
    });
  }

  /**
   * Wire one child connection to one mock-gateway socket.
   *
   * Verbatim in both directions, so the mock stays the single judge and a
   * spawned adapter is held to exactly the in-process standard. The observer
   * hanging off the inbound side adds a label, never a verdict.
   */
  private async bridge(
    ctx: AdapterStartContext,
    conn: WsSocket,
  ): Promise<void> {
    let socket: TestkitSocket;
    try {
      socket = await ctx.ws(ctx.url, {
        onMessage: (raw: string) => {
          if (conn.readyState === WsSocket.OPEN) conn.send(raw);
        },
        onClose: (code: number) => {
          // Close codes outside the wire-legal range would throw inside the
          // mock's callback and be misread as an adapter crash.
          const safe =
            code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
          try {
            conn.close(safe);
          } catch {
            /* already closing */
          }
        },
      });
    } catch {
      conn.terminate();
      return;
    }

    conn.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      const raw = Buffer.isBuffer(data)
        ? data.toString('utf8')
        : Array.isArray(data)
          ? Buffer.concat(data).toString('utf8')
          : Buffer.from(data).toString('utf8');

      if (raw.length > this.run_.budgets.maxFrameBytes) {
        this.run_.trip('frame-too-large');
        return;
      }
      this.frames += 1;
      if (this.frames > this.run_.budgets.maxFrames) {
        this.run_.trip('frame-budget-exceeded');
        // A child past its frame budget is not a subject any more. Saying so
        // here is what keeps the remaining checks from each waiting out a
        // full wall-clock budget for an answer that will never be relayed.
        this.death ??= `budget: the child exceeded ${String(this.run_.budgets.maxFrames)} frames in one session`;
        return;
      }
      this.observe(raw);
      socket.send(raw);
    });

    conn.on('close', () => {
      socket.close(1000);
    });
    conn.on('error', () => {
      socket.close(1011);
    });
    conn.resume();
  }

  /** Label, do not judge. The mock gateway is still the only verdict. */
  private observe(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.run_.violation(classifyRefusal('envelope', undefined));
      return;
    }
    // `parseAgentFrame`, never `parseFrame`. `draft.request` is a real frame
    // type that an agent may not originate; the direction-blind parser would
    // accept a replay of it and the kit would launder the one violation it
    // exists to catch.
    const parsed = parseAgentFrame(json);
    if (parsed.ok) return;
    const type = (json as { type?: unknown } | null)?.type;
    this.run_.violation(classifyRefusal(parsed.error.kind, type));
  }

  /** Idempotent: every caller awaits the same teardown, never a second one. */
  shutdown(): Promise<void> {
    this.closing = true;
    this.teardown ??= this.tearDown();
    return this.teardown;
  }

  private async tearDown(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child !== null) await reap(child);
    const server = this.server;
    this.server = null;
    if (server !== null)
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        for (const client of server.clients) client.terminate();
      });
  }
}

/**
 * Run the six checks against a child process over a real socket.
 *
 * Same checks, same mock, same report; the only difference is that the
 * subject is a process. Nothing here throws for a broken child: a stranger's
 * adapter failing is the expected case and the report is the output.
 */
export async function runConformanceSpawned(
  opts: SpawnedRunOptions,
): Promise<ConformanceReport> {
  const budgets: SpawnBudgets = {
    ...DEFAULT_SPAWN_BUDGETS,
    ...opts.budgets,
    ...(opts.timeoutMs !== undefined ? { checkMs: opts.timeoutMs } : {}),
  };
  const token = mintAdapterToken();
  const argv = [opts.cmd, ...(opts.args ?? [])];
  const run = new SpawnRun(argv, token, budgets);
  const sessions: SpawnSession[] = [];

  const subject: AdapterUnderTest = {
    name: opts.name ?? basename(opts.cmd),
    start: (ctx) => {
      const session = new SpawnSession(run, opts);
      sessions.push(session);
      run.current = session;
      return session.handle(ctx);
    },
  };

  const env: CheckEnv = {
    ...DEFAULT_CHECK_ENV,
    token,
    waitMs: budgets.checkMs,
    settleTicks: SPAWN_SETTLE_TICKS,
    diagnose: () => run.diagnose(),
  };

  let report: ConformanceReport;
  try {
    report = await runConformance(subject, {
      env,
      transport: 'spawn',
      budgetMs: budgets.checkMs,
    });
  } finally {
    for (const session of sessions) await session.shutdown();
    run.flush();
  }

  const diagnostics: SpawnDiagnostics = {
    transport: 'ws',
    argv,
    children: run.children,
    // Ours, not the registry's: a neighbouring run in the same worker is not
    // this run's leak, and counting it would make the row lie in both
    // directions.
    orphans: [...run.own].filter((child) => REGISTRY.has(child)).length,
    lastExit: run.lastExit,
    transcript: redactTokens(run.transcript),
    protocolViolations: [...run.violations],
    budgetTrips: [...run.trips],
    budgets,
    tokenFingerprint: fingerprint(token),
  };
  return { ...report, spawn: diagnostics };
}
