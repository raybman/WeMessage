/**
 * s10 Slice 1: `typedstreamWithText` builds a macOS 26 attributedBody blob
 * for an arbitrary string by splicing it into Apple's own plain-ascii.bin.
 *
 * Two lengths move with the text, and the decoder only reads the first:
 * the NSString prefix counts UTF-8 BYTES, the attribute run counts UTF-16
 * CODE UNITS. A splice that patched one and not the other would still decode
 * and would still be a blob Apple never writes. The golden rows are the
 * proof: from plain-ascii.bin alone the encoder must reproduce three other
 * real corpus blobs byte for byte, one with astral emoji (bytes != units),
 * one multiline, one past the single-byte integer range (0x81 lo hi).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { typedstreamWithText } from '../src/index.js';

const CORPUS = join(import.meta.dirname, '..', 'typedstream');
const manifest = JSON.parse(
  readFileSync(join(CORPUS, 'manifest.json'), 'utf8'),
) as Record<string, { expectedText: string }>;

describe('typedstreamWithText (s10 Slice 1)', () => {
  it.each(['plain-ascii', 'emoji', 'multiline', 'long-4k'])(
    'reproduces the real %s.bin byte for byte',
    (name) => {
      const expected = readFileSync(join(CORPUS, `${name}.bin`));
      const text = manifest[`${name}.bin`]?.expectedText;
      expect(text).toBeTypeOf('string');
      expect(typedstreamWithText(text as string).equals(expected)).toBe(true);
    },
  );

  it('rejects an empty body rather than inventing a blob shape', () => {
    expect(() => typedstreamWithText('')).toThrow(/empty/i);
  });
});
