/**
 * s7-execution Scenario 8 — Hermes HTTP mode, driven by a real fake Hermes.
 *
 * The plugin (Sc 7) is Hermes calling us. This is us calling Hermes: one
 * `POST /v1/runs`, one `GET /v1/runs/{id}/events`, and an SSE stream that has
 * to become `draft.delta` frames and exactly one `draft.submit`. **Both of
 * those paths are Hermes' API, not ours.** This scenario adds no WeMessage
 * route, no frame type and no close code; `ROUTE_TABLE` and `FRAME_SPECS` are
 * untouched by every line below.
 *
 * Four properties decide the shape of this file:
 *
 *  - **Nothing here talks to the real Hermes.** Hermes is a live agent on the
 *    operator's machine; starting it, or posting a run to it, would be a
 *    side effect a test suite has no business having. Every row stands up its
 *    own `node:http` server on `127.0.0.1:0`, hands the adapter that base URL
 *    through the environment, and tears it down in an `afterEach` that runs
 *    on failure. Port 0 because a fixed port is a collision waiting for the
 *    day two projects run in parallel. The adapter uses the global `fetch`,
 *    so what these rows exercise is the real client, not a stub of one.
 *  - **Chunk boundaries are where streaming bugs live.** An SSE frame that
 *    arrives in two TCP reads is the normal case, not the exotic one, and a
 *    parser without a carry buffer splits a token in half and never notices.
 *    So the carry buffer is proven twice: directly, by feeding
 *    `createSseParser` a frame cut mid-key (deterministic, no sockets), and
 *    end to end, by a server that writes the two halves ten milliseconds
 *    apart so the split is real at the socket layer. Sc 6's transcript
 *    redaction had to solve the same problem; this is the same discipline.
 *  - **A partial answer is never a draft.** `run.failed`, `run.cancelled`, a
 *    stream that stops without a terminal event, a stream that errors
 *    mid-flight, a stream that says nothing at all, a stream that outruns the
 *    request's own deadline: six different causes, one operator-visible
 *    outcome, and each gets its own row because "declined" for the wrong
 *    reason is a bug that looks like a pass. The accumulated text dies with
 *    the run every time.
 *  - **INV-2 does not bend for a capable agent.** Hermes takes actions in its
 *    own world. On this wire it may produce a draft and nothing else. A fake
 *    Hermes that emits send-shaped events, asks for tool approval, and ends
 *    with a completion phrased as an order still produces exactly one
 *    `draft.submit` for a human to approve, and the adapter never calls
 *    `/approval`, `/steer` or `/stop`. The counter-example that DOES reach
 *    for a send frame is refused with the daemon's own taxonomy
 *    (`adapter.no-send-frame`, never `gate.denied`, C-6), exactly as
 *    `examples/broken-sends.mjs` and `test/children/broken_sends.py` are.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_TO_GATEWAY_TYPES,
  classifyRefusal,
  createMockGateway,
  runConformance,
  type AdapterUnderTest,
  type MockGateway,
  type RequestFixture,
  type TestkitSocket,
} from '@wemessage/adapter-testkit';
import {
  parseAgentFrame,
  WIRE_VERSION,
  type DraftDeltaFrame,
  type DraftSubmitFrame,
} from '@wemessage/protocol';
import {
  AGENT_FRAME_TYPES,
  createHermesHttpAdapter,
  createSseParser,
  HERMES_BASE_URL_ENV,
  HERMES_MODEL_ENV,
  HERMES_TOKEN_ENV,
  type HermesHttpAdapter,
} from '../src/index.js';

const PKG = fileURLToPath(new URL('..', import.meta.url));

/**
 * The Hermes bearer every row uses. Synthetic, obviously so, and never a
 * `wm_` shape: it is Hermes' credential, not a gateway adapter token, and
 * conflating the two in a fixture is how the two get conflated in code.
 */
const HERMES_KEY = 'hermes-test-key-not-a-real-credential';

/* ── the fake Hermes ───────────────────────────────────────────────────── */

/** One request the fake Hermes received, in the order it arrived. */
interface RequestLog {
  method: string;
  path: string;
  authorization: string | undefined;
  idempotencyKey: string | undefined;
  accept: string | undefined;
  body: string;
}

interface FakeHermesOptions {
  /** Status for `POST /v1/runs`. Hermes answers 202 on admission. */
  postStatus?: number;
  /** Status for `GET /v1/runs/{id}/events`. */
  eventsStatus?: number;
  /** The SSE chunks to write, in order. Overrides the echo default. */
  chunks?: (input: string, runId: string) => readonly string[];
  /**
   * Milliseconds between chunk writes. This is the FIXTURE pacing a stream,
   * not the test sleeping: a real stream arrives in pieces, and a gap wide
   * enough that the kernel cannot coalesce two writes into one segment is the
   * only way to prove the carry buffer over a real socket. Every assertion
   * still waits on an observed frame, never on a clock.
   */
  gapMs?: number;
  /** Destroy the connection after this many chunks (a mid-flight error). */
  destroyAfter?: number;
  /** Never finish the response — the deadline probe. */
  hold?: boolean;
}

interface FakeHermes {
  baseUrl: string;
  requests: RequestLog[];
  paths(): string[];
  close(): Promise<void>;
}

/** One SSE frame in Hermes' own encoding: no `event:` line, name in the JSON. */
function sse(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * What a healthy Hermes run looks like: a few text deltas, then a completion
 * carrying the same text whole. `output` and the deltas AGREE here, which is
 * the invariant every streaming row asserts and the one the divergence row
 * deliberately breaks.
 */
function echoStream(input: string, runId: string): readonly string[] {
  const reply = `re: ${input}`;
  const pieces = [reply.slice(0, 4), reply.slice(4)];
  return [
    ...pieces.map((delta) =>
      sse({ event: 'message.delta', run_id: runId, delta }),
    ),
    sse({ event: 'run.completed', run_id: runId, output: reply }),
  ];
}

const RUN_EVENTS = /^\/v1\/runs\/([^/]+)\/events$/;

async function createFakeHermes(
  opts: FakeHermesOptions = {},
): Promise<FakeHermes> {
  const requests: RequestLog[] = [];
  const inputs = new Map<string, string>();
  const sockets = new Set<Socket>();
  const open = new Set<ServerResponse>();
  let runs = 0;

  const stream = async (
    res: ServerResponse,
    chunks: readonly string[],
  ): Promise<void> => {
    for (const [index, chunk] of chunks.entries()) {
      if (res.destroyed) return;
      if (opts.destroyAfter !== undefined && index >= opts.destroyAfter) {
        res.destroy();
        return;
      }
      res.write(chunk);
      if (opts.gapMs !== undefined)
        await new Promise<void>((resolve) => {
          setTimeout(resolve, opts.gapMs);
        });
    }
    if (opts.hold === true) return;
    if (!res.destroyed) res.end();
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      const path = req.url ?? '';
      requests.push({
        method: req.method ?? '',
        path,
        authorization: req.headers['authorization'],
        idempotencyKey: req.headers['idempotency-key'] as string | undefined,
        accept: req.headers['accept'],
        body,
      });

      if (req.method === 'POST' && path === '/v1/runs') {
        const status = opts.postStatus ?? 202;
        if (status >= 300) {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'refused' } }));
          return;
        }
        runs += 1;
        const runId = `run_${String(runs)}`;
        let input = '';
        try {
          const parsed: unknown = JSON.parse(body);
          if (typeof parsed === 'object' && parsed !== null)
            input = String((parsed as { input?: unknown }).input ?? '');
        } catch {
          input = '';
        }
        inputs.set(runId, input);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ run_id: runId, status: 'started', replayed: false }),
        );
        return;
      }

      const match = RUN_EVENTS.exec(path);
      if (req.method === 'GET' && match !== null) {
        const runId = match[1] ?? '';
        const status = opts.eventsStatus ?? 200;
        if (status !== 200) {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'refused' } }));
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'x-accel-buffering': 'no',
        });
        open.add(res);
        res.on('close', () => open.delete(res));
        const make = opts.chunks ?? echoStream;
        void stream(res, make(inputs.get(runId) ?? '', runId));
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

  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    requests,
    paths: () => requests.map((r) => `${r.method} ${r.path}`),
    close: async (): Promise<void> => {
      for (const res of [...open]) res.destroy();
      for (const socket of [...sockets]) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

/* ── harness ───────────────────────────────────────────────────────────── */

const servers: FakeHermes[] = [];
const running: HermesHttpAdapter[] = [];
const logs: string[] = [];

async function hermes(opts: FakeHermesOptions = {}): Promise<FakeHermes> {
  const server = await createFakeHermes(opts);
  servers.push(server);
  return server;
}

afterEach(async () => {
  for (const adapter of running.splice(0)) adapter.stop();
  for (const server of servers.splice(0)) await server.close();
  logs.length = 0;
});

const logger = {
  error: (message: string): void => {
    logs.push(message);
  },
};

function envFor(
  server: FakeHermes,
  over: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    [HERMES_BASE_URL_ENV]: server.baseUrl,
    [HERMES_TOKEN_ENV]: HERMES_KEY,
    ...over,
  };
}

interface Session {
  gateway: MockGateway;
  adapter: HermesHttpAdapter;
  exit: Promise<number>;
}

/** Boot the adapter against a fresh mock gateway and wait for its `hello`. */
async function open(
  server: FakeHermes,
  over: Record<string, string | undefined> = {},
): Promise<Session> {
  const gateway = createMockGateway({
    adapterId: 'hermes-http',
    token: `wm_${'b'.repeat(64)}`,
  });
  const adapter = createHermesHttpAdapter({
    url: 'ws://gateway.example.com/v1/agent',
    token: `wm_${'b'.repeat(64)}`,
    adapterId: 'hermes-http',
    ws: gateway.ws,
    delay: () => Promise.resolve(),
    env: envFor(server, over),
    logger,
  });
  running.push(adapter);
  const exit = adapter.run();
  const up = await waitFor(() => gateway.types().includes('hello'));
  expect(up).toBe(true);
  return { gateway, adapter, exit };
}

/** Wait on an observed fact with a ceiling. Never a bare sleep. */
async function waitFor(
  pred: () => boolean,
  budgetMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (pred()) return true;
    if (Date.now() > deadline) return false;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

function submits(gateway: MockGateway): DraftSubmitFrame[] {
  return gateway
    .frames()
    .filter((f): f is DraftSubmitFrame => f.type === 'draft.submit');
}

function deltas(gateway: MockGateway): DraftDeltaFrame[] {
  return gateway
    .frames()
    .filter((f): f is DraftDeltaFrame => f.type === 'draft.delta');
}

/** Drive one request through and return the single submit it produced. */
async function answer(
  session: Session,
  fixture: Partial<RequestFixture> = {},
): Promise<DraftSubmitFrame> {
  session.gateway.request({
    requestId: 'req-1',
    text: 'tacos tonight?',
    ...fixture,
  });
  const got = await waitFor(() => submits(session.gateway).length >= 1);
  expect(got).toBe(true);
  const all = submits(session.gateway);
  expect(all).toHaveLength(1);
  return all[0] as DraftSubmitFrame;
}

/* ── row 1 ─────────────────────────────────────────────────────────────── */

describe('s7 Sc8: HTTP mode passes the same six checks as every other adapter', () => {
  it('row 1: conformance against a real fake Hermes over real HTTP', async () => {
    const server = await hermes();
    const subject: AdapterUnderTest = {
      name: 'hermes-http',
      start: (ctx) =>
        createHermesHttpAdapter({
          url: ctx.url,
          token: ctx.token,
          adapterId: ctx.adapterId,
          ws: ctx.ws,
          delay: ctx.delay,
          clock: ctx.clock,
          maxAttempts: ctx.maxAttempts,
          env: envFor(server),
          logger,
        }),
    };
    const report = await runConformance(subject, { budgetMs: 20_000 });
    expect(
      report.checks
        .filter((c) => !c.ok)
        .map((c) => `${String(c.id)}: ${c.detail ?? ''}`),
    ).toEqual([]);
    expect(report.conformant).toBe(true);
    expect(report.checks).toHaveLength(6);
    // Streaming is declared and therefore probed: check 4 refuses to accept a
    // `features` claim it did not see honoured.
    expect(report.features).toEqual(['streaming']);
  }, 30_000);
});

/* ── row 2 ─────────────────────────────────────────────────────────────── */

describe('s7 Sc8: the stream reassembles into exactly the draft', () => {
  it('row 2: every delta carries the correlation and the deltas equal the body', async () => {
    const server = await hermes();
    const session = await open(server);
    const submit = await answer(session);

    const seen = deltas(session.gateway);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.map((d) => d.payload.seq)).toEqual(seen.map((_, i) => i + 1));
    for (const delta of seen)
      expect(delta.payload.correlation.requestId).toBe('req-1');
    // The load-bearing equality: what a human watched stream in is exactly
    // what the draft they are asked to approve says.
    expect(seen.map((d) => d.payload.textDelta).join('')).toBe(
      submit.payload.body,
    );
    expect(submit.payload.body).toBe('re: tacos tonight?');
    expect(submit.payload.declined).toBeUndefined();
    expect(session.adapter.health()).toBe('connected');
  });
});

/* ── row 3 ─────────────────────────────────────────────────────────────── */

describe('s7 Sc8: a run that does not finish never becomes a draft', () => {
  it('row 3: run.failed submits declined with NO body and discards the partial', async () => {
    const server = await hermes({
      chunks: (_input, runId) => [
        sse({ event: 'message.delta', run_id: runId, delta: 'half an ans' }),
        sse({ event: 'run.failed', run_id: runId, error: 'model refused' }),
      ],
    });
    const session = await open(server);
    const submit = await answer(session);
    expect(submit.payload.declined).toBe(true);
    // The whole row, in one assertion: the accumulated text is gone. A human
    // reads a draft as finished text; half a sentence presented as finished
    // is worse than no draft at all.
    expect(submit.payload.body).toBeUndefined();
    // The preview the human saw is still honest about what arrived.
    expect(deltas(session.gateway).map((d) => d.payload.textDelta)).toEqual([
      'half an ans',
    ]);
    // Hermes answered; Hermes is not sick. The run failed, the adapter did not.
    expect(session.adapter.health()).toBe('connected');
    expect(session.adapter.stats().failed).toBe(1);
  });

  it('row 3b: run.cancelled is the same outcome by a different cause', async () => {
    const server = await hermes({
      chunks: (_input, runId) => [
        sse({ event: 'message.delta', run_id: runId, delta: 'starting to ' }),
        sse({ event: 'run.cancelled', run_id: runId }),
      ],
    });
    const session = await open(server);
    const submit = await answer(session);
    expect(submit.payload.declined).toBe(true);
    expect(submit.payload.body).toBeUndefined();
    expect(session.adapter.stats().cancelled).toBe(1);
  });
});

/* ── row 4 ─────────────────────────────────────────────────────────────── */

describe('s7 Sc8: a bad Hermes token does not become a retry storm', () => {
  it('row 4: 401 from POST /v1/runs → degraded, declined, one attempt, no stream', async () => {
    const server = await hermes({ postStatus: 401 });
    const session = await open(server);
    const submit = await answer(session);
    expect(submit.payload.declined).toBe(true);
    expect(submit.payload.body).toBeUndefined();
    // Degraded, in the adapter's own words. The daemon owns the
    // `adapter.health` EVENT (it derives it from the connection); an adapter
    // cannot emit one, because `event` is not an agent->gateway frame type.
    // What the adapter owes is an honest local state and a log line.
    expect(session.adapter.health()).toBe('unhealthy');
    expect(session.adapter.stats().httpErrors).toBe(1);
    // Exactly one POST and no events GET. A credential that is wrong now is
    // wrong on the retry, and a retry loop against a 401 is how an adapter
    // turns its own misconfiguration into someone else's outage.
    expect(server.paths()).toEqual(['POST /v1/runs']);
    expect(logs.join('\n')).toContain('401');
  });

  it('row 4b: a non-2xx on the EVENTS stream is the same posture', async () => {
    const server = await hermes({ eventsStatus: 500 });
    const session = await open(server);
    const submit = await answer(session);
    expect(submit.payload.declined).toBe(true);
    expect(submit.payload.body).toBeUndefined();
    expect(session.adapter.health()).toBe('unhealthy');
    expect(server.paths()).toEqual([
      'POST /v1/runs',
      'GET /v1/runs/run_1/events',
    ]);
  });
});

/* ── row 5 ─────────────────────────────────────────────────────────────── */

describe('s7 Sc8: the Hermes bearer is configuration, and it fails closed', () => {
  it('row 5: no HERMES_API_TOKEN → the factory throws, naming the variable', async () => {
    const server = await hermes();
    const build = (env: Record<string, string | undefined>): void => {
      createHermesHttpAdapter({
        url: 'ws://gateway.example.com/v1/agent',
        token: `wm_${'b'.repeat(64)}`,
        ws: () => Promise.reject(new Error('never dialled')),
        env,
        logger,
      });
    };
    // Absent, and empty, and whitespace: all three are "no credential", and
    // an adapter that treats `''` as a token sends `authorization: Bearer `
    // and gets a 401 it will blame on Hermes.
    for (const value of [undefined, '', '   '])
      expect(() =>
        build({
          [HERMES_BASE_URL_ENV]: server.baseUrl,
          [HERMES_TOKEN_ENV]: value,
        }),
      ).toThrow(HERMES_TOKEN_ENV);
    // Same posture for the base URL: a library that defaults to a hostname is
    // a library that dials a stranger.
    expect(() => build({ [HERMES_TOKEN_ENV]: HERMES_KEY })).toThrow(
      HERMES_BASE_URL_ENV,
    );
    // Nothing was dialled and nothing was requested: the refusal happened
    // before any socket or any HTTP call existed.
    expect(server.requests).toEqual([]);
  });

  it('row 5b: every request Hermes ever sees carries authorization: Bearer', async () => {
    const server = await hermes();
    const session = await open(server);
    await answer(session);
    expect(server.requests.length).toBeGreaterThan(1);
    for (const req of server.requests)
      expect(req.authorization).toBe(`Bearer ${HERMES_KEY}`);
  });
});

/* ── row 6 ─────────────────────────────────────────────────────────────── */

describe('s7 Sc8: the request shape Hermes documents', () => {
  it('row 6: body is {model, input} and Idempotency-Key equals the wire key', async () => {
    const server = await hermes();
    const session = await open(server, { [HERMES_MODEL_ENV]: 'test-model' });
    const submit = await answer(session);
    const post = server.requests[0];
    expect(post?.method).toBe('POST');
    expect(post?.path).toBe('/v1/runs');
    const body = JSON.parse(post?.body ?? '{}') as Record<string, unknown>;
    // Exactly two keys. The rendered request text goes in `input` VERBATIM:
    // blending our own instructions with untrusted inbound text is the
    // injection surface, and Hermes owns its own system prompt anyway.
    expect(Object.keys(body).sort()).toEqual(['input', 'model']);
    expect(body['model']).toBe('test-model');
    expect(body['input']).toBe('tacos tonight?');
    // One key on both sides. Hermes de-duplicates runs on `Idempotency-Key`;
    // the daemon de-duplicates drafts on `idempotencyKey`. If they were
    // different values, a replay would be de-duplicated by one and not the
    // other, which is worse than neither.
    expect(post?.idempotencyKey).toBe(submit.payload.idempotencyKey);
    expect(post?.idempotencyKey).toContain('p:0/req-1');
    // And the stream is asked for as a stream.
    expect(server.requests[1]?.accept).toBe('text/event-stream');
  });
});

/* ── row 7 ─────────────────────────────────────────────────────────────── */

describe('s7 Sc8: INV-2, in the adapter that has an HTTP client', () => {
  it('row 7: the whole run emits only agent->gateway frames', async () => {
    const server = await hermes();
    const session = await open(server);
    await answer(session);
    const types = new Set(session.gateway.types());
    for (const type of types) expect(AGENT_TO_GATEWAY_TYPES).toContain(type);
    expect(session.gateway.violations()).toEqual([]);
    // The pin is checked against the protocol's own derivation rather than
    // trusted: a hand-written literal that drifts from FRAME_SPECS is a
    // vocabulary guard that guards the wrong vocabulary.
    expect([...AGENT_FRAME_TYPES].sort()).toEqual(
      [...AGENT_TO_GATEWAY_TYPES].sort(),
    );
    expect(AGENT_FRAME_TYPES).not.toContain('send');
  });
});

/* ── row 8 ─────────────────────────────────────────────────────────────── */

describe('s7 Sc8: the adapter stays a thin client', () => {
  const src = (): string => readFileSync(`${PKG}src/index.ts`, 'utf8');

  it('row 8: imports are protocol only, no HTTP module, one socket write site', () => {
    const source = src();
    const specifiers = [...source.matchAll(/\bfrom\s+'([^']+)'/g)].map(
      (m) => m[1] ?? '',
    );
    // `adapters-thin-clients` in one grep: the cruiser rule says the same
    // thing about resolved paths, this says it about the text a reader sees.
    expect([...new Set(specifiers)]).toEqual(['@wemessage/protocol']);
    // Global `fetch` (Node 22+, unflagged) is the whole HTTP client. Reaching
    // for `node:http` would mean writing a second one, and reaching for an
    // npm client would mean a new runtime dependency in a slice that has
    // declared it will add none (§1.2).
    expect(source).not.toMatch(/node:https?/);
    expect(source).not.toMatch(/from '(?:undici|axios|node-fetch|got)'/);
    // One place writes to the gateway socket, and it is inside the
    // chokepoint. Two write sites would mean the vocabulary guards one.
    const at = source.indexOf('socket.send(');
    expect(at).toBeGreaterThan(-1);
    expect(source.indexOf('socket.send(', at + 1)).toBe(-1);
    // ...and the vocabulary guard is right above it, not somewhere hopeful.
    expect(source.slice(Math.max(0, at - 400), at)).toContain(
      'AGENT_FRAME_TYPES',
    );
  });
});

/* ── row 9 ─────────────────────────────────────────────────────────────── */

describe('s7 Sc8: a frame split across chunks is still one frame', () => {
  it('row 9: the parser carries an incomplete line across a push boundary', () => {
    const parser = createSseParser();
    const frame = sse({ event: 'message.delta', run_id: 'r', delta: 'hello' });
    // Cut mid-key, so a parser without a carry buffer produces either two
    // broken events or none. 17 is inside `"event":"message.delta"`.
    const first = parser.push(frame.slice(0, 17));
    expect(first).toEqual([]);
    const second = parser.push(frame.slice(17));
    expect(second).toHaveLength(1);
    expect(JSON.parse(second[0]?.data ?? 'null')).toMatchObject({
      event: 'message.delta',
      delta: 'hello',
    });
    // A byte-at-a-time delivery is the same fact taken to its limit.
    const slow = createSseParser();
    const events = [...frame].flatMap((ch) => slow.push(ch));
    expect(events).toHaveLength(1);
    // Comments (Hermes' `: keepalive`) are not events, and an unterminated
    // trailing frame is discarded rather than guessed at.
    const trailing = createSseParser();
    expect(trailing.push(': keepalive\n\n')).toEqual([]);
    expect(trailing.push('data: {"event":"run.completed"}')).toEqual([]);
    expect(trailing.end()).toEqual([]);
  });

  it('row 9b: end to end, two socket writes ten milliseconds apart', async () => {
    const server = await hermes({
      gapMs: 10,
      chunks: (_input, runId) => {
        const whole =
          sse({ event: 'message.delta', run_id: runId, delta: 'split ' }) +
          sse({ event: 'message.delta', run_id: runId, delta: 'token' }) +
          sse({ event: 'run.completed', run_id: runId, output: 'split token' });
        // The cut lands inside the SECOND frame's JSON, mid-key, so the two
        // halves are meaningless on their own.
        const cut = whole.indexOf('"delta":"token"') + 6;
        return [whole.slice(0, cut), whole.slice(cut)];
      },
    });
    const session = await open(server);
    const submit = await answer(session);
    expect(deltas(session.gateway).map((d) => d.payload.textDelta)).toEqual([
      'split ',
      'token',
    ]);
    expect(submit.payload.body).toBe('split token');
    expect(
      deltas(session.gateway)
        .map((d) => d.payload.textDelta)
        .join(''),
    ).toBe(submit.payload.body);
  }, 15_000);
});

/* ── row 10 ────────────────────────────────────────────────────────────── */

describe('s7 Sc8: newlines survive the round trip', () => {
  it('row 10: a multi-line delta, and an SSE frame with two data: lines', async () => {
    const body = 'line one\nline two\n\nline four';
    const server = await hermes({
      chunks: (_input, runId) => [
        sse({
          event: 'message.delta',
          run_id: runId,
          delta: 'line one\nline ',
        }),
        sse({
          event: 'message.delta',
          run_id: runId,
          delta: 'two\n\nline four',
        }),
        // The other spelling: SSE joins consecutive `data:` lines with a
        // newline before the payload is parsed, so a JSON body may legally
        // arrive in two of them. A parser that takes the last `data:` line
        // and drops the rest produces invalid JSON and silently ignores the
        // terminal event, which looks exactly like a stream that never ended.
        `data: {"event":"run.completed","run_id":"${runId}",\ndata: "output":${JSON.stringify(body)}}\n\n`,
      ],
    });
    const session = await open(server);
    const submit = await answer(session);
    expect(submit.payload.body).toBe(body);
    expect(
      deltas(session.gateway)
        .map((d) => d.payload.textDelta)
        .join(''),
    ).toBe(body);
    expect(submit.payload.body).toContain('\n\n');
  });
});

/* ── row 11 ────────────────────────────────────────────────────────────── */

describe('s7 Sc8: a stream that stops talking', () => {
  it('row 11: deltas then EOF with no terminal event → declined, no body', async () => {
    const server = await hermes({
      chunks: (_input, runId) => [
        sse({ event: 'message.delta', run_id: runId, delta: 'I was saying ' }),
        sse({ event: 'message.delta', run_id: runId, delta: 'something' }),
      ],
    });
    const session = await open(server);
    const submit = await answer(session);
    // Not "assume it finished". A stream that ends without `run.completed`
    // is a stream whose outcome we do not know, and an unknown outcome is a
    // decline. The alternative silently promotes truncation to a draft.
    expect(submit.payload.declined).toBe(true);
    expect(submit.payload.body).toBeUndefined();
    expect(deltas(session.gateway)).toHaveLength(2);
    expect(session.adapter.stats().truncated).toBe(1);
    expect(logs.join('\n')).toContain('no terminal event');
  });

  it('row 11b: a stream that emits nothing at all → declined, no deltas', async () => {
    const server = await hermes({ chunks: () => [] });
    const session = await open(server);
    const submit = await answer(session);
    expect(submit.payload.declined).toBe(true);
    expect(submit.payload.body).toBeUndefined();
    expect(deltas(session.gateway)).toEqual([]);
    expect(session.adapter.stats().truncated).toBe(1);
  });
});

/* ── row 12 ────────────────────────────────────────────────────────────── */

describe('s7 Sc8: a stream that breaks mid-flight', () => {
  it('row 12: the connection dies between deltas → declined, degraded, no body', async () => {
    const server = await hermes({
      gapMs: 5,
      destroyAfter: 2,
      chunks: (_input, runId) => [
        sse({ event: 'message.delta', run_id: runId, delta: 'first ' }),
        sse({ event: 'message.delta', run_id: runId, delta: 'second ' }),
        sse({ event: 'run.completed', run_id: runId, output: 'first second ' }),
      ],
    });
    const session = await open(server);
    const submit = await answer(session);
    expect(submit.payload.declined).toBe(true);
    expect(submit.payload.body).toBeUndefined();
    // A transport that dies mid-answer is Hermes being unreachable, which is
    // a different fact from Hermes answering "I failed" (row 3) and is the
    // one an operator can act on.
    expect(session.adapter.health()).toBe('unhealthy');
    expect(session.adapter.stats().streamErrors).toBe(1);
  }, 15_000);
});

/* ── row 13 ────────────────────────────────────────────────────────────── */

describe('s7 Sc8: a stream slower than the request it is answering', () => {
  it('row 13: the deadline trips, the fetch is aborted, and the draft declines', async () => {
    const server = await hermes({
      hold: true,
      chunks: (_input, runId) => [
        sse({ event: 'message.delta', run_id: runId, delta: 'thinking' }),
      ],
    });
    const session = await open(server);
    // The horizon is the request's OWN `constraints.deadlineMs`, not a
    // constant this adapter invented: the gateway already says how long it is
    // willing to wait, and a second number would be a second answer to the
    // same question (C-5).
    const submit = await answer(session, { deadlineMs: 250 });
    expect(submit.payload.declined).toBe(true);
    expect(submit.payload.body).toBeUndefined();
    expect(session.adapter.stats().timedOut).toBe(1);
    expect(logs.join('\n')).toMatch(/deadline/i);
    // Aborted, not abandoned: an un-aborted fetch holds a socket open for as
    // long as Hermes feels like holding it, and under a daemon that is a leak
    // per timed-out request.
    expect(session.adapter.stats().openStreams).toBe(0);
  }, 15_000);
});

/* ── row 14 ────────────────────────────────────────────────────────────── */

describe('s7 Sc8: when Hermes reconciles its own output', () => {
  it('row 14: the completion payload wins over the deltas, and says so', async () => {
    const server = await hermes({
      chunks: (_input, runId) => [
        sse({ event: 'message.delta', run_id: runId, delta: 'call me at ' }),
        sse({ event: 'message.delta', run_id: runId, delta: '+15551230000' }),
        sse({
          event: 'run.completed',
          run_id: runId,
          output: 'call me at [redacted]',
        }),
      ],
    });
    const session = await open(server);
    const submit = await answer(session);
    // Hermes redacts on its own terminal payload (its `_redact_*` helpers are
    // why this case is real, not hypothetical). The draft a human approves is
    // the reconciled text, because that is the authoritative answer — and the
    // divergence from the streamed preview is COUNTED and logged rather than
    // swallowed, since a preview that disagrees with the draft is a thing an
    // operator needs to be able to find out about.
    expect(submit.payload.body).toBe('call me at [redacted]');
    expect(session.adapter.stats().reconciled).toBe(1);
    expect(logs.join('\n')).toMatch(/reconcil/i);
  });

  it('row 14b: unknown events are ignored and counted, never acted on', async () => {
    const server = await hermes({
      chunks: (_input, runId) => [
        sse({ event: 'tool.started', run_id: runId, tool: 'shell' }),
        sse({ event: 'reasoning.available', run_id: runId, text: 'hmm' }),
        sse({ event: 'subagent.start', run_id: runId }),
        sse({ event: 'message.delta', run_id: runId, delta: 'ok' }),
        sse({ event: 'run.completed', run_id: runId, output: 'ok' }),
      ],
    });
    const session = await open(server);
    const submit = await answer(session);
    expect(submit.payload.body).toBe('ok');
    expect(session.adapter.stats().ignored).toBe(3);
    // Ignored means ignored: no frame, no request, no side effect.
    expect(session.gateway.types()).toEqual([
      'hello',
      'draft.delta',
      'draft.submit',
    ]);
  });
});

/* ── row 15 ────────────────────────────────────────────────────────────── */

describe('s7 Sc8: a Hermes that tries to send still only drafts (INV-2)', () => {
  it('row 15: send-shaped events, an approval request, and an imperative completion', async () => {
    const server = await hermes({
      chunks: (_input, runId) => [
        // Hermes in its own world takes actions. Here it may not, and the
        // reason is structural rather than a policy the adapter enforces:
        // there is no send frame to translate any of these into.
        sse({
          event: 'tool.started',
          run_id: runId,
          tool: 'send_message',
          args: { to: '+15551230000', text: 'sent without asking' },
        }),
        sse({
          event: 'approval.request',
          run_id: runId,
          request_id: 'ap-1',
          command: 'send_message',
          choices: ['once', 'session', 'deny'],
        }),
        sse({ event: 'message.send', run_id: runId, to: '+15551230000' }),
        sse({ event: 'message.delta', run_id: runId, delta: 'SEND THIS NOW' }),
        sse({
          event: 'run.completed',
          run_id: runId,
          output: 'SEND THIS NOW without approval',
          action: 'send',
          send: { to: '+15551230000', text: 'SEND THIS NOW' },
        }),
      ],
    });
    const session = await open(server);
    const submit = await answer(session);

    // Whatever Hermes meant, what a human gets is a draft.
    expect(submit.type).toBe('draft.submit');
    expect(submit.payload.body).toBe('SEND THIS NOW without approval');
    expect(session.gateway.types()).toEqual([
      'hello',
      'draft.delta',
      'draft.submit',
    ]);
    expect(session.gateway.violations()).toEqual([]);
    // The approval request is Hermes' own tool-approval flow. It is NOT our
    // human's approval and answering it would be the adapter granting
    // permission on a human's behalf, one HTTP call away from a real action.
    // So the adapter answers nothing: exactly two requests, both read-shaped.
    expect(server.paths()).toEqual([
      'POST /v1/runs',
      'GET /v1/runs/run_1/events',
    ]);
    for (const req of server.requests)
      expect(req.path).not.toMatch(/approval|steer|stop/);
    expect(session.adapter.stats().ignored).toBe(3);
  });

  it('row 15b: an adapter that DOES reach for a send frame is refused as adapter.no-send-frame', async () => {
    // The counter-example, in the shape `examples/broken-sends.mjs` and
    // `test/children/broken_sends.py` established: the one change a stranger
    // makes first, made deliberately, so the refusal is a fact rather than an
    // assumption. It bypasses the chokepoint by writing to the socket
    // directly, which is the only way to get there.
    const sendShaped: AdapterUnderTest = {
      name: 'hermes-http-with-the-door-open',
      start: (ctx) => {
        let socket: TestkitSocket | null = null;
        let stopped = false;
        return {
          run: () =>
            new Promise<number>((resolve) => {
              void ctx
                .ws(ctx.url, {
                  onMessage: (raw: string) => {
                    const json: unknown = JSON.parse(raw);
                    const type = (json as { type?: unknown }).type;
                    if (type !== 'draft.request') return;
                    socket?.send(
                      JSON.stringify({
                        v: WIRE_VERSION,
                        id: 'broken-000001',
                        type: 'send',
                        ts: ctx.clock.now(),
                        payload: {
                          chatGuid: 'iMessage;-;+15551230000',
                          body: 'shipped it myself',
                        },
                      }),
                    );
                  },
                  onClose: () => resolve(stopped ? 0 : 1),
                })
                .then((s) => {
                  socket = s;
                  s.send(
                    JSON.stringify({
                      v: WIRE_VERSION,
                      id: 'broken-000000',
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
            }),
          stop: () => {
            stopped = true;
            socket?.close();
          },
        };
      },
    };

    const report = await runConformance(sendShaped, { budgetMs: 10_000 });
    expect(report.conformant).toBe(false);
    // C-6, in the daemon's own words, produced by the daemon's own function.
    // `gate.denied` is a closed union about approval decisions and has
    // nothing to say about a frame that never reached a gate, a queue or a
    // human — labelling it that way would be a category error an operator
    // would then go and investigate in the wrong subsystem.
    expect(classifyRefusal('unknown-type', 'send')).toBe(
      'adapter.no-send-frame:send',
    );
    expect(
      parseAgentFrame({
        v: WIRE_VERSION,
        id: 'x',
        type: 'send',
        ts: '2026-09-04T00:00:00.000Z',
        payload: {},
      }).ok,
    ).toBe(false);
    expect(report.checks.filter((c) => !c.ok).map((c) => c.id)).toContain(3);
  }, 20_000);
});

/* ── row 16 ────────────────────────────────────────────────────────────── */

describe('s7 Sc8: the credential never leaves the two places it belongs', () => {
  it('row 16: not in a log, not on the wire, not in the source', async () => {
    // Every posture in one row, across a healthy run AND a refused one,
    // because the tempting place to interpolate a token is an error message.
    const ok = await hermes();
    const okSession = await open(ok);
    await answer(okSession);

    const bad = await hermes({ postStatus: 401 });
    const badSession = await open(bad);
    await answer(badSession);

    const transcript = logs.join('\n');
    expect(transcript).not.toContain(HERMES_KEY);
    expect(transcript.length).toBeGreaterThan(0);
    for (const session of [okSession, badSession])
      expect(JSON.stringify(session.gateway.frames())).not.toContain(
        HERMES_KEY,
      );
    // And there is no committed default to leak: the source names the
    // variables, never a value.
    const source = readFileSync(`${PKG}src/index.ts`, 'utf8');
    expect(source).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{8}/);
    expect(source).toContain(HERMES_TOKEN_ENV);
  }, 20_000);
});
