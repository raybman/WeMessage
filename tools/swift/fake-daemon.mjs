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
//
// v2 S7a: a scenario.json may name a generator instead of shipping
// responses: {"generator": "bulk"} serves tools/swift/bulk.mjs's 4,000
// threads and 2,000-turn transcript, paged as the real daemon pages (v2 F1:
// {"generator": "long"} serves 250 threads and a 450-turn transcript). With
// --control, POST /v1/_emit {"state"} writes one live connection.state
// frame to every open stream, so a UI test can time event to label.
//
// v2 F3d (G-06a): Done, Snooze and Mute are kept as the daemon keeps them
// (packages/daemon/src/routes/thread-state.ts): PUT /v1/threads/:guid/state
// with its strict body, the ifUpdatedAt 409 and a cleared record deleted,
// and GET /v1/threads/state with wake judged against the request clock.
// Seed records come from the scenario chain only, never from S0, so no
// other board's queue moves; writes live until a scenario switch or reset,
// so a relaunched app reads back what it wrote. A write is journaled with
// its sorted body keys (never values) so a UI test can ban seenAt.
//
// v2 F2e: GET /v1/search and GET /v1/threads/:guid/years. A scenario's
// responses/search.*.json pages answer the query their own
// `coverage.tokens` echo (op and value in the daemon's order, instants
// compared as instants): the daemon's echo of a request IS the request, so
// the files stay {route, status, body}. The nearest scenario in the chain
// with any search page owns search (S0's goldens without one); any other
// query is an empty page with that coverage and its tokens echoed as
// core's compileSearch echoes them. Every canned page is one page, so a
// cursor is answered with the empty page. Years are a canned answer for the
// chat and zone, else counted from the served transcript in the zone.
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
import { LONG, generateBulk, pageMessages, pageThreads } from './bulk.mjs';

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
  // v2 S4j: board 14's Send creates a pending draft after its undo window;
  // the create golden answers it (201). The queue's approve still sends.
  'POST /v1/drafts',
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
/**
 * v2 F5: which conversation a handle has, a read. A scenario answers a
 * handle with a responses/ file on this route whose body names it; any
 * other handle is the S0 "none" golden, renamed. Like the daemon, an empty
 * handle, one with a ';' or one over 320 characters is 400 invalid-handle.
 */
const BY_HANDLE = /^GET \/v1\/threads\/by-handle\/([^/]*)$/;
const BY_HANDLE_ROUTE = 'GET /v1/threads/by-handle/:handle';
/** v2 F2e: message search and a thread's years. */
const SEARCH = 'GET /v1/search';
const YEARS = /^GET \/v1\/threads\/([^/]+)\/years$/;
const YEARS_ROUTE = 'GET /v1/threads/:guid/years';
const SEARCH_KEYS = new Set([
  'term',
  'from',
  'in',
  'channel',
  'has',
  'before',
  'after',
  'tz',
  'limit',
  'cursor',
]);
const SEARCH_CHANNELS = ['imessage', 'whatsapp', 'linkedin', 'email'];
/** core's TRIGRAM_MIN: a shorter term alone is matched in a window only. */
const TRIGRAM_MIN = 3;
/** v2 F3d: the thread-state pair. */
const THREAD_STATES = 'GET /v1/threads/state';
const THREAD_STATE = /^PUT \/v1\/threads\/([^/]+)\/state$/;
const ACTS = new Set(['done', 'snoozed', 'muted']);
const ATTENTIONS = new Set(['queue', 'stream', 'muted']);
const STATE_KEYS = new Set([
  'act',
  'actAt',
  'snoozedUntil',
  'attention',
  'ifUpdatedAt',
]);
/** An ISO-8601 instant with an offset, as the daemon's zod `iso.datetime({offset: true})`. */
const INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
/** Auto-send and schedules are parked: 409 for these, whatever the body. */
const PARKED =
  /^(POST \/v1\/schedules|POST \/v1\/send|PATCH \/v1\/toggles\/.+|POST \/v1\/toggles\/.+)$/;

/** The control surface, answered only with --control and a loopback peer. */
const CONTROL_PREFIX = '/v1/_';
const CONTROL_SCENARIO = 'POST /v1/_scenario';
const CONTROL_RESET = 'POST /v1/_reset';
const CONTROL_JOURNAL = 'GET /v1/_journal';
const CONTROL_EMIT = 'POST /v1/_emit';
/** The ids live frames carry: past any replayed frame, rising per emit. */
const EMIT_BASE_ID = 100000;
/** A connection state is a short kebab word, as the daemon's are. */
const EMIT_STATE = /^[a-z][a-z-]{0,39}$/;
/** The generators a scenario.json may name. */
const GENERATORS = { bulk: generateBulk, long: () => generateBulk(LONG) };
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

/** v2 F5: by-handle answers keyed by the handle in each body. */
function indexHandles(dir) {
  const map = new Map();
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort()) {
    const golden = readJson(join(dir, name));
    if (golden.route !== BY_HANDLE_ROUTE) continue;
    const handle = golden.body?.handle;
    if (typeof handle === 'string' && !map.has(handle))
      map.set(handle, { status: golden.status, body: golden.body });
  }
  return map;
}

/** v2 F2e: every search page in a directory, in file-name order. */
function indexSearches(dir) {
  const list = [];
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort()) {
    const golden = readJson(join(dir, name));
    if (golden.route === SEARCH)
      list.push({ status: golden.status, body: golden.body });
  }
  return list;
}

/** v2 F2e: years answers keyed by `chatGuid` and `tz` in each body. */
function indexYears(dir) {
  const map = new Map();
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort()) {
    const golden = readJson(join(dir, name));
    if (golden.route !== YEARS_ROUTE) continue;
    const key = `${golden.body?.chatGuid}\n${golden.body?.tz}`;
    if (!map.has(key))
      map.set(key, { status: golden.status, body: golden.body });
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
    const {
      summary,
      extends: parent = null,
      generator = null,
    } = readJson(meta);
    if (generator !== null && !Object.hasOwn(GENERATORS, generator))
      throw new Error(
        `fake-daemon: "${name}" names no generator "${generator}"`,
      );
    const responses = join(dir, name, 'responses');
    const has = existsSync(responses);
    map.set(name, {
      name,
      summary,
      parent,
      generated: generator === null ? null : GENERATORS[generator](),
      responses: has ? indexDir(responses) : new Map(),
      messages: has ? indexMessages(responses) : new Map(),
      handles: has ? indexHandles(responses) : new Map(),
      searches: has ? indexSearches(responses) : [],
      years: has ? indexYears(responses) : new Map(),
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
    handles: indexHandles(join(root, 'responses')),
    searches: indexSearches(join(root, 'responses')),
    years: indexYears(join(root, 'responses')),
    noConversation: byName(
      join(root, 'responses'),
      'threads.by-handle.none.json',
    ),
    scenarios: loadScenarios(scenarios),
    errors: {
      missing: byName(errors, '401.missing.json'),
      unauthorized: byName(errors, '401.unauthorized.json'),
      parked: byName(errors, '409.parked.json'),
      notFound: byName(errors, '404.not-found.json'),
      unknownChat: byName(errors, '404.unknown-chat.json'),
      illegalTransition: byName(errors, '409.illegal-transition.json'),
      invalidHandle: byName(errors, '400.invalid-handle.json'),
      invalidThreadState: byName(errors, '400.invalid-thread-state.json'),
      threadStateConflict: byName(errors, '409.thread-state-conflict.json'),
      invalidSearch: byName(errors, '400.invalid-search.json'),
      emptySearch: byName(errors, '400.empty-search.json'),
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
 *   stream?: boolean, frames?: Buffer[], emit?: Buffer,
 *   next?: ReturnType<typeof initialState> }} Answer
 */

/** @param {{ status: number, body: unknown }} golden @returns {Answer} */
function answer(golden) {
  return { status: golden.status, headers: JSON_HEADERS, body: golden.body };
}

/**
 * The state a fresh daemon holds; `control` is fixed for its life.
 * `killSwitch` is null until the kill toggle flips it (v2 S4f).
 * @returns {{ control: boolean, scenario: string, drafts: Record<string, any>,
 *   journal: Array<{ method: string, path: string, query: string, status: number,
 *     chatGuid?: string | null, bodyKeys?: string[] }>,
 *   killSwitch: boolean | null, emitted: number,
 *   threadState: Record<string, Record<string, unknown> | null> }}
 */
export function initialState({ control = false } = {}) {
  return {
    control,
    scenario: DEFAULT_SCENARIO,
    drafts: {},
    journal: [],
    killSwitch: null,
    emitted: 0,
    // v2 F3d: writes over the scenario's seed, by chatGuid; null deletes.
    threadState: {},
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

/** The nearest generated data along the scenario chain, or null. */
function generatedFor(goldens, state) {
  return (
    chainOf(goldens, state.scenario).find((s) => s.generated)?.generated ?? null
  );
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

/** One connection.state frame, as the daemon writes it. */
function liveFrame(id, connection) {
  const data = JSON.stringify({ event: 'connection.state', state: connection });
  return Buffer.from(`id: ${id}\nevent: connection.state\ndata: ${data}\n\n`);
}

/** The control routes. Only reached with --control and a loopback peer. */
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
  if (key === CONTROL_EMIT) {
    const wanted =
      parsed && typeof parsed === 'object' ? parsed.state : undefined;
    if (typeof wanted !== 'string' || !EMIT_STATE.test(wanted))
      return controlError(
        'invalid-body',
        'want a JSON body {"state": "<connection state>"}',
      );
    const id = EMIT_BASE_ID + state.emitted + 1;
    return {
      status: 200,
      headers: JSON_HEADERS,
      body: { emitted: 'connection.state', state: wanted, id },
      emit: liveFrame(id, wanted),
      next: { ...state, emitted: state.emitted + 1 },
    };
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
    next: {
      ...state,
      scenario: name,
      drafts: {},
      killSwitch: null,
      threadState: {},
    },
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

/** v2 F5: the scenario chain's answer for `raw`, then S0's, else "none". */
function resolveHandle(goldens, state, raw) {
  let handle = '';
  try {
    handle = decodeURIComponent(raw).trim();
  } catch {
    return goldens.errors.invalidHandle;
  }
  if (handle === '' || handle.includes(';') || handle.length > 320)
    return goldens.errors.invalidHandle;
  for (const scenario of chainOf(goldens, state.scenario)) {
    const hit = scenario.handles.get(handle);
    if (hit) return hit;
  }
  const none = goldens.noConversation;
  return (
    goldens.handles.get(handle) ?? {
      status: none.status,
      body: { ...none.body, handle },
    }
  );
}

/** An IANA zone this runtime knows, as the daemon's isValidTimeZone. */
function isZone(tz) {
  if (typeof tz !== 'string' || tz === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** An instant written the one way the daemon writes it: UTC, milliseconds. */
function toUtc(iso) {
  return new Date(iso).toISOString();
}

/**
 * The daemon's structured query from a search query string, or the error
 * golden it would answer. Only the refusals a UI test can reach are
 * mirrored: a missing or unknown zone, an unknown key, a bad instant, and
 * nothing to look for.
 */
function parseSearch(goldens, query) {
  const params = new URLSearchParams(query);
  const invalid = { error: goldens.errors.invalidSearch };
  for (const key of params.keys()) if (!SEARCH_KEYS.has(key)) return invalid;
  if (!isZone(params.get('tz'))) return invalid;
  const one = (key) => {
    const v = params.get(key);
    return v === null ? undefined : v.trim();
  };
  const p = {
    terms: params.getAll('term').map((t) => t.trim()),
    from: one('from'),
    in: one('in'),
    channels: [...new Set(params.getAll('channel'))],
    has: [...new Set(params.getAll('has'))],
    before: undefined,
    after: undefined,
    cursor: params.get('cursor'),
  };
  if (p.terms.some((t) => t === '') || p.from === '' || p.in === '')
    return invalid;
  if (p.channels.some((c) => !SEARCH_CHANNELS.includes(c))) return invalid;
  for (const key of ['before', 'after']) {
    const v = params.get(key);
    if (v === null) continue;
    if (!isInstant(v)) return invalid;
    p[key] = toUtc(v);
  }
  const empty =
    p.terms.length === 0 &&
    p.from === undefined &&
    p.in === undefined &&
    p.channels.length === 0 &&
    p.has.length === 0 &&
    p.before === undefined &&
    p.after === undefined;
  return empty ? { error: goldens.errors.emptySearch } : { params: p };
}

/** core's compileSearch echo: every token, applied, partial or not, in its order. */
function echoTokens(p) {
  const tokens = [];
  const long = p.terms.filter((t) => [...t].length >= TRIGRAM_MIN);
  for (const t of p.terms) {
    tokens.push(
      [...t].length >= TRIGRAM_MIN || long.length > 0
        ? { op: 'term', value: t, applied: 'applied' }
        : { op: 'term', value: t, applied: 'partial', reason: 'short-term' },
    );
  }
  if (p.from === 'me')
    tokens.push({ op: 'from', value: 'me', applied: 'applied' });
  else if (p.from !== undefined)
    tokens.push({
      op: 'from',
      value: p.from,
      applied: 'partial',
      reason: 'handles-and-saved-names',
    });
  if (p.in !== undefined)
    tokens.push({ op: 'in', value: p.in, applied: 'applied' });
  for (const c of p.channels)
    tokens.push(
      c === 'imessage'
        ? { op: 'channel', value: c, applied: 'applied' }
        : {
            op: 'channel',
            value: c,
            applied: 'not-applied',
            reason: 'no-source',
          },
    );
  for (const h of p.has)
    tokens.push({ op: 'has', value: h, applied: 'applied' });
  if (p.before !== undefined)
    tokens.push({ op: 'before', value: p.before, applied: 'applied' });
  if (p.after !== undefined)
    tokens.push({ op: 'after', value: p.after, applied: 'applied' });
  return tokens;
}

/** A token list as one comparable string: op and value, instants as instants. */
function tokenKey(tokens) {
  return (tokens ?? [])
    .map((t) =>
      t.op === 'before' || t.op === 'after'
        ? `${t.op}=${Date.parse(t.value)}`
        : `${t.op}=${t.value}`,
    )
    .join('\n');
}

/** The search pages of the nearest scenario in the chain with any, else S0's. */
function searchPages(goldens, state) {
  for (const scenario of chainOf(goldens, state.scenario))
    if (scenario.searches.length > 0) return scenario.searches;
  return goldens.searches;
}

/** GET /v1/search over the scenario: a canned page, else an honest empty one. */
function searchFor(goldens, state, query) {
  const parsed = parseSearch(goldens, query);
  if (parsed.error) return answer(parsed.error);
  const p = parsed.params;
  const pages = searchPages(goldens, state);
  const tokens = echoTokens(p);
  const key = tokenKey(tokens);
  const hit = pages.find((g) => tokenKey(g.body?.coverage?.tokens) === key);
  if (hit && p.cursor === null) return answer(hit);
  const base = pages[0]?.body ?? goldens.responses.get(SEARCH)?.body;
  const imessageAsked =
    p.channels.length === 0 || p.channels.includes('imessage');
  const channels = (base?.coverage?.channels ?? []).map((c) =>
    c.channel === 'imessage' && !imessageAsked
      ? { channel: 'imessage', state: 'not-searched', reason: 'not-requested' }
      : c,
  );
  return {
    status: 200,
    headers: JSON_HEADERS,
    body: {
      hits: [],
      total: 0,
      nextCursor: null,
      asOf: base?.asOf,
      facets: { years: [], channels: [], senders: [] },
      coverage: {
        channels,
        tokens: hit ? hit.body.coverage.tokens : tokens,
        capped: false,
        deletedHidden: 0,
        deletionsChecked: true,
      },
    },
  };
}

/** The year `iso` falls in, in `tz`. */
function yearIn(iso, tz) {
  return Number(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric' }).format(
      new Date(iso),
    ),
  );
}

/** Turns by year in `tz`, newest first, empty years between kept, as the daemon counts. */
function countYears(turns, tz) {
  const by = new Map();
  for (const t of turns) {
    const y = yearIn(t.at, tz);
    const e = by.get(y) ?? [];
    e.push(t.at);
    by.set(y, e);
  }
  if (by.size === 0) return [];
  const ys = [...by.keys()];
  const out = [];
  for (let y = Math.max(...ys); y >= Math.min(...ys); y -= 1) {
    const ats = (by.get(y) ?? []).sort();
    out.push({
      year: y,
      count: ats.length,
      first: ats[0] ?? null,
      last: ats[ats.length - 1] ?? null,
    });
  }
  return out;
}

/** GET /v1/threads/:guid/years over the scenario. */
function yearsFor(goldens, state, raw, query) {
  let chatGuid = '';
  try {
    chatGuid = decodeURIComponent(raw);
  } catch {
    return answer(goldens.errors.unknownChat);
  }
  const params = new URLSearchParams(query);
  const tz = params.get('tz');
  if ([...params.keys()].some((k) => k !== 'tz') || !isZone(tz)) {
    return {
      status: 400,
      headers: JSON_HEADERS,
      body: {
        error: 'invalid-query',
        detail: {
          issues: [
            {
              code: 'custom',
              path: ['tz'],
              message: 'tz is not an IANA time zone',
            },
          ],
        },
      },
    };
  }
  const key = `${chatGuid}\n${tz}`;
  for (const scenario of chainOf(goldens, state.scenario)) {
    const hit = scenario.years.get(key);
    if (hit) return answer(hit);
  }
  const generated = generatedFor(goldens, state);
  let turns = null;
  let asOf = null;
  if (generated) {
    turns = generated.turns(chatGuid) ?? null;
    asOf = generated.asOf;
  } else {
    if (goldens.years.has(key)) return answer(goldens.years.get(key));
    const transcript = resolveMessages(goldens, state, chatGuid);
    if (transcript.status === 200) {
      turns = transcript.body.turns ?? [];
      asOf = transcript.body.asOf;
    }
  }
  if (turns === null) return answer(goldens.errors.unknownChat);
  return {
    status: 200,
    headers: JSON_HEADERS,
    body: { chatGuid, tz, years: countYears(turns, tz), asOf },
  };
}

/** The stored fields of a record, without the computed `awake`. */
function stored(record) {
  const rest = { ...record };
  delete rest.awake;
  return rest;
}

/** v2 F3d: the scenario chain's seed records overlaid with this daemon's writes, by chatGuid. */
function threadStates(goldens, state) {
  const byGuid = new Map();
  for (const scenario of chainOf(goldens, state.scenario)) {
    const hit = scenario.responses.get(THREAD_STATES);
    if (!hit) continue;
    for (const r of hit.body?.states ?? []) byGuid.set(r.chatGuid, stored(r));
    break;
  }
  for (const [guid, r] of Object.entries(state.threadState ?? {})) {
    if (r === null) byGuid.delete(guid);
    else byGuid.set(guid, r);
  }
  return byGuid;
}

/** The request clock, else the scenario's own `asOf`: never wall time. */
function clockOf(goldens, state, now) {
  if (now) return now;
  for (const scenario of chainOf(goldens, state.scenario)) {
    const asOf = scenario.responses.get(THREAD_STATES)?.body?.asOf;
    if (asOf) return asOf;
  }
  return goldens.responses.get(THREAD_STATES)?.body?.asOf;
}

/** A record as the wire carries it: wake is computed, never stored. */
function wireState(record, now) {
  if (!record) return null;
  const awake =
    record.act === 'snoozed' &&
    record.snoozedUntil !== null &&
    Date.parse(record.snoozedUntil) <= Date.parse(now);
  return { ...record, awake };
}

/** GET /v1/threads/state, sorted by chatGuid as the store lists them. */
function listThreadStates(goldens, state, now) {
  const at = clockOf(goldens, state, now);
  const states = [...threadStates(goldens, state).values()]
    .sort((a, b) =>
      a.chatGuid < b.chatGuid ? -1 : a.chatGuid > b.chatGuid ? 1 : 0,
    )
    .map((r) => wireState(r, at));
  return { status: 200, headers: JSON_HEADERS, body: { states, asOf: at } };
}

function isInstant(v) {
  return (
    typeof v === 'string' && INSTANT.test(v) && !Number.isNaN(Date.parse(v))
  );
}

/** The daemon's strict PUT body, or null when it would refuse it. */
function stateBody(raw, now) {
  let body = null;
  try {
    body = JSON.parse(String(raw ?? ''));
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (!Object.keys(body).every((k) => STATE_KEYS.has(k))) return null;
  if (!Object.hasOwn(body, 'act')) return null;
  const { act, actAt, snoozedUntil, attention, ifUpdatedAt } = body;
  if (act !== null && !ACTS.has(act)) return null;
  if (actAt !== undefined && !isInstant(actAt)) return null;
  if (
    snoozedUntil !== undefined &&
    snoozedUntil !== null &&
    !isInstant(snoozedUntil)
  )
    return null;
  if (
    attention !== undefined &&
    attention !== null &&
    !ATTENTIONS.has(attention)
  )
    return null;
  if (
    ifUpdatedAt !== undefined &&
    ifUpdatedAt !== null &&
    !isInstant(ifUpdatedAt)
  )
    return null;
  if (
    (act === 'snoozed') !==
    (snoozedUntil !== undefined && snoozedUntil !== null)
  )
    return null;
  if (
    actAt !== undefined &&
    (act === null || Date.parse(actAt) > Date.parse(now))
  )
    return null;
  return body;
}

/** One thread.state frame, as the daemon broadcasts it. */
function stateFrame(id, chatGuid, record) {
  const data = JSON.stringify({
    event: 'thread.state',
    chatGuid,
    state: record,
  });
  return Buffer.from(`id: ${id}\nevent: thread.state\ndata: ${data}\n\n`);
}

/** PUT /v1/threads/:guid/state, in the daemon's order: validate, check, write, frame. */
function putThreadState(goldens, state, raw, rawBody, now) {
  let chatGuid = '';
  try {
    chatGuid = decodeURIComponent(raw);
  } catch {
    return answer(goldens.errors.invalidThreadState);
  }
  const at = clockOf(goldens, state, now);
  const body =
    chatGuid.length < 1 || chatGuid.length > 512
      ? null
      : stateBody(rawBody, at);
  if (!body) return answer(goldens.errors.invalidThreadState);
  const previous = threadStates(goldens, state).get(chatGuid) ?? null;
  if (body.ifUpdatedAt !== undefined) {
    const current = previous?.updatedAt ?? null;
    const same =
      body.ifUpdatedAt === null || current === null
        ? body.ifUpdatedAt === current
        : Date.parse(body.ifUpdatedAt) === Date.parse(current);
    if (!same) {
      const conflict = goldens.errors.threadStateConflict;
      return {
        status: conflict.status,
        headers: JSON_HEADERS,
        body: {
          ...conflict.body,
          detail: { current: wireState(previous, at) },
        },
      };
    }
  }
  const attention =
    body.attention !== undefined
      ? body.attention
      : (previous?.attention ?? null);
  const next =
    body.act === null && attention === null
      ? null
      : {
          chatGuid,
          act: body.act,
          actAt:
            body.act === null
              ? null
              : body.actAt !== undefined
                ? new Date(body.actAt).toISOString()
                : at,
          snoozedUntil: body.act === 'snoozed' ? body.snoozedUntil : null,
          attention,
          updatedAt: at,
        };
  const wire = wireState(next, at);
  const id = EMIT_BASE_ID + state.emitted + 1;
  return {
    status: 200,
    headers: JSON_HEADERS,
    body: { state: wire },
    emit: stateFrame(id, chatGuid, wire),
    next: {
      ...state,
      emitted: state.emitted + 1,
      threadState: { ...state.threadState, [chatGuid]: next },
    },
  };
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
      CONTROL_EMIT,
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
    BY_HANDLE.test(key) ||
    DRAFT_ACTION.test(key) ||
    key === THREAD_STATES ||
    THREAD_STATE.test(key) ||
    key === SEARCH ||
    YEARS.test(key);
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
    const generated = generatedFor(goldens, state);
    if (generated) {
      const page = pageMessages(generated, guid, query);
      return answer(page ?? goldens.errors.unknownChat);
    }
    return answer(resolveMessages(goldens, state, guid));
  }
  if (key === SEARCH) return searchFor(goldens, state, query);
  if (key === THREAD_STATES) return listThreadStates(goldens, state, req.now);
  const threadState = THREAD_STATE.exec(key);
  if (threadState)
    return putThreadState(
      goldens,
      state,
      threadState[1] ?? '',
      req.body,
      req.now,
    );
  const byHandle = BY_HANDLE.exec(key);
  if (byHandle) return answer(resolveHandle(goldens, state, byHandle[1] ?? ''));
  const years = YEARS.exec(key);
  if (years) return yearsFor(goldens, state, years[1] ?? '', query);
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
  if (key === 'GET /v1/threads') {
    const generated = generatedFor(goldens, state);
    if (generated) return answer(pageThreads(generated, query));
  }
  if (key === 'GET /v1/status' || key === 'GET /v1/settings')
    return answer(withKill(goldens, state, key));
  return answer(resolve(goldens, state, key));
}

/** The chatGuid a draft-create body names, or null. */
function draftChatGuid(raw) {
  try {
    const guid = JSON.parse(String(raw ?? ''))?.chatGuid;
    return typeof guid === 'string' ? guid : null;
  } catch {
    return null;
  }
}

/** v2 F3d: the sorted top-level keys a state write sent, never their values. */
function bodyKeys(raw) {
  try {
    const body = JSON.parse(String(raw ?? ''));
    return body && typeof body === 'object' && !Array.isArray(body)
      ? Object.keys(body).sort()
      : [];
  } catch {
    return [];
  }
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
  // v2 F5: a draft create names the conversation it was written to, so a
  // UI test can prove compose drafted on the guid the daemon resolved.
  const entry = {
    method,
    path,
    query,
    status: out.status,
    ...(key === 'POST /v1/drafts' ? { chatGuid: draftChatGuid(req.body) } : {}),
    ...(THREAD_STATE.test(key) ? { bodyKeys: bodyKeys(req.body) } : {}),
  };
  return {
    ...out,
    next: { ...base, journal: [...base.journal, entry] },
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
    if (out.emit) for (const open of streams) open.write(out.emit);
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
