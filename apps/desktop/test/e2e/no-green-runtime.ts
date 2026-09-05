/**
 * s8 Sc 4 — the RUNTIME half of the no-green lint (F-104).
 *
 * The static half (`tokens.spec.ts`) enforces LOCALITY: colour is written in
 * `tokens.css` and nowhere else. F-104 is explicit that it is not the gate,
 * because `'#' + '34C759'`, a `var()` chain and an SVG `fill` all walk past
 * a text scan. This half asks the browser for the RESOLVED value of every
 * colour-bearing property on every element and pseudo-element, which is the
 * one place all three indirections have already been collapsed to numbers.
 *
 * The split is deliberate: the page collects strings, Node judges them, and
 * the judge is `greenVerdict` — the same predicate the static sweep, the
 * transcript linter and the token sheet rule use. A second implementation
 * inside `page.evaluate` would be a fourth definition of "green".
 *
 * Sc 4 uses it on the empty shell. Sc 17 widens the callers to every screen
 * x theme x variant; this file is the mechanism, not the coverage.
 */
import type { Page } from 'playwright-core';
import {
  colourLiterals,
  greenVerdict,
} from '../../../../packages/cli/test/helpers/transcript-lint.js';

/** The computed properties that can carry a colour. */
const COLOUR_PROPERTIES: readonly string[] = [
  'color',
  'background-color',
  'background-image',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline-color',
  'text-decoration-color',
  'column-rule-color',
  'caret-color',
  'box-shadow',
  'fill',
  'stroke',
  'stop-color',
];

export interface ResolvedColour {
  readonly path: string;
  readonly property: string;
  readonly value: string;
}

/** Every resolved colour-bearing declaration in the loaded document. */
export async function resolvedColours(page: Page): Promise<ResolvedColour[]> {
  return page.evaluate((properties: readonly string[]) => {
    const describe = (el: Element): string => {
      const parts: string[] = [];
      for (let n: Element | null = el; n !== null; n = n.parentElement) {
        const id = n.id === '' ? '' : `#${n.id}`;
        parts.unshift(`${n.tagName.toLowerCase()}${id}`);
      }
      return parts.join('>');
    };
    const out: { path: string; property: string; value: string }[] = [];
    for (const el of Array.from(document.querySelectorAll('*'))) {
      for (const pseudo of [null, '::before', '::after']) {
        const style = window.getComputedStyle(el, pseudo);
        for (const property of properties) {
          const value = style.getPropertyValue(property);
          if (value === '' || value === 'none') continue;
          out.push({
            path: `${describe(el)}${pseudo ?? ''}`,
            property,
            value,
          });
        }
      }
    }
    return out;
  }, COLOUR_PROPERTIES);
}

/**
 * Every resolved colour that is green, with where it came from.
 *
 * `transparent` resolves to `rgba(0, 0, 0, 0)`, which is not green; fully
 * transparent greens are still reported, because a token that is green at
 * alpha 0 is a token that becomes green the moment somebody raises it.
 */
export async function runtimeGreenOffenders(page: Page): Promise<string[]> {
  const out: string[] = [];
  for (const found of await resolvedColours(page)) {
    for (const literal of colourLiterals(found.value, {
      shortHex: true,
      namedInContext: false,
    })) {
      const verdict = greenVerdict(literal.text);
      if (verdict?.green === true)
        out.push(
          `${found.path} { ${found.property}: ${literal.text} } — ${verdict.why}`,
        );
    }
  }
  return out.sort();
}
