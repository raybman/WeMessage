/**
 * s3-execution Scenario 10 (part 2) — pure-function coverage for
 * `disconnect --purge`'s phrase-matching and TTY-gating logic (src/purge.ts).
 * The interactive TTY-prompt path itself is exercised instead, at the
 * subprocess level, by packages/daemon/test/send-connect-cli.spec.ts's two
 * scriptable edges (non-TTY refusal, `--yes-really-purge` bypass) — see
 * that file's header for why the "type the phrase at a real terminal" path
 * cannot be driven from any automated test in this repo.
 */
import { describe, expect, it } from 'vitest';
import {
  confirmPurge,
  matchesPurgePhrase,
  PURGE_PHRASE,
} from '../src/purge.js';

describe('matchesPurgePhrase', () => {
  it('matches the exact phrase', () => {
    expect(matchesPurgePhrase('delete my data')).toBe(true);
  });

  it('trims surrounding whitespace (readline newline, stray spaces)', () => {
    expect(matchesPurgePhrase('  delete my data\n')).toBe(true);
  });

  it('rejects anything else, including a near-miss', () => {
    expect(matchesPurgePhrase('delete my Data')).toBe(false);
    expect(matchesPurgePhrase('yes')).toBe(false);
    expect(matchesPurgePhrase('')).toBe(false);
  });

  it('PURGE_PHRASE is the exact string the function matches against', () => {
    expect(matchesPurgePhrase(PURGE_PHRASE)).toBe(true);
  });
});

describe('confirmPurge', () => {
  it('refuses immediately on non-TTY stdin without ever asking', async () => {
    let asked = false;
    const confirmed = await confirmPurge({
      isTTY: false,
      ask: async () => {
        asked = true;
        return PURGE_PHRASE;
      },
    });
    expect(confirmed).toBe(false);
    expect(asked).toBe(false);
  });

  it('on a TTY, asks and confirms only on the exact phrase', async () => {
    const confirmed = await confirmPurge({
      isTTY: true,
      ask: async () => 'delete my data',
    });
    expect(confirmed).toBe(true);
  });

  it('on a TTY, refuses a wrong answer', async () => {
    const confirmed = await confirmPurge({
      isTTY: true,
      ask: async () => 'nope',
    });
    expect(confirmed).toBe(false);
  });
});
