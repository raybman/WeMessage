#!/usr/bin/env node
// tools/swift/fake-daemon.mjs: the S0 goldens served over loopback for the
// CI UI lane (docs/plans/v2-swift-S3.md §3.10, §4.9). Zero dependencies.
// Reads fixtures/contract at runtime (the dependency-cruiser rule forbids
// tools/ IMPORTING fixtures/, not reading them). Synthetic data only:
// everything it answers is already in the tree.
//
//   node tools/swift/fake-daemon.mjs --dir <path> [--port <n>] [--pid-file <path>]
//
// On start it mints a bearer, writes it to <dir>/daemon.token (0600), binds
// the literal 127.0.0.1 and prints exactly one line,
// {"ready":true,"port":<n>,"dir":"<path>"}. The bearer is never printed.
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CONTRACT = fileURLToPath(
  new URL('../../fixtures/contract', import.meta.url),
);
const LOOPBACK = '127.0.0.1';
const DEFAULT_PORT = 47100;

/** The routes the window may call, and the golden that answers each. */
const SERVED = [
  'GET /v1/health',
  'GET /v1/status',
  'GET /v1/drafts',
  'GET /v1/threads',
];
const OPEN = new Set(['GET /v1/health']);
const STREAM = 'GET /v1/events/sse';
/** Auto-send and schedules are parked: 409 for these, whatever the body. */
const PARKED =
  /^(POST \/v1\/schedules|POST \/v1\/send|PATCH \/v1\/toggles\/.+|POST \/v1\/toggles\/.+)$/;

function parsePort(raw) {
  const n = Number(raw);
  if (!/^\d+$/.test(String(raw)) || n > 65535) {
    throw new Error(`fake-daemon: not a port: ${raw}`);
  }
  return n;
}

/** -> { dir, port, pidFile }. Throws without a directory or on any unknown flag. */
export function parseArgs(argv, env) {
  let dir = null;
  let port = null;
  let pidFile = null;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
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
  return { dir, port, pidFile };
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

export function loadGoldens(root = CONTRACT) {
  const errors = join(root, 'errors');
  const sse = join(root, 'sse');
  return {
    responses: indexDir(join(root, 'responses')),
    errors: {
      missing: byName(errors, '401.missing.json'),
      unauthorized: byName(errors, '401.unauthorized.json'),
      parked: byName(errors, '409.parked.json'),
      notFound: byName(errors, '404.not-found.json'),
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
 * @typedef {{ status: number, headers: Record<string, string>, body?: unknown, stream?: boolean }} Answer
 */

/** @param {{ status: number, body: unknown }} golden @returns {Answer} */
function answer(golden) {
  return { status: golden.status, headers: JSON_HEADERS, body: golden.body };
}

/**
 * Pure over (method, path, authorization): the §3.10 table.
 * @param {{ method?: string | undefined, path?: string | undefined,
 *   authorization?: string | undefined }} req
 * @param {string} token
 * @param {ReturnType<typeof loadGoldens>} goldens
 * @returns {Answer}
 */
export function route(req, token, goldens) {
  const path = String(req.path ?? '/').split('?')[0];
  const key = `${String(req.method ?? 'GET').toUpperCase()} ${path}`;
  const header = req.authorization ?? '';

  if (OPEN.has(key)) return answer(goldens.responses.get(key));

  const known = SERVED.includes(key) || key === STREAM || PARKED.test(key);
  if (!known) return answer(goldens.errors.notFound);

  if (!header) return answer(goldens.errors.missing);
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!sameSecret(presented, token)) return answer(goldens.errors.unauthorized);

  if (key === STREAM) {
    return { status: 200, headers: goldens.sse.headers, stream: true };
  }
  if (PARKED.test(key)) return answer(goldens.errors.parked);
  return answer(goldens.responses.get(key));
}

/**
 * mkdir -p dir; write dir/daemon.token (0600); listen on 127.0.0.1:port;
 * write pidFile if given; print one ready line through `write`.
 * @param {{ dir: string, port: number, pidFile?: string | null,
 *   write?: (line: string) => unknown, root?: string }} options
 */
export async function start({
  dir,
  port,
  pidFile = null,
  write = (s) => process.stdout.write(s),
  root = CONTRACT,
}) {
  const goldens = loadGoldens(root);
  const token = mintToken();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'daemon.token'), token + '\n', { mode: 0o600 });

  const streams = new Set();
  const server = createServer((req, res) => {
    const out = route(
      {
        method: req.method,
        path: req.url,
        authorization: req.headers.authorization,
      },
      token,
      goldens,
    );
    if (out.stream) {
      res.writeHead(200, out.headers);
      res.write(goldens.sse.greeting);
      const timer = setInterval(
        () => res.write(goldens.sse.keepalive),
        goldens.wire.sse.keepaliveMs,
      );
      streams.add(res);
      const end = () => {
        clearInterval(timer);
        streams.delete(res);
      };
      req.on('close', end);
      res.on('close', end);
      return;
    }
    res.writeHead(out.status, out.headers);
    res.end(JSON.stringify(out.body));
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
