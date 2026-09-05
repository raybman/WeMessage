/**
 * s8-execution Scenario 3 (CLI half) — `wemessage watch` learns the four
 * draft-lifecycle events.
 *
 * Location follows the deviation every CLI slice since S2 has taken and
 * cli-s5.spec.ts / cli-s7.spec.ts document at length: rows that are pure
 * functions of a payload live here, in the package that owns the function;
 * rows that need a real daemon on a real socket live under
 * packages/daemon/test. `createWatchRenderer` is a pure function of an
 * event, so this is the whole surface.
 *
 * PLAN DEVIATION worth stating: s8-execution's row 9 asks for these to be
 * asserted "through the existing watch transcript harness". There is no such
 * harness. `watch` renders through `createWatchRenderer()` and prints in
 * `bin.ts`, which no test may import (it calls `program.parseAsync` as a
 * module side effect), so the renderer's unit rows in cli-s5.spec.ts are the
 * established surface for exactly this and these rows join them.
 *
 * The load-bearing property: **a lifecycle line is a record, not a
 * preview.** `draft.delta` is `inPlace: true` because a streaming preview
 * supersedes itself — the operator wants the latest text, not every prefix.
 * Every event here is a fact that HAPPENED to a specific draft, and a
 * terminal that overwrote "expired" with "requeued" would be destroying the
 * only copy of the first one. So all four are `inPlace: false`, and that is
 * asserted per event rather than once.
 *
 * The second property is that the two LINKED events name their partner. A
 * supersede and a redraft each mention two draft ids, under two different
 * words (`byDraftId`, `newDraftId`), and a line that printed only the
 * subject would tell an operator their draft vanished and not where it
 * went. Both ids appear, in a fixed order, with the direction spelled out.
 *
 * Ids are synthetic ULIDs; no handles appear at all.
 */
import { describe, expect, it } from 'vitest';
import type { GatewayEventPayload } from '@wemessage/client';
import { createWatchRenderer } from '../src/watch.js';

/** Same fence every CLI renderer row carries: colour is the caller's job. */
const ANSI_RE = /\x1b\[/;

const OLD = '01AAA0000000000000000000';
const NEW = '01BBB0000000000000000000';

/** One event through a fresh renderer — none of these four are stateful. */
const render = (
  event: GatewayEventPayload,
): ReturnType<ReturnType<typeof createWatchRenderer>> =>
  createWatchRenderer()(event);

describe('s8 Sc3 CLI: watch renders the four draft-lifecycle events', () => {
  it('draft.expired names the draft and the thing that happened to it', () => {
    const line = render({ event: 'draft.expired', draftId: OLD });
    expect(line?.text).toBe(`draft ${OLD}: expired`);
  });

  it('draft.requeued names the draft and the thing that happened to it', () => {
    const line = render({ event: 'draft.requeued', draftId: OLD });
    expect(line?.text).toBe(`draft ${OLD}: requeued`);
  });

  it('draft.superseded names the draft that replaced it', () => {
    const line = render({
      event: 'draft.superseded',
      draftId: OLD,
      byDraftId: NEW,
    });
    // Subject first, then the replacement. An operator reading a scrollback
    // has to be able to follow the chain in one direction without guessing
    // which of two ULIDs is the survivor.
    expect(line?.text).toBe(`draft ${OLD}: superseded by ${NEW}`);
  });

  it('draft.redrafted names the draft that was written in its place', () => {
    const line = render({
      event: 'draft.redrafted',
      draftId: OLD,
      newDraftId: NEW,
    });
    expect(line?.text).toBe(`draft ${OLD}: redrafted as ${NEW}`);
  });

  it('renders all four as records, never in place', () => {
    // `draft.delta` is `inPlace: true` because a preview supersedes itself.
    // These do not: overwriting "expired" with "requeued" at a terminal
    // would delete the only copy of the first fact. One assertion per
    // event, because the mistake is per-branch.
    const events: GatewayEventPayload[] = [
      { event: 'draft.expired', draftId: OLD },
      { event: 'draft.superseded', draftId: OLD, byDraftId: NEW },
      { event: 'draft.redrafted', draftId: OLD, newDraftId: NEW },
      { event: 'draft.requeued', draftId: OLD },
    ];
    for (const event of events) {
      const line = render(event);
      expect(line, event.event).not.toBeNull();
      expect(line?.inPlace, event.event).toBe(false);
      expect(line?.text, event.event).not.toMatch(ANSI_RE);
    }
  });

  it('shares one renderer across a whole lifecycle without leaking state', () => {
    // The renderer is stateful for `draft.delta` alone (the preview
    // accumulator, keyed by requestId). A lifecycle line that accumulated
    // would print the previous event's text again.
    const one = createWatchRenderer();
    const lines = [
      one({ event: 'draft.redrafted', draftId: OLD, newDraftId: NEW }),
      one({ event: 'draft.expired', draftId: NEW }),
      one({ event: 'draft.requeued', draftId: NEW }),
    ].map((line) => line?.text);
    expect(lines).toEqual([
      `draft ${OLD}: redrafted as ${NEW}`,
      `draft ${NEW}: expired`,
      `draft ${NEW}: requeued`,
    ]);
  });

  it('still returns null for events that stay NDJSON (§3.8)', () => {
    // The four new branches must not become a catch-all. `draft.rejected`
    // is the near miss: same family, same `draftId`, deliberately NOT
    // rendered, because `--json` is the surface for the bulk verbs.
    const other = createWatchRenderer();
    expect(
      other({
        event: 'draft.rejected',
        draftId: OLD,
        actor: { kind: 'human', via: 'cli' },
      }),
    ).toBeNull();
    expect(other({ event: 'message.unsent', guid: 'p:0/abc' })).toBeNull();
  });
});
