/**
 * The ship-era static no-green sweep (s9 Sc 1 rows 2 and 3), kept by v2 S6c.
 *
 * This is the half of the old desktop helper that never depended on the
 * desktop app. S8's locality rule (every colour written in one token sheet)
 * belonged to that app and went with it; the Swift app holds its own palette
 * to the same zero-green rule in `Tokens.swift` and its tests. What stays is
 * the WEAKER question asked of a WIDER set of files: not "is colour written
 * down here" but "is any of it green", over everything an operator meets
 * before and after installing. A landing page that paints APPROVE green is
 * the same decision the app refuses, made where more people see it.
 *
 * The predicates are NOT implemented here. `colourLiterals` and
 * `greenVerdict` live in `packages/cli/test/helpers/transcript-lint.ts`,
 * shared with the transcript linter. This file is the FILE WALK and the
 * POLICY.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  colourLiterals,
  greenVerdict,
} from '../../../packages/cli/test/helpers/transcript-lint.js';

export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * Every surface the sweep reads. The previous desktop app contributed three
 * roots here (its sources, assets and build inputs); v2 S6c replaced them
 * with the one tree of the Swift app that is not Swift source, its bundle
 * resources (Info.plist, the entitlements, the icon).
 */
export const SHIP_ROOTS: readonly string[] = [
  'apps/mac/Resources',
  'site',
  'homebrew',
  'README.md',
  'CHANGELOG.md',
  'SECURITY.md',
];

/**
 * What the sweep reads as text: the languages the ship era writes, every one
 * of which can carry a hex.
 */
const SHIP_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.css',
  '.html',
  '.svg',
  '.json',
  '.md',
  '.rb',
  '.plist',
  '.yml',
  '.yaml',
  '.sh',
  '.mjs',
  '.js',
];

const RASTER_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.icns',
  '.bmp',
  '.tiff',
];

/**
 * Raster files permitted in the tree, by exact repo-relative path.
 *
 * An ALLOWLIST rather than a ban, and a PROMOTION rather than an exemption:
 * every entry is decoded and swept pixel by pixel by `raster-decode.ts`.
 * v2 S6c removed the previous desktop app and with it two of the four
 * entries (its build icon and its DMG background); the Swift app's icon is
 * a byte copy of that build icon, so the decode and the pixel sweep pass for
 * the same reason they always did. Sorted, because the spec compares this
 * list to sorted `git ls-files` output by equality. No apostrophes in these
 * comments: s9-e2e Sc15 row 4 reads every single-quoted span here as a path.
 */
export const RASTER_ALLOWLIST: readonly string[] = [
  'apps/mac/Resources/icon.icns',
  'site/media/launch.gif',
];

function walk(absRoot: string): string[] {
  if (!existsSync(absRoot)) return [];
  // A root may be a FILE: `README.md` is a swept surface, and `readdirSync`
  // on it throws ENOTDIR rather than returning nothing.
  if (statSync(absRoot).isFile()) return [absRoot];
  const out: string[] = [];
  const rec = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) rec(full);
      else out.push(full);
    }
  };
  rec(absRoot);
  return out;
}

function relOf(abs: string): string {
  return abs.slice(REPO_ROOT.length).replace(/\\/g, '/').replace(/^\/+/, '');
}

/** Every file under the ship roots, whatever its extension. */
export function filesUnderShipRoots(
  roots: readonly string[] = SHIP_ROOTS,
): string[] {
  return roots
    .flatMap((r) => walk(join(REPO_ROOT, r)))
    .map(relOf)
    .sort();
}

/** The ship-era surface list, read as text. Row 2's enumeration. */
export function shipTextFiles(roots: readonly string[] = SHIP_ROOTS): string[] {
  return filesUnderShipRoots(roots).filter((f) =>
    SHIP_EXTENSIONS.some((e) => f.endsWith(e)),
  );
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1)
    if (text[i] === '\n') line += 1;
  return line;
}

/**
 * Every GREEN colour literal on a ship surface.
 *
 * A literal that is not green is not an offender here, and neither is one
 * this parser cannot resolve: `greenVerdict` returns `null` for `oklch()`
 * and for a CSS named colour, and treating that as an offender would make
 * every `#faq` anchor and every sentence containing the word `color` a
 * finding on a README. A guard that cries wolf on prose gets turned off.
 */
export function shipGreenOffenders(
  roots: readonly string[] = SHIP_ROOTS,
): string[] {
  const out: string[] = [];
  for (const rel of shipTextFiles(roots)) {
    const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
    for (const lit of colourLiterals(text, {
      shortHex: true,
      // `#482` in `audit #482 appended to hash chain` is a sequence number;
      // a colour is written as a VALUE in every language this sweep reads.
      shortHexValuesOnly: true,
      namedInContext: true,
    })) {
      const verdict = greenVerdict(lit.text);
      if (verdict === null || !verdict.green) continue;
      out.push(
        `${rel}:${String(lineOf(text, lit.index))}: ${lit.text} — ${verdict.why}`,
      );
    }
  }
  return out.sort();
}

/** Every raster under a ship root that the allowlist does not name. */
export function rasterOffenders(
  roots: readonly string[] = SHIP_ROOTS,
  allowlist: readonly string[] = RASTER_ALLOWLIST,
): string[] {
  return filesUnderShipRoots(roots)
    .filter((f) => RASTER_EXTENSIONS.some((e) => f.toLowerCase().endsWith(e)))
    .filter((f) => !allowlist.includes(f))
    .map((f) => `${f}: raster asset not on the allowlist`)
    .sort();
}
