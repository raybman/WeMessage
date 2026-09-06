/**
 * s8 Sc15 — axe-core, run for real against a real window.
 *
 * `axe-core` has been a declared devDependency since Sc4 and `test/arch.
 * spec.ts` row 15 has guarded it since Sc1 — no spec may switch a rule off,
 * no spec may drop a subtree, and the allowlist file has to carry a real
 * reason for anything it ever holds. That guard has been watching a tool
 * nobody had run yet. This is the file that runs it.
 *
 * It also, on first write, caught this file: the paragraph above named one
 * of the two banned spellings in prose, and row 15 reads RAW text because a
 * suppression hidden in a comment is a suppression somebody is about to
 * uncomment. Reworded rather than exempted.
 *
 * The onboarding wizard is the honest place for the first run. It is the
 * first surface an operator meets, it is the surface they meet while
 * something is already wrong, and it is the one place in the app where a
 * screen reader is likely to be ON because the operator has not yet had a
 * chance to set anything up. A permission card that carries its state in a
 * glyph the accessibility tree cannot see is a card that says nothing at
 * all to the person most likely to be reading it that way.
 *
 * The library is injected as SOURCE rather than reached over the network:
 * the renderer runs behind a real CSP on a custom scheme with no remote
 * origin allowed, and a helper that needed the network to run would be a
 * helper that silently stops running in CI.
 *
 * Nothing here narrows the run. There is no rule list, no scope and no
 * exclusion; the whole document is analysed and the RESULT is filtered to
 * the two impacts the plan names. Filtering an answer is not the same act
 * as refusing to ask the question, and the difference is exactly what row
 * 15 is about.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Page } from 'playwright-core';

const need = createRequire(import.meta.url);

/** The minified bundle, read once per worker. */
const SOURCE = readFileSync(
  join(dirname(need.resolve('axe-core')), 'axe.min.js'),
  'utf8',
);

/**
 * One `color-contrast` node's arithmetic, as axe itself computed it.
 *
 * Added in Sc17. A selector alone names WHERE a contrast failure is and
 * says nothing about WHAT is wrong, so a sweep over the whole product
 * reports the same root cause a thousand times and a reader has to
 * reproduce every one by hand. These four numbers collapse a thousand
 * nodes to the handful of token pairs that actually failed, and they are
 * the browser's RESOLVED colours rather than the values the stylesheet
 * declared — which is the only version of the question worth asking, since
 * a translucent layer resolves to something no author ever typed.
 */
export interface ContrastFact {
  readonly fg: string;
  readonly bg: string;
  readonly ratio: number;
  readonly required: number;
}

/** One failing rule, flattened to the facts a failure message needs. */
export interface AxeFinding {
  readonly id: string;
  readonly impact: string;
  readonly nodes: readonly string[];
  /** Empty for every rule but `color-contrast`. */
  readonly contrast: readonly ContrastFact[];
}

/**
 * Every `serious` or `critical` violation in the page, as it stands.
 *
 * Returned rather than asserted so the caller's `expect` carries the row's
 * own name, and so a caller can print the offending selectors: an a11y
 * failure whose message is `expected [] to equal [Array]` is a failure
 * somebody has to reproduce by hand before they can start reading it.
 */
export async function axeFindings(page: Page): Promise<AxeFinding[]> {
  await page.evaluate(SOURCE);
  return page.evaluate(async () => {
    const runner = (
      window as unknown as {
        axe: {
          run(context: Document): Promise<{
            violations: {
              id: string;
              impact: string | null;
              nodes: {
                target: unknown[];
                any?: {
                  data?: {
                    fgColor?: string;
                    bgColor?: string;
                    contrastRatio?: number;
                    expectedContrastRatio?: string;
                  };
                }[];
              }[];
            }[];
          }>;
        };
      }
    ).axe;
    const result = await runner.run(document);
    return result.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => ({
        id: v.id,
        impact: v.impact ?? 'unknown',
        nodes: v.nodes.map((n) => n.target.map((t) => String(t)).join(' ')),
        contrast: v.nodes.flatMap((n) =>
          (n.any ?? []).flatMap((c) =>
            c.data?.fgColor !== undefined &&
            c.data.bgColor !== undefined &&
            c.data.contrastRatio !== undefined
              ? [
                  {
                    fg: c.data.fgColor,
                    bg: c.data.bgColor,
                    ratio: c.data.contrastRatio,
                    required: Number.parseFloat(
                      c.data.expectedContrastRatio ?? '0',
                    ),
                  },
                ]
              : [],
          ),
        ),
      }));
  });
}
