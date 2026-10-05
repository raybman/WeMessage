/**
 * v2 A1: the conversations list's keymap, without a DOM.
 *
 * The e2e proves the strokes reach a window; this proves the two decisions
 * the keymap makes before they do. Which chord opens the list (⇧⌘R and
 * nothing that merely resembles it), and which strokes the focused list
 * claims (navigation, and only navigation). A claimed stroke is a stroke
 * the list calls `preventDefault` on, so every wrong "yes" below would be a
 * key the operator's menu bar or system never saw.
 */
import { describe, expect, it } from 'vitest';
import { PAGE, type KeyStroke } from '../../src/renderer/keys/index.js';
import {
  isThreadsChord,
  threadsMoveTo,
  threadsVerbOf,
  type ChordStroke,
  type ThreadsVerb,
} from '../../src/renderer/keys/threads.js';

function stroke(key: string, mods: Partial<KeyStroke> = {}): KeyStroke {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  };
}

function chord(code: string, mods: Partial<ChordStroke> = {}): ChordStroke {
  return {
    code,
    metaKey: true,
    shiftKey: true,
    ctrlKey: false,
    altKey: false,
    ...mods,
  };
}

describe('v2 A1: the chord that opens the conversations list', () => {
  it('is ⇧⌘R, by physical key', () => {
    expect(isThreadsChord(chord('KeyR'))).toBe(true);
  });

  it('refuses every near-miss', () => {
    // ⌘R without shift is a reload on most platforms and is not ours.
    expect(isThreadsChord(chord('KeyR', { shiftKey: false }))).toBe(false);
    // ⇧R without ⌘ is a capital letter somebody is typing.
    expect(isThreadsChord(chord('KeyR', { metaKey: false }))).toBe(false);
    // ⌃ or ⌥ on top is a different chord, whose meaning this app cannot see.
    expect(isThreadsChord(chord('KeyR', { ctrlKey: true }))).toBe(false);
    expect(isThreadsChord(chord('KeyR', { altKey: true }))).toBe(false);
    // Another key under the same modifiers.
    expect(isThreadsChord(chord('KeyT'))).toBe(false);
    expect(isThreadsChord(chord('Digit1'))).toBe(false);
  });
});

describe('v2 A1: the strokes the focused list claims', () => {
  const TABLE: ReadonlyArray<readonly [string, ThreadsVerb]> = [
    ['j', 'next'],
    ['ArrowDown', 'next'],
    ['k', 'previous'],
    ['ArrowUp', 'previous'],
    ['g', 'first'],
    ['Home', 'first'],
    ['G', 'last'],
    ['End', 'last'],
    ['PageDown', 'page-down'],
    ['PageUp', 'page-up'],
  ];

  it('claims the queue’s navigation vocabulary, and nothing else', () => {
    for (const [key, verb] of TABLE)
      expect(threadsVerbOf(stroke(key)), key).toBe(verb);
  });

  it('keeps G reachable: shift alone is not a disqualifier', () => {
    expect(threadsVerbOf(stroke('G', { shiftKey: true }))).toBe('last');
  });

  it('leaves Enter, Escape and Space alone: A1 opens nothing and expands nothing', () => {
    for (const key of [
      'Enter',
      'Escape',
      ' ',
      'Space',
      'a',
      'r',
      'e',
      'x',
      'z',
    ])
      expect(threadsVerbOf(stroke(key)), key).toBeNull();
  });

  it('refuses every stroke carrying ⌘, ⌃ or ⌥', () => {
    for (const [key] of TABLE) {
      expect(
        threadsVerbOf(stroke(key, { metaKey: true })),
        `⌘${key}`,
      ).toBeNull();
      expect(
        threadsVerbOf(stroke(key, { ctrlKey: true })),
        `⌃${key}`,
      ).toBeNull();
      expect(
        threadsVerbOf(stroke(key, { altKey: true })),
        `⌥${key}`,
      ).toBeNull();
    }
  });
});

describe('v2 A1: where a verb lands among the rows held', () => {
  it('moves by one, by a page, and to either end, clamped', () => {
    expect(threadsMoveTo('next', 0, 100)).toBe(1);
    expect(threadsMoveTo('previous', 0, 100)).toBe(0);
    expect(threadsMoveTo('page-down', 1, 100)).toBe(1 + PAGE);
    expect(threadsMoveTo('page-up', 1 + PAGE, 100)).toBe(1);
    expect(threadsMoveTo('page-up', 3, 100)).toBe(0);
    expect(threadsMoveTo('first', 57, 100)).toBe(0);
    // Last HELD, not last in the daemon's total: the next page is fetched
    // when the cursor arrives here, never skipped over.
    expect(threadsMoveTo('last', 0, 100)).toBe(99);
    expect(threadsMoveTo('next', 99, 100)).toBe(99);
    expect(threadsMoveTo('page-down', 95, 100)).toBe(99);
  });

  it('names no row when none are held', () => {
    for (const [, verb] of [
      ['', 'next'],
      ['', 'last'],
      ['', 'first'],
    ] as const)
      expect(threadsMoveTo(verb, 0, 0)).toBe(-1);
  });
});
