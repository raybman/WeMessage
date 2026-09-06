/**
 * The adapters table and the danger zone's count — the two projections on
 * the settings screen that are about ADAPTERS rather than about settings.
 *
 * Pure, like every file in this directory: an argument in, strings out, no
 * clock, no bridge and no state. What is worth arguing here is what these
 * rows deliberately do NOT carry.
 *
 *  - **No credential, in any shape.** `AdapterPayload.hasToken` is a
 *    boolean because the daemon mints a token once and never reads it back:
 *    there is no route that returns stored token material. So the column is
 *    `SET` or `NONE`, and there is nothing here for a reveal to reveal.
 *  - **No connect command.** The daemon builds one as `--token <plaintext>`
 *    and argv is world-readable through `ps`. It does not reach this
 *    projection, it does not reach the screen, and an arch row asserts the
 *    whole desktop app names it in exactly one file — the main process.
 *  - **No age.** `lastSeenAt` is on the payload and is not drawn: an age is
 *    a clock read, this directory is banned from reading one, and a
 *    "last seen 3m ago" that froze at the moment the screen loaded would be
 *    worse than the health word it sits next to.
 *
 * The count is the danger zone's only claim about consequences, and both of
 * its numbers come from the daemon: the adapters it holds credentials for
 * and the drafts still waiting on somebody. A sentence about "your data"
 * with no number in it is the shape this exists to refuse.
 */
import type { AdapterPayload } from '@wemessage/client';
import { HEALTH_GLYPH } from './state.js';

/**
 * The one kind whose product is determinism rather than a model.
 *
 * Marked because an operator looking at a list of agents should be able to
 * tell at a glance which of them is the test fixture — and because rotating
 * the credential of a loopback fixture is a different decision from
 * rotating the credential of the thing actually answering their guests.
 */
const DEV_KIND = 'echo';

/** Health words the daemon can produce; anything else reads as unknown. */
const HEALTH_WORD: Readonly<Record<string, string>> = {
  connected: 'CONNECTED',
  unknown: 'UNKNOWN',
  disconnected: 'DISCONNECTED',
  unhealthy: 'UNHEALTHY',
};

export interface AdapterRow {
  readonly id: string;
  readonly name: string;
  /** The daemon's own word, as data. Never the sole carrier of state. */
  readonly health: string;
  readonly glyph: string;
  readonly word: string;
  /** `SET` or `NONE`. A boolean is the whole read surface there is. */
  readonly token: string;
  readonly dev: boolean;
  readonly note: string;
}

/**
 * Every adapter the daemon answered with, in the order it answered.
 *
 * No sort: `GET /v1/adapters` orders by id and re-ordering here would put
 * this screen's opinion in front of the daemon's, for a list whose row
 * identity is what the operator is about to act on.
 */
export function adapterRows(adapters: readonly AdapterPayload[]): AdapterRow[] {
  return adapters.map((adapter) => {
    const dev = adapter.kind === DEV_KIND;
    return {
      id: adapter.id,
      name: adapter.displayName === '' ? adapter.id : adapter.displayName,
      health: adapter.health,
      glyph: HEALTH_GLYPH[adapter.health] ?? HEALTH_GLYPH['unknown'] ?? '◌',
      word: HEALTH_WORD[adapter.health] ?? 'UNKNOWN',
      token: adapter.hasToken ? 'SET' : 'NONE',
      dev,
      note: dev
        ? `${adapter.kind.toUpperCase()} DEV LOOPBACK · PREFIXES THE INBOUND TEXT AND PROPOSES IT · NEVER SENDS`
        : `${adapter.kind.toUpperCase()} · PROPOSES DRAFTS · NEVER SENDS, ONLY THE DAEMON DOES AND ONLY AFTER A PERSON SAYS SO`,
    };
  });
}

/**
 * What a disconnect costs, in the daemon's own numbers.
 *
 * Both counts are rendered even at zero and even at one. Sc12's
 * `TN-bulk-auto-silently` is the precedent from the other direction: a
 * confirmation that skips itself when it thinks the work is trivial is a
 * confirmation that is not there when the count is wrong.
 */
export function dangerCounts(adapters: number, waiting: number): string {
  return `REVOKES ${String(adapters)} ADAPTER TOKEN(S) · ABANDONS ${String(waiting)} PENDING DRAFT(S)`;
}
