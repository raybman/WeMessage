/**
 * s5-execution Scenario 11 — `wemessage watch` renderers for the two S5
 * events that are not readable as raw JSON at a terminal.
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
    return null;
  };
}
