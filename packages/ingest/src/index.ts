// @wemessage/ingest — chat.db reader, typedstream decoder, watcher, cursor.
// Typedstream decoding lands in Scenario 5; the rest of Track A is
// Scenarios 6-9.
import type { ChatDbReader } from '@wemessage/core';

export type { ChatDbReader };
export {
  decodeTypedstreamText,
  decodeSummaryInfoLatestText,
  type DecodeResult,
} from './typedstream/index.js';
