/**
 * s5-execution Scenario 11 (extended by s8 Sc3) — `wemessage watch`
 * renderers for the events that are not readable as raw JSON at a terminal.
 *
 * `draft.delta` is a STREAMING preview: chunks arrive one at a time and mean
 * nothing individually, so the renderer accumulates them per request and
 * hands back the whole preview so far, marked `inPlace` — the caller
 * overwrites one line at a terminal rather than printing a page of
 * increasingly-long prefixes. Nothing here is persisted; a preview may
 * legitimately evaporate without a draft ever existing (F-44).
 *
 * Every other event returns `null` and stays NDJSON, which is what `--json`
 * emits for all of them, unchanged (§3.8).
 */
import type { GatewayEventPayload } from '@wemessage/client';

export interface WatchLine {
  text: string;
  /** True when the line supersedes the previous one at a terminal. */
  inPlace: boolean;
}

/** How much of a streaming preview fits on one line before eliding. */
const PREVIEW_MAX = 72;

/** Trailing segment of a chat guid: `iMessage;-;+1555…` → `+1555…`. */
function chatLabel(chatGuid: string): string {
  return chatGuid.split(';').at(-1) ?? chatGuid;
}

function elide(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Stateful by necessity (the accumulator), constructed per `watch` run so
 * two runs never share a buffer.
 */
export function createWatchRenderer(): (
  event: GatewayEventPayload,
) => WatchLine | null {
  const previews = new Map<string, string>();
  return (event) => {
    if (event.event === 'draft.delta') {
      // Keyed by requestId, not chat: two agents may be drafting into the
      // same conversation, and interleaving their text would be worse than
      // useless.
      const key = event.correlation.requestId;
      const text = (previews.get(key) ?? '') + event.textDelta;
      previews.set(key, text);
      return {
        text: `preview ${chatLabel(event.correlation.chatGuid)}: ${elide(text, PREVIEW_MAX)}`,
        inPlace: true,
      };
    }
    if (event.event === 'adapter.health') {
      return {
        text: `adapter ${event.adapterId}: ${event.status}`,
        inPlace: false,
      };
    }
    // s8 Sc3 — the four things that happen to a draft with nobody pressing
    // a key. Raw JSON is a poor answer for these: an operator watching a
    // queue wants to read that a card timed out, not to parse a frame for
    // it, and two of the four carry a SECOND id that is the whole point (a
    // draft that vanished and the one that replaced it). All four are
    // `inPlace: false` — a preview supersedes itself, a fact does not, and
    // overwriting "expired" with "requeued" would destroy the only copy of
    // the first one.
    if (event.event === 'draft.expired') {
      return { text: `draft ${event.draftId}: expired`, inPlace: false };
    }
    if (event.event === 'draft.requeued') {
      return { text: `draft ${event.draftId}: requeued`, inPlace: false };
    }
    if (event.event === 'draft.superseded') {
      return {
        text: `draft ${event.draftId}: superseded by ${event.byDraftId}`,
        inPlace: false,
      };
    }
    if (event.event === 'draft.redrafted') {
      return {
        text: `draft ${event.draftId}: redrafted as ${event.newDraftId}`,
        inPlace: false,
      };
    }
    return null;
  };
}

/**
 * s7 Sc5 — `--events draft.created,draft.sent`.
 *
 * A split, and NOTHING else: no trimming, no de-duplication, no check that
 * the names exist. The vocabulary is the daemon's (`GATEWAY_EVENT_NAMES`),
 * and a second copy here would go stale the first time it grew and would
 * answer a typo with a different sentence than the daemon does. So the list
 * travels verbatim, the daemon refuses what it does not recognise, and the
 * operator reads the refusal in the same words the server logged.
 *
 * `''` therefore parses to `['']`, which reaches the wire as `?events=` and
 * is refused. That is deliberate: an empty filter read HERE as "everything"
 * would hand an operator a subscription to every event they did not ask for,
 * which is the loudest possible quiet bug.
 */
export function parseEventsFlag(raw: string): string[] {
  return raw.split(',');
}
