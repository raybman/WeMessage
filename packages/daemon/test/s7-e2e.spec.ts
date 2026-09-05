/**
 * s7-execution Scenario 13 ★ CHECKPOINT — S7 end to end: one daemon, four
 * adapters, three subscribers, told as ONE narrative.
 *
 * Scenarios 1-12 each proved one mechanism against a surface they arranged
 * for themselves: a mock gateway, a fixture broadcast, a store seeded by
 * hand. This file removes every one of those props. There is one real
 * daemon listening on a real port, four real adapter processes-or-clients
 * speaking the real wire to it at the same time, three real subscribers
 * watching the same event stream, and an agent that reads
 * `skills/claude/SKILL.md` at run time and approves through the real CLI.
 *
 * **The spine of the whole story is a negative.** Four adapters draft. None
 * of them can send. The only thing that ever reaches the send backend is a
 * draft a person approved, through `dispatchApproved`, with an `Approval`
 * row behind it — and the last beat writes a raw `send` frame down a
 * genuinely authenticated adapter's own socket to show what happens to the
 * one that tries (`adapter.no-send-frame`, never `gate.denied`, C-6).
 *
 * **The story, in the order it happens.**
 *
 *   A. one daemon on port 0, four adapters connected at once: the Node
 *      reference adapter (`echo`), the Hermes HTTP-mode adapter against a
 *      fake Hermes on its own port 0, the Luna channel adapter, and the
 *      OpenClaw stdio shim over the committed example child — a REAL
 *      grandchild process, spawned by the production spawner.
 *   B. three subscribers attach before anything happens: the CLI's `watch
 *      --json` as a subprocess, a WS client, an unfiltered SSE client, and
 *      a filtered SSE client. All four open with the same greeting.
 *   C. two rules through the operator's own route: chat 1 to Hermes, chat 2
 *      to echo. Luna and OpenClaw are connected and routed by nothing.
 *   D. two inbounds, two drafts: the Hermes one preceded by real deltas,
 *      the echo one not, each attributed to its own adapter.
 *   E. WS/SSE parity under real adapter load — Sc 3's claim, proven against
 *      traffic no fixture generated — and the filtered stream as the
 *      unfiltered one minus the names it did not ask for.
 *   F. the settings API takes effect: a floor that refuses to be crossed,
 *      then a bound that moves, on all three streams, with `setting.changed`
 *      durable before the first frame leaves (§1.8).
 *   G. the scripted agent approves both drafts through the real CLI, on
 *      explicit human lines. Two sends, two `Approval` rows, two ledger
 *      rows, and not one byte on the wire before a person said so.
 *   H. autonomy is armed, and the bound that moved in F is the bound that
 *      bites: two autonomous sends where the shipped default allowed one,
 *      and the third clamped `rate-limited` — which a person then approves
 *      anyway, because a clamp withholds autonomy and never vetoes a human.
 *   I. Luna and OpenClaw idled correctly throughout: zero requests, zero
 *      frames beyond `hello`, healthy, and the OpenClaw child still alive.
 *   J. the record: `wemessage audit verify` exits 0, the chain verifies,
 *      and not one `adapter.*` row exists — nobody misbehaved.
 *   K. ...and then somebody does. A `send` frame down echo's own socket,
 *      after J has counted, so the taxonomy row is proven rather than
 *      assumed: `adapter.no-send-frame`, socket still open, backend
 *      untouched, and the chain still verifies.
 *   L. the meta-assertions over what the narrative actually observed.
 *
 * The static meta rows (row 8's surface pins and the single `SendBackend.
 * send` call site, row 9's public sweep) are separate `it`s: they are
 * properties of the TREE, not of the run, and a reviewer chasing a failure
 * should not have to read a 600-line narrative to find out that a route
 * count moved.
 *
 * **The Python leg (Sc 7's idiom, not a second one).** The plugin is a
 * fifth surface and it needs an interpreter, so it is declared through
 * `pyRow` exactly as `plugin-conformance.spec.ts` declares its rows: every
 * declared row lands in `ran[]` or `skipped[]`, an accounting row asserts
 * the union is the declared set exactly, it is all-or-nothing, and under
 * `CI=true` nothing may skip at all.
 *
 * **Flake discipline, because this file spawns more concurrent real
 * processes than anything else in the suite.** Port 0 everywhere, never a
 * fixed port. No sleep is ever a readiness signal: every wait is a
 * predicate over something observed. Every server, socket, adapter and
 * child is torn down in an `afterEach` that runs on failure, each teardown
 * independent so one throw cannot strand the next. The narrative carries an
 * explicit timeout rather than flaking at the 5 s default.
 *
 * Every handle is synthetic (`+1555…`), every host is loopback, every token
 * is minted by this daemon and never printed, and every transcript this
 * file collects is run through Sc 11's linter — the same one, imported, not
 * a fourth copy of it.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AuditEvent,
  Draft,
  GateContext,
  GateDecision,
  Handle,
  Message,
} from '@wemessage/core';
import {
  evaluateGate,
  parseChatGuid,
  readGateCounters,
  readGateSettings,
  readLoopCandidate,
  verifyChain,
  CAP_FLOOR,
  DEFAULT_RATE_CAPS,
  SETTING_CAP_CONTACT_PER_2MIN,
} from '@wemessage/core';
import { createInboundDispatch, toGatewayEvent } from '@wemessage/daemon';
import { FRAME_SPECS, GATEWAY_EVENT_NAMES } from '@wemessage/protocol';
import {
  createEchoAdapter,
  type EchoAdapter,
  type EchoSocketFactory,
} from '@wemessage/adapter-echo';
import {
  createHermesHttpAdapter,
  AGENT_FRAME_TYPES as HERMES_FRAME_TYPES,
  HERMES_BASE_URL_ENV,
  HERMES_TOKEN_ENV,
  type HermesHttpAdapter,
} from '@wemessage/adapter-hermes';
import {
  createLunaChannelAdapter,
  AGENT_FRAME_TYPES as LUNA_FRAME_TYPES,
  type LunaChannelAdapter,
  type LunaChannelHost,
  type LunaInboundMessage,
} from '@wemessage/adapter-luna';
import {
  createNodeChildSpawner,
  createStdioShimAdapter,
  AGENT_FRAME_TYPES as OPENCLAW_FRAME_TYPES,
  CHILD_TO_SHIM_KINDS,
  SHIM_TO_CHILD_KINDS,
  type ChildSpawner,
  type ShimChild,
  type StdioShimAdapter,
} from '@wemessage/adapter-openclaw';
import {
  lintTranscript,
  matchArgv,
  parseSkillBlocks,
  publicStringOffenders,
  type Finding,
  type SkillPolicy,
} from '../../cli/test/helpers/transcript-lint.js';
import {
  auditEvents,
  CHAT,
  HANDLE,
  T0,
  type Harness,
} from './helpers/draft-harness.js';
import {
  bootAgent,
  cleanupAgentHarness,
  type AgentHarness,
} from './helpers/agent-harness.js';
import { openSse, type SseStream } from './helpers/sse-client.js';
import {
  EMITTED_WS_EVENTS,
  PORT_IMPORTER_ALLOWLIST,
  ROUTE_TABLE,
  UNEMITTED_WS_EVENTS,
  WS_EVENT_VOCABULARY,
} from './transport-surface.snapshot.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const CLI_BIN = join(repoRoot, 'packages/cli/dist/bin.js');
const SKILL_PATH = join(repoRoot, 'skills/claude/SKILL.md');
const PLUGIN_DIR = join(repoRoot, 'packages/adapters/hermes/plugin');
const EXAMPLE_CHILD = join(
  repoRoot,
  'packages/adapter-testkit/examples/stdio-child.mjs',
);

/** Any ANSI escape — which is every colour there is, green included (C-9). */
const ANSI_RE = /\x1b\[/;
const SSE_PATH = '/v1/events/sse';
const WS_PATH = '/v1/events';

/** Chat 1 is the harness fixture's chat; chat 2 is added by beat A. */
const HANDLE_2: Handle = '+15557654321';
const CHAT_2 = `iMessage;-;${HANDLE_2}`;

const ECHO_ID = 'echo-1';
const HERMES_ID = 'hermes-http';
const LUNA_ID = 'luna-1';
const OPENCLAW_ID = 'openclaw-1';
const PYTHON_ID = 'hermes-plugin';

/** F-78's default: `send.autoGraceSeconds` inherits `send.undoGraceSeconds`. */
const PAST_GRACE_MS = 11_000;

/** The one credential shape a fake upstream needs. Not a real anything. */
const HERMES_KEY = 'hermes-test-key-not-a-real-credential';

/* ── teardown registry ─────────────────────────────────────────────────── */

const children: ChildProcess[] = [];
const transcripts: string[] = [];
const openSockets: WebSocket[] = [];
const openStreams: SseStream[] = [];
const echoes: EchoAdapter[] = [];
const stoppables: Array<() => Promise<unknown>> = [];
const upstreams: Array<() => Promise<void>> = [];

/** Never let one failing teardown strand the ones behind it. */
async function quietly(fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch {
    /* teardown is best-effort by design */
  }
}

afterEach(async () => {
  for (const echo of echoes.splice(0)) await quietly(() => echo.stop());
  for (const stop of stoppables.splice(0)) await quietly(stop);
  for (const child of children.splice(0))
    await quietly(() => child.kill('SIGKILL'));
  for (const stream of openStreams.splice(0))
    await quietly(() => stream.close());
  await Promise.all(
    openSockets.splice(0).map(
      (ws) =>
        new Promise<void>((resolve) => {
          if (ws.readyState === ws.CLOSED) return resolve();
          ws.on('close', () => resolve());
          ws.close();
        }),
    ),
  );
  await quietly(() => cleanupAgentHarness());
  for (const close of upstreams.splice(0)) await quietly(close);
  transcripts.length = 0;
});

/* ── the fake Hermes (Sc 8's, reduced to the one healthy shape) ────────── */

interface FakeHermes {
  baseUrl: string;
  runs(): number;
}

function sse(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * A Hermes that answers one run with two deltas and a completion carrying
 * the same words whole. Deliberately the SIMPLE shape: Sc 8 owns the
 * failure taxonomy, and re-proving it here would only mean this file fails
 * for reasons that have nothing to do with composition.
 */
async function fakeHermes(): Promise<FakeHermes> {
  const inputs = new Map<string, string>();
  const sockets = new Set<Socket>();
  let runs = 0;

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      const path = req.url ?? '';
      if (req.method === 'POST' && path.startsWith('/v1/runs')) {
        runs += 1;
        const runId = `run-${String(runs)}`;
        const parsed = JSON.parse(body === '' ? '{}' : body) as {
          input?: unknown;
        };
        inputs.set(runId, typeof parsed.input === 'string' ? parsed.input : '');
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ run_id: runId }));
        return;
      }
      const match = /^\/v1\/runs\/([^/]+)\/events/.exec(path);
      if (req.method === 'GET' && match !== null) {
        const runId = match[1] ?? '';
        const input = inputs.get(runId) ?? '';
        const reply = `re: ${input}`;
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        });
        res.write(
          sse({
            event: 'message.delta',
            run_id: runId,
            delta: reply.slice(0, 4),
          }),
        );
        res.write(
          sse({ event: 'message.delta', run_id: runId, delta: reply.slice(4) }),
        );
        res.write(
          sse({ event: 'run.completed', run_id: runId, output: reply }),
        );
        res.end();
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  };

  const server: Server = createServer(handle);
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  upstreams.push(async () => {
    for (const socket of [...sockets]) socket.destroy();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
  return { baseUrl: `http://127.0.0.1:${String(port)}`, runs: () => runs };
}

/* ── the adapter rig: one real socket per adapter, with a frame tap ────── */

interface Frame {
  type: string;
  payload?: Record<string, unknown>;
}

interface Rig {
  /** Gateway -> adapter, in arrival order. */
  inbound: Frame[];
  /** Adapter -> gateway, in send order (the tap is on the write, too). */
  outbound: Frame[];
  /** The live socket, so a beat can write a frame the adapter never would. */
  socket: WebSocket | null;
  factory: EchoSocketFactory;
}

/**
 * The factory every adapter is handed. It is a REAL `ws` client against the
 * REAL daemon; the only thing added is a tap on both directions, which is
 * what makes "these four adapters never sent anything but these frame
 * types" an observation rather than a claim about their source code.
 */
function rig(): Rig {
  const r: Rig = {
    inbound: [],
    outbound: [],
    socket: null,
    factory: (url, handlers) =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        openSockets.push(ws);
        r.socket = ws;
        ws.on('message', (data) => {
          const raw = String(data);
          r.inbound.push(JSON.parse(raw) as Frame);
          handlers.onMessage(raw);
        });
        ws.on('close', (code) => handlers.onClose(code));
        ws.on('error', reject);
        ws.on('open', () =>
          resolve({
            send: (data) => {
              r.outbound.push(JSON.parse(String(data)) as Frame);
              ws.send(data);
            },
            close: (code) => ws.close(code ?? 1000),
          }),
        );
      }),
  };
  return r;
}

function typesOf(frames: Frame[]): string[] {
  return [...new Set(frames.map((f) => f.type))].sort();
}

/* ── subscribers ───────────────────────────────────────────────────────── */

interface WsStream {
  /** Raw utf8 of every frame — bytes, so parity is a byte claim. */
  frames: string[];
  waitFor(n: number, label?: string): Promise<void>;
}

function httpUrl(h: AgentHarness): string {
  return h.baseUrl.replace(/^ws:/, 'http:');
}

async function openWs(h: AgentHarness, query = ''): Promise<WsStream> {
  const ws = new WebSocket(`${h.baseUrl}${WS_PATH}${query}`, {
    headers: h.headers,
  });
  openSockets.push(ws);
  const frames: string[] = [];
  ws.on('message', (data) => frames.push((data as Buffer).toString('utf8')));
  await new Promise<void>((resolve, reject) => {
    ws.on('error', reject);
    ws.on('open', () => resolve());
  });
  return {
    frames,
    waitFor: (n, label) =>
      poll(() => frames.length >= n, label ?? `${String(n)} ws frames`),
  };
}

/** A long-lived CLI subprocess whose stdout is read as it arrives. */
interface CliStream {
  lines: string[];
  waitFor(n: number, label?: string): Promise<void>;
  end(): Promise<void>;
}

function watchCli(h: AgentHarness): CliStream {
  const child = spawn(process.execPath, [CLI_BIN, 'watch', '--json'], {
    env: { ...process.env, ...cliEnv(h) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const lines: string[] = [];
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    const parts = stdout.split('\n');
    stdout = parts.pop() ?? '';
    for (const line of parts) if (line !== '') lines.push(line);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  return {
    lines,
    waitFor: (n, label) =>
      poll(() => lines.length >= n, label ?? `${String(n)} watch lines`),
    end: () =>
      new Promise<void>((resolve) => {
        child.on('close', () => {
          transcripts.push(lines.join('\n'), stderr);
          resolve();
        });
        child.kill('SIGTERM');
      }),
  };
}

/**
 * Poll a predicate off the event loop with a ceiling.
 *
 * `agent-harness`'s `waitUntil` spins 200 microtasks, which is right for a
 * fact the same process is about to produce and far too short for one that
 * has to cross a socket to a child process and back. This is the same
 * shape with a macrotask and a budget: still never a sleep-as-readiness,
 * because the budget is only ever the failure path.
 */
async function poll(
  pred: () => boolean,
  label: string,
  budgetMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`poll: ${label} never happened`);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 2);
    });
  }
}

/* ── daemon-side helpers (s6 Sc 14's, unchanged where they applied) ────── */

/** The daemon's `deliver` in miniature, composed exactly as `daemon.ts` does. */
function deliverer(h: AgentHarness): (message: Message) => Promise<void> {
  const dispatch = createInboundDispatch({
    store: h.store,
    clock: h.clockCtl.clock,
    sink: h.sink,
    reader: h.reader,
    transport: {
      isConnected: (id) => h.server.agentTransport?.isConnected(id) ?? false,
      sendTo: (id, frame) =>
        h.server.agentTransport?.sendTo(id, frame) ?? false,
    },
    issueRequest: (req) => h.server.agentRequests?.issue(req),
  });
  return async (message) => {
    h.store.insertInboundMessage(message);
    h.sink.broadcast(toGatewayEvent(message));
    await dispatch.emitWinner(message, h.store.listRules());
  };
}

let guidSeq = 0;

function inbound(
  h: AgentHarness,
  text: string,
  chatGuid = CHAT,
  handle: Handle = HANDLE,
): Message {
  guidSeq += 1;
  const at = h.clockCtl.clock.now();
  return {
    guid: `GUID-S7-${String(guidSeq)}`,
    sourceRowid: 7000 + guidSeq,
    chatGuid,
    handle,
    isFromMe: false,
    isGroup: false,
    // Lowercase, always: anything but 'imessage' is `sms-auto-forbidden`.
    service: 'imessage',
    kind: 'text',
    text,
    attachments: [],
    sentAt: at,
    receivedAt: at,
  };
}

function drafts(h: Harness): Draft[] {
  return h.store.listDrafts({});
}

function draftStates(h: Harness): Array<{ id: string; state: string }> {
  return h.store.db
    .prepare('SELECT id, state FROM drafts ORDER BY id')
    .all() as Array<{ id: string; state: string }>;
}

function events(h: Harness, type: string): AuditEvent[] {
  return auditEvents(h.store).filter((e) => e.type === type);
}

function gateInputs(h: Harness, draft: Draft): Omit<GateContext, 'settings'> {
  const now = h.clockCtl.clock.now();
  const rule = draft.ruleId === null ? null : h.store.getRule(draft.ruleId);
  const scheduleId = rule?.scheduleId ?? null;
  const parsed = parseChatGuid(draft.chatGuid);
  const source =
    draft.inboundGuid === null || draft.inboundGuid === undefined
      ? null
      : h.store.getInboundMessage(draft.inboundGuid);
  const handle: Handle = source?.handle ?? parsed.handle;
  return {
    now,
    rule,
    schedule: scheduleId === null ? null : h.store.getSchedule(scheduleId),
    contact: h.store.getContactPolicy(handle),
    message: {
      isGroup: parsed.isGroup,
      service: source?.service ?? parsed.service,
      handle,
      chatGuid: draft.chatGuid,
    },
    counters: readGateCounters(h.store, {
      now,
      handle,
      chatGuid: draft.chatGuid,
    }),
    candidate: readLoopCandidate(h.store, {
      chatGuid: draft.chatGuid,
      body: draft.body,
    }),
  };
}

/**
 * The gate exactly as `maybeAutoApprove` builds it, so a beat can NAME the
 * clamp that withheld autonomy. A clamp writes no audit row (§1.7), so the
 * only honest attribution is to ask the same pure function the same
 * question with the same inputs; the observable half — no `Approval`, no
 * `auto.approved`, still `pending` — is asserted alongside it every time.
 */
function decisionFor(h: Harness, draft: Draft): GateDecision {
  return evaluateGate({
    ...gateInputs(h, draft),
    settings: readGateSettings(h.store),
  });
}

function clampOf(h: Harness, draft: Draft): string {
  const decision = decisionFor(h, draft);
  if (!decision.allow) return `denied:${decision.reason}`;
  return decision.clampedBy ?? 'none';
}

function runCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      transcripts.push(stdout, stderr);
      resolve({ code, stdout, stderr });
    });
  });
}

function cliEnv(h: AgentHarness): Record<string, string> {
  return {
    WEMESSAGE_PORT: String(Number(new URL(h.baseUrl).port)),
    WEMESSAGE_TOKEN: h.server.token ?? '',
  };
}

async function register(
  h: AgentHarness,
  id: string,
  kind: string,
): Promise<string> {
  const res = await h.server.app.inject({
    method: 'POST',
    url: '/v1/adapters',
    headers: h.headers,
    payload: { id, kind, displayName: id },
  });
  expect(res.statusCode, `register ${id}`).toBe(201);
  return (res.json() as { token: string }).token;
}

/* ── the scripted agent (Sc 11's, driven against THIS daemon) ──────────── */

interface Turn {
  readonly human?: string;
  readonly argv: readonly string[];
}

type Refusal = 'never' | 'not-permitted' | 'needs-instruction';

interface Step {
  readonly argv: readonly string[];
  readonly refused: Refusal | null;
  readonly code: number | null;
  readonly stdout: string;
}

const policy = (): SkillPolicy =>
  parseSkillBlocks(readFileSync(SKILL_PATH, 'utf8'));

/**
 * An agent that obeys `skills/claude/SKILL.md` and nothing else, re-reading
 * it at run time. The three checks are the three blocks in the precedence
 * the document states; there is no fourth check and no exception. Sc 11
 * owns the proof that this is faithful to the document; here it is the
 * thing that puts a human's sentence in front of every approval.
 */
async function runAgent(
  h: AgentHarness,
  turns: readonly Turn[],
): Promise<{ steps: Step[]; transcript: string }> {
  const p = policy();
  const lines: string[] = [];
  const steps: Step[] = [];
  for (const turn of turns) {
    if (turn.human !== undefined) lines.push(`human: ${turn.human}`);
    const argv = [...turn.argv];
    const refused: Refusal | null = p.never.some((n) => matchArgv(n, argv))
      ? 'never'
      : !p.allowed.some((a) => matchArgv(a, argv))
        ? 'not-permitted'
        : p.approval.some((a) => matchArgv(a, argv)) && turn.human === undefined
          ? 'needs-instruction'
          : null;
    if (refused !== null) {
      lines.push(`agent: refusing \`${argv.join(' ')}\` (${refused})`);
      steps.push({ argv, refused, code: null, stdout: '' });
      continue;
    }
    lines.push(`$ wemessage ${argv.join(' ')}`);
    const res = await runCli(argv, cliEnv(h));
    for (const l of res.stdout.trimEnd().split('\n'))
      lines.push(l === '' ? '<' : `< ${l}`);
    for (const l of res.stderr.trimEnd().split('\n'))
      if (l !== '') lines.push(`! ${l}`);
    lines.push(`< exit ${String(res.code ?? -1)}`);
    steps.push({ argv, refused: null, code: res.code, stdout: res.stdout });
  }
  const transcript = lines.join('\n');
  transcripts.push(transcript);
  return { steps, transcript };
}

/* ── production-source walk (rows 8 and 9) ─────────────────────────────── */

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  'coverage',
  '.turbo',
  '__pycache__',
]);

function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else out.push(full);
    }
  };
  visit(root);
  return out;
}

/**
 * Every production TypeScript file, adapter packages included.
 *
 * `test/arch.spec.ts`'s own walk keys off `^(packages|apps)/[^/]+/src/`,
 * which by construction cannot see `packages/adapters/<name>/src`. That is
 * correct for the rows it guards and wrong for these: an adapter is exactly
 * the kind of package somebody would put a second send path in.
 */
function productionSources(): string[] {
  return walk(join(repoRoot, 'packages'))
    .map((abs) => relative(repoRoot, abs).replace(/\\/g, '/'))
    .filter((f) => /(^|\/)src\//.test(f))
    .filter((f) => /\.(ts|tsx|mts|cts)$/.test(f))
    .filter((f) => !f.endsWith('.d.ts'))
    .sort();
}

/**
 * Every place production code calls `.send(...)` on something it declared to
 * be a `SendBackend`.
 *
 * A grep for `type: 'send'` cannot see this, and that is the point: the
 * forbidden thing is not a frame name, it is REACHING the backend. So the
 * carriers are found by their type annotation (`x: SendBackend`, `x:
 * Pick<SendBackend, …>`, `class C implements SendBackend` for `this`) and
 * then their call sites are found by name. A second exported function that
 * takes a `SendBackend` and calls `.send` on it lands here whatever it is
 * called and whoever does or does not import it.
 */
function sendBackendCallSites(): string[] {
  const hits: string[] = [];
  for (const file of productionSources()) {
    const src = readFileSync(join(repoRoot, file), 'utf8');
    if (!src.includes('SendBackend')) continue;
    const carriers = new Set<string>();
    for (const m of src.matchAll(
      /(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[?!]?\s*:\s*(?:Pick<\s*)?SendBackend\b/g,
    ))
      carriers.add(m[1] ?? '');
    if (/\bimplements\s+SendBackend\b/.test(src)) carriers.add('this');
    for (const name of carriers) {
      if (name === '') continue;
      const call = new RegExp(
        `\\b${name.replace(/\$/g, '\\$')}\\s*\\.\\s*send\\s*\\(`,
        'g',
      );
      const lines = src.split('\n');
      lines.forEach((line, index) => {
        if (call.test(line)) hits.push(`${file}:${String(index + 1)}`);
        call.lastIndex = 0;
      });
    }
  }
  return [...new Set(hits)].sort();
}

/* ── the Python leg (Sc 7's idiom, imported wholesale) ─────────────────── */

interface PythonRuntime {
  source: 'env' | 'uv' | 'system';
  cmd: string;
  args: string[];
  label: string;
}

const PROBE = [
  'import sys, websockets;',
  'v = sys.version_info;',
  'ok = (3, 11) <= (v.major, v.minor) < (3, 14);',
  'print("PROBE", "ok" if ok else "version", v.major, v.minor, websockets.version.version);',
  'sys.exit(0 if ok else 3)',
].join(' ');

function probe(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, [...args, '-c', PROBE], {
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function hasUv(): boolean {
  try {
    execFileSync('uv', ['--version'], { stdio: 'ignore', timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * The ladder, in order, each rung probed before it is believed — byte for
 * byte Sc 7's, including `--no-project` (without it `uv` walks up to the
 * plugin's own `pyproject.toml` and tries to install the repo as a project).
 */
function resolvePython(): PythonRuntime | null {
  const fromEnv = process.env['WEMESSAGE_PYTHON'];
  if (fromEnv !== undefined && fromEnv !== '') {
    const detail = probe(fromEnv, []);
    if (detail !== null)
      return { source: 'env', cmd: fromEnv, args: [], label: detail };
  }
  if (hasUv()) {
    const args = [
      'run',
      '--quiet',
      '--no-project',
      '--python',
      '3.12',
      '--with-requirements',
      join(PLUGIN_DIR, 'requirements.txt'),
      'python',
    ];
    const detail = probe('uv', args);
    if (detail !== null)
      return { source: 'uv', cmd: 'uv', args, label: detail };
  }
  for (const candidate of ['python3.12', 'python3']) {
    const detail = probe(candidate, []);
    if (detail !== null)
      return { source: 'system', cmd: candidate, args: [], label: detail };
  }
  return null;
}

const PYTHON = resolvePython();
const CI = process.env['CI'] === 'true';

/** The rows that need an interpreter, named exactly as they are declared. */
const INTERPRETED_ROWS = [
  'row 10: the Python plugin joins the same daemon, drafts, and cannot send',
] as const;

const ran: string[] = [];
const skipped: string[] = [];

if (PYTHON === null)
  // Printed, not swallowed. A skip nobody sees is a pass with extra steps.
  console.warn(
    '[s7 Sc13] no usable Python: every interpreted row will SKIP. Wanted an ' +
      'interpreter in >=3.11,<3.14 that can import websockets; tried ' +
      '$WEMESSAGE_PYTHON, uv (--python 3.12), python3.12, python3.',
  );
else
  console.warn(
    `[s7 Sc13] interpreter: ${PYTHON.source} — ${PYTHON.cmd} — ${PYTHON.label}`,
  );

function pyRow(
  name: (typeof INTERPRETED_ROWS)[number],
  body: (py: PythonRuntime) => Promise<void> | void,
  timeout = 180_000,
): void {
  it(
    name,
    async (ctx) => {
      if (PYTHON === null) {
        skipped.push(name);
        ctx.skip();
        return;
      }
      ran.push(name);
      await body(PYTHON);
    },
    timeout,
  );
}

/* ═══════════════════════════════════════════════════════════════════════ */
/* the narrative                                                            */
/* ═══════════════════════════════════════════════════════════════════════ */

describe('s7 Scenario 13: one daemon, four adapters, three subscribers', () => {
  it('runs the S7 demo: four adapters draft, none can send, and one human approval reaches the wire', async () => {
    /* ---- A. one daemon, four adapters ------------------------------- */
    const h = await bootAgent({ rules: true, greeting: true, startIso: T0 });
    const before = new Set(readdirSync(h.dir));

    // Chat 2, so the two rules route to two conversations rather than
    // racing each other over one. The loopback backend verifies a send by
    // reading the row back out of THIS fixture, so the chat has to be a
    // real resolvable 1:1 chat, not a guid-shaped string.
    const handleRow = h.fixture.addHandle(HANDLE_2);
    h.fixture.addChat({ identifier: HANDLE_2, handleIds: [handleRow] });

    const upstream = await fakeHermes();

    const echoRig = rig();
    const echoToken = await register(h, ECHO_ID, 'echo');
    const echo = createEchoAdapter({
      url: `${h.baseUrl}/v1/agent`,
      token: echoToken,
      adapterId: ECHO_ID,
      ws: echoRig.factory,
      clock: h.clockCtl.clock,
      delay: () => Promise.resolve(),
    });
    echoes.push(echo);
    void echo.run();

    const hermesRig = rig();
    const hermesToken = await register(h, HERMES_ID, 'hermes');
    const hermes: HermesHttpAdapter = createHermesHttpAdapter({
      url: `${h.baseUrl}/v1/agent`,
      token: hermesToken,
      adapterId: HERMES_ID,
      ws: hermesRig.factory,
      clock: h.clockCtl.clock,
      delay: () => Promise.resolve(),
      env: {
        [HERMES_BASE_URL_ENV]: upstream.baseUrl,
        [HERMES_TOKEN_ENV]: HERMES_KEY,
      },
    });
    stoppables.push(() => Promise.resolve(hermes.stop()));
    void hermes.run();

    const lunaRig = rig();
    const lunaToken = await register(h, LUNA_ID, 'luna');
    const lunaHeard: LunaInboundMessage[] = [];
    const lunaHost: LunaChannelHost = {
      receive: (msg) => {
        lunaHeard.push(msg);
        return msg.channel.deliver({
          chatGuid: msg.chatGuid,
          text: `luna: ${msg.text}`,
        });
      },
    };
    const luna: LunaChannelAdapter = createLunaChannelAdapter({
      url: `${h.baseUrl}/v1/agent`,
      token: lunaToken,
      adapterId: LUNA_ID,
      ws: lunaRig.factory,
      host: lunaHost,
      clock: h.clockCtl.clock,
      delay: () => Promise.resolve(),
    });
    stoppables.push(() => luna.stop());
    void luna.run();

    // The OpenClaw child is a REAL grandchild process, spawned by the
    // production spawner. The wrapper adds nothing to the child's
    // behaviour; it records liveness so beat I can say "still alive" and
    // teardown can say "and then it was not" about the same process.
    const childLife = { alive: true, kills: 0 };
    const spawner: ChildSpawner = (command, args, env) => {
      const kid = createNodeChildSpawner()(command, args, env);
      const wrapped: ShimChild = {
        write: (line) => kid.write(line),
        onStdout: (cb) => kid.onStdout(cb),
        onExit: (cb) =>
          kid.onExit(() => {
            childLife.alive = false;
            cb();
          }),
        kill: () => {
          childLife.kills += 1;
          kid.kill();
        },
      };
      return wrapped;
    };
    const openclawRig = rig();
    const openclawToken = await register(h, OPENCLAW_ID, 'openclaw');
    const openclaw: StdioShimAdapter = createStdioShimAdapter({
      url: `${h.baseUrl}/v1/agent`,
      token: openclawToken,
      adapterId: OPENCLAW_ID,
      ws: openclawRig.factory,
      command: process.execPath,
      args: [EXAMPLE_CHILD],
      spawn: spawner,
      clock: h.clockCtl.clock,
      delay: () => Promise.resolve(),
    });
    stoppables.push(() => openclaw.stop());
    void openclaw.run();

    const connected = (id: string): boolean =>
      h.store.getAdapter(id)?.health === 'connected';
    await poll(
      () =>
        connected(ECHO_ID) &&
        connected(HERMES_ID) &&
        connected(LUNA_ID) &&
        connected(OPENCLAW_ID),
      'all four adapters connected',
    );
    expect(h.server.agentTransport?.openSessions()).toBe(4);
    expect(childLife.alive).toBe(true);

    /* ---- B. three subscribers, before anything happens --------------- */
    const watch = watchCli(h);
    await watch.waitFor(1, 'the CLI watcher greeting');
    const ws = await openWs(h);
    await ws.waitFor(1, 'the WS greeting');
    const all = await openSse(httpUrl(h), SSE_PATH, {
      headers: h.headers,
      waitMs: 20_000,
    });
    openStreams.push(all);
    await all.waitForEvents(1, 'the unfiltered SSE greeting');
    const some = await openSse(
      httpUrl(h),
      `${SSE_PATH}?events=draft.created,draft.sent,toggle.changed`,
      { headers: h.headers, waitMs: 20_000 },
    );
    openStreams.push(some);
    await some.waitForEvents(1, 'the filtered SSE greeting');

    // All four transports open with the SAME frame, and it is the same
    // bytes on the two that can be compared byte for byte.
    expect(all.events[0]?.event).toBe('connection.state');
    expect(some.events[0]?.event).toBe('connection.state');
    expect(all.events[0]?.data).toBe(ws.frames[0]);
    expect(
      (JSON.parse(watch.lines[0] ?? '{}') as { event?: string }).event,
    ).toBe('connection.state');

    /* ---- C. two rules, through the operator's own route -------------- */
    const ruleFor = async (
      name: string,
      handle: Handle,
      adapterId: string,
    ): Promise<string> => {
      const res = await h.server.app.inject({
        method: 'POST',
        url: '/v1/rules',
        headers: h.headers,
        payload: {
          name,
          matcher: { kind: 'contact', handles: [handle] },
          adapterId,
          respondMode: 'draft-only',
          outsideWindow: 'draft-only',
          draftTtlMinutes: 480,
        },
      });
      expect(res.statusCode, `rule ${name}`).toBe(201);
      return (res.json() as { rule: { id: string } }).rule.id;
    };
    const ruleA = await ruleFor('chat one to hermes', HANDLE, HERMES_ID);
    const ruleB = await ruleFor('chat two to echo', HANDLE_2, ECHO_ID);
    expect(h.store.listRules()).toHaveLength(2);

    // The deny-all default (§2.4.3) is not a technicality to route around:
    // a rule alone drafts nothing, because an unknown contact is a denied
    // contact. Both handles are opened to DRAFTING and neither to
    // autonomy, which is the posture the next four beats are about.
    const contactMode = async (handle: Handle, mode: string): Promise<void> => {
      const res = await h.server.app.inject({
        method: 'PUT',
        url: `/v1/contacts/${encodeURIComponent(handle)}`,
        headers: h.headers,
        payload: { mode },
      });
      expect(res.statusCode, `contact ${handle} -> ${mode}`).toBe(200);
    };
    await contactMode(HANDLE, 'draft-only');
    await contactMode(HANDLE_2, 'draft-only');

    const deliver = deliverer(h);

    /* ---- D. two inbounds, two drafts -------------------------------- */
    await deliver(inbound(h, 'is the roof fixed?'));
    await poll(() => drafts(h).length === 1, 'the Hermes draft');
    await deliver(inbound(h, 'dinner at seven?', CHAT_2, HANDLE_2));
    await poll(() => drafts(h).length === 2, 'the echo draft');

    const created = events(h, 'draft.created') as unknown as Array<{
      draftId: string;
      draft: { adapterId: string | null };
    }>;
    expect(created).toHaveLength(2);
    expect(created.map((e) => e.draft.adapterId)).toEqual([HERMES_ID, ECHO_ID]);

    const hermesDraft = drafts(h).find((d) => d.adapterId === HERMES_ID);
    const echoDraft = drafts(h).find((d) => d.adapterId === ECHO_ID);
    expect(hermesDraft?.body).toBe('re: is the roof fixed?');
    expect(echoDraft?.body).toBe('echo: dinner at seven?');
    expect(hermesDraft?.ruleId).toBe(ruleA);
    expect(echoDraft?.ruleId).toBe(ruleB);
    expect(upstream.runs()).toBe(1);

    // The Hermes leg streamed; the echo leg did not. And the deltas
    // arrived BEFORE the draft they were a preview of, which is the whole
    // reason a preview exists.
    const names = (): string[] =>
      ws.frames.map((f) => (JSON.parse(f) as { event: string }).event);
    await poll(
      () => names().filter((n) => n === 'draft.delta').length === 2,
      'two deltas on the operator bus',
    );
    expect(names().indexOf('draft.delta')).toBeLessThan(
      names().indexOf('draft.created'),
    );
    expect(typesOf(hermesRig.outbound)).toEqual([
      'draft.delta',
      'draft.submit',
      'hello',
    ]);
    expect(typesOf(echoRig.outbound)).toEqual(['draft.submit', 'hello']);

    // Nothing has been sent. Nothing has even been approved.
    expect(h.backend.callCount()).toBe(0);
    expect(drafts(h).every((d) => d.state === 'pending')).toBe(true);

    /* ---- E. parity, under real adapter load -------------------------- */
    await all.waitForEvents(ws.frames.length, 'SSE caught up with WS');
    const wsFrames = [...ws.frames];
    const sseData = all.events.slice(0, wsFrames.length).map((e) => e.data);
    // Byte for byte, event for event: Sc 3's claim, now under traffic four
    // real adapters produced rather than a fixture broadcast.
    expect(sseData).toEqual(wsFrames);

    // The filtered stream is the unfiltered one minus the names it did not
    // ask for — plus its own greeting, which is always delivered.
    const wanted = new Set(['draft.created', 'draft.sent', 'toggle.changed']);
    const expectFiltered = (): string[] => [
      'connection.state',
      ...ws.frames
        .slice(1)
        .map((f) => (JSON.parse(f) as { event: string }).event)
        .filter((n) => wanted.has(n)),
    ];
    await poll(
      () => some.events.length >= expectFiltered().length,
      'the filtered SSE caught up',
    );
    expect(some.events.map((e) => e.event)).toEqual(expectFiltered());

    // And the third subscriber saw the same story in the same order.
    await watch.waitFor(ws.frames.length, 'the CLI watcher caught up');
    expect(
      watch.lines
        .slice(0, ws.frames.length)
        .map((l) => (JSON.parse(l) as { event: string }).event),
    ).toEqual(names());

    /* ---- F. the settings API takes effect ---------------------------- */
    const auditLen = (): number => auditEvents(h.store).length;
    const beforeFloor = auditLen();
    const beforeBroadcasts = h.broadcasts.length;
    const floor = await h.server.app.inject({
      method: 'PATCH',
      url: '/v1/settings',
      headers: h.headers,
      payload: { [SETTING_CAP_CONTACT_PER_2MIN]: CAP_FLOOR - 1 },
    });
    expect(floor.statusCode).toBe(400);
    expect(floor.json()).toEqual({
      error: 'below-floor',
      key: SETTING_CAP_CONTACT_PER_2MIN,
      floor: CAP_FLOOR,
    });
    // A refusal writes nothing and says nothing: all-or-nothing means the
    // stream never learns about a change that did not happen.
    expect(auditLen()).toBe(beforeFloor);
    expect(h.broadcasts).toHaveLength(beforeBroadcasts);

    const raised = await h.server.app.inject({
      method: 'PATCH',
      url: '/v1/settings',
      headers: h.headers,
      payload: { [SETTING_CAP_CONTACT_PER_2MIN]: 2 },
    });
    expect(raised.statusCode).toBe(200);
    expect((raised.json() as { changed: string[] }).changed).toEqual([
      SETTING_CAP_CONTACT_PER_2MIN,
    ]);
    expect(events(h, 'setting.changed')).toEqual([
      {
        type: 'setting.changed',
        key: SETTING_CAP_CONTACT_PER_2MIN,
        from: DEFAULT_RATE_CAPS.contactPer2Min,
        to: 2,
      },
    ]);

    // §1.8: the row was durable BEFORE the frame left. The witness records
    // the audit log as it stood at each broadcast, which is the only way
    // to tell "appended then broadcast" from the other order.
    const toggleBroadcast = h.broadcasts.find(
      (b) => (b.frame as { event?: string }).event === 'toggle.changed',
    );
    expect(toggleBroadcast?.auditAtBroadcast).toContain('setting.changed');

    // It reached all three subscribers, in the same position in each.
    await poll(
      () => names().includes('toggle.changed'),
      'toggle.changed on the WS',
    );
    await all.waitForEvents(ws.frames.length, 'toggle.changed on the SSE');
    await watch.waitFor(ws.frames.length, 'toggle.changed on the CLI');
    const at = names().lastIndexOf('toggle.changed');
    expect(all.events[at]?.event).toBe('toggle.changed');
    expect(all.events[at]?.data).toBe(ws.frames[at]);
    expect(
      (JSON.parse(watch.lines[at] ?? '{}') as { event?: string }).event,
    ).toBe('toggle.changed');
    expect(some.events.at(-1)?.event).toBe('toggle.changed');

    /* ---- G. approve-before-send, through the real CLI ---------------- */
    const first = hermesDraft as Draft;
    const second = echoDraft as Draft;
    const agent = await runAgent(h, [
      { human: 'anything waiting on me?', argv: ['status'] },
      { argv: ['drafts', 'list'] },
      { argv: ['drafts', 'show', first.id] },
      // The one the document refuses without a human sentence, proven
      // here rather than asserted: same verb, same daemon, no human.
      { argv: ['drafts', 'approve', first.id] },
      { human: `approve ${first.id}`, argv: ['drafts', 'approve', first.id] },
      {
        human: `approve ${second.id} too`,
        argv: ['drafts', 'approve', second.id],
      },
    ]);
    expect(agent.steps.map((s) => s.refused)).toEqual([
      null,
      null,
      null,
      'needs-instruction',
      null,
      null,
    ]);
    for (const step of agent.steps)
      if (step.refused === null) expect(step.code, step.argv.join(' ')).toBe(0);

    // Approved by a person, with a real grace ahead of them, and NOTHING
    // on the wire yet.
    expect(h.backend.callCount()).toBe(0);
    h.clockCtl.advance(PAST_GRACE_MS);
    await h.scheduler.tick();
    await poll(
      () => h.backend.callCount() === 2,
      'both human approvals reached the backend',
    );
    expect(h.store.getDraft(first.id)?.state).toBe('sent');
    expect(h.store.getDraft(second.id)?.state).toBe('sent');
    expect(h.store.listApprovals(first.id)).toHaveLength(1);
    expect(h.store.listApprovals(second.id)).toHaveLength(1);
    expect(events(h, 'auto.approved')).toHaveLength(0);

    /* ---- H. autonomy armed, and the moved bound bites ---------------- */
    await contactMode(HANDLE, 'auto');
    expect(
      (
        await h.server.app.inject({
          method: 'POST',
          url: '/v1/toggles/global-mode',
          headers: h.headers,
          payload: { mode: 'auto' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await h.server.app.inject({
          method: 'PATCH',
          url: `/v1/rules/${ruleA}`,
          headers: h.headers,
          payload: { respondMode: 'auto' },
        })
      ).statusCode,
    ).toBe(200);

    const autoSend = async (text: string): Promise<Draft> => {
      const had = drafts(h).length;
      await deliver(inbound(h, text));
      await poll(() => drafts(h).length === had + 1, `draft for "${text}"`);
      const draft = drafts(h).at(-1) as Draft;
      await poll(
        () => h.store.getDraft(draft.id)?.state === 'approved',
        `auto approval for "${text}"`,
      );
      h.clockCtl.advance(PAST_GRACE_MS);
      await h.scheduler.tick();
      await poll(
        () => h.store.getDraft(draft.id)?.state === 'sent',
        `the send for "${text}"`,
      );
      return draft;
    };

    await autoSend('and the gutters?');
    await autoSend('and the porch light?');
    expect(h.backend.callCount()).toBe(4);

    // THE BITE, observed rather than argued. `overRateCap` compares with
    // `>=`, so under the SHIPPED default of one the second autonomous send
    // to this contact inside the two-minute window could not have been
    // decided at all. There are two of them, inside one window, and the
    // only thing that differs between the shipped daemon and this one is
    // the operator's PATCH in beat F.
    expect(DEFAULT_RATE_CAPS.contactPer2Min).toBe(1);
    expect(readGateSettings(h.store).caps?.contactPer2Min).toBe(2);
    expect(
      readGateCounters(h.store, {
        now: h.clockCtl.clock.now(),
        handle: HANDLE,
        chatGuid: CHAT,
      }).contactAutoLast2Min,
    ).toBe(2);
    expect(events(h, 'auto.approved')).toHaveLength(2);

    // ...and the new bound is a bound, not an absence of one.
    await deliver(inbound(h, 'and the fence?'));
    await poll(() => drafts(h).length === 1, 'the clamped draft');
    const clamped = drafts(h)[0] as Draft;
    expect(clamped.state).toBe('pending');
    expect(clampOf(h, clamped)).toBe('rate-limited');
    expect(h.store.listApprovals(clamped.id)).toEqual([]);
    expect(events(h, 'auto.approved')).toHaveLength(2);

    // A clamp withholds autonomy. It does not veto a person.
    const rescue = await runAgent(h, [
      {
        human: `approve ${clamped.id}, I will vouch for it`,
        argv: ['drafts', 'approve', clamped.id],
      },
    ]);
    expect(rescue.steps[0]?.refused).toBeNull();
    expect(rescue.steps[0]?.code).toBe(0);
    h.clockCtl.advance(PAST_GRACE_MS);
    await h.scheduler.tick();
    await poll(
      () => h.store.getDraft(clamped.id)?.state === 'sent',
      'the human rescue reached the backend',
    );
    expect(h.backend.callCount()).toBe(5);

    /* ---- I. the two that were routed by nothing ---------------------- */
    expect(lunaHeard).toEqual([]);
    expect(
      typesOf(lunaRig.inbound).filter((t) => t === 'draft.request'),
    ).toEqual([]);
    expect(
      typesOf(openclawRig.inbound).filter((t) => t === 'draft.request'),
    ).toEqual([]);
    expect(typesOf(lunaRig.outbound)).toEqual(['hello']);
    expect(typesOf(openclawRig.outbound)).toEqual(['hello']);
    expect(luna.state()).toBe('connected');
    expect(openclaw.health()).toBe('healthy');
    expect(h.store.getAdapter(LUNA_ID)?.health).toBe('connected');
    expect(h.store.getAdapter(OPENCLAW_ID)?.health).toBe('connected');
    // One child, spawned once, still alive, and never asked to answer.
    expect(openclaw.stats()['child.spawns']).toBe(1);
    expect(openclaw.stats()['child.lines.in']).toBe(0);
    expect(openclaw.refusals()).toEqual([]);
    expect(childLife.alive).toBe(true);
    expect(childLife.kills).toBe(0);

    /* ---- J. the record, before anybody misbehaves -------------------- */
    const verify = await runCli(['audit', 'verify', '--json'], cliEnv(h));
    expect(verify.code).toBe(0);
    expect(JSON.parse(verify.stdout) as { ok: boolean }).toMatchObject({
      ok: true,
    });
    expect(verifyChain(h.store.readAuditRows(0, 20_000))).toMatchObject({
      ok: true,
    });

    // Not one adapter row of any kind: four adapters, five conversations
    // worth of traffic, and nobody reached for anything they were not
    // given. This is counted BEFORE beat K deliberately breaks it.
    const adapterRows = auditEvents(h.store).filter((e) =>
      /^adapter\.(no-send-frame|protocol-violation|auth-failed)$/.test(e.type),
    );
    expect(adapterRows).toEqual([]);
    expect(events(h, 'gate.denied')).toEqual([]);

    /* ---- K. ...and then somebody tries ------------------------------- */
    // Not a forged socket: echo's OWN live, authenticated session, which
    // is the only version of this that proves anything. An adapter that
    // has already been trusted with a draft asks for a send.
    const impostor = echoRig.socket as WebSocket;
    impostor.send(
      JSON.stringify({
        v: 1,
        id: `01${'F'.repeat(24)}`,
        type: 'send',
        ts: h.clockCtl.clock.now(),
        payload: { chatGuid: CHAT, body: 'let me out' },
      }),
    );
    await poll(
      () => events(h, 'adapter.no-send-frame').length === 1,
      'the send frame was refused',
    );
    expect(events(h, 'adapter.no-send-frame')).toEqual([
      {
        type: 'adapter.no-send-frame',
        adapterId: ECHO_ID,
        frameType: 'send',
      },
    ]);
    // C-6: never `gate.denied`, and never a protocol violation either —
    // this is evidence, not a hang-up.
    expect(events(h, 'gate.denied')).toEqual([]);
    expect(events(h, 'adapter.protocol-violation')).toEqual([]);
    expect(impostor.readyState).toBe(impostor.OPEN);
    expect(h.store.getAdapter(ECHO_ID)?.health).toBe('connected');
    expect(h.backend.callCount()).toBe(5);
    expect(verifyChain(h.store.readAuditRows(0, 20_000))).toMatchObject({
      ok: true,
    });

    /* ---- L. what the narrative observed ------------------------------ */
    await watch.end();
    /**
     * The exact vocabulary this story put on the bus — pinned rather than
     * bounded, because "at most seventeen" would pass for a daemon that
     * broadcast nothing at all.
     *
     * `draft.sent` is subscribed to by the filtered stream above and is
     * deliberately NOT in this list. On the scheduler path the send is
     * recorded in the AUDIT log (`draft.sent`, asserted below alongside the
     * ledger) and the only bus broadcast of that name comes from the human
     * `POST /v1/send` route. That is a pre-S7 shape, unchanged by this
     * slice; the filter admitting a name it never sees is exactly what a
     * subscriber asking for future events should get.
     */
    const seen = [...new Set(names())].sort();
    expect(seen).toEqual([
      'arming.changed',
      'connection.state',
      'draft.approved',
      'draft.created',
      'draft.delta',
      'message.received',
      'rule.matched',
      'toggle.changed',
    ]);
    for (const name of seen) expect(GATEWAY_EVENT_NAMES).toContain(name);
    for (const name of seen) expect(WS_EVENT_VOCABULARY).toContain(name);
    expect(events(h, 'draft.sent')).toHaveLength(5);

    // INV-2 over the whole run: one ledger row per sent draft, first
    // attempt, loopback, and one approval behind each of them.
    const sent = draftStates(h).filter((d) => d.state === 'sent');
    expect(sent).toHaveLength(5);
    const ledger = h.store.db
      .prepare('SELECT draft_id, attempt, backend FROM send_ledger')
      .all() as Array<{ draft_id: string; attempt: number; backend: string }>;
    expect(ledger).toHaveLength(5);
    for (const draft of sent) {
      expect(h.store.listApprovals(draft.id)).toHaveLength(1);
      expect(ledger.filter((r) => r.draft_id === draft.id)).toEqual([
        { draft_id: draft.id, attempt: 1, backend: 'loopback' },
      ]);
    }
    expect(
      h.backend
        .calls()
        .map((c) => c.chatGuid)
        .sort(),
    ).toEqual([CHAT, CHAT, CHAT, CHAT, CHAT_2].sort());
    expect(events(h, 'draft.illegal-transition')).toHaveLength(0);

    // Every frame the four adapters ever sent, in one set. `send` is not
    // in it, and neither is anything else the wire does not have.
    const spoken = typesOf([
      ...echoRig.outbound,
      ...hermesRig.outbound,
      ...lunaRig.outbound,
      ...openclawRig.outbound,
    ]);
    expect(spoken).toEqual(['draft.delta', 'draft.submit', 'hello']);
    for (const type of spoken) expect(Object.keys(FRAME_SPECS)).toContain(type);

    // Nothing green, nothing coloured, no token, no operator, on any
    // surface — asked of Sc 11's linter, not of a fourth copy of it.
    const p = policy();
    const findings: Finding[] = [];
    expect(transcripts.length).toBeGreaterThan(0);
    for (const text of transcripts) {
      expect(ANSI_RE.test(text)).toBe(false);
      findings.push(...lintTranscript(text, p));
    }
    expect(findings).toEqual([]);
    for (const token of [echoToken, hermesToken, lunaToken, openclawToken])
      for (const text of transcripts) expect(text).not.toContain(token);

    // Zero real network, zero writes outside the temp dir.
    for (const socket of openSockets) expect(socket.url).toContain('127.0.0.1');
    const added = readdirSync(h.dir).filter((e) => !before.has(e));
    expect(added.filter((e) => !/-(wal|shm|journal)$/.test(e))).toEqual([]);
  }, 180_000);
});

/* ═══════════════════════════════════════════════════════════════════════ */
/* the Python leg                                                           */
/* ═══════════════════════════════════════════════════════════════════════ */

describe('s7 Scenario 13: the fifth surface needs an interpreter', () => {
  pyRow(INTERPRETED_ROWS[0], async (py) => {
    const h = await bootAgent({ rules: true, greeting: true, startIso: T0 });
    const token = await register(h, PYTHON_ID, 'hermes');
    const child = spawn(
      py.cmd,
      [...py.args, join(PLUGIN_DIR, 'wemessage_wire.py'), '--standalone'],
      {
        env: {
          ...process.env,
          WEMESSAGE_GATEWAY_URL: `${h.baseUrl}/v1/agent`,
          WEMESSAGE_ADAPTER_ID: PYTHON_ID,
          WEMESSAGE_ADAPTER_TOKEN: token,
          WEMESSAGE_MAX_ATTEMPTS: '3',
          WEMESSAGE_BACKOFF_MS: '10',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    children.push(child);
    let chatter = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (chatter += c));
    child.stderr.on('data', (c: string) => (chatter += c));

    await poll(
      () => h.store.getAdapter(PYTHON_ID)?.health === 'connected',
      'the Python adapter connected',
      60_000,
    );

    const rule = await h.server.app.inject({
      method: 'POST',
      url: '/v1/rules',
      headers: h.headers,
      payload: {
        name: 'chat one to the plugin',
        matcher: { kind: 'contact', handles: [HANDLE] },
        adapterId: PYTHON_ID,
        respondMode: 'draft-only',
        outsideWindow: 'draft-only',
        draftTtlMinutes: 480,
      },
    });
    expect(rule.statusCode).toBe(201);
    expect(
      (
        await h.server.app.inject({
          method: 'PUT',
          url: `/v1/contacts/${encodeURIComponent(HANDLE)}`,
          headers: h.headers,
          payload: { mode: 'draft-only' },
        })
      ).statusCode,
    ).toBe(200);

    await deliverer(h)(inbound(h, 'is the roof fixed?'));
    await poll(() => drafts(h).length === 1, 'the Python draft', 60_000);
    const draft = drafts(h)[0] as Draft;
    expect(draft.adapterId).toBe(PYTHON_ID);
    expect(draft.body).toBe('Got it: is the roof fixed?');
    expect(draft.state).toBe('pending');

    // It drafted, and it cannot send: no backend call, no send frame, and
    // no row saying it reached for one.
    expect(h.backend.callCount()).toBe(0);
    expect(events(h, 'adapter.no-send-frame')).toEqual([]);
    expect(events(h, 'adapter.protocol-violation')).toEqual([]);

    // The token travels by environment. `ps(1)` shows argv to every user on
    // the box, and a `uv run …` line is about as public as argv gets.
    expect(child.spawnargs.join(' ')).not.toContain(token);
    expect(chatter).not.toContain(token);
    expect(publicStringOffenders(chatter)).toEqual([]);
  });

  it('row 11: every interpreted row ran, or every one of them skipped and said why', () => {
    // The enumeration is asserted first. A row that is deleted or renamed
    // must not be able to make the accounting below vacuously true.
    expect(INTERPRETED_ROWS).toHaveLength(1);
    expect([...ran, ...skipped].sort()).toEqual([...INTERPRETED_ROWS].sort());

    if (CI) {
      // F-88 / C-11: on CI the interpreter is pinned by ci-python.yml, so a
      // skip here means the pin did not take and the green tick would be a
      // lie about what was verified.
      expect(PYTHON).not.toBeNull();
      expect(skipped).toEqual([]);
      return;
    }
    if (PYTHON === null) {
      expect(skipped.sort()).toEqual([...INTERPRETED_ROWS].sort());
      expect(ran).toEqual([]);
      return;
    }
    expect(skipped).toEqual([]);
    expect(PYTHON.label).toMatch(/^PROBE ok 3 (?:11|12|13) /);
  });
});

/* ═══════════════════════════════════════════════════════════════════════ */
/* the meta rows: properties of the tree, not of the run                    */
/* ═══════════════════════════════════════════════════════════════════════ */

describe('s7 Scenario 13: the surface did not move', () => {
  it('row 8: the wire has nine frames, none of them sends, and the backend has exactly one call site', () => {
    // The surface pins. Routes and importers unchanged since ratchet #22;
    // the vocabulary moved 17 -> 21 at ratchet #23 (s8 Sc 2) and the emitted
    // set deliberately did NOT, because Sc 2 declares the four owed
    // `draft.*` lifecycle names and Sc 3 wires the emit sites. The gap is
    // enumerated in `UNEMITTED_WS_EVENTS` and partitioned in
    // `transport-surface.ratchet.spec.ts`; this row only records the
    // arithmetic so an S7 reader sees where the numbers went.
    expect(ROUTE_TABLE).toHaveLength(67);
    expect(WS_EVENT_VOCABULARY).toHaveLength(21);
    expect(EMITTED_WS_EVENTS).toHaveLength(17);
    expect(UNEMITTED_WS_EVENTS).toHaveLength(4);
    expect(PORT_IMPORTER_ALLOWLIST).toHaveLength(15);
    expect(Object.keys(FRAME_SPECS)).toHaveLength(9);
    expect(Object.keys(FRAME_SPECS)).not.toContain('send');

    // No production file declares a send frame...
    const declaring = productionSources().filter((f) =>
      /type:\s*'send'/.test(readFileSync(join(repoRoot, f), 'utf8')),
    );
    expect(declaring).toEqual([]);

    // ...and no adapter package's own agent-frame set names one, which is
    // the same claim made where an adapter author would look for it.
    for (const set of [
      HERMES_FRAME_TYPES,
      LUNA_FRAME_TYPES,
      OPENCLAW_FRAME_TYPES,
    ]) {
      expect(set).not.toContain('send');
      for (const type of set) expect(Object.keys(FRAME_SPECS)).toContain(type);
    }
    // Nor does the OpenClaw child protocol, on either side of the pipe.
    for (const kind of [...SHIM_TO_CHILD_KINDS, ...CHILD_TO_SHIM_KINDS])
      expect(kind).not.toBe('send');

    /**
     * And the one that a frame-name grep structurally cannot catch: the
     * SendBackend itself. Exactly one call site, in the dispatcher, which is
     * what makes `dispatchApproved` the only door rather than merely the
     * usual one. A second exported function that takes a `SendBackend` and
     * calls it would build, would pass the allowlist, would never appear in
     * a `type: 'send'` grep, and fails right here.
     */
    expect(sendBackendCallSites()).toEqual([
      'packages/core/src/sending/dispatcher.ts:454',
    ]);
  });

  it('row 9: the public surface says nothing about who runs it', () => {
    const groups: Record<string, string[]> = {
      skills: walk(join(repoRoot, 'skills')),
      examples: walk(join(repoRoot, 'packages/adapter-testkit/examples')),
      plugin: walk(PLUGIN_DIR),
      readmes: walk(join(repoRoot, 'packages')).filter((f) =>
        /README\.md$/.test(f),
      ),
    };
    const offenders: string[] = [];
    for (const [group, files] of Object.entries(groups)) {
      // Non-empty, or the sweep below is a sweep over nothing.
      expect(files.length, `${group} is empty`).toBeGreaterThan(0);
      for (const file of files) {
        if (/\.(png|ico|svg|db|bin|blob|pyc)$/.test(file)) continue;
        const rel = relative(repoRoot, file).replace(/\\/g, '/');
        for (const o of publicStringOffenders(readFileSync(file, 'utf8')))
          offenders.push(`${rel}: ${o.detail}`);
      }
    }
    expect(offenders.sort()).toEqual([]);
  });
});
