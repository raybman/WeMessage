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
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
  SHIP_ROOTS,
  shipGreenOffenders,
  shipTextFiles,
  sweptTextFiles,
  tokenSheetOffenders,
  TOKENS_FILE,
} from './helpers/no-green-static.js';
// s9 Sc1 row 3: the readers that make an allowlisted raster reviewable.
import { decodeRaster, rasterGreenOffenders } from './helpers/raster-decode.js';

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

/* ═══════════════════════════════════════════════════════════════════════ */
/* s9 Sc 1 rows 2-3 — the same question, asked of everything that ships.   */
/* ═══════════════════════════════════════════════════════════════════════ */

/**
 * F-104's decision was never "the app is monochrome". It was that this
 * product does not have a green light, because §3.10 put state on the glyph
 * so that hue would never have to carry it, and a green APPROVE button is
 * the exact affordance the design refuses: a colour that says "safe, go
 * ahead" about an action whose whole point is that a human looked at it.
 *
 * S8 enforced that across the application and stopped at the application's
 * edge. Row 2 walks it out to everything an operator actually meets — the
 * landing page, the README, the cask, the DMG background — and the first
 * thing it finds is that the public page has been painting APPROVE green
 * since the day it was written, with a `--go` token declared for the
 * purpose. The GREEN deletes the token.
 *
 * Row 3 handles the half a text sweep structurally cannot reach. The ship
 * era commits rasters, and a hex inside a PNG is not a hex a grep can see.
 */
describe('s9 Sc1: the ship-era colour sweep (rows 2 and 3)', () => {
  /** Plant a ship surface, sweep it, take it away again. */
  const shipPlanted: string[] = [];
  const plantShip = (rel: string, body: string): string => {
    const abs = join(REPO_ROOT, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
    shipPlanted.push(rel);
    return rel;
  };
  afterEach(() => {
    for (const rel of shipPlanted.splice(0))
      rmSync(join(REPO_ROOT, rel), { force: true });
  });

  /* ── row 2 ────────────────────────────────────────────────────────── */

  it('row 2a: the sweep reads the surfaces an operator actually meets', () => {
    const files = shipTextFiles();
    // Non-vacuity first, every time: a hue rule over an empty file list is
    // a rule that passes because it read nothing.
    expect(files.length).toBeGreaterThan(0);
    // Named individually rather than by count, because the failure this
    // catches is a ROOT going missing, and a count cannot tell a missing
    // root from a deleted file.
    expect(files).toContain('site/index.html');
    expect(files).toContain('README.md');
    expect(files).toContain(TOKENS_FILE);
    // A root that is a FILE rather than a directory is the shape that broke
    // the walker: `readdirSync` on `README.md` throws ENOTDIR.
    expect(existsSync(join(REPO_ROOT, 'README.md'))).toBe(true);
  });

  it('row 2b: nothing green on any ship surface', () => {
    expect(shipGreenOffenders()).toEqual([]);
  });

  it('row 2c: the roots are the ship-era seven plus the assets s8 already swept', () => {
    // Pinned so that dropping a root is a diff. The plan proposed replacing
    // `apps/desktop/assets` rather than keeping it, which would have
    // dropped the tray glyphs — the one place a hue is baked into a file
    // the app ships — out of the only sweep that reads them.
    expect([...SHIP_ROOTS]).toEqual([
      'apps/desktop/src',
      'apps/desktop/assets',
      'apps/desktop/build',
      'site',
      'homebrew',
      'README.md',
      'CHANGELOG.md',
      'SECURITY.md',
    ]);
  });

  it('row 2 PLANTED: a green approve button on the site trips it', () => {
    const rel = plantShip(
      'site/__s9probe__.html',
      `<style>.approve{background:${GREEN_30}}</style>\n`,
    );
    expect(shipGreenOffenders().join('\n')).toContain(rel);
  });

  it('row 2 PLANTED: green in a cask, a plist or a shell script trips it', () => {
    // The ship era writes Ruby, XML and shell, and every one of them can
    // carry a hex. An extension list that stopped at the GUI-era six would
    // have swept none of these.
    for (const [name, body] of [
      ['site/__s9probe__.rb', `  badge "${GREEN_34}"\n`],
      ['site/__s9probe__.plist', `<string>${GREEN_24}</string>\n`],
      ['site/__s9probe__.sh', `TINT=${GREEN_30}\n`],
      ['site/__s9probe__.md', `The go light is ${GREEN_34}.\n`],
    ] as ReadonlyArray<readonly [string, string]>) {
      const rel = plantShip(name, body);
      expect(shipGreenOffenders().join('\n'), name).toContain(rel);
    }
  });

  it('row 2 NEAR-MISS: the palette the product actually ships is silent', () => {
    // The counterfactual. A page is ALLOWED to have colour — this one has
    // about forty literals — and the rule is one hue band, not austerity.
    const rel = plantShip(
      'site/__s9probe__ok.html',
      [
        '<style>',
        `  :root{--tint:${TINT};--danger:#FF453A;--warn:#FF9F0A}`,
        '  .approve{background:var(--tint);color:#04121f}',
        '  body{background:#0B0B0F;color:#F5F5F7}',
        '  a{color:#4AA9FF}',
        '</style>',
        '',
      ].join('\n'),
    );
    expect(shipGreenOffenders().filter((o) => o.startsWith(rel))).toEqual([]);
    // …and the sweep did read it, so the silence is a verdict.
    expect(shipTextFiles()).toContain(rel);
  });

  it('row 2: prose is not a colour, so a README does not cry wolf', () => {
    // `shipGreenOffenders` treats an unparseable literal as "not a colour",
    // where `tokenSheetOffenders` treats it as an offender. Both are right
    // for their file: a token sheet has no business holding a colour the
    // lint cannot resolve, and a README is mostly English.
    const rel = plantShip(
      'site/__s9probe__prose.md',
      [
        '# Colour',
        '',
        'See [#faq](#faq) about the colour of the approve control.',
        'The window is `oklch(0.7 0.1 150)` in the design file.',
        '',
      ].join('\n'),
    );
    expect(shipGreenOffenders().filter((o) => o.startsWith(rel))).toEqual([]);
  });

  /**
   * The SELF-TRIP this row cost, and both halves of the resolution.
   *
   * Row 2b's first run convicted `site/index.html:465` of `#482`. The line
   * is `sent ✓ · audit #482 appended to hash chain` inside a terminal
   * mock: a sequence number, expanding to `#448822`, which really is an
   * olive green by the dominant-G test. The sweep was right about the
   * pixels and wrong about the tree.
   *
   * The page was NOT edited. A guard a legitimate caller has to be
   * mutilated for is the wrong guard, and the next `#abc`-shaped token in
   * a README would have brought it straight back. `shortHex` was not
   * turned off either — that would have let `--go:#3d5` through, which is
   * the precise defect this scenario exists to delete. The tokenizer
   * gained `shortHexValuesOnly` instead, and these two rows are the teeth
   * on either side of it.
   */
  it('row 2 SHORT HEX: a three-digit green in a value position still trips', () => {
    // Five spellings, one per language the ship era writes. If the
    // resolution had been "stop reading short hex", every one of these
    // would be silent — which is why the near-miss row below is not
    // sufficient evidence on its own.
    for (const [name, body] of [
      ['site/__s9probe__short.css', ':root{--go:#3d5}\n'],
      ['site/__s9probe__short.svg', '<svg><path fill="#3d5"/></svg>\n'],
      ['site/__s9probe__short.sh', 'TINT=#3d5\n'],
      ['site/__s9probe__short.plist', '<string>#3d5</string>\n'],
      ['site/__s9probe__short.rb', '  badge "#3d5"\n'],
    ] as ReadonlyArray<readonly [string, string]>) {
      const rel = plantShip(name, body);
      expect(shipGreenOffenders().join('\n'), name).toContain(rel);
    }
  });

  it('row 2 NEAR-MISS: a sequence number in a sentence is not a colour', () => {
    const rel = plantShip(
      'site/__s9probe__seq.md',
      [
        '# Audit',
        '',
        'sent ✓ · audit #482 appended to hash chain',
        'See issue #3d5 and milestone #4a2 for the rest.',
        '',
      ].join('\n'),
    );
    expect(shipGreenOffenders().filter((o) => o.startsWith(rel))).toEqual([]);
    expect(shipTextFiles()).toContain(rel);
    // …and the real page that provoked this still says it, unedited.
    expect(readFileSync(join(REPO_ROOT, 'site/index.html'), 'utf8')).toContain(
      'audit #482 appended',
    );
  });

  /* ── row 3 ────────────────────────────────────────────────────────── */

  /**
   * The plan's allowlist names `apps/desktop/test/__snapshots__/rt-light.png`
   * and `rt-dark.png`. Those files do not exist and never will: s8 Sc 17
   * replaced the golden-screenshot plan with an alpha census (184 dark, 199
   * light, 255 reduced) precisely because a golden PNG of a translucent
   * window over a macOS material is machine-dependent and because a
   * mutation must fail a structural row rather than a picture.
   *
   * So the correct allowlist AT THIS SCENARIO IS EMPTY, and it is asserted
   * as an EQUALITY today rather than as the plan's subset-until-Sc-13. A
   * subset row over an empty set passes against any tree at all.
   */
  describe('row 3: the raster allowlist, decoded rather than trusted', () => {
    const trackedRasters = (): string[] =>
      execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
        .split('\n')
        .filter((f) => f.length > 0)
        .filter((f) =>
          [
            '.png',
            '.jpg',
            '.jpeg',
            '.gif',
            '.webp',
            '.ico',
            '.icns',
            '.bmp',
          ].some((e) => f.toLowerCase().endsWith(e)),
        )
        .sort();

    /**
     * HOW THIS SITS WITH THE S8 CLOSE, said out loud because "we added a
     * second row about rasters" is exactly the shape that ends with two
     * rows disagreeing.
     *
     * `test/arch.spec.ts` row 13 (s8 Sc 1, tightened at the S8 close) pins
     * `git ls-files '*.png'` to `[]` by EQUALITY with a planted probe. That
     * row is NOT superseded and NOT weakened — it stays exactly as it is.
     * This row is ADDED ALONGSIDE it and is strictly stronger in two ways:
     * it covers all eight raster extensions rather than `*.png` alone, and
     * every member it admits is DECODED and pixel-swept (row 3b) rather
     * than merely named.
     *
     * The plan's Sc 1 allowlist names `apps/desktop/test/__snapshots__/
     * rt-light.png` and `rt-dark.png`. Those files do not exist and never
     * will: Sc 17 replaced the golden-PNG approach with an alpha equality
     * (`minAlpha(window) === round(255 * alpha(--layer-1))`) plus an
     * identity check and a dark→reduced→dark round trip, which is a
     * stronger instrument AND keeps binaries out of a public repository.
     * So the correct Sc 1 allowlist is EMPTY, growing to the three real
     * ship artefacts by Sc 13. The plan's "subset until Sc 13, equality
     * from Sc 13" structure is deliberately NOT adopted either: an empty
     * set is already pinned by equality at the S8 close, and downgrading a
     * standing equality to a subset to match a stale plan would be the
     * only loosening in this scenario.
     */
    it('row 3a: the tracked raster set IS the allowlist, exactly', () => {
      expect(trackedRasters()).toEqual([...RASTER_ALLOWLIST]);
      // Spelled out here as well as in the helper, so that admitting a raster
      // is a two-file diff and never a quiet append.
      expect([...RASTER_ALLOWLIST]).toEqual([
        'apps/desktop/build/dmg-background.png',
        'apps/desktop/build/icon.icns',
      ]);
    });

    it('row 3a PLANTED: the equality is a verdict, not an empty search', () => {
      // Without this the row above passes on a tree where `git ls-files`
      // is broken, the extension list is empty, or the filter never
      // matches — the "predicate that matches nothing" shape. The probe is
      // `--intent-to-add`ed because the reader is `git ls-files`, so an
      // untracked file would prove nothing.
      const rel = 'apps/desktop/assets/__s9_probe__ship.icns';
      const abs = join(REPO_ROOT, rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, 'not really an icns\n');
      try {
        execFileSync('git', ['add', '--intent-to-add', '--', rel], {
          cwd: REPO_ROOT,
        });
        // The row's actual claim, asserted directly rather than inferred
        // from the equality below: the predicate MATCHED the file we
        // planted. This survives the allowlist growing again.
        expect(trackedRasters()).toContain(rel);
        // And the set is still EXACT now that the allowlist is not empty:
        // the probe plus the allowlist, nothing else. Sorted rather than
        // written out in order, because the order is `git ls-files`' and
        // not a fact worth pinning twice.
        expect(trackedRasters()).toEqual([...RASTER_ALLOWLIST, rel].sort());
        expect(trackedRasters()).not.toEqual([...RASTER_ALLOWLIST]);
      } finally {
        try {
          execFileSync(
            'git',
            ['rm', '--cached', '--quiet', '--force', '--', rel],
            {
              cwd: REPO_ROOT,
              stdio: 'ignore',
            },
          );
        } catch {
          // never indexed; the unlink is the whole cleanup
        }
        rmSync(abs, { force: true });
      }
    });

    it('row 3b: every allowlisted raster exists, decodes, and is not green', () => {
      for (const rel of RASTER_ALLOWLIST) {
        const abs = join(REPO_ROOT, rel);
        expect(existsSync(abs), rel).toBe(true);
        expect(rasterGreenOffenders(rel, readFileSync(abs)), rel).toEqual([]);
      }
      // No longer vacuous. s9 Sc 6 put the two packaging artefacts on the
      // list, so the loop above now really does decode a 155 KB icns holding
      // eight embedded PNGs and a 540x380 background, and really does sweep
      // their pixels for the banned hues. The teeth below still matter: they
      // are what proves the decoder would convict if there were anything to
      // convict.
      expect(RASTER_ALLOWLIST.length).toBe(2);
    });

    it('row 3c: the ban still holds inside the swept roots', () => {
      expect(rasterOffenders(SHIP_ROOTS, RASTER_ALLOWLIST)).toEqual([]);
    });

    describe('the decoders bite: planted rasters, read off disk', () => {
      // Encoded by `pngjs` and `gifenc` — two implementations that share no
      // code with the readers under test — and pasted here as bytes. A
      // decoder proved against its own encoder proves only that it agrees
      // with itself.
      //
      // Four pixels of #30D158 over four of #0A84FF, 4x2. The green row is
      // the one the sweep must find; the blue row is the one it must not.
      const PNG_BYTES = Buffer.from(
        '89504e470d0a1a0a0000000d4948445200000004' +
          '0000000208060000007fa87d6300000017494441' +
          '5478016334b818f19f0109b0dcdabc9c01190000' +
          '6aa10492efbbabd80000000049454e44ae426082',
        'hex',
      );
      const GIF_BYTES = Buffer.from(
        '47494638396104000200f0000030d1580a84ff21' +
          'ff0b4e45545343415045322e30030100000021f9' +
          '0400000000002c00000000040002000008090001' +
          '080410a0608080003b',
        'hex',
      );
      // A 16x16 `ic04`: four #30D158 pixels then 252 #0A84FF, fully
      // opaque, as four run-length-encoded planes behind the `ARGB` magic.
      // Encoded by a PYTHON encoder written from the format description,
      // for the same reason PNG_BYTES came out of `pngjs`: a decoder proved
      // against its own encoder proves only that it agrees with itself, and
      // there is no third-party ARGB encoder to reach for. Small enough to
      // check by hand: `ffff` is a run of 130 alpha bytes, `8130` a run of
      // four 0x30 reds.
      const ARGB_ICNS_BYTES = Buffer.from(
        '69636e730000002a696330340000002241524742' +
          'fffffbff8130ff0af70a81d1ff84f7848158ffff' +
          'f7ff',
        'hex',
      );
      const GREEN_PIXEL = 'rgb(48, 209, 88)';
      const BLUE_PIXEL = 'rgb(10, 132, 255)';

      let dir = '';
      beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 's9-raster-'));
      });
      afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
      });
      const onDisk = (name: string, bytes: Uint8Array): Uint8Array => {
        writeFileSync(join(dir, name), bytes);
        return readFileSync(join(dir, name));
      };

      it('PNG: the pixels come back exactly, and only the green row trips', () => {
        const bytes = onDisk('probe.png', PNG_BYTES);
        const decoded = decodeRaster('probe.png', bytes);
        expect(decoded.undecoded).toEqual([]);
        expect(decoded.frames.length).toBe(1);
        const frame = decoded.frames[0];
        expect(frame?.width).toBe(4);
        expect(frame?.height).toBe(2);
        // Row 0 pixel 0 and row 1 pixel 0, by byte, so a decoder that
        // returned plausible-looking noise would fail here first.
        expect([...(frame?.rgba.subarray(0, 4) ?? [])]).toEqual([
          48, 209, 88, 255,
        ]);
        expect([...(frame?.rgba.subarray(16, 20) ?? [])]).toEqual([
          10, 132, 255, 255,
        ]);
        const offenders = rasterGreenOffenders('probe.png', bytes);
        expect(offenders.length).toBe(4);
        expect(offenders.join('\n')).toContain(GREEN_PIXEL);
        expect(offenders.join('\n')).not.toContain(BLUE_PIXEL);
        expect(offenders[0]).toContain('probe.png@0,0');
      });

      it('GIF: every frame is decoded, and the palette resolves', () => {
        const bytes = onDisk('probe.gif', GIF_BYTES);
        const decoded = decodeRaster('probe.gif', bytes);
        expect(decoded.undecoded).toEqual([]);
        expect(decoded.frames.length).toBe(1);
        expect(decoded.frames[0]?.label).toBe('probe.gif#0');
        expect([...(decoded.frames[0]?.rgba.subarray(0, 4) ?? [])]).toEqual([
          48, 209, 88, 255,
        ]);
        const offenders = rasterGreenOffenders('probe.gif', bytes);
        expect(offenders.length).toBe(4);
        expect(offenders.join('\n')).toContain(GREEN_PIXEL);
      });

      it('ICNS: the embedded PNG is found and swept', () => {
        // `icns` + total length, then one `ic09` entry wrapping the PNG.
        const entry = Buffer.alloc(8);
        entry.write('ic09', 0, 'ascii');
        entry.writeUInt32BE(8 + PNG_BYTES.length, 4);
        const header = Buffer.alloc(8);
        header.write('icns', 0, 'ascii');
        header.writeUInt32BE(16 + PNG_BYTES.length, 4);
        const bytes = onDisk(
          'probe.icns',
          Buffer.concat([header, entry, PNG_BYTES]),
        );
        const decoded = decodeRaster('probe.icns', bytes);
        expect(decoded.undecoded).toEqual([]);
        expect(decoded.frames.map((f) => f.label)).toEqual(['probe.icns:ic09']);
        expect(rasterGreenOffenders('probe.icns', bytes).length).toBe(4);
      });

      it('ICNS: the ARGB entries `iconutil` really writes are read too', () => {
        // NOT hypothetical, and not legacy. `iconutil` on macOS 15 writes
        // the 16pt and 32pt slots of a standard `.iconset` as ARGB and
        // every larger slot as PNG, so the committed `build/icon.icns` is
        // nine PNGs and two ARGBs. Until s9 Sc 6 taught the reader ARGB,
        // those two came back UNDECODED and row 3b failed. That failure is
        // the only reason the gap was visible instead of two unswept
        // renderings of the app icon sitting quietly in the bundle.
        const bytes = onDisk('argb.icns', ARGB_ICNS_BYTES);
        const decoded = decodeRaster('argb.icns', bytes);
        expect(decoded.undecoded).toEqual([]);
        expect(decoded.frames.map((f) => f.label)).toEqual(['argb.icns:ic04']);
        const frame = decoded.frames[0];
        expect(frame?.width).toBe(16);
        expect(frame?.height).toBe(16);
        // By byte, on both sides of the boundary. The plane order (A,R,G,B
        // in the file, RGBA out of the reader) is the one thing a wrong
        // decoder would get plausibly, invisibly wrong.
        expect([...(frame?.rgba.subarray(0, 4) ?? [])]).toEqual([
          48, 209, 88, 255,
        ]);
        expect([...(frame?.rgba.subarray(16, 20) ?? [])]).toEqual([
          10, 132, 255, 255,
        ]);
        const offenders = rasterGreenOffenders('argb.icns', bytes);
        expect(offenders.length).toBe(4);
        expect(offenders.join('\n')).toContain(GREEN_PIXEL);
        expect(offenders.join('\n')).not.toContain(BLUE_PIXEL);
      });

      it('a TRUNCATED ARGB entry is an offender, not a partial sweep', () => {
        // `unpackIcnsRle` returns null unless the stream fills the planes
        // EXACTLY while consuming EXACTLY all of its input. Without both
        // halves of that, a corrupt or misread entry decodes to a short
        // buffer of zeroes, sweeps clean, and reports nothing: the
        // quiet-pass shape this whole file exists to refuse. Two bytes come
        // off the end (one run of 122 blue bytes) and both length fields
        // are repaired, so the ONLY thing wrong with the file is the one
        // thing under test.
        const cut = Buffer.from(
          ARGB_ICNS_BYTES.subarray(0, ARGB_ICNS_BYTES.length - 2),
        );
        cut.writeUInt32BE(cut.length, 4);
        cut.writeUInt32BE(cut.length - 8, 12);
        const offenders = rasterGreenOffenders('cut.icns', cut);
        expect(offenders.length).toBe(1);
        expect(offenders[0]).toContain('UNDECODED');
        expect(offenders[0]).toContain('16x16');
      });

      it('an ARGB entry LONGER than its OSType implies is an offender', () => {
        // The other half of `unpackIcnsRle`'s exactness, and the half that
        // checks `ICNS_ARGB_SIDE` against the file instead of trusting it.
        // The square is not recoverable from an ARGB payload, so if that map
        // ever said 16 for a type that is really 32, a reader which stopped
        // at "the planes are full" would sweep a QUARTER of the icon and
        // call the rest clean. Two bytes are appended and both length fields
        // repaired, so the planes still fill exactly and the leftover input
        // is the only thing wrong.
        //
        // Written because the mutation that drops `s === src.length` from
        // `unpackIcnsRle` survived the whole suite until this row existed.
        // `Buffer.alloc`, NOT a hex literal: `test/arch.spec.ts` row 11
        // admits a `Buffer.from(..., 'hex')` blob in this file only when it
        // starts with a raster magic, because a standalone hex run is what
        // a leaked signing digest looks like. Two padding bytes are not a
        // raster and have no business pretending to be one.
        const fat = Buffer.concat([ARGB_ICNS_BYTES, Buffer.alloc(2)]);
        fat.writeUInt32BE(fat.length, 4);
        fat.writeUInt32BE(fat.length - 8, 12);
        const offenders = rasterGreenOffenders('fat.icns', fat);
        expect(offenders.length).toBe(1);
        expect(offenders[0]).toContain('UNDECODED');
        expect(offenders[0]).toContain('16x16');
      });

      it('an entry this reader cannot read is an OFFENDER, not a pass', () => {
        // The failure mode that would quietly disable the whole row: an
        // ICNS whose entries are raw 24-bit RLE rather than embedded PNGs,
        // decoded to zero frames, swept for zero green, reported clean.
        const raw = Buffer.alloc(16, 0x7f);
        const entry = Buffer.alloc(8);
        entry.write('is32', 0, 'ascii');
        entry.writeUInt32BE(8 + raw.length, 4);
        const header = Buffer.alloc(8);
        header.write('icns', 0, 'ascii');
        header.writeUInt32BE(16 + raw.length, 4);
        const bytes = Buffer.concat([header, entry, raw]);
        const offenders = rasterGreenOffenders('raw.icns', bytes);
        expect(offenders.length).toBe(1);
        expect(offenders[0]).toContain('UNDECODED');
      });

      it('a file wearing the wrong extension is an offender too', () => {
        const offenders = rasterGreenOffenders(
          'lies.png',
          Buffer.from('not really a png\n'),
        );
        expect(offenders.length).toBe(1);
        expect(offenders[0]).toContain('UNDECODED');
      });

      it('LEGITIMATE NEAR-MISS: the tint half of the same file is silent', () => {
        // Eight pixels go in; four come out as findings. Without this row
        // the three above could all be passing because the sweep convicts
        // every pixel it is handed, which is the failure mode a hue rule
        // with no tolerance band is most likely to have.
        const frame = decodeRaster('probe.png', PNG_BYTES).frames[0];
        expect(frame?.width ?? 0).toBe(4);
        let green = 0;
        let notGreen = 0;
        for (let p = 0; p < 8; p += 1) {
          const d = p * 4;
          const literal = `rgb(${String(frame?.rgba[d] ?? 0)}, ${String(
            frame?.rgba[d + 1] ?? 0,
          )}, ${String(frame?.rgba[d + 2] ?? 0)})`;
          if (greenVerdict(literal)?.green === true) green += 1;
          else notGreen += 1;
        }
        expect(green).toBe(4);
        expect(notGreen).toBe(4);
        expect(greenVerdict(BLUE_PIXEL)?.green).toBe(false);
        expect(greenVerdict(GREEN_PIXEL)?.green).toBe(true);
      });
    });
  });
});
