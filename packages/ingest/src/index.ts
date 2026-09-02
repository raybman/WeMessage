// @wemessage/ingest — chat.db reader, typedstream decoder, watcher, cursor.
// Typedstream: Scenario 5. Reader + normalizer: Scenario 7. Cursor/watch:
// Scenarios 8-10.
import type { ChatDbReader } from '@wemessage/core';

export type { ChatDbReader };
export {
  decodeTypedstreamText,
  decodeSummaryInfoLatestText,
  type DecodeResult,
} from './typedstream/index.js';
export {
  appleNsToIso,
  mapService,
  normalizeRow,
  type DecodeFailedSignal,
  type NormalizedRow,
  type RawMessageRow,
} from './normalize/index.js';
export {
  createChatDbReader,
  type ChatDbReaderOptions,
  type IngestChatDbReader,
} from './chatdb/index.js';
