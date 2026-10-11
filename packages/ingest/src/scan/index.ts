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
import { isoToAppleNs, type DecodeFailedSignal } from '../normalize/index.js';

/** settings key for the mutation-sweep ns watermark (S2 Scenario 8). */
export const MUTATION_WATERMARK_KEY = 'ingest.mutationWatermarkNs';

/**
 * v2 F8a: settings key for the newest SENT time the ROWID pass has seen
 * (Apple-epoch ns, decimal string). The sweep window anchors on the earlier
 * of this and the previous scan time, so a chat.db whose newest message is
 * behind the wall clock (a restored backup, skew, a test fixture) still has
 * its recent edits swept. Anchoring on the earlier of the two only ever
 * WIDENS the window.
 */
export const NEWEST_SENT_KEY = 'ingest.newestSentNs';

const BUSY_BACKOFF_START_MS = 50;
const BUSY_BACKOFF_CAP_MS = 2000;
const DEFAULT_MAX_BUSY_RETRIES = 10;

/**
 * v2 F8a: how far before the PREVIOUS scan the steady-state mutation sweep
 * looks for sent messages. Messages allows edits for 15 minutes and unsends
 * for 2; seven days covers late delivery, clock skew and a sleeping Mac with
 * room to spare, and still turns a whole-table walk into an index range.
 */
const MUTATION_SENT_WINDOW_NS = 7n * 24n * 3600n * 1_000_000_000n;

/** Let queued I/O (HTTP requests, timers) run between heavy burst steps. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

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
  /**
   * v2 F8b: read at most this many rows per burst. Unset keeps the original
   * read-everything burst. A first run against a real history was one
   * unbounded read of the whole table (minutes, ~1.8 GB) before the daemon
   * could listen; paged, each burst is bounded and `hasBacklog()` tells the
   * caller to come back for the next page.
   */
  pageSize?: number;
}

export interface ScanLoop {
  /** One scan burst: emits and returns the newly-seen messages. */
  scanOnce(): Promise<Message[]>;
  /**
   * v2 F8b: true when the last burst filled its page, so rows may remain
   * past the cursor. Always false without `pageSize`.
   */
  hasBacklog(): boolean;
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
  const pageSize = options.pageSize;
  let backlog = false;

  async function burst(): Promise<Message[]> {
    const previous = options.store.getCursor();
    const lastRowid = previous?.lastRowid ?? 0;
    const readerOptions: ChatDbReaderOptions = {
      clock: options.clock,
      ...(options.onDecodeFailed !== undefined
        ? { onDecodeFailed: options.onDecodeFailed }
        : {}),
    };
    const reader = openReader(options.chatDbPath, readerOptions);
    try {
      const rows =
        pageSize === undefined
          ? await reader.readSince(lastRowid)
          : await reader.readSince(lastRowid, pageSize);
      const full = pageSize !== undefined && rows.length >= pageSize;
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

      // v2 F8a: track the newest sent time seen, then derive the window.
      const storedNewest = options.store.getSetting(NEWEST_SENT_KEY);
      let newestSentNs = storedNewest !== null ? BigInt(storedNewest) : null;
      const before = newestSentNs;
      for (const message of rows) {
        const ns = isoToAppleNs(message.sentAt);
        if (newestSentNs === null || ns > newestSentNs) newestSentNs = ns;
      }
      if (newestSentNs !== null && newestSentNs !== before) {
        options.store.setSetting(NEWEST_SENT_KEY, newestSentNs.toString());
      }
      // No cursor means a first run, which sweeps the whole table once.
      let sentAfterNs: string | undefined;
      if (previous !== null) {
        let anchor = isoToAppleNs(previous.lastScanAt);
        if (newestSentNs !== null && newestSentNs < anchor) {
          anchor = newestSentNs;
        }
        sentAfterNs = (anchor - MUTATION_SENT_WINDOW_NS).toString();
      }

      // v2 F8b: a first run that is paging through history reads every row
      // in its CURRENT, already-mutated state, so mutations made before now
      // are not news. Start the mutation watermark at now; without this the
      // first sweep after the catch-up re-delivers every historical edit.
      if (
        full &&
        previous === null &&
        options.store.getSetting(MUTATION_WATERMARK_KEY) === null
      ) {
        options.store.setSetting(
          MUTATION_WATERMARK_KEY,
          isoToAppleNs(options.clock.now()).toString(),
        );
      }
      backlog = full;

      // Step 2 (Scenario 8): mutation sweep. Same burst, same reader, same
      // busy/backoff envelope as the ROWID pass above. v2 F8b: skipped while
      // a paged catch-up is behind; a row not yet read must not surface as
      // a mutation before it surfaces as a message.
      if (options.onMutation !== undefined && !full) {
        await yieldToEventLoop();
        const sinceNs = options.store.getSetting(MUTATION_WATERMARK_KEY) ?? '0';
        const sinceNsBig = BigInt(sinceNs);
        const mutated = await reader.readMutatedSince(sinceNs, sentAfterNs);
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
    hasBacklog: () => backlog,
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
