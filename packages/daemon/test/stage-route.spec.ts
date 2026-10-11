/**
 * v2 F6d: `POST /v1/attachments/staged` (route ratchet #33), the operator's
 * file into the daemon's own outbox.
 *
 * Every byte here is generated in the test (syntheticPng / syntheticHeader)
 * and every outbox is a temp folder under the harness's config dir. Nothing
 * reads ~/Library/Messages and nothing is sent: staging is not sending.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { syntheticHeader, syntheticPng } from '@wemessage/fixtures';
import {
  SETTING_SEND_ATTACHMENTS,
  STAGE_KEEP_MS,
  STAGE_MAX_BYTES,
} from '@wemessage/daemon';
import {
  boot,
  cleanupHarness,
  CHAT,
  type BootOptions,
  type Harness,
} from './helpers/draft-harness.js';

afterEach(async () => {
  await cleanupHarness();
});

async function harness(
  outbox: BootOptions['outbox'] = true,
  on = true,
): Promise<Harness> {
  const h = await boot({ outbox, send: true });
  if (on) h.store.setSetting(SETTING_SEND_ATTACHMENTS, '1');
  return h;
}

function stage(
  h: Harness,
  payload: Buffer | Readable,
  opts: { mime?: string; name?: string } = {},
) {
  return h.server.app.inject({
    method: 'POST',
    url: '/v1/attachments/staged',
    headers: {
      ...h.headers,
      'content-type': opts.mime ?? 'image/png',
      'x-wemessage-name': encodeURIComponent(opts.name ?? 'grey.png'),
    },
    payload,
  });
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** `total` bytes, a PNG signature first, made 64 KiB at a time. */
function lazyPng(total: number): Readable {
  const head = syntheticPng(2, 2);
  const chunk = Buffer.alloc(64 * 1024, 0x55);
  let sent = 0;
  return Readable.from(
    (function* () {
      yield head;
      sent += head.length;
      while (sent < total) {
        const n = Math.min(chunk.length, total - sent);
        sent += n;
        yield n === chunk.length ? chunk : chunk.subarray(0, n);
      }
    })(),
  );
}

describe('v2 F6d: staging streams, hashes, caps and sniffs', () => {
  it('streamsHashesAndCaps', async () => {
    const h = await harness();
    // Under the cap: the stage id IS the sha256 of the bytes, the file is
    // under a folder named by that hash, 0600 in a 0700 folder.
    const png = syntheticPng(8, 8);
    const ok = await stage(h, png, { name: '../../evil/grey.png' });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as {
      stageId: string;
      name: string;
      mime: string;
      bytes: number;
    };
    expect(body).toEqual({
      stageId: sha(png),
      name: 'grey.png',
      mime: 'image/png',
      bytes: png.length,
    });
    const folder = join(h.dir, 'outbox', sha(png));
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(statSync(join(folder, 'grey.png')).mode & 0o777).toBe(0o600);
    expect(h.store.getStagedFile(sha(png))?.bytes).toBe(png.length);

    // 100 MB + 1, streamed without a Content-Length so the outbox's own
    // count is what refuses it (the header check is the cheap twin).
    //
    // Measured on CI (runs 38107969492, 38107969479): a cold stage grew RSS
    // by 36 MB, all of it V8 sizing its young generation to the allocation
    // rate (heapTotal +12 MB locally, heapUsed +0.2 MB, buffers +0.1 MB), not
    // a byte of body held. So one identical stage warms the heap first, and
    // the second is measured at its PEAK (sampled every 5 ms), which is
    // stricter than the end-to-end delta. A route that buffered the body
    // would still grow by about 100 MB here.
    expect((await stage(h, lazyPng(STAGE_MAX_BYTES + 1))).statusCode).toBe(413);
    const before = process.memoryUsage().rss;
    let peak = before;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 5);
    const big = await stage(h, lazyPng(STAGE_MAX_BYTES + 1));
    clearInterval(sampler);
    peak = Math.max(peak, process.memoryUsage().rss);
    const grownMb = (peak - before) / (1024 * 1024);
    expect(big.statusCode).toBe(413);
    expect(big.json()).toEqual({
      error: 'attachment-too-large',
      limit: STAGE_MAX_BYTES,
    });
    console.log(
      `F6d stage 100 MB + 1: peak RSS grew ${grownMb.toFixed(1)} MB (budget 16)`,
    );
    expect(grownMb).toBeLessThanOrEqual(16);
    // Nothing left behind: no temp file, no second folder.
    expect(
      readdirSync(join(h.dir, 'outbox')).filter((n) => n !== sha(png)),
    ).toEqual([]);

    // The header twin: a declared length over the cap never reaches disk.
    const declared = await h.server.app.inject({
      method: 'POST',
      url: '/v1/attachments/staged',
      headers: {
        ...h.headers,
        'content-type': 'image/png',
        'x-wemessage-name': 'grey.png',
        'content-length': String(STAGE_MAX_BYTES + 1),
      },
      payload: lazyPng(STAGE_MAX_BYTES + 1),
    });
    expect(declared.statusCode).toBe(413);
  }, 60_000);

  it('a lowered cap refuses one byte over and keeps exactly the cap', async () => {
    const png = syntheticPng(4, 4);
    const h = await harness({ maxBytes: png.length });
    expect((await stage(h, png)).statusCode).toBe(200);
    const over = await stage(h, Buffer.concat([png, Buffer.from([0])]));
    expect(over.statusCode).toBe(413);
    expect(over.json()).toEqual({
      error: 'attachment-too-large',
      limit: png.length,
    });
  });

  it('sniffMismatchIs415', async () => {
    const h = await harness();
    // A PNG declared as a JPEG is refused, never "corrected".
    const png = syntheticPng(4, 4);
    const wrong = await stage(h, png, { mime: 'image/jpeg', name: 'a.jpg' });
    expect(wrong.statusCode).toBe(415);
    expect(wrong.json()).toEqual({
      error: 'attachment-type-mismatch',
      declared: 'image/jpeg',
      sniffed: 'image/png',
    });
    // Bytes outside the closed set are refused whatever they claim.
    const unknown = await stage(h, Buffer.from('<html>hello</html>'), {
      mime: 'text/html',
      name: 'a.html',
    });
    expect(unknown.statusCode).toBe(415);
    expect((unknown.json() as { sniffed: unknown }).sniffed).toBeNull();
    // A matching declaration over the same set is accepted.
    const pdf = syntheticHeader('pdf');
    expect(
      (await stage(h, pdf, { mime: 'application/pdf', name: 'a.pdf' }))
        .statusCode,
    ).toBe(200);
    // No row and no file for either refusal.
    expect(h.store.getStagedFile(sha(png))).toBeNull();
    expect(existsSync(join(h.dir, 'outbox', sha(png)))).toBe(false);
    expect(
      readdirSync(join(h.dir, 'outbox')).filter((n) => n.startsWith('.stage-')),
    ).toEqual([]);
  });

  it('a nameless or typeless stage is a 400', async () => {
    const h = await harness();
    const png = syntheticPng(2, 2);
    expect((await stage(h, png, { name: '...' })).statusCode).toBe(400);
    const noType = await h.server.app.inject({
      method: 'POST',
      url: '/v1/attachments/staged',
      headers: { ...h.headers, 'x-wemessage-name': 'grey.png' },
      payload: png,
    });
    expect(noType.statusCode).toBe(400);
  });

  it('offIs409', async () => {
    // D-F6-1: the default build refuses both halves, before a byte lands.
    const h = await harness(true, false);
    const png = syntheticPng(4, 4);
    const staged = await stage(h, png);
    expect(staged.statusCode).toBe(409);
    expect(staged.json()).toEqual({ error: 'attachments-unproven' });
    expect(existsSync(join(h.dir, 'outbox', sha(png)))).toBe(false);
    expect(h.store.getStagedFile(sha(png))).toBeNull();

    const send = await h.server.app.inject({
      method: 'POST',
      url: '/v1/send',
      headers: h.headers,
      payload: { chatGuid: CHAT, file: sha(png) },
    });
    expect(send.statusCode).toBe(409);
    expect(send.json()).toEqual({ error: 'attachments-unproven' });
    expect(h.backend.callCount()).toBe(0);
  });

  it('POST /v1/send takes text or one file, never both and never neither', async () => {
    const h = await harness();
    const png = syntheticPng(4, 4);
    const both = await h.server.app.inject({
      method: 'POST',
      url: '/v1/send',
      headers: h.headers,
      payload: { chatGuid: CHAT, body: 'hi', file: sha(png) },
    });
    expect(both.statusCode).toBe(400);
    const neither = await h.server.app.inject({
      method: 'POST',
      url: '/v1/send',
      headers: h.headers,
      payload: { chatGuid: CHAT },
    });
    expect(neither.statusCode).toBe(400);
    const unstaged = await h.server.app.inject({
      method: 'POST',
      url: '/v1/send',
      headers: h.headers,
      payload: { chatGuid: CHAT, file: sha(png) },
    });
    expect(unstaged.statusCode).toBe(404);
    expect(unstaged.json()).toEqual({ error: 'stage-not-found' });
  });

  it('unboundSweptAfter24h', async () => {
    const h = await harness();
    const png = syntheticPng(6, 6);
    expect((await stage(h, png)).statusCode).toBe(200);
    const folder = join(h.dir, 'outbox', sha(png));
    // A stray file in the outbox root is never a sweep target.
    writeFileSync(join(h.dir, 'outbox', 'not-a-stage'), 'x');

    h.clockCtl.advance(STAGE_KEEP_MS - 1);
    expect(await h.outbox!.sweep()).toEqual([]);
    expect(existsSync(folder)).toBe(true);

    h.clockCtl.advance(1);
    expect(await h.outbox!.sweep()).toEqual([sha(png)]);
    expect(existsSync(folder)).toBe(false);
    expect(existsSync(join(h.dir, 'outbox', 'not-a-stage'))).toBe(true);
    // The row stays, marked removed, and a send of it is refused.
    expect(h.store.getStagedFile(sha(png))?.removedAt).not.toBeNull();
    const send = await h.server.app.inject({
      method: 'POST',
      url: '/v1/send',
      headers: h.headers,
      payload: { chatGuid: CHAT, file: sha(png) },
    });
    expect(send.statusCode).toBe(404);
    // Staging the same bytes again brings it back.
    expect((await stage(h, png)).statusCode).toBe(200);
    expect(h.store.getStagedFile(sha(png))?.removedAt).toBeNull();
  });

  it('a bound file stays until 24 h after its draft ends', async () => {
    const h = await harness();
    const png = syntheticPng(6, 6);
    expect((await stage(h, png)).statusCode).toBe(200);
    h.clockCtl.advance(STAGE_KEEP_MS);
    // Bound and sent (since F6e the send verifies, which ends the draft).
    const send = await h.server.app.inject({
      method: 'POST',
      url: '/v1/send',
      headers: h.headers,
      payload: { chatGuid: CHAT, file: sha(png) },
    });
    expect(send.statusCode).toBe(200);
    expect(await h.outbox!.sweep()).toEqual([]);
    h.clockCtl.advance(STAGE_KEEP_MS - 1);
    expect(await h.outbox!.sweep()).toEqual([]);
    h.clockCtl.advance(1);
    expect(await h.outbox!.sweep()).toEqual([sha(png)]);
  });
});
