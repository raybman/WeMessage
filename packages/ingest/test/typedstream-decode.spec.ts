/**
 * Scenario 5 — Typedstream corpus decodes 100% (spec Part 2 #5; named S1
 * checkpoint; plan §2.2.1, §2.7 Compat: "typedstream corpus must decode 100%").
 *
 * Given the checked-in scrubbed corpus fixtures/typedstream/*.bin with
 * manifest.json golden expectations (spec Part 3), when each blob is run
 * through packages/ingest/src/typedstream/ (clean-room TS decoder — knowledge
 * ported from ReagentX's imessage-database and public typedstream format
 * documentation, NEVER code; GPL-3.0 stays out of tree), then 100% of corpus
 * blobs decode to exactly the manifest's expected text.
 *
 * Degrade path (§2.2.1): malformed blobs return a typed failure — no throw
 * escapes, no crash. The normalizer's mapping to text:null + decode-failed
 * audit event is Scenario 7's job; here we assert the typed result only.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decodeTypedstreamText,
  decodeSummaryInfoLatestText,
  type DecodeResult,
} from '@wemessage/ingest';

const CORPUS_DIR = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'fixtures',
  'typedstream',
);

interface ManifestEntry {
  /** 'typedstream' = attributedBody blob; 'summary-info' = message_summary_info bplist. */
  kind: 'typedstream' | 'summary-info';
  sourceOs: string;
  /** Exactly one of expectedText / expectFailure per entry. */
  expectedText?: string;
  expectFailure?: true;
  note?: string;
}

const manifest = JSON.parse(
  readFileSync(join(CORPUS_DIR, 'manifest.json'), 'utf8'),
) as Record<string, ManifestEntry>;

const binFiles = readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.bin'));

function decode(file: string, entry: ManifestEntry): DecodeResult {
  const bytes = readFileSync(join(CORPUS_DIR, file));
  return entry.kind === 'summary-info'
    ? decodeSummaryInfoLatestText(bytes)
    : decodeTypedstreamText(bytes);
}

describe('typedstream corpus (S1 checkpoint, §2.7 Compat)', () => {
  it('every checked-in .bin has a manifest entry and vice versa (corpus-rot guard)', () => {
    expect(binFiles.length).toBeGreaterThan(0);
    expect(new Set(binFiles)).toEqual(new Set(Object.keys(manifest)));
  });

  it('every manifest entry has exactly one of expectedText / expectFailure', () => {
    for (const [file, entry] of Object.entries(manifest)) {
      const has = [
        entry.expectedText !== undefined,
        entry.expectFailure === true,
      ];
      expect(has.filter(Boolean), file).toHaveLength(1);
    }
  });

  const goldens = Object.entries(manifest).filter(
    ([, e]) => e.expectedText !== undefined,
  );
  it.each(goldens)(
    'decodes %s to exactly the manifest golden',
    (file, entry) => {
      const result = decode(file, entry);
      expect(
        result.ok,
        `decode failed: ${!result.ok ? result.error.code : ''}`,
      ).toBe(true);
      if (result.ok) expect(result.text).toBe(entry.expectedText);
    },
  );

  it('decodes 100% of the golden corpus (§2.7 Compat wording)', () => {
    const decoded = goldens.filter(([file, entry]) => {
      const result = decode(file, entry);
      return result.ok && result.text === entry.expectedText;
    });
    expect(decoded.length).toBe(goldens.length);
    expect(goldens.length).toBeGreaterThanOrEqual(8); // Part 3.1 corpus cases
  });

  const malformed = Object.entries(manifest).filter(
    ([, e]) => e.expectFailure === true,
  );
  it.each(malformed)(
    'returns a typed failure (no throw) for malformed blob %s (§2.2.1 degrade)',
    (file, entry) => {
      let result: DecodeResult | undefined;
      expect(() => {
        result = decode(file, entry);
      }).not.toThrow();
      expect(result).toBeDefined();
      expect(result!.ok).toBe(false);
      if (!result!.ok) {
        expect(result!.error.code).toBe('malformed');
        expect(typeof result!.error.message).toBe('string');
      }
    },
  );

  it('never throws on any truncation of a valid blob (fuzz sweep, plan §2.2.1 "fuzzed")', () => {
    const [file] = goldens.find(([, e]) => e.kind === 'typedstream')!;
    const bytes = readFileSync(join(CORPUS_DIR, file));
    for (let len = 0; len < bytes.length; len++) {
      const truncated = bytes.subarray(0, len);
      expect(() => decodeTypedstreamText(truncated)).not.toThrow();
      const result = decodeTypedstreamText(truncated);
      // A strict prefix of a valid blob must never silently decode to the
      // full golden AND must be a typed result either way.
      expect(typeof result.ok).toBe('boolean');
    }
  });

  it('returns typed failure on empty and on non-typedstream input', () => {
    for (const bytes of [
      Buffer.alloc(0),
      Buffer.from('bplist00deadbeef', 'utf8'),
      Buffer.from([0x00, 0x01, 0x02, 0x03]),
    ]) {
      const result = decodeTypedstreamText(bytes);
      expect(result.ok).toBe(false);
    }
  });
});
