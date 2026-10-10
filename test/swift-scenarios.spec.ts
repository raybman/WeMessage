/**
 * v2 S4b: fake daemon scenarios, the control surface and SSE replay
 * (docs/plans/v2-swift-S4.md, S4b, advisor item 3).
 *
 * The pure parts are called directly: `route()` takes a scenario state and
 * hands back the next one, so purity, reset and the journal are asserted
 * without a socket. The control routes are then proven over a real
 * 127.0.0.1 socket, with and without --control. The last block validates
 * every file under fixtures/scenarios against the S0 contract it overlays:
 * routes and statuses that exist, bodies shaped like the goldens, stream
 * frames shaped like fixtures/events, and synthetic data only. The Swift
 * twin (ScenarioFixtureTests) decodes the same files through the strict DTOs.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { publicStringOffenders } from '../packages/cli/test/helpers/transcript-lint.js';
import {
  DEFAULT_SCENARIO,
  initialState,
  loadGoldens,
  loadScenarios,
  mintToken,
  parseArgs,
  replay,
  route,
  start,
} from '../tools/swift/fake-daemon.mjs';
import {
  BULK,
  MESSAGES_PAGE,
  THREADS_PAGE,
  generateBulk,
} from '../tools/swift/bulk.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const contract = join(repoRoot, 'fixtures/contract');
const scenariosDir = join(repoRoot, 'fixtures/scenarios');
const eventsDir = join(repoRoot, 'fixtures/events');

const TOKEN = mintToken(Buffer.alloc(32, 7));
const AUTH = `Bearer ${TOKEN}`;
const LOOP = '127.0.0.1';
const NOW = '2026-09-01T12:30:00.000Z';

/**
 * v2 B0: the channel state only the fake daemon serves. The word may appear
 * under fixtures/scenarios/preview-* and nowhere else in the tree; the
 * quoted state value is what opens a board over fixtures.
 */
const FIXTURE_WORD_RE = /preview/i;
const FIXTURE_STATE = '"state": "preview"';

const EXPECTED_SCENARIOS = [
  'bulk',
  'degraded',
  'empty-earned',
  'fda-denied',
  'kill',
  'pending',
  'preview-email',
  'preview-linkedin',
  'preview-linkedin-ratelimited',
  'preview-voice',
  'preview-voice-confirm',
  'preview-voice-interrupted',
  'preview-voice-misheard',
  'preview-voice-muted',
  'preview-voice-selfheard',
  'preview-voice-speaking',
  'preview-voice-transport',
  'preview-voice-unheard',
  'preview-whatsapp',
  'preview-whatsapp-empty',
  'quiet',
  'rich',
  'search',
];

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Golden = { route: string; status: number; body: Json };
type State = ReturnType<typeof initialState>;
type Req = Parameters<typeof route>[0];

function readJson<T = Json>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    for (const v of Object.values(value as object)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

const g = loadGoldens();

/** One request through route(), threading the state like start() does. */
function step(state: State, req: Req) {
  const out = route(
    { remote: LOOP, authorization: AUTH, now: NOW, ...req },
    TOKEN,
    g,
    state,
  );
  return { out, state: out.next ?? state };
}

function body(out: { body?: unknown }): Record<string, Json> {
  return out.body as Record<string, Json>;
}

function controlled(): State {
  return initialState({ control: true });
}

function switchTo(name: string, state: State = controlled()): State {
  const { out, state: next } = step(state, {
    method: 'POST',
    path: '/v1/_scenario',
    body: JSON.stringify({ name }),
  });
  expect(out.status, name).toBe(200);
  return next;
}

describe('v2 S4b SC1: parseArgs --control', () => {
  it('is a flag without a value, off by default', () => {
    expect(parseArgs(['--dir', '/x', '--control'], {})).toEqual({
      dir: '/x',
      port: 47100,
      pidFile: null,
      control: true,
    });
    expect(
      parseArgs(['--control', '--dir', '/x', '--port', '0'], {}).control,
    ).toBe(true);
    expect(parseArgs(['--dir', '/x'], {}).control).toBe(false);
  });
});

describe('v2 S4b SC2: loadScenarios', () => {
  it('finds the twenty-two shipped scenarios, and "default" is not one of them', () => {
    const map = loadScenarios();
    expect([...map.keys()]).toEqual(EXPECTED_SCENARIOS);
    expect(map.has(DEFAULT_SCENARIO)).toBe(false);
    expect(map.get('pending')?.parent).toBe('rich');
    expect(map.get('rich')?.parent).toBe(null);
    for (const s of map.values()) expect(s.summary.length).toBeGreaterThan(20);
  });

  describe('rejects a broken tree', () => {
    let dir = '';
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = '';
    });
    function tree(entries: Record<string, object>): string {
      dir = mkdtempSync(join(tmpdir(), 'wm-scenarios-'));
      for (const [name, meta] of Object.entries(entries)) {
        mkdirSync(join(dir, name));
        writeFileSync(join(dir, name, 'scenario.json'), JSON.stringify(meta));
      }
      return dir;
    }
    it('a reserved "default"', () => {
      expect(() => loadScenarios(tree({ default: { summary: 's' } }))).toThrow(
        /reserved/,
      );
    });
    it('an extends that names nothing', () => {
      expect(() =>
        loadScenarios(tree({ a: { summary: 's', extends: 'nope' } })),
      ).toThrow(/no scenario "nope"/);
    });
    it('an extends loop', () => {
      expect(() =>
        loadScenarios(
          tree({
            a: { summary: 's', extends: 'b' },
            b: { summary: 's', extends: 'a' },
          }),
        ),
      ).toThrow(/loops/);
    });
    it('a missing directory is no scenarios at all', () => {
      expect(loadScenarios(join(tmpdir(), 'wm-no-such-dir-s4b')).size).toBe(0);
    });
  });
});

describe('v2 S4b SC3: route is pure over (req, token, goldens, state)', () => {
  it('changes nothing it is given and answers the same twice', () => {
    let state = switchTo('pending');
    state = step(state, { method: 'GET', path: '/v1/status' }).state;
    const frozen = deepFreeze(structuredClone(state));
    const reqs: Req[] = [
      { method: 'GET', path: '/v1/drafts' },
      { method: 'POST', path: '/v1/drafts/drf-0101/approve', body: '{}' },
      { method: 'POST', path: '/v1/send', body: '{}' },
      { method: 'POST', path: '/v1/_scenario', body: '{"name":"kill"}' },
      { method: 'POST', path: '/v1/_reset' },
      { method: 'GET', path: '/v1/_journal' },
      { method: 'GET', path: '/v1/events/sse' },
    ];
    for (const req of reqs) {
      const a = step(frozen, req).out;
      const b = step(frozen, req).out;
      expect(a, `${req.method} ${req.path}`).toEqual(b);
    }
    expect(frozen).toEqual(state);
  });

  it('reads no clock: without req.now an approval keeps the golden time', () => {
    const state = switchTo('rich');
    const out = route(
      {
        method: 'POST',
        path: '/v1/drafts/drf-0101/approve',
        authorization: AUTH,
      },
      TOKEN,
      g,
      state,
    );
    const draft = body(out).draft as Record<string, Json>;
    expect(draft.stateChangedAt).toBe('2026-09-01T11:58:20.000Z');
    const again = route(
      {
        method: 'POST',
        path: '/v1/drafts/drf-0101/approve',
        authorization: AUTH,
      },
      TOKEN,
      g,
      state,
    );
    expect(again).toEqual(out);
  });

  it('defaults to a fresh state without --control', () => {
    const out = route({ method: 'GET', path: '/v1/health' }, TOKEN, g);
    expect(out.next).toEqual({
      ...initialState(),
      journal: [{ method: 'GET', path: '/v1/health', query: '', status: 200 }],
    });
  });
});

describe('v2 S4b SC4: control routes exist only with --control and a loopback peer', () => {
  const routes: Req[] = [
    { method: 'POST', path: '/v1/_scenario', body: '{"name":"rich"}' },
    { method: 'POST', path: '/v1/_reset' },
    { method: 'GET', path: '/v1/_journal' },
  ];
  const notFound = readJson<Golden>(
    join(contract, 'errors/404.not-found.json'),
  );

  it('404 without --control, even with the bearer', () => {
    for (const req of routes) {
      const out = route(
        { ...req, authorization: AUTH, remote: LOOP },
        TOKEN,
        g,
        initialState(),
      );
      expect(out.status, req.path).toBe(404);
      expect(out.body).toEqual(notFound.body);
      expect(out.next).toBeUndefined();
    }
  });
  it('404 with --control from a non-loopback or unknown peer', () => {
    for (const remote of ['10.0.0.5', '::1', '192.168.1.2', undefined]) {
      for (const req of routes) {
        const out = route({ ...req, remote }, TOKEN, g, controlled());
        expect(out.status, `${String(remote)} ${req.path}`).toBe(404);
        expect(out.next).toBeUndefined();
      }
    }
  });
  it('answers 127.0.0.1 and its v4-mapped form', () => {
    for (const remote of [LOOP, '::ffff:127.0.0.1']) {
      const out = route(
        { method: 'GET', path: '/v1/_journal', remote },
        TOKEN,
        g,
        controlled(),
      );
      expect(out.status).toBe(200);
    }
  });
  it('other /v1/_ paths are 404 even with --control', () => {
    for (const [method, path] of [
      ['GET', '/v1/_scenario'],
      ['GET', '/v1/_reset'],
      ['POST', '/v1/_journal'],
      ['POST', '/v1/_anything'],
    ] as const) {
      expect(
        step(controlled(), { method, path }).out.status,
        `${method} ${path}`,
      ).toBe(404);
    }
  });
  it('control calls are never journaled, app calls always are', () => {
    let state = controlled();
    state = step(state, { method: 'GET', path: '/v1/status' }).state;
    state = step(state, { method: 'GET', path: '/v1/_journal' }).state;
    state = switchTo('rich', state);
    state = step(state, { method: 'GET', path: '/v1/drafts?limit=50' }).state;
    state = step(state, { method: 'GET', path: '/v1/_nope' }).state;
    expect(state.journal).toEqual([
      { method: 'GET', path: '/v1/status', query: '', status: 200 },
      { method: 'GET', path: '/v1/drafts', query: 'limit=50', status: 200 },
    ]);
  });
});

describe('v2 S4b SC5: reset and the journal', () => {
  it('reset clears the scenario, the draft moves and the journal', () => {
    let state = switchTo('pending');
    state = step(state, {
      method: 'POST',
      path: '/v1/drafts/drf-0101/approve',
    }).state;
    state = step(state, { method: 'GET', path: '/v1/drafts' }).state;
    expect(state.journal).toHaveLength(2);
    expect(Object.keys(state.drafts)).toEqual(['drf-0101']);
    const { out, state: after } = step(state, {
      method: 'POST',
      path: '/v1/_reset',
    });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ scenario: 'default' });
    expect(after).toEqual(initialState({ control: true }));
    const journal = step(after, { method: 'GET', path: '/v1/_journal' }).out;
    expect(journal.body).toEqual({ scenario: 'default', requests: [] });
  });
  it('switching scenario keeps the journal and drops draft moves', () => {
    let state = switchTo('rich');
    state = step(state, {
      method: 'POST',
      path: '/v1/drafts/drf-0101/reject',
    }).state;
    state = switchTo('pending', state);
    expect(state.drafts).toEqual({});
    expect(state.journal).toHaveLength(1);
    expect(state.scenario).toBe('pending');
  });
  it('a POST /v1/send is journaled (with its 409), so "no send" is not vacuous', () => {
    const { state } = step(controlled(), {
      method: 'POST',
      path: '/v1/send',
      body: '{}',
    });
    expect(state.journal).toEqual([
      { method: 'POST', path: '/v1/send', query: '', status: 409 },
    ]);
    const journal = step(state, { method: 'GET', path: '/v1/_journal' }).out;
    expect(body(journal).requests).toEqual(state.journal);
  });
  it('a request without the bearer is journaled with its 401', () => {
    const out = route(
      { method: 'GET', path: '/v1/status', remote: LOOP },
      TOKEN,
      g,
      controlled(),
    );
    expect(out.next?.journal).toEqual([
      { method: 'GET', path: '/v1/status', query: '', status: 401 },
    ]);
  });
});

describe('v2 S4b SC6: a bad scenario request is a 4xx that says why', () => {
  it('an unknown name: 400 unknown-scenario, the known list, no state change', () => {
    const out = step(controlled(), {
      method: 'POST',
      path: '/v1/_scenario',
      body: '{"name":"nope"}',
    }).out;
    expect(out.status).toBe(400);
    expect(out.body).toEqual({
      error: 'unknown-scenario',
      detail: 'no scenario named "nope"',
      known: ['default', ...EXPECTED_SCENARIOS],
    });
    expect(out.next).toBeUndefined();
  });
  it('a body that is not {"name": string}: 400 invalid-body', () => {
    for (const raw of [
      undefined,
      '',
      'not json',
      '[]',
      '{"name":7}',
      '{}',
      'null',
    ]) {
      const out = step(controlled(), {
        method: 'POST',
        path: '/v1/_scenario',
        body: raw,
      }).out;
      expect(out.status, String(raw)).toBe(400);
      expect(body(out).error).toBe('invalid-body');
      expect(String(body(out).detail)).toMatch(/name/);
      expect(out.next).toBeUndefined();
    }
  });
  it('a known name answers its summary; "default" is always known', () => {
    const rich = step(controlled(), {
      method: 'POST',
      path: '/v1/_scenario',
      body: '{"name":"rich"}',
    }).out;
    expect(rich.body).toEqual({
      scenario: 'rich',
      summary: readJson<{ summary: string }>(
        join(scenariosDir, 'rich/scenario.json'),
      ).summary,
    });
    expect(
      step(controlled(), {
        method: 'POST',
        path: '/v1/_scenario',
        body: '{"name":"default"}',
      }).out.status,
    ).toBe(200);
  });
});

describe('v2 S4b SC7: overlay precedence (scenario, its parents, then S0)', () => {
  const get = (state: State, path: string) =>
    step(state, { method: 'GET', path }).out;
  const file = (rel: string) => readJson<Golden>(join(scenariosDir, rel));
  const s0 = (rel: string) =>
    readJson<Golden>(join(contract, 'responses', rel));

  it('default serves the S0 goldens', () => {
    const state = controlled();
    expect(get(state, '/v1/status').body).toEqual(s0('status.json').body);
    expect(get(state, '/v1/threads').body).toEqual(
      s0('threads.list.json').body,
    );
    expect(get(state, '/v1/doctor').body).toEqual(s0('doctor.json').body);
  });
  it('pending: its own drafts, rich threads, S0 doctor', () => {
    const state = switchTo('pending');
    expect(get(state, '/v1/drafts').body).toEqual(
      file('pending/responses/drafts.list.json').body,
    );
    expect(get(state, '/v1/threads').body).toEqual(
      file('rich/responses/threads.list.json').body,
    );
    expect(get(state, '/v1/doctor').body).toEqual(s0('doctor.json').body);
    expect(get(state, '/v1/settings').body).toEqual(
      s0('settings.list.json').body,
    );
  });
  it('kill: the kill switch is on in status and settings', () => {
    const state = switchTo('kill');
    expect(body(get(state, '/v1/status')).killSwitch).toBe(true);
    const settings = body(get(state, '/v1/settings')).settings as Record<
      string,
      { value: Json }
    >;
    expect(settings['send.killSwitch']?.value).toBe(true);
  });
  it('fda-denied: threads 503 with the S0 source-unavailable body', () => {
    const out = get(switchTo('fda-denied'), '/v1/threads');
    expect(out.status).toBe(503);
    expect(out.body).toEqual(
      readJson<Golden>(join(contract, 'errors/503.source-unavailable.json'))
        .body,
    );
  });
  it('empty-earned and quiet: an empty queue', () => {
    expect(body(get(switchTo('empty-earned'), '/v1/drafts')).drafts).toEqual(
      [],
    );
    expect(body(get(switchTo('quiet'), '/v1/threads')).threads).toEqual([]);
  });
});

describe('v2 S4b SC8: transcripts by chat guid', () => {
  const auth = { authorization: AUTH };
  it('rich serves each thread its own transcript, percent-encoded or not', () => {
    const state = switchTo('rich');
    const threads = body(
      step(state, { method: 'GET', path: '/v1/threads' }).out,
    ).threads as Array<{ chatGuid: string }>;
    expect(threads).toHaveLength(8);
    for (const t of threads) {
      const out = step(state, {
        method: 'GET',
        path: `/v1/threads/${encodeURIComponent(t.chatGuid)}/messages`,
        ...auth,
      }).out;
      expect(out.status, t.chatGuid).toBe(200);
      expect(body(out).chatGuid).toBe(t.chatGuid);
    }
    const sms = step(state, {
      method: 'GET',
      path: '/v1/threads/SMS;-;+15550100004/messages',
    }).out;
    expect(body(sms).chatGuid).toBe('SMS;-;+15550100004');
  });
  it('search overrides one transcript and inherits the rest', () => {
    const state = switchTo('search');
    const maya = step(state, {
      method: 'GET',
      path: `/v1/threads/${encodeURIComponent('iMessage;-;+15550100001')}/messages`,
    }).out;
    expect(body(maya)).toEqual(
      readJson<Golden>(
        join(scenariosDir, 'search/responses/threads.messages.maya.json'),
      ).body,
    );
    const priya = step(state, {
      method: 'GET',
      path: `/v1/threads/${encodeURIComponent('SMS;-;+15550100004')}/messages`,
    }).out;
    expect(priya.status).toBe(200);
  });
  it('an unknown chat, or a broken escape, is the S0 404 unknown-chat', () => {
    const unknown = readJson<Golden>(
      join(contract, 'errors/404.unknown-chat.json'),
    );
    for (const path of [
      '/v1/threads/nope/messages',
      '/v1/threads/%E0%A4%A/messages',
    ]) {
      const out = step(switchTo('rich'), { method: 'GET', path }).out;
      expect(out.status, path).toBe(404);
      expect(out.body).toEqual(unknown.body);
    }
  });
});

describe('v2 S4b SC9: the draft state machine', () => {
  const act = (state: State, id: string, action: string) =>
    step(state, {
      method: 'POST',
      path: `/v1/drafts/${id}/${action}`,
      body: '{}',
    });
  const ids = (state: State, q = '') =>
    (
      body(step(state, { method: 'GET', path: `/v1/drafts${q}` }).out)
        .drafts as Array<{
        id: string;
      }>
    ).map((d) => d.id);

  it('approve then recall, with the undo window from settings', () => {
    let state = switchTo('rich');
    const approved = act(state, 'drf-0101', 'approve');
    expect(approved.out.status).toBe(200);
    const d = body(approved.out).draft as Record<string, Json>;
    expect(d.state).toBe('approved');
    expect(d.stateChangedAt).toBe(NOW);
    expect(d.sendNotBefore).toBe('2026-09-01T12:30:10.000Z');
    expect(body(approved.out).approvalId).toBe('apv-drf-0101-approve');
    state = approved.state;
    const again = act(state, 'drf-0101', 'approve');
    expect(again.out.status).toBe(409);
    expect(again.out.body).toEqual({
      error: 'illegal-transition',
      from: 'approved',
      requested: 'approve',
    });
    expect(again.out.next?.drafts).toEqual(state.drafts);
    const recalled = act(state, 'drf-0101', 'recall');
    expect(recalled.out.status).toBe(200);
    const r = body(recalled.out).draft as Record<string, Json>;
    expect(r.state).toBe('recalled');
    expect('sendNotBefore' in r).toBe(false);
    state = recalled.state;
    expect(ids(state)).not.toContain('drf-0101');
    expect(ids(state, '?state=recalled')).toEqual(['drf-0101']);
  });
  it('reject leaves the live list; recall of a pending draft is 409', () => {
    let state = switchTo('rich');
    expect(act(state, 'drf-0102', 'recall').out.status).toBe(409);
    state = act(state, 'drf-0102', 'reject').state;
    expect(ids(state)).toEqual([
      'drf-0101',
      'drf-0103',
      'drf-0104',
      'drf-0105',
    ]);
    expect(ids(state, '?state=pending')).toEqual([
      'drf-0101',
      'drf-0103',
      'drf-0104',
    ]);
    expect(ids(state, '?state=approved')).toEqual(['drf-0105']);
  });
  it('an unknown draft is the S0 404', () => {
    const out = act(switchTo('rich'), 'drf-9999', 'approve').out;
    expect(out.status).toBe(404);
    expect(out.body).toEqual(
      readJson<Golden>(join(contract, 'errors/404.not-found.json')).body,
    );
  });
  it('fda-denied threads are 503 but its queue still answers', () => {
    expect(ids(switchTo('fda-denied'))).toEqual([]);
  });
});

describe('v2 S4b SC10: SSE replay', () => {
  const greeting = readFileSync(join(contract, 'sse/greeting.txt'));
  const idsOf = (frames: Buffer[]) =>
    frames.map((f) => Number(/^id: (\d+)$/m.exec(f.toString('utf8'))?.[1]));

  it('default replays the greeting alone, byte for byte', () => {
    const frames = replay(g, controlled());
    expect(frames).toHaveLength(1);
    expect(frames[0]?.equals(greeting)).toBe(true);
  });
  it('rich replays ids 1 to 7, and pending inherits nothing it overrides', () => {
    expect(idsOf(replay(g, switchTo('rich')))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(idsOf(replay(g, switchTo('pending')))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(idsOf(replay(g, switchTo('empty-earned')))).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(replay(g, switchTo('rich'))[0]?.equals(greeting)).toBe(true);
  });
  it('Last-Event-ID skips what was seen; the greeting always leads', () => {
    expect(idsOf(replay(g, switchTo('rich'), 4))).toEqual([1, 5, 6, 7]);
    expect(idsOf(replay(g, switchTo('rich'), '7'))).toEqual([1]);
    expect(idsOf(replay(g, switchTo('rich'), 'junk'))).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
  });
  it('the greeting says the scenario connection state', () => {
    const degraded = replay(g, switchTo('degraded'))[0]?.toString('utf8') ?? '';
    expect(degraded).toContain('"state":"read-only"');
    expect(degraded.startsWith('id: 1\nevent: connection.state\n')).toBe(true);
    const fda = replay(g, switchTo('fda-denied'))[0]?.toString('utf8') ?? '';
    expect(fda).toContain('"state":"disconnected"');
  });
  it('the stream route answers the replay, honouring last-event-id', () => {
    const out = step(switchTo('rich'), {
      method: 'GET',
      path: '/v1/events/sse',
      lastEventId: '5',
    }).out;
    expect(out.stream).toBe(true);
    expect(idsOf(out.frames ?? [])).toEqual([1, 6, 7]);
  });
});

describe('v2 S4b SC11: start, with and without --control', () => {
  let dir = '';
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (close) await close();
    close = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });
  async function boot(control: boolean) {
    dir = mkdtempSync(join(tmpdir(), 'wm-fake-daemon-s4b-'));
    const daemon = await start({
      dir: join(dir, 'wm'),
      port: 0,
      control,
      write: () => undefined,
      frameGapMs: 1,
    });
    close = daemon.close;
    return { daemon, base: `http://127.0.0.1:${daemon.port}` };
  }

  it('with --control: bound to 127.0.0.1, scenario, journal and reset end to end', async () => {
    const { daemon, base } = await boot(true);
    expect(daemon.server.address()).toMatchObject({ address: '127.0.0.1' });
    const auth = { authorization: `Bearer ${daemon.token}` };

    const bad = await fetch(`${base}/v1/_scenario`, {
      method: 'POST',
      body: '{"name":"nope"}',
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe(
      'unknown-scenario',
    );

    const ok = await fetch(`${base}/v1/_scenario`, {
      method: 'POST',
      body: '{"name":"degraded"}',
    });
    expect(ok.status).toBe(200);
    const status = await fetch(`${base}/v1/status`, { headers: auth });
    expect(
      ((await status.json()) as { connectionState: string }).connectionState,
    ).toBe('read-only');
    await fetch(`${base}/v1/send`, {
      method: 'POST',
      headers: auth,
      body: '{}',
    });

    const journal = (await (await fetch(`${base}/v1/_journal`)).json()) as {
      scenario: string;
      requests: Array<{ method: string; path: string; status: number }>;
    };
    expect(journal.scenario).toBe('degraded');
    expect(
      journal.requests.map((r) => `${r.method} ${r.path} ${r.status}`),
    ).toEqual(['GET /v1/status 200', 'POST /v1/send 409']);

    const reset = await fetch(`${base}/v1/_reset`, { method: 'POST' });
    expect(reset.status).toBe(200);
    const after = (await (await fetch(`${base}/v1/_journal`)).json()) as {
      scenario: string;
      requests: unknown[];
    };
    expect(after).toEqual({ scenario: 'default', requests: [] });
  });

  it('with --control: the stream replays the scenario frames after the greeting', async () => {
    const { daemon, base } = await boot(true);
    await fetch(`${base}/v1/_scenario`, {
      method: 'POST',
      body: '{"name":"rich"}',
    });
    const ac = new AbortController();
    const sse = await fetch(`${base}/v1/events/sse`, {
      headers: { authorization: `Bearer ${daemon.token}` },
      signal: ac.signal,
    });
    const reader = sse.body!.getReader();
    let text = '';
    while ((text.match(/^id: /gm) ?? []).length < 7) {
      const { value, done } = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString('utf8');
    }
    ac.abort();
    expect(
      [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1])),
    ).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('without --control: every control route is 404 and nothing is journaled', async () => {
    const { daemon, base } = await boot(false);
    expect(daemon.server.address()).toMatchObject({ address: '127.0.0.1' });
    for (const [method, path] of [
      ['POST', '/v1/_scenario'],
      ['POST', '/v1/_reset'],
      ['GET', '/v1/_journal'],
    ] as const) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${daemon.token}` },
        ...(method === 'POST' ? { body: '{"name":"rich"}' } : {}),
      });
      expect(res.status, path).toBe(404);
    }
    const status = await fetch(`${base}/v1/status`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    expect(status.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Fixture validation: every scenario file against the S0 contract.
// ---------------------------------------------------------------------------

/** Every S0 golden (responses and errors), by route, then by status. */
function s0Goldens(): Golden[] {
  const out: Golden[] = [];
  for (const sub of ['responses', 'errors']) {
    for (const n of readdirSync(join(contract, sub)).filter((f) =>
      f.endsWith('.json'),
    ))
      out.push(readJson<Golden>(join(contract, sub, n)));
  }
  return out;
}
const S0 = s0Goldens();

type Shape =
  | { kind: 'object'; keys: Map<string, Shape> }
  | { kind: 'array'; of: Shape | null }
  | { kind: 'scalar'; types: Set<string> };

function typeName(v: Json): string {
  return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
}

/** Merge every sample into one shape: the union of keys and scalar types. */
function learn(samples: Json[]): Shape | null {
  let shape: Shape | null = null;
  for (const v of samples) shape = merge(shape, v);
  return shape;
}
function merge(shape: Shape | null, v: Json): Shape {
  if (Array.isArray(v)) {
    const base: Shape =
      shape?.kind === 'array' ? shape : { kind: 'array', of: null };
    let of = base.kind === 'array' ? base.of : null;
    for (const item of v) of = merge(of, item);
    return { kind: 'array', of };
  }
  if (v !== null && typeof v === 'object') {
    const keys = new Map(shape?.kind === 'object' ? shape.keys : []);
    for (const [k, child] of Object.entries(v))
      keys.set(k, merge(keys.get(k) ?? null, child));
    return { kind: 'object', keys };
  }
  const types = new Set(shape?.kind === 'scalar' ? shape.types : []);
  types.add(typeName(v));
  return { kind: 'scalar', types };
}

/**
 * Fields the S0 goldens never happen to show but the contract (and the
 * strict Swift DTOs, decodeIfPresent) accepts. Keyed by `route|path`.
 * Anything not here, and not in a golden, is a typo the test catches.
 */
const SUPPLEMENT: Record<string, Record<string, string[]>> = {
  'GET /v1/threads/:guid/messages': {
    'turns[]': ['editedAt', 'unsentAt', 'handle', 'meta'],
  },
  'GET /v1/threads': { 'threads[]': ['displayName', 'title', 'meta'] },
  'GET /v1/drafts': {
    'drafts[]': ['ruleId', 'sendNotBefore', 'proactiveReason', 'error'],
  },
  'GET /v1/contacts': { 'contacts[]': ['displayName'] },
  'GET /v1/adapters': { 'adapters[]': ['lastSeenAt'] },
  'GET /v1/doctor': { 'checks[]': ['detail', 'remediation'] },
  // v2 B4: board 07's voice dock reads status.meta.voice (preview-* only).
  'GET /v1/status': { '': ['meta'] },
  'event message.received': { message: ['displayName'] },
  'event draft.created': { draft: ['displayName', 'ruleId'] },
};
/**
 * Shapes S0 shows only empty: an attachment is {mimeType, bytes}
 * (InboundMessage.content.attachments in the Swift DTOs).
 */
const ELEMENTS: Record<string, Json[]> = {
  'event message.received': [
    {
      message: {
        content: { attachments: [{ mimeType: 'image/jpeg', bytes: 1 }] },
      },
    },
  ],
};
/** Values that may be null where the goldens only ever show a value. */
const NULLABLE: Record<string, string[]> = {
  'GET /v1/status': ['cursor', 'armed.until'],
  'GET /v1/threads': [
    'threads[].lastLine',
    'threads[].title',
    'threads[].displayName',
  ],
  'GET /v1/threads/:guid/messages': ['turns[].text'],
  'event message.received': ['message.content.text'],
};
/**
 * Open maps (any keys, any values): settings by key and adapter config.
 * status.adapters is checked on its own, against an adapters.list element.
 */
const OPEN: Record<string, string[]> = {
  'GET /v1/adapters': ['adapters[].config'],
  // v2 Phase B: per-board fixture detail, preview-* scenarios only (row below).
  'GET /v1/threads': ['threads[].meta'],
  'GET /v1/threads/:guid/messages': ['turns[].meta'],
  'GET /v1/settings': ['settings'],
  'PATCH /v1/settings': ['settings'],
  'GET /v1/status': ['adapters', 'meta'],
};
const isOpen = (route: string, path: string) =>
  (OPEN[route] ?? []).includes(path);

function check(
  route: string,
  path: string,
  shape: Shape | null,
  v: Json,
  out: string[],
) {
  if (isOpen(route, path)) return;
  if (shape === null) {
    out.push(`${path}: no S0 shape to compare against`);
    return;
  }
  const t = typeName(v);
  if (t === 'null' && (NULLABLE[route] ?? []).includes(path)) return;
  // S0 shows only null here: the contract leaves the value to the scenario.
  if (
    shape.kind === 'scalar' &&
    shape.types.size === 1 &&
    shape.types.has('null')
  )
    return;
  if (shape.kind === 'scalar') {
    if (!shape.types.has(t))
      out.push(`${path}: ${t}, S0 has ${[...shape.types].join('|')}`);
    return;
  }
  if (shape.kind === 'array') {
    if (!Array.isArray(v))
      return void out.push(`${path}: ${t}, S0 has an array`);
    if (shape.of === null) {
      if (v.length > 0) out.push(`${path}: S0 only shows an empty array`);
      return;
    }
    for (const item of v) check(route, `${path}[]`, shape.of, item, out);
    return;
  }
  if (t !== 'object') return void out.push(`${path}: ${t}, S0 has an object`);
  const extra = SUPPLEMENT[route]?.[path] ?? [];
  for (const [k, child] of Object.entries(v as Record<string, Json>)) {
    const at = path ? `${path}.${k}` : k;
    const known = shape.keys.get(k);
    if (known) check(route, at, known, child, out);
    else if (!extra.includes(k)) out.push(`${at}: not in S0`);
  }
}

type ScenarioFile = { scenario: string; file: string; golden: Golden };
function scenarioFiles(): ScenarioFile[] {
  const out: ScenarioFile[] = [];
  for (const scenario of readdirSync(scenariosDir).sort()) {
    const dir = join(scenariosDir, scenario, 'responses');
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).sort())
      out.push({ scenario, file, golden: readJson<Golden>(join(dir, file)) });
  }
  return out;
}
function frameFiles(): Array<{ scenario: string; file: string; text: string }> {
  const out = [];
  for (const scenario of readdirSync(scenariosDir).sort()) {
    const dir = join(scenariosDir, scenario, 'sse');
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).sort())
      out.push({ scenario, file, text: readFileSync(join(dir, file), 'utf8') });
  }
  return out;
}
function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? allFiles(join(dir, e.name)) : [join(dir, e.name)],
  );
}

describe('v2 S4b SC12: every scenario fixture validates against S0', () => {
  const files = scenarioFiles();

  it('the tree is non-empty and has only scenario.json, responses/*.json, sse/*.txt', () => {
    expect(files.length).toBeGreaterThanOrEqual(30);
    for (const path of allFiles(scenariosDir)) {
      const rel = path.slice(scenariosDir.length + 1);
      expect(rel, rel).toMatch(
        /^[a-z][a-z-]*\/(scenario\.json|responses\/[a-z][a-z.-]*\.json|sse\/\d{2}-[a-z]+\.[a-z]+\.txt)$/,
      );
    }
  });

  it('scenario.json holds a summary and, at most, extends (and, for bulk alone, its generator)', () => {
    for (const name of EXPECTED_SCENARIOS) {
      const meta = readJson<Record<string, Json>>(
        join(scenariosDir, name, 'scenario.json'),
      );
      expect(
        Object.keys(meta).every(
          (k) =>
            k === 'summary' ||
            k === 'extends' ||
            (k === 'generator' && name === 'bulk'),
        ),
        name,
      ).toBe(true);
      expect(typeof meta.summary).toBe('string');
    }
  });

  it('each response is {route, status, body} on a route and status S0 knows', () => {
    for (const { scenario, file, golden } of files) {
      const where = `${scenario}/${file}`;
      expect(Object.keys(golden).sort(), where).toEqual([
        'body',
        'route',
        'status',
      ]);
      expect(
        S0.some((s) => s.route === golden.route),
        `${where}: route ${golden.route}`,
      ).toBe(true);
      if (golden.status < 400) {
        expect(
          S0.some(
            (s) => s.route === golden.route && s.status === golden.status,
          ),
          `${where}: status ${golden.status}`,
        ).toBe(true);
      }
    }
  });

  it('error responses carry an S0 error body exactly', () => {
    const errors = readdirSync(join(contract, 'errors')).map((n) =>
      readJson<Golden>(join(contract, 'errors', n)),
    );
    let seen = 0;
    for (const { scenario, file, golden } of files) {
      if (golden.status < 400) continue;
      seen += 1;
      expect(
        errors.some(
          (e) =>
            e.status === golden.status &&
            JSON.stringify(e.body) === JSON.stringify(golden.body),
        ),
        `${scenario}/${file}`,
      ).toBe(true);
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('each success body has the shape of the S0 goldens on its route', () => {
    const offenders: string[] = [];
    for (const { scenario, file, golden } of files) {
      if (golden.status >= 400) continue;
      const samples = S0.filter(
        (s) => s.route === golden.route && s.status < 400,
      ).map((s) => s.body);
      const found: string[] = [];
      check(golden.route, '', learn(samples), golden.body, found);
      offenders.push(...found.map((f) => `${scenario}/${file} ${f}`));
    }
    expect(offenders).toEqual([]);
  });

  it('status.adapters entries have the shape of an adapters.list element', () => {
    const adapters = readJson<Golden>(
      join(contract, 'responses/adapters.list.json'),
    );
    const element = learn((adapters.body as { adapters: Json[] }).adapters);
    const offenders: string[] = [];
    let seen = 0;
    for (const { scenario, file, golden } of files) {
      if (golden.route !== 'GET /v1/status' || golden.status !== 200) continue;
      for (const a of (golden.body as { adapters: Json[] }).adapters) {
        seen += 1;
        const found: string[] = [];
        check('GET /v1/adapters', 'adapters[]', element, a, found);
        offenders.push(...found.map((f) => `${scenario}/${file} ${f}`));
      }
    }
    expect(seen).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it('stream frames: one frame, ids from 2 rising, payload shaped like fixtures/events', () => {
    const frames = frameFiles();
    expect(frames.length).toBeGreaterThanOrEqual(10);
    const byScenario = new Map<string, number[]>();
    const offenders: string[] = [];
    for (const { scenario, file, text } of frames) {
      const m = /^id: (\d+)\nevent: ([a-z.]+)\ndata: (.+)\n\n$/.exec(text);
      expect(m, `${scenario}/${file}`).not.toBeNull();
      if (!m) continue;
      const [, id, event, data] = m;
      expect(file, `${scenario}/${file}`).toBe(
        `${String(id).padStart(2, '0')}-${event}.txt`,
      );
      byScenario.set(scenario, [
        ...(byScenario.get(scenario) ?? []),
        Number(id),
      ]);
      const payload = JSON.parse(data ?? '') as Record<string, Json>;
      expect(payload.event).toBe(event);
      const sample = join(eventsDir, `${event}.json`);
      expect(existsSync(sample), `${event} has an S0 event`).toBe(true);
      const found: string[] = [];
      check(
        `event ${event}`,
        '',
        learn([readJson(sample), ...(ELEMENTS[`event ${event}`] ?? [])]),
        payload,
        found,
      );
      offenders.push(...found.map((f) => `${scenario}/${file} ${f}`));
    }
    for (const [scenario, ids] of byScenario) {
      expect(ids, scenario).toEqual(ids.map((_, i) => i + 2));
    }
    expect(offenders).toEqual([]);
  });

  it('threads agree with their transcripts, and every draft points at a thread', () => {
    const state = (name: string) => switchTo(name);
    for (const name of [
      'rich',
      'search',
      'pending',
      'preview-whatsapp',
      'preview-linkedin',
    ]) {
      const s = state(name);
      const threads = body(step(s, { method: 'GET', path: '/v1/threads' }).out)
        .threads as Array<Record<string, Json>>;
      for (const t of threads) {
        const transcript = body(
          step(s, {
            method: 'GET',
            path: `/v1/threads/${encodeURIComponent(String(t.chatGuid))}/messages`,
          }).out,
        );
        const turns = transcript.turns as Array<Record<string, Json>>;
        expect(turns.length, `${name} ${String(t.chatGuid)}`).toBeGreaterThan(
          0,
        );
        const last = turns[turns.length - 1]!;
        expect(t.lastAt, `${name} ${String(t.chatGuid)} lastAt`).toBe(last.at);
        expect(t.lastFromMe, `${name} ${String(t.chatGuid)} lastFromMe`).toBe(
          last.from === 'me',
        );
        const ats = turns.map((x) => String(x.at));
        expect(ats, 'turns in time order').toEqual([...ats].sort());
      }
      const guids = new Set(threads.map((t) => t.chatGuid));
      const drafts = body(
        step(s, { method: 'GET', path: '/v1/drafts?state=pending' }).out,
      ).drafts as Array<Record<string, Json>>;
      for (const d of drafts)
        expect(guids.has(d.chatGuid), `${name} ${String(d.id)}`).toBe(true);
    }
  });

  it('synthetic only: no public-string offenders, emails only at example.com, the fixture state and meta only under preview-*', () => {
    const offenders: string[] = [];
    let phones = 0;
    let fixtureStates = 0;
    for (const path of allFiles(scenariosDir)) {
      const text = readFileSync(path, 'utf8');
      const rel = path.slice(scenariosDir.length + 1);
      for (const o of publicStringOffenders(text))
        offenders.push(`${rel}: ${o.rule}`);
      for (const e of text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g) ?? [])
        if (!e.endsWith('@example.com')) offenders.push(`${rel}: email ${e}`);
      phones += (text.match(/\+1555\d{7}/g) ?? []).length;
      if (/\u2014/.test(text)) offenders.push(`${rel}: em dash`);
      if (/wm_[0-9a-f]{8}/.test(text)) offenders.push(`${rel}: token shape`);
      // v2 B0: the state that opens a board over fixtures lives in the
      // preview-* scenarios and nowhere else in the tree, so a scenario that
      // mirrors the real daemon can never carry it by accident.
      if (FIXTURE_WORD_RE.test(text) && !rel.startsWith('preview-'))
        offenders.push(`${rel}: the fixture word outside preview-*`);
      // v2 Phase B: per-board `meta` is fixture detail the real daemon never
      // sends, so it rides only in the preview-* scenarios.
      if (/"meta"\s*:/.test(text) && !rel.startsWith('preview-'))
        offenders.push(`${rel}: meta outside preview-*`);
      fixtureStates += text.split(FIXTURE_STATE).length - 1;
    }
    expect(phones).toBeGreaterThan(20);
    // Three boards open over fixtures; preview-voice opens none. Board 04's
    // pushed-back scenario (v2 B3) restates LinkedIn's state, so it counts
    // twice.
    expect(fixtureStates).toBe(4);
    expect(offenders).toEqual([]);
  });

  it('JSON files are canonical (two-space, trailing newline)', () => {
    for (const path of allFiles(scenariosDir).filter((p) =>
      p.endsWith('.json'),
    )) {
      const text = readFileSync(path, 'utf8');
      expect(JSON.stringify(JSON.parse(text), null, 2) + '\n', path).toBe(text);
    }
  });
});

describe('v2 S4f SC13: the kill switch toggle, only with --control', () => {
  const toggle = (state: State, on: unknown, remote = LOOP) =>
    step(state, {
      method: 'POST',
      path: '/v1/toggles/kill-switch',
      body: JSON.stringify({ on }),
      remote,
    });
  const killOf = (state: State) => ({
    status: body(step(state, { method: 'GET', path: '/v1/status' }).out),
    setting: (
      body(step(state, { method: 'GET', path: '/v1/settings' }).out)
        .settings as Record<string, { value: Json }>
    )['send.killSwitch']?.value,
  });

  it('without --control it stays parked (409), and nothing flips', () => {
    const state = initialState();
    const { out, state: next } = toggle(state, false);
    expect(out.status).toBe(409);
    expect(out.body).toEqual(
      readJson<Golden>(join(contract, 'errors/409.parked.json')).body,
    );
    expect(next.killSwitch).toBeNull();
  });
  it('a non-loopback peer is parked too', () => {
    const out = toggle(switchTo('kill'), false, '10.0.0.9').out;
    expect(out.status).toBe(409);
  });
  it('kill, then disengage: status, armed and settings follow; journaled', () => {
    let state = switchTo('kill');
    expect(killOf(state).status.killSwitch).toBe(true);
    const off = toggle(state, false);
    expect(off.out.status).toBe(200);
    expect(off.out.body).toEqual(
      readJson<Golden>(join(contract, 'responses/toggles.killswitch.off.json'))
        .body,
    );
    state = off.state;
    const k = killOf(state);
    expect(k.status.killSwitch).toBe(false);
    expect(k.status.armed).toEqual(
      readJson<{ body: { armed: Json } }>(
        join(contract, 'responses/status.json'),
      ).body.armed,
    );
    expect(k.setting).toBe(false);
    expect(
      state.journal.map((r) => `${r.method} ${r.path} ${String(r.status)}`),
    ).toContain('POST /v1/toggles/kill-switch 200');
  });
  it('engaging from rich mirrors the kill scenario status', () => {
    const on = toggle(switchTo('rich'), true);
    expect(on.out.body).toEqual(
      readJson<Golden>(join(contract, 'responses/toggles.killswitch.json'))
        .body,
    );
    const k = killOf(on.state);
    const killStatus = readJson<{ body: Record<string, Json> }>(
      join(scenariosDir, 'kill/responses/status.json'),
    ).body;
    expect(k.status).toEqual(killStatus);
    expect(k.setting).toBe(true);
  });
  it('a scenario switch or reset drops the flip; a bad body is 400', () => {
    const off = toggle(switchTo('kill'), false).state;
    expect(killOf(switchTo('kill', off)).status.killSwitch).toBe(true);
    const reset = step(off, { method: 'POST', path: '/v1/_reset' }).state;
    expect(reset).toEqual(initialState({ control: true }));
    const bad = toggle(switchTo('kill'), 'yes');
    expect(bad.out.status).toBe(400);
    expect(bad.state.killSwitch).toBeNull();
  });
});

/**
 * v2 B4: board 07's voice dock is driven only by status.meta.voice in the
 * preview-voice* scenarios. Each one inherits the rich queue (so Priya's
 * pending draft drf-0102 exists), names one of the three dock sizes and one
 * of the nine chips, and always carries a caption: the dock has no off
 * switch for it. A card is only ever armed for a draft the queue holds
 * pending, and no fixture says a draft was approved or sent by voice.
 */
describe('v2 B4: the voice scenarios', () => {
  const SIZES = ['idle', 'speaking', 'confirm'];
  const CHIPS = [
    'idle',
    'listening',
    'speaking',
    'thinking',
    'driving',
    'interrupted',
    'unheard',
    'confirm',
    'muted',
  ];
  const FAILURES = [
    'unheard',
    'misheard',
    'selfheard',
    'interrupted',
    'transport',
    'muted',
  ];
  const KEYS = new Set([
    'dockState',
    'caption',
    'readbackToken',
    'micMuted',
    'chip',
    'failure',
    'heard',
    'meant',
    'draftId',
    'armed',
  ]);
  const voiceScenarios = EXPECTED_SCENARIOS.filter((n) =>
    n.startsWith('preview-voice'),
  );
  const get = (state: State, path: string) =>
    step(state, { method: 'GET', path }).out;
  const file = (rel: string) => readJson<Golden>(join(scenariosDir, rel));
  const voiceOf = (status: Record<string, Json>): Record<string, Json> =>
    (status.meta as { voice: Record<string, Json> }).voice;

  it('nine scenarios, the three sizes and all six failure modes', () => {
    expect(voiceScenarios).toHaveLength(9);
    const sizes = new Set<string>();
    const failures = new Set<string>();
    for (const name of voiceScenarios) {
      const voice = voiceOf(body(get(switchTo(name), '/v1/status')));
      sizes.add(voice.dockState as string);
      if (voice.failure) failures.add(voice.failure as string);
    }
    expect([...sizes].sort()).toEqual([...SIZES].sort());
    expect([...failures].sort()).toEqual([...FAILURES].sort());
  });

  it('every voice state is well formed, captioned, and arms only a pending draft', () => {
    for (const name of voiceScenarios) {
      const state = switchTo(name);
      const status = body(get(state, '/v1/status'));
      expect(Object.keys(status.meta as object), name).toEqual(['voice']);
      const voice = voiceOf(status);
      for (const k of Object.keys(voice))
        expect(KEYS.has(k), `${name}: key ${k}`).toBe(true);
      expect(SIZES, name).toContain(voice.dockState);
      expect(CHIPS, name).toContain(voice.chip);
      expect(typeof voice.caption, name).toBe('string');
      expect((voice.caption as string).trim().length, name).toBeGreaterThan(0);
      expect(typeof voice.micMuted, name).toBe('boolean');
      expect(
        voice.readbackToken === null || typeof voice.readbackToken === 'string',
        name,
      ).toBe(true);
      if (voice.failure !== undefined)
        expect(FAILURES, name).toContain(voice.failure);
      if (voice.armed !== undefined) {
        expect(typeof voice.armed, name).toBe('boolean');
        const drafts = body(get(state, '/v1/drafts')).drafts as {
          id: string;
          state: string;
        }[];
        const armedFor = drafts.find((d) => d.id === voice.draftId);
        expect(armedFor?.state, `${name}: ${String(voice.draftId)}`).toBe(
          'pending',
        );
      }
      // The rest of status is rich's: the voice dock adds meta, nothing else.
      const rich = file('rich/responses/status.json').body as Record<
        string,
        Json
      >;
      const rest = { ...status };
      delete rest.meta;
      expect(rest, name).toEqual(rich);
    }
  });

  it('only the confirm scenario is armed and clean; selfheard and transport are not', () => {
    const armed = voiceScenarios.filter((name) => {
      const voice = (
        file(`${name}/responses/status.json`).body as {
          meta: { voice: Record<string, Json> };
        }
      ).meta.voice;
      return voice.armed === true && voice.failure === undefined;
    });
    expect(armed).toEqual(['preview-voice-confirm']);
  });
});

/**
 * v2 B3: board 04 is driven by thread.meta, turn.meta and status.meta.linkedin
 * in preview-linkedin, and preview-linkedin-ratelimited differs from it only
 * by the pause. The seven threads cover the three inboxes, both categories,
 * every eligibility step, a request, an InMail with its subject and credits,
 * and a commercial payload of each kind.
 */
describe('v2 B3: the LinkedIn scenarios', () => {
  const get = (state: State, path: string) =>
    step(state, { method: 'GET', path }).out;
  type Linked = { linkedin: Record<string, Json> };

  it('seven threads over three inboxes, two categories and steps 0..4', () => {
    const s = switchTo('preview-linkedin');
    const threads = body(get(s, '/v1/threads')).threads as Array<
      Record<string, Json>
    >;
    expect(threads).toHaveLength(7);
    const metas = threads.map((t) => t.meta as Record<string, Json>);
    for (const t of threads) expect(t.channel).toBe('linkedin');
    expect([...new Set(metas.map((m) => m.inbox))].sort()).toEqual([
      'personal',
      'recruiter',
      'salesNav',
    ]);
    expect([...new Set(metas.map((m) => m.category))].sort()).toEqual([
      'focused',
      'other',
    ]);
    expect(
      [...new Set(metas.map((m) => m.eligibility as number))].sort(),
    ).toEqual([0, 1, 2, 3, 4]);
    expect(metas.filter((m) => m.requestState === 'pending')).toHaveLength(1);
    const turns = threads.flatMap(
      (t) =>
        body(
          get(
            s,
            `/v1/threads/${encodeURIComponent(String(t.chatGuid))}/messages`,
          ),
        ).turns as Array<Record<string, Json>>,
    );
    const metasOfTurns = turns
      .map((x) => x.meta as Record<string, Record<string, Json>> | undefined)
      .filter((m) => m !== undefined);
    const inMail = metasOfTurns.filter((m) => m.inMail);
    expect(inMail.length).toBeGreaterThan(0);
    for (const m of inMail) {
      expect(typeof m.inMail!.subject).toBe('string');
      expect(typeof m.inMail!.credits).toBe('number');
    }
    expect(inMail.some((m) => (m.inMail!.credits as number) > 0)).toBe(true);
    expect(
      metasOfTurns
        .filter((m) => m.commercial)
        .map((m) => m.commercial!.kind)
        .sort(),
    ).toEqual(['job', 'recruiter', 'sponsored']);
  });

  it('the pushed-back scenario is preview-linkedin plus a pause, and nothing else', () => {
    const calm = body(get(switchTo('preview-linkedin'), '/v1/status'));
    const paused = body(
      get(switchTo('preview-linkedin-ratelimited'), '/v1/status'),
    );
    expect((calm.meta as Linked).linkedin.pausedUntil).toBeUndefined();
    const pause = (paused.meta as Linked).linkedin;
    expect(typeof pause.pausedUntil).toBe('string');
    const rest = { ...pause };
    delete rest.pausedUntil;
    expect(rest).toEqual((calm.meta as Linked).linkedin);
    expect({ ...paused, meta: null }).toEqual({ ...calm, meta: null });
    expect(
      body(get(switchTo('preview-linkedin-ratelimited'), '/v1/threads')),
    ).toEqual(body(get(switchTo('preview-linkedin'), '/v1/threads')));
  });
});

/**
 * v2 S7a: the bulk scenario (docs/plans/v2-swift-S5-B.md, S7a). Its data is
 * generated by tools/swift/bulk.mjs from a seed, not checked in, so these
 * rows hold the generator to what a checked-in fixture would be held to:
 * S0 shapes, synthetic strings, the real daemon's paging, determinism.
 */
describe('v2 S7a: the bulk scenario', () => {
  type Row = Record<string, Json>;
  const bulk = () => switchTo('bulk');
  const threadsAt = (state: State, query = '') =>
    step(state, { method: 'GET', path: `/v1/threads${query}` }).out;
  const turnsAt = (state: State, guid: string, query = '') =>
    step(state, {
      method: 'GET',
      path: `/v1/threads/${encodeURIComponent(guid)}/messages${query}`,
    }).out;

  /** Every thread, walking cursors at the largest page. */
  function allThreads(state: State): Row[] {
    const seen: Row[] = [];
    let query = `?limit=${THREADS_PAGE.max}`;
    for (let pages = 0; pages < 100; pages += 1) {
      const page = body(threadsAt(state, query));
      seen.push(...(page.threads as Row[]));
      if (page.nextCursor === null) return seen;
      query = `?limit=${THREADS_PAGE.max}&cursor=${String(page.nextCursor)}`;
    }
    throw new Error('the cursor walk never ended');
  }

  /** Every turn of one transcript, walking `before` back to the start. */
  function allTurns(state: State, guid: string): Row[][] {
    const pages: Row[][] = [];
    let query = `?limit=${MESSAGES_PAGE.max}`;
    for (let n = 0; n < 100; n += 1) {
      const page = body(turnsAt(state, guid, query));
      pages.push(page.turns as Row[]);
      if (page.nextBefore === null) return pages;
      query = `?limit=${MESSAGES_PAGE.max}&before=${String(page.nextBefore)}`;
    }
    throw new Error('the before walk never ended');
  }

  it('the generator is pinned to the plan: 4,000 threads, a 2,000-turn thread, the daemon page bounds', () => {
    expect(BULK.threads).toBe(4000);
    expect(BULK.longTurns).toBe(2000);
    expect(THREADS_PAGE).toEqual({ min: 1, max: 200, fallback: 100 });
    expect(MESSAGES_PAGE).toEqual({ min: 1, max: 200, fallback: 50 });
  });

  it('GET /v1/threads pages 100 by default; the cursor walk lists 4,000 distinct threads, newest first', () => {
    const state = bulk();
    const first = body(threadsAt(state));
    expect((first.threads as Row[]).length).toBe(100);
    expect(first.total).toBe(4000);
    expect(typeof first.nextCursor).toBe('string');
    const all = allThreads(state);
    expect(all.length).toBe(4000);
    expect(new Set(all.map((t) => t.chatGuid)).size).toBe(4000);
    const ats = all.map((t) => String(t.lastAt));
    expect(ats).toEqual([...ats].sort().reverse());
    expect(new Set(ats).size).toBe(4000);
    expect(all.some((t) => t.isGroup === true)).toBe(true);
    expect(all.some((t) => String(t.chatGuid).includes('@example.com'))).toBe(
      true,
    );
  });

  it("a bad limit is the daemon's 400 invalid-query, a bad cursor its 400 invalid-cursor golden", () => {
    const state = bulk();
    const cursorGolden = readJson<Golden>(
      join(contract, 'errors/400.invalid-cursor.json'),
    );
    for (const q of ['?limit=0', '?limit=201', '?limit=x', '?limit=1.5']) {
      const out = threadsAt(state, q);
      expect(out.status, q).toBe(400);
      expect(body(out).error, q).toBe('invalid-query');
      expect(turnsAt(state, 'iMessage;-;+15552000000', q).status, q).toBe(400);
    }
    for (const q of [
      '?cursor=o0',
      '?cursor=zzz',
      '?cursor=o4000',
      '?cursor=',
    ]) {
      const out = threadsAt(state, q);
      expect(out.status, q).toBe(400);
      expect(out.body, q).toEqual(cursorGolden.body);
    }
    expect(
      turnsAt(state, 'iMessage;-;+15552000000', '?before=o2000').body,
    ).toEqual(cursorGolden.body);
    expect(turnsAt(state, 'iMessage;-;+15559999999').status).toBe(404);
  });

  it('the newest thread carries 2,000 turns: 50 by default, the before walk returns each once, in time order', () => {
    const state = bulk();
    const newest = body(threadsAt(state, '?limit=1')).threads as Row[];
    const head = newest[0]!;
    const guid = String(head.chatGuid);
    const firstPage = body(turnsAt(state, guid));
    expect((firstPage.turns as Row[]).length).toBe(50);
    const pages = allTurns(state, guid);
    expect(pages.length).toBe(10);
    const turns = pages.reverse().flat();
    expect(turns.length).toBe(2000);
    expect(new Set(turns.map((t) => t.guid)).size).toBe(2000);
    const ats = turns.map((t) => String(t.at));
    expect(ats).toEqual([...ats].sort());
    const last = turns[turns.length - 1]!;
    expect(last).toEqual((firstPage.turns as Row[]).at(-1));
    expect(head.lastAt).toBe(last.at);
    expect(head.lastFromMe).toBe(last.from === 'me');
    expect(head.lastLine).toBe(last.text);
  });

  it('every sampled thread agrees with its transcript, as the checked-in scenarios do', () => {
    const state = bulk();
    const all = allThreads(state);
    for (let i = 1; i < all.length; i += 97) {
      const t = all[i]!;
      const turns = body(turnsAt(state, String(t.chatGuid))).turns as Row[];
      expect(turns.length, String(t.chatGuid)).toBeGreaterThan(0);
      expect(turns.length).toBeLessThanOrEqual(BULK.shortTurnsMax);
      const last = turns.at(-1)!;
      expect(t.lastAt).toBe(last.at);
      expect(t.lastFromMe).toBe(last.from === 'me');
      expect(t.lastLine).toBe(last.text);
    }
  });

  it('pages have the shape of the S0 goldens on their routes', () => {
    const state = bulk();
    const offenders: string[] = [];
    const guid = String((body(threadsAt(state)).threads as Row[])[0]!.chatGuid);
    for (const [route, out] of [
      ['GET /v1/threads', threadsAt(state)],
      ['GET /v1/threads', threadsAt(state, '?cursor=o3900')],
      ['GET /v1/threads/:guid/messages', turnsAt(state, guid)],
      ['GET /v1/threads/:guid/messages', turnsAt(state, guid, '?before=o1990')],
    ] as const) {
      expect(out.status, route).toBe(200);
      const samples = S0.filter((s) => s.route === route && s.status < 400).map(
        (s) => s.body,
      );
      const found: string[] = [];
      check(route, '', learn(samples), out.body as Json, found);
      offenders.push(...found.map((f) => `${route} ${f}`));
    }
    expect(offenders).toEqual([]);
  });

  it('synthetic only: +1555 numbers, example.com addresses, no public-string offenders, no meta', () => {
    const data = generateBulk();
    const long = data.turns(String(data.threads[0]!.chatGuid))!;
    const text = JSON.stringify({ threads: data.threads, long });
    expect(publicStringOffenders(text)).toEqual([]);
    for (const e of text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g) ?? [])
      expect(e.endsWith('@example.com'), e).toBe(true);
    for (const p of text.match(/\+1\d{10}/g) ?? [])
      expect(p.startsWith('+1555'), p).toBe(true);
    expect((text.match(/\+1555\d{7}/g) ?? []).length).toBeGreaterThan(3000);
    expect(text).not.toMatch(/—/);
    expect(text).not.toMatch(/"meta"\s*:/);
    expect(text).not.toMatch(FIXTURE_WORD_RE);
  });

  it('deterministic: the same seed gives the same bytes; another seed does not', () => {
    const a = generateBulk();
    const b = generateBulk();
    expect(JSON.stringify(a.threads)).toBe(JSON.stringify(b.threads));
    const guid = String(a.threads[0]!.chatGuid);
    expect(a.turns(guid)).toEqual(b.turns(guid));
    const c = generateBulk({ ...BULK, seed: BULK.seed + 1 });
    expect(JSON.stringify(c.threads)).not.toBe(JSON.stringify(a.threads));
  });

  it('every other scenario is untouched: rich still serves its checked-in list', () => {
    const rich = body(threadsAt(switchTo('rich'))).threads as Row[];
    expect(rich.length).toBeLessThan(100);
  });
});

describe('v2 S7a: POST /v1/_emit, a live connection.state frame, only with --control', () => {
  const emit = (state: State, payload: string, remote: string | null = LOOP) =>
    route(
      {
        method: 'POST',
        path: '/v1/_emit',
        body: payload,
        ...(remote === null ? {} : { remote }),
      },
      TOKEN,
      g,
      state,
    );

  it('404 without --control, and from any peer but the loopback', () => {
    const notFound = readJson<Golden>(
      join(contract, 'errors/404.not-found.json'),
    );
    const out = emit(initialState(), '{"state":"read-only"}');
    expect(out.status).toBe(404);
    expect(out.body).toEqual(notFound.body);
    expect((out as { emit?: unknown }).emit).toBeUndefined();
    for (const remote of ['10.0.0.5', '::1', null]) {
      const far = emit(controlled(), '{"state":"read-only"}', remote);
      expect(far.status, String(remote)).toBe(404);
      expect((far as { emit?: unknown }).emit).toBeUndefined();
    }
  });

  it('a bad body is 400 invalid-body and emits nothing', () => {
    for (const payload of [
      '',
      'nope',
      '{}',
      '{"state":7}',
      '{"state":"Read Only"}',
    ]) {
      const out = emit(controlled(), payload);
      expect(out.status, payload).toBe(400);
      expect(body(out).error).toBe('invalid-body');
      expect((out as { emit?: unknown }).emit).toBeUndefined();
    }
  });

  it("frames are shaped like the stream's, ids past every replayed frame and rising, never journaled", () => {
    let state = controlled();
    const ids: number[] = [];
    for (const wanted of ['read-only', 'fully-connected']) {
      const out = emit(state, JSON.stringify({ state: wanted }));
      expect(out.status).toBe(200);
      const frame = String((out as { emit?: Buffer }).emit);
      const m = /^id: (\d+)\nevent: connection\.state\ndata: (.+)\n\n$/.exec(
        frame,
      );
      expect(m, frame).not.toBeNull();
      ids.push(Number(m![1]));
      expect(JSON.parse(m![2]!)).toEqual({
        event: 'connection.state',
        state: wanted,
      });
      state = out.next ?? state;
    }
    expect(ids[0]).toBeGreaterThan(1000);
    expect(ids[1]).toBe(ids[0]! + 1);
    expect(state.journal).toEqual([]);
  });

  it('over the socket: an open stream receives the emitted frame', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wm-fake-daemon-s7a-'));
    const daemon = await start({
      dir: join(dir, 'wm'),
      port: 0,
      control: true,
      write: () => undefined,
      frameGapMs: 1,
    });
    const base = `http://127.0.0.1:${daemon.port}`;
    const ac = new AbortController();
    try {
      const sse = await fetch(`${base}/v1/events/sse`, {
        headers: { authorization: `Bearer ${daemon.token}` },
        signal: ac.signal,
      });
      const reader = sse.body!.getReader();
      let text = '';
      while (!text.includes('\n\n')) {
        const { value, done } = await reader.read();
        if (done) break;
        text += Buffer.from(value).toString('utf8');
      }
      const ok = await fetch(`${base}/v1/_emit`, {
        method: 'POST',
        body: '{"state":"read-only"}',
      });
      expect(ok.status).toBe(200);
      while (!text.includes('"state":"read-only"')) {
        const { value, done } = await reader.read();
        if (done) break;
        text += Buffer.from(value).toString('utf8');
      }
      expect(text).toMatch(
        /id: \d+\nevent: connection\.state\ndata: \{"event":"connection\.state","state":"read-only"\}\n\n/,
      );
    } finally {
      ac.abort();
      await daemon.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('v2 S7a: a scenario may name only a known generator', () => {
  it('an unknown generator throws at load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wm-scenarios-s7a-'));
    try {
      mkdirSync(join(dir, 'a'));
      writeFileSync(
        join(dir, 'a', 'scenario.json'),
        JSON.stringify({ summary: 's', generator: 'nope' }),
      );
      expect(() => loadScenarios(dir)).toThrow(/generator/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
