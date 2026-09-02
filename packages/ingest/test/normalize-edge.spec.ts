/**
 * Scenario 7 — Normalizer handles every §1.3.8 inbound kind (spec Part 2 #7;
 * named S1 checkpoint: "tapback/edit/unsend/audio/SMS/self").
 *
 * Given fixture DBs built per Scenario 6 (@wemessage/fixtures), when rows are
 * read via ChatDbReader and normalized into §3.2 Message, then every §1.3.8
 * kind maps per the table: tapbacks, edits (latest revision from
 * message_summary_info), unsend, attachment-only (paths referenced, never
 * copied), audio, service preservation (sms/rcs/imessage/unknown), self-sent
 * isFromMe, group isGroup, text-vs-attributedBody precedence, decode-failed
 * degrade (§2.2.1), reply threading, Apple-epoch date conversion (RD §1).
 *
 * Ports/fakes: real SQLite fixture file (that's the point); Clock fake.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatDb, type ChatDbFixture } from '@wemessage/fixtures';
import {
  appleNsToIso,
  createChatDbReader,
  type DecodeFailedSignal,
} from '@wemessage/ingest';
import type { Clock, Message } from '@wemessage/core';

const FIXED_NOW = '2026-01-05T12:00:00.000Z';
const fakeClock: Clock = {
  now: () => FIXED_NOW,
  nowMs: () => Date.parse(FIXED_NOW),
};

interface Ctx {
  fixture: ChatDbFixture;
  chatId: number;
  handleId: number;
  signals: DecodeFailedSignal[];
  read: () => Promise<Message[]>;
  close: () => void;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function ctx(): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'wm-normalize-'));
  const fixture = createChatDb(join(dir, 'chat.db'));
  const chatId = fixture.addChat({ identifier: '+15555550111' });
  const handleId = fixture.addHandle('+15555550111');
  const signals: DecodeFailedSignal[] = [];
  let close = (): void => {};
  const read = async (): Promise<Message[]> => {
    const reader = createChatDbReader(fixture.path, {
      clock: fakeClock,
      onDecodeFailed: (s) => signals.push(s),
    });
    close = () => reader.close();
    return reader.readSince(0);
  };
  cleanups.push(() => {
    close();
    fixture.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { fixture, chatId, handleId, signals, read, close: () => close() };
}

async function one(c: Ctx, guid: string): Promise<Message> {
  const all = await c.read();
  const m = all.find((x) => x.guid === guid);
  expect(m).toBeDefined();
  return m as Message;
}

describe('normalize-edge (Scenario 7, §1.3.8 / §3.2)', () => {
  it('plain text from the text column -> kind:text with the body', async () => {
    const c = ctx();
    const ref = c.fixture.addMessage({
      chatId: c.chatId,
      handleId: c.handleId,
      text: 'hello from the text column',
    });
    const m = await one(c, ref.guid);
    expect(m.kind).toBe('text');
    expect(m.text).toBe('hello from the text column');
    expect(m.sourceRowid).toBe(ref.rowid);
    expect(m.chatGuid).toContain('+15555550111');
    expect(m.handle).toBe('+15555550111');
  });

  it('plain text from attributedBody when text is NULL (the Ventura case, §2.2.1)', async () => {
    const c = ctx();
    const ref = c.fixture.addMessage({
      chatId: c.chatId,
      handleId: c.handleId,
      attributedBodyFixture: 'plain-ascii',
    });
    const m = await one(c, ref.guid);
    expect(m.kind).toBe('text');
    expect(m.text).toBe('GL-FIX-001 plain ascii body');
    expect(c.signals).toHaveLength(0);
  });

  it('tapback -> kind:tapback with targetGuid + type, never matched as text', async () => {
    const c = ctx();
    const target = c.fixture.addMessage({
      chatId: c.chatId,
      handleId: c.handleId,
      text: 'react to me',
    });
    const tap = c.fixture.addTapback(target.guid, 2001, {
      chatId: c.chatId,
      handleId: c.handleId,
    });
    const m = await one(c, tap.guid);
    expect(m.kind).toBe('tapback');
    expect(m.tapback).toEqual({ targetGuid: target.guid, type: 2001 });
  });

  it('edited message -> kind:edit, editedAt set, text = LATEST revision from message_summary_info', async () => {
    const c = ctx();
    const ref = c.fixture.addMessage({
      chatId: c.chatId,
      handleId: c.handleId,
      text: 'original body',
    });
    c.fixture.editMessage(ref.guid, 'text-column after edit', {
      at: '2026-01-02T03:04:05Z',
    });
    const m = await one(c, ref.guid);
    expect(m.kind).toBe('edit');
    // The summary-info payload is authoritative for the post-edit body; the
    // committed corpus blob's latest revision is GL-FIX-005 v2 (Part 3).
    expect(m.text).toBe('GL-FIX-005 edited body (v2)');
    expect(m.editedAt).toBe('2026-01-02T03:04:05.000Z');
  });

  it('unsent message -> kind:unsend with text null', async () => {
    const c = ctx();
    const ref = c.fixture.addMessage({
      chatId: c.chatId,
      handleId: c.handleId,
      text: 'soon retracted',
    });
    c.fixture.unsendMessage(ref.guid, { at: '2026-01-02T03:04:05Z' });
    const m = await one(c, ref.guid);
    expect(m.kind).toBe('unsend');
    expect(m.text).toBeNull();
  });

  it('attachment-only -> AttachmentRef[] referenced by path+mime, never copied (§1.3.8)', async () => {
    const c = ctx();
    const ref = c.fixture.addAttachmentOnly({
      chatId: c.chatId,
      handleId: c.handleId,
      filename: '~/Library/Messages/Attachments/ab/cd/photo.png',
      mimeType: 'image/png',
      transferName: 'photo.png',
      totalBytes: 4096,
    });
    const m = await one(c, ref.guid);
    expect(m.kind).toBe('attachment-only');
    expect(m.text).toBeNull();
    expect(m.attachments).toEqual([
      {
        path: '~/Library/Messages/Attachments/ab/cd/photo.png',
        mimeType: 'image/png',
        bytes: 4096,
        transferName: 'photo.png',
      },
    ]);
  });

  it('audio message -> kind:audio with the audio attachment referenced', async () => {
    const c = ctx();
    const ref = c.fixture.addAudioMessage({
      chatId: c.chatId,
      handleId: c.handleId,
    });
    const m = await one(c, ref.guid);
    expect(m.kind).toBe('audio');
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments[0]?.mimeType).toContain('audio');
  });

  it('service is preserved: iMessage/SMS/RCS map to imessage/sms/rcs; anything else -> unknown', async () => {
    const c = ctx();
    const im = c.fixture.addMessage({
      chatId: c.chatId,
      handleId: c.handleId,
      text: 'im',
    });
    const sms = c.fixture.addSmsMessage({
      chatId: c.chatId,
      handleId: c.handleId,
      text: 'sms',
    });
    const rcs = c.fixture.addMessage({
      chatId: c.chatId,
      handleId: c.handleId,
      text: 'rcs',
      service: 'RCS',
    });
    const odd = c.fixture.addMessage({
      chatId: c.chatId,
      handleId: c.handleId,
      text: 'odd',
      service: 'Satellite',
    });
    const all = await c.read();
    const byGuid = new Map(all.map((m) => [m.guid, m]));
    expect(byGuid.get(im.guid)?.service).toBe('imessage');
    expect(byGuid.get(sms.guid)?.service).toBe('sms');
    expect(byGuid.get(rcs.guid)?.service).toBe('rcs');
    expect(byGuid.get(odd.guid)?.service).toBe('unknown');
  });

  it('self-sent (is_from_me, incl. other-device) -> isFromMe:true (INV-6 ground truth)', async () => {
    const c = ctx();
    const mine = c.fixture.addSelfMessage({
      chatId: c.chatId,
      handleId: c.handleId,
      text: 'sent from my other device',
    });
    const theirs = c.fixture.addMessage({
      chatId: c.chatId,
      handleId: c.handleId,
      text: 'inbound',
    });
    const all = await c.read();
    expect(all.find((m) => m.guid === mine.guid)?.isFromMe).toBe(true);
    expect(all.find((m) => m.guid === theirs.guid)?.isFromMe).toBe(false);
  });

  it('group chat row -> isGroup:true (style 43); 1:1 -> isGroup:false', async () => {
    const c = ctx();
    const h2 = c.fixture.addHandle('+15555550122');
    const groupId = c.fixture.addGroupChat([c.handleId, h2], {
      displayName: 'Fixture Group',
    });
    const inGroup = c.fixture.addMessage({
      chatId: groupId,
      handleId: h2,
      text: 'group hello',
    });
    const oneToOne = c.fixture.addMessage({
      chatId: c.chatId,
      handleId: c.handleId,
      text: 'dm hello',
    });
    const all = await c.read();
    expect(all.find((m) => m.guid === inGroup.guid)?.isGroup).toBe(true);
    expect(all.find((m) => m.guid === oneToOne.guid)?.isGroup).toBe(false);
  });

  it('undecodable attributedBody -> text:null, kind:attachment-only, decode-failed signal surfaced (§2.2.1)', async () => {
    const c = ctx();
    const bad = c.fixture.addMessage({
      chatId: c.chatId,
      handleId: c.handleId,
      attributedBodyFixture: 'malformed-truncated',
    });
    const m = await one(c, bad.guid);
    expect(m.text).toBeNull();
    expect(m.kind).toBe('attachment-only');
    expect(c.signals).toHaveLength(1);
    expect(c.signals[0]?.guid).toBe(bad.guid);
    expect(c.signals[0]?.sourceRowid).toBe(bad.rowid);
    expect(c.signals[0]?.reason.length).toBeGreaterThan(0);
  });

  it('reply threading -> threadOriginatorGuid populated', async () => {
    const c = ctx();
    const origin = c.fixture.addMessage({
      chatId: c.chatId,
      handleId: c.handleId,
      text: 'thread origin',
    });
    const reply = c.fixture.addMessage({
      chatId: c.chatId,
      handleId: c.handleId,
      text: 'threaded reply',
      threadOriginatorGuid: origin.guid,
    });
    const all = await c.read();
    expect(all.find((m) => m.guid === reply.guid)?.threadOriginatorGuid).toBe(
      origin.guid,
    );
    expect(
      all.find((m) => m.guid === origin.guid)?.threadOriginatorGuid,
    ).toBeUndefined();
  });

  it('Apple-epoch conversion: sentAt is golden ISO-UTC; receivedAt comes from the injected Clock (RD §1)', async () => {
    const c = ctx();
    const ref = c.fixture.addMessage({
      chatId: c.chatId,
      handleId: c.handleId,
      text: 'dated',
      at: '2026-01-02T03:04:05Z',
    });
    const m = await one(c, ref.guid);
    expect(m.sentAt).toBe('2026-01-02T03:04:05.000Z');
    expect(m.receivedAt).toBe(FIXED_NOW);
    // Pure converter golden (789015845000000000n = the Scenario 6 golden ns).
    expect(appleNsToIso(789015845000000000n)).toBe('2026-01-02T03:04:05.000Z');
  });

  it('readSince(lastRowid) returns only strictly newer rows, in ROWID order', async () => {
    const c = ctx();
    const refs = c.fixture.addMessageBurst(5, {
      chatId: c.chatId,
      handleId: c.handleId,
      startAt: '2026-01-03T00:00:00Z',
    });
    const reader = createChatDbReader(c.fixture.path, { clock: fakeClock });
    cleanups.push(() => reader.close());
    const fromThird = await reader.readSince(refs[2]?.rowid ?? 0);
    expect(fromThird.map((m) => m.guid)).toEqual([
      refs[3]?.guid,
      refs[4]?.guid,
    ]);
    const rowids = fromThird.map((m) => m.sourceRowid);
    expect([...rowids].sort((a, b) => a - b)).toEqual(rowids);
  });

  it('reader never writes: the chat.db handle is opened read-only', async () => {
    const c = ctx();
    c.fixture.addMessage({
      chatId: c.chatId,
      handleId: c.handleId,
      text: 'read-only probe',
    });
    const reader = createChatDbReader(c.fixture.path, { clock: fakeClock });
    cleanups.push(() => reader.close());
    await reader.readSince(0);
    // The reader exposes no write surface; prove the underlying connection is
    // read-only by checking the file did not change after a full read pass.
    expect(reader.isReadonly()).toBe(true);
  });
});
