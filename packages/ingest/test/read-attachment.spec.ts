/**
 * v2 F6a: the reader names each file by chat.db's attachment.guid, looks a
 * file up by that id for the bytes route, and finds an outbound file by its
 * transfer name for a file send's verification. It still never opens a
 * file, and no transcript page statement names `filename`.
 *
 * Every chat.db here is a synthetic fixture in a tmp dir; every number is
 * +1555 and every byte is generated in the test.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  CHAT_PAGE_STATEMENTS,
  createChatDbReader,
  type IngestChatDbReader,
} from '@wemessage/ingest';
import type { Clock } from '@wemessage/core';

const NOW = '2026-09-01T12:30:00.000Z';
const clock: Clock = { now: () => NOW, nowMs: () => Date.parse(NOW) };

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function fresh(): { fixture: ChatDbFixture; home: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wm-read-attachment-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const fixture = createChatDb(join(dir, 'chat.db'), { home });
  cleanups.push(() => fixture.close());
  return { fixture, home };
}

function readerOver(fixture: ChatDbFixture): IngestChatDbReader {
  const reader = createChatDbReader(fixture.path, { clock });
  cleanups.push(() => reader.close());
  return reader;
}

function chatGuidOf(fixture: ChatDbFixture, chatId: number): string {
  return (
    fixture.db.prepare('SELECT guid FROM chat WHERE ROWID = ?').get(chatId) as {
      guid: string;
    }
  ).guid;
}

describe('v2 F6a: synthetic media', () => {
  it('syntheticPng is a real PNG with the asked size; syntheticHeader carries magic', () => {
    const png = syntheticPng(3, 2, 200);
    expect([...png.subarray(0, 8)]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(png.readUInt32BE(16)).toBe(3);
    expect(png.readUInt32BE(20)).toBe(2);
    expect(syntheticHeader('heic').subarray(4, 12).toString('ascii')).toBe(
      'ftypheic',
    );
    expect(syntheticHeader('pdf', 10).length).toBe(10);
  });

  it('onDisk writes the bytes under the fake home and records the ~/ path', () => {
    const { fixture, home } = fresh();
    const h = fixture.addHandle('+15550100001');
    const chatId = fixture.addChat({ identifier: '+15550100001' });
    const bytes = syntheticPng(4, 4);
    const m = fixture.addAttachmentOnly({
      chatId,
      handleId: h,
      attachmentGuid: 'AT-0001',
      transferName: 'grey.png',
      onDisk: bytes,
    });
    const row = fixture.db
      .prepare(
        `SELECT a.filename AS filename, a.total_bytes AS bytes
           FROM attachment a JOIN message_attachment_join maj
             ON maj.attachment_id = a.ROWID WHERE maj.message_id = ?`,
      )
      .get(m.rowid) as { filename: string; bytes: number };
    expect(row.filename.startsWith('~/Library/Messages/Attachments/')).toBe(
      true,
    );
    expect(row.filename.endsWith('/AT-0001/grey.png')).toBe(true);
    const onDisk = join(home, row.filename.slice(2));
    expect(existsSync(onDisk)).toBe(true);
    expect(readFileSync(onDisk).equals(bytes)).toBe(true);
    expect(row.bytes).toBe(bytes.length);
  });
});

describe('v2 F6a: reader ids', () => {
  it('fileIdIsAttachmentGuid', async () => {
    const { fixture } = fresh();
    const h = fixture.addHandle('+15550100001');
    const chatId = fixture.addChat({ identifier: '+15550100001' });
    fixture.addAttachmentOnly({
      chatId,
      handleId: h,
      attachmentGuid: 'AT-PAGE-1',
      transferName: 'one.png',
    });
    const reader = readerOver(fixture);
    const page = await reader.readChatPage({
      chatGuid: chatGuidOf(fixture, chatId),
      limit: 10,
    });
    const files = page.turns.flatMap((t) => t.files);
    expect(files).toHaveLength(1);
    expect(files[0]?.id).toBe('AT-PAGE-1');
    expect(files[0]?.name).toBe('one.png');
    // The id is a guid, never a path or anything path-shaped.
    expect(JSON.stringify(page)).not.toMatch(/Library|Attachments|~\//);
  });

  it('attachmentFile returns the row for a joined guid, with its path fields', () => {
    const { fixture } = fresh();
    const h = fixture.addHandle('+15550100001');
    const chatId = fixture.addChat({ identifier: '+15550100001' });
    fixture.addAttachmentOnly({
      chatId,
      handleId: h,
      attachmentGuid: 'AT-JOINED',
      transferName: 'joined.png',
      filename: '~/Library/Messages/Attachments/aa/bb/AT-JOINED/joined.png',
      transferState: 5,
    });
    fixture.addAttachmentOnly({
      chatId,
      handleId: h,
      attachmentGuid: 'AT-NOPATH',
      transferName: 'nopath.png',
      filename: null,
    });
    const reader = readerOver(fixture);
    expect(reader.attachmentFile('AT-JOINED')).toEqual({
      filename: '~/Library/Messages/Attachments/aa/bb/AT-JOINED/joined.png',
      transferName: 'joined.png',
      transferState: 5,
    });
    expect(reader.attachmentFile('AT-NOPATH')?.filename).toBeNull();
    expect(reader.attachmentFile('AT-UNKNOWN')).toBeNull();
  });

  it('attachmentFileUnjoinedIsNull', () => {
    const { fixture } = fresh();
    fixture.addHandle('+15550100001');
    fixture.addChat({ identifier: '+15550100001' });
    // An attachment row no message joins: chat.db keeps these around
    // (purged messages), and a guid that reaches no message is not served.
    fixture.db
      .prepare(
        `INSERT INTO attachment (guid, filename, transfer_name)
         VALUES ('AT-ORPHAN', '~/Library/Messages/Attachments/zz/orphan.png', 'orphan.png')`,
      )
      .run();
    const reader = readerOver(fixture);
    expect(reader.attachmentFile('AT-ORPHAN')).toBeNull();
  });

  it('attachmentFile binds the id as a parameter: SQL in the id finds nothing', () => {
    const { fixture } = fresh();
    const h = fixture.addHandle('+15550100001');
    const chatId = fixture.addChat({ identifier: '+15550100001' });
    fixture.addAttachmentOnly({ chatId, handleId: h, attachmentGuid: 'AT-1' });
    const reader = readerOver(fixture);
    expect(reader.attachmentFile("x' OR '1'='1")).toBeNull();
  });

  it('findOutboundFileMatchesTransferName', async () => {
    const { fixture } = fresh();
    const h = fixture.addHandle('+15550100001');
    const chatId = fixture.addChat({ identifier: '+15550100001' });
    const other = fixture.addChat({ identifier: '+15550100002' });
    const chatGuid = chatGuidOf(fixture, chatId);
    const since = '2026-09-01T12:00:00.000Z';
    // Decoys: the same name inbound, the same name too early, the same name
    // in another chat, and another name outbound in the window.
    fixture.addAttachmentOnly({
      chatId,
      handleId: h,
      transferName: 'grey.png',
      at: '2026-09-01T12:01:00.000Z',
    });
    fixture.appendOutboundFile({
      chatGuid,
      transferName: 'grey.png',
      atIso: '2026-09-01T11:59:00.000Z',
    });
    fixture.appendOutboundFile({
      chatGuid: chatGuidOf(fixture, other),
      transferName: 'grey.png',
      atIso: '2026-09-01T12:02:00.000Z',
    });
    fixture.appendOutboundFile({
      chatGuid,
      transferName: 'other.png',
      atIso: '2026-09-01T12:03:00.000Z',
    });
    const reader = readerOver(fixture);
    expect(
      await reader.findOutboundFile({
        chatGuid,
        transferName: 'grey.png',
        sinceIso: since,
      }),
    ).toBeNull();

    const sent = fixture.appendOutboundFile({
      chatGuid,
      transferName: 'grey.png',
      atIso: '2026-09-01T12:04:00.000Z',
    });
    expect(
      await reader.findOutboundFile({
        chatGuid,
        transferName: 'grey.png',
        sinceIso: since,
      }),
    ).toEqual({ guid: sent.guid });
  });

  it('pageSqlStillNeverNamesFilename', () => {
    // The page statements read ids now, and still never the path column.
    expect(CHAT_PAGE_STATEMENTS.files).toMatch(/a\.guid\s+AS id/);
    for (const [name, sql] of Object.entries(CHAT_PAGE_STATEMENTS)) {
      expect(sql, name).not.toMatch(/filename/i);
    }
  });
});
