/**
 * v2 F7b: `ownHandle`, the operator's own iMessage identity for the reply
 * banner ("Replying on iMessage as ..."). It is the destination_caller_id
 * of the newest message the operator SENT over iMessage: an inbound row's
 * caller id is the account it arrived on, which may be another alias, and
 * an SMS row's is a phone line, not the iMessage identity.
 *
 * The column is in Apple's schema but probed with PRAGMA table_info, so an
 * older chat.db without it gives null rather than an error.
 *
 * Every chat.db here is a synthetic fixture in tmp; every handle is +1555
 * or example.com. Nothing reads ~/Library/Messages or Contacts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createChatDb, type ChatDbFixture } from '@wemessage/fixtures';
import { createChatDbReader, type IngestChatDbReader } from '@wemessage/ingest';
import type { Clock } from '@wemessage/core';

const FIXED_NOW = '2026-10-10T12:00:00.000Z';
const clock: Clock = {
  now: () => FIXED_NOW,
  nowMs: () => Date.parse(FIXED_NOW),
};

const ME_PHONE = '+15550100000';
const ME_EMAIL = 'me@example.com';
const OTHER_ALIAS = 'other@example.com';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function freshFixture(opts?: { callerIdColumn?: boolean }): ChatDbFixture {
  const dir = mkdtempSync(join(tmpdir(), 'wm-own-handle-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = createChatDb(join(dir, 'chat.db'), opts);
  cleanups.push(() => fixture.close());
  return fixture;
}

function readerOver(f: ChatDbFixture): IngestChatDbReader {
  const reader = createChatDbReader(f.path, { clock });
  cleanups.push(() => reader.close());
  return reader;
}

function chatWith(
  f: ChatDbFixture,
  handle: string,
): {
  chatId: number;
  handleId: number;
} {
  const handleId = f.addHandle(handle);
  const chatId = f.addChat({ identifier: handle, handleIds: [handleId] });
  return { chatId, handleId };
}

describe('ownHandle (v2 F7b)', () => {
  it('newestSentIMessageWins', () => {
    const f = freshFixture();
    const { chatId, handleId } = chatWith(f, '+15550100001');
    f.addMessage({ chatId, isFromMe: true, text: 'a', callerId: ME_EMAIL });
    f.addMessage({ chatId, handleId, text: 'b' });
    f.addMessage({ chatId, isFromMe: true, text: 'c', callerId: ME_PHONE });
    expect(readerOver(f).ownHandle()).toBe(ME_PHONE);
  });

  it('inboundCallerIdIgnored', () => {
    const f = freshFixture();
    const { chatId, handleId } = chatWith(f, '+15550100001');
    f.addMessage({ chatId, isFromMe: true, text: 'a', callerId: ME_PHONE });
    // Newer, but INBOUND: its caller id names the alias it arrived on.
    f.addMessage({ chatId, handleId, text: 'b', callerId: OTHER_ALIAS });
    expect(readerOver(f).ownHandle()).toBe(ME_PHONE);
  });

  it('smsRowIgnored', () => {
    const f = freshFixture();
    const { chatId } = chatWith(f, '+15550100001');
    f.addMessage({ chatId, isFromMe: true, text: 'a', callerId: ME_EMAIL });
    f.addSmsMessage({
      chatId,
      isFromMe: true,
      text: 'b',
      callerId: '+15550100009',
    });
    expect(readerOver(f).ownHandle()).toBe(ME_EMAIL);
  });

  it('an empty caller id is skipped, and no sent row at all is null', () => {
    const f = freshFixture();
    const { chatId, handleId } = chatWith(f, '+15550100001');
    const reader = readerOver(f);
    expect(reader.ownHandle()).toBeNull();
    f.addMessage({ chatId, handleId, text: 'in only' });
    expect(reader.ownHandle()).toBeNull();
    f.addMessage({ chatId, isFromMe: true, text: 'a', callerId: ME_PHONE });
    f.addMessage({ chatId, isFromMe: true, text: 'b', callerId: '' });
    f.addMessage({ chatId, isFromMe: true, text: 'c' });
    expect(reader.ownHandle()).toBe(ME_PHONE);
  });

  it('absentColumnGivesNull', () => {
    const f = freshFixture({ callerIdColumn: false });
    const { chatId } = chatWith(f, '+15550100001');
    f.addMessage({ chatId, isFromMe: true, text: 'a' });
    const cols = (
      f.db.prepare('PRAGMA table_info(message)').all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).not.toContain('destination_caller_id');
    expect(readerOver(f).ownHandle()).toBeNull();
  });
});

describe('ownHandle perf (v2 F7b)', () => {
  const ROWS = 530_000;
  const BUDGET = { typicalMs: 5, noSentMs: 150 } as const;
  let dir = '';
  let typical: IngestChatDbReader | undefined;
  let noSent: IngestChatDbReader | undefined;
  const closers: (() => void)[] = [];

  function seed(path: string, withSent: boolean): void {
    const f = createChatDb(path);
    const { chatId, handleId } = chatWith(f, '+15550100001');
    f.db.transaction(() => {
      for (let i = 0; i < ROWS; i += 1) {
        // A typical history: a sent row every few rows. The worst case has
        // none at all, so the reader walks every row before giving up.
        const sent = withSent && i % 3 === 0;
        f.addMessage({
          chatId,
          ...(sent ? { isFromMe: true, callerId: ME_PHONE } : { handleId }),
          text: 'x',
        });
      }
    })();
    f.close();
  }

  function median(run: () => unknown): number {
    run();
    const samples: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const t0 = performance.now();
      run();
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    return samples[2] ?? Number.POSITIVE_INFINITY;
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'wm-own-handle-perf-'));
    seed(join(dir, 'typical.db'), true);
    seed(join(dir, 'nosent.db'), false);
    typical = createChatDbReader(join(dir, 'typical.db'), { clock });
    noSent = createChatDbReader(join(dir, 'nosent.db'), { clock });
    closers.push(
      () => typical?.close(),
      () => noSent?.close(),
    );
  }, 600_000);

  afterAll(() => {
    for (const c of closers) c();
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  it(`typical <= ${String(BUDGET.typicalMs)} ms, no sent rows <= ${String(BUDGET.noSentMs)} ms`, () => {
    expect(typical?.ownHandle()).toBe(ME_PHONE);
    expect(noSent?.ownHandle()).toBeNull();
    const t = median(() => typical?.ownHandle());
    const n = median(() => noSent?.ownHandle());
    console.info(
      `[perf] ownHandle typical ${t.toFixed(2)} ms, no sent ${n.toFixed(2)} ms`,
    );
    expect(t).toBeLessThanOrEqual(BUDGET.typicalMs);
    expect(n).toBeLessThanOrEqual(BUDGET.noSentMs);
  });
});
