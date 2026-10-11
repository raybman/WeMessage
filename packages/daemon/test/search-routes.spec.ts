/**
 * v2 F2b: `GET /v1/search`, message search over the daemon's own index.
 *
 * What these rows hold the route to:
 *  - every token the operator typed comes back in `coverage.tokens`, applied,
 *    partial or not-applied with a reason, and every channel says whether it
 *    was searched (everyTokenReportedInCoverage);
 *  - `from:` a name matches handles and saved names only, never Contacts,
 *    and says partial (fromNameIsPartial);
 *  - `in:` that cannot read chat titles is not applied, and says so, rather
 *    than answering as if it had filtered (inNotAppliedWhenSourceDown);
 *  - a hit Messages no longer holds is hidden and counted
 *    (deletedInMessagesHidden);
 *  - a hit is built field by field: no attachment path, no `meta`
 *    (noPathOrMetaOnWire);
 *  - a cursor is bound to its query; the operator bearer only; a read writes
 *    no audit row, broadcasts nothing and reaches no adapter.
 *
 * Every handle here is synthetic (`+1555...`); no row reads the real
 * Messages database.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  INDEX_BATCH,
  type Clock,
  type FsWatcher,
  type SearchHitWire,
  type SearchPageWire,
} from '@wemessage/core';
import { createChatDb } from '@wemessage/fixtures';
import { startDaemon, type DoctorProbes } from '@wemessage/daemon';
import { createUnusedSendBackend } from './helpers/loopback-backend.js';
import {
  auditEvents,
  boot,
  T0,
  type BootOptions,
  type Harness,
} from './helpers/draft-harness.js';
import {
  addAdapter,
  bootAgent,
  cleanupAgentHarness,
  connectAuthed,
} from './helpers/agent-harness.js';
import { ROUTE_TABLE } from './transport-surface.snapshot.js';

afterEach(cleanupAgentHarness);

const ANA = '+15550100001';
const BEN = '+15550100002';
const LA = 'America/Los_Angeles';

interface Seeded {
  h: Harness;
  anaChat: string;
  lakeChat: string;
  guids: Record<
    'ana2019' | 'me2024' | 'ben2025' | 'meOk' | 'dinner' | 'pic',
    string
  >;
}

/** Mirror whatever chat.db holds past the store's cursor, then index it all. */
async function mirrorAndIndex(h: Harness): Promise<void> {
  const from = h.store.getCursor()?.lastRowid ?? 0;
  const rows = await h.reader.readSince(from);
  let last = from;
  for (const m of rows) {
    h.store.insertInboundMessage(m);
    last = Math.max(last, m.sourceRowid);
  }
  h.store.setCursor({ lastRowid: last, lastScanAt: T0 });
  let mark = -1;
  for (;;) {
    const step = h.store.indexPending(INDEX_BATCH);
    if (step.throughRowid === mark) break;
    mark = step.throughRowid;
  }
}

async function seeded(opts: BootOptions = {}): Promise<Seeded> {
  const h = await boot({ search: true, ...opts });
  const f = h.fixture;
  const ana = f.addHandle(ANA);
  const ben = f.addHandle(BEN);
  const anaChatId = f.addChat({ identifier: ANA, handleIds: [ana] });
  const lakeChatId = f.addGroupChat([ana, ben], {
    displayName: 'Família Lake',
  });
  const chatGuid = (id: number): string =>
    (
      f.db.prepare('SELECT guid FROM chat WHERE ROWID = ?').get(id) as {
        guid: string;
      }
    ).guid;

  const ana2019 = f.addMessage({
    chatId: anaChatId,
    handleId: ana,
    text: 'the cabin in 2019',
    at: '2019-07-04T18:00:00.000Z',
  });
  // 2025-01-01T05:00Z is still New Year's Eve 2024 in Los Angeles.
  const me2024 = f.addMessage({
    chatId: anaChatId,
    text: 'cabin photos are up',
    at: '2025-01-01T05:00:00.000Z',
    isFromMe: true,
  });
  const ben2025 = f.addMessage({
    chatId: lakeChatId,
    handleId: ben,
    text: 'see you at the cabin',
    at: '2025-06-02T16:00:00.000Z',
  });
  const meOk = f.addMessage({
    chatId: lakeChatId,
    text: 'ok',
    at: '2025-06-02T16:05:00.000Z',
    isFromMe: true,
  });
  const dinner = f.addMessage({
    chatId: anaChatId,
    handleId: ana,
    text: 'dinner tonight?',
    at: '2026-08-30T01:00:00.000Z',
  });
  const pic = f.addMessage({
    chatId: anaChatId,
    handleId: ana,
    text: 'cabin view',
    at: '2026-08-31T01:00:00.000Z',
    cacheHasAttachments: true,
  });
  f.addAttachment(pic.rowid, {
    filename: '~/Library/Messages/Attachments/ab/01/IMG_0001.jpeg',
    mimeType: 'image/jpeg',
    transferName: 'IMG_0001.jpeg',
  });
  await mirrorAndIndex(h);
  return {
    h,
    anaChat: chatGuid(anaChatId),
    lakeChat: chatGuid(lakeChatId),
    guids: {
      ana2019: ana2019.guid,
      me2024: me2024.guid,
      ben2025: ben2025.guid,
      meOk: meOk.guid,
      dinner: dinner.guid,
      pic: pic.guid,
    },
  };
}

function search(
  h: Harness,
  qs: string,
  method: 'GET' | 'HEAD' = 'GET',
  // null, not undefined: an explicit undefined would take the default.
  authorization: string | null = h.headers.authorization,
) {
  return h.server.app.inject({
    method,
    url: `/v1/search?${qs}`,
    headers: authorization === null ? {} : { authorization },
  });
}

async function page(h: Harness, qs: string): Promise<SearchPageWire> {
  const res = await search(h, qs);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as SearchPageWire;
}

const q = (pairs: [string, string][]): string =>
  new URLSearchParams([...pairs, ['tz', LA]]).toString();

describe('GET /v1/search answers from the index (v2 F2b)', () => {
  it('finds a term, newest first, dated by the daemon clock, with facets', async () => {
    const { h, guids, anaChat, lakeChat } = await seeded();
    const p = await page(h, q([['term', 'cabin']]));
    expect(p.hits.map((x) => x.guid)).toEqual([
      guids.pic,
      guids.ben2025,
      guids.me2024,
      guids.ana2019,
    ]);
    expect(p.total).toBe(4);
    expect(p.nextCursor).toBeNull();
    expect(p.asOf).toBe(T0);
    const ben = p.hits[1] as SearchHitWire;
    expect(ben).toEqual({
      guid: guids.ben2025,
      chatGuid: lakeChat,
      title: 'Família Lake',
      isGroup: true,
      channel: 'imessage',
      from: 'them',
      handle: BEN,
      text: 'see you at the cabin',
      sentAt: '2025-06-02T16:00:00.000Z',
      hasAttachment: false,
    });
    const mine = p.hits[2] as SearchHitWire;
    expect(mine.from).toBe('me');
    expect(mine.handle).toBeNull();
    expect(mine.chatGuid).toBe(anaChat);
    expect(mine.isGroup).toBe(false);
    // The year is the operator's: 05:00Z on Jan 1 is still 2024 in LA.
    expect(p.facets.years).toEqual([
      { year: 2026, count: 1 },
      { year: 2025, count: 1 },
      { year: 2024, count: 1 },
      { year: 2019, count: 1 },
    ]);
    expect(p.facets.channels).toEqual([{ channel: 'imessage', count: 4 }]);
    expect(p.facets.senders).toEqual([
      { handle: ANA, count: 2 },
      { handle: BEN, count: 1 },
      { handle: 'me', count: 1 },
    ]);
  });

  it('the same instant faceted in UTC lands in 2025', async () => {
    const { h } = await seeded();
    const res = await search(
      h,
      new URLSearchParams([
        ['term', 'cabin'],
        ['tz', 'UTC'],
      ]).toString(),
    );
    const p = res.json() as SearchPageWire;
    expect(p.facets.years).toEqual([
      { year: 2026, count: 1 },
      { year: 2025, count: 2 },
      { year: 2019, count: 1 },
    ]);
  });

  it('everyTokenReportedInCoverage: every token comes back with its fate, every channel with its state', async () => {
    const { h } = await seeded();
    const p = await page(
      h,
      q([
        ['term', 'cabin'],
        ['term', 'up'],
        ['from', 'me'],
        ['in', 'familia'],
        ['channel', 'imessage'],
        ['channel', 'whatsapp'],
        ['has', 'link'],
        ['before', '2026-09-01T00:00:00.000Z'],
        ['after', '2019-01-01T00:00:00-08:00'],
      ]),
    );
    expect(p.coverage.tokens).toEqual([
      { op: 'term', value: 'cabin', applied: 'applied' },
      { op: 'term', value: 'up', applied: 'applied' },
      { op: 'from', value: 'me', applied: 'applied' },
      { op: 'in', value: 'familia', applied: 'applied' },
      { op: 'channel', value: 'imessage', applied: 'applied' },
      {
        op: 'channel',
        value: 'whatsapp',
        applied: 'not-applied',
        reason: 'no-source',
      },
      { op: 'has', value: 'link', applied: 'applied' },
      { op: 'before', value: '2026-09-01T00:00:00.000Z', applied: 'applied' },
      // An offset instant is written the one way sent_at is: UTC, ms.
      { op: 'after', value: '2019-01-01T08:00:00.000Z', applied: 'applied' },
    ]);
    const typed = 9;
    expect(p.coverage.tokens).toHaveLength(typed);
    expect(p.coverage.channels).toEqual([
      {
        channel: 'imessage',
        state: 'searched',
        indexed: 6,
        eligible: 6,
        indexedThroughRowid: h.store.getCursor()?.lastRowid,
        mirrorAsOf: T0,
      },
      { channel: 'whatsapp', state: 'not-searched', reason: 'no-source' },
      { channel: 'linkedin', state: 'not-searched', reason: 'no-source' },
      { channel: 'email', state: 'not-searched', reason: 'no-source' },
    ]);
    expect(p.coverage.capped).toBe(false);
    expect(p.coverage.deletionsChecked).toBe(true);
  });

  it('a short term alone is partial, and says why', async () => {
    const { h, guids } = await seeded();
    const p = await page(h, q([['term', 'ok']]));
    expect(p.hits.map((x) => x.guid)).toEqual([guids.meOk]);
    expect(p.coverage.tokens).toEqual([
      { op: 'term', value: 'ok', applied: 'partial', reason: 'short-term' },
    ]);
  });

  it('a channel filter that leaves iMessage out searches nothing, and says so', async () => {
    const { h } = await seeded();
    const p = await page(
      h,
      q([
        ['term', 'cabin'],
        ['channel', 'whatsapp'],
      ]),
    );
    expect(p.hits).toEqual([]);
    expect(p.total).toBe(0);
    expect(p.coverage.channels[0]).toEqual({
      channel: 'imessage',
      state: 'not-searched',
      reason: 'not-requested',
    });
    expect(p.coverage.tokens).toEqual([
      { op: 'term', value: 'cabin', applied: 'applied' },
      {
        op: 'channel',
        value: 'whatsapp',
        applied: 'not-applied',
        reason: 'no-source',
      },
    ]);
  });

  it('fromNameIsPartial: a saved name or a handle, never Contacts, and always partial', async () => {
    const { h, guids } = await seeded();
    h.store.setContactPolicy({
      handle: BEN,
      displayName: 'Ben Rivera',
      mode: 'draft-only',
      updatedAt: T0,
    });
    const byName = await page(
      h,
      q([
        ['term', 'cabin'],
        ['from', 'rivera'],
      ]),
    );
    expect(byName.hits.map((x) => x.guid)).toEqual([guids.ben2025]);
    expect(byName.coverage.tokens).toContainEqual({
      op: 'from',
      value: 'rivera',
      applied: 'partial',
      reason: 'handles-and-saved-names',
    });
    const byHandle = await page(
      h,
      q([
        ['term', 'cabin'],
        ['from', '0100001'],
      ]),
    );
    expect(byHandle.hits.map((x) => x.guid)).toEqual([
      guids.pic,
      guids.ana2019,
    ]);
    expect(byHandle.coverage.tokens[1]?.applied).toBe('partial');
    const me = await page(
      h,
      q([
        ['term', 'cabin'],
        ['from', 'me'],
      ]),
    );
    expect(me.hits.map((x) => x.guid)).toEqual([guids.me2024]);
  });

  it('in: folds case and accents against chat titles', async () => {
    const { h, guids } = await seeded();
    for (const needle of ['lake', 'FAMILIA', 'Família']) {
      const p = await page(
        h,
        q([
          ['term', 'cabin'],
          ['in', needle],
        ]),
      );
      expect(
        p.hits.map((x) => x.guid),
        needle,
      ).toEqual([guids.ben2025]);
    }
  });

  it('inNotAppliedWhenSourceDown: the filter does not run and the token says not-applied', async () => {
    const { h, guids } = await seeded({
      search: {
        chatsTitled: () => {
          throw new Error('chat.db closed');
        },
      },
    });
    const p = await page(
      h,
      q([
        ['term', 'cabin'],
        ['in', 'lake'],
      ]),
    );
    expect(p.coverage.tokens).toContainEqual({
      op: 'in',
      value: 'lake',
      applied: 'not-applied',
      reason: 'source-unavailable',
    });
    // Unfiltered, and the coverage is the only honest way to say it.
    expect(p.hits.map((x) => x.guid)).toContain(guids.ana2019);
    expect(p.total).toBe(4);
  });

  it('a disconnected gateway degrades every chat.db read and still answers', async () => {
    const boom = (): never => {
      throw new Error('chat.db reader used while disconnected');
    };
    const { h } = await seeded({
      search: { chatTitles: boom, chatsTitled: boom, existingGuids: boom },
    });
    const p = await page(
      h,
      q([
        ['term', 'cabin'],
        ['in', 'lake'],
      ]),
    );
    expect(p.hits).toHaveLength(4);
    expect(p.hits.every((x) => x.title === null)).toBe(true);
    expect(p.coverage.deletionsChecked).toBe(false);
    expect(p.coverage.deletedHidden).toBe(0);
    expect(p.coverage.tokens[1]?.applied).toBe('not-applied');
  });

  it('deletedInMessagesHidden: a hit Messages no longer holds is hidden and counted', async () => {
    const { h, guids } = await seeded();
    // Deleted in Messages: the row and its chat join are gone from chat.db,
    // while the daemon's mirror still holds it.
    const db = h.fixture.db;
    const rowid = (
      db
        .prepare('SELECT ROWID AS r FROM message WHERE guid = ?')
        .get(guids.ben2025) as { r: number }
    ).r;
    db.prepare('DELETE FROM chat_message_join WHERE message_id = ?').run(rowid);
    db.prepare('DELETE FROM message WHERE ROWID = ?').run(rowid);
    const p = await page(h, q([['term', 'cabin']]));
    expect(p.hits.map((x) => x.guid)).not.toContain(guids.ben2025);
    expect(p.hits).toHaveLength(3);
    expect(p.coverage.deletedHidden).toBe(1);
    expect(p.coverage.deletionsChecked).toBe(true);
  });

  it('noPathOrMetaOnWire: a hit carries its own fields and nothing from meta', async () => {
    const { h, guids } = await seeded();
    const res = await search(
      h,
      q([
        ['term', 'cabin'],
        ['has', 'attachment'],
      ]),
    );
    expect(res.statusCode).toBe(200);
    const p = res.json() as SearchPageWire;
    expect(p.hits.map((x) => x.guid)).toEqual([guids.pic]);
    expect(p.hits[0]?.hasAttachment).toBe(true);
    expect(Object.keys(p.hits[0] ?? {}).sort()).toEqual([
      'channel',
      'chatGuid',
      'from',
      'guid',
      'handle',
      'hasAttachment',
      'isGroup',
      'sentAt',
      'text',
      'title',
    ]);
    expect(res.body).not.toMatch(/Library|Attachments|IMG_0001|meta|filename/);
  });

  it('a hit text is control-stripped and bounded', async () => {
    const h = await boot({ search: true });
    const f = h.fixture;
    const ana = f.addHandle(ANA);
    const chatId = f.addChat({ identifier: ANA, handleIds: [ana] });
    f.addMessage({
      chatId,
      handleId: ana,
      text: `cabin\u0007\u0085 ${'x'.repeat(5000)}`,
      at: '2026-08-01T00:00:00.000Z',
    });
    await mirrorAndIndex(h);
    const p = await page(h, q([['term', 'cabin']]));
    const text = p.hits[0]?.text ?? '';
    expect(text.length).toBeLessThanOrEqual(4000);
    // The event boundary's policy: C0 (bar newline and tab), DEL and C1.
    expect(text).not.toMatch(/[\u0007\u0085]/);
    expect(text.startsWith('cabin')).toBe(true);
  });
});

describe('paging and refusals (v2 F2b)', () => {
  it('pages by cursor, newest first, with no repeat and no gap', async () => {
    const { h, guids } = await seeded();
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const pairs: [string, string][] = [
        ['term', 'cabin'],
        ['limit', '1'],
      ];
      if (cursor !== null) pairs.push(['cursor', cursor]);
      const p = await page(h, q(pairs));
      seen.push(...p.hits.map((x) => x.guid));
      expect(p.total).toBe(4);
      cursor = p.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(seen).toEqual([
      guids.pic,
      guids.ben2025,
      guids.me2024,
      guids.ana2019,
    ]);
    expect(pages).toBe(4);
  });

  it('a cursor reused under another query, or another zone, is refused', async () => {
    const { h } = await seeded();
    const first = await page(
      h,
      q([
        ['term', 'cabin'],
        ['limit', '1'],
      ]),
    );
    const cursor = first.nextCursor ?? '';
    expect(cursor).not.toBe('');
    const other = await search(
      h,
      q([
        ['term', 'cabin'],
        ['from', 'me'],
        ['cursor', cursor],
      ]),
    );
    expect(other.statusCode).toBe(400);
    expect(other.json()).toEqual({ error: 'invalid-cursor' });
    const zone = await search(
      h,
      new URLSearchParams([
        ['term', 'cabin'],
        ['tz', 'UTC'],
        ['cursor', cursor],
      ]).toString(),
    );
    expect(zone.statusCode).toBe(400);
    const forged = await search(
      h,
      q([
        ['term', 'cabin'],
        ['cursor', 'not-a-cursor'],
      ]),
    );
    expect(forged.statusCode).toBe(400);
    expect(forged.json()).toEqual({ error: 'invalid-cursor' });
  });

  it('400 empty-search when nothing is asked', async () => {
    const { h } = await seeded();
    const res = await search(h, `tz=${encodeURIComponent(LA)}`);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'empty-search' });
  });

  it('400 invalid-search: no zone, a zone that is not IANA, an unknown key, a bad bound', async () => {
    const { h } = await seeded();
    for (const qs of [
      'term=cabin',
      'term=cabin&tz=Mars%2FOlympus',
      'term=cabin&tz=UTC&sort=oldest',
      'term=cabin&tz=UTC&limit=0',
      'term=cabin&tz=UTC&limit=101',
      'term=cabin&tz=UTC&channel=fax',
      'term=cabin&tz=UTC&before=yesterday',
      `${Array.from({ length: 9 }, (_, i) => `term=t${String(i)}xx`).join('&')}&tz=UTC`,
    ]) {
      const res = await search(h, qs);
      expect(res.statusCode, qs).toBe(400);
      expect((res.json() as { error: string }).error, qs).toBe(
        'invalid-search',
      );
    }
    const tz = await search(h, 'term=cabin&tz=Mars%2FOlympus');
    const issues = (res(tz).detail?.issues ?? []) as { path: string[] }[];
    expect(issues.map((i) => i.path)).toContainEqual(['tz']);
  });
});

function res(r: { json: () => unknown }): {
  error: string;
  detail?: { issues?: unknown[] };
} {
  return r.json() as { error: string; detail?: { issues?: unknown[] } };
}

describe("search is the operator's alone, and only a read (v2 F2b)", () => {
  it('401 with no bearer, a wrong one, or an adapter token, on GET and HEAD', async () => {
    const { h } = await seeded();
    const minted = await h.server.app.inject({
      method: 'POST',
      url: '/v1/adapters',
      headers: h.headers,
      payload: { id: 'echo', kind: 'echo', displayName: 'Echo' },
    });
    expect(minted.statusCode).toBe(201);
    const adapterToken = (minted.json() as { token: string }).token;
    for (const authorization of [
      null,
      `Bearer wm_${'0'.repeat(64)}`,
      `Bearer ${adapterToken}`,
      adapterToken,
    ]) {
      for (const method of ['GET', 'HEAD'] as const) {
        const r = await search(
          h,
          q([['term', 'cabin']]),
          method,
          authorization,
        );
        expect(r.statusCode, `${method} ${String(authorization)}`).toBe(401);
        expect(r.body).not.toContain('cabin');
      }
    }
  });

  it('HEAD twin answers 200 with no body', async () => {
    const { h } = await seeded();
    const r = await search(h, q([['term', 'cabin']]), 'HEAD');
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('');
  });

  it('no audit row and no broadcast follow a search', async () => {
    const { h } = await seeded();
    const audits = auditEvents(h.store).length;
    const frames = h.broadcasts.length;
    await page(h, q([['term', 'cabin']]));
    await search(h, q([['term', 'cabin']]), 'HEAD');
    await search(h, `tz=UTC`);
    expect(auditEvents(h.store).length).toBe(audits);
    expect(h.broadcasts.length).toBe(frames);
  });

  it('/v1/agent hears nothing of a search', async () => {
    const h = await bootAgent({ search: true });
    const sock = await connectAuthed(h, await addAdapter(h, 'echo-1'));
    const before = sock.frames.length;
    const r = await search(h, q([['term', 'cabin']]));
    expect(r.statusCode).toBe(200);
    for (let i = 0; i < 20; i += 1) await new Promise((r2) => setImmediate(r2));
    expect(sock.frames.slice(before)).toEqual([]);
  });
});

describe('the surface (v2 F2b, route ratchet #30)', () => {
  it('pins GET and its HEAD twin', () => {
    // 80 since v2 F2c (#31) added `GET /v1/threads/:guid/years`; 82 since
    // v2 F6b (#32) added `GET /v1/attachments/:id`.
    expect(ROUTE_TABLE).toHaveLength(82);
    expect(ROUTE_TABLE).toContain('GET /v1/search');
    expect(ROUTE_TABLE).toContain('HEAD /v1/search');
  });

  it('dated by the daemon clock: the route file never reads wall time', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/routes/search.ts', import.meta.url)),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/Date\.now\(|new Date\(\)|performance\.now/);
    expect(src).toMatch(/clock\.now\(\)/);
  });

  it('names no port as a value and never reads meta', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/routes/search.ts', import.meta.url)),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/SendBackend|ChatDbReader/);
    expect(src).not.toMatch(/\.meta\b/);
  });
});

describe('the composed daemon indexes what it mirrors (v2 F2b)', () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) await fn();
  });

  it('rows in chat.db at boot are findable at once; a later row after its scan', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wm-search-daemon-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const chatDbPath = join(dir, 'chat.db');
    const f = createChatDb(chatDbPath);
    cleanups.push(() => f.close());
    const ana = f.addHandle(ANA);
    const chatId = f.addChat({ identifier: ANA, handleIds: [ana] });
    const old = f.addMessage({
      chatId,
      handleId: ana,
      text: 'the cabin in 2019',
      at: '2019-07-04T18:00:00.000Z',
    });
    const clock: Clock = { now: () => T0, nowMs: () => Date.parse(T0) };
    let kick: () => void = () => undefined;
    const watcher: FsWatcher = {
      watch: (_paths, onChange) => {
        kick = onChange;
        return () => undefined;
      },
    };
    const doctorProbes: DoctorProbes = {
      osMajor: () => 15,
      fda: async () => 'ok',
      automation: async () => 'ok',
      messagesRunning: async () => true,
    };
    const daemon = await startDaemon({
      autonomy: 'live',
      configDir: join(dir, 'config'),
      chatDbPath,
      clock,
      watcher,
      doctorProbes,
      backend: createUnusedSendBackend(),
      backendName: 'unused',
    });
    cleanups.push(() => daemon.stop());
    const find = async (): Promise<string[]> => {
      const r = await daemon.server.app.inject({
        method: 'GET',
        url: `/v1/search?${q([['term', 'cabin']])}`,
        headers: { authorization: `Bearer ${daemon.server.token ?? ''}` },
      });
      expect(r.statusCode, r.body).toBe(200);
      return (r.json() as SearchPageWire).hits.map((x) => x.guid);
    };
    expect(await find()).toEqual([old.guid]);

    const fresh = f.addMessage({
      chatId,
      handleId: ana,
      text: 'back at the cabin',
      at: '2026-08-31T01:00:00.000Z',
    });
    kick();
    for (let i = 0; i < 200; i += 1) {
      if ((await find()).length === 2) break;
      await new Promise((r) => setImmediate(r));
    }
    expect(await find()).toEqual([fresh.guid, old.guid]);
    // tick() runs an index step too, and with nothing pending it is a no-op.
    await daemon.tick();
    expect(await find()).toEqual([fresh.guid, old.guid]);
  });

  it('one index step runs batch after batch until the mark stands still', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wm-search-daemon-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const chatDbPath = join(dir, 'chat.db');
    const f = createChatDb(chatDbPath);
    cleanups.push(() => f.close());
    const ana = f.addHandle(ANA);
    const chatId = f.addChat({ identifier: ANA, handleIds: [ana] });
    // More rows than one batch, the needle in the last: a step that stopped
    // after one batch would leave it unfound until a later tick.
    for (let i = 0; i < INDEX_BATCH + 50; i += 1) {
      f.addMessage({
        chatId,
        handleId: ana,
        text: `filler ${String(i)}`,
        at: new Date(
          Date.parse('2020-01-01T00:00:00.000Z') + i * 60_000,
        ).toISOString(),
      });
    }
    const needle = f.addMessage({
      chatId,
      handleId: ana,
      text: 'the cabin, at last',
      at: '2026-08-31T01:00:00.000Z',
    });
    const clock: Clock = { now: () => T0, nowMs: () => Date.parse(T0) };
    const daemon = await startDaemon({
      autonomy: 'live',
      configDir: join(dir, 'config'),
      chatDbPath,
      clock,
      watcher: { watch: () => () => undefined },
      doctorProbes: {
        osMajor: () => 15,
        fda: async () => 'ok',
        automation: async () => 'ok',
        messagesRunning: async () => true,
      },
      backend: createUnusedSendBackend(),
      backendName: 'unused',
    });
    cleanups.push(() => daemon.stop());
    const r = await daemon.server.app.inject({
      method: 'GET',
      url: `/v1/search?${q([['term', 'cabin']])}`,
      headers: { authorization: `Bearer ${daemon.server.token ?? ''}` },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as SearchPageWire).hits.map((x) => x.guid)).toEqual([
      needle.guid,
    ]);
  });
});
