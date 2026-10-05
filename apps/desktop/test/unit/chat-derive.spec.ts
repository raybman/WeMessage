/**
 * v2 A1: the renderer's chat-guid reader, pinned to the client's.
 *
 * `derive/chat.ts` is a copy of `parseChatGuid` from `@wemessage/client`,
 * and the copy is forced: the client package imports `ws` and `node:fs`, so
 * it lives in the main process and cannot be bundled into a sandboxed
 * renderer. Two copies of one parser drift unless something holds them side
 * by side, and the file's own doc said this was that something long before
 * it existed. This is the file it names now.
 *
 * Two rows, one per half of the contract:
 *
 *  - **Where the client answers, the renderer answers the same thing.**
 *    Field for field, on every guid shape the product has met, including
 *    macOS 26's `any;` prefix. Since v2 A1 the client accepts `any;` and
 *    names no service for it (`'unknown'`), because Messages writes every
 *    new chat that way and a conversations list that threw on them would
 *    be empty on a current Mac.
 *  - **Where the client refuses, the renderer still paints.** The client
 *    throws for a prefix it cannot name; the renderer answers `'unknown'`,
 *    because it is painting a row the daemon already accepted and an
 *    exception mid-render blanks a window over one string.
 *
 * Synthetic handles only (`+1555…`, example.com), as everywhere in this
 * PUBLIC repo.
 */
import { describe, expect, it } from 'vitest';
import { parseChatGuid } from '@wemessage/client';
import { chatParts } from '../../src/renderer/derive/chat.js';

const ACCEPTED = [
  'iMessage;-;+15550000001',
  'SMS;-;+15550000002',
  'iMessage;+;chat123',
  'SMS;+;chat456',
  'imessage;-;friend@example.com',
  'any;-;+15550000005',
  'any;+;chat789',
  'ANY;-;+15550000006',
  // The FIRST separator ends the prefix: a handle may contain anything.
  'iMessage;-;a;-;b',
] as const;

const REFUSED = [
  '',
  'garbage',
  'whatsapp;-;+15550000003',
  ';-;x',
  'anything;-;x',
] as const;

describe('chatParts and the client parser (v2 A1)', () => {
  it('agree field for field wherever the client answers, any; included', () => {
    for (const guid of ACCEPTED) {
      expect(chatParts(guid), guid).toEqual(parseChatGuid(guid));
    }
  });

  it('names no service where the client refuses, instead of throwing', () => {
    for (const guid of REFUSED) {
      expect(() => parseChatGuid(guid), guid).toThrow(/chat guid/i);
      expect(chatParts(guid).service, guid).toBe('unknown');
    }
  });

  it('reads any; as a room or a person the same way it reads iMessage;', () => {
    expect(chatParts('any;+;chat789')).toEqual({
      handle: '',
      service: 'unknown',
      isGroup: true,
    });
    expect(chatParts('any;-;+15550000005')).toEqual({
      handle: '+15550000005',
      service: 'unknown',
      isGroup: false,
    });
  });
});
