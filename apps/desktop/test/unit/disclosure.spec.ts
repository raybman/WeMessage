import { describe, expect, it } from 'vitest';

import {
  APPROVAL_LINE,
  LEAVES_THIS_MAC,
} from '../../src/renderer/derive/disclosure.js';

/**
 * s10 Slice 6: the Welcome step's two promises, as data.
 *
 * The list is the product's privacy claim in the operator's own words, so
 * these rows pin the parts a well-meaning edit would sand off: the agent
 * row (the one place message text does leave), and the closing "Nothing
 * else" row that makes the list total.
 */
describe('s10 Sl6: Welcome disclosure', () => {
  it('states the approval promise in one sentence', () => {
    expect(APPROVAL_LINE).toBe('You approve every message.');
  });

  it('names exactly three rows: the approved send, the agent, and nothing else', () => {
    expect(LEAVES_THIS_MAC.map((r) => r.what)).toEqual([
      'A message you approved',
      'An incoming message a rule sends to an agent',
      'Nothing else',
    ]);
  });

  it('owns up to the agent: a connected cloud model sees the text', () => {
    const agent = LEAVES_THIS_MAC[1];
    expect(agent?.where).toMatch(/agent you connected/);
    expect(agent?.where).toMatch(/cloud model/);
  });

  it('never claims that no message content leaves this Mac', () => {
    for (const row of LEAVES_THIS_MAC) {
      expect(`${row.what} ${row.where}`).not.toMatch(
        /no message (content|text)/i,
      );
    }
  });

  it('carries no em dash', () => {
    const all = [
      APPROVAL_LINE,
      ...LEAVES_THIS_MAC.flatMap((r) => [r.what, r.where]),
    ];
    for (const line of all) expect(line.includes('\u2014')).toBe(false);
  });
});
