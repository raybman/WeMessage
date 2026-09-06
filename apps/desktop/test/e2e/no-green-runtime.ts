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
 * x theme x variant, and widened the mechanism too: this file used to read
 * fifteen NAMED properties, and a named list is a list a colour can be set
 * outside of. Chromium resolves 494 longhands per element on this app, and
 * the fifteen missed `-webkit-text-fill-color`, `-webkit-text-stroke-color`,
 * `-webkit-tap-highlight-color`, `text-emphasis-color`, `flood-color`,
 * `lighting-color`, every `border-block-*`/`border-inline-*` logical alias,
 * and — the largest hole — every CUSTOM PROPERTY, so a green declared in
 * the token sheet and not yet used by anything was invisible to the sweep
 * that exists to find greens in the token sheet. The census now iterates
 * the `CSSStyleDeclaration` itself, so there is no list to fall off.
 */
import type { Page } from 'playwright-core';
import {
  colourLiterals,
  greenVerdict,
} from '../../../../packages/cli/test/helpers/transcript-lint.js';

export interface ResolvedColour {
  readonly path: string;
  readonly property: string;
  readonly value: string;
}

/**
 * Every resolved colour-bearing declaration in the loaded document.
 *
 * The only filter is on the VALUE, never on the property name: a value is
 * kept when it contains a `#` or a `(`, which is exactly the set of forms
 * `colourLiterals` can parse with `namedInContext: false` (hex of any
 * length, and any functional notation — `rgb`, `rgba`, `hsl`, `oklch`,
 * `color(display-p3 …)`). Filtering there rather than on the name is what
 * makes the sweep total: it cannot miss a property because nobody thought
 * of it, and it drops only values no judge would have had an opinion about.
 */
export async function resolvedColours(page: Page): Promise<ResolvedColour[]> {
  return page.evaluate(() => {
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
      const path = describe(el);
      for (const pseudo of [null, '::before', '::after']) {
        const style = window.getComputedStyle(el, pseudo);
        for (let i = 0; i < style.length; i += 1) {
          const property = style.item(i);
          const value = style.getPropertyValue(property);
          if (!value.includes('#') && !value.includes('(')) continue;
          out.push({ path: `${path}${pseudo ?? ''}`, property, value });
        }
      }
    }
    return out;
  });
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
