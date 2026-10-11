/**
 * v2 F2c: `GET /v1/threads/:guid/years?tz=`, one conversation's turns
 * counted by year in the operator's zone, for the transcript's scrubber.
 *
 * A read and only a read, like the page it sits beside: behind the operator
 * bearer, no audit row, no broadcast. chat.db is reached through a closure
 * (the reader's `yearCounts`), never a reader, so the port-importer
 * allowlist does not grow. An unknown chat is a 404; a reader that throws
 * is a 503 that names nothing; a zone that is not IANA is a 400.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { UnknownChatError } from '@wemessage/core';
import { ROUTE_TABLE } from './transport-surface.snapshot.js';
import {
  auditEvents,
  boot,
  cleanupHarness,
  get,
  post,
  type Harness,
} from './helpers/draft-harness.js';

afterEach(async () => {
  await cleanupHarness();
});

interface YearsBody {
  chatGuid: string;
  tz: string;
  years: {
    year: number;
    count: number;
    first: string | null;
    last: string | null;
  }[];
  asOf: string;
}

const LA = encodeURIComponent('America/Los_Angeles');
const yearsPath = (guid: string, tz: string = LA): string =>
  `/v1/threads/${encodeURIComponent(guid)}/years?tz=${tz}`;

function chatWithTurns(h: Harness): string {
  const handle = h.fixture.addHandle('+15550104001');
  const chatId = h.fixture.addChat({
    identifier: '+15550104001',
    handleIds: [handle],
  });
  h.fixture.addMessage({
    chatId,
    handleId: handle,
    text: 'summer',
    at: '2022-07-04T18:00:00.000Z',
  });
  // 2024-12-31T23:30-08:00: 2024 in LA, 2025 in UTC.
  h.fixture.addMessage({
    chatId,
    handleId: handle,
    text: 'nye',
    at: '2025-01-01T07:30:00.000Z',
  });
  const row = h.fixture.db
    .prepare('SELECT guid FROM chat WHERE ROWID = ?')
    .get(chatId) as { guid: string };
  return row.guid;
}

describe('GET /v1/threads/:guid/years (v2 F2c)', () => {
  it('counts turns by year in the asked zone, newest first, empty years kept, dated by the daemon clock', async () => {
    const h = await boot({ threads: true });
    const guid = chatWithTurns(h);

    const res = await get(h, yearsPath(guid));
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as YearsBody;
    expect(Object.keys(body).sort()).toEqual([
      'asOf',
      'chatGuid',
      'tz',
      'years',
    ]);
    expect(body.chatGuid).toBe(guid);
    expect(body.tz).toBe('America/Los_Angeles');
    expect(body.asOf).toBe(h.clockCtl.clock.now());
    expect(body.years).toEqual([
      {
        year: 2024,
        count: 1,
        first: '2025-01-01T07:30:00.000Z',
        last: '2025-01-01T07:30:00.000Z',
      },
      { year: 2023, count: 0, first: null, last: null },
      {
        year: 2022,
        count: 1,
        first: '2022-07-04T18:00:00.000Z',
        last: '2022-07-04T18:00:00.000Z',
      },
    ]);

    const utc = (await get(h, yearsPath(guid, 'UTC'))).json() as YearsBody;
    expect(utc.years.map((y) => [y.year, y.count])).toEqual([
      [2025, 1],
      [2024, 0],
      [2023, 0],
      [2022, 1],
    ]);
  });

  it('forwards the guid and the zone to the reader, once', async () => {
    const asked: [string, string][] = [];
    const h = await boot({
      threads: true,
      yearCounts: (chatGuid, tz) => {
        asked.push([chatGuid, tz]);
        return [];
      },
    });
    const res = await get(
      h,
      yearsPath('iMessage;-;+15550104002', 'Asia%2FKolkata'),
    );
    expect(res.statusCode).toBe(200);
    expect((res.json() as YearsBody).years).toEqual([]);
    expect(asked).toEqual([['iMessage;-;+15550104002', 'Asia/Kolkata']]);
  });

  it('404 unknown-chat for a chat chat.db never held', async () => {
    const h = await boot({ threads: true });
    const res = await get(h, yearsPath('iMessage;-;+15550104009'));
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'unknown-chat' });

    const h2 = await boot({
      threads: true,
      yearCounts: () => {
        throw new UnknownChatError();
      },
    });
    expect((await get(h2, yearsPath('x'))).statusCode).toBe(404);
  });

  it('503 source-unavailable when the reader throws, naming nothing', async () => {
    const h = await boot({
      threads: true,
      yearCounts: () => {
        throw new Error('SQLITE_CANTOPEN /secret/path/chat.db');
      },
    });
    const res = await get(h, yearsPath('iMessage;-;+15550104001'));
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'source-unavailable' });
    expect(res.body).not.toContain('secret');
  });

  it('400 invalid-query: no zone, a zone that is not IANA, an unknown key; the reader is never asked', async () => {
    const asked: string[] = [];
    const h = await boot({
      threads: true,
      yearCounts: (chatGuid) => {
        asked.push(chatGuid);
        return [];
      },
    });
    const g = encodeURIComponent('iMessage;-;+15550104001');
    for (const url of [
      `/v1/threads/${g}/years`,
      `/v1/threads/${g}/years?tz=Mars%2FOlympus`,
      `/v1/threads/${g}/years?tz=`,
      `/v1/threads/${g}/years?tz=UTC&limit=5`,
    ]) {
      const res = await get(h, url);
      expect(res.statusCode, url).toBe(400);
      const body = res.json() as {
        error: string;
        detail: { issues: unknown[] };
      };
      expect(body.error, url).toBe('invalid-query');
      expect(body.detail.issues.length, url).toBeGreaterThan(0);
    }
    expect(asked).toEqual([]);
  });

  it('is behind the operator bearer: none, a wrong one and an adapter token are all 401, GET and HEAD', async () => {
    const h = await boot({ threads: true });
    const minted = await post(h, '/v1/adapters', {
      id: 'echo',
      kind: 'echo',
      displayName: 'Echo',
    });
    expect(minted.statusCode).toBe(201);
    const adapterToken = (minted.json() as { token: string }).token;
    for (const method of ['GET', 'HEAD'] as const) {
      for (const authorization of [
        undefined,
        `Bearer wm_${'0'.repeat(64)}`,
        `Bearer ${adapterToken}`,
      ]) {
        const res = await h.server.app.inject({
          method,
          url: yearsPath('iMessage;-;+15550104001'),
          headers: authorization === undefined ? {} : { authorization },
        });
        expect(res.statusCode, `${method} ${String(authorization)}`).toBe(401);
      }
    }
  });

  it('no audit row and no broadcast follow a look at the years', async () => {
    const h = await boot({ threads: true });
    const guid = chatWithTurns(h);
    const before = auditEvents(h.store).length;
    const frames = h.broadcasts.length;
    expect((await get(h, yearsPath(guid))).statusCode).toBe(200);
    expect(auditEvents(h.store)).toHaveLength(before);
    expect(h.broadcasts).toHaveLength(frames);
  });

  it('pins GET and its HEAD twin (route ratchet #31)', () => {
    // 82 since v2 F6b (#32) added `GET /v1/attachments/:id` and its twin;
    // 83 since v2 F6d (#33) added `POST /v1/attachments/staged`.
    expect(ROUTE_TABLE).toHaveLength(83);
    expect(ROUTE_TABLE).toContain('GET /v1/threads/:guid/years');
    expect(ROUTE_TABLE).toContain('HEAD /v1/threads/:guid/years');
  });

  it('the route file reads no wall time and holds no reader', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/routes/threads.ts', import.meta.url)),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/Date\.now\(|new Date\(\)|performance\.now/);
    expect(src).toMatch(/clock\.now\(\)/);
    expect(src).not.toMatch(/\bChatDbReader\b|better-sqlite3/);
  });
});
