/**
 * s7-execution Scenario 10 — the generic NDJSON-over-stdio shim.
 *
 * The shim speaks the WeMessage wire on one side and a documented NDJSON
 * child protocol on the other. It is named after OpenClaw because OpenClaw is
 * the first agent we want behind it, but nothing in `src/` mentions OpenClaw,
 * imports OpenClaw, or has ever been run against one: the child contract is
 * OURS, it is a public API a stranger implements in any language, and the
 * OpenClaw binding is one labelled-unverified paragraph in the README (F-92).
 *
 * That generality is the reason this file is long. A contract a stranger
 * implements is only as good as its ugly cases, so the framing rows below
 * cover a line split across two chunks, a line past the frame budget, invalid
 * JSON with valid lines either side, a child that emits nothing, a child that
 * dies mid-line, a trailing line with no newline, and CRLF — each with a
 * DEFINED behaviour rather than an accident of implementation.
 *
 * Four properties are load-bearing:
 *
 *  - **The child cannot reach the wire (INV-2).** A generic NDJSON contract
 *    is the single easiest place in this project for a stranger to smuggle a
 *    send: write a line that already looks like a frame and hope the shim
 *    forwards it. It does not. The line is refused, counted as
 *    `child.rejected`, answered with `{kind:'error', reason:
 *    'not-a-child-message'}`, and labelled with the daemon's own taxonomy —
 *    `adapter.no-send-frame:send`, never `gate.denied` (C-6). There is
 *    exactly one place in `src/index.ts` where a byte reaches the socket and
 *    no child line ever gets there.
 *  - **The child never holds the credential.** The shim authenticates to the
 *    gateway; the child answers questions. So `childEnv()` strips
 *    `WEMESSAGE_ADAPTER_TOKEN` and anything `wm_<64 hex>` shaped out of the
 *    environment it hands down, and nothing is ever passed in argv. A child
 *    that cannot see a token cannot leak one.
 *  - **A dead child is a decline, not a silence.** The gateway is owed
 *    exactly one `draft.submit` per `draft.request`. When the child exits
 *    mid-run, every open request is declined, health goes `degraded`, and the
 *    shim respawns at most `maxAttempts` times — kit check 5's semantics
 *    applied to the child rather than to the socket.
 *  - **The honesty is a value, not a sentence.** `OPENCLAW_VERIFICATION`
 *    reuses Sc 9's discriminated union rather than inventing a second
 *    vocabulary for the same admission, the README's first paragraph is
 *    rendered from it, and `OPENCLAW_CLAIMS` records which OpenClaw API
 *    details are verified facts and which are assumptions.
 *
 * Nothing in this file starts, probes or modifies an OpenClaw. Every row
 * drives the Sc 6 conformance harness, the committed example child, and pure
 * functions. The kit opens no port on the in-process path, so the only real
 * processes here are `node` running `examples/stdio-child.mjs`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { parseSkillBlocks } from '../../../cli/test/helpers/transcript-lint.js';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMockGateway,
  runConformance,
  type AdapterStartContext,
  type AdapterUnderTest,
  type MockGateway,
} from '@wemessage/adapter-testkit';
import { WIRE_VERSION, type DraftSubmitFrame } from '@wemessage/protocol';
import {
  childEnv,
  classifyChildRefusal,
  createNdjsonParser,
  createNodeChildSpawner,
  createStdioShimAdapter,
  liveVerificationOffenders,
  readChildMessage,
  verificationBanner,
  AGENT_FRAME_TYPES,
  CHILD_COUNTERS,
  CHILD_MESSAGE_KINDS,
  CHILD_PROTOCOL_ENV,
  CHILD_PROTOCOL_VERSION,
  CHILD_TO_SHIM_KINDS,
  DEFAULT_MAX_LINE_BYTES,
  OPENCLAW_ASSUMPTION_HEADING,
  OPENCLAW_CLAIMS,
  OPENCLAW_VERIFICATION,
  SHIM_TO_CHILD_KINDS,
  type ChildSpawner,
  type ShimChild,
  type StdioShimAdapter,
} from '../src/index.js';

const PKG = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const README = readFileSync(join(PKG, 'README.md'), 'utf8');
const SHIM_SRC = readFileSync(join(PKG, 'src/index.ts'), 'utf8');
const SKILL_PATH = join(REPO_ROOT, 'skills/openclaw/SKILL.md');
const EXAMPLE_CHILD = join(
  REPO_ROOT,
  'packages/adapter-testkit/examples/stdio-child.mjs',
);

/**
 * Synthetic, `wm_` shaped so it is the right KIND of credential, and 64 hex
 * characters of `a` so it can never collide with one a real daemon minted
 * (Part 3 fixture rules).
 */
const TOKEN = `wm_${'a'.repeat(64)}`;
const URL_ = 'ws://mock-gateway.example.com/v1/agent';

/* ── child plumbing ────────────────────────────────────────────────────── */

/**
 * Every child any row in this file started, so a failing row cannot leak a
 * node process into the rest of the suite. `afterEach` runs on failure too,
 * which is the whole reason the registry exists rather than a `finally` in
 * each row.
 */
const STARTED: ShimChild[] = [];

/** The PRODUCTION spawner, wrapped only to record what it handed back. */
const spawner: ChildSpawner = (command, args, env) => {
  const child = createNodeChildSpawner()(command, args, env);
  STARTED.push(child);
  return child;
};

/** A scripted child that never runs a process: pure, synchronous, ours. */
interface FakeChild extends ShimChild {
  /** Feed the shim a raw stdout chunk, exactly as a pipe would. */
  emit(chunk: string): void;
  /** End the child, as an exit event would. */
  die(): void;
  /** Every line the SHIM wrote to this child's stdin, newline stripped. */
  written(): string[];
  /** The environment this child was handed. */
  env(): Readonly<Record<string, string>>;
}

interface FakeSpawner {
  spawn: ChildSpawner;
  /** Children in spawn order. */
  children(): FakeChild[];
  /** The most recent child, or `undefined` before the first spawn. */
  latest(): FakeChild | undefined;
  /** The argv of every spawn, for the "never in argv" row. */
  argv(): string[][];
}

function fakeSpawner(): FakeSpawner {
  const kids: FakeChild[] = [];
  const argvs: string[][] = [];
  const spawn: ChildSpawner = (command, args, env) => {
    const lines: string[] = [];
    let onOut: (chunk: string) => void = () => undefined;
    let onExit: () => void = () => undefined;
    let alive = true;
    argvs.push([command, ...args]);
    const child: FakeChild = {
      write: (line: string): void => {
        lines.push(line);
      },
      onStdout: (cb) => {
        onOut = cb;
      },
      onExit: (cb) => {
        onExit = cb;
      },
      kill: (): void => {
        if (!alive) return;
        alive = false;
        onExit();
      },
      emit: (chunk: string): void => {
        if (alive) onOut(chunk);
      },
      die: (): void => {
        if (!alive) return;
        alive = false;
        onExit();
      },
      written: () => [...lines],
      env: () => env,
    };
    kids.push(child);
    return child;
  };
  return {
    spawn,
    children: () => [...kids],
    latest: () => kids[kids.length - 1],
    argv: () => argvs.map((a) => [...a]),
  };
}

afterEach(() => {
  while (STARTED.length > 0) STARTED.pop()?.kill();
});

/* ── session helpers ───────────────────────────────────────────────────── */

interface Session {
  gateway: MockGateway;
  adapter: StdioShimAdapter;
  exit: Promise<number>;
}

interface Over {
  spawn?: ChildSpawner;
  maxAttempts?: number;
  schedule?: (ms: number, fn: () => void) => () => void;
  maxLineBytes?: number;
  command?: string;
  args?: readonly string[];
}

async function open(over: Over = {}): Promise<Session> {
  const gateway = createMockGateway({ adapterId: 'openclaw', token: TOKEN });
  const adapter = createStdioShimAdapter({
    url: URL_,
    adapterId: 'openclaw',
    token: TOKEN,
    ws: gateway.ws,
    command: over.command ?? process.execPath,
    args: over.args ?? [EXAMPLE_CHILD],
    spawn: over.spawn ?? spawner,
    delay: () => Promise.resolve(),
    clock: { now: () => '2026-09-05T00:00:00.000Z' },
    ...(over.maxAttempts !== undefined
      ? { maxAttempts: over.maxAttempts }
      : {}),
    ...(over.schedule !== undefined ? { schedule: over.schedule } : {}),
    ...(over.maxLineBytes !== undefined
      ? { maxLineBytes: over.maxLineBytes }
      : {}),
  });
  const exit = adapter.run();
  await until(() => gateway.types().includes('hello'));
  return { gateway, adapter, exit };
}

async function shut(session: Session): Promise<void> {
  await session.adapter.stop();
  await Promise.race([session.exit, settle()]);
}

/** Resolve on an observed fact, never on a clock. */
async function until(pred: () => boolean, budgetMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (pred()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Drain the queues before asserting a NEGATIVE. */
async function settle(ticks = 40): Promise<void> {
  for (let i = 0; i < ticks; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

function submits(gateway: MockGateway): DraftSubmitFrame[] {
  return gateway
    .frames()
    .filter((f): f is DraftSubmitFrame => f.type === 'draft.submit');
}

/** The subject, as a third party would hand it to the kit. */
const SHIM: AdapterUnderTest = {
  name: 'openclaw-stdio-shim',
  start: (ctx: AdapterStartContext) => {
    const adapter = createStdioShimAdapter({
      url: ctx.url,
      adapterId: ctx.adapterId,
      token: ctx.token,
      ws: ctx.ws,
      command: process.execPath,
      args: [EXAMPLE_CHILD],
      spawn: spawner,
      clock: ctx.clock,
      delay: ctx.delay,
      maxAttempts: ctx.maxAttempts,
    });
    return {
      run: () => adapter.run(),
      stop: () => {
        void adapter.stop();
      },
    };
  },
};

/* ── row 1: conformance, driving the committed example child ───────────── */

describe('s7 Sc10: the shim passes the same six checks as every other adapter', () => {
  it('row 1: CONFORMANT in-process with the example child behind it', async () => {
    // Sc 6 deferred `examples/stdio-child.mjs` to this scenario because the
    // contract it demonstrates did not exist yet. It exists now, so the
    // example is EXERCISED here rather than merely linted: every check below
    // ran a real `node` process reading NDJSON off its own stdin.
    expect(existsSync(EXAMPLE_CHILD)).toBe(true);
    const report = await runConformance(SHIM, { budgetMs: 20_000 });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.conformant).toBe(true);
    expect(report.transport).toBe('in-process');
    expect(report.checks).toHaveLength(6);
    // Nothing optional is declared, so check 4 never probes for a
    // `draft.delta` the shim would not send.
    expect(report.features).toEqual([]);
  }, 60_000);
});

/* ── row 2: the child protocol, named and shaped ───────────────────────── */

describe('s7 Sc10: the NDJSON child contract is a closed, documented vocabulary', () => {
  it('row 2a: CHILD_MESSAGE_KINDS is closed and the two directions partition it', () => {
    // The plan's Sc 10 row 2 names five kinds and its row 3 introduces a
    // sixth (`error`, shim -> child). The constant is their union, and the
    // direction tables below are what actually constrain a message.
    expect([...CHILD_MESSAGE_KINDS]).toEqual([
      'request',
      'submit',
      'decline',
      'ping',
      'pong',
      'error',
    ]);
    expect([...SHIM_TO_CHILD_KINDS]).toEqual(['request', 'ping', 'error']);
    expect([...CHILD_TO_SHIM_KINDS]).toEqual(['submit', 'decline', 'pong']);
    // Partitioned, not merely covered: a kind in both directions would be a
    // kind whose direction check means nothing.
    expect(
      [...SHIM_TO_CHILD_KINDS].filter((k) => CHILD_TO_SHIM_KINDS.includes(k)),
    ).toEqual([]);
    expect([...SHIM_TO_CHILD_KINDS, ...CHILD_TO_SHIM_KINDS].sort()).toEqual(
      [...CHILD_MESSAGE_KINDS].sort(),
    );
    // Every kind is documented where a stranger will look for it.
    for (const kind of CHILD_MESSAGE_KINDS)
      expect(README, `README documents ${kind}`).toContain(`\`${kind}\``);
  });

  it('row 2b: a `request` line is the wire draft.request.payload, unreshaped', async () => {
    const fake = fakeSpawner();
    const session = await open({ spawn: fake.spawn });
    // Built here rather than through `gateway.request()` so the comparison is
    // against a payload this row OWNS: "no re-shaping" is only an assertion
    // if both sides of the equality are visible in one place.
    const payload = {
      correlation: {
        requestId: 'req-1',
        chatGuid: 'iMessage;-;+15551230000',
        inboundGuid: 'p:0/msg-1',
      },
      message: {
        guid: 'p:0/msg-1',
        chatGuid: 'iMessage;-;+15551230000',
        handle: '+15551230000',
        isGroup: false,
        service: 'imessage',
        receivedAt: '2026-09-05T00:00:00.000Z',
        content: { untrusted: true, text: 'tacos tonight?', attachments: [] },
      },
      context: [],
      rule: {
        id: `${'0'.repeat(24)}R1`,
        name: 'conformance',
        respondMode: 'draft-only',
      },
      constraints: { maxChars: 1_000, deadlineMs: 5_000 },
    };
    try {
      session.gateway.deliver({
        v: WIRE_VERSION,
        id: 'gw-000001',
        type: 'draft.request',
        ts: '2026-09-05T00:00:00.000Z',
        payload,
      });
      await until(() => (fake.latest()?.written().length ?? 0) >= 1);
      const line = fake.latest()?.written()[0] ?? '';
      const parsed: unknown = JSON.parse(line);
      const obj = parsed as Record<string, unknown>;
      // No re-shaping: the keys the child sees are the wire payload's keys
      // plus `kind`, so a child that has read PROTOCOL.md needs nothing else.
      expect(Object.keys(obj).sort()).toEqual([
        'constraints',
        'context',
        'correlation',
        'kind',
        'message',
        'rule',
      ]);
      const { kind, ...rest } = obj;
      expect(kind).toBe('request');
      expect(rest).toEqual(payload);
    } finally {
      await shut(session);
    }
  });
});

/* ── rows 3-4: the negatives that are the reason the shim exists ───────── */

describe('s7 Sc10: a child line that already looks like a frame is refused (INV-2)', () => {
  it('row 3: a `send`-shaped wire frame from the child never reaches the socket', async () => {
    const fake = fakeSpawner();
    const session = await open({ spawn: fake.spawn });
    try {
      const child = fake.latest();
      expect(child).toBeDefined();
      const before = session.gateway.frames().length;
      // The line a stranger writes first: it is already a valid-LOOKING wire
      // frame, so "why re-wrap it" is the question the shim has to answer
      // with a refusal rather than a forward.
      child?.emit(
        `${JSON.stringify({
          v: WIRE_VERSION,
          id: 'child-000001',
          type: 'send',
          ts: '2026-09-05T00:00:00.000Z',
          payload: {
            chatGuid: 'iMessage;-;+15551230000',
            body: 'delivered it myself',
          },
        })}\n`,
      );
      await settle();
      // Nothing on the wire. Not a refused frame, not a violation the mock
      // had to catch: the frame never left this process.
      expect(session.gateway.frames()).toHaveLength(before);
      expect(session.gateway.violations()).toEqual([]);
      expect(session.gateway.types()).toEqual(['hello']);
      expect(session.gateway.crashed()).toBe(false);
      expect(session.adapter.stats()['child.rejected']).toBe(1);
      // The child is TOLD, in the vocabulary it speaks.
      expect(child?.written()).toEqual([
        JSON.stringify({ kind: 'error', reason: 'not-a-child-message' }),
      ]);
      // C-6: the daemon's taxonomy, and never the approval one.
      expect(session.adapter.refusals()).toEqual([
        'adapter.no-send-frame:send',
      ]);
      for (const label of session.adapter.refusals())
        expect(label).not.toContain('gate.denied');
    } finally {
      await shut(session);
    }
  });

  it('row 3b: a `{"kind":"send"}` line is refused the same way', async () => {
    const fake = fakeSpawner();
    const session = await open({ spawn: fake.spawn });
    try {
      fake.latest()?.emit(`${JSON.stringify({ kind: 'send', body: 'x' })}\n`);
      await settle();
      expect(session.gateway.types()).toEqual(['hello']);
      expect(session.adapter.stats()['child.rejected']).toBe(1);
      expect(session.adapter.refusals()).toEqual([
        'adapter.no-send-frame:send',
      ]);
    } finally {
      await shut(session);
    }
  });

  it('row 4: a submit for an unknown correlation is dropped and counted', async () => {
    const fake = fakeSpawner();
    const session = await open({ spawn: fake.spawn });
    try {
      const before = session.gateway.frames().length;
      fake
        .latest()
        ?.emit(
          `${JSON.stringify({ kind: 'submit', correlation: { requestId: 'never-asked' }, body: 'hello?' })}\n`,
        );
      await settle();
      // INV-2 as reachability again: a child cannot originate, because the
      // only thing that turns a child line into a frame is an OPEN request,
      // and there is none.
      expect(session.gateway.frames()).toHaveLength(before);
      expect(submits(session.gateway)).toEqual([]);
      expect(session.gateway.violations()).toEqual([]);
      expect(session.adapter.stats()['child.unknown-correlation']).toBe(1);
      expect(session.adapter.stats()['child.rejected']).toBe(0);
    } finally {
      await shut(session);
    }
  });
});

/* ── row 5: a dead child is a decline, not a silence ───────────────────── */

describe('s7 Sc10: the child dying mid-run declines rather than hangs', () => {
  it('row 5: every open request is declined, health degrades, respawns are capped', async () => {
    const fake = fakeSpawner();
    // One attempt, so the death is terminal and the assertion about health
    // is not racing a respawn.
    const session = await open({ spawn: fake.spawn, maxAttempts: 1 });
    try {
      expect(session.adapter.health()).toBe('healthy');
      session.gateway.request({ requestId: 'req-1', text: 'first' });
      session.gateway.request({
        requestId: 'req-2',
        chatGuid: 'iMessage;-;+15551230001',
        text: 'second',
      });
      await until(() => (fake.latest()?.written().length ?? 0) >= 2);
      fake.latest()?.die();
      await until(() => submits(session.gateway).length >= 2);
      await settle();
      const out = submits(session.gateway);
      expect(out).toHaveLength(2);
      for (const frame of out) {
        expect(frame.payload.declined).toBe(true);
        expect(frame.payload.body).toBeUndefined();
      }
      expect(out.map((f) => f.payload.correlation.requestId).sort()).toEqual([
        'req-1',
        'req-2',
      ]);
      expect(session.adapter.health()).toBe('degraded');
      expect(session.adapter.stats()['child.declined-on-death']).toBe(2);
      // The ceiling, kit check 5's semantics applied to the child.
      expect(session.adapter.stats()['child.spawns']).toBe(1);
      expect(fake.children()).toHaveLength(1);
      expect(session.gateway.violations()).toEqual([]);
    } finally {
      await shut(session);
    }
  });

  it('row 5b: a child that keeps dying is respawned at most maxAttempts times', async () => {
    const fake = fakeSpawner();
    const session = await open({ spawn: fake.spawn, maxAttempts: 3 });
    try {
      for (let i = 0; i < 6; i += 1) {
        fake.latest()?.die();
        await settle(2);
      }
      expect(fake.children()).toHaveLength(3);
      expect(session.adapter.stats()['child.spawns']).toBe(3);
      expect(session.adapter.health()).toBe('degraded');
      // A shim with no child left still answers, because an unanswered
      // request is a check-2 failure on a real daemon.
      session.gateway.request({ requestId: 'req-late', text: 'anyone?' });
      await until(() => submits(session.gateway).length >= 1);
      const late = submits(session.gateway)[0] as DraftSubmitFrame;
      expect(late.payload.declined).toBe(true);
    } finally {
      await shut(session);
    }
  });
});

/* ── the ugly cases: NDJSON framing, as a public contract ──────────────── */

describe('s7 Sc10: the NDJSON framer defines every malformed input', () => {
  const line = (o: unknown): string => JSON.stringify(o);

  it('a line split across two chunks is delivered once, whole', () => {
    const parser = createNdjsonParser();
    const text = line({ kind: 'pong' });
    const cut = Math.floor(text.length / 2);
    expect(parser.push(text.slice(0, cut))).toEqual([]);
    expect(parser.push(`${text.slice(cut)}\n`)).toEqual([
      { ok: true, text, final: false },
    ]);
  });

  it('a line split mid-multibyte-character survives the boundary', () => {
    // The decoder upstream is stateful, but the framer must not assume a
    // chunk ends on a character boundary either.
    const parser = createNdjsonParser();
    const text = line({ kind: 'submit', correlation: { requestId: 'r' } });
    for (const ch of text) expect(parser.push(ch)).toEqual([]);
    expect(parser.push('\n')).toEqual([{ ok: true, text, final: false }]);
  });

  it('CRLF is line terminator plus noise, not part of the line', () => {
    const parser = createNdjsonParser();
    const text = line({ kind: 'pong' });
    expect(parser.push(`${text}\r\n`)).toEqual([
      { ok: true, text, final: false },
    ]);
  });

  it('blank and whitespace-only lines are skipped, not refused', () => {
    const parser = createNdjsonParser();
    expect(parser.push('\n\n   \n\t\n')).toEqual([]);
    expect(parser.end()).toEqual([]);
  });

  it('a line past the budget is dropped and the framer resynchronises', () => {
    const parser = createNdjsonParser(64);
    const good = line({ kind: 'pong' });
    const huge = `{"kind":"submit","body":"${'x'.repeat(500)}"}`;
    const events = parser.push(`${huge}\n${good}\n`);
    // The tail of an over-budget line must NOT become a fresh line: that is
    // how a framer turns one bad input into a stream of plausible garbage.
    expect(events).toEqual([
      { ok: false, reason: 'oversize' },
      { ok: true, text: good, final: false },
    ]);
  });

  it('an over-budget line with no terminator ever still resynchronises', () => {
    const parser = createNdjsonParser(64);
    const good = line({ kind: 'pong' });
    expect(parser.push('y'.repeat(200))).toEqual([
      { ok: false, reason: 'oversize' },
    ]);
    // Still skipping: everything up to the next newline belongs to the line
    // we already refused.
    expect(parser.push('more of the same')).toEqual([]);
    expect(parser.push(`\n${good}\n`)).toEqual([
      { ok: true, text: good, final: false },
    ]);
  });

  it('a trailing line with no newline is flushed at end, marked final', () => {
    const parser = createNdjsonParser();
    const text = line({ kind: 'pong' });
    expect(parser.push(text)).toEqual([]);
    expect(parser.end()).toEqual([{ ok: true, text, final: true }]);
    // `end` is idempotent: a second call has nothing left to invent.
    expect(parser.end()).toEqual([]);
  });

  it('the default budget is the kit`s frame budget, not a fresh number', () => {
    expect(DEFAULT_MAX_LINE_BYTES).toBe(262_144);
  });
});

describe('s7 Sc10: the message layer defines every malformed line', () => {
  it('the three child->shim kinds parse', () => {
    expect(
      readChildMessage(
        JSON.stringify({
          kind: 'submit',
          correlation: { requestId: 'r' },
          body: 'hi',
        }),
      ),
    ).toEqual({
      ok: true,
      message: { kind: 'submit', correlation: { requestId: 'r' }, body: 'hi' },
    });
    expect(
      readChildMessage(
        JSON.stringify({ kind: 'decline', correlation: { requestId: 'r' } }),
      ),
    ).toEqual({
      ok: true,
      message: { kind: 'decline', correlation: { requestId: 'r' } },
    });
    expect(readChildMessage(JSON.stringify({ kind: 'pong' }))).toEqual({
      ok: true,
      message: { kind: 'pong' },
    });
  });

  it('every refusal names a reason and, where there is one, a name', () => {
    const cases: [string, string, string | null][] = [
      ['not json at all', 'invalid-json', null],
      ['[]', 'not-an-object', null],
      ['null', 'not-an-object', null],
      ['3', 'not-an-object', null],
      ['"a string"', 'not-an-object', null],
      ['{}', 'not-a-child-message', null],
      [JSON.stringify({ kind: 42 }), 'not-a-child-message', null],
      [JSON.stringify({ kind: 'send' }), 'not-a-child-message', 'send'],
      [
        JSON.stringify({
          v: 1,
          id: 'x',
          type: 'send',
          ts: '2026-09-05T00:00:00.000Z',
          payload: {},
        }),
        'not-a-child-message',
        'send',
      ],
      [
        JSON.stringify({
          v: 1,
          id: 'x',
          type: 'draft.submit',
          ts: '2026-09-05T00:00:00.000Z',
          payload: {},
        }),
        'not-a-child-message',
        'draft.submit',
      ],
      [JSON.stringify({ kind: 'request' }), 'wrong-direction', 'request'],
      [JSON.stringify({ kind: 'ping' }), 'wrong-direction', 'ping'],
      [
        JSON.stringify({ kind: 'error', reason: 'nope' }),
        'wrong-direction',
        'error',
      ],
      [JSON.stringify({ kind: 'submit' }), 'malformed-payload', null],
      [
        JSON.stringify({ kind: 'submit', correlation: {} }),
        'malformed-payload',
        null,
      ],
      [
        JSON.stringify({
          kind: 'submit',
          correlation: { requestId: 'r' },
          body: 7,
        }),
        'malformed-payload',
        null,
      ],
      [JSON.stringify({ kind: 'decline' }), 'malformed-payload', null],
    ];
    for (const [text, reason, name] of cases) {
      const parsed = readChildMessage(text);
      expect(parsed.ok, text).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.reason, text).toBe(reason);
      expect(parsed.name, text).toBe(name);
    }
  });

  it('the refusal taxonomy is the daemon`s, and never the approval one', () => {
    // Exactly the split `classifyRefusal` makes in the testkit: reaching for
    // a name the wire has (or a direction it may not originate) is
    // `no-send-frame`; being structurally broken is `protocol-violation`.
    expect(classifyChildRefusal('not-a-child-message', 'send')).toBe(
      'adapter.no-send-frame:send',
    );
    expect(classifyChildRefusal('wrong-direction', 'request')).toBe(
      'adapter.no-send-frame:request',
    );
    expect(classifyChildRefusal('not-a-child-message', null)).toBe(
      'adapter.protocol-violation:not-a-child-message',
    );
    expect(classifyChildRefusal('invalid-json', null)).toBe(
      'adapter.protocol-violation:invalid-json',
    );
    expect(classifyChildRefusal('malformed-payload', 'submit')).toBe(
      'adapter.protocol-violation:malformed-payload',
    );
    for (const reason of [
      'invalid-json',
      'not-an-object',
      'not-a-child-message',
      'wrong-direction',
      'malformed-payload',
      'truncated-line',
      'oversize-line',
    ] as const) {
      expect(classifyChildRefusal(reason, null)).not.toContain('gate.denied');
      expect(classifyChildRefusal(reason, 'send')).not.toContain('gate.denied');
    }
  });
});

describe('s7 Sc10: the ugly cases, end to end through the shim', () => {
  it('invalid JSON between two valid lines costs only the invalid line', async () => {
    const fake = fakeSpawner();
    const session = await open({ spawn: fake.spawn });
    try {
      session.gateway.request({ requestId: 'req-1', text: 'one' });
      session.gateway.request({
        requestId: 'req-2',
        chatGuid: 'iMessage;-;+15551230001',
        text: 'two',
      });
      await until(() => (fake.latest()?.written().length ?? 0) >= 2);
      fake
        .latest()
        ?.emit(
          `${JSON.stringify({ kind: 'submit', correlation: { requestId: 'req-1' }, body: 'first' })}\n` +
            'this line is not json\n' +
            `${JSON.stringify({ kind: 'submit', correlation: { requestId: 'req-2' }, body: 'second' })}\n`,
        );
      await until(() => submits(session.gateway).length >= 2);
      await settle();
      expect(submits(session.gateway).map((f) => f.payload.body)).toEqual([
        'first',
        'second',
      ]);
      expect(session.adapter.stats()['child.invalid-json']).toBe(1);
      expect(session.gateway.violations()).toEqual([]);
    } finally {
      await shut(session);
    }
  });

  it('a submit split across two chunks is honoured once', async () => {
    const fake = fakeSpawner();
    const session = await open({ spawn: fake.spawn });
    try {
      session.gateway.request({ requestId: 'req-1', text: 'one' });
      await until(() => (fake.latest()?.written().length ?? 0) >= 1);
      const text = JSON.stringify({
        kind: 'submit',
        correlation: { requestId: 'req-1' },
        body: 'split down the middle',
      });
      fake.latest()?.emit(text.slice(0, 12));
      await settle(4);
      expect(submits(session.gateway)).toEqual([]);
      fake.latest()?.emit(`${text.slice(12)}\n`);
      await until(() => submits(session.gateway).length >= 1);
      await settle();
      expect(submits(session.gateway)).toHaveLength(1);
      expect(
        (submits(session.gateway)[0] as DraftSubmitFrame).payload.body,
      ).toBe('split down the middle');
    } finally {
      await shut(session);
    }
  });

  it('a child that emits nothing declines at the request deadline', async () => {
    const fake = fakeSpawner();
    // The deadline is a SEPARATE seam from the reconnect backoff: the kit
    // injects a zero `delay`, and reusing it here would decline every
    // request before the child could read it.
    const session = await open({
      spawn: fake.spawn,
      schedule: (_ms, fn) => {
        fn();
        return () => undefined;
      },
    });
    try {
      session.gateway.request({ requestId: 'req-1', text: 'anyone home?' });
      await until(() => submits(session.gateway).length >= 1);
      const frame = submits(session.gateway)[0] as DraftSubmitFrame;
      expect(frame.payload.declined).toBe(true);
      expect(frame.payload.body).toBeUndefined();
      expect(session.adapter.stats()['child.deadline-decline']).toBe(1);
      // And the late answer is then an unknown correlation, not a second
      // draft in front of a human.
      fake
        .latest()
        ?.emit(
          `${JSON.stringify({ kind: 'submit', correlation: { requestId: 'req-1' }, body: 'sorry, slow' })}\n`,
        );
      await settle();
      expect(submits(session.gateway)).toHaveLength(1);
      expect(session.adapter.stats()['child.unknown-correlation']).toBe(1);
    } finally {
      await shut(session);
    }
  });

  it('a child that dies mid-line drops the fragment rather than half-reading it', async () => {
    const fake = fakeSpawner();
    const session = await open({ spawn: fake.spawn, maxAttempts: 1 });
    try {
      session.gateway.request({ requestId: 'req-1', text: 'one' });
      await until(() => (fake.latest()?.written().length ?? 0) >= 1);
      fake.latest()?.emit('{"kind":"submit","correlation":{"requestI');
      fake.latest()?.die();
      await until(() => submits(session.gateway).length >= 1);
      await settle();
      // The open request is DECLINED (the death path), never completed from
      // a fragment: half a JSON object is not half an answer.
      const out = submits(session.gateway);
      expect(out).toHaveLength(1);
      expect(out[0]?.payload.declined).toBe(true);
      expect(session.adapter.stats()['child.truncated']).toBe(1);
      expect(session.adapter.stats()['child.lines.in']).toBe(0);
    } finally {
      await shut(session);
    }
  });

  it('a well-formed final line with no newline is honoured at exit', async () => {
    const fake = fakeSpawner();
    const session = await open({ spawn: fake.spawn, maxAttempts: 1 });
    try {
      session.gateway.request({ requestId: 'req-1', text: 'one' });
      await until(() => (fake.latest()?.written().length ?? 0) >= 1);
      // Plenty of children never terminate their last line. Refusing it
      // would punish a correct answer for a missing byte.
      fake.latest()?.emit(
        JSON.stringify({
          kind: 'submit',
          correlation: { requestId: 'req-1' },
          body: 'no trailing newline',
        }),
      );
      fake.latest()?.die();
      await until(() => submits(session.gateway).length >= 1);
      await settle();
      const out = submits(session.gateway);
      expect(out).toHaveLength(1);
      expect(out[0]?.payload.body).toBe('no trailing newline');
      expect(out[0]?.payload.declined).toBeUndefined();
      expect(session.adapter.stats()['child.truncated']).toBe(0);
    } finally {
      await shut(session);
    }
  });

  it('an over-budget child line is refused and the stream recovers', async () => {
    const fake = fakeSpawner();
    const session = await open({ spawn: fake.spawn, maxLineBytes: 256 });
    try {
      session.gateway.request({ requestId: 'req-1', text: 'one' });
      await until(() => (fake.latest()?.written().length ?? 0) >= 1);
      fake
        .latest()
        ?.emit(
          `${JSON.stringify({ kind: 'submit', correlation: { requestId: 'req-1' }, body: 'z'.repeat(4_000) })}\n` +
            `${JSON.stringify({ kind: 'submit', correlation: { requestId: 'req-1' }, body: 'short enough' })}\n`,
        );
      await until(() => submits(session.gateway).length >= 1);
      await settle();
      expect(session.adapter.stats()['child.oversize']).toBe(1);
      const out = submits(session.gateway);
      expect(out).toHaveLength(1);
      expect(out[0]?.payload.body).toBe('short enough');
      expect(session.gateway.violations()).toEqual([]);
    } finally {
      await shut(session);
    }
  });

  it('a gateway ping is answered by the shim and forwarded as a liveness probe', async () => {
    const fake = fakeSpawner();
    const session = await open({ spawn: fake.spawn });
    try {
      session.gateway.ping();
      await until(() => session.gateway.types().includes('pong'));
      // The shim answers the gateway itself: the child's liveness is the
      // shim's business, and a gateway `pong` must never wait on a process
      // that may be wedged.
      expect(session.gateway.types()).toEqual(['hello', 'pong']);
      expect(fake.latest()?.written()).toEqual([
        JSON.stringify({ kind: 'ping' }),
      ]);
      fake.latest()?.emit(`${JSON.stringify({ kind: 'pong' })}\n`);
      await settle();
      expect(session.adapter.stats()['child.pong']).toBe(1);
      expect(session.gateway.types()).toEqual(['hello', 'pong']);
    } finally {
      await shut(session);
    }
  });
});

/* ── the credential never goes down ────────────────────────────────────── */

describe('s7 Sc10: the child never holds the gateway credential', () => {
  it('childEnv strips the adapter token and anything wm_-shaped', () => {
    const env = childEnv(
      {
        WEMESSAGE_ADAPTER_TOKEN: `wm_${'b'.repeat(64)}`,
        SOMETHING_ELSE: `carrying wm_${'c'.repeat(64)} inline`,
        HARMLESS: 'keep me',
      },
      { PATH: '/usr/bin', WEMESSAGE_ADAPTER_TOKEN: `wm_${'d'.repeat(64)}` },
    );
    expect(env['WEMESSAGE_ADAPTER_TOKEN']).toBeUndefined();
    expect(env['SOMETHING_ELSE']).toBeUndefined();
    expect(env['HARMLESS']).toBe('keep me');
    expect(env['PATH']).toBe('/usr/bin');
    expect(env[CHILD_PROTOCOL_ENV]).toBe(CHILD_PROTOCOL_VERSION);
    expect(JSON.stringify(env)).not.toMatch(/wm_[0-9a-f]{64}/);
  });

  it('the token reaches neither the child environment nor its argv', async () => {
    const fake = fakeSpawner();
    const session = await open({ spawn: fake.spawn });
    try {
      const env = fake.latest()?.env() ?? {};
      expect(JSON.stringify(env)).not.toContain(TOKEN);
      expect(env['WEMESSAGE_ADAPTER_TOKEN']).toBeUndefined();
      // `ps(1)` shows any user on the box the full argv of every process.
      for (const argv of fake.argv())
        expect(argv.join(' ')).not.toContain(TOKEN);
    } finally {
      await shut(session);
    }
  });
});

/* ── the chokepoint ────────────────────────────────────────────────────── */

describe('s7 Sc10: one place a byte reaches the socket', () => {
  it('there is exactly one send call site, and `send` is not a frame type', () => {
    const sites = SHIM_SRC.match(/socket\?\.send\(/g) ?? [];
    expect(sites).toHaveLength(1);
    expect(SHIM_SRC.match(/socket\.send\(/g)).toBeNull();
    expect([...AGENT_FRAME_TYPES]).toEqual([
      'hello',
      'draft.submit',
      'draft.delta',
      'proactive.propose',
      'pong',
    ]);
    expect(AGENT_FRAME_TYPES).not.toContain('send');
  });

  it('the counter vocabulary is closed and every counter starts at zero', async () => {
    const fake = fakeSpawner();
    const session = await open({ spawn: fake.spawn });
    try {
      const stats = session.adapter.stats();
      expect(Object.keys(stats).sort()).toEqual([...CHILD_COUNTERS].sort());
      for (const name of CHILD_COUNTERS)
        if (name !== 'child.spawns') expect(stats[name]).toBe(0);
      expect(stats['child.spawns']).toBe(1);
    } finally {
      await shut(session);
    }
  });
});

/* ── rows 6-7: the honesty that ships with it ──────────────────────────── */

describe('s7 Sc10: the verification tier is a value, and the README prints it', () => {
  it('row 7a: the shipped claim is conformance-only and internally sound', () => {
    expect(OPENCLAW_VERIFICATION.adapter).toBe('openclaw');
    expect(OPENCLAW_VERIFICATION.tier).toBe('conformance-only');
    expect(OPENCLAW_VERIFICATION.liveEvidence).toBeNull();
    expect(
      liveVerificationOffenders(OPENCLAW_VERIFICATION, {
        read: () => null,
        tracked: () => false,
      }),
    ).toEqual([]);
  });

  it('row 7b: the README first paragraph is the rendered banner, byte for byte', () => {
    const banner = verificationBanner(OPENCLAW_VERIFICATION);
    expect(banner).toContain('NOT LIVE-VERIFIED');
    const head = README.split(/\n\s*\n/)
      .slice(0, 3)
      .join('\n\n');
    expect(head).toContain(banner);
  });

  it('row 7c: the README says the child contract is ours and the binding is a guess', () => {
    expect(README).toMatch(/child contract .*(is|are) ours/i);
    expect(README).toMatch(/read from (the )?docs only/i);
    // The one-line OpenClaw binding is shown as an EXAMPLE and labelled.
    expect(README).toContain('openclaw.plugin.json');
    expect(README).toMatch(/unverified/i);
    expect(README).toContain(OPENCLAW_ASSUMPTION_HEADING);
    // Nothing in the shipped code names OpenClaw: the shim is generic, and a
    // README paragraph is the entire extent of the OpenClaw-specific surface.
    expect(SHIM_SRC).not.toMatch(/from\s+['"][^'"]*openclaw[^'"]*['"]/i);
  });

  it('row 7d: every assumption is labelled, and republished in the README', () => {
    expect(OPENCLAW_CLAIMS.length).toBeGreaterThan(4);
    const verified = OPENCLAW_CLAIMS.filter((c) => c.basis === 'verified');
    const assumed = OPENCLAW_CLAIMS.filter((c) => c.basis === 'assumed');
    // Both halves must be non-empty: a ledger with no assumptions is a
    // ledger nobody filled in.
    expect(verified.length).toBeGreaterThan(0);
    expect(assumed.length).toBeGreaterThan(0);
    for (const claim of verified) expect(claim.source).not.toBe(null);
    const section = README.slice(README.indexOf(OPENCLAW_ASSUMPTION_HEADING));
    for (const claim of assumed) expect(section).toContain(claim.claim);
    // A verified fact must not be quietly demoted into the guess list.
    for (const claim of verified) expect(section).not.toContain(claim.claim);
  });
});

describe('s7 Sc10: the OpenClaw skill (skill-first, linted by Sc 11)', () => {
  const BLOCKS = ['allowed', 'approval', 'never'] as const;

  /**
   * REWIRED BY s7 Sc 11. This used to be a local parser for the §1.7 block
   * format. Sc 11 needs the same parse in three more places, so the
   * implementation moved to `packages/cli/test/helpers/transcript-lint.ts`
   * and this delegates to it. Two parsers for one file format is one parser
   * too many, and these rows are exactly the rows that would stop noticing
   * if the two drifted.
   *
   * The import is test-to-test. `adapters-thin-clients` fences
   * `^packages/adapters/[^/]+/src`, so an adapter's PRODUCTION source still
   * cannot reach a sibling package; a spec reading a shared parser is not
   * that coupling and never was.
   */
  function block(name: (typeof BLOCKS)[number]): readonly string[] {
    return parseSkillBlocks(readFileSync(SKILL_PATH, 'utf8'))[name];
  }

  it('row 6a: the file exists and carries the three labelled blocks from §1.7', () => {
    expect(existsSync(SKILL_PATH)).toBe(true);
    const skill = readFileSync(SKILL_PATH, 'utf8');
    for (const name of BLOCKS) {
      expect(skill).toContain(`<!-- wemessage:${name} -->`);
      expect(block(name).length).toBeGreaterThan(0);
    }
  });

  it('row 6b: the first paragraph says NOT LIVE-VERIFIED, from the same value', () => {
    const skill = readFileSync(SKILL_PATH, 'utf8');
    const head = skill
      .split(/\n\s*\n/)
      .slice(0, 3)
      .join('\n\n');
    expect(head).toContain('NOT LIVE-VERIFIED');
    expect(head).toContain(verificationBanner(OPENCLAW_VERIFICATION));
  });

  it('row 6c: approval is a subset of allowed, and never is disjoint from both', () => {
    const allowed = block('allowed');
    const approval = block('approval');
    const never = block('never');
    for (const verb of approval) expect(allowed).toContain(verb);
    for (const pattern of never) expect(allowed).not.toContain(pattern);
    for (const pattern of never) expect(approval).not.toContain(pattern);
  });

  it('row 6d: every allowed line is a verb path the CLI could plausibly have', () => {
    // Sc 11 checks these against the real `wemessage --help`. This row keeps
    // the file machine-parseable in the meantime: one verb per line, lower
    // case, no flags, no prose.
    for (const verb of [...block('allowed'), ...block('approval')])
      expect(verb, verb).toMatch(/^[a-z][a-z-]*( [a-z<*][\w<>*-]*)*$/);
  });

  it('row 6e: the never block covers the widening and credential minimum', () => {
    const never = block('never');
    for (const pattern of [
      'kill',
      'resume',
      'contacts set * auto',
      'settings set *',
      'adapters token-rotate *',
      'auth *',
      'mode *',
      'pause *',
    ])
      expect(never, pattern).toContain(pattern);
  });

  it('row 6f: every verb this skill allows, the flagship skill allows too', () => {
    // WAS A TRIPWIRE. Until s7 Sc 11 this row asserted that
    // `skills/claude/SKILL.md` did not exist, deliberately, so that creating
    // it would fail this file and force the real assertion into the same
    // commit. Sc 11 created it, this row fired, and this is the assertion it
    // was holding a place for.
    //
    // The direction is the one that matters. OpenClaw is a smaller surface
    // than Claude, so it may permit LESS and must never permit more: a verb
    // reachable from this host and not from the flagship is a capability
    // nobody wrote a policy for. `never` runs the other way — every refusal
    // the flagship makes, this host makes too — and is checked in Sc 11,
    // where both documents are already in scope.
    const claudePath = join(REPO_ROOT, 'skills/claude/SKILL.md');
    expect(existsSync(claudePath)).toBe(true);
    const claude = parseSkillBlocks(readFileSync(claudePath, 'utf8'));
    // Guard the guard: a subset check against an empty superset passes
    // vacuously, and an unparsed document is exactly how that happens.
    expect(claude.allowed.length).toBeGreaterThan(8);
    expect(block('allowed').length).toBeGreaterThan(0);
    for (const verb of block('allowed'))
      expect(claude.allowed, verb).toContain(verb);
    for (const verb of block('approval'))
      expect(claude.approval, verb).toContain(verb);
  });
});
