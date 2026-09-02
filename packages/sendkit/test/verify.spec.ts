/**
 * s3-execution.md Part 2 Scenario 4 — Post-send verification: `verifySend`.
 *
 * `verifySend` polls `ChatDbReader.findOutboundMessage` on a 250ms-doubling
 * backoff capped to a 10s total budget. It never sees the send backend's
 * `accepted` flag (§2.2.2 pinned: the signature can't even express "trust
 * the exit code") — the ONLY signal is a real row appearing in chat.db.
 *
 * Fake `delay` doubles as the stepping clock's driver: each simulated wait
 * both records the requested ms (for the exact-schedule assertion) and
 * advances the fake `Clock.nowMs()` by that same amount, so the function's
 * own budget bookkeeping (elapsed = clock.nowMs() - start) is exercised for
 * real, not just its poll-count.
 */
import { describe, expect, it } from 'vitest';
import type { ChatDbReader, Clock } from '@wemessage/core';
import { verifySend } from '@wemessage/sendkit';

function fakeStepper(): {
  clock: Clock;
  delay: (ms: number) => Promise<void>;
  delays: number[];
} {
  let ms = 0;
  const clock: Clock = {
    now: () => new Date(ms).toISOString(),
    nowMs: () => ms,
  };
  const delays: number[] = [];
  const delay = (requested: number): Promise<void> => {
    delays.push(requested);
    ms += requested;
    return Promise.resolve();
  };
  return { clock, delay, delays };
}

const SEND_STARTED_AT = '2026-01-05T12:00:00.000Z';

describe('verifySend (Scenario 4)', () => {
  it('a row appearing on the 3rd poll verifies, with delays following 250ms-doubling', async () => {
    const { clock, delay, delays } = fakeStepper();
    let calls = 0;
    const reader: Pick<ChatDbReader, 'findOutboundMessage'> = {
      findOutboundMessage: () => {
        calls += 1;
        if (calls === 3) return Promise.resolve({ guid: 'MSG-3' });
        return Promise.resolve(null);
      },
    };

    const result = await verifySend(reader, clock, delay, {
      chatGuid: 'iMessage;-;+15551234567',
      body: 'confirmed for 3pm',
      sendStartedAt: SEND_STARTED_AT,
    });

    expect(result).toEqual({ verified: true, guid: 'MSG-3' });
    expect(calls).toBe(3);
    expect(delays).toEqual([250, 500]);
  });

  it('no row within the 10s budget gives up, with an exact capped-backoff schedule summing to 10s', async () => {
    const { clock, delay, delays } = fakeStepper();
    let calls = 0;
    const reader: Pick<ChatDbReader, 'findOutboundMessage'> = {
      findOutboundMessage: () => {
        calls += 1;
        return Promise.resolve(null);
      },
    };

    const result = await verifySend(reader, clock, delay, {
      chatGuid: 'iMessage;-;+15551234567',
      body: 'confirmed for 3pm',
      sendStartedAt: SEND_STARTED_AT,
    });

    expect(result).toEqual({ verified: false });
    expect(calls).toBe(7);
    expect(delays).toEqual([250, 500, 1000, 2000, 4000, 2250]);
    expect(delays.reduce((a, b) => a + b, 0)).toBe(10_000);
  });
});
