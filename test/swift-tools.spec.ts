/**
 * v2 S3b: tools/swift/fake-daemon.mjs, the S0 goldens served over loopback
 * for the CI UI lane (docs/plans/v2-swift-S3.md §3.10, §4.9, §5.2 F1-F9).
 *
 * The CI `ui` job is the only place the window meets this server, and it
 * runs on one runner image. These rows are the local proof: the pure parts
 * (argument parsing, the token shape, the golden index, the routing table)
 * are called directly, and F8/F9 start the real server on port 0, bound to
 * 127.0.0.1, for the length of one test.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  initialState,
  loadGoldens,
  mintToken,
  parseArgs,
  route,
  start,
} from '../tools/swift/fake-daemon.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const contract = join(repoRoot, 'fixtures/contract');

function golden(rel: string): { route: string; status: number; body: unknown } {
  return JSON.parse(readFileSync(join(contract, rel), 'utf8')) as {
    route: string;
    status: number;
    body: unknown;
  };
}

/** Bytes the route answered, whatever shape the body took. */
function bodyOf(answer: { body?: unknown }): unknown {
  return answer.body;
}

const TOKEN = mintToken(Buffer.alloc(32, 7));

describe('v2 S3b F1: parseArgs', () => {
  it('reads --dir, --port and --pid-file', () => {
    expect(
      parseArgs(
        ['--dir', '/x/wm', '--port', '47191', '--pid-file', '/x/p'],
        {},
      ),
    ).toEqual({ dir: '/x/wm', port: 47191, pidFile: '/x/p', control: false });
  });
  it('falls back to WEMESSAGE_DIR and WEMESSAGE_PORT, then 47100', () => {
    expect(
      parseArgs([], { WEMESSAGE_DIR: '/e/wm', WEMESSAGE_PORT: '47192' }),
    ).toEqual({ dir: '/e/wm', port: 47192, pidFile: null, control: false });
    expect(parseArgs([], { WEMESSAGE_DIR: '/e/wm' })).toEqual({
      dir: '/e/wm',
      port: 47100,
      pidFile: null,
      control: false,
    });
  });
  it('allows port 0 (the OS picks)', () => {
    expect(parseArgs(['--dir', '/x', '--port', '0'], {}).port).toBe(0);
  });
  it('throws without a directory, and on an unknown flag', () => {
    expect(() => parseArgs([], {})).toThrow();
    expect(() => parseArgs(['--dir', '/x', '--host', '0.0.0.0'], {})).toThrow();
  });
});

describe('v2 S3b F2: mintToken', () => {
  it('is wm_ plus 64 lowercase hex over 32 bytes in', () => {
    expect(TOKEN).toMatch(/^wm_[0-9a-f]{64}$/);
    expect(mintToken()).toMatch(/^wm_[0-9a-f]{64}$/);
    expect(mintToken()).not.toBe(mintToken());
    const bytes = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    expect(mintToken(bytes)).toBe('wm_' + bytes.toString('hex'));
  });
});

describe('v2 S3b F3: loadGoldens', () => {
  it('keys responses by each golden route field, never by file name', () => {
    const g = loadGoldens(contract);
    for (const key of [
      'GET /v1/health',
      'GET /v1/status',
      'GET /v1/threads',
      'GET /v1/drafts',
    ]) {
      expect(g.responses.has(key), key).toBe(true);
    }
    expect(g.responses.has('health.json')).toBe(false);
    // Two goldens share GET /v1/drafts; the window's first read is the empty list.
    expect(g.responses.get('GET /v1/drafts')?.body).toEqual(
      golden('responses/drafts.list.empty.json').body,
    );
    expect(g.wire.sse.keepaliveMs).toBe(15000);
    expect(g.sse.greeting.length).toBe(92);
  });
});

describe('v2 S3b F4-F7: route', () => {
  const g = loadGoldens(contract);
  const call = (method: string, path: string, auth?: string) =>
    route({ method, path, authorization: auth }, TOKEN, g);

  it('F4 health needs no bearer', () => {
    const a = call('GET', '/v1/health');
    expect(a.status).toBe(200);
    expect(bodyOf(a)).toEqual(golden('responses/health.json').body);
  });
  it('F5 status: missing, wrong (same and different length) and right bearer', () => {
    const missing = call('GET', '/v1/status');
    expect(missing.status).toBe(401);
    expect(bodyOf(missing)).toEqual(golden('errors/401.missing.json').body);
    const wrong = call(
      'GET',
      '/v1/status',
      `Bearer ${mintToken(Buffer.alloc(32, 9))}`,
    );
    expect(wrong.status).toBe(401);
    expect(bodyOf(wrong)).toEqual(golden('errors/401.unauthorized.json').body);
    const short = call('GET', '/v1/status', 'Bearer wm_');
    expect(short.status).toBe(401);
    const prefix = call('GET', '/v1/status', `Bearer ${TOKEN}0`);
    expect(prefix.status).toBe(401);
    const right = call('GET', '/v1/status', `Bearer ${TOKEN}`);
    expect(right.status).toBe(200);
    expect(bodyOf(right)).toEqual(golden('responses/status.json').body);
  });
  it('F5b drafts and threads answer the goldens with a bearer, ignoring the query', () => {
    const drafts = call('GET', '/v1/drafts?limit=50', `Bearer ${TOKEN}`);
    expect(drafts.status).toBe(200);
    expect(bodyOf(drafts)).toEqual(
      golden('responses/drafts.list.empty.json').body,
    );
    const threads = call('GET', '/v1/threads', `Bearer ${TOKEN}`);
    expect(threads.status).toBe(200);
    expect(bodyOf(threads)).toEqual(golden('responses/threads.list.json').body);
    expect(call('GET', '/v1/threads').status).toBe(401);
  });
  it('F5c POST /v1/drafts answers the create golden (201) with a bearer, and 401 without (S4j)', () => {
    const created = call('POST', '/v1/drafts', `Bearer ${TOKEN}`);
    expect(created.status).toBe(201);
    expect(bodyOf(created)).toEqual(
      golden('responses/drafts.create.json').body,
    );
    expect(call('POST', '/v1/drafts').status).toBe(401);
    // The send route stays parked: a compose reaches the queue, never /v1/send.
    expect(call('POST', '/v1/send', `Bearer ${TOKEN}`).status).toBe(409);
  });
  it('F6 schedules, send and toggles are parked (409)', () => {
    const parked = golden('errors/409.parked.json').body;
    for (const [m, p] of [
      ['POST', '/v1/schedules'],
      ['POST', '/v1/send'],
      ['POST', '/v1/toggles/kill-switch'],
      ['PATCH', '/v1/toggles/pause'],
    ] as const) {
      const a = call(m, p, `Bearer ${TOKEN}`);
      expect(a.status, `${m} ${p}`).toBe(409);
      expect(bodyOf(a)).toEqual(parked);
    }
  });
  it('F7 anything else is 404', () => {
    const a = call('GET', '/v1/nothing-here', `Bearer ${TOKEN}`);
    expect(a.status).toBe(404);
    expect(bodyOf(a)).toEqual(golden('errors/404.not-found.json').body);
    expect(call('DELETE', '/v1/health').status).toBe(404);
  });
});

describe('v2 S3b F8-F9: start on port 0', () => {
  let dir = '';
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (close) await close();
    close = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  async function boot() {
    dir = mkdtempSync(join(tmpdir(), 'wm-fake-daemon-'));
    const lines: string[] = [];
    const daemon = await start({
      dir: join(dir, 'wm'),
      port: 0,
      pidFile: join(dir, 'pid'),
      write: (s: string) => lines.push(s),
    });
    close = daemon.close;
    return { daemon, lines };
  }

  it('F8 writes a 0600 token, prints one ready line, and serves health and the stream', async () => {
    const { daemon, lines } = await boot();
    const tokenPath = join(dir, 'wm', 'daemon.token');
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(tokenPath, 'utf8')).toBe(daemon.token + '\n');
    expect(readFileSync(join(dir, 'pid'), 'utf8').trim()).toBe(
      String(process.pid),
    );
    expect(daemon.port).toBeGreaterThan(0);
    expect(daemon.server.address()).toMatchObject({
      address: '127.0.0.1',
      port: daemon.port,
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith('\n')).toBe(true);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      ready: true,
      port: daemon.port,
      dir: join(dir, 'wm'),
    });

    const base = `http://127.0.0.1:${daemon.port}`;
    const health = await fetch(`${base}/v1/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual(golden('responses/health.json').body);

    const ac = new AbortController();
    const sse = await fetch(`${base}/v1/events/sse`, {
      headers: { authorization: `Bearer ${daemon.token}` },
      signal: ac.signal,
    });
    expect(sse.status).toBe(200);
    expect(sse.headers.get('content-type')).toBe('text/event-stream');
    const greeting = readFileSync(join(contract, 'sse/greeting.txt'));
    const reader = sse.body!.getReader();
    let got = Buffer.alloc(0);
    while (got.length < greeting.length) {
      const { value, done } = await reader.read();
      if (done) break;
      got = Buffer.concat([got, Buffer.from(value)]);
    }
    expect(got.subarray(0, greeting.length).equals(greeting)).toBe(true);
    ac.abort();
    await reader.cancel().catch(() => undefined);

    const refused = await fetch(`${base}/v1/events/sse`);
    expect(refused.status).toBe(401);
    await refused.body?.cancel();
  });

  it('F9 the token is never in what the daemon prints', async () => {
    const { daemon, lines } = await boot();
    expect(daemon.token).toMatch(/^wm_[0-9a-f]{64}$/);
    for (const line of lines) {
      expect(line).not.toContain(daemon.token);
      expect(line).not.toContain('wm_');
    }
  });
});

/**
 * v2 F3d (G-06a): the fake daemon keeps Done, Snooze and Mute the way the
 * daemon does, so a UI test can act, relaunch the app against the same
 * process and still see the act. The rules are the daemon's
 * (packages/daemon/src/routes/thread-state.ts): a strict body, an
 * ifUpdatedAt check that answers 409 with the record that won, a cleared
 * record deleted, wake computed against the request clock. Base records come
 * from the scenario chain only, never from S0, so no other board's queue
 * moves (deviation D20).
 */
describe('v2 F3d T1-T9: thread state on the fake daemon', () => {
  const g = loadGoldens();
  type State = ReturnType<typeof initialState>;
  const NOW = '2026-09-01T12:30:00.000Z';
  const DANIEL = 'iMessage;-;+15550100002';
  const MAYA = 'iMessage;-;+15550100001';
  const enc = encodeURIComponent;

  function step(
    state: State,
    req: {
      method: string;
      path: string;
      body?: unknown;
      auth?: boolean;
      now?: string;
    },
  ) {
    const out = route(
      {
        method: req.method,
        path: req.path,
        authorization: req.auth === false ? undefined : `Bearer ${TOKEN}`,
        remote: '127.0.0.1',
        now: req.now ?? NOW,
        body:
          req.body === undefined
            ? undefined
            : typeof req.body === 'string'
              ? req.body
              : JSON.stringify(req.body),
      },
      TOKEN,
      g,
      state,
    );
    return { out, state: out.next ?? state };
  }
  const scenario = (name: string): State =>
    step(initialState({ control: true }), {
      method: 'POST',
      path: '/v1/_scenario',
      body: { name },
    }).state;
  const list = (state: State, now = NOW) =>
    step(state, { method: 'GET', path: '/v1/threads/state', now });
  const put = (state: State, guid: string, body: unknown, now = NOW) =>
    step(state, {
      method: 'PUT',
      path: `/v1/threads/${enc(guid)}/state`,
      body,
      now,
    });
  const states = (out: { body?: unknown }) =>
    (out.body as { states: Array<Record<string, unknown>> }).states;

  it('T1 GET /v1/threads/state: the thread-state scenario seeds one snooze on Daniel; default and rich seed none', () => {
    const seeded = list(scenario('thread-state'));
    expect(seeded.out.status).toBe(200);
    expect(seeded.out.body).toEqual({
      states: [
        {
          chatGuid: DANIEL,
          act: 'snoozed',
          actAt: '2026-09-01T11:00:00.000Z',
          snoozedUntil: '2026-09-02T09:00:00.000Z',
          attention: null,
          updatedAt: '2026-09-01T11:00:00.000Z',
          awake: false,
        },
      ],
      asOf: NOW,
    });
    expect(states(list(initialState()).out)).toEqual([]);
    expect(states(list(scenario('rich')).out)).toEqual([]);
    expect(states(list(scenario('pending')).out)).toEqual([]);
  });

  it('T2 wake is computed against the request clock, never stored', () => {
    const state = scenario('thread-state');
    const later = list(state, '2026-09-02T09:00:00.000Z');
    expect(states(later.out)[0]?.awake).toBe(true);
    expect(later.out.body).toMatchObject({ asOf: '2026-09-02T09:00:00.000Z' });
    expect(states(list(later.state).out)[0]?.awake).toBe(false);
  });

  it('T3 PUT stores the act, stamps actAt and updatedAt with the request clock, and GET then serves it', () => {
    const first = put(scenario('rich'), MAYA, {
      act: 'done',
      ifUpdatedAt: null,
    });
    expect(first.out.status).toBe(200);
    const done = {
      chatGuid: MAYA,
      act: 'done',
      actAt: NOW,
      snoozedUntil: null,
      attention: null,
      updatedAt: NOW,
      awake: false,
    };
    expect(first.out.body).toEqual({ state: done });
    expect(states(list(first.state).out)).toEqual([done]);

    const snoozed = put(
      first.state,
      MAYA,
      {
        act: 'snoozed',
        snoozedUntil: '2026-09-02T09:00:00.000Z',
        ifUpdatedAt: NOW,
      },
      '2026-09-01T12:31:00.000Z',
    );
    expect(snoozed.out.status).toBe(200);
    expect(snoozed.out.body).toMatchObject({
      state: {
        act: 'snoozed',
        actAt: '2026-09-01T12:31:00.000Z',
        snoozedUntil: '2026-09-02T09:00:00.000Z',
        updatedAt: '2026-09-01T12:31:00.000Z',
      },
    });
  });

  it('T4 a restore (undo) keeps its own actAt; a cleared act with no attention deletes the record, even a seeded one', () => {
    const base = scenario('thread-state');
    const restored = put(base, MAYA, {
      act: 'muted',
      actAt: '2026-09-01T10:00:00.000Z',
      ifUpdatedAt: null,
    });
    expect(restored.out.body).toMatchObject({
      state: {
        act: 'muted',
        actAt: '2026-09-01T10:00:00.000Z',
        updatedAt: NOW,
      },
    });
    const cleared = put(restored.state, DANIEL, {
      act: null,
      ifUpdatedAt: '2026-09-01T11:00:00.000Z',
    });
    expect(cleared.out.status).toBe(200);
    expect(cleared.out.body).toEqual({ state: null });
    expect(states(list(cleared.state).out).map((s) => s.chatGuid)).toEqual([
      MAYA,
    ]);
  });

  it('T5 a stale ifUpdatedAt is 409 conflict carrying the record that won, and changes nothing', () => {
    const base = scenario('thread-state');
    const stale = put(base, DANIEL, { act: 'done', ifUpdatedAt: null });
    expect(stale.out.status).toBe(409);
    expect(stale.out.body).toEqual({
      error: 'conflict',
      detail: { current: states(list(base).out)[0] },
    });
    expect(stale.state.threadState).toEqual(base.threadState);
    const missing = put(base, MAYA, {
      act: 'done',
      ifUpdatedAt: '2026-09-01T11:00:00.000Z',
    });
    expect(missing.out.status).toBe(409);
    expect(missing.out.body).toEqual({
      error: 'conflict',
      detail: { current: null },
    });
    // Omitted: no check at all, as the daemon does.
    expect(put(base, DANIEL, { act: 'done' }).out.status).toBe(200);
  });

  it('T6 a bad body is the S0 400 invalid-thread-state, and changes nothing', () => {
    const invalid = golden('errors/400.invalid-thread-state.json').body;
    const base = scenario('rich');
    for (const bad of [
      'not json',
      [],
      {},
      { act: 'archived' },
      { act: 'snoozed' },
      { act: 'done', snoozedUntil: '2026-09-02T09:00:00.000Z' },
      { act: 'done', seenAt: NOW },
      { act: 'done', attention: 'loud' },
      { act: 'done', ifUpdatedAt: 'yesterday' },
      { act: null, actAt: '2026-09-01T10:00:00.000Z' },
      { act: 'done', actAt: '2026-09-01T13:00:00.000Z' },
    ]) {
      const out = put(base, MAYA, bad);
      expect([bad, out.out.status, out.out.body]).toEqual([bad, 400, invalid]);
      expect(out.state.threadState, JSON.stringify(bad)).toEqual({});
    }
  });

  it('T7 both routes need the bearer, and an act frame reaches every open stream', () => {
    const base = scenario('rich');
    expect(
      step(base, { method: 'GET', path: '/v1/threads/state', auth: false }).out
        .status,
    ).toBe(401);
    const refused = step(base, {
      method: 'PUT',
      path: `/v1/threads/${enc(MAYA)}/state`,
      body: { act: 'done' },
      auth: false,
    });
    expect(refused.out.status).toBe(401);
    expect(refused.state.threadState).toEqual({});

    const acted = put(base, MAYA, { act: 'done' });
    const frame = String(acted.out.emit ?? '');
    expect(frame).toMatch(/^id: \d+\nevent: thread\.state\ndata: /);
    const data = JSON.parse(/^data: (.*)$/m.exec(frame)?.[1] ?? 'null');
    expect(data).toEqual({
      event: 'thread.state',
      chatGuid: MAYA,
      state: (acted.out.body as { state: unknown }).state,
    });
  });

  it('T8 the journal carries the sorted body keys of a state write, so a UI test can ban seenAt', () => {
    const acted = put(scenario('rich'), MAYA, {
      ifUpdatedAt: null,
      act: 'done',
    });
    expect(acted.state.journal.at(-1)).toEqual({
      method: 'PUT',
      path: `/v1/threads/${enc(MAYA)}/state`,
      query: '',
      status: 200,
      bodyKeys: ['act', 'ifUpdatedAt'],
    });
    const listed = list(acted.state);
    expect(listed.state.journal.at(-1)).toEqual({
      method: 'GET',
      path: '/v1/threads/state',
      query: '',
      status: 200,
    });
  });

  it('T9 a scenario switch and a reset drop every write', () => {
    const acted = put(scenario('thread-state'), MAYA, { act: 'done' });
    expect(states(list(acted.state).out)).toHaveLength(2);
    const switched = step(acted.state, {
      method: 'POST',
      path: '/v1/_scenario',
      body: { name: 'thread-state' },
    }).state;
    expect(states(list(switched).out).map((s) => s.chatGuid)).toEqual([DANIEL]);
    const reset = step(acted.state, {
      method: 'POST',
      path: '/v1/_reset',
    }).state;
    expect(reset.threadState).toEqual({});
    expect(states(list(reset).out)).toEqual([]);
  });
});

describe('v2 F3d T10: an act survives a new connection (the relaunch, over a socket)', () => {
  let dir = '';
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (close) await close();
    close = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('T10 PUT on one connection, GET on a fresh one: the snooze is still there', async () => {
    dir = mkdtempSync(join(tmpdir(), 'wm-fake-daemon-'));
    const daemon = await start({
      dir: join(dir, 'wm'),
      port: 0,
      control: true,
      write: () => undefined,
    });
    close = daemon.close;
    const base = `http://127.0.0.1:${daemon.port}`;
    const auth = { authorization: `Bearer ${daemon.token}` };
    const switched = await fetch(`${base}/v1/_scenario`, {
      method: 'POST',
      body: JSON.stringify({ name: 'rich' }),
    });
    expect(switched.status).toBe(200);
    await switched.body?.cancel();
    const guid = 'iMessage;-;+15550100001';
    const wrote = await fetch(
      `${base}/v1/threads/${encodeURIComponent(guid)}/state`,
      {
        method: 'PUT',
        headers: {
          ...auth,
          'content-type': 'application/json',
          connection: 'close',
        },
        body: JSON.stringify({
          act: 'snoozed',
          snoozedUntil: '2099-01-01T09:00:00.000Z',
          ifUpdatedAt: null,
        }),
      },
    );
    expect(wrote.status).toBe(200);
    await wrote.body?.cancel();
    const read = await fetch(`${base}/v1/threads/state`, {
      headers: { ...auth, connection: 'close' },
    });
    expect(read.status).toBe(200);
    const page = (await read.json()) as {
      states: Array<{ chatGuid: string; act: string; awake: boolean }>;
    };
    expect(page.states.map((s) => [s.chatGuid, s.act, s.awake])).toEqual([
      [guid, 'snoozed', false],
    ]);
  });
});
