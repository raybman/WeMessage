/**
 * v2 F6b: the bytes route's budgets, on a synthetic chat.db in tmp.
 *
 *   measured                                       budget
 *   id lookup (chat.db, 2,000 attachments)         <= 2 ms  (median of 50)
 *   resolve + open (realpath, stat, open, fstat)   <= 3 ms  (median of 50)
 *   10 MB GET over loopback, full body read        <= 80 ms (median of 7)
 *
 * Its own file, over a bare Fastify with only the attachments route, like
 * search-route-perf.spec.ts: the route spec boots the whole daemon harness
 * per row, and timing a 10 MB stream beside that is timing the harness.
 * One untimed GET warms the stream path first.
 *
 * Every byte is generated (syntheticHeader); nothing here reads
 * ~/Library/Messages.
 */
import * as realFs from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createChatDb,
  syntheticHeader,
  type ChatDbFixture,
} from '@wemessage/fixtures';
import { createChatDbReader, type IngestChatDbReader } from '@wemessage/ingest';
import type { Clock } from '@wemessage/core';
import { registerAttachmentRoutes, resolveAttachment } from '@wemessage/daemon';

const PEER = '+15550100001';
const FILL = 2_000;
const BIG = 10 * 1024 * 1024;
const BUDGET_LOOKUP_MS = 2;
const BUDGET_OPEN_MS = 3;
const BUDGET_GET_MS = 80;

const clock: Clock = {
  now: () => '2026-10-10T12:00:00.000Z',
  nowMs: () => Date.parse('2026-10-10T12:00:00.000Z'),
};

let dir = '';
let home = '';
let root = '';
let fixture: ChatDbFixture | undefined;
let reader: IngestChatDbReader | undefined;
let app: FastifyInstance | undefined;
let port = 0;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? Infinity;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wm-f6b-perf-'));
  home = join(dir, 'home');
  root = join(home, 'Library', 'Messages', 'Attachments');
  mkdirSync(root, { recursive: true });
  const f = createChatDb(join(dir, 'chat.db'), { home });
  fixture = f;
  const handleId = f.addHandle(PEER);
  const chatId = f.addChat({ identifier: PEER, handleIds: [handleId] });
  for (let i = 0; i < FILL; i += 1) {
    f.addAttachmentOnly({
      chatId,
      handleId,
      attachmentGuid: `AT-FILL-${String(i)}`,
      transferName: `f${String(i)}.png`,
    });
  }
  f.addAttachmentOnly({
    chatId,
    handleId,
    attachmentGuid: 'AT-BIG',
    transferName: 'big.png',
    onDisk: syntheticHeader('png', BIG),
  });
  const r = createChatDbReader(f.path, { clock });
  reader = r;
  const a = Fastify();
  app = a;
  registerAttachmentRoutes(a, {
    attachmentFile: (id) => r.attachmentFile(id),
    home,
    root,
  });
  await a.listen({ port: 0, host: '127.0.0.1' });
  const addr = a.server.address();
  port = typeof addr === 'object' && addr !== null ? addr.port : 0;
});

afterAll(async () => {
  await app?.close();
  reader?.close();
  fixture?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('v2 F6b: bytes route perf (synthetic, in tmp)', () => {
  it(`id lookup ≤ ${String(BUDGET_LOOKUP_MS)} ms, resolve + open ≤ ${String(BUDGET_OPEN_MS)} ms`, () => {
    const r = reader as IngestChatDbReader;
    r.attachmentFile('AT-BIG');
    const lookups: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      const t = performance.now();
      r.attachmentFile('AT-BIG');
      lookups.push(performance.now() - t);
    }
    const row = r.attachmentFile('AT-BIG');
    const opens: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      const t = performance.now();
      const res = resolveAttachment(row, { home, root, fs: realFs });
      opens.push(performance.now() - t);
      expect(res.ok).toBe(true);
      if (res.ok) realFs.closeSync(res.fd);
    }
    const [l, o] = [median(lookups), median(opens)];
    console.log(
      `[perf] F6b id lookup median ${l.toFixed(2)} ms (≤ ${String(BUDGET_LOOKUP_MS)}); resolve+open median ${o.toFixed(2)} ms (≤ ${String(BUDGET_OPEN_MS)})`,
    );
    expect(l).toBeLessThanOrEqual(BUDGET_LOOKUP_MS);
    expect(o).toBeLessThanOrEqual(BUDGET_OPEN_MS);
  });

  it(`10 MB GET to loopback ≤ ${String(BUDGET_GET_MS)} ms`, async () => {
    const url = `http://127.0.0.1:${String(port)}/v1/attachments/AT-BIG`;
    // Warm the stream path once, untimed.
    await (await fetch(url)).arrayBuffer();
    const gets: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const t = performance.now();
      const res = await fetch(url);
      const body = new Uint8Array(await res.arrayBuffer());
      gets.push(performance.now() - t);
      expect(res.status).toBe(200);
      expect(body.length).toBe(BIG);
    }
    const g = median(gets);
    console.log(
      `[perf] F6b 10 MB GET median ${g.toFixed(1)} ms (≤ ${String(BUDGET_GET_MS)})`,
    );
    expect(g).toBeLessThanOrEqual(BUDGET_GET_MS);
  });
});
