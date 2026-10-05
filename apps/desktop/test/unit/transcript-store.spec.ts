/**
 * v2 A2: the transcript binding, against a scripted bridge.
 *
 * What it asks for, and what it does with the answer: one page replaces
 * what is held on open and on a jump, an older page goes in front by the
 * cursor verbatim, and a refreshed head is laid over what is held, never
 * appended from an event. Synthetic guids only.
 */
import { describe, expect, it } from 'vitest';
import type { ThreadTurn } from '@wemessage/client';
import {
  bindTranscript,
  type TranscriptBridge,
} from '../../src/renderer/store/transcript.js';

const CHAT = 'any;-;+15550000201';
const AS_OF = '2026-09-04T23:42:00.000Z';

function turn(n: number): ThreadTurn {
  return {
    guid: `G-${String(n)}`,
    from: n % 2 === 0 ? 'me' : 'them',
    kind: 'text',
    text: `line ${String(n)}`,
    at: AS_OF,
    attachments: 0,
  };
}
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => turn(from + i));

function page(turns: ThreadTurn[], nextBefore: string | null, chatGuid = CHAT) {
  return { chatGuid, channel: 'imessage', turns, nextBefore, asOf: AS_OF };
}

/** A bridge that answers from a queue and records every call. */
function scripted(...answers: unknown[]) {
  const calls: unknown[][] = [];
  const bridge: TranscriptBridge = {
    transcript: (...args: readonly unknown[]) => {
      calls.push([...args]);
      const next = answers.shift();
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(next);
    },
  };
  return { bridge, calls };
}
const guids = (turns: readonly ThreadTurn[]) => turns.map((t) => t.guid);

describe('bindTranscript (v2 A2)', () => {
  it('open holds the newest page, at the head, asked with the guid alone', async () => {
    const { bridge, calls } = scripted(page(range(51, 100), 'c.50'));
    const t = bindTranscript(bridge);
    const opening = t.open(CHAT);
    expect(t.data().status).toBe('loading');
    await opening;
    expect(calls).toEqual([[CHAT]]);
    expect(t.data()).toMatchObject({
      status: 'ready',
      chatGuid: CHAT,
      nextBefore: 'c.50',
      atHead: true,
      jumpedTo: null,
    });
    expect(t.data().turns).toHaveLength(50);
  });

  it('older carries the cursor verbatim and puts the page in front', async () => {
    const { bridge, calls } = scripted(
      page(range(51, 100), 'c.50'),
      page(range(1, 50), null),
    );
    const t = bindTranscript(bridge);
    await t.open(CHAT);
    await t.older();
    expect(calls[1]).toEqual([CHAT, { before: 'c.50' }]);
    expect(guids(t.data().turns)).toEqual(guids(range(1, 100)));
    expect(t.data().nextBefore).toBeNull();
    await t.older(); // nothing older: no request
    expect(calls).toHaveLength(2);
  });

  it('jump asks with until and nothing else, and is not the head', async () => {
    const until = '2026-03-15T06:59:59.999Z';
    const { bridge, calls } = scripted(
      page(range(51, 100), 'c.50'),
      page(range(10, 20), 'c.9'),
    );
    const t = bindTranscript(bridge);
    await t.open(CHAT);
    await t.jump(until);
    expect(calls[1]).toEqual([CHAT, { until }]);
    expect(t.data()).toMatchObject({ atHead: false, jumpedTo: until });
    expect(guids(t.data().turns)).toEqual(guids(range(10, 20)));
    await t.refresh(); // not at the head: no request
    expect(calls).toHaveLength(2);
  });

  it('refresh lays an overlapping head over what is held', async () => {
    const { bridge } = scripted(
      page(range(51, 100), 'c.50'),
      page(range(54, 103), 'c.53'),
    );
    const t = bindTranscript(bridge);
    await t.open(CHAT);
    await t.refresh();
    expect(guids(t.data().turns)).toEqual(guids(range(51, 103)));
    // The walk back still starts behind the oldest HELD turn.
    expect(t.data().nextBefore).toBe('c.50');
    expect(t.data().seams).toBe(0);
  });

  it('refresh replaces, drops the old cursor and counts a seam when nothing overlaps', async () => {
    const { bridge } = scripted(
      page(range(51, 100), 'c.50'),
      page(range(151, 200), 'c.150'),
    );
    const t = bindTranscript(bridge);
    await t.open(CHAT);
    await t.refresh();
    expect(guids(t.data().turns)).toEqual(guids(range(151, 200)));
    expect(t.data().nextBefore).toBe('c.150');
    expect(t.data().seams).toBe(1);
  });

  it('says which refusal it got, each in its own status', async () => {
    const a = bindTranscript(scripted({ refused: 'unknown-chat' }).bridge);
    await a.open(CHAT);
    expect(a.data().status).toBe('unknown-chat');
    const b = bindTranscript(
      scripted({ refused: 'source-unavailable' }).bridge,
    );
    await b.open(CHAT);
    expect(b.data().status).toBe('unavailable');
    const c = bindTranscript(scripted(new Error('boom')).bridge);
    await c.open(CHAT);
    expect(c.data().status).toBe('failed');
  });

  it('refuses a page that belongs to some other conversation', async () => {
    const t = bindTranscript(
      scripted(page(range(1, 3), null, 'any;-;+15550000999')).bridge,
    );
    await t.open(CHAT);
    expect(t.data().status).toBe('failed');
  });

  it('drops a malformed turn and a repeated guid rather than drawing them', async () => {
    const t = bindTranscript(
      scripted(page([turn(1), { guid: 'x' } as never, turn(1), turn(2)], null))
        .bridge,
    );
    await t.open(CHAT);
    expect(guids(t.data().turns)).toEqual(['G-1', 'G-2']);
  });

  it('a reset while a page is in flight never paints that page', async () => {
    let release: (value: unknown) => void = () => undefined;
    const bridge: TranscriptBridge = {
      transcript: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    };
    const t = bindTranscript(bridge);
    const opening = t.open(CHAT);
    t.reset();
    release(page(range(1, 3), null));
    await opening;
    expect(t.data()).toMatchObject({ status: 'idle', chatGuid: null });
  });
});
