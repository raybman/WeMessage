/**
 * s8 Sc1 rows 4-6 — the static no-green lint (F-104).
 *
 * The product is `#0A84FF` blue. Nothing in the GUI is green: not a token,
 * not a template string, not a CSS variable's value, not an SVG fill. §3.10
 * pushed state onto the GLYPH (● armed, ○ held, ◐ draft-only, ⊘ killed, ◌
 * disconnected) precisely so that colour never has to carry it, and this
 * file is the mechanism that keeps the decision from eroding one hex at a
 * time.
 *
 * Two things this file is careful about:
 *
 *  - It is NOT the gate. F-104 says so out loud: a static sweep loses to
 *    `'#' + '34C759'`, and Sc 17's computed-style walk is the layer that
 *    resolves template strings, `var()` indirection and SVG fills to numbers.
 *    This layer is the one that runs in twelve milliseconds and names a file.
 *  - Every banned literal in this file is ASSEMBLED FROM FRAGMENTS. A lint
 *    whose own spec has to be exempted from it is a lint with one exemption
 *    already, and s7 Sc7 and Sc11 both showed how quickly that list grows.
 */
import { existsSync } from 'node:fs';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BANNED_GREEN_HEXES,
  GREEN_BAN_MESSAGE,
  greenVerdict,
} from '../../../packages/cli/test/helpers/transcript-lint.js';
import {
  colourLocalityOffenders,
  filesUnderSweptRoots,
  rasterOffenders,
  RASTER_ALLOWLIST,
  REPO_ROOT,
  sweptTextFiles,
  tokenSheetOffenders,
  TOKENS_FILE,
} from './helpers/no-green-static.js';

/** The three hexes ui-design-integration §2 bans by name, never spelled. */
const GREEN_34 = `#34${'C759'}`;
const GREEN_24 = `#24${'8A3D'}`;
const GREEN_30 = `#30${'D158'}`;
/** The product's one saturated colour, legal in the token sheet and nowhere else. */
const TINT = `#0A${'84FF'}`;

describe('s8 Sc1: the static no-green lint (F-104)', () => {
  it('row 4a: the sweep is not vacuous — it reads real files, including the token sheet', () => {
    // A locality rule over an empty tree is a rule that passes because there
    // is nothing to check. The enumeration is asserted first, every time.
    const text = sweptTextFiles();
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain(TOKENS_FILE);
    expect(existsSync(join(REPO_ROOT, TOKENS_FILE))).toBe(true);
  });

  it('row 4b: no colour literal exists anywhere in the app except tokens.css', () => {
    expect(colourLocalityOffenders()).toEqual([]);
  });

  it('row 4c: every literal in tokens.css is parseable and is not green', () => {
    expect(tokenSheetOffenders()).toEqual([]);
  });

  it('row 4d: the app ships no raster asset, and the allowlist that would admit one is anchored', () => {
    expect(rasterOffenders()).toEqual([]);
    // Anchored (s6 (a) precedent). Empty today; the row is written so that a
    // later slice adding a packaging icon has to add a path that EXISTS.
    expect(
      RASTER_ALLOWLIST.filter((f) => !existsSync(join(REPO_ROOT, f))),
    ).toEqual([]);
    // And the sweep genuinely looked at files, so "no raster" is a finding
    // rather than an absence of looking.
    expect(filesUnderSweptRoots().length).toBeGreaterThan(0);
  });

  it('row 5: the three named hexes are rejected BY NAME, case-insensitively, in every hex form', () => {
    expect([...BANNED_GREEN_HEXES]).toEqual([
      GREEN_34.toLowerCase(),
      GREEN_24.toLowerCase(),
      GREEN_30.toLowerCase(),
    ]);
    for (const hex of [GREEN_34, GREEN_24, GREEN_30]) {
      for (const form of [hex, hex.toLowerCase(), hex.toUpperCase()]) {
        const verdict = greenVerdict(form);
        expect(verdict?.green).toBe(true);
        expect(verdict?.why).toContain(GREEN_BAN_MESSAGE);
      }
      // …including the eight-digit alpha form, which is the same decision
      // wearing an opacity.
      const withAlpha = greenVerdict(`${hex}FF`);
      expect(withAlpha?.green).toBe(true);
      expect(withAlpha?.why).toContain(GREEN_BAN_MESSAGE);
    }
    // The shorthand parser works, proven on the one shorthand that is
    // unambiguously green rather than on a shorthand of nothing in
    // particular. This arm reports a HUE, not a name: the by-name arm and
    // the predicate arm are two different claims and both have to bite.
    const shorthand = greenVerdict(`#0${'f0'}`);
    expect(shorthand?.green).toBe(true);
    expect(shorthand?.why).not.toContain(GREEN_BAN_MESSAGE);
    // And the product blue is not green in any of them.
    expect(greenVerdict(TINT)?.green).toBe(false);
    expect(greenVerdict(`rgba(10, 132, 255, .14)`)?.green).toBe(false);
    expect(greenVerdict(`#FF453A`)?.green).toBe(false);
    expect(greenVerdict(`#FF9F0A`)?.green).toBe(false);
  });

  describe('proven teeth: a guard written before the screens is worthless unless it bites', () => {
    const probeDir = 'apps/desktop/src/__s8probe__';
    const assetProbeDir = 'apps/desktop/assets/__s8probe__';
    const planted: string[] = [];

    const plant = (rel: string, body: string | Uint8Array): string => {
      const abs = join(REPO_ROOT, rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, body);
      planted.push(rel);
      return rel;
    };

    afterEach(() => {
      planted.splice(0);
      for (const dir of [probeDir, assetProbeDir])
        rmSync(join(REPO_ROOT, dir), { recursive: true, force: true });
    });

    it('a banned hex in a TSX string trips locality', () => {
      const rel = plant(
        `${probeDir}/Glyph.tsx`,
        `export const ARMED = '${GREEN_34}';\n`,
      );
      expect(colourLocalityOffenders().join('\n')).toContain(rel);
    });

    it('a functional green in a CSS file that is not tokens.css trips locality', () => {
      const rel = plant(
        `${probeDir}/armed.css`,
        `.armed { color: rgb(52, 199, 89); }\n`,
      );
      const offenders = colourLocalityOffenders().join('\n');
      expect(offenders).toContain(rel);
      expect(offenders).toContain('rgb(52, 199, 89)');
    });

    it('a named colour in an SVG fill trips locality', () => {
      const rel = plant(
        `${assetProbeDir}/tray.svg`,
        `<svg xmlns="http://www.w3.org/2000/svg"><circle fill="lime" r="4"/></svg>\n`,
      );
      const offenders = colourLocalityOffenders().join('\n');
      expect(offenders).toContain(rel);
      expect(offenders).toContain('(named)');
    });

    it('the PRODUCT BLUE in a TSX file trips locality — the rule is locality, not hue', () => {
      // The row that makes the whole design work. A non-green literal in the
      // wrong file is still a violation, which is what keeps "is there any
      // green in this app" answerable by reading one file.
      const rel = plant(`${probeDir}/Pill.tsx`, `const tint = '${TINT}';\n`);
      const offenders = colourLocalityOffenders().join('\n');
      expect(offenders).toContain(rel);
      expect(offenders).toContain(TINT);
    });

    it('a raster under assets/ trips the raster rule', () => {
      // A real 1x1 PNG, not a text file wearing the extension: the rule is
      // about the FILE, and a probe that only works because it is text would
      // prove the wrong thing.
      const png = Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100' +
          '05fe02fea7000000004945' +
          '4e44ae426082',
        'hex',
      );
      const rel = plant(`${assetProbeDir}/badge.png`, png);
      expect(rasterOffenders().join('\n')).toContain(rel);
      // …and it is not swept as text, so it can hide from rule 1 and must
      // not be able to hide from rule 3.
      expect(sweptTextFiles()).not.toContain(rel);
    });

    it('a green literal INSIDE tokens.css trips the hue rule rather than locality', () => {
      // Two rules, two failures, no overlap: this offender is invisible to
      // locality by construction and must be caught by the sheet rule.
      const dark = `#24${'8A3D'}`;
      const verdict = greenVerdict(dark);
      expect(verdict?.green).toBe(true);
      // Desaturated and dark greens that dominant-G alone would miss.
      expect(greenVerdict('hsl(140, 35%, 40%)')?.green).toBe(true);
      expect(greenVerdict('#5A6E5A')?.green).toBe(true);
    });

    it('LEGITIMATE NEAR-MISS: var(--…), a neutral layer and a blue token are all silent', () => {
      // The counterfactual that keeps every row above honest. A screen is
      // ALLOWED to name colours — through tokens — and a token sheet is
      // allowed every hue but one.
      const rel = plant(
        `${probeDir}/Card.tsx`,
        [
          `export const STYLE = 'color: var(--tint); background: var(--layer-1)';`,
          `// #0A84FF is the tint, discussed here in a comment as a var name`,
          `export const GLYPHS = ['\\u25CF', '\\u25CB', '\\u25D0'];`,
          '',
        ].join('\n'),
      );
      // The comment mentions a hex, so the near-miss is deliberately the
      // HARD version: prose is not exempt and the file must be rewritten to
      // not spell it. Assert the shape we actually ship instead.
      expect(colourLocalityOffenders().join('\n')).toContain(rel);
      rmSync(join(REPO_ROOT, rel));
      plant(
        `${probeDir}/Card.tsx`,
        [
          `export const STYLE = 'color: var(--tint); background: var(--layer-1)';`,
          `export const GLYPHS = ['\\u25CF', '\\u25CB', '\\u25D0'];`,
          `export const NOT_A_COLOUR = { fill: 'currentColor', stroke: 'none' };`,
          `export const ID = '01J8ZK5Q0000000000000000';`,
          '',
        ].join('\n'),
      );
      expect(colourLocalityOffenders()).toEqual([]);
      // And the neutrals the token sheet actually uses are not green.
      for (const neutral of ['#F5F5F7', '#1C1C1E', '#8E8E93', '#FFFFFF'])
        expect(greenVerdict(neutral)?.green).toBe(false);
    });
  });
});
