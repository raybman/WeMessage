/**
 * v2 A2: what a stroke on the conversations list means once a conversation
 * can be opened. Focus never leaves the list, so the mode decides.
 */
import { describe, expect, it } from 'vitest';
import {
  isJumpChord,
  messengerVerbOf,
  type MessengerMode,
  type MessengerStroke,
} from '../../src/renderer/keys/transcript.js';

function stroke(
  key: string,
  extra: Partial<MessengerStroke> = {},
): MessengerStroke {
  return {
    key,
    code: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...extra,
  };
}
const CMD_J = stroke('j', { code: 'KeyJ', metaKey: true });
const verb = (s: MessengerStroke, mode: MessengerMode) =>
  messengerVerbOf(s, mode);

describe('list mode (v2 A2)', () => {
  it('keeps the A1 navigation and adds Return to open', () => {
    expect(verb(stroke('j'), 'list')).toEqual({ kind: 'move', verb: 'next' });
    expect(verb(stroke('End'), 'list')).toEqual({ kind: 'move', verb: 'last' });
    expect(verb(stroke('Enter'), 'list')).toEqual({ kind: 'open' });
  });

  it('leaves Escape, ⌘J and a modified Return alone', () => {
    expect(verb(stroke('Escape'), 'list')).toBeNull();
    expect(verb(CMD_J, 'list')).toBeNull();
    expect(verb(stroke('Enter', { metaKey: true }), 'list')).toBeNull();
    expect(verb(stroke('Enter', { shiftKey: true }), 'list')).toBeNull();
  });
});

describe('open mode: the transcript is read like a pager (v2 A2)', () => {
  it('maps the list strokes onto reading verbs', () => {
    const read = (key: string) => verb(stroke(key), 'open');
    expect(read('j')).toEqual({ kind: 'read', verb: 'line-down' });
    expect(read('ArrowUp')).toEqual({ kind: 'read', verb: 'line-up' });
    expect(read('PageUp')).toEqual({ kind: 'read', verb: 'page-up' });
    expect(read('PageDown')).toEqual({ kind: 'read', verb: 'page-down' });
    expect(read('g')).toEqual({ kind: 'read', verb: 'top' });
    expect(read('G')).toEqual({ kind: 'read', verb: 'bottom' });
  });

  it('Escape closes, ⌘J starts a jump, Return does nothing', () => {
    expect(verb(stroke('Escape'), 'open')).toEqual({ kind: 'close' });
    expect(verb(CMD_J, 'open')).toEqual({ kind: 'jump-start' });
    expect(verb(stroke('Enter'), 'open')).toBeNull();
  });

  it('⌘J is the physical key, alone', () => {
    expect(isJumpChord({ ...CMD_J, key: 'h' })).toBe(true); // Dvorak
    expect(isJumpChord({ ...CMD_J, shiftKey: true })).toBe(false);
    expect(isJumpChord({ ...CMD_J, ctrlKey: true })).toBe(false);
    expect(isJumpChord({ ...CMD_J, altKey: true })).toBe(false);
    expect(isJumpChord({ ...CMD_J, metaKey: false })).toBe(false);
  });
});

describe('jumping mode: a date prompt and nothing else (v2 A2)', () => {
  it('takes digits, Backspace, Return and Escape', () => {
    expect(verb(stroke('7'), 'jumping')).toEqual({
      kind: 'jump-digit',
      digit: '7',
    });
    expect(verb(stroke('Backspace'), 'jumping')).toEqual({
      kind: 'jump-erase',
    });
    expect(verb(stroke('Enter'), 'jumping')).toEqual({ kind: 'jump-commit' });
    expect(verb(stroke('Escape'), 'jumping')).toEqual({ kind: 'jump-cancel' });
  });

  it('refuses everything else, the reading keys included', () => {
    for (const key of ['j', 'k', 'g', 'G', 'PageUp', '-', 'a'])
      expect(verb(stroke(key), 'jumping'), key).toBeNull();
    expect(verb(stroke('7', { metaKey: true }), 'jumping')).toBeNull();
    expect(verb(CMD_J, 'jumping')).toBeNull();
  });
});
