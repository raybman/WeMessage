/**
 * The conversations list's binding (v2 A1), and the first binding of the v2
 * messenger.
 *
 * One read and nothing else. The list is what `GET /v1/threads` says, in the
 * order it says it, dated by the `asOf` the daemon stamped on the page. This
 * file holds the pages it has been handed and asks for the next one when the
 * screen reaches the end of what is held; it never sorts, never merges a
 * stream into the list, and never decides which conversation moved.
 *
 * No `on`, deliberately. A list patched from the event stream is a list the
 * renderer has to re-sort, and a renderer that re-sorts is a renderer with
 * its own opinion about which conversation is newest. Leaving the mode and
 * coming back asks again: the list is a read of now, not a cache.
 *
 * Every answer crosses the bridge as `unknown` and is narrowed here, as the
 * other bindings do it. A row that is not shaped like a conversation is
 * dropped rather than drawn half-blank: that is a bug on the wire, not a
 * conversation.
 *
 * Pages can overlap. The daemon pages by the date of each chat's newest
 * message, and a message that is unsent between two page reads can move a
 * chat to a later page. The first occurrence wins, so the list never holds a
 * conversation twice and an option id is never minted for two rows.
 */
import type { ThreadSummary } from '@wemessage/client';
import type { WmBridge } from '../../preload/api.js';

/** The one request channel this list may reach. */
export const THREADS_CHANNELS = ['threads'] as const;

/**
 * The bridge, cut to the one channel. A `Pick` rather than a structural
 * copy, so a channel renamed in `ipc-channels.ts` breaks this line instead of
 * becoming a call to a channel that no longer exists.
 */
export type ThreadsBridge = Pick<WmBridge, 'threads'>;

/**
 * Where the list is.
 *
 * `unavailable` is its own state because it is the daemon's own answer (the
 * daemon is up, the token is fine, and the Messages history cannot be read
 * right now), and the words for it are not the words for a request that
 * failed outright.
 */
export type ThreadsStatus =
  'idle' | 'loading' | 'ready' | 'failed' | 'unavailable';

export interface ThreadsData {
  readonly status: ThreadsStatus;
  /** Every row held so far, in the daemon's order, no chat twice. */
  readonly rows: readonly ThreadSummary[];
  /** The daemon's count of the whole list, from the latest page. */
  readonly total: number;
  /** Where the next page starts, or `null` when the list is all held. */
  readonly nextCursor: string | null;
  /** The instant the latest page was dated with, or `''` before one. */
  readonly asOf: string;
  /** A next page is in flight. */
  readonly paging: boolean;
}

export interface ThreadsBinding {
  data(): ThreadsData;
  subscribe(listener: () => void): () => void;
  /** Drop whatever is held and ask for the first page. */
  load(): Promise<void>;
  /** Ask for the page after the last one held, if there is one. */
  more(): Promise<void>;
  /** Back to `idle`, discarding any answer still in flight. */
  reset(): void;
  settled(): Promise<void>;
}

/* ── narrowing ────────────────────────────────────────────────────────── */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  return value as Record<string, unknown>;
}

/**
 * One row, with every field the list draws, or `null`.
 *
 * The channel is checked as a STRING and not against the union: a channel
 * this renderer has never heard of is still a conversation, and the row
 * derivation draws it under `?` with its own name rather than dropping it.
 */
function threadOf(value: unknown): ThreadSummary | null {
  const row = asRecord(value);
  if (row === null) return null;
  const { chatGuid, channel, title, isGroup, lastLine, lastFromMe, lastAt } =
    row;
  if (typeof chatGuid !== 'string' || chatGuid === '') return null;
  if (typeof channel !== 'string' || channel === '') return null;
  if (typeof title !== 'string') return null;
  if (typeof isGroup !== 'boolean') return null;
  if (lastLine !== null && typeof lastLine !== 'string') return null;
  if (typeof lastFromMe !== 'boolean') return null;
  if (typeof lastAt !== 'string') return null;
  return {
    chatGuid,
    channel,
    title,
    isGroup,
    lastLine,
    lastFromMe,
    lastAt,
  } as ThreadSummary;
}

interface Page {
  readonly rows: readonly ThreadSummary[];
  readonly total: number;
  readonly nextCursor: string | null;
  readonly asOf: string;
}

type Answer =
  | { readonly kind: 'page'; readonly page: Page }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'unreadable' };

const UNREADABLE: Answer = { kind: 'unreadable' };

function answerOf(value: unknown): Answer {
  const record = asRecord(value);
  if (record === null) return UNREADABLE;
  if (record['refused'] === 'source-unavailable')
    return { kind: 'unavailable' };
  const { threads, total, nextCursor, asOf } = record;
  if (!Array.isArray(threads)) return UNREADABLE;
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0)
    return UNREADABLE;
  if (
    nextCursor !== null &&
    (typeof nextCursor !== 'string' || nextCursor === '')
  )
    return UNREADABLE;
  if (typeof asOf !== 'string') return UNREADABLE;
  const rows: ThreadSummary[] = [];
  for (const row of threads as readonly unknown[]) {
    const thread = threadOf(row);
    if (thread !== null) rows.push(thread);
  }
  return { kind: 'page', page: { rows, total, nextCursor, asOf } };
}

/** `held` then whichever of `next` it does not already hold. */
function append(
  held: readonly ThreadSummary[],
  next: readonly ThreadSummary[],
): ThreadSummary[] {
  const seen = new Set(held.map((row) => row.chatGuid));
  const out = [...held];
  for (const row of next) {
    if (seen.has(row.chatGuid)) continue;
    seen.add(row.chatGuid);
    out.push(row);
  }
  return out;
}

/* ── the binding ──────────────────────────────────────────────────────── */

const EMPTY: ThreadsData = {
  status: 'idle',
  rows: [],
  total: 0,
  nextCursor: null,
  asOf: '',
  paging: false,
};

export function bindThreads(bridge: ThreadsBridge): ThreadsBinding {
  let data: ThreadsData = EMPTY;
  /**
   * Bumped by every `load` and `reset`. An answer is applied only if the
   * generation it was asked under is still current, so leaving the mode
   * while a page is in flight cannot paint that page into the next visit.
   */
  let generation = 0;
  const listeners = new Set<() => void>();
  const inflight = new Set<Promise<unknown>>();

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function track<T>(work: Promise<T>): Promise<T> {
    const done: Promise<void> = work.then(
      () => undefined,
      () => undefined,
    );
    inflight.add(done);
    void done.then(() => inflight.delete(done));
    return work;
  }

  return {
    data: () => data,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async load() {
      generation += 1;
      const asked = generation;
      data = { ...EMPTY, status: 'loading' };
      notify();
      let answer: Answer;
      try {
        answer = answerOf(await track(bridge.threads()));
      } catch {
        answer = UNREADABLE;
      }
      if (asked !== generation) return;
      if (answer.kind === 'page')
        data = {
          status: 'ready',
          rows: append([], answer.page.rows),
          total: answer.page.total,
          nextCursor: answer.page.nextCursor,
          asOf: answer.page.asOf,
          paging: false,
        };
      else
        data = {
          ...EMPTY,
          status: answer.kind === 'unavailable' ? 'unavailable' : 'failed',
        };
      notify();
    },
    async more() {
      const cursor = data.nextCursor;
      if (data.status !== 'ready' || data.paging || cursor === null) return;
      const asked = generation;
      data = { ...data, paging: true };
      notify();
      let answer: Answer;
      try {
        answer = answerOf(await track(bridge.threads(cursor)));
      } catch {
        answer = UNREADABLE;
      }
      if (asked !== generation) return;
      // A next page that did not arrive leaves what is held exactly as it
      // was, cursor included, so the next press of End asks again. The
      // rows on screen were really there; a failed page is not evidence
      // that they went anywhere.
      data =
        answer.kind === 'page'
          ? {
              status: 'ready',
              rows: append(data.rows, answer.page.rows),
              total: answer.page.total,
              nextCursor: answer.page.nextCursor,
              asOf: answer.page.asOf,
              paging: false,
            }
          : { ...data, paging: false };
      notify();
    },
    reset() {
      generation += 1;
      data = EMPTY;
      notify();
    },
    async settled() {
      while (inflight.size > 0) await Promise.all([...inflight]);
    },
  };
}
