/**
 * v2 F5: `GET /v1/threads/by-handle/:handle`, the conversation a new draft
 * to that handle would land in.
 *
 * The send path already makes this lookup (`resolveChat`), but only at
 * dispatch, where a miss is a draft that fails as `no-conversation`. This
 * route asks the same question first, so compose can refuse before there
 * is a draft. It answers the guid the daemon would use, never one the GUI
 * made up: on macOS 26 a 1:1 chat is `any;-;<handle>`, and a synthesised
 * `iMessage;-;<handle>` names a chat that does not exist.
 *
 * A read and only a read: no audit row, no broadcast, behind the operator
 * bearer. A handle carrying `;` is a guid in disguise and is a 400; a reader
 * that throws is a 503 that names nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
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

interface ByHandleBody {
  handle: string;
  conversation: {
    chatGuid: string;
    service: string;
    isGroup: boolean;
  } | null;
  asOf: string;
}

const pathOf = (handle: string): string =>
  `/v1/threads/by-handle/${encodeURIComponent(handle)}`;

function guidOf(h: Harness, chatId: number): string {
  const row = h.fixture.db
    .prepare('SELECT guid FROM chat WHERE ROWID = ?')
    .get(chatId) as { guid: string };
  return row.guid;
}

function inject(
  h: Harness,
  url: string,
  authorization?: string,
  method: 'GET' | 'HEAD' = 'GET',
) {
  return h.server.app.inject({
    method,
    url,
    headers: authorization === undefined ? {} : { authorization },
  });
}

describe('GET /v1/threads/by-handle/:handle (v2 F5)', () => {
  it('answers the guid chat.db holds, `any;-;` included, never a synthesised one', async () => {
    const h = await boot({ threads: true });
    const handleId = h.fixture.addHandle('+15550100001');
    const chatId = h.fixture.addChat({
      identifier: '+15550100001',
      handleIds: [handleId],
      guidPrefix: 'any',
    });

    const res = await get(h, pathOf('+15550100001'));

    expect(res.statusCode).toBe(200);
    const body = res.json() as ByHandleBody;
    expect(body.conversation).toEqual({
      chatGuid: 'any;-;+15550100001',
      service: 'imessage',
      isGroup: false,
    });
    expect(body.conversation?.chatGuid).toBe(guidOf(h, chatId));
    expect(body.handle).toBe('+15550100001');
    expect(body.asOf).toBe(h.clockCtl.clock.now());
    expect(Object.keys(body).sort()).toEqual([
      'asOf',
      'conversation',
      'handle',
    ]);
  });

  it('an SMS-only 1:1 is found, and says sms', async () => {
    const h = await boot({ threads: true });
    const handleId = h.fixture.addHandle('+15550100003', { service: 'SMS' });
    h.fixture.addChat({
      identifier: '+15550100003',
      service: 'SMS',
      handleIds: [handleId],
    });

    const body = (await get(h, pathOf('+15550100003'))).json() as ByHandleBody;

    expect(body.conversation).toEqual({
      chatGuid: 'SMS;-;+15550100003',
      service: 'sms',
      isGroup: false,
    });
  });

  it('no chat on this Mac is a 200 with a null conversation, not an error', async () => {
    const h = await boot({ threads: true });

    const res = await get(h, pathOf('+15550100099'));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      handle: '+15550100099',
      conversation: null,
      asOf: h.clockCtl.clock.now(),
    });
  });

  it('a handle only in groups answers the group, isGroup:true, for the GUI to refuse', async () => {
    const h = await boot({ threads: true });
    const a = h.fixture.addHandle('+15550100005');
    const b = h.fixture.addHandle('+15550100006');
    const groupId = h.fixture.addGroupChat([a, b]);

    const body = (await get(h, pathOf('+15550100005'))).json() as ByHandleBody;

    expect(body.conversation).toEqual({
      chatGuid: guidOf(h, groupId),
      service: 'imessage',
      isGroup: true,
    });
  });

  it('a formatted phone and a mixed-case email normalise to the stored handle', async () => {
    const h = await boot({ threads: true });
    const phone = h.fixture.addHandle('+15550100007');
    const phoneChat = h.fixture.addChat({
      identifier: '+15550100007',
      handleIds: [phone],
    });
    const mail = h.fixture.addHandle('maya@example.com');
    const mailChat = h.fixture.addChat({
      identifier: 'maya@example.com',
      handleIds: [mail],
    });

    const byPhone = (
      await get(h, pathOf('+1 (555) 010-0007'))
    ).json() as ByHandleBody;
    expect(byPhone.handle).toBe('+15550100007');
    expect(byPhone.conversation?.chatGuid).toBe(guidOf(h, phoneChat));

    const byMail = (
      await get(h, pathOf(' Maya@Example.COM '))
    ).json() as ByHandleBody;
    expect(byMail.handle).toBe('maya@example.com');
    expect(byMail.conversation?.chatGuid).toBe(guidOf(h, mailChat));
  });

  it('forwards the normalised handle to resolveChat, once', async () => {
    const asked: string[] = [];
    const h = await boot({
      threads: true,
      resolveChat: (handle) => {
        asked.push(handle);
        return Promise.resolve(null);
      },
    });

    await get(h, pathOf('+1 555 010 0008'));

    expect(asked).toEqual(['+15550100008']);
  });

  it('a handle with ";" is a 400 invalid-handle, and the reader is never asked', async () => {
    const asked: string[] = [];
    const h = await boot({
      threads: true,
      resolveChat: (handle) => {
        asked.push(handle);
        return Promise.resolve(null);
      },
    });

    for (const bad of ['+15550100001;x', 'iMessage;-;+15550100001', ';']) {
      const res = await get(h, pathOf(bad));
      expect(res.statusCode, bad).toBe(400);
      const body = res.json() as {
        error: string;
        detail: { issues: unknown[] };
      };
      expect(body.error).toBe('invalid-handle');
      expect(body.detail.issues.length).toBeGreaterThan(0);
    }
    expect(asked).toEqual([]);
  });

  it('an empty or blank handle is a 400 invalid-handle, never a lookup of ""', async () => {
    const asked: string[] = [];
    const h = await boot({
      threads: true,
      resolveChat: (handle) => {
        asked.push(handle);
        return Promise.resolve(null);
      },
    });

    for (const bad of ['%20', '%20%20']) {
      const res = await get(h, `/v1/threads/by-handle/${bad}`);
      expect(res.statusCode, bad).toBe(400);
      expect((res.json() as { error: string }).error).toBe('invalid-handle');
    }
    // An overlong handle is refused before it is read. Fastify's router
    // refuses a path parameter past 100 characters with a 414 before the
    // schema's 320 is reached; either way the reader is never asked.
    const long = await get(h, pathOf(`${'a'.repeat(320)}@example.com`));
    expect([400, 414]).toContain(long.statusCode);
    expect(asked).toEqual([]);
  });

  it('a reader that throws or rejects is a 503 that names nothing', async () => {
    const h = await boot({
      threads: true,
      resolveChat: () => {
        throw new Error('SQLITE_CANTOPEN /secret/path/chat.db');
      },
    });
    const res = await get(h, pathOf('+15550100001'));
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'source-unavailable' });
    expect(res.body).not.toContain('secret');

    const h2 = await boot({
      threads: true,
      resolveChat: () => Promise.reject(new Error('locked')),
    });
    const res2 = await get(h2, pathOf('+15550100001'));
    expect(res2.statusCode).toBe(503);
    expect(res2.json()).toEqual({ error: 'source-unavailable' });
  });

  it('is behind the operator bearer: none, a wrong one and an adapter token are all 401', async () => {
    const h = await boot({ threads: true });
    const minted = await post(h, '/v1/adapters', {
      id: 'echo',
      kind: 'echo',
      displayName: 'Echo',
    });
    expect(minted.statusCode).toBe(201);
    const adapterToken = (minted.json() as { token: string }).token;

    for (const authorization of [
      undefined,
      `Bearer wm_${'0'.repeat(64)}`,
      `Bearer ${adapterToken}`,
      adapterToken,
    ]) {
      for (const method of ['GET', 'HEAD'] as const) {
        const res = await inject(
          h,
          pathOf('+15551234567'),
          authorization,
          method,
        );
        expect(res.statusCode, `${method} ${String(authorization)}`).toBe(401);
        expect(res.body).not.toContain(';-;');
      }
    }
    const ok = await inject(h, pathOf('+15551234567'), h.headers.authorization);
    expect(ok.statusCode).toBe(200);
  });

  it('HEAD answers 200 with no body', async () => {
    const h = await boot({ threads: true });
    const res = await inject(
      h,
      pathOf('+15551234567'),
      h.headers.authorization,
      'HEAD',
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });

  it('reads and only reads: no audit row and no broadcast follow a lookup', async () => {
    const h = await boot({ threads: true });
    const auditBefore = auditEvents(h.store).length;
    const broadcastsBefore = h.broadcasts.length;
    await get(h, pathOf('+15551234567'));
    await get(h, pathOf('+15550100099'));
    await get(h, pathOf('bad;handle'));
    await inject(h, pathOf('+15551234567'), h.headers.authorization, 'HEAD');
    expect(auditEvents(h.store).length).toBe(auditBefore);
    expect(h.broadcasts.length).toBe(broadcastsBefore);
  });

  it('is not served unless the daemon was handed the threads surface', async () => {
    const h = await boot();
    const res = await get(h, pathOf('+15551234567'));
    expect(res.statusCode).toBe(404);
  });
});
