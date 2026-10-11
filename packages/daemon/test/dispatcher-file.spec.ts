/**
 * v2 F6e: a file draft end to end through the daemon. Real store, real
 * outbox under a temp folder, the real ingest reader over a fixture
 * chat.db, and the loopback backend, whose `sendFile` lands an outbound
 * attachment-only row with the transfer name it was given. No osascript is
 * spawned and nothing reads ~/Library/Messages: every byte is generated.
 *
 * What these rows prove: the file is verified by the transfer name of the
 * row Messages writes, never by body text (a file draft's body is empty),
 * and a file that lands late is found by the retry route's late verify and
 * never sent twice.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { syntheticPng } from '@wemessage/fixtures';
import { SETTING_SEND_ATTACHMENTS } from '@wemessage/daemon';
import {
  auditEvents,
  boot,
  cleanupHarness,
  CHAT,
  post,
  type Harness,
} from './helpers/draft-harness.js';

afterEach(async () => {
  await cleanupHarness();
});

async function on(): Promise<Harness> {
  const h = await boot({ outbox: true, send: true });
  h.store.setSetting(SETTING_SEND_ATTACHMENTS, '1');
  return h;
}

async function stage(h: Harness, bytes: Buffer, name: string) {
  const r = await h.server.app.inject({
    method: 'POST',
    url: '/v1/attachments/staged',
    headers: {
      ...h.headers,
      'content-type': 'image/png',
      'x-wemessage-name': name,
    },
    payload: bytes,
  });
  expect(r.statusCode).toBe(200);
  return r.json() as { stageId: string };
}

async function sendFile(h: Harness, stageId: string) {
  const r = await post(h, '/v1/send', { chatGuid: CHAT, file: stageId });
  expect(r.statusCode).toBe(200);
  return r.json() as {
    draftId: string;
    outcome: string;
    sentMessageGuid?: string;
    error?: { code: string };
  };
}

describe('v2 F6e: file send through the daemon', () => {
  it('fileSendVerifiesByTransferName', async () => {
    const h = await on();
    const { stageId } = await stage(h, syntheticPng(8, 8), 'grey.png');
    const sent = await sendFile(h, stageId);
    expect(sent.outcome).toBe('sent');

    // One file call, the outbox path and the staged name; no text call.
    expect(h.backend.fileCalls()).toHaveLength(1);
    const call = h.backend.fileCalls()[0]!;
    expect(call.file.name).toBe('grey.png');
    expect(call.file.path.endsWith(`/outbox/${stageId}/grey.png`)).toBe(true);
    expect(h.backend.calls()).toEqual([]);

    // The guid recorded is the guid of the attachment row Messages wrote.
    const draft = h.store.getDraft(sent.draftId);
    expect(draft?.state).toBe('sent');
    expect(draft?.sentMessageGuid).toBe(h.backend.lastFileGuid());
    expect(sent.sentMessageGuid).toBe(h.backend.lastFileGuid());
    const types = auditEvents(h.store)
      .filter((e) => 'draftId' in e && e.draftId === sent.draftId)
      .map((e) => e.type);
    expect(types).toContain('send.attempted');
    expect(types).toContain('draft.sent');
  });

  it('a file whose row never lands is unverified, even with a text row in the chat', async () => {
    const h = await on();
    const { stageId } = await stage(h, syntheticPng(6, 6), 'grey.png');
    h.backend.sabotageFiles();
    // A text row lands in the same chat after the send started. An empty
    // body text match would take it; a transfer-name match cannot.
    h.fixture.appendOutbound({
      chatGuid: CHAT,
      text: '',
      atIso: h.clockCtl.clock.now(),
    });
    const sent = await sendFile(h, stageId);
    expect(sent.outcome).toBe('failed');
    expect(sent.error?.code).toBe('unverified');
    expect(h.store.getDraft(sent.draftId)?.state).toBe('failed');
    expect(h.backend.fileCalls()).toHaveLength(1);
  });

  it('a file that lands late is found by the retry, never sent twice', async () => {
    const h = await on();
    const { stageId } = await stage(h, syntheticPng(5, 5), 'late.png');
    h.backend.sabotageFiles();
    const sent = await sendFile(h, stageId);
    expect(sent.error?.code).toBe('unverified');

    // Messages writes the attachment row after the verify budget ran out.
    const late = h.fixture.appendOutboundFile({
      chatGuid: CHAT,
      transferName: 'late.png',
      atIso: h.clockCtl.clock.now(),
    });
    const retry = await post(h, `/v1/drafts/${sent.draftId}/retry`);
    expect(retry.statusCode).toBe(409);
    expect(retry.json()).toEqual({
      error: 'already-sent',
      from: 'sent',
      sentMessageGuid: late.guid,
    });
    expect(h.backend.fileCalls()).toHaveLength(1);
  });
});
