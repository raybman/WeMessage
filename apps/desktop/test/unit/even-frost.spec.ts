/**
 * G2 "even frost", the static half.
 *
 * The pixel row in `e2e/a11y.spec.ts` proves the panes it visits are glass.
 * This row is the ratchet for the ones it does not: every rule in the
 * component sheet that paints `--layer-0` as a background must be on a
 * short, named list, so a new pane cannot quietly come back opaque.
 *
 * The list has two kinds of member and they are kept apart on purpose:
 * CONTROLS, which sit ON the material and need a solid ground to type on,
 * and OPAQUE BY DECISION, the surfaces s8 Sc15 made opaque because an
 * operator reads them while deciding whether anything works.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP_CSS = fileURLToPath(
  new URL('../../src/renderer/app.css', import.meta.url),
);

const CONTROLS = [
  '.editor-text',
  '.rule-input',
  '.rule-select',
  '.dryrun-row',
  '.confirm-input',
  '.wiz-button',
  '#wizard-exit',
  '.wiz-card',
  '.wiz-test',
  '.wiz-input',
] as const;

const OPAQUE_BY_DECISION = [
  '#state-strip',
  '#daemon-not-found',
  '#wizard',
  '.wiz-card-pane',
] as const;

/** Panes G2 turned to glass. Each must paint `var(--pane)`. */
const PANES = [
  '#queue-pane',
  '.rules-pane',
  '.rules-detail',
  '.sched-pane',
] as const;

/** Grids whose 1px gap used to BE the hairline, over a stroke background. */
const SEAMED_GRIDS = ['.rules', '.schedule'] as const;

interface Rule {
  readonly selectors: readonly string[];
  readonly body: string;
}

/** Innermost `{…}` blocks, comments stripped. Media blocks nest, rules don't. */
export function rules(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const head = (m[1] as string).trim();
    if (head.startsWith('@')) continue;
    out.push({
      selectors: head.split(',').map((s) => s.trim()),
      body: m[2] as string,
    });
  }
  return out;
}

const background = (body: string): string | null =>
  /(?:^|[;\s])background(?:-color)?:\s*([^;]+);/.exec(body)?.[1]?.trim() ??
  null;

function opaqueOffenders(css: string): string[] {
  const allowed = new Set<string>([...CONTROLS, ...OPAQUE_BY_DECISION]);
  const out: string[] = [];
  for (const r of rules(css)) {
    if (background(r.body) !== 'var(--layer-0)') continue;
    for (const sel of r.selectors) if (!allowed.has(sel)) out.push(sel);
  }
  return out;
}

const sheet = readFileSync(APP_CSS, 'utf8');

describe('G2 even frost: the static ratchet', () => {
  it('paints --layer-0 as a ground only on the named controls and the opaque-by-decision set', () => {
    expect(opaqueOffenders(sheet)).toEqual([]);
  });

  it('every G2 pane paints var(--pane)', () => {
    const grounds = new Map<string, string | null>();
    for (const r of rules(sheet))
      for (const sel of r.selectors)
        if (background(r.body) !== null) grounds.set(sel, background(r.body));
    expect(
      Object.fromEntries(PANES.map((p) => [p, grounds.get(p) ?? null])),
    ).toEqual(Object.fromEntries(PANES.map((p) => [p, 'var(--pane)'])));
  });

  it('the seamed grids no longer paint a stroke ground behind glass panes', () => {
    for (const grid of SEAMED_GRIDS) {
      const r = rules(sheet).find((x) => x.selectors.includes(grid));
      expect(r, grid).toBeDefined();
      expect(background((r as Rule).body), grid).not.toBe('var(--stroke)');
    }
  });

  it('every allowlisted selector still exists, so the list cannot rot into a blanket pass', () => {
    const present = new Set(rules(sheet).flatMap((r) => r.selectors));
    const stale = [...CONTROLS, ...OPAQUE_BY_DECISION].filter(
      (s) => !present.has(s),
    );
    expect(stale).toEqual([]);
  });

  describe('teeth', () => {
    it('a new pane painting --layer-0 trips the ratchet', () => {
      expect(
        opaqueOffenders(
          `${sheet}\n.new-pane { padding: 0; background: var(--layer-0); }`,
        ),
      ).toEqual(['.new-pane']);
    });
    it('a grouped selector is judged per member', () => {
      expect(
        opaqueOffenders('.wiz-input,\n.sneaky { background: var(--layer-0); }'),
      ).toEqual(['.sneaky']);
    });
    it('near-miss: --layer-0 as a border or text colour is not a ground', () => {
      expect(
        opaqueOffenders(
          '.x { border-color: var(--layer-0); color: var(--layer-0); }',
        ),
      ).toEqual([]);
    });
  });
});
