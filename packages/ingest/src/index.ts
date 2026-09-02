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
  type ChatDbOpenMode,
  type ChatDbReaderOptions,
  type IngestChatDbReader,
} from './chatdb/index.js';
export {
  createScanLoop,
  type ScanLoop,
  type ScanLoopOptions,
} from './scan/index.js';
export {
  createClockSkewWakeSignal,
  createNodeFsWatcher,
  createWatchTrigger,
  type ClockSkewWakeSignal,
  type ClockSkewWakeSignalOptions,
  type WakeSignal,
  type WatchTrigger,
  type WatchTriggerOptions,
} from './watch/index.js';
