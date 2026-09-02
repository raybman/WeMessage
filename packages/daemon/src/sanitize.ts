/**
 * Event-boundary sanitizer (§2.4.5, §3.4): inbound content is DATA, never
 * instructions. The wire shape wraps text in `content: { untrusted: true }`
 * with control characters stripped — from day one, at the single point where
 * domain Messages become wire events.
 */
import type { Message } from '@wemessage/core';
import type { SanitizedInbound } from '@wemessage/protocol';

/**
 * Strip control characters (§2.4.5): C0 except \n and \t, DEL, and C1.
 * Newlines/tabs survive because they are ordinary message formatting.
 */
export function stripControlChars(text: string): string {
  return text.replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g,
    '',
  );
}

/** Domain Message -> §3.4 `SanitizedInbound` wire shape. */
export function sanitizeInbound(message: Message): SanitizedInbound {
  return {
    guid: message.guid,
    chatGuid: message.chatGuid,
    handle: message.handle,
    isGroup: message.isGroup,
    service: message.service,
    receivedAt: message.receivedAt,
    content: {
      untrusted: true,
      text: message.text === null ? null : stripControlChars(message.text),
      attachments: message.attachments.map((a) => ({
        mimeType: a.mimeType,
        bytes: a.bytes,
      })),
    },
  };
}
