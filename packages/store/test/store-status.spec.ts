/**
 * v2 F7a: the status facts the store answers.
 *
 * "today" is messages SENT since the operator's local midnight, never rows
 * COPIED since UTC midnight: right after the first copy every row was
 * received today, so a copy-time count reads the whole history as today.
 *
 * Real temp-dir SqliteStore, fake Clock. Every handle is synthetic (+1555).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dayStartInZone, type Clock, type Message } from '@wemessage/core';
import { openStore, type SqliteStore } from '@wemessage/store';

const NOW = '2026-09-02T12:00:00.000Z';
const clock: Clock = { now: () => NOW, nowMs: () => Date.parse(NOW) };

const MAYA = 'iMessage;-;+15550100001';
const THEO = 'iMessage;-;+15550100002';
const CREW = 'iMessage;+;chat000000000000000001';

let seq = 0;
function msg(partial: Partial<Message> & { guid: string }): Message {
  seq += 1;
  return {
    sourceRowid: seq,
    chatGuid: MAYA,
    handle: '+15550100001',
    isFromMe: false,
    isGroup: false,
    service: 'imessage',
    kind: 'text',
    text: 'hello',
    attachments: [],
    sentAt: '2026-09-02T10:00:00.000Z',
    // Copy time: the ingest stamps the clock, so a first copy makes every
    // row "received today".
    receivedAt: NOW,
    ...partial,
  };
}

let dir = '';
let store: SqliteStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wm-store-status-'));
  store = openStore({ dir, clock });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('store status facts (v2 F7a)', () => {
  it('todayCountsBySentTimeNotCopyTime', () => {
    store.insertInboundMessage(
      msg({ guid: 'OLD-1', sentAt: '2019-05-01T10:00:00.000Z' }),
    );
    store.insertInboundMessage(
      msg({ guid: 'OLD-2', sentAt: '2019-05-02T10:00:00.000Z' }),
    );
    const since = dayStartInZone(new Date(NOW), 'UTC').toISOString();
    // Both rows were copied today; neither was sent today.
    expect(store.countSentSince(since)).toBe(0);
    store.insertInboundMessage(msg({ guid: 'NEW-1' }));
    expect(store.countSentSince(since)).toBe(1);
  });

  it('todayHonoursZone', () => {
    // 23:30 on 2026-09-01 in Los Angeles is 06:30 UTC on 09-02: past UTC
    // midnight, but yesterday where the operator lives.
    store.insertInboundMessage(
      msg({ guid: 'LATE', sentAt: '2026-09-02T06:30:00.000Z' }),
    );
    const since = dayStartInZone(
      new Date(NOW),
      'America/Los_Angeles',
    ).toISOString();
    expect(since).toBe('2026-09-02T07:00:00.000Z');
    expect(store.countSentSince(since)).toBe(0);
    store.insertInboundMessage(
      msg({ guid: 'MORNING', sentAt: '2026-09-02T07:00:00.000Z' }),
    );
    expect(store.countSentSince(since)).toBe(1);
  });

  it('mirrorCountsMatchSeeds', () => {
    expect(store.mirrorCounts()).toEqual({
      messages: 0,
      chats: 0,
      historyFrom: null,
    });
    store.insertInboundMessage(msg({ guid: 'A1' }));
    store.insertInboundMessage(msg({ guid: 'A2' }));
    store.insertInboundMessage(
      msg({ guid: 'B1', chatGuid: THEO, handle: '+15550100002' }),
    );
    store.insertInboundMessage(
      msg({ guid: 'C1', chatGuid: CREW, isGroup: true, kind: 'tapback' }),
    );
    // Idempotent on guid: a re-copy is not a second message.
    store.insertInboundMessage(msg({ guid: 'A1' }));
    const counts = store.mirrorCounts();
    expect(counts.messages).toBe(4);
    expect(counts.chats).toBe(3);
  });

  it('historyFromIsOldestSent', () => {
    store.insertInboundMessage(
      msg({
        guid: 'MID',
        sentAt: '2018-01-01T00:00:00.000Z',
        receivedAt: '2026-09-02T11:00:00.000Z',
      }),
    );
    // Copied FIRST (oldest received_at) but sent later: copy order is not
    // history order.
    store.insertInboundMessage(
      msg({
        guid: 'EARLY-COPY',
        sentAt: '2020-01-01T00:00:00.000Z',
        receivedAt: '2026-09-01T00:00:00.000Z',
      }),
    );
    store.insertInboundMessage(
      msg({
        guid: 'OLDEST',
        sentAt: '2014-03-02T08:15:00.000Z',
        receivedAt: '2026-09-02T11:30:00.000Z',
      }),
    );
    expect(store.mirrorCounts().historyFrom).toBe('2014-03-02T08:15:00.000Z');
  });
});
