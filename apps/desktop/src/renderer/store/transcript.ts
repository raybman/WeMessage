/**
 * The transcript's binding (v2 A2): one conversation, read a page at a time.
 *
 * One read channel and nothing else. What is held is what
 * `GET /v1/threads/:guid/messages` said, in the order it said it, and the
 * three ways of asking are the three things the pane can do:
 *
 *  - `open` and `jump` replace what is held with ONE page: the newest, or
 *    the newest at or before an instant.
 *  - `older` puts the page before the oldest one held in front of it, by
 *    the opaque cursor that page carried, verbatim.
 *  - `refresh` re-reads the head and lays it over what is held
 *    (`mergeHead`). Never an append from an event: an inbound frame says
 *    that something arrived, the daemon says what.
 *
 * No `on`, deliberately, for the list's reason and one more. The edge that
 * calls `refresh` is seen by the composition root, which already holds the
 * one event subscription (through the optimistic store); a second
 * subscriber here would be a second opinion about which conversation an
 * event belongs to.
 *
 * Every answer crosses the bridge as `unknown` and is narrowed here. A turn
 * that is not shaped like a turn is dropped rather than drawn half-blank.
 */
import type { ThreadTurn } from '@wemessage/client';
import type { WmBridge } from '../../preload/api.js';
import { mergeHead, prependOlder } from '../derive/transcript.js';

/** The one request channel the transcript may reach. */
export const TRANSCRIPT_CHANNELS = ['transcript'] as const;

/** The bridge, cut to the one channel, by `Pick` for the list's reason. */
export type TranscriptBridge = Pick<WmBridge, 'transcript'>;

/**
 * Where the transcript is. `unavailable` and `unknown-chat` are each the
 * daemon's own answer, and the words for them are not the words for a
 * request that did not come back.
 */
export type TranscriptStatus =
  'idle' | 'loading' | 'ready' | 'failed' | 'unavailable' | 'unknown-chat';

export interface TranscriptData {
  readonly status: TranscriptStatus;
  /** The conversation held, or `null` when none is open. */
  readonly chatGuid: string | null;
  /** Every turn held, oldest first, no guid twice. */
  readonly turns: readonly ThreadTurn[];
  /** The cursor to the page before the oldest held, or `null` at the start. */
  readonly nextBefore: string | null;
  /** The instant the newest page held was read at, or `''`. */
  readonly asOf: string;
  /** An older page is in flight. */
  readonly paging: boolean;
  /** Whether the newest page held is the head (not a jump into the past). */
  readonly atHead: boolean;
  /** The `until` of the jump on screen, or `null`. */
  readonly jumpedTo: string | null;
  /**
   * Bumped each time a refreshed head shared nothing with what was held and
   * replaced it, so the caller can say so. Monotonic within one open.
   */
  readonly seams: number;
}

export interface TranscriptBinding {
  data(): TranscriptData;
  subscribe(listener: () => void): () => void;
  /** Hold `chatGuid`'s newest page and nothing else. */
  open(chatGuid: string): Promise<void>;
  /** Put the page before the oldest held in front of it, if there is one. */
  older(): Promise<void>;
  /** Hold the newest page at or before `until` and nothing else. */
  jump(until: string): Promise<void>;
  /** Re-read the head and lay it over what is held. Only at the head. */
  refresh(): Promise<void>;
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

const KINDS = new Set(['text', 'attachment-only', 'audio']);

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function turnOf(value: unknown): ThreadTurn | null {
  const row = asRecord(value);
  if (row === null) return null;
  const {
    guid,
    from,
    kind,
    text,
    at,
    handle,
    editedAt,
    unsentAt,
    attachments,
  } = row;
  if (typeof guid !== 'string' || guid === '') return null;
  if (from !== 'me' && from !== 'them') return null;
  if (typeof kind !== 'string' || !KINDS.has(kind)) return null;
  if (text !== null && typeof text !== 'string') return null;
  if (typeof at !== 'string') return null;
  if (!optionalString(handle)) return null;
  if (!optionalString(editedAt) || !optionalString(unsentAt)) return null;
  if (
    typeof attachments !== 'number' ||
    !Number.isSafeInteger(attachments) ||
    attachments < 0
  )
    return null;
  return {
    guid,
    from,
    kind,
    text,
    at,
    attachments,
    ...(handle !== undefined ? { handle } : {}),
    ...(editedAt !== undefined ? { editedAt } : {}),
    ...(unsentAt !== undefined ? { unsentAt } : {}),
  } as ThreadTurn;
}

interface Page {
  readonly turns: readonly ThreadTurn[];
  readonly nextBefore: string | null;
  readonly asOf: string;
}

type Answer =
  | { readonly kind: 'page'; readonly page: Page }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'unknown-chat' }
  | { readonly kind: 'unreadable' };

const UNREADABLE: Answer = { kind: 'unreadable' };

function answerOf(value: unknown, chatGuid: string): Answer {
  const record = asRecord(value);
  if (record === null) return UNREADABLE;
  if (record['refused'] === 'source-unavailable')
    return { kind: 'unavailable' };
  if (record['refused'] === 'unknown-chat') return { kind: 'unknown-chat' };
  const { turns, nextBefore, asOf } = record;
  // A page for some other conversation is not a page of this one.
  if (record['chatGuid'] !== chatGuid) return UNREADABLE;
  if (!Array.isArray(turns)) return UNREADABLE;
  if (
    nextBefore !== null &&
    (typeof nextBefore !== 'string' || nextBefore === '')
  )
    return UNREADABLE;
  if (typeof asOf !== 'string') return UNREADABLE;
  const out: ThreadTurn[] = [];
  const seen = new Set<string>();
  for (const raw of turns as readonly unknown[]) {
    const turn = turnOf(raw);
    if (turn === null || seen.has(turn.guid)) continue;
    seen.add(turn.guid);
    out.push(turn);
  }
  return { kind: 'page', page: { turns: out, nextBefore, asOf } };
}

/* ── the binding ──────────────────────────────────────────────────────── */

const EMPTY: TranscriptData = {
  status: 'idle',
  chatGuid: null,
  turns: [],
  nextBefore: null,
  asOf: '',
  paging: false,
  atHead: false,
  jumpedTo: null,
  seams: 0,
};

export function bindTranscript(bridge: TranscriptBridge): TranscriptBinding {
  let data: TranscriptData = EMPTY;
  /**
   * Bumped by every `open`, `jump` and `reset`. An answer is applied only
   * if the generation it was asked under is still current, so closing a
   * conversation while a page is in flight cannot paint that page into the
   * next one opened.
   */
  let generation = 0;
  let refreshing = false;
  let refreshAgain = false;
  const listeners = new Set<() => void>();
  const inflight = new Set<Promise<unknown>>();

  function notify(): void {
    for (const listener of listeners) listener();
  }

  async function ask(
    chatGuid: string,
    at?: { before: string } | { until: string },
  ): Promise<Answer> {
    const work =
      at === undefined
        ? bridge.transcript(chatGuid)
        : bridge.transcript(chatGuid, at);
    const done: Promise<void> = work.then(
      () => undefined,
      () => undefined,
    );
    inflight.add(done);
    void done.then(() => inflight.delete(done));
    try {
      return answerOf(await work, chatGuid);
    } catch {
      return UNREADABLE;
    }
  }

  /** `open` and `jump`: one page replaces whatever is held. */
  async function replace(chatGuid: string, until: string | null) {
    generation += 1;
    const asked = generation;
    data = {
      ...EMPTY,
      status: 'loading',
      chatGuid,
      jumpedTo: until,
      seams: data.chatGuid === chatGuid ? data.seams : 0,
    };
    notify();
    const answer = await ask(chatGuid, until === null ? undefined : { until });
    if (asked !== generation) return;
    data =
      answer.kind === 'page'
        ? {
            ...data,
            status: 'ready',
            turns: answer.page.turns,
            nextBefore: answer.page.nextBefore,
            asOf: answer.page.asOf,
            atHead: until === null,
          }
        : {
            ...data,
            status: answer.kind === 'unreadable' ? 'failed' : answer.kind,
          };
    notify();
  }

  const binding: TranscriptBinding = {
    data: () => data,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open: (chatGuid) => replace(chatGuid, null),
    jump(until) {
      const chatGuid = data.chatGuid;
      if (chatGuid === null) return Promise.resolve();
      return replace(chatGuid, until);
    },
    async older() {
      const { chatGuid, nextBefore: cursor } = data;
      if (
        data.status !== 'ready' ||
        data.paging ||
        chatGuid === null ||
        cursor === null
      )
        return;
      const asked = generation;
      data = { ...data, paging: true };
      notify();
      const answer = await ask(chatGuid, { before: cursor });
      if (asked !== generation) return;
      // An older page that did not arrive leaves what is held as it was,
      // cursor included, so the next PageUp asks again.
      data =
        answer.kind === 'page'
          ? {
              ...data,
              turns: prependOlder(data.turns, answer.page.turns),
              nextBefore: answer.page.nextBefore,
              paging: false,
            }
          : { ...data, paging: false };
      notify();
    },
    async refresh() {
      const chatGuid = data.chatGuid;
      if (data.status !== 'ready' || !data.atHead || chatGuid === null) return;
      if (refreshing) {
        refreshAgain = true;
        return;
      }
      refreshing = true;
      const asked = generation;
      try {
        const answer = await ask(chatGuid);
        if (asked !== generation || answer.kind !== 'page') return;
        const merged = mergeHead(data.turns, answer.page.turns);
        data = {
          ...data,
          turns: merged.turns,
          asOf: answer.page.asOf,
          // A head that replaced what was held starts the walk back again
          // from its own cursor; the old one points behind a hole.
          nextBefore: merged.continuous
            ? data.nextBefore
            : answer.page.nextBefore,
          seams: merged.continuous ? data.seams : data.seams + 1,
        };
        notify();
      } finally {
        refreshing = false;
        if (refreshAgain && asked === generation) {
          refreshAgain = false;
          await binding.refresh();
        } else refreshAgain = false;
      }
    },
    reset() {
      generation += 1;
      refreshAgain = false;
      data = EMPTY;
      notify();
    },
    async settled() {
      while (inflight.size > 0) await Promise.all([...inflight]);
    },
  };
  return binding;
}
