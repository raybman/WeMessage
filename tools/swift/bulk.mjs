// tools/swift/bulk.mjs: the `bulk` scenario's data, generated rather than
// checked in (docs/plans/v2-swift-S5-B.md, S7a). 4,000 threads and one
// 2,000-turn transcript would be megabytes of fixture nobody reads; a seed
// and a pure function are a few hundred lines everybody can.
//
// Deterministic: the same seed gives the same bytes, every run, every
// machine. Synthetic only: every number is +1555, every address
// example.com, every word from the lists below.
//
// Paging is the real daemon's (packages/daemon/src/routes/threads.ts):
// GET /v1/threads takes limit 1..200 (default 100) and an opaque cursor;
// GET /v1/threads/:guid/messages takes limit 1..200 (default 50) and an
// opaque `before`, and pages walk back in time. A cursor this module did
// not mint is the daemon's 400 {"error":"invalid-cursor"}.

/**
 * @typedef {{ seed: number, threads: number, longTurns: number,
 *   shortTurnsMax: number, asOf: string }} BulkSpec
 */

/** The shape the S7a rows hold the app to. @type {Readonly<BulkSpec>} */
export const BULK = Object.freeze({
  seed: 0x5eed7a,
  threads: 4000,
  /** The newest thread, first in the list, carries this many turns. */
  longTurns: 2000,
  /** Every other thread carries between 1 and this many. */
  shortTurnsMax: 6,
  asOf: '2026-09-01T12:00:43.000Z',
});

/**
 * v2 F1: the `long` scenario, small enough to scroll to its end. 250
 * threads are three pages of the list (100, 100, 50); the newest carries
 * 450 turns, three pages of the transcript (200, 200, 50).
 * @type {Readonly<BulkSpec>}
 */
export const LONG = Object.freeze({ ...BULK, threads: 250, longTurns: 450 });

/** The real daemon's paging bounds, quoted, not imported (tools/ never imports packages/). */
export const THREADS_PAGE = Object.freeze({ min: 1, max: 200, fallback: 100 });
export const MESSAGES_PAGE = Object.freeze({ min: 1, max: 200, fallback: 50 });

const FIRST = [
  'Ada',
  'Ben',
  'Cleo',
  'Dev',
  'Esme',
  'Femi',
  'Gus',
  'Hana',
  'Ivo',
  'Jade',
  'Kofi',
  'Lior',
  'Mina',
  'Nico',
  'Oona',
  'Pax',
  'Quinn',
  'Rhea',
  'Soren',
  'Tavi',
  'Uma',
  'Vik',
  'Wren',
  'Xavi',
  'Yara',
  'Zed',
];
const LAST = [
  'Abara',
  'Bianchi',
  'Castell',
  'Duarte',
  'Eklund',
  'Farrow',
  'Gallo',
  'Haddad',
  'Ibsen',
  'Jansen',
  'Kowal',
  'Lindqvist',
  'Moreau',
  'Nakamura',
  'Ortega',
  'Petrov',
  'Quist',
  'Rossi',
  'Sato',
  'Tanaka',
  'Ueda',
  'Varga',
];
const GROUPS = [
  'Book club',
  'Climbing crew',
  'Flat 2C',
  'Garden plot',
  'Pickup soccer',
  'Road trip',
  'Supper club',
  'Trivia night',
];
const LINES = [
  'see you at seven',
  'running a bit late',
  'did you get the tickets?',
  'sounds good to me',
  'can we push to tomorrow?',
  'on my way',
  'thanks again for yesterday',
  'what time works for you?',
  'just landed',
  'call when you are free',
  'sent the photos',
  'happy birthday!',
  'the usual place?',
  'bring the charger please',
  'that was great',
  'almost there',
];

/** mulberry32: small, fast, and the same everywhere. -> () => [0, 1) */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rand, list) => list[Math.floor(rand() * list.length)];

/** +1555 and seven digits from the index: 4,000 distinct numbers, all fiction. */
function phone(i) {
  return '+15552' + String(i).padStart(6, '0');
}

/**
 * One thread's turns, oldest first, ending on its list line. Pure over
 * (seed, index, count, lastAt, handle).
 */
function turnsFor(seed, index, count, lastAt, handle, lastLine, lastFromMe) {
  const rand = prng(seed ^ Math.imul(index + 1, 0x9e3779b1));
  const end = Date.parse(lastAt);
  const turns = [];
  for (let k = 0; k < count; k += 1) {
    const newest = k === count - 1;
    const fromMe = newest ? lastFromMe : rand() < 0.45;
    const at = new Date(end - (count - 1 - k) * 90_000).toISOString();
    const turn = {
      guid: `bulk-${index}-${String(k).padStart(4, '0')}`,
      from: fromMe ? 'me' : 'them',
      kind: 'text',
      text: newest ? lastLine : pick(rand, LINES),
      at,
    };
    if (!fromMe) turn.handle = handle;
    turn.attachments = 0;
    turns.push(turn);
  }
  return turns;
}

/**
 * -> { asOf, threads, turns(guid) }. `threads` is newest first, as the
 * daemon lists them; `turns(guid)` is the whole transcript, oldest first,
 * or null for a guid the scenario never listed.
 */
/** @param {Readonly<BulkSpec>} [spec] */
export function generateBulk(spec = BULK) {
  const rand = prng(spec.seed);
  const asOf = Date.parse(spec.asOf);
  const threads = [];
  const meta = new Map();
  let at = asOf - 60_000;
  for (let i = 0; i < spec.threads; i += 1) {
    at -= Math.floor(1 + rand() * 40) * 60_000;
    const lastAt = new Date(at).toISOString();
    const lastLine = pick(rand, LINES);
    const lastFromMe = rand() < 0.4;
    const roll = rand();
    let chatGuid;
    let title;
    let isGroup = false;
    let handle;
    if (i > 0 && roll < 0.08) {
      isGroup = true;
      chatGuid = `iMessage;+;chat5552${String(i).padStart(6, '0')}`;
      title = `${pick(rand, GROUPS)} ${1 + (i % 9)}`;
      handle = phone(i);
    } else if (i > 0 && roll < 0.12) {
      handle = `contact${i}@example.com`;
      chatGuid = `iMessage;-;${handle}`;
      title = `${pick(rand, FIRST)} ${pick(rand, LAST)}`;
    } else {
      handle = phone(i);
      chatGuid = `iMessage;-;${handle}`;
      title = `${pick(rand, FIRST)} ${pick(rand, LAST)}`;
    }
    threads.push({
      chatGuid,
      channel: 'imessage',
      title,
      isGroup,
      lastLine,
      lastFromMe,
      lastAt,
    });
    const count =
      i === 0 ? spec.longTurns : 1 + Math.floor(rand() * spec.shortTurnsMax);
    meta.set(chatGuid, {
      index: i,
      count,
      lastAt,
      handle,
      lastLine,
      lastFromMe,
    });
  }
  const cache = new Map();
  const turns = (guid) => {
    const m = meta.get(guid);
    if (!m) return null;
    if (!cache.has(guid)) {
      cache.set(
        guid,
        turnsFor(
          spec.seed,
          m.index,
          m.count,
          m.lastAt,
          m.handle,
          m.lastLine,
          m.lastFromMe,
        ),
      );
    }
    return cache.get(guid);
  };
  return { asOf: spec.asOf, threads, turns };
}

/** The daemon's coercion: an integer in [min, max], the fallback when absent, else null. */
function pageSize(raw, bounds) {
  if (raw === null || raw === '') return bounds.fallback;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= bounds.min && n <= bounds.max ? n : null;
}

const INVALID_CURSOR = { status: 400, body: { error: 'invalid-cursor' } };
const INVALID_QUERY = {
  status: 400,
  body: { error: 'invalid-query', detail: { issues: [] } },
};

/** "o<offset>", minted here only; anything else is invalid. */
function readCursor(raw, max) {
  const m = /^o(\d+)$/.exec(raw ?? '');
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 && n <= max ? n : null;
}

/** GET /v1/threads over the generated list. -> { status, body } */
export function pageThreads(data, query) {
  const params = new URLSearchParams(query);
  const limit = pageSize(params.get('limit'), THREADS_PAGE);
  if (limit === null) return INVALID_QUERY;
  let offset = 0;
  if (params.has('cursor')) {
    offset = readCursor(params.get('cursor'), data.threads.length - 1);
    if (offset === null) return INVALID_CURSOR;
  }
  const end = Math.min(offset + limit, data.threads.length);
  return {
    status: 200,
    body: {
      threads: data.threads.slice(offset, end),
      nextCursor: end < data.threads.length ? `o${end}` : null,
      total: data.threads.length,
      asOf: data.asOf,
    },
  };
}

/** GET /v1/threads/:guid/messages over one generated transcript, or null when unlisted. */
export function pageMessages(data, guid, query) {
  const all = data.turns(guid);
  if (!all) return null;
  const params = new URLSearchParams(query);
  const limit = pageSize(params.get('limit'), MESSAGES_PAGE);
  if (limit === null) return INVALID_QUERY;
  // `before` counts back from the newest turn: "o<n>" is n turns already shown.
  let shown = 0;
  if (params.has('before')) {
    shown = readCursor(params.get('before'), all.length - 1);
    if (shown === null) return INVALID_CURSOR;
  }
  const end = all.length - shown;
  const start = Math.max(0, end - limit);
  return {
    status: 200,
    body: {
      chatGuid: guid,
      channel: 'imessage',
      turns: all.slice(start, end),
      nextBefore: start > 0 ? `o${all.length - start}` : null,
      asOf: data.asOf,
    },
  };
}
