/**
 * Cursor scan loop (Scenario 8; plan §1.3.8 "Dedup on restart", §2.2.1).
 *
 * Incremental, deduped, resumable: each burst opens a FRESH reader (§2.2.1
 * re-open per scan burst), reads rows past the persisted cursor, guid-dedups
 * against the §2.3 inbound_messages mirror, emits + mirrors the new ones, and
 * advances the cursor to the max ROWID seen. On SQLITE_BUSY the burst backs
 * off exponentially 50ms -> 2s and retries; it never writes to chat.db and
 * never holds a long transaction.
 */
import type { Clock, Message, Store } from '@wemessage/core';
import {
  createChatDbReader,
  type ChatDbReaderOptions,
  type IngestChatDbReader,
} from '../chatdb/index.js';
import type { DecodeFailedSignal } from '../normalize/index.js';

/** settings key for the mutation-sweep ns watermark (S2 Scenario 8). */
export const MUTATION_WATERMARK_KEY = 'ingest.mutationWatermarkNs';

const BUSY_BACKOFF_START_MS = 50;
const BUSY_BACKOFF_CAP_MS = 2000;
const DEFAULT_MAX_BUSY_RETRIES = 10;

export interface ScanLoopOptions {
  chatDbPath: string;
  store: Store;
  clock: Clock;
  onMessage: (message: Message) => void;
  /**
   * In-place mutation sink (S2 Scenario 8): edits/unsends of already-scanned
   * rows, which the ROWID cursor can never see. When absent the mutation
   * sweep is skipped entirely.
   */
  onMutation?: (message: Message) => void;
  /** §2.2.1 degrade signal sink (persisted to audit since S2 Scenario 9). */
  onDecodeFailed?: (signal: DecodeFailedSignal) => void;
  /** Injectable for tests; defaults to a real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable reader factory for tests (busy injection, open counting). */
  openReader?: (
    path: string,
    options: ChatDbReaderOptions,
  ) => IngestChatDbReader;
  maxBusyRetries?: number;
}

export interface ScanLoop {
  /** One scan burst: emits and returns the newly-seen messages. */
  scanOnce(): Promise<Message[]>;
}

function isBusyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: string }).code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT';
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createScanLoop(options: ScanLoopOptions): ScanLoop {
  const sleep = options.sleep ?? defaultSleep;
  const openReader = options.openReader ?? createChatDbReader;
  const maxBusyRetries = options.maxBusyRetries ?? DEFAULT_MAX_BUSY_RETRIES;

  async function burst(): Promise<Message[]> {
    const lastRowid = options.store.getCursor()?.lastRowid ?? 0;
    const readerOptions: ChatDbReaderOptions = {
      clock: options.clock,
      ...(options.onDecodeFailed !== undefined
        ? { onDecodeFailed: options.onDecodeFailed }
        : {}),
    };
    const reader = openReader(options.chatDbPath, readerOptions);
    try {
      const rows = await reader.readSince(lastRowid);
      const emitted: Message[] = [];
      const justEmitted = new Set<string>();
      let maxRowid = lastRowid;
      for (const message of rows) {
        if (message.sourceRowid > maxRowid) maxRowid = message.sourceRowid;
        // §1.3.8 dedup: re-scanned rows (rewound cursor / restart window)
        // must not double-process.
        if (options.store.hasInboundMessage(message.guid)) continue;
        options.store.insertInboundMessage(message);
        options.onMessage(message);
        emitted.push(message);
        justEmitted.add(message.guid);
      }
      options.store.setCursor({
        lastRowid: maxRowid,
        lastScanAt: options.clock.now(),
      });

      // Step 2 (Scenario 8): mutation sweep. Same burst, same reader, same
      // busy/backoff envelope as the ROWID pass above.
      if (options.onMutation !== undefined) {
        const sinceNs = options.store.getSetting(MUTATION_WATERMARK_KEY) ?? '0';
        const sinceNsBig = BigInt(sinceNs);
        const mutated = await reader.readMutatedSince(sinceNs);
        let maxNs = sinceNsBig;
        for (const { message, mutationNs } of mutated) {
          // Rows that arrived ALREADY mutated were just delivered (post-
          // mutation state) by the ROWID pass — emitting here would double.
          if (!justEmitted.has(message.guid)) {
            // At-least-once ordering: emit, refresh the mirror, and only
            // AFTER the whole sweep advance the watermark. A crash anywhere
            // in between re-delivers on restart; advancing the watermark
            // first would silently drop the mutation forever.
            options.onMutation(message);
            options.store.updateInboundMessage(message);
          }
          const ns = BigInt(mutationNs);
          if (ns > maxNs) maxNs = ns;
        }
        if (maxNs > sinceNsBig) {
          // Decimal string, never Number(): real Apple-epoch ns exceed 2^53.
          options.store.setSetting(MUTATION_WATERMARK_KEY, maxNs.toString());
        }
      }
      return emitted;
    } finally {
      // Re-open per scan burst (§2.2.1): never hold the handle across bursts.
      reader.close();
    }
  }

  return {
    async scanOnce(): Promise<Message[]> {
      for (let attempt = 0; ; attempt++) {
        try {
          return await burst();
        } catch (err) {
          if (!isBusyError(err) || attempt >= maxBusyRetries) throw err;
          const delay = Math.min(
            BUSY_BACKOFF_START_MS * 2 ** attempt,
            BUSY_BACKOFF_CAP_MS,
          );
          await sleep(delay);
        }
      }
    },
  };
}
