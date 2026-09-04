/**
 * s5-execution Scenario 13 ★ CHECKPOINT — the conformance kit, dogfooded.
 *
 * The kit is a claim about other people's adapters, so it has to be a claim
 * about ours first (rubric 4.5). Every row here runs the SAME six golden
 * checks a third party would run, against the two first-party adapters:
 * `@wemessage/adapter-echo` (deterministic, no model) and
 * `@wemessage/adapter-sol` (a real bridge, driven by an in-process mock Sol).
 * If a check cannot be made green on echo, the check is wrong; if it cannot
 * be made green on sol, the seam is.
 *
 * The last three rows are the kit's own teeth. A conformance suite that only
 * ever sees conformant adapters proves nothing, so three deliberately broken
 * adapters are built here — one that streams without declaring it, one that
 * mints a fresh idempotency key per request, one that retries forever — and
 * each must fail exactly the check that owns it and no other. That is the
 * difference between a suite and a badge printer.
 *
 * Nothing in this file opens a socket, spawns a process or touches a clock.
 * The kit is workspace-internal in S5 (F-52); the `npx` packaging and the
 * subprocess transport are S7, and neither is presumed here.
 */
import { describe, expect, it } from 'vitest';
import { WIRE_VERSION } from '@wemessage/protocol';
import { createEchoAdapter } from '@wemessage/adapter-echo';
import { createSolAdapter } from '@wemessage/adapter-sol';
import {
  AGENT_TO_GATEWAY_TYPES,
  badgeLine,
  createMockGateway,
  formatJson,
  formatTap,
  runConformance,
  type AdapterHandle,
  type AdapterStartContext,
  type AdapterUnderTest,
  type ConformanceReport,
  type TestkitSocket,
  type TestkitSocketFactory,
} from '../src/index.js';

/* ── the two first-party subjects ──────────────────────────────────────── */

const ECHO: AdapterUnderTest = {
  name: 'echo',
  start: (ctx: AdapterStartContext): AdapterHandle =>
    createEchoAdapter({
      url: ctx.url,
      token: ctx.token,
      adapterId: ctx.adapterId,
      ws: ctx.ws,
      clock: ctx.clock,
      delay: ctx.delay,
      maxAttempts: ctx.maxAttempts,
      // Echo declares `streaming` in its hello, so check 4 is entitled to
      // demand deltas. Running it with streaming off would be an adapter that
      // lies in its handshake — which is exactly what row `undeclared
      // streaming` proves the kit catches.
      streaming: true,
    }),
};

/**
 * A mock Sol: RD §4's frames and nothing else. It answers a `{type:"message"}`
 * with `sessionCreated` at connect and a token stream terminated by `done`,
 * which is the shape that makes sol's `draft.delta` → `draft.submit` path run.
 * It never contacts anything; there is no real `WS_SECRET` anywhere in this
 * file (Sc 1 gate (d)).
 */
const SOL_SECRET = 'mock-secret-not-a-real-ws-secret';
const SOL_CHUNKS = 3;

function mockSolWs(): TestkitSocketFactory {
  return (_url, handlers) => {
    let closed = false;
    const socket: TestkitSocket = {
      send(data: string) {
        const json = JSON.parse(data) as {
          type?: string;
          message?: { text?: string };
        };
        if (json.type !== 'message') return;
        const text = json.message?.text ?? '';
        const body = `sol: ${text}`;
        const size = Math.ceil(body.length / SOL_CHUNKS);
        for (let i = 0; i < SOL_CHUNKS; i += 1) {
          handlers.onMessage(
            JSON.stringify({
              type: 'token',
              text: body.slice(i * size, (i + 1) * size),
            }),
          );
        }
        handlers.onMessage(JSON.stringify({ type: 'done' }));
      },
      close(code?: number) {
        if (closed) return;
        closed = true;
        handlers.onClose(code ?? 1000);
      },
    };
    handlers.onMessage(
      JSON.stringify({ type: 'sessionCreated', sessionId: 's-1' }),
    );
    return Promise.resolve(socket);
  };
}

const SOL: AdapterUnderTest = {
  name: 'sol',
  start: (ctx: AdapterStartContext): AdapterHandle =>
    createSolAdapter({
      url: ctx.url,
      token: ctx.token,
      adapterId: ctx.adapterId,
      ws: ctx.ws,
      solUrl: 'ws://mock-sol.example.com/ws',
      solWs: mockSolWs(),
      wsSecret: SOL_SECRET,
      clock: ctx.clock,
      delay: ctx.delay,
      maxAttempts: ctx.maxAttempts,
      logger: { error: () => undefined },
    }),
};

function failedIds(report: ConformanceReport): number[] {
  return report.checks.filter((c) => !c.ok).map((c) => c.id);
}

function explain(report: ConformanceReport): string {
  return report.checks
    .filter((c) => !c.ok)
    .map((c) => `${String(c.id)}: ${c.detail ?? 'no detail'}`)
    .join('\n');
}

/* ── rows 1–2: the dogfood ─────────────────────────────────────────────── */

describe('s5 Sc13: the conformance kit is green on the first-party adapters', () => {
  it('echo is CONFORMANT v1 across all six checks', async () => {
    const report = await runConformance(ECHO);
    expect(explain(report)).toBe('');
    expect(report.conformant).toBe(true);
    expect(report.checks).toHaveLength(6);
    expect(report.checks.every((c) => c.ok)).toBe(true);
    expect(report.features).toEqual(['streaming', 'proactive']);
    expect(badgeLine(report)).toBe('CONFORMANT v1 - echo');
  }, 30_000);

  it('sol is CONFORMANT v1 against an in-process mock Sol', async () => {
    const report = await runConformance(SOL);
    expect(explain(report)).toBe('');
    expect(report.conformant).toBe(true);
    expect(badgeLine(report)).toBe('CONFORMANT v1 - sol');
    // The dogfood is only worth something if the kit ran the SAME checks.
    expect(report.checks.map((c) => c.id)).toEqual([1, 2, 3, 4, 5, 6]);
  }, 30_000);
});

/* ── row 3: the kit's teeth ────────────────────────────────────────────── */

describe('s5 Sc13: the kit fails adapters that deserve to fail', () => {
  it('catches an adapter that streams without declaring `streaming` (check 4)', async () => {
    const report = await runConformance({
      name: 'liar',
      start: (ctx) =>
        createEchoAdapter({
          url: ctx.url,
          token: ctx.token,
          adapterId: ctx.adapterId,
          ws: undeclaredStreamingWs(ctx.ws),
          clock: ctx.clock,
          delay: ctx.delay,
          maxAttempts: ctx.maxAttempts,
          streaming: true,
        }),
    });
    expect(failedIds(report)).toEqual([4]);
    expect(report.conformant).toBe(false);
    expect(badgeLine(report)).toBe('NOT CONFORMANT v1 - liar (1/6 failed)');
  }, 30_000);

  it('catches an unstable idempotency key (check 2)', async () => {
    const report = await runConformance({
      name: 'entropy',
      start: (ctx) =>
        createEchoAdapter({
          url: ctx.url,
          token: ctx.token,
          adapterId: ctx.adapterId,
          ws: randomKeyWs(ctx.ws),
          clock: ctx.clock,
          delay: ctx.delay,
          maxAttempts: ctx.maxAttempts,
          streaming: true,
        }),
    });
    expect(failedIds(report)).toEqual([2]);
  }, 30_000);

  it('catches an adapter that never stops retrying (check 5)', async () => {
    const report = await runConformance({
      name: 'hammer',
      start: (ctx) =>
        createEchoAdapter({
          url: ctx.url,
          token: ctx.token,
          adapterId: ctx.adapterId,
          ws: ctx.ws,
          clock: ctx.clock,
          delay: ctx.delay,
          // The fail-closed ceiling is the check: an adapter that dials past
          // it is hammering a daemon that has already said no.
          maxAttempts: 25,
          streaming: true,
        }),
    });
    expect(failedIds(report)).toEqual([5]);
  }, 30_000);

  it('catches an adapter that crashes on a malformed frame (check 3)', async () => {
    const report = await runConformance({
      name: 'brittle',
      start: (ctx) => brittleAdapter(ctx),
    });
    expect(failedIds(report)).toContain(3);
    expect(report.conformant).toBe(false);
  }, 30_000);
});

/* ── row 4: the report surfaces ────────────────────────────────────────── */

describe('s5 Sc13: TAP, JSON and the badge line', () => {
  it('renders TAP 13 with one line per check and the badge as a comment', async () => {
    const report = await runConformance(ECHO);
    const tap = formatTap(report);
    const lines = tap.split('\n');
    expect(lines[0]).toBe('TAP version 13');
    expect(lines[1]).toBe('1..6');
    for (const id of [1, 2, 3, 4, 5, 6])
      expect(tap).toMatch(new RegExp(`^ok ${String(id)} - `, 'm'));
    expect(tap).not.toMatch(/^not ok/m);
    expect(lines[lines.length - 1]).toBe('# CONFORMANT v1 - echo');
    // C-9, repo-wide: no color escapes anywhere in an output surface.
    expect(tap).not.toMatch(/\x1b\[/);
    expect(formatJson(report)).not.toMatch(/\x1b\[/);
    expect(badgeLine(report)).not.toMatch(/\x1b\[/);
  }, 30_000);

  it('round-trips as JSON and never claims CONFORMANT on a failure', () => {
    const failing: ConformanceReport = {
      adapter: 'nope',
      version: 1,
      conformant: false,
      features: [],
      checks: [
        { id: 1, name: 'handshake', ok: true },
        { id: 2, name: 'submit', ok: false, detail: 'no draft.submit' },
      ],
    };
    expect(JSON.parse(formatJson(failing))).toEqual(failing);
    expect(badgeLine(failing)).toBe('NOT CONFORMANT v1 - nope (1/2 failed)');
    expect(formatTap(failing)).toMatch(/^not ok 2 - submit$/m);
  });
});

/* ── row 5: the vocabulary is derived from the protocol ────────────────── */

describe('s5 Sc13: the kit judges by the protocol, not by a copy of it', () => {
  it('permits exactly the AgentToGateway frame types and no others', () => {
    expect([...AGENT_TO_GATEWAY_TYPES].sort()).toEqual([
      'draft.delta',
      'draft.submit',
      'hello',
      'pong',
      'proactive.propose',
    ]);
    // There is no send frame to permit, and there never will be (INV-2).
    expect(AGENT_TO_GATEWAY_TYPES).not.toContain('draft.approve');
  });

  it('the mock gateway validates with the daemon parser, not a laxer one', async () => {
    const gateway = createMockGateway({ adapterId: 'a', token: 't' });
    const socket = await gateway.ws('ws://x.example.com', {
      onMessage: () => undefined,
      onClose: () => undefined,
    });
    socket.send(
      JSON.stringify({
        v: WIRE_VERSION,
        id: 'x',
        type: 'draft.approve',
        ts: '2026-09-01T00:00:00.000Z',
        payload: { draftId: '01D' },
      }),
    );
    expect(gateway.violations()).toEqual(['draft.approve']);
    expect(gateway.frames()).toHaveLength(0);
  });
});

/* ── the deliberately broken adapters ──────────────────────────────────── */

/** Strip `features` out of the hello: the adapter streams but never says so. */
function undeclaredStreamingWs(
  inner: TestkitSocketFactory,
): TestkitSocketFactory {
  return async (url, handlers) => {
    const socket = await inner(url, handlers);
    return {
      send(data: string) {
        const json = JSON.parse(data) as Record<string, unknown>;
        if (json['type'] === 'hello') {
          const payload = json['payload'] as Record<string, unknown>;
          delete payload['features'];
          socket.send(JSON.stringify(json));
          return;
        }
        socket.send(data);
      },
      close: (code?: number) => {
        socket.close(code);
      },
    };
  };
}

/** Re-key every submit: the gateway's dedup silently stops working. */
function randomKeyWs(inner: TestkitSocketFactory): TestkitSocketFactory {
  let n = 0;
  return async (url, handlers) => {
    const socket = await inner(url, handlers);
    return {
      send(data: string) {
        const json = JSON.parse(data) as Record<string, unknown>;
        if (json['type'] === 'draft.submit') {
          n += 1;
          const payload = json['payload'] as Record<string, unknown>;
          payload['idempotencyKey'] = `entropy-${String(n)}`;
          socket.send(JSON.stringify(json));
          return;
        }
        socket.send(data);
      },
      close: (code?: number) => {
        socket.close(code);
      },
    };
  };
}

/** Throws on anything it cannot parse — the crash check 3 exists to catch. */
function brittleAdapter(ctx: AdapterStartContext): AdapterHandle {
  let socket: TestkitSocket | null = null;
  let stopped = false;
  let attempts = 0;
  const connect = (): Promise<number> =>
    new Promise<number>((resolve) => {
      attempts += 1;
      void ctx
        .ws(ctx.url, {
          onMessage: (raw: string) => {
            // No try/catch anywhere: this is the whole defect.
            const json = JSON.parse(raw) as { type: string };
            if (json.type === 'ping') socket?.send(pong(ctx));
          },
          onClose: (code: number) => {
            socket = null;
            resolve(code);
          },
        })
        .then((s) => {
          socket = s;
          s.send(
            JSON.stringify({
              v: WIRE_VERSION,
              id: `brittle-${String(attempts)}`,
              type: 'hello',
              ts: ctx.clock.now(),
              payload: {
                adapterId: ctx.adapterId,
                token: ctx.token,
                wire: WIRE_VERSION,
              },
            }),
          );
        });
    });
  return {
    async run(): Promise<number> {
      for (let i = 0; i < ctx.maxAttempts; i += 1) {
        const code = await connect();
        if (stopped) return 0;
        if (i === ctx.maxAttempts - 1) return code === 1000 ? 0 : 1;
        await ctx.delay(0);
      }
      return 1;
    },
    stop(): void {
      stopped = true;
      socket?.close();
    },
  };
}

function pong(ctx: AdapterStartContext): string {
  return JSON.stringify({
    v: WIRE_VERSION,
    id: 'brittle-pong',
    type: 'pong',
    ts: ctx.clock.now(),
    payload: {},
  });
}
