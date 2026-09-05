/**
 * s8 Sc1 — the STATIC half of the no-green lint (F-104, §1.7).
 *
 * F-104 is explicit that this layer is not the gate: `'#' + '34C759'` walks
 * straight past it, and Sc 17's computed-style sweep is the layer that
 * cannot be fooled. This layer earns its place two other ways. It fails in
 * milliseconds on every platform, and it names the file. And it enforces
 * LOCALITY, which is what makes "is there any green in this app" a question
 * with a short answer: every colour in the product is written in exactly one
 * file, so the audit is one file long.
 *
 * Three rules:
 *
 *  1. Outside `tokens.css`, no colour literal of any form. Not a hex, not a
 *     functional notation, not a CSS named colour in a colour-valued
 *     position. Colour is `var(--…)` everywhere else.
 *  2. Inside `tokens.css`, no green: the three hexes ui-design-integration §2
 *     bans by name, plus dominant-G, plus hue [75, 165] above 10%
 *     saturation. `#0A84FF` is the product's one saturated colour.
 *  3. No raster asset. SVG only, and every SVG is swept by rule 1.
 *
 * The predicates are NOT implemented here. `colourLiterals` and
 * `greenVerdict` live in `packages/cli/test/helpers/transcript-lint.ts`
 * beside `publicStringOffenders`, because the transcript linter already had
 * a colour rule and s7 twice paid to delete a second copy of a predicate
 * rather than to keep one. This file is the FILE WALK and the POLICY; the
 * tokenizer and the hue maths are shared.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  colourLiterals,
  greenVerdict,
} from '../../../../packages/cli/test/helpers/transcript-lint.js';

export const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

/** The two trees that become the shipped app. */
export const SWEPT_ROOTS: readonly string[] = [
  'apps/desktop/src',
  'apps/desktop/assets',
];

/** The one file in the product allowed to write a colour down. */
export const TOKENS_FILE = 'apps/desktop/src/renderer/theme/tokens.css';

/** Everything under a swept root that could carry a colour as text. */
const SWEPT_EXTENSIONS = ['.ts', '.tsx', '.css', '.html', '.svg', '.json'];

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
 * Raster files permitted inside the swept roots, by exact repo-relative path.
 *
 * EMPTY at S8 Sc 1 and an ALLOWLIST rather than a flat ban on purpose. S8's
 * own need is "no raster in the app", which a flat ban satisfies — but the
 * app is not the only thing that will live under these roots. Packaging
 * needs an `.icns`, a DMG background and a launch animation, none of which
 * an SVG can be, and a flat ban would have to be deleted and rewritten to
 * admit them. An allowlist is EXTENDED instead: a later slice adds the exact
 * paths it needs, each one visible in a diff, and every other raster still
 * fails. The rule stays; only the list moves.
 *
 * Entries are asserted to exist (the s6 (a) precedent: an allowlist entry
 * that does not exist is an allowlist entry nobody can review).
 */
export const RASTER_ALLOWLIST: readonly string[] = [];

function walk(absRoot: string): string[] {
  if (!existsSync(absRoot)) return [];
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

/** Every file under the swept roots, whatever its extension. */
export function filesUnderSweptRoots(
  roots: readonly string[] = SWEPT_ROOTS,
): string[] {
  return roots
    .flatMap((r) => walk(join(REPO_ROOT, r)))
    .map(relOf)
    .sort();
}

/** The subset rule 1 reads as text. */
export function sweptTextFiles(
  roots: readonly string[] = SWEPT_ROOTS,
): string[] {
  return filesUnderSweptRoots(roots).filter((f) =>
    SWEPT_EXTENSIONS.some((e) => f.endsWith(e)),
  );
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1)
    if (text[i] === '\n') line += 1;
  return line;
}

/**
 * Rule 1. Every colour literal outside `tokens.css`, with its location.
 *
 * `shortHex` and `namedInContext` are BOTH on here and both off in the
 * transcript linter, which is the whole reason the tokenizer takes options
 * rather than being copied: `#3c5` is a colour in a stylesheet and an anchor
 * in a markdown file, and `snow` is a colour in a `fill=` and a word in a
 * sentence.
 */
export function colourLocalityOffenders(
  roots: readonly string[] = SWEPT_ROOTS,
): string[] {
  const out: string[] = [];
  for (const rel of sweptTextFiles(roots)) {
    if (rel === TOKENS_FILE) continue;
    const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
    for (const lit of colourLiterals(text, {
      shortHex: true,
      namedInContext: true,
    }))
      out.push(
        `${rel}:${String(lineOf(text, lit.index))}: colour literal ${lit.text} (${lit.form}); colour lives in ${TOKENS_FILE}`,
      );
  }
  return out.sort();
}

/**
 * Rule 2. Every literal in the token sheet that is green, unparseable, or
 * written as a CSS named colour.
 *
 * A named colour is refused by FORM rather than by hue. The token sheet is
 * the UI doc §2.2 sheet, which is hex and `rgba()`; admitting `lime` here
 * would mean carrying 148 name-to-triple rows purely so the guard could then
 * reject it. Refusing the form is the same verdict for less machinery, and
 * it also refuses `wheat`, which no hue predicate would have.
 */
export function tokenSheetOffenders(): string[] {
  const abs = join(REPO_ROOT, TOKENS_FILE);
  if (!existsSync(abs)) return [`${TOKENS_FILE}: missing`];
  const text = readFileSync(abs, 'utf8');
  const out: string[] = [];
  for (const lit of colourLiterals(text, {
    shortHex: true,
    namedInContext: true,
  })) {
    const at = `${TOKENS_FILE}:${String(lineOf(text, lit.index))}`;
    if (lit.form === 'named') {
      out.push(`${at}: CSS named colour ${lit.text}; write hex or rgba()`);
      continue;
    }
    const verdict = greenVerdict(lit.text);
    if (verdict === null) {
      out.push(`${at}: ${lit.text} is a colour this lint cannot parse`);
      continue;
    }
    if (verdict.green) out.push(`${at}: ${lit.text} — ${verdict.why}`);
  }
  return out.sort();
}

/** Rule 3. Every raster under a swept root that the allowlist does not name. */
export function rasterOffenders(
  roots: readonly string[] = SWEPT_ROOTS,
  allowlist: readonly string[] = RASTER_ALLOWLIST,
): string[] {
  return filesUnderSweptRoots(roots)
    .filter((f) => RASTER_EXTENSIONS.some((e) => f.toLowerCase().endsWith(e)))
    .filter((f) => !allowlist.includes(f))
    .map((f) => `${f}: raster asset; the app ships SVG only`)
    .sort();
}
