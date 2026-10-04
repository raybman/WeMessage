// Split out of dispatcher.ts in s10 Slice 2 so late-verify.ts can share it
// without a dispatcher <-> late-verify import cycle. Re-exported from
// dispatcher.ts, so the public surface is unchanged.
import type { ChatGuid, Handle, Service } from '../domain/types.js';

/**
 * Apple 1:1 chat guids are "service;-;handle" (the only format any fixture
 * uses); group guids ("service;+;roomName") carry no single counterparty
 * handle at all. Used to (a) populate GateContext.message ahead of the gate
 * call and (b) short-circuit group sends before wasting a resolveChat call
 * (S3 ships no group-send path).
 */
export function parseChatGuid(chatGuid: ChatGuid): {
  handle: Handle;
  service: Service;
  isGroup: boolean;
} {
  const ONE_ON_ONE_SEP = ';-;';
  const prefix = chatGuid.split(';')[0]?.toLowerCase();
  const service: Service =
    prefix === 'imessage' ? 'imessage' : prefix === 'sms' ? 'sms' : 'unknown';
  const idx = chatGuid.indexOf(ONE_ON_ONE_SEP);
  if (idx === -1) {
    return { handle: '', service, isGroup: true };
  }
  return {
    handle: chatGuid.slice(idx + ONE_ON_ONE_SEP.length),
    service,
    isGroup: false,
  };
}
