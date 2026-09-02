/**
 * Normalizer: raw chat.db rows -> §3.2 `Message` (Scenario 7; plan §1.3.8).
 *
 * Pure value-in/value-out: no I/O, no Date.now (Clock injected). Every §1.3.8
 * inbound kind is enumerated here; undecodable attributedBody degrades to
 * text:null + kind:'attachment-only' with a decode-failed signal surfaced to
 * the caller (§2.2.1 — audit persistence of the signal is S2).
 */
import type { AttachmentRef, Clock, Message, Service } from '@wemessage/core';
import {
  decodeSummaryInfoLatestText,
  decodeTypedstreamText,
} from '../typedstream/index.js';

/** RD §1: Apple epoch offset (2001-01-01T00:00:00Z) in Unix milliseconds. */
const APPLE_EPOCH_UNIX_MS = 978307200000;

/** Apple-epoch nanoseconds (chat.db `date` columns) -> ISO-8601 UTC. */
export function appleNsToIso(ns: bigint): string {
  return new Date(Number(ns / 1_000_000n) + APPLE_EPOCH_UNIX_MS).toISOString();
}

/**
 * ISO-8601 UTC -> Apple-epoch nanoseconds (inverse of {@link appleNsToIso}).
 * Scenario 4's `findOutboundMessage` binds `sinceIso` against chat.db's
 * `message.date` column, which is Apple-epoch ns, not Unix ms.
 */
export function isoToAppleNs(iso: string): bigint {
  return BigInt(Date.parse(iso) - APPLE_EPOCH_UNIX_MS) * 1_000_000n;
}

/** §2.2.1 degrade signal; persisted to audit since S2 Scenario 9. */
export interface DecodeFailedSignal {
  guid: string;
  sourceRowid: number;
  reason: string;
}

/** One joined chat.db row, DB flavor already erased (bigints for dates). */
export interface RawMessageRow {
  rowid: number;
  guid: string;
  text: string | null;
  attributedBody: Uint8Array | null;
  date: bigint;
  dateEdited: bigint;
  dateRetracted: bigint;
  isFromMe: boolean;
  isAudioMessage: boolean;
  service: string | null;
  associatedMessageGuid: string | null;
  associatedMessageType: number;
  threadOriginatorGuid: string | null;
  messageSummaryInfo: Uint8Array | null;
  cacheHasAttachments: boolean;
  chatGuid: string;
  chatStyle: number;
  chatIdentifier: string;
  handle: string | null;
  attachments: AttachmentRef[];
}

export interface NormalizedRow {
  message: Message;
  decodeFailed?: DecodeFailedSignal;
}

/** §1.3.8 "SMS vs iMessage vs RCS": service column preserved, else unknown. */
export function mapService(raw: string | null): Service {
  switch (raw?.toLowerCase()) {
    case 'imessage':
      return 'imessage';
    case 'sms':
      return 'sms';
    case 'rcs':
      return 'rcs';
    default:
      return 'unknown';
  }
}

/** Tapback targets are stored as `p:<part>/<guid>` (or `bp:<guid>`). */
function tapbackTargetGuid(associated: string): string {
  return associated.replace(/^(?:bp:|p:\d+\/)/, '');
}

const GROUP_CHAT_STYLE = 43;

export function normalizeRow(
  row: RawMessageRow,
  deps: { clock: Clock },
): NormalizedRow {
  let decodeFailed: DecodeFailedSignal | undefined;

  // Body: text column when present, attributedBody typedstream when NULL
  // (the Ventura case, §2.2.1). Decode failure degrades, never throws.
  let text: string | null = row.text;
  if (text === null && row.attributedBody !== null) {
    const decoded = decodeTypedstreamText(row.attributedBody);
    if (decoded.ok) {
      text = decoded.text;
    } else {
      decodeFailed = {
        guid: row.guid,
        sourceRowid: row.rowid,
        reason: decoded.error.message,
      };
    }
  }

  let kind: Message['kind'];
  let tapback: Message['tapback'];
  let editedAt: string | undefined;

  if (row.associatedMessageGuid !== null && row.associatedMessageType !== 0) {
    // §1.3.8 tapbacks: never rule-matched; the matching exclusion is S2, the
    // kind is its ground truth.
    kind = 'tapback';
    tapback = {
      targetGuid: tapbackTargetGuid(row.associatedMessageGuid),
      type: row.associatedMessageType,
    };
  } else if (row.dateRetracted > 0n) {
    kind = 'unsend';
    text = null;
  } else if (row.dateEdited > 0n) {
    kind = 'edit';
    editedAt = appleNsToIso(row.dateEdited);
    // The summary-info payload is authoritative for the post-edit body: its
    // latest revision wins over the text column when it decodes (§1.3.8).
    if (row.messageSummaryInfo !== null) {
      const latest = decodeSummaryInfoLatestText(row.messageSummaryInfo);
      if (latest.ok) text = latest.text;
    }
  } else if (row.isAudioMessage) {
    kind = 'audio';
  } else if (text !== null) {
    kind = 'text';
  } else {
    // No decodable body: attachment-only, which also covers the §2.2.1
    // undecodable-attributedBody degrade path.
    kind = 'attachment-only';
  }

  const message: Message = {
    guid: row.guid,
    sourceRowid: row.rowid,
    chatGuid: row.chatGuid,
    handle: row.handle ?? row.chatIdentifier,
    isFromMe: row.isFromMe,
    isGroup: row.chatStyle === GROUP_CHAT_STYLE,
    service: mapService(row.service),
    kind,
    text,
    attachments: row.attachments,
    sentAt: appleNsToIso(row.date),
    receivedAt: deps.clock.now(),
    ...(editedAt !== undefined ? { editedAt } : {}),
    ...(tapback !== undefined ? { tapback } : {}),
    ...(row.threadOriginatorGuid !== null
      ? { threadOriginatorGuid: row.threadOriginatorGuid }
      : {}),
  };

  return decodeFailed !== undefined ? { message, decodeFailed } : { message };
}
