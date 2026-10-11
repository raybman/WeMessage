/**
 * v2 F6b: `GET /v1/attachments/:id` (route ratchet #32), the bytes of one
 * chat.db attachment, served from the Attachments folder only.
 *
 * Every chat.db here is a synthetic fixture and every "home" a temp folder;
 * every byte is generated in the test (syntheticPng / syntheticHeader).
 * The swap rows hand the resolver a filesystem that moves the file between
 * the check and the open, which is the TOCTOU window the dev/ino compare
 * and O_NOFOLLOW close.
 */
import * as realFs from 'node:fs';
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createChatDb,
  syntheticHeader,
  syntheticPng,
  type ChatDbFixture,
} from '@wemessage/fixtures';
import {
  parseRange,
  resolveAttachment,
  sniff,
  type ResolveFs,
} from '@wemessage/daemon';
import {
  auditEvents,
  boot,
  type BootOptions,
  type Harness,
} from './helpers/draft-harness.js';
import { ROUTE_TABLE } from './transport-surface.snapshot.js';

const PEER = '+15550100001';
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

interface World {
  h: Harness;
  dir: string;
  home: string;
  root: string;
  fixture: ChatDbFixture;
  chatId: number;
  handleId: number;
  /** Where the fixture wrote an attachment's bytes. */
  pathOf(attachmentGuid: string): string;
}

async function world(
  attachments: Partial<NonNullable<BootOptions['attachments']>> = {},
): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'wm-f6b-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const root = join(home, 'Library', 'Messages', 'Attachments');
  mkdirSync(root, { recursive: true });
  const fixture = createChatDb(join(dir, 'chat.db'), { home });
  const handleId = fixture.addHandle(PEER);
  const chatId = fixture.addChat({ identifier: PEER, handleIds: [handleId] });
  const h = await boot({ dir, fixture, attachments: { home, ...attachments } });
  const pathOf = (attachmentGuid: string): string => {
    const row = fixture.db
      .prepare('SELECT filename FROM attachment WHERE guid = ?')
      .get(attachmentGuid) as { filename: string };
    return join(home, row.filename.slice(2));
  };
  return { h, dir, home, root, fixture, chatId, handleId, pathOf };
}

function add(
  w: World,
  attachmentGuid: string,
  bytes: Uint8Array | null,
  extra: {
    transferName?: string;
    mimeType?: string;
    filename?: string | null;
  } = {},
): void {
  w.fixture.addAttachmentOnly({
    chatId: w.chatId,
    handleId: w.handleId,
    attachmentGuid,
    transferName: extra.transferName ?? 'grey.png',
    ...(bytes === null ? {} : { onDisk: bytes }),
    ...(extra.mimeType !== undefined ? { mimeType: extra.mimeType } : {}),
    ...(extra.filename !== undefined ? { filename: extra.filename } : {}),
  });
}

async function get(
  h: Harness,
  id: string,
  headers: Record<string, string> = {},
  method: 'GET' | 'HEAD' = 'GET',
) {
  return h.server.app.inject({
    method,
    url: `/v1/attachments/${encodeURIComponent(id)}`,
    headers: { ...h.headers, ...headers },
  });
}

function reasonOf(r: { json: () => unknown }): string {
  return (r.json() as { reason: string }).reason;
}

/** A filesystem that runs `between` after the stat and before the open. */
function swappingFs(between: () => void): ResolveFs {
  let fired = false;
  return {
    realpathSync: (p) => realFs.realpathSync(p),
    statSync: (p) => realFs.statSync(p),
    openSync: (p, flags) => {
      if (!fired) {
        fired = true;
        between();
      }
      return realFs.openSync(p, flags);
    },
    fstatSync: (fd) => realFs.fstatSync(fd),
    closeSync: (fd) => realFs.closeSync(fd),
  };
}

describe('v2 F6b: bytes, by id, from the Attachments folder only', () => {
  it('servesSniffedTypeNotStoredMime', async () => {
    const w = await world();
    const png = syntheticPng(4, 4);
    add(w, 'AT-PNG', png, { mimeType: 'text/html', transferName: 'grey.png' });
    const r = await get(w.h, 'AT-PNG');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cache-control']).toBe('private, no-store');
    expect(r.headers['accept-ranges']).toBe('bytes');
    expect(r.headers['content-disposition']).toBe(
      "attachment; filename*=UTF-8''grey.png",
    );
    expect(r.headers['content-length']).toBe(String(png.length));
    expect(r.rawPayload.equals(png)).toBe(true);
  });

  it('an unknown format is octet-stream, never the stored claim', async () => {
    const w = await world();
    add(w, 'AT-HTML', syntheticHeader('html'), {
      mimeType: 'image/png',
      transferName: 'page.html',
    });
    const r = await get(w.h, 'AT-HTML');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect(r.headers['content-disposition']).toMatch(/^attachment;/);
  });

  it('traversalIsOutsideRoot (and a sibling folder is not inside)', async () => {
    const w = await world();
    const evil = join(w.home, 'Library', 'Messages', 'Attachments-evil');
    mkdirSync(evil, { recursive: true });
    writeFileSync(join(evil, 'x.png'), syntheticPng(2, 2));
    writeFileSync(join(w.home, 'secret.png'), syntheticPng(2, 2));
    add(w, 'AT-SIBLING', null, {
      filename: '~/Library/Messages/Attachments-evil/x.png',
    });
    add(w, 'AT-DOTDOT', null, {
      filename: '~/Library/Messages/Attachments/../../../secret.png',
    });
    add(w, 'AT-RELATIVE', null, { filename: 'Library/Messages/x.png' });
    for (const id of ['AT-SIBLING', 'AT-DOTDOT', 'AT-RELATIVE']) {
      const r = await get(w.h, id);
      expect(r.statusCode, id).toBe(404);
      expect(r.json(), id).toEqual({
        error: 'attachment-not-local',
        reason: 'outside-root',
      });
    }
  });

  it('symlinkEscapeIsOutsideRoot', async () => {
    const w = await world();
    const outside = join(w.dir, 'outside.png');
    writeFileSync(outside, syntheticPng(2, 2));
    add(w, 'AT-LINK', null, {
      filename: '~/Library/Messages/Attachments/aa/link.png',
    });
    mkdirSync(join(w.root, 'aa'), { recursive: true });
    symlinkSync(outside, join(w.root, 'aa', 'link.png'));
    const r = await get(w.h, 'AT-LINK');
    expect(r.statusCode).toBe(404);
    expect(reasonOf(r)).toBe('outside-root');
  });

  it('swappedAfterRealpathIsChanged (a new file at the same path)', async () => {
    let target = '';
    const w = await world({
      fs: swappingFs(() => {
        unlinkSync(target);
        writeFileSync(target, syntheticHeader('html'));
      }),
    });
    add(w, 'AT-SWAP', syntheticPng(4, 4));
    target = w.pathOf('AT-SWAP');
    const r = await get(w.h, 'AT-SWAP');
    expect(r.statusCode).toBe(404);
    expect(reasonOf(r)).toBe('changed');
  });

  it('a new file that reuses the inode number is still changed', async () => {
    // ext4 gives a freed inode number to the next file created, so on Linux
    // an unlink-and-recreate can keep dev and ino (run 38107969492). Here
    // the reuse is simulated so the row holds on any filesystem: the opened
    // file reports the checked dev and ino, but its own size and ctime.
    let target = '';
    let checked: ReturnType<typeof realFs.statSync> | undefined;
    const base = swappingFs(() => {
      unlinkSync(target);
      writeFileSync(target, syntheticHeader('html'));
    });
    const fs: ResolveFs = {
      ...base,
      statSync: (p) => (checked = realFs.statSync(p)),
      fstatSync: (fd) =>
        Object.assign(realFs.fstatSync(fd), {
          dev: checked!.dev,
          ino: checked!.ino,
        }),
    };
    const w = await world({ fs });
    add(w, 'AT-REUSE', syntheticPng(4, 4));
    target = w.pathOf('AT-REUSE');
    const r = await get(w.h, 'AT-REUSE');
    expect(r.statusCode).toBe(404);
    expect(reasonOf(r)).toBe('changed');
  });

  it('a symlink planted at the path between check and open is changed', async () => {
    // The original moves out of the root (same inode) and a link takes its
    // place: following it would pass the dev/ino compare and serve a file
    // outside the root. O_NOFOLLOW refuses the link.
    let target = '';
    let moved = '';
    const w = await world({
      fs: swappingFs(() => {
        renameSync(target, moved);
        symlinkSync(moved, target);
      }),
    });
    add(w, 'AT-PLANT', syntheticPng(4, 4));
    target = w.pathOf('AT-PLANT');
    moved = join(w.dir, 'moved-out.png');
    const r = await get(w.h, 'AT-PLANT');
    expect(r.statusCode).toBe(404);
    expect(reasonOf(r)).toBe('changed');
  });

  it('missingFileIsNotOnThisMac', async () => {
    const w = await world();
    add(w, 'AT-GONE', syntheticPng(2, 2));
    unlinkSync(w.pathOf('AT-GONE'));
    const r = await get(w.h, 'AT-GONE');
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({
      error: 'attachment-not-local',
      reason: 'not-on-this-mac',
    });
  });

  it('a directory at the path is not a file on this Mac', async () => {
    const w = await world();
    add(w, 'AT-DIR', syntheticPng(2, 2));
    const p = w.pathOf('AT-DIR');
    unlinkSync(p);
    mkdirSync(p);
    const r = await get(w.h, 'AT-DIR');
    expect(r.statusCode).toBe(404);
    expect(reasonOf(r)).toBe('not-on-this-mac');
  });

  it('nullFilenameIsNoLocalPath', async () => {
    const w = await world();
    add(w, 'AT-NULL', null, { filename: null });
    const r = await get(w.h, 'AT-NULL');
    expect(r.statusCode).toBe(404);
    expect(reasonOf(r)).toBe('no-local-path');
  });

  it('an unknown, unjoined, or malformed id is unknown-attachment', async () => {
    const w = await world();
    w.fixture.db
      .prepare(
        `INSERT INTO attachment (guid, filename, transfer_name)
         VALUES ('AT-ORPHAN', '~/Library/Messages/Attachments/zz/o.png', 'o.png')`,
      )
      .run();
    for (const id of [
      'AT-NOPE',
      'AT-ORPHAN',
      'a b',
      'x'.repeat(99) + '!',
      'a/b',
    ]) {
      const r = await get(w.h, id);
      expect(r.statusCode, id).toBe(404);
      expect(reasonOf(r), id).toBe('unknown-attachment');
    }
    // Past the router's 100-character param cap Fastify answers 414 itself,
    // before the route runs; either way nothing is read.
    const long = await get(w.h, 'x'.repeat(129));
    expect([404, 414]).toContain(long.statusCode);
  });

  it('rangeGives206', async () => {
    const w = await world();
    const png = syntheticPng(16, 16);
    add(w, 'AT-R', png);
    const r = await get(w.h, 'AT-R', { range: 'bytes=0-9' });
    expect(r.statusCode).toBe(206);
    expect(r.headers['content-range']).toBe(`bytes 0-9/${png.length}`);
    expect(r.headers['content-length']).toBe('10');
    expect(r.rawPayload.equals(png.subarray(0, 10))).toBe(true);
    // Open-ended, suffix, and an end past the size clamp.
    const open = await get(w.h, 'AT-R', { range: 'bytes=8-' });
    expect(open.statusCode).toBe(206);
    expect(open.rawPayload.equals(png.subarray(8))).toBe(true);
    const tail = await get(w.h, 'AT-R', { range: 'bytes=-5' });
    expect(tail.rawPayload.equals(png.subarray(png.length - 5))).toBe(true);
    const past = await get(w.h, 'AT-R', { range: 'bytes=4-999999' });
    expect(past.headers['content-range']).toBe(
      `bytes 4-${png.length - 1}/${png.length}`,
    );
  });

  it('badRangeGives416', async () => {
    const w = await world();
    const png = syntheticPng(2, 2);
    add(w, 'AT-416', png);
    for (const range of [`bytes=${png.length}-`, 'bytes=-0']) {
      const r = await get(w.h, 'AT-416', { range });
      expect(r.statusCode, range).toBe(416);
      expect(r.headers['content-range']).toBe(`bytes */${png.length}`);
      expect(r.json()).toEqual({ error: 'range-not-satisfiable' });
    }
  });

  it('multiRangeGivesFull (and a malformed range is ignored)', async () => {
    const w = await world();
    const png = syntheticPng(4, 4);
    add(w, 'AT-MULTI', png);
    for (const range of ['bytes=0-1,4-5', 'items=0-1', 'bytes=5-2']) {
      const r = await get(w.h, 'AT-MULTI', { range });
      expect(r.statusCode, range).toBe(200);
      expect(r.headers['content-range'], range).toBeUndefined();
      expect(r.rawPayload.equals(png), range).toBe(true);
    }
  });

  it('etag304', async () => {
    const w = await world();
    add(w, 'AT-E', syntheticPng(2, 2));
    const first = await get(w.h, 'AT-E');
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^"AT-E-\d+-\d+"$/);
    const again = await get(w.h, 'AT-E', { 'if-none-match': etag });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
    const other = await get(w.h, 'AT-E', { 'if-none-match': '"nope"' });
    expect(other.statusCode).toBe(200);
  });

  it('headMatchesGet', async () => {
    const w = await world();
    const png = syntheticPng(8, 8);
    add(w, 'AT-H', png);
    const g = await get(w.h, 'AT-H');
    const h = await get(w.h, 'AT-H', {}, 'HEAD');
    expect(h.statusCode).toBe(200);
    expect(h.body).toBe('');
    for (const k of [
      'content-type',
      'content-length',
      'etag',
      'accept-ranges',
      'cache-control',
      'content-disposition',
      'x-content-type-options',
    ]) {
      expect(h.headers[k], k).toBe(g.headers[k]);
    }
    const hr = await get(w.h, 'AT-H', { range: 'bytes=0-3' }, 'HEAD');
    expect(hr.statusCode).toBe(206);
    expect(hr.headers['content-length']).toBe('4');
  });

  it('closedReaderIs503', async () => {
    const w = await world({
      attachmentFile: () => {
        throw new Error('chat.db reader used while disconnected');
      },
    });
    const r = await get(w.h, 'AT-ANY');
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: 'source-unavailable' });
    // The real reader, closed, answers the same.
    const w2 = await world();
    add(w2, 'AT-C', syntheticPng(2, 2));
    w2.h.reader.close();
    const r2 = await get(w2.h, 'AT-C');
    expect(r2.statusCode).toBe(503);
  });

  it('401 with no bearer, a wrong one, or an adapter token, on GET and HEAD', async () => {
    const w = await world();
    add(w, 'AT-AUTH', syntheticPng(2, 2));
    const minted = await w.h.server.app.inject({
      method: 'POST',
      url: '/v1/adapters',
      headers: w.h.headers,
      payload: { id: 'echo', kind: 'echo', displayName: 'Echo' },
    });
    const adapterToken =
      minted.statusCode === 201
        ? (minted.json() as { token: string }).token
        : `wm_${'1'.repeat(64)}`;
    for (const authorization of [
      undefined,
      `Bearer wm_${'0'.repeat(64)}`,
      `Bearer ${adapterToken}`,
    ]) {
      for (const method of ['GET', 'HEAD'] as const) {
        const r = await w.h.server.app.inject({
          method,
          url: '/v1/attachments/AT-AUTH',
          headers: authorization === undefined ? {} : { authorization },
        });
        expect(r.statusCode, `${method} ${String(authorization)}`).toBe(401);
        expect(r.headers['content-type']).not.toBe('image/png');
      }
    }
  });

  it('noPathInAnyBody: no answer names the temp root or a path', async () => {
    const w = await world();
    add(w, 'AT-P1', null, {
      filename: '~/Library/Messages/Attachments-evil/x.png',
    });
    add(w, 'AT-P2', syntheticPng(2, 2));
    unlinkSync(w.pathOf('AT-P2'));
    add(w, 'AT-P3', null, { filename: null });
    add(w, 'AT-P4', syntheticPng(2, 2));
    for (const [id, headers] of [
      ['AT-P1', {}],
      ['AT-P2', {}],
      ['AT-P3', {}],
      ['AT-NONE', {}],
      ['AT-P4', { range: 'bytes=999-' }],
    ] as const) {
      const r = await get(w.h, id, headers);
      expect(r.statusCode, id).toBeGreaterThanOrEqual(400);
      const all = r.body + JSON.stringify(r.headers);
      expect(all, id).not.toContain(w.dir);
      expect(all, id).not.toMatch(/Library|Attachments|~\//);
    }
  });

  it('no audit row and no broadcast follow a read', async () => {
    const w = await world();
    add(w, 'AT-Q', syntheticPng(2, 2));
    const frames = w.h.broadcasts.length;
    const audits = auditEvents(w.h.store).length;
    await get(w.h, 'AT-Q');
    await get(w.h, 'AT-Q', {}, 'HEAD');
    await get(w.h, 'AT-NOPE');
    expect(w.h.broadcasts.length).toBe(frames);
    expect(auditEvents(w.h.store).length).toBe(audits);
  });
});

describe('v2 F6b: sniff and range, as units', () => {
  it('the closed sniff set, and nothing else', () => {
    expect(sniff(syntheticHeader('jpeg'))).toBe('image/jpeg');
    expect(sniff(syntheticHeader('png'))).toBe('image/png');
    expect(sniff(syntheticHeader('gif'))).toBe('image/gif');
    expect(sniff(syntheticHeader('webp'))).toBe('image/webp');
    expect(sniff(syntheticHeader('heic'))).toBe('image/heic');
    expect(sniff(syntheticHeader('heif'))).toBe('image/heic');
    expect(sniff(syntheticHeader('mp4'))).toBe('video/mp4');
    expect(sniff(syntheticHeader('mov'))).toBe('video/quicktime');
    expect(sniff(syntheticHeader('pdf'))).toBe('application/pdf');
    expect(sniff(syntheticHeader('caf'))).toBe('audio/x-caf');
    expect(sniff(syntheticHeader('html'))).toBeNull();
    expect(sniff(syntheticHeader('zip'))).toBeNull();
    expect(sniff(new Uint8Array(0))).toBeNull();
  });

  it('parseRange', () => {
    expect(parseRange(undefined, 10)).toBe('full');
    expect(parseRange('bytes=0-4', 10)).toEqual({ start: 0, end: 4 });
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange('bytes=-30', 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=10-', 10)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-0', 0)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-1,3-4', 10)).toBe('full');
    expect(parseRange('bytes=-', 10)).toBe('full');
  });

  it('a resolver error that is not ENOENT throws (the route answers 503)', () => {
    const fs: ResolveFs = {
      ...realFs,
      realpathSync: () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
    };
    expect(() =>
      resolveAttachment(
        { filename: '/x/y.png', transferName: 'y.png', transferState: 5 },
        { home: '/h', root: '/x', fs },
      ),
    ).toThrow(/EACCES/);
  });
});

describe('v2 F6b: the surface (route ratchet #32)', () => {
  it('pins GET and its HEAD twin', () => {
    // 83 since v2 F6d (#33) added `POST /v1/attachments/staged`.
    expect(ROUTE_TABLE).toHaveLength(83);
    expect(ROUTE_TABLE).toContain('GET /v1/attachments/:id');
    expect(ROUTE_TABLE).toContain('HEAD /v1/attachments/:id');
  });
});
