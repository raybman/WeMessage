#!/usr/bin/env node
// tools/swift/fake-daemon.mjs: the S0 goldens served over loopback for the
// CI UI lane (docs/plans/v2-swift-S3.md §3.10, §4.9). Zero dependencies.
// Reads fixtures/contract and fixtures/scenarios at runtime (the
// dependency-cruiser rule forbids tools/ IMPORTING fixtures/, not reading
// them). Synthetic data only: everything it answers is already in the tree.
//
//   node tools/swift/fake-daemon.mjs --dir <path> [--port <n>] [--pid-file <path>] [--control]
//
// On start it mints a bearer, writes it to <dir>/daemon.token (0600), binds
// the literal 127.0.0.1 and prints exactly one line,
// {"ready":true,"port":<n>,"dir":"<path>"}. The bearer is never printed.
//
// v2 S4b: a scenario (fixtures/scenarios/<name>) overlays the S0 goldens,
// along its `extends` chain, and replays its event stream after the
// greeting. With --control, and only then, three loopback routes drive it
// from a UI test (docs/plans/v2-swift-S4.md, advisor item 3):
//   POST /v1/_scenario {"name"}  switch scenario (the journal is kept)
//   POST /v1/_reset              back to "default": state and journal cleared
//   GET  /v1/_journal            every request the app made since the reset
// They carry no bearer (the UI test runner is sandboxed and cannot read the
// token file); they answer only a 127.0.0.1 peer, and are never journaled.
//
// v2 S4f: with --control, POST /v1/toggles/kill-switch {"on": bool} is served
// (bearer and journal as any app route) and flips the kill switch in status
// and settings until the next scenario switch or reset. Without --control it
// stays parked (409), as S3 pinned it.
import { timingSafeEqual, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CONTRACT = fileURLToPath(
  new URL('../../fixtures/contract', import.meta.url),
);
const SCENARIOS = fileURLToPath(
  new URL('../../fixtures/scenarios', import.meta.url),
);
const LOOPBACK = '127.0.0.1';
/** The peers a control route answers: the IPv4 loopback, plain or mapped. */
const LOOPBACK_PEERS = new Set([LOOPBACK, '::ffff:' + LOOPBACK]);
const DEFAULT_PORT = 47100;
/** The S0 goldens alone, with no overlay: what a fresh start serves. */
export const DEFAULT_SCENARIO = 'default';

/** The routes the window may call, and the golden that answers each. */
const SERVED = [
  'GET /v1/health',
  'GET /v1/status',
  'GET /v1/drafts',
  'GET /v1/threads',
  'GET /v1/audit',
  'GET /v1/settings',
  'PATCH /v1/settings',
  'GET /v1/doctor',
  'GET /v1/contacts',
  'GET /v1/adapters',
];
const OPEN = new Set(['GET /v1/health']);
const STREAM = 'GET /v1/events/sse';
const MESSAGES = /^GET \/v1\/threads\/([^/]+)\/messages$/;
const MESSAGES_ROUTE = 'GET /v1/threads/:guid/messages';
const DRAFT_ACTION = /^POST \/v1\/drafts\/([^/]+)\/(approve|reject|recall)$/;
/** Auto-send and schedules are parked: 409 for these, whatever the body. */
const PARKED =
  /^(POST \/v1\/schedules|POST \/v1\/send|PATCH \/v1\/toggles\/.+|POST \/v1\/toggles\/.+)$/;

/** The control surface, answered only with --control and a loopback peer. */
const CONTROL_PREFIX = '/v1/_';
const CONTROL_SCENARIO = 'POST /v1/_scenario';
const CONTROL_RESET = 'POST /v1/_reset';
const CONTROL_JOURNAL = 'GET /v1/_journal';
/** v2 S4f: served (only with --control) so the kill banner can disengage. */
const KILL_TOGGLE = 'POST /v1/toggles/kill-switch';

/** The draft state machine the queue routes walk: action -> [from, to]. */
const TRANSITIONS = {
  approve: ['pending', 'approved'],
  reject: ['pending', 'rejected'],
  recall: ['approved', 'recalled'],
};
/** The states GET /v1/drafts leaves out when no state is asked for. */
const TERMINAL = new Set([
  'sent',
  'rejected',
  'expired',
  'superseded',
  'recalled',
  'failed',
]);

function parsePort(raw) {
  const n = Number(raw);
  if (!/^\d+$/.test(String(raw)) || n > 65535) {
    throw new Error(`fake-daemon: not a port: ${raw}`);
  }
  return n;
}

/** -> { dir, port, pidFile, control }. Throws without a directory or on any unknown flag. */
export function parseArgs(argv, env) {
  let dir = null;
  let port = null;
  let pidFile = null;
  let control = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--control') {
      control = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined)
      throw new Error(`fake-daemon: ${flag} needs a value`);
    if (flag === '--dir') dir = value;
    else if (flag === '--port') port = parsePort(value);
    else if (flag === '--pid-file') pidFile = value;
    else throw new Error(`fake-daemon: unknown flag ${flag}`);
    i += 1;
  }
  dir = dir ?? env.WEMESSAGE_DIR ?? null;
  if (!dir) throw new Error('fake-daemon: --dir or WEMESSAGE_DIR is required');
  if (port === null) {
    port = env.WEMESSAGE_PORT ? parsePort(env.WEMESSAGE_PORT) : DEFAULT_PORT;
  }
  return { dir, port, pidFile, control };
}

/** 'wm_' + 64 lowercase hex over 32 bytes. */
export function mintToken(bytes = randomBytes(32)) {
  return 'wm_' + Buffer.from(bytes).toString('hex');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Goldens keyed by their own `route` field; the first file in name order wins a shared route. */
function indexDir(dir) {
  const map = new Map();
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort()) {
    const golden = readJson(join(dir, name));
    if (typeof golden.route !== 'string' || map.has(golden.route)) continue;
    map.set(golden.route, { status: golden.status, body: golden.body });
  }
  return map;
}

function byName(dir, name) {
  const golden = readJson(join(dir, name));
  return { status: golden.status, body: golden.body };
}

/** Transcripts keyed by the chatGuid in each body: many files share one route. */
function indexMessages(dir) {
  const map = new Map();
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort()) {
    const golden = readJson(join(dir, name));
    if (golden.route !== MESSAGES_ROUTE) continue;
    const guid = golden.body?.chatGuid;
    if (typeof guid === 'string' && !map.has(guid))
      map.set(guid, { status: golden.status, body: golden.body });
  }
  return map;
}

/** The frames of one sse/ directory, in file-name order, or null without one. */
function readFrames(dir) {
  if (!existsSync(dir)) return null;
  return readdirSync(dir)
    .filter((n) => n.endsWith('.txt'))
    .sort()
    .map((n) => readFileSync(join(dir, n)));
}

/** The numeric `id:` of one frame, 0 when it has none. */
function frameId(frame) {
  const m = /^id: (\d+)$/m.exec(frame.toString('utf8'));
  return m ? Number(m[1]) : 0;
}

/**
 * fixtures/scenarios/<name>/{scenario.json, responses/*.json, sse/*.txt},
 * keyed by name. Throws on an `extends` that names nothing or loops.
 */
export function loadScenarios(dir = SCENARIOS) {
  const map = new Map();
  if (!existsSync(dir)) return map;
  for (const name of readdirSync(dir).sort()) {
    const meta = join(dir, name, 'scenario.json');
    if (!existsSync(meta)) continue;
    const { summary, extends: parent = null } = readJson(meta);
    const responses = join(dir, name, 'responses');
    const has = existsSync(responses);
    map.set(name, {
      name,
      summary,
      parent,
      responses: has ? indexDir(responses) : new Map(),
      messages: has ? indexMessages(responses) : new Map(),
      frames: readFrames(join(dir, name, 'sse')),
    });
  }
  if (map.has(DEFAULT_SCENARIO))
    throw new Error(`fake-daemon: "${DEFAULT_SCENARIO}" is reserved`);
  for (const name of map.keys()) chainOf({ scenarios: map }, name);
  return map;
}

export function loadGoldens(root = CONTRACT, scenarios = SCENARIOS) {
  const errors = join(root, 'errors');
  const sse = join(root, 'sse');
  return {
    responses: indexDir(join(root, 'responses')),
    messages: indexMessages(join(root, 'responses')),
    scenarios: loadScenarios(scenarios),
    errors: {
      missing: byName(errors, '401.missing.json'),
      unauthorized: byName(errors, '401.unauthorized.json'),
      parked: byName(errors, '409.parked.json'),
      notFound: byName(errors, '404.not-found.json'),
      unknownChat: byName(errors, '404.unknown-chat.json'),
      illegalTransition: byName(errors, '409.illegal-transition.json'),
    },
    sse: {
      headers: readJson(join(sse, 'headers.json')),
      greeting: readFileSync(join(sse, 'greeting.txt')),
      keepalive: readFileSync(join(sse, 'keepalive.txt')),
    },
    wire: readJson(join(root, 'wire.json')),
  };
}

/** Constant-time over equal-length buffers; a length mismatch is simply false. */
function sameSecret(presented, expected) {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

const JSON_HEADERS = { 'content-type': 'application/json' };

/**
 * @typedef {{ status: number, headers: Record<string, string>, body?: unknown,
 *   stream?: boolean, frames?: Buffer[], next?: ReturnType<typeof initialState> }} Answer
 */

/** @param {{ status: number, body: unknown }} golden @returns {Answer} */
function answer(golden) {
  return { status: golden.status, headers: JSON_HEADERS, body: golden.body };
}

/**
 * The state a fresh daemon holds; `control` is fixed for its life.
 * `killSwitch` is null until the kill toggle flips it (v2 S4f).
 * @returns {{ control: boolean, scenario: string, drafts: Record<string, any>,
 *   journal: Array<{ method: string, path: string, query: string, status: number }>,
 *   killSwitch: boolean | null }}
 */
export function initialState({ control = false } = {}) {
  return {
    control,
    scenario: DEFAULT_SCENARIO,
    drafts: {},
    journal: [],
    killSwitch: null,
  };
}

/** [name, its parent, ...]; "default" is the empty chain. Throws on a loop or a missing parent. */
function chainOf(goldens, name) {
  const chain = [];
  let at = name;
  while (at !== null && at !== DEFAULT_SCENARIO) {
    const scenario = goldens.scenarios.get(at);
    if (!scenario) throw new Error(`fake-daemon: no scenario "${at}"`);
    if (chain.includes(scenario)) throw new Error(`fake-daemon: "${at}" loops`);
    chain.push(scenario);
    at = scenario.parent;
  }
  return chain;
}

/** The golden for `key` along the scenario chain, then S0. */
function resolve(goldens, state, key) {
  for (const scenario of chainOf(goldens, state.scenario)) {
    const hit = scenario.responses.get(key);
    if (hit) return hit;
  }
  return goldens.responses.get(key);
}

function resolveMessages(goldens, state, guid) {
  for (const scenario of chainOf(goldens, state.scenario)) {
    const hit = scenario.messages.get(guid);
    if (hit) return hit;
  }
  return goldens.messages.get(guid) ?? goldens.errors.unknownChat;
}

/** The scenario's queue with this daemon's transitions applied. */
function queue(goldens, state) {
  const list = resolve(goldens, state, 'GET /v1/drafts');
  const drafts = list?.status === 200 ? (list.body?.drafts ?? []) : [];
  return drafts.map((d) => state.drafts[d.id] ?? d);
}

/** The greeting, saying the scenario's own connection state when it has one. */
function greetingFor(goldens, state) {
  const status = resolve(goldens, state, 'GET /v1/status');
  const wanted = status?.status === 200 ? status.body?.connectionState : null;
  const text = goldens.sse.greeting.toString('utf8');
  const line = /^data: (.*)$/m.exec(text);
  if (!wanted || !line) return goldens.sse.greeting;
  const payload = JSON.parse(line[1]);
  if (payload.state === wanted) return goldens.sse.greeting;
  return Buffer.from(
    text.replace(
      line[0],
      `data: ${JSON.stringify({ ...payload, state: wanted })}`,
    ),
  );
}

/**
 * The greeting, then the scenario's frames whose id is past `lastEventId`.
 * @param {ReturnType<typeof loadGoldens>} goldens
 * @param {ReturnType<typeof initialState>} state
 * @param {number | string | undefined} [lastEventId]
 * @returns {Buffer[]}
 */
export function replay(goldens, state, lastEventId = 0) {
  const after = Number(lastEventId) || 0;
  const source = chainOf(goldens, state.scenario).find((s) => s.frames);
  const frames = (source?.frames ?? []).filter((f) => frameId(f) > after);
  return [greetingFor(goldens, state), ...frames];
}

function seconds(goldens, state, key) {
  const settings = resolve(goldens, state, 'GET /v1/settings');
  const value = settings?.body?.settings?.[key]?.value;
  return typeof value === 'number' ? value : 0;
}

/** POST /v1/drafts/:id/<action>: the state machine over the scenario's queue. */
function transition(goldens, state, id, action, now) {
  const draft = queue(goldens, state).find((d) => d.id === id);
  if (!draft) return { answer: answer(goldens.errors.notFound) };
  const [from, to] = TRANSITIONS[action];
  if (draft.state !== from) {
    const err = goldens.errors.illegalTransition;
    return {
      answer: {
        status: err.status,
        headers: JSON_HEADERS,
        body: { ...err.body, from: draft.state, requested: action },
      },
    };
  }
  const at = now ?? draft.stateChangedAt;
  const moved = { ...draft, state: to, stateChangedAt: at };
  delete moved.sendNotBefore;
  if (to === 'approved') {
    const grace = seconds(goldens, state, 'send.undoGraceSeconds');
    moved.sendNotBefore = new Date(Date.parse(at) + grace * 1000).toISOString();
  }
  return {
    answer: {
      status: 200,
      headers: JSON_HEADERS,
      body: { draft: moved, approvalId: `apv-${id}-${action}` },
    },
    next: { ...state, drafts: { ...state.drafts, [id]: moved } },
  };
}

function controlError(error, detail, extra = {}) {
  return {
    status: 400,
    headers: JSON_HEADERS,
    body: { error, detail, ...extra },
  };
}

/** The three control routes. Only reached with --control and a loopback peer. */
function control(goldens, state, key, rawBody) {
  if (key === CONTROL_JOURNAL) {
    return {
      status: 200,
      headers: JSON_HEADERS,
      body: { scenario: state.scenario, requests: state.journal },
    };
  }
  if (key === CONTROL_RESET) {
    return {
      status: 200,
      headers: JSON_HEADERS,
      body: { scenario: DEFAULT_SCENARIO },
      next: initialState({ control: state.control }),
    };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(String(rawBody ?? ''));
  } catch {
    parsed = null;
  }
  const name = parsed && typeof parsed === 'object' ? parsed.name : undefined;
  if (typeof name !== 'string')
    return controlError(
      'invalid-body',
      'want a JSON body {"name": "<scenario>"}',
    );
  const known = [DEFAULT_SCENARIO, ...goldens.scenarios.keys()];
  if (!known.includes(name)) {
    return controlError('unknown-scenario', `no scenario named "${name}"`, {
      known,
    });
  }
  return {
    status: 200,
    headers: JSON_HEADERS,
    body: {
      scenario: name,
      summary: goldens.scenarios.get(name)?.summary ?? 'the S0 goldens alone',
    },
    next: { ...state, scenario: name, drafts: {}, killSwitch: null },
  };
}

/** GET /v1/status and GET /v1/settings with a flipped kill switch laid over. */
function withKill(goldens, state, key) {
  const base = resolve(goldens, state, key);
  const on = state.killSwitch;
  if (on === null || on === undefined || base?.status !== 200) return base;
  if (key === 'GET /v1/status') {
    const s0 = goldens.responses.get(key)?.body?.armed;
    const armed = on
      ? { armed: false, until: null, reason: 'kill-switch' }
      : base.body.armed?.reason === 'kill-switch'
        ? s0
        : base.body.armed;
    return { ...base, body: { ...base.body, killSwitch: on, armed } };
  }
  const settings = base.body.settings ?? {};
  const entry = settings['send.killSwitch'];
  if (!entry) return base;
  return {
    ...base,
    body: {
      ...base.body,
      settings: { ...settings, 'send.killSwitch': { ...entry, value: on } },
    },
  };
}

/** POST /v1/toggles/kill-switch {"on": bool}, only with --control. */
function toggleKill(goldens, state, rawBody) {
  let parsed = null;
  try {
    parsed = JSON.parse(String(rawBody ?? ''));
  } catch {
    parsed = null;
  }
  const on = parsed && typeof parsed === 'object' ? parsed.on : undefined;
  if (typeof on !== 'boolean')
    return controlError('invalid-body', 'want a JSON body {"on": boolean}');
  const version = on ? 0 : 1;
  return {
    status: 200,
    headers: JSON_HEADERS,
    body: {
      key: 'send.killSwitch',
      on,
      version,
      cancelled: [],
      circuitCleared: false,
    },
    next: { ...state, killSwitch: on },
  };
}

/** GET /v1/drafts with the daemon's filter: a named state, or every live one. */
function listDrafts(goldens, state, query) {
  const list = resolve(goldens, state, 'GET /v1/drafts');
  if (list.status !== 200) return answer(list);
  const wanted = new URLSearchParams(query).get('state');
  const drafts = queue(goldens, state).filter((d) =>
    wanted ? d.state === wanted : !TERMINAL.has(d.state),
  );
  return { status: 200, headers: JSON_HEADERS, body: { ...list.body, drafts } };
}

/** The S3b table, now over a scenario. -> an Answer and, if it moved, the next state. */
function dispatch(req, token, goldens, state, key, query) {
  if (
    key.startsWith('GET ' + CONTROL_PREFIX) ||
    key.startsWith('POST ' + CONTROL_PREFIX)
  ) {
    const isControl = [
      CONTROL_SCENARIO,
      CONTROL_RESET,
      CONTROL_JOURNAL,
    ].includes(key);
    if (!isControl || !state.control || !LOOPBACK_PEERS.has(req.remote ?? ''))
      return answer(goldens.errors.notFound);
    return control(goldens, state, key, req.body);
  }

  if (OPEN.has(key)) return answer(goldens.responses.get(key));

  const known =
    SERVED.includes(key) ||
    key === STREAM ||
    PARKED.test(key) ||
    MESSAGES.test(key) ||
    DRAFT_ACTION.test(key);
  if (!known) return answer(goldens.errors.notFound);

  const header = req.authorization ?? '';
  if (!header) return answer(goldens.errors.missing);
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!sameSecret(presented, token)) return answer(goldens.errors.unauthorized);

  if (key === STREAM) {
    return {
      status: 200,
      headers: goldens.sse.headers,
      stream: true,
      frames: replay(goldens, state, req.lastEventId),
    };
  }
  if (
    key === KILL_TOGGLE &&
    state.control &&
    LOOPBACK_PEERS.has(req.remote ?? '')
  )
    return toggleKill(goldens, state, req.body);
  if (PARKED.test(key)) return answer(goldens.errors.parked);

  const messages = MESSAGES.exec(key);
  if (messages) {
    let guid = '';
    try {
      guid = decodeURIComponent(messages[1] ?? '');
    } catch {
      return answer(goldens.errors.unknownChat);
    }
    return answer(resolveMessages(goldens, state, guid));
  }
  const action = DRAFT_ACTION.exec(key);
  if (action) {
    const id = decodeURIComponent(action[1] ?? '');
    const { answer: out, next } = transition(
      goldens,
      state,
      id,
      action[2],
      req.now,
    );
    return next ? { ...out, next } : out;
  }
  if (key === 'GET /v1/drafts') return listDrafts(goldens, state, query);
  if (key === 'GET /v1/status' || key === 'GET /v1/settings')
    return answer(withKill(goldens, state, key));
  return answer(resolve(goldens, state, key));
}

/**
 * Pure over (req, token, goldens, state): the same arguments give the same
 * Answer, and nothing passed in is changed. A request that moves the state
 * comes back with `next`; every request outside /v1/_ is journaled in it.
 * @param {{ method?: string | undefined, path?: string | undefined,
 *   authorization?: string | undefined, body?: string | undefined,
 *   remote?: string | undefined, lastEventId?: string | undefined,
 *   now?: string | undefined }} req
 * @param {string} token
 * @param {ReturnType<typeof loadGoldens>} goldens
 * @param {ReturnType<typeof initialState>} [state]
 * @returns {Answer}
 */
export function route(req, token, goldens, state = initialState()) {
  const raw = String(req.path ?? '/');
  const cut = raw.indexOf('?');
  const path = cut === -1 ? raw : raw.slice(0, cut);
  const query = cut === -1 ? '' : raw.slice(cut + 1);
  const method = String(req.method ?? 'GET').toUpperCase();
  const key = `${method} ${path}`;

  const out = dispatch(req, token, goldens, state, key, query);
  if (path.startsWith(CONTROL_PREFIX)) return out;
  const base = out.next ?? state;
  return {
    ...out,
    next: {
      ...base,
      journal: [...base.journal, { method, path, query, status: out.status }],
    },
  };
}

/**
 * mkdir -p dir; write dir/daemon.token (0600); listen on 127.0.0.1:port;
 * write pidFile if given; print one ready line through `write`.
 * @param {{ dir: string, port: number, pidFile?: string | null,
 *   control?: boolean, write?: (line: string) => unknown, root?: string,
 *   scenarios?: string, frameGapMs?: number }} options
 */
export async function start({
  dir,
  port,
  pidFile = null,
  control = false,
  write = (s) => process.stdout.write(s),
  root = CONTRACT,
  scenarios = SCENARIOS,
  frameGapMs = 250,
}) {
  const goldens = loadGoldens(root, scenarios);
  const token = mintToken();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'daemon.token'), token + '\n', { mode: 0o600 });

  let state = initialState({ control });
  const streams = new Set();
  const handle = (req, res, body) => {
    const out = route(
      {
        method: req.method,
        path: req.url,
        authorization: req.headers.authorization,
        body,
        remote: req.socket.remoteAddress,
        lastEventId: req.headers['last-event-id'],
        now: new Date().toISOString(),
      },
      token,
      goldens,
      state,
    );
    if (out.next) state = out.next;
    if (out.stream) {
      res.writeHead(200, out.headers);
      // The greeting at once, then one replayed frame per gap, then the
      // keepalive the S0 wire names.
      const [greeting, ...frames] = out.frames ?? [goldens.sse.greeting];
      res.write(greeting);
      const timers = frames.map((frame, i) =>
        setTimeout(() => res.write(frame), frameGapMs * (i + 1)),
      );
      const timer = setInterval(
        () => res.write(goldens.sse.keepalive),
        goldens.wire.sse.keepaliveMs,
      );
      streams.add(res);
      const end = () => {
        for (const t of timers) clearTimeout(t);
        clearInterval(timer);
        streams.delete(res);
      };
      // Not req 'close': the body is already read, so it has fired.
      res.on('close', end);
      return;
    }
    res.writeHead(out.status, out.headers);
    res.end(JSON.stringify(out.body));
  };
  const server = createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= 65536) chunks.push(chunk);
    });
    req.on('end', () =>
      handle(req, res, Buffer.concat(chunks).toString('utf8')),
    );
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, LOOPBACK, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const bound = server.address().port;
  if (pidFile) writeFileSync(pidFile, `${process.pid}\n`);
  write(JSON.stringify({ ready: true, port: bound, dir }) + '\n');

  const close = () =>
    new Promise((resolve) => {
      for (const res of streams) res.destroy();
      streams.clear();
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  return { server, port: bound, token, close };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const daemon = await start(parseArgs(process.argv.slice(2), process.env));
    const stop = () => {
      void daemon.close().then(() => process.exit(0));
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
