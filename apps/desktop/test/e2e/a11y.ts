/**
 * s8 Sc17 — the three things an a11y checkpoint needs that nothing else has.
 *
 * `axe.ts` (Sc15) runs the static rule engine. This file adds what a rule
 * engine cannot answer:
 *
 *  - **The COMPUTED accessibility tree**, read out of Chromium over CDP.
 *    Asserting on ARIA attributes proves only that we wrote what we wrote;
 *    the attribute is the input and the tree is the output, and every
 *    interesting failure lives in the gap. A `role="option"` whose parent
 *    stopped being a `listbox` still HAS its attribute and is no longer an
 *    option to a screen reader. `page.accessibility` was removed from
 *    playwright-core by 1.63 (probed: `undefined`), so the protocol is the
 *    supported route rather than a workaround.
 *  - **Colour arithmetic.** WCAG contrast over values RESOLVED by the
 *    browser, so a token that arrives through three `var()` hops is judged
 *    as the number it paints as.
 *  - **Pixels.** Reduced transparency has no getter on this Electron (there
 *    is no `getVibrancy` on a window here — probed: `undefined`), so the
 *    honest observable of "the surfaces really did go opaque" is that the
 *    window LOOKS different, measured, with a floor under the difference so
 *    that a mode which quietly did nothing cannot pass.
 */
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type { ElectronApplication, Page } from 'playwright-core';

/* ── the computed accessibility tree ──────────────────────────────────── */

/** One node of Chromium's own accessibility tree, flattened. */
export interface AxNode {
  readonly nodeId: string;
  /** The COMPUTED role, which is not always the attribute's spelling. */
  readonly role: string;
  /** The COMPUTED accessible name, after the whole name-from calculation. */
  readonly name: string;
  /** Whether the tree drops this node before a screen reader sees it. */
  readonly ignored: boolean;
  readonly properties: Readonly<Record<string, string>>;
  /**
   * The idrefs a relation property RESOLVED to, which is the only place the
   * answer lives.
   *
   * A relation like `activedescendant` is typed `idref` in the protocol and
   * carries `relatedNodes`, never a scalar. Flattening it through
   * `String(value.value)` yields the empty string, so a row written against
   * `properties.activedescendant` asserts `''` and passes whether the
   * relation points at the right option, the wrong option, or nothing at
   * all. Chromium only publishes a `relatedNodes` entry once the idref
   * RESOLVES to a live node, so a cursor naming a card that scrolled out of
   * the mounted window shows up here as an empty array while the DOM
   * attribute still reads perfectly well.
   */
  readonly related: Readonly<Record<string, readonly string[]>>;
  readonly childIds: readonly string[];
}

interface RawAxValue {
  value?: unknown;
  relatedNodes?: { idref?: string; backendDOMNodeId?: number }[];
}
interface RawAxNode {
  nodeId: string;
  ignored?: boolean;
  role?: RawAxValue;
  name?: RawAxValue;
  properties?: { name: string; value?: RawAxValue }[];
  childIds?: string[];
}

/**
 * The whole tree, unfiltered.
 *
 * `getFullAXTree` rather than a filtered walk: the ignored nodes are half
 * the evidence. "The card is not in the tree" and "the card is in the tree
 * and says nothing" are different bugs and only the full tree tells them
 * apart.
 */
export async function axTree(
  app: ElectronApplication,
  page: Page,
): Promise<AxNode[]> {
  const session = await app.context().newCDPSession(page);
  try {
    await session.send('Accessibility.enable');
    const tree = (await session.send('Accessibility.getFullAXTree')) as {
      nodes: RawAxNode[];
    };
    return tree.nodes.map((n) => {
      const properties: Record<string, string> = {};
      const related: Record<string, readonly string[]> = {};
      for (const p of n.properties ?? []) {
        properties[p.name] = String(p.value?.value ?? '');
        if (p.value?.relatedNodes !== undefined)
          related[p.name] = p.value.relatedNodes.map((r) => r.idref ?? '');
      }
      return {
        nodeId: n.nodeId,
        role: String(n.role?.value ?? ''),
        name: String(n.name?.value ?? ''),
        ignored: n.ignored === true,
        properties,
        related,
        childIds: n.childIds ?? [],
      };
    });
  } finally {
    await session.detach();
  }
}

/** The nodes a screen reader would actually reach, with the given role. */
export const axByRole = (nodes: readonly AxNode[], role: string): AxNode[] =>
  nodes.filter((n) => !n.ignored && n.role === role);

/* ── contrast, over resolved colour ───────────────────────────────────── */

export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/**
 * A CSS colour as the browser resolves it.
 *
 * Custom properties are TEXT until something paints them, so the value is
 * handed to a real element and read back off `getComputedStyle`. A token
 * written `color-mix(...)`, `#abc` or three `var()` hops deep all come back
 * as the same `rgb()`/`rgba()` triple, which is the only form worth doing
 * arithmetic on.
 */
export async function resolveColour(
  page: Page,
  css: string,
): Promise<Rgba | null> {
  const text = await page.evaluate((value: string) => {
    const probe = document.createElement('span');
    probe.style.color = value;
    // Appended so custom properties inherited from `:root` are in scope; a
    // detached element resolves `var(--layer-1)` to nothing at all.
    document.body.appendChild(probe);
    const out = window.getComputedStyle(probe).color;
    probe.remove();
    return out;
  }, css);
  const nums = text.match(/-?[\d.]+/g);
  if (nums === null || nums.length < 3) return null;
  return {
    r: Number(nums[0]),
    g: Number(nums[1]),
    b: Number(nums[2]),
    a: nums.length > 3 ? Number(nums[3]) : 1,
  };
}

/*
 * There is deliberately no `contrastRatio()` here.
 *
 * Writing the WCAG arithmetic was the first instinct and it was the wrong
 * one. A ratio computed in this process is a ratio over colours THIS FILE
 * composited, which is the same class of claim as asserting the attributes
 * we wrote: it can only ever agree with its own model of the stack. axe
 * computes contrast from the colours the BROWSER resolved, walking the real
 * background stack, and reports `fgColor`/`bgColor`/`contrastRatio` on the
 * node — so the judgement is made where the pixels are. Under the two
 * translucent variants axe declines to judge at all, because it reaches the
 * root with the stack unterminated and assumes a white canvas that this
 * window does not have; that is why contrast is gated on the `reduced`
 * variants and why the translucent ones are judged by the alpha census
 * instead, as an equality rather than a ratio.
 */

/* ── pixels ───────────────────────────────────────────────────────────── */

export interface PixelDiff {
  readonly differing: number;
  readonly total: number;
  readonly ratio: number;
}

/**
 * How much two renders of the same window differ.
 *
 * Deliberately NOT a committed golden image. A reference PNG of an Electron
 * window is a hostage to the host's font stack, GPU and OS version, it is
 * regenerated by whoever it inconveniences, and a diff against it says
 * nothing about accessibility. Comparing two renders taken seconds apart on
 * ONE machine asks a question with a real answer instead: did flipping the
 * mode change anything, and is a run with the mode unchanged stable enough
 * for that to mean something.
 */
export function pixelDiff(a: Buffer, b: Buffer): PixelDiff {
  const left = PNG.sync.read(a);
  const right = PNG.sync.read(b);
  if (left.width !== right.width || left.height !== right.height)
    throw new Error(
      `size drift: ${String(left.width)}x${String(left.height)} vs ${String(right.width)}x${String(right.height)}`,
    );
  const total = left.width * left.height;
  const differing = pixelmatch(
    left.data,
    right.data,
    // No output buffer: the count is the whole answer and a diff image
    // nobody looks at is a file nobody deletes. `undefined`, not `null`,
    // because the signature is `void | Uint8Array | Uint8ClampedArray`.
    undefined,
    left.width,
    left.height,
    { threshold: 0.1 },
  );
  return { differing, total, ratio: differing / total };
}

/**
 * Every node's parent role, from the tree's own child lists.
 *
 * `role="option"` is a claim about a relationship, not about a node: an
 * option is only an option because a `listbox` owns it. The DOM cannot
 * answer that question, because a `<li role="option">` keeps its attribute
 * no matter what happens to its ancestors, and `closest('[role=listbox]')`
 * answers about the markup we wrote rather than about the widget Chromium
 * built. The computed tree reparents, drops and merges nodes, so its child
 * lists are the only place the real answer is.
 */
export function axParentRole(
  nodes: readonly AxNode[],
): ReadonlyMap<string, string> {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const out = new Map<string, string>();
  for (const n of nodes)
    for (const c of n.childIds) out.set(c, byId.get(n.nodeId)?.role ?? '');
  return out;
}

/**
 * The colour an element ACTUALLY paints, read off the rendered pixels.
 *
 * The last honest step. `getComputedStyle` reports what an element declares,
 * which for a translucent layer is not what a person sees: the token stack
 * composites over its ancestors, over the page canvas, and over whatever the
 * window itself is made of, and CSS can describe none of that. Sampling the
 * modal pixel of an element's own screenshot skips the entire argument. It
 * is the background because it is the most common colour in the box: glyph
 * coverage of a line of 11px text is a few percent, so the mode is the field
 * the glyphs sit on, whatever produced it.
 *
 * Calibrated rather than trusted: a row below samples an element whose
 * background is an opaque token and asserts the mode equals that token
 * exactly, so an instrument that returned some plausible-looking average
 * could not pass.
 */
export function modalColour(png: Buffer): Rgba {
  const img = PNG.sync.read(png);
  const counts = new Map<number, number>();
  for (let i = 0; i < img.data.length; i += 4) {
    const key =
      ((img.data[i] ?? 0) << 16) |
      ((img.data[i + 1] ?? 0) << 8) |
      (img.data[i + 2] ?? 0);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = 0;
  let seen = -1;
  for (const [key, n] of counts)
    if (n > seen) {
      seen = n;
      best = key;
    }
  return { r: (best >> 16) & 255, g: (best >> 8) & 255, b: best & 255, a: 1 };
}

/** `#rrggbb`, for a message a person can paste into a colour picker. */
export const hex = (c: Rgba): string =>
  `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/**
 * How many of a capture's pixels are not fully opaque.
 *
 * The honest observable for reduced transparency, and it needed finding.
 * There is no `getVibrancy()` on this Electron, and a ratio between two
 * renders needs a floor somebody has to choose. The alpha channel needs
 * neither: a window whose renderer root is transparent captures pixels with
 * alpha below 255, and a window whose layers have all gone opaque captures
 * none at all. Measured on this app: 3 456 277 of 3 776 000 pixels are
 * translucent with the glass on, and EXACTLY ZERO are with it off. An exact
 * zero on one side is the same shape of evidence Sc 15 wanted when it
 * asserted a lower bound — a mode that quietly did nothing cannot produce
 * it, and neither can a broken capture, because the other side is 91% of
 * the window.
 *
 * This also settles what the contrast numbers mean. Alpha below 255 at the
 * root is proof that the ancestor stack is UNTERMINATED: there is no colour
 * under the theme inside the page at all, because on macOS what is under it
 * is the window's own `NSVisualEffectView` material, which no screenshot
 * and no `getComputedStyle` can see. A contrast engine that has to assume a
 * canvas will assume white and be wrong. Where alpha is 255 the base is
 * real, known and ours, and every number computed there is a fact.
 */
export function translucentPixels(png: Buffer): number {
  const img = PNG.sync.read(png);
  let out = 0;
  for (let i = 3; i < img.data.length; i += 4)
    if ((img.data[i] ?? 255) < 255) out += 1;
  return out;
}

/** The alpha the MOST pixels of a capture carry. */
export function modalAlpha(png: Buffer): number {
  const img = PNG.sync.read(png);
  const counts = new Map<number, number>();
  for (let i = 3; i < img.data.length; i += 4) {
    const a = img.data[i] ?? 255;
    counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  let best = 255;
  let seen = -1;
  for (const [a, n] of counts)
    if (n > seen) {
      seen = n;
      best = a;
    }
  return best;
}

/**
 * How many pixels a capture has, so a census can be stated as a FRACTION.
 *
 * `translucentPixels` on its own is a number nobody can size: 3 456 277 is
 * either "almost all of them" or "a rounding error" depending on the
 * window, and a window's size is decided by the host. Dividing by this
 * makes the reduced-transparency measurement a ratio with a floor that
 * came from the measurement rather than from a preference.
 */
export function pixelCount(png: Buffer): number {
  const img = PNG.sync.read(png);
  return img.width * img.height;
}

/**
 * The least opaque pixel in a capture.
 *
 * The one number that makes "reduced transparency actually reduced the
 * transparency" a measurement instead of an opinion, because it can be
 * PREDICTED from the token sheet rather than compared against a threshold
 * somebody picked. `#app` covers the viewport and paints `--layer-1`, so
 * the thinnest point of the window is exactly that token's alpha and
 * nothing in the page is thinner. Predicting it and hitting it also proves
 * there is nothing opaque underneath: if Electron were painting a default
 * white base beneath the theme the minimum would be 255 everywhere.
 */
export function minAlpha(png: Buffer): number {
  const img = PNG.sync.read(png);
  let out = 255;
  for (let i = 3; i < img.data.length; i += 4) {
    const a = img.data[i] ?? 255;
    if (a < out) out = a;
  }
  return out;
}

/** One declaration in the loaded sheets that the browser could not honour. */
export interface DeadDeclaration {
  readonly selector: string;
  readonly property: string;
  readonly authored: string;
  readonly substituted: string;
}

export interface Legality {
  readonly dead: DeadDeclaration[];
  /** Declarations whose tokens resolved to nothing on this screen. */
  readonly unjudged: string[];
  readonly judged: number;
}

/**
 * Every `var()`-bearing declaration in the CSSOM, substituted and checked.
 *
 * `--backdrop` is a filter-function list. Assign it to `backdrop-filter` and
 * the panel blurs; assign it to `background` and the declaration is invalid
 * at computed-value time, the property silently unsets, and the element
 * paints nothing — no error, no warning, and no way for axe or a contrast
 * reader to notice, because the pixels that should have been there never
 * existed to be measured. `.confirm-scrim` shipped exactly that.
 *
 * So this asks the browser directly. For each rule it takes the AUTHORED
 * value (the CSSOM keeps `var(--backdrop)` unresolved, which is the whole
 * point), substitutes each token with its computed value on an element the
 * rule actually matches — falling back to the root, where the token sheet
 * declares everything — and asks `CSS.supports(property, value)`. A `false`
 * is a declaration that does nothing.
 *
 * Rules that match no element AND reference a token the root does not carry
 * are reported as `unjudged` rather than passed over in silence; the sweep
 * visits every screen, so a token that is only ever declared on a component
 * resolves on the screen that mounts it, and the union across the sweep is
 * asserted empty.
 */
export async function declarationLegality(page: Page): Promise<Legality> {
  return page.evaluate(() => {
    const dead: DeadDeclaration[] = [];
    const unjudged: string[] = [];
    let judged = 0;

    const VAR = /var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^()]*?)\s*)?\)/gi;

    const check = (selector: string, style: CSSStyleDeclaration): void => {
      let hosts: Element[] = [];
      try {
        hosts = Array.from(document.querySelectorAll(selector));
      } catch {
        hosts = [];
      }
      const host = hosts[0] ?? document.documentElement;
      const computed = window.getComputedStyle(host);
      // What to check, and it is NOT simply what `style` enumerates.
      //
      // A shorthand containing a `var()` is stored as a pending
      // substitution: `background: var(--backdrop)` enumerates as the nine
      // background longhands, EVERY ONE of which returns the empty string,
      // and the authored value survives only under the shorthand name. A
      // loop over `style.item(i)` therefore sees nine declarations with no
      // `var(` in them and finds nothing — which is what the first version
      // of this function did, on the one declaration it was written for.
      //
      // The owning shorthand is recovered by name rather than from a table:
      // drop one hyphenated segment at a time and take the first prefix
      // that answers. `background-position-x` → `background-position` (also
      // empty) → `background` → `var(--backdrop)`. `border-block-start-color`
      // → … → `border`. No list to fall off, and nothing to keep in step
      // with the CSS spec.
      const pending = new Map<string, string>();
      for (let i = 0; i < style.length; i += 1) {
        const property = style.item(i);
        const authored = style.getPropertyValue(property);
        if (authored !== '') {
          if (authored.includes('var(') && !property.startsWith('--'))
            pending.set(property, authored);
          continue;
        }
        const parts = property.split('-');
        for (let cut = parts.length - 1; cut > 0; cut -= 1) {
          const shorthand = parts.slice(0, cut).join('-');
          const value = style.getPropertyValue(shorthand);
          if (value === '') continue;
          if (value.includes('var(')) pending.set(shorthand, value);
          break;
        }
      }
      for (const [property, authored] of pending) {
        let missing = false;
        const substituted = authored.replace(
          VAR,
          (_m: string, name: string, fallback: string | undefined) => {
            const value = computed.getPropertyValue(name).trim();
            if (value !== '') return value;
            if (fallback !== undefined && fallback !== '') return fallback;
            missing = true;
            return '';
          },
        );
        if (missing || substituted.includes('var(')) {
          unjudged.push(`${selector} { ${property}: ${authored} }`);
          continue;
        }
        judged += 1;
        if (!CSS.supports(property, substituted))
          dead.push({ selector, property, authored, substituted });
      }
    };

    const walk = (rules: CSSRuleList): void => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule) check(rule.selectorText, rule.style);
        else if ('cssRules' in rule)
          walk((rule as unknown as { cssRules: CSSRuleList }).cssRules);
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        walk(sheet.cssRules);
      } catch {
        // A cross-origin sheet cannot be read. There are none in this app,
        // and the count below would drop to zero if one ever appeared.
      }
    }
    return { dead, unjudged, judged };
  });
}
