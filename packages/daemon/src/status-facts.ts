/**
 * v2 F7: the facts `GET /v1/status` carries beyond connection state, and the
 * cache that keeps reading them cheap while the app re-reads status every
 * few seconds.
 *
 *  - `imessage()`: lastSyncAt (the cursor's lastScanAt), today (sent since
 *    local midnight in the daemon's zone) and the operator's own handle.
 *    today is a covering-index range count and is taken on every call, so it
 *    turns over at midnight with no read in between. The handle is
 *    memoised for `handleEveryMs` (60 s), held in memory only, and is null
 *    whenever the chat.db reader is closed: a disconnected gateway is not
 *    reading the Messages database, so it does not say whose it is.
 *  - `mirror()`: the local copy's size and counts. They are recounted only
 *    when the cursor's ROWID or the search index's through-mark has moved,
 *    and then at most once per `recountEveryMs` (5 s). A quiet Mac re-reads
 *    status forever on one count.
 *
 * Nothing here writes. The handle never leaves this module except as the
 * status payload's field: no store row, audit event, broadcast or log.
 */
import { existsSync, statSync } from 'node:fs';
import { sep } from 'node:path';
import type { Autonomy, Clock, IsoUtc, Store } from '@wemessage/core';
import {
  dayStartInZone,
  SETTING_KILL_SWITCH,
  SETTING_SEARCH_INDEXED_THROUGH,
} from '@wemessage/core';
import { resolveArming } from './arming.js';
import { channelStatuses, type ImessageLive } from './channels.js';
import { readConnectionState } from './doctor.js';

export interface MirrorStatus {
  /** `~`-abbreviated; never the absolute home path. */
  path: string;
  /** wemessage.db plus its WAL, in bytes. */
  bytes: number;
  messages: number;
  chats: number;
  /** The oldest sent time copied; null when nothing is. */
  historyFrom: IsoUtc | null;
  phase: 'empty' | 'indexing' | 'current';
  indexed: number;
  eligible: number;
  /** When the counts above were taken (daemon clock). */
  countedAt: IsoUtc;
}

export interface StatusFactsDeps {
  store: Pick<
    Store,
    | 'getCursor'
    | 'countSentSince'
    | 'mirrorCounts'
    | 'searchCoverage'
    | 'getSetting'
  >;
  clock: Clock;
  /** IANA zone "today" is counted in. */
  zone: string;
  /** The mirror path as the wire carries it (see `tildePath`). */
  displayPath: string;
  /** wemessage.db plus WAL bytes, read on each recount. */
  statBytes: () => number;
  /** The newest sent iMessage row's destination_caller_id, or null. */
  ownHandle: () => string | null;
  /**
   * Whether the chat.db reader is open. Closed means the handle is null now,
   * whatever the memo held. Defaults to open.
   */
  readerOpen?: () => boolean;
  recountEveryMs?: number;
  handleEveryMs?: number;
}

export interface StatusFacts {
  imessage(): ImessageLive;
  mirror(): MirrorStatus;
  /** How many mirror recounts have run (the cache's witness). */
  recounts(): number;
}

export const STATUS_RECOUNT_EVERY_MS = 5_000;
export const STATUS_HANDLE_EVERY_MS = 60_000;

/**
 * `path` under `home` with the home prefix written `~`. A path outside home
 * is not the operator's to abbreviate, so only its file name is said.
 */
export function tildePath(path: string, home: string): string {
  const root = home.endsWith(sep) ? home.slice(0, -1) : home;
  if (root.length > 0 && path.startsWith(root + sep)) {
    return `~/${path
      .slice(root.length + 1)
      .split(sep)
      .join('/')}`;
  }
  const parts = path.split(sep);
  return parts[parts.length - 1] ?? path;
}

/** wemessage.db plus its WAL sibling, in bytes; a missing file counts 0. */
export function dbBytes(dbPath: string): number {
  const size = (p: string): number => (existsSync(p) ? statSync(p).size : 0);
  return size(dbPath) + size(`${dbPath}-wal`);
}

export function createStatusFacts(d: StatusFactsDeps): StatusFacts {
  const recountEveryMs = d.recountEveryMs ?? STATUS_RECOUNT_EVERY_MS;
  const handleEveryMs = d.handleEveryMs ?? STATUS_HANDLE_EVERY_MS;
  let counted: { key: string; atMs: number; mirror: MirrorStatus } | null =
    null;
  let recounts = 0;
  let handleMemo: { atMs: number; handle: string | null } | null = null;

  const markKey = (): string =>
    `${String(d.store.getCursor()?.lastRowid ?? -1)}:${d.store.getSetting(SETTING_SEARCH_INDEXED_THROUGH) ?? '-'}`;

  const handle = (): string | null => {
    if (d.readerOpen !== undefined && !d.readerOpen()) {
      handleMemo = null;
      return null;
    }
    const nowMs = d.clock.nowMs();
    if (handleMemo !== null && nowMs - handleMemo.atMs < handleEveryMs) {
      return handleMemo.handle;
    }
    let value: string | null;
    try {
      value = d.ownHandle();
    } catch {
      // An unreadable chat.db says nothing about whose it is, and a failed
      // read is not remembered: the next status asks again.
      return null;
    }
    handleMemo = { atMs: nowMs, handle: value };
    return value;
  };

  return {
    imessage() {
      const now = d.clock.now();
      const since = dayStartInZone(new Date(now), d.zone).toISOString();
      return {
        lastSyncAt: d.store.getCursor()?.lastScanAt ?? null,
        today: d.store.countSentSince(since),
        handle: handle(),
      };
    },
    mirror() {
      const key = markKey();
      const nowMs = d.clock.nowMs();
      if (
        counted !== null &&
        (counted.key === key || nowMs - counted.atMs < recountEveryMs)
      ) {
        return counted.mirror;
      }
      const counts = d.store.mirrorCounts();
      const coverage = d.store.searchCoverage();
      const phase: MirrorStatus['phase'] =
        counts.messages === 0
          ? 'empty'
          : coverage.indexed < coverage.eligible
            ? 'indexing'
            : 'current';
      const mirror: MirrorStatus = {
        path: d.displayPath,
        bytes: d.statBytes(),
        messages: counts.messages,
        chats: counts.chats,
        historyFrom: counts.historyFrom,
        phase,
        indexed: coverage.indexed,
        eligible: coverage.eligible,
        countedAt: d.clock.now(),
      };
      recounts += 1;
      counted = { key, atMs: nowMs, mirror };
      return mirror;
    },
    recounts: () => recounts,
  };
}

export interface ComposeStatusDeps {
  store: Store;
  clock: Clock;
  autonomy: Autonomy;
  facts: StatusFacts;
}

/**
 * The composed daemon's status payload. One function so the daemon and the
 * contract recorder cannot drift: the golden is this shape, not a copy of it.
 */
export function composeStatus(d: ComposeStatusDeps): Record<string, unknown> {
  const live = d.facts.imessage();
  return {
    // s3 Scenario 7: probe-derived, persisted state.
    connectionState: readConnectionState(d.store),
    cursor: d.store.getCursor(),
    // F7: the same number the iMessage entry's `today` carries, for the CLI.
    counts: { messagesToday: live.today },
    // s5 Sc14: `AdapterRecord` carries `hasToken` and no hash of any kind
    // (F-43), so the status payload cannot leak credential material.
    adapters: d.store.listAdapters(),
    // s6 Scenario 11: derived at request time from the rows the gate reads.
    killSwitch: d.store.getSetting(SETTING_KILL_SWITCH) === '1',
    armed: resolveArming({
      store: d.store,
      clock: d.clock,
      autonomy: d.autonomy,
    }),
    // v2 B0 + F7: the channels this version reads, iMessage with its facts.
    channels: channelStatuses(live),
    asOf: d.clock.now(),
    mirror: d.facts.mirror(),
  };
}
