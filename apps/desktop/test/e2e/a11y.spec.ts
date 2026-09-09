/**
 * s8 Sc17 ★ CHECKPOINT — the accessibility lane.
 *
 * The other two checkpoints measured speed and could not be faked because a
 * broken product cannot produce a good number: Sc8 triaged twenty drafts in
 * 2 819ms of a 60 000ms budget and stopped its clock only when three
 * independent witnesses agreed; Sc15 walked every exit state the wizard has
 * in ~2 520ms. Both derived their ratchet from the MEASURED floor and both
 * asserted a lower bound, because a run that beats the floor is a broken
 * measurement rather than a win.
 *
 * An accessibility checkpoint has the same problem in a different shape.
 * The number here is zero, and zero is what a run that scanned nothing
 * reports. So the discipline is:
 *
 *  - **Coverage is total BY CONSTRUCTION.** The surface is a
 *    `Readonly<Record<Screen, …>>` and a `Readonly<Record<WizardExit, …>>`
 *    over the product's own registries. A seventh screen does not compile;
 *    a ninth exit does not compile. Nothing here is a hand-written list a
 *    future screen can quietly fall off.
 *  - **Every driver proves it arrived.** Reaching a state is asserted from
 *    the document (`data-screen`, `data-exit`, a witness selector) before
 *    anything is scanned. A driver that silently landed on the default
 *    screen would otherwise scan the queue fifteen times and call it total.
 *  - **Every zero is proved non-vacuous.** A violation is planted and the
 *    row is watched going red; a green is planted and the sweep is watched
 *    catching it; the element and colour census is asserted to have a floor
 *    under it. An empty result is only evidence when the instrument has
 *    just been shown to be capable of a non-empty one.
 *  - **No rule is ever switched off.** Sc15 ran axe for the first time and
 *    it found a real defect immediately (`#state-strip` was translucent,
 *    axe assumes a white canvas under it, `--tint` came out 2.42:1). It was
 *    fixed by putting the strip on an opaque layer, not by filtering the
 *    rule, and `test/arch.spec.ts` row 15 bans the alternative in raw text.
 *
 * WHAT THIS FILE CANNOT PROVE, said plainly. It does not drive VoiceOver.
 * Nothing here launches the macOS screen reader, sends it a rotor gesture
 * or reads what it spoke; that needs Accessibility permission, a real
 * session and an AppleScript bridge, and none of it survives CI. What it
 * proves instead is the layer VoiceOver consumes: Chromium's own COMPUTED
 * accessibility tree, read over CDP, which is what the platform hands the
 * screen reader. That is strictly more than asserting ARIA attributes —
 * attributes are the input we wrote, the tree is the output the machine
 * computed — and strictly less than driving the reader itself. Claiming the
 * latter would be exactly the sort of green this slice keeps rejecting.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SCREENS,
  WIZARD_STEPS,
  type Screen,
} from '../../src/renderer/router.js';
import {
  NOT_CHECKED_EXIT,
  WIZARD_EXITS,
  WIZARD_EXIT_SPEC,
  type WizardExit,
} from '../../src/renderer/derive/wizardExits.js';
import { scriptedProbes } from '../../../../packages/daemon/test/helpers/scripted-probes.js';
import {
  bootFixtureDaemon,
  launchApp,
  waitForConn,
  waitForConnected,
  type BootOptions,
  type FixtureDaemon,
  type LaunchedApp,
} from './harness.js';
import { axeFindings, type AxeFinding } from './axe.js';
import { resolvedColours, runtimeGreenOffenders } from './no-green-runtime.js';
import {
  axByRole,
  axParentRole,
  axTree,
  declarationLegality,
  hex,
  minAlpha,
  modalAlpha,
  modalColour,
  pixelCount,
  pixelDiff,
  resolveColour,
  translucentPixels,
  type AxNode,
  type DeadDeclaration,
  type Rgba,
} from './a11y.js';

/** The §2.2 token sheet, read as text where the CSSOM cannot answer. */
const TOKENS_CSS = fileURLToPath(
  new URL('../../src/renderer/theme/tokens.css', import.meta.url),
);

/** The component sheet, the one place that says which token goes where. */
const APP_CSS = fileURLToPath(
  new URL('../../src/renderer/app.css', import.meta.url),
);

/**
 * Every token the product ever paints TEXT with, derived from the sheet.
 *
 * The sweep below reports what it finds, and "found nothing" is only worth
 * something if it looked. The reach it needs proving is per-token, not
 * per-screen: a token can be declared, used in a hundred rules, and still
 * never render on any surface this file enters, in which case its contrast
 * was never measured and the sweep's silence about it means nothing. That
 * is not hypothetical — it is exactly the state `--warn` was in for the
 * light appearance until Sc 17, where the sweep's silence came from the
 * layers underneath it being wrong rather than from the token being right.
 *
 * Derived from `app.css`, so a token that starts being used as text on a
 * screen the sweep cannot reach fails this rather than being missed. The
 * pattern deliberately requires a word boundary before `color`, which is
 * what excludes `background-color`, `border-color`, `accent-color` and
 * `-webkit-text-fill-color`: those paint something, but not glyphs, and
 * only glyphs have a contrast requirement.
 */
const INK_TOKENS: readonly string[] = (() => {
  const css = readFileSync(APP_CSS, 'utf8');
  const found = new Set<string>();
  for (const m of css.matchAll(/(?:^|[\s;{])color:\s*var\((--[a-z0-9-]+)\)/g))
    found.add(m[1] as string);
  return [...found].sort();
})();

/** Synthetic, and the only kind a PUBLIC repo may carry (arch row 13). */
const HANDLE = '+15550001111';
const CHAT = `iMessage;-;${HANDLE}`;
/** Long enough that nothing expires mid-sweep; the clock is still hand-driven. */
const LONG_TTL = 6_000;

/**
 * Twenty, because that is the number Sc8's checkpoint triages and the
 * number the queue's virtualization was built for. A tree row that read
 * "some options" would not notice a window that had silently shrunk.
 */
const DRAFTS = 20;

/**
 * The kill switch, as the app actually paints it.
 *
 * The first draft of this table watched `#queue [data-arming="KILLED"]`,
 * an attribute that appears nowhere under `apps/desktop/src`. It would have
 * hung for thirty seconds and failed, which is the good outcome; the bad
 * one is that a `waitForSelector` on a never-arriving element is
 * indistinguishable from a slow app. `StateStrip` is the component that
 * knows, it lives in `main.tsx` rather than inside a screen, and it spells
 * the state `data-outbound="kill-switch"` — so the witness is global, which
 * is also what makes it a fair witness for the settings screen's copy of
 * the same state.
 */
const KILLED = '#state-strip[data-outbound="kill-switch"]';

const running: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const stop of running.splice(0).reverse()) {
    try {
      await stop();
    } catch {
      /* teardown is best-effort by design */
    }
  }
});

/* ── the four rendering variants ──────────────────────────────────────── */

/**
 * Colour scheme x transparency, and both halves are pinned rather than
 * inherited.
 *
 * Sc4's precedent: the host Mac's automatic appearance switch made a colour
 * row pass at 02:00 and fail at 09:00, so the scheme is set explicitly on
 * every variant and never left to the machine.
 *
 * Transparency is NOT set with `emulateMedia`, and the reason is stronger
 * than "it did not work". playwright-core 1.63's `emulateMedia` accepts
 * exactly five options — `colorScheme`, `contrast`, `forcedColors`, `media`
 * and `reducedMotion` — and reduced transparency is not among them, so
 * `@media (prefers-reduced-transparency: reduce)` is not merely unreliable
 * from a test, it is structurally unreachable. That is precisely why the
 * product declares the same swap twice: once under the media query, for the
 * first paint before any IPC has happened, and once under
 * `:root[data-reduced-transparency]`, which main can drive. The attribute
 * branch is exercised here through the SAME path production uses:
 * `nativeTheme` -> main's theme module -> the theme channel -> the root
 * attribute. A row below parses the sheet and asserts the two branches
 * declare the same thing, so the branch a test cannot reach is not a branch
 * a test cannot trust.
 */
interface Variant {
  readonly id: string;
  readonly scheme: 'dark' | 'light';
  readonly reduced: boolean;
}
const VARIANTS: readonly Variant[] = [
  { id: 'dark/transparent', scheme: 'dark', reduced: false },
  { id: 'dark/reduced', scheme: 'dark', reduced: true },
  { id: 'light/transparent', scheme: 'light', reduced: false },
  { id: 'light/reduced', scheme: 'light', reduced: true },
];

/**
 * The variant in which a contrast number is a fact rather than a guess.
 *
 * Anything that wants to assert "axe found nothing" as a PRECONDITION has to
 * say it somewhere axe can be right. Under a translucent variant axe reaches
 * the root with the background stack unterminated and assumes a white canvas,
 * which on this window is false, so a zero there is not a clean bill of
 * health and a non-zero there is not a defect. Derived from the table rather
 * than written as `VARIANTS[1]`, so reordering the table cannot silently move
 * this to a variant that cannot judge.
 */
const JUDGEABLE: Variant = (() => {
  const v = VARIANTS.find((c) => c.reduced);
  if (v === undefined) throw new Error('no reduced variant to judge in');
  return v;
})();

/**
 * The same, under a LIGHT appearance.
 *
 * `--danger` is one token for both schemes and it is the light one that is
 * marginal: #ff453a scores 3.13:1 on the light `--layer-0` and 4.5:1 is the
 * threshold for normal text, so the only reason the sweep is green is that
 * every element painting it is LARGE, where axe's threshold is 3:1. That is
 * a real pass with 0.13 to spare, and the row at the bottom of this file is
 * what stops a font-size edit spending it. Derived by predicate, like the
 * one above, so the table can be reordered.
 */
const LIGHT_JUDGEABLE: Variant = (() => {
  const v = VARIANTS.find((c) => c.reduced && c.scheme === 'light');
  if (v === undefined) throw new Error('no reduced light variant to judge in');
  return v;
})();

/** The ids of every variant painted under a light appearance. */
const LIGHT_IDS: ReadonlySet<string> = new Set(
  VARIANTS.filter((v) => v.scheme === 'light').map((v) => v.id),
);

async function applyVariant(app: LaunchedApp, v: Variant): Promise<void> {
  await app.page.emulateMedia({ colorScheme: v.scheme });
  await app.app.evaluate((_electron, reducedTransparency: boolean) => {
    (
      globalThis as unknown as {
        __wmPushTheme(patch: { reducedTransparency: boolean }): void;
      }
    ).__wmPushTheme({ reducedTransparency });
  }, v.reduced);
  await app.page.waitForSelector(
    `html[data-reduced-transparency="${v.reduced ? 'on' : 'off'}"]`,
    { timeout: 30_000 },
  );
  // The scheme half has no attribute to wait on, so it is asserted from the
  // query the sheet itself branches on. Without this a variant that failed
  // to apply would scan the previous scheme twice and report four variants.
  expect(
    await app.page.evaluate(
      () => window.matchMedia('(prefers-color-scheme: dark)').matches,
    ),
    `${v.id}: the colour scheme did not take`,
  ).toBe(v.scheme === 'dark');
  await settle(app);
}

/**
 * Wait for the paint to STOP moving.
 *
 * `#app` transitions its background over `--dur-base`, and Sc 4 already
 * learned that a single read lands somewhere on the interpolation. This is
 * the same lesson for a whole-document instrument: the first version of
 * this sweep reported a contrast finding on `#queue-count` in one variant
 * and not the other three, because axe measured a colour that was still
 * moving. `getAnimations()` is the browser's own answer to "is anything
 * still animating", so it is polled rather than slept on — the no-timer
 * rule holds in this file too, and there is not one `setTimeout` in it.
 */
async function settle(app: LaunchedApp): Promise<void> {
  await app.page.waitForFunction(
    () =>
      document.getAnimations().filter((a) => a.playState === 'running')
        .length === 0,
    undefined,
    { timeout: 30_000 },
  );
}

/* ── one scan ─────────────────────────────────────────────────────────── */

/** Everything one (surface, variant) pair yields, so the caller can print it. */
/**
 * One element painting the danger ink, and the two facts axe judges it by.
 */
interface DangerInk {
  readonly path: string;
  /** Computed `font-size`, in px. */
  readonly px: number;
  /** Computed `font-weight`, as a number. */
  readonly weight: number;
  /** Whether axe would treat this text as LARGE, and so judge it at 3:1. */
  readonly large: boolean;
  /** The text it paints, trimmed. */
  readonly text: string;
}

/**
 * Every rendered element whose own text is painted in the danger token.
 *
 * The ink is RESOLVED by the browser, not parsed here: a probe element is
 * given `color: var(--danger)`, its computed `color` is read back, and the
 * probe is removed before the walk begins. That is one triple to compare
 * against, it survives the token being re-authored in any notation the
 * platform accepts, and it means this file holds no second opinion about
 * what `--danger` is.
 *
 * Only elements that own a non-empty TEXT node are kept, and only ones the
 * layout actually placed. An element that inherits the colour but paints no
 * characters has no contrast to judge, and counting it would put rows in
 * the census that no threshold could ever apply to — a census with vacuous
 * members is a census whose emptiness check means nothing.
 *
 * `large` mirrors axe: 18pt, or 14pt at weight 700 and above, converted
 * from px at 0.75 rather than written as 24 and 18.66, so the two magic
 * numbers in the WCAG text are the two numbers that appear here.
 */
async function dangerInk(
  app: LaunchedApp,
): Promise<{ token: string; ink: string; found: readonly DangerInk[] }> {
  return app.page.evaluate(() => {
    const token = window
      .getComputedStyle(document.documentElement)
      .getPropertyValue('--danger')
      .trim();
    const probe = document.createElement('span');
    probe.style.color = 'var(--danger)';
    document.body.appendChild(probe);
    const ink = window.getComputedStyle(probe).color;
    probe.remove();
    const describe = (el: Element): string => {
      const parts: string[] = [];
      for (let n: Element | null = el; n !== null; n = n.parentElement) {
        const id = n.id === '' ? '' : `#${n.id}`;
        parts.unshift(`${n.tagName.toLowerCase()}${id}`);
      }
      return parts.join('>');
    };
    const found: DangerInk[] = [];
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const style = window.getComputedStyle(el);
      if (style.color !== ink) continue;
      const owns = Array.from(el.childNodes).some(
        (n) =>
          n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '',
      );
      if (!owns || el.getClientRects().length === 0) continue;
      const px = Number.parseFloat(style.fontSize);
      const weight = Number.parseFloat(style.fontWeight);
      const pt = px * 0.75;
      found.push({
        path: describe(el),
        px,
        weight,
        large: pt >= 18 || (pt >= 14 && weight >= 700),
        text: (el.textContent ?? '').trim(),
      });
    }
    return { token, ink, found };
  });
}

interface Scan {
  readonly surface: string;
  readonly variant: string;
  readonly findings: readonly AxeFinding[];
  readonly greens: readonly string[];
  /** How many resolved colour declarations the sweep actually looked at. */
  readonly colours: number;
  /** How many elements the document had when it looked. */
  readonly elements: number;
  /** Declarations the browser could not honour. */
  readonly dead: readonly DeadDeclaration[];
  /** Declarations whose tokens resolved to nothing on THIS surface. */
  readonly unjudged: readonly string[];
  /** How many `var()`-bearing declarations were actually judged. */
  readonly judged: number;
  /** Every distinct resolved `color` this surface actually painted. */
  readonly inks: readonly string[];
  /** Every element painting the danger ink, at the size axe judges it at. */
  readonly danger: readonly DangerInk[];
}

const scans: Scan[] = [];

/**
 * Scan one surface, having first proved the surface is on screen.
 *
 * The witness is checked HERE rather than only in the driver, because the
 * driver and the scan are separated by a variant flip: a theme change that
 * unmounted the state would leave the driver's own `waitForSelector` a
 * true statement about a moment that has passed. The scan asserts what was
 * true when the instruments ran.
 */
async function scan(
  app: LaunchedApp,
  surface: string,
  v: Variant,
  witness: string,
): Promise<Scan> {
  expect(
    await app.page.locator(witness).count(),
    `${surface} @ ${v.id}: witness ${witness} matched nothing`,
  ).toBeGreaterThan(0);
  // Sequential, not a destructured array literal: `[await a, await b]` is a
  // union-typed array rather than a tuple, and each instrument perturbs the
  // document (axe injects a script) in ways the next one must see settled.
  const findings = await axeFindings(app.page);
  const greens = await runtimeGreenOffenders(app.page);
  const census = await resolvedColours(app.page);
  const colours = census.length;
  // `color` alone: Chromium normalises it to an `rgb()`/`rgba()` triple, and
  // the coverage row below compares triples. Custom properties come back as
  // whatever text was authored, which is why they are not the witness here
  // even though the census carries them.
  const inks = [
    ...new Set(
      census.filter((c) => c.property === 'color').map((c) => c.value),
    ),
  ];
  const elements = await app.page.evaluate(
    () => document.querySelectorAll('*').length,
  );
  // Rides this walk rather than a second one: the row that judges it is at
  // the bottom of this file and it reads what the sweep already saw, which
  // is what makes it a census of the PRODUCT rather than of a typed list.
  const danger = await dangerInk(app);
  expect(
    danger.token,
    `${surface} @ ${v.id}: --danger resolves to nothing`,
  ).not.toBe('');
  const legality = await declarationLegality(app.page);
  const out = {
    surface,
    variant: v.id,
    findings,
    greens,
    colours,
    elements,
    dead: legality.dead,
    unjudged: legality.unjudged,
    judged: legality.judged,
    inks,
    danger: danger.found,
  };
  scans.push(out);
  return out;
}

/**
 * Assert one scan's colour rows, with a message that names its surface.
 *
 * The axe findings are deliberately NOT asserted here. They go through
 * `triage`, which is the only place that knows whether this variant can
 * judge a contrast number, and the sweep collects the verdicts and asserts
 * them once at the end — a checkpoint that stops at the first defect
 * reports one defect, and the job of this one is to report all of them.
 */
function expectClean(s: Scan): void {
  expect(s.greens, `${s.surface} @ ${s.variant}`).toEqual([]);
  // A sweep that walked an empty document also reports no green, so the
  // census needs a floor — and the floor is DERIVED rather than picked.
  // Every element resolves a non-empty `color`, always, so a census that
  // really visited every element cannot return fewer entries than the
  // document has elements. A number chosen by looking at last run's output
  // would drift the moment a screen got smaller; this one is a fact about
  // CSS. (Measured, for scale: ~36 declarations per element.)
  expect(
    s.elements,
    `${s.surface} @ ${s.variant} had no elements`,
  ).toBeGreaterThan(0);
  expect(
    s.colours,
    `${s.surface} @ ${s.variant} scanned ${String(s.colours)} colours over ${String(s.elements)} elements`,
  ).toBeGreaterThanOrEqual(s.elements);
  // A declaration the browser threw away paints nothing, and a thing that
  // was never painted is a thing no contrast reader and no screenshot can
  // find missing. `--backdrop` is a filter list; `background: var(--backdrop)`
  // is invalid at computed-value time and unsets silently.
  expect(
    s.dead.map(
      (d) =>
        `${d.selector} { ${d.property}: ${d.authored} } → ${d.substituted}`,
    ),
    `${s.surface} @ ${s.variant}: the browser could not honour these`,
  ).toEqual([]);
  // And a floor, for the same reason the colour census has one: a legality
  // check that resolved nothing also reports nothing dead.
  expect(
    s.judged,
    `${s.surface} @ ${s.variant} judged no var() declarations at all`,
  ).toBeGreaterThan(0);
}

/* ── the surface, enumerated from the product's own registries ────────── */

interface Sweep {
  readonly app: LaunchedApp;
  readonly fixture: FixtureDaemon;
  /**
   * `id:state` for every draft this sweep SEEDED, filled in by the queue's
   * own `populated` state. Recorded as a pair rather than an id because the
   * INV-2 row at the end compares states, and a list of ids would let a
   * seeded draft be approved during the sweep without anything noticing.
   */
  readonly seeded: string[];
  readonly ruleId: string;
  readonly scheduleId: string;
}

/**
 * One MATERIAL state of one screen: how to get there, and how to know.
 *
 * `witness` is not decoration. A driver that pressed a stroke the app
 * ignored would leave the sweep on the previous screen, scan it again and
 * report a clean run over a surface it never visited — the exact vacuous
 * green this checkpoint exists to make impossible. So arrival is asserted
 * from the document twice: `data-screen` for the screen, `witness` for the
 * state within it.
 */
interface SurfaceState {
  readonly id: string;
  readonly enter: (s: Sweep) => Promise<void>;
  /** A selector that exists in THIS state and not in the screen's default. */
  readonly witness: string;
  /** Undo anything `enter` did that the next state must not inherit. */
  readonly leave?: (s: Sweep) => Promise<void>;
}

const KEY: Readonly<Record<Screen, string>> = {
  queue: 'Meta+Digit1',
  rules: 'Meta+Digit2',
  schedule: 'Meta+Digit3',
  people: 'Meta+Digit4',
  audit: 'Meta+Digit5',
  settings: 'Meta+Digit6',
};

async function go(s: Sweep, screen: Screen): Promise<void> {
  const at = await s.app.page.getAttribute('html', 'data-screen');
  if (at !== screen) await s.app.page.keyboard.press(KEY[screen]);
  await s.app.page.waitForSelector(`html[data-screen="${screen}"]`, {
    timeout: 30_000,
  });
}

/**
 * Wait for the store to report EXACTLY `n` rows, and say what it saw instead.
 *
 * The budget is unchanged and there is no retry. What is added is the
 * sentence the failure prints, and the reason is a run of this file on a
 * hosted macOS runner that reported, in full:
 *
 *   TimeoutError: page.waitForSelector: Timeout 30000ms exceeded.
 *   Call log:
 *     - waiting for locator('html[data-store-rows="20"]') to be visible
 *
 * Nine words, and every distinct fault below produces exactly those nine:
 *
 *   the daemon never got the drafts        (a seeding failure)
 *   the daemon has them, the store is behind   (a stream or replay failure)
 *   the store has MORE than n              (a surface leaked state into this
 *                                           one, and `="20"` is an equality)
 *   the stream is down                     (nothing will arrive, ever)
 *   the store knows it is stale            (the refetch is the thing failing)
 *
 * The first is our bug in the fixture, the second and fifth are our bug in
 * the renderer, the third is our bug in the registry above, and the fourth is
 * the runner's. Telling them apart cost one CI round trip per guess, on a
 * failure that does not reproduce on developer hardware — the same shape, and
 * the same cost, as the silent `launchApp: no window` this suite already
 * learned to make talk.
 *
 * So on the way out the store is asked what it thinks, and the DAEMON is
 * asked what is true. Those two numbers together name the fault. The original
 * error is kept as `cause` so the Playwright call log is not thrown away.
 */
const rows = async (s: Sweep, n: number): Promise<void> => {
  try {
    await s.app.page.waitForSelector(`html[data-store-rows="${String(n)}"]`, {
      timeout: 30_000,
    });
  } catch (cause) {
    throw new Error(await whyNoRows(s, n), { cause });
  }
};

/**
 * The sentence `rows` prints when it gives up. Never throws itself: this runs
 * on a path that is already failing, and a diagnostic that dies while
 * explaining a death replaces the message with its own.
 */
async function whyNoRows(s: Sweep, want: number): Promise<string> {
  const seen = await s.app.page
    .evaluate(() => {
      const d = document.documentElement.dataset;
      return {
        rows: d['storeRows'] ?? '(unset)',
        missed: d['storeMissed'] ?? '(unset)',
        stale: d['storeStale'] ?? '(unset)',
        syncedAt: d['storeSyncedAt'] ?? '(never)',
        conn: d['conn'] ?? '(unset)',
        screen: d['screen'] ?? '(unset)',
        // What is DRAWN, as against what the store counts. The two are
        // written in one paint on purpose, so a disagreement here is itself
        // the finding.
        drawn: document.querySelectorAll('#queue-list [role="option"]').length,
      };
    })
    .catch((e: unknown) => `unreadable: ${String(e)}`);
  const truth = await s.fixture.directClient
    .listDrafts({})
    .then((ds) => String(ds.length))
    .catch((e: unknown) => `unreachable: ${String(e)}`);
  return [
    `the store never reported ${String(want)} rows.`,
    `document: ${JSON.stringify(seen)}`,
    `daemon holds: ${truth} draft(s); this sweep seeded ${String(s.seeded.length)}`,
  ].join(' ');
}

/**
 * Every screen, and every state of it this app can be in.
 *
 * `Readonly<Record<Screen, …>>` is the whole point: `SCREENS` is the closed
 * registry (F-113) and a seventh member makes this object fail to compile
 * rather than fail to be swept. The compiler proves the record is total
 * over the union; the row below proves the union is still the one the app
 * ships, by reading the keys back and comparing them with `SCREENS`.
 *
 * Order inside a screen is load-bearing where a state seeds or perturbs
 * something: the queue is scanned EMPTY before anything is drafted, and
 * DISCONNECTED last because severing the tee is the one thing that changes
 * what every later request can do.
 */
const SURFACES: Readonly<Record<Screen, readonly SurfaceState[]>> = {
  queue: [
    {
      id: 'empty',
      witness: '#queue-empty',
      enter: async (s) => {
        await go(s, 'queue');
        await rows(s, 0);
      },
    },
    {
      id: 'populated',
      witness: '#queue-list [role="option"]',
      enter: async (s) => {
        await go(s, 'queue');
        for (let i = 0; i < DRAFTS; i += 1) {
          const draft = await s.fixture.directClient.createDraft({
            chatGuid: CHAT,
            body: `Reply ${String(i + 1)}: confirming receipt.`,
            ttlMinutes: LONG_TTL,
          });
          s.seeded.push(`${draft.id}:${draft.state}`);
        }
        await rows(s, DRAFTS);
      },
    },
    {
      /**
       * The editor, which is the ONE place a `<textarea>` is allowed to
       * exist (an arch row pins the tag to `components/Editor.tsx`) and
       * therefore the one state in which the document has two tab stops
       * rather than one. The first draft of this row watched
       * `#queue-pane textarea`; the editor is `#queue-editor-text` inside
       * `#queue-editor` and is not a descendant of the pane, so the witness
       * matched nothing and the scan refused to run, which is the witness
       * doing exactly its job.
       */
      id: 'editing',
      witness: '#queue-editor-text',
      enter: async (s) => {
        await go(s, 'queue');
        await s.app.page.focus('#queue-list');
        await s.app.page.keyboard.press('e');
        await s.app.page.waitForSelector('#queue-editor-text', {
          timeout: 30_000,
        });
      },
      leave: async (s) => {
        await s.app.page.keyboard.press('Escape');
        await s.app.page.waitForSelector('#queue-editor', {
          state: 'detached',
          timeout: 30_000,
        });
      },
    },
    {
      id: 'kill-switched',
      witness: KILLED,
      enter: async (s) => {
        await s.fixture.directClient.setKillSwitch(true);
        await go(s, 'queue');
        await s.app.page.waitForSelector(KILLED, { timeout: 30_000 });
      },
      leave: async (s) => {
        await s.fixture.directClient.setKillSwitch(false);
        await s.app.page.waitForSelector(KILLED, {
          state: 'detached',
          timeout: 30_000,
        });
      },
    },
    {
      id: 'disconnected',
      witness: '#queue-overlay',
      enter: async (s) => {
        await go(s, 'queue');
        s.fixture.requests.sever();
        await s.app.page.waitForSelector('#queue-overlay', { timeout: 30_000 });
      },
      leave: async (s) => {
        s.fixture.requests.restore();
        await waitForConnected(s.app.page);
      },
    },
  ],
  rules: [
    {
      id: 'list',
      witness: '#rules-list',
      enter: async (s) => {
        await go(s, 'rules');
        await s.app.page.waitForSelector('html[data-rules-rows="1"]', {
          timeout: 30_000,
        });
      },
    },
    {
      id: 'detail',
      witness: '#rule-detail',
      enter: async (s) => {
        await go(s, 'rules');
        await s.app.page.click(`#rule-opt-${s.ruleId}`);
        await s.app.page.waitForSelector(
          `#rule-detail[data-rule-id="${s.ruleId}"]`,
          { timeout: 30_000 },
        );
      },
    },
  ],
  schedule: [
    {
      id: 'list',
      witness: '#sched-list',
      enter: async (s) => {
        await go(s, 'schedule');
        await s.app.page.waitForSelector('#sched-list', { timeout: 30_000 });
      },
    },
    {
      id: 'detail',
      witness: '#sched-detail',
      enter: async (s) => {
        await go(s, 'schedule');
        await s.app.page.click(`#sched-opt-${s.scheduleId}`);
        await s.app.page.waitForSelector('#sched-detail', { timeout: 30_000 });
      },
    },
  ],
  people: [
    {
      id: 'grid',
      witness: '#people-grid',
      enter: async (s) => {
        await go(s, 'people');
        await s.app.page.waitForSelector('html[data-people-rows="1"]', {
          timeout: 30_000,
        });
      },
    },
    {
      id: 'scope',
      witness: '#people-scope',
      enter: async (s) => {
        await go(s, 'people');
        // The row itself is a `role="row"` div and clicking it does
        // nothing; the ladder opens from the handle BUTTON inside it,
        // which is also the only control on the row that carries an
        // accessible name naming the contact. Clicking the row passed and
        // then the pane never arrived, which is the difference between a
        // gesture the app received and a gesture the app acted on.
        await s.app.page.click(
          `.people-row[data-key="${HANDLE}"] .people-handle`,
        );
        await s.app.page.waitForSelector('#people-scope', { timeout: 30_000 });
      },
    },
  ],
  audit: [
    {
      id: 'list',
      witness: '#audit-table',
      enter: async (s) => {
        await go(s, 'audit');
        await s.app.page.waitForSelector('.audit-open', { timeout: 30_000 });
      },
    },
    {
      id: 'drawer',
      witness: '#audit-drawer',
      enter: async (s) => {
        await go(s, 'audit');
        await s.app.page.click('.audit-open');
        await s.app.page.waitForSelector('#audit-drawer', { timeout: 30_000 });
      },
    },
  ],
  settings: [
    {
      id: 'form',
      witness: '#set-form',
      enter: async (s) => {
        await go(s, 'settings');
        await s.app.page.waitForSelector('#set-loaded', { timeout: 30_000 });
      },
    },
    {
      id: 'kill-switched',
      witness: '#kill-banner',
      enter: async (s) => {
        await s.fixture.directClient.setKillSwitch(true);
        await go(s, 'settings');
        await s.app.page.waitForSelector('#kill-banner', { timeout: 30_000 });
      },
      leave: async (s) => {
        await s.fixture.directClient.setKillSwitch(false);
        await s.app.page.waitForSelector('#kill-banner', {
          state: 'detached',
          timeout: 30_000,
        });
      },
    },
    {
      /**
       * The one modal in the app. `role="dialog"` has exactly one home
       * (`components/TypedConfirm.tsx`, pinned by an arch row), and the five
       * intents differ only in the sentence they ask for, so one mount IS
       * the component's coverage. Opening it is a local state change: the
       * `ask…` functions set a flag and paint, and nothing crosses the wire
       * until the phrase is typed and the verb pressed, neither of which
       * this sweep does.
       */
      id: 'confirm',
      witness: '#typed-confirm',
      enter: async (s) => {
        await go(s, 'settings');
        await s.app.page.click('#danger-disconnect');
        await s.app.page.waitForSelector('#typed-confirm', { timeout: 30_000 });
      },
      leave: async (s) => {
        await s.app.page.keyboard.press('Escape');
        await s.app.page.waitForSelector('#typed-confirm', {
          state: 'detached',
          timeout: 30_000,
        });
      },
    },
  ],
};

/* ── the wizard, enumerated from its own exit vocabulary ──────────────── */

interface Reached {
  readonly app: LaunchedApp;
  readonly fixture: FixtureDaemon;
}

/**
 * How to put the wizard into each exit it has, one boot each.
 *
 * The union comes from the product (`WizardExit` is
 * `link:${DownReason} | daemon:${ConnectionState}`), so the record is total
 * by the compiler and a ninth exit shipped by the daemon breaks this file
 * before it breaks an operator. The ninth KEY here is `not-checked`, which
 * Sc15 was careful to call the absence of an exit rather than an exit; it
 * is swept because an operator can be looking at it, and it is spelled
 * separately from the union for the same reason Sc15 spelled it separately.
 *
 * Each driver's arrival is checked against `#wizard-exit`'s `data-exit`,
 * which is the app's own answer, not this table's. A driver that produced
 * some OTHER exit would scan a real screen and label it wrongly, and the
 * label is what makes the coverage claim.
 */
type ExitKey = WizardExit | typeof NOT_CHECKED_EXIT;

const EXIT_DRIVERS: Readonly<Record<ExitKey, () => Promise<Reached>>> = {
  'link:no-token': async () => {
    const fixture = await bootHere();
    // A configuration directory nothing has ever written a credential to.
    const app = await launchHere(fixture, {
      configDir: mkdtempSync(join(tmpdir(), 'wm-a11y-')),
    });
    await waitForConn(app.page, 'down');
    return { app, fixture };
  },
  'link:token-rejected': async () => {
    const fixture = await bootHere();
    const app = await launchHere(fixture, {
      env: { WEMESSAGE_TOKEN: `wm${'_'}wrong` },
    });
    await waitForConn(app.page, 'down');
    return { app, fixture };
  },
  'link:unreachable': async () => {
    const fixture = await bootHere();
    fixture.requests.sever();
    const app = await launchHere(fixture);
    await waitForConn(app.page, 'down');
    return { app, fixture };
  },
  'link:stream-refused': async () => {
    const fixture = await bootHere();
    fixture.requests.rewriteOnce(
      'GET /v1/events HTTP/1.1',
      'GET /v1/events?events= HTTP/1.1',
    );
    const app = await launchHere(fixture);
    await waitForConn(app.page, 'down');
    return { app, fixture };
  },
  'daemon:unsupported': async () => reachViaProbes({ osMajor: 12 }),
  'daemon:disconnected': async () => reachViaProbes({ fda: 'eperm' }),
  'daemon:read-only': async () => reachViaProbes({ fda: 'enoent' }),
  'daemon:fully-connected': async () => reachViaProbes({}),
  'not-checked': async () => {
    const scripted = scriptedProbes();
    const fixture = await bootHere({ probes: scripted.probes });
    const app = await launchHere(fixture);
    await waitForConnected(app.page);
    // The daemon is up and the socket is fine; the PROBE is what fails.
    scripted.script.explode = true;
    await openWizard(app);
    return { app, fixture };
  },
};

async function reachViaProbes(
  script: Parameters<typeof scriptedProbes>[0],
): Promise<Reached> {
  const scripted = scriptedProbes(script);
  const fixture = await bootHere({ probes: scripted.probes });
  const app = await launchHere(fixture);
  await waitForConnected(app.page);
  await openWizard(app);
  return { app, fixture };
}

/**
 * Entry to the wizard while the link is UP — the Permissions pane's own
 * button, which is the only door the product has for it (Sc15: the wizard
 * is a mode, not a `SCREENS` member, so it has no stroke of its own).
 */
async function openWizard(app: LaunchedApp): Promise<void> {
  await app.page.keyboard.press('Meta+Digit6');
  await app.page.waitForSelector('#set-perms', { timeout: 30_000 });
  await app.page.click('#set-perms-wizard');
  await app.page.waitForSelector('#wizard', { timeout: 30_000 });
}

async function bootHere(options: BootOptions = {}): Promise<FixtureDaemon> {
  const fixture = await bootFixtureDaemon({
    clockAt: new Date().toISOString(),
    ...options,
    seed: (f) => {
      const handle = f.addHandle(HANDLE);
      f.addChat({ identifier: HANDLE, handleIds: [handle] });
      options.seed?.(f);
    },
  });
  running.push(fixture.stop);
  return fixture;
}

async function launchHere(
  fixture: FixtureDaemon,
  extra: { configDir?: string; env?: Record<string, string> } = {},
): Promise<LaunchedApp> {
  const app = await launchApp({
    configDir: extra.configDir ?? fixture.configDir,
    port: fixture.port,
    ...(extra.env === undefined ? {} : { env: extra.env }),
  });
  running.push(app.close);
  await app.page.emulateMedia({ colorScheme: 'dark' });
  return app;
}

/* ══ the rows ═════════════════════════════════════════════════════════ */

describe('s8 Sc17 — the surface is enumerated from the product, not from a list', () => {
  it('every screen and every exit the product has is in the sweep', () => {
    // The compiler already proves both records are TOTAL over their unions.
    // What it cannot prove is that the union is still the one the app
    // ships, so the keys are read back and compared with the registries —
    // the same argument `WIZARD_EXIT_SPEC` makes about itself (Sc15).
    expect(Object.keys(SURFACES).sort()).toEqual([...SCREENS].sort());
    expect(Object.keys(EXIT_DRIVERS).sort()).toEqual(
      [...WIZARD_EXITS, NOT_CHECKED_EXIT].sort(),
    );
    expect(Object.keys(WIZARD_EXIT_SPEC).sort()).toEqual([...WIZARD_EXITS]);
    expect(WIZARD_EXITS).toHaveLength(8);
    expect(Object.keys(KEY).sort()).toEqual([...SCREENS].sort());

    // Every state has a name and a witness, and no two states of a screen
    // share either — two entries with one id would silently halve coverage
    // while the count still looked right.
    const ids: string[] = [];
    const witnesses: string[] = [];
    for (const screen of SCREENS)
      for (const state of SURFACES[screen]) {
        ids.push(`${screen}/${state.id}`);
        witnesses.push(state.witness);
      }
    expect(new Set(ids).size).toBe(ids.length);
    // Distinct witnesses, because two states that watch for the same
    // element are two states that cannot tell each other apart. Asserting
    // `witness.length > 0` — which is what this row said first — is a
    // statement about the table above, not about the product; it passes on
    // a witness that matches nothing at all. The sweep asserts the witness
    // MATCHES, live, at scan time, which is the version with teeth.
    expect(new Set(witnesses).size, witnesses.join(', ')).toBe(
      witnesses.length,
    );
    // Every screen carries more than its default view, or the sweep would
    // be "six screens once each" wearing a bigger word.
    for (const screen of SCREENS)
      expect(SURFACES[screen].length, screen).toBeGreaterThan(1);
  });

  it('the wizard walk covers every step in the registry', () => {
    expect(WIZARD_STEPS).toHaveLength(6);
    // `welcome` is where the wizard opens; the other five are reached by
    // CONTINUE. The walk below asserts it landed on each in turn, so this
    // row only has to state that the registry is the thing being walked.
    // Six since the s9 Sc7 amendment added `keep-running`. The length is
    // spelled out rather than derived so that a step vanishing from the
    // registry cannot quietly shorten the walk this row is here to police.
    expect(WIZARD_STEPS[0]).toBe('welcome');
  });
});

/* ── non-vacuity: the instruments are shown to bite before they are trusted ── */

describe('s8 Sc17 — a zero that could not have been anything else', () => {
  it('axe finds a planted violation, the sweep finds a planted green, and both go quiet again', async () => {
    const fixture = await bootHere();
    const app = await launchHere(fixture);
    await waitForConnected(app.page);
    // In the variant where a contrast number means something: this block
    // asserts a CLEAN start, and under a translucent variant `color-contrast`
    // is deferred by the contract below rather than trusted, so a clean start
    // could not be claimed there. Pinning it here also means the planted
    // faint text is judged against a base the page actually paints.
    await applyVariant(app, JUDGEABLE);

    // Clean first, so the two plants below are the only difference.
    expect(await axeFindings(app.page)).toEqual([]);
    expect(await runtimeGreenOffenders(app.page)).toEqual([]);

    // The near-miss half, first, because a ban that flags everything is not
    // a ban and every empty result above would look identical under one.
    // `greenVerdict` has two clauses — a dominant green channel (g more than
    // 16 above both others) and a hue in [75, 165] at over 10% saturation —
    // and these three sit one step outside BOTH, on purpose:
    //
    //   `#0A84FF`           the only accent this product is allowed. Blue
    //                       dominates, hue 210.
    //   `rgb(218, 218, 11)` hue 60 and `rgb(11, 218, 218)` hue 180: the two
    //                       points either side of the ban where the green
    //                       channel stops being the largest. Yellow and
    //                       cyan. A guard with a wider band, or with `>=`
    //                       where the ratified rule says `>`, flags these.
    //   `rgb(140, 145, 140)` hue 120, dead centre of the band, at 3.4%
    //                       saturation. A hue-only guard flags every grey
    //                       in the app, including `--ink-dim`.
    //
    // Note what is NOT in this list: a saturated teal at hue 170, or a
    // yellow-green at hue 70. Both were tried and both are correctly GREEN
    // by the dominant-channel clause, which is the answer to "is teal
    // green" being settled by the ratified predicate rather than by taste.
    const NEAR_MISSES = [
      'rgb(10, 132, 255)',
      'rgb(218, 218, 11)',
      'rgb(11, 218, 218)',
      'rgb(140, 145, 140)',
    ] as const;
    await app.page.evaluate((colours: readonly string[]) => {
      const host = document.createElement('div');
      host.id = 'planted-near-miss';
      for (const [i, colour] of colours.entries()) {
        const el = document.createElement('span');
        el.style.color = colour;
        el.style.borderTopColor = colour;
        el.style.setProperty(`--planted-${String(i)}`, colour);
        host.appendChild(el);
      }
      document.body.appendChild(host);
    }, NEAR_MISSES);
    // Seen by the census — a near-miss the sweep never looked at proves
    // nothing at all, and this is the assertion that the widened census
    // (which now reads custom properties too) actually reaches them.
    const censused = (await resolvedColours(app.page))
      .filter((c) => c.path.includes('#planted-near-miss'))
      .map((c) => c.value);
    for (const colour of NEAR_MISSES)
      expect(censused, `${colour} was never censused`).toContain(colour);
    expect(
      censused.filter((v) => v.startsWith('rgb(')).length,
      'the custom properties on the near-miss node were not read',
    ).toBeGreaterThanOrEqual(NEAR_MISSES.length * 3);
    // ...and judged not-green.
    expect(
      await runtimeGreenOffenders(app.page),
      'the ban flagged a colour the product is allowed to ship',
    ).toEqual([]);
    await app.page.evaluate(() => {
      document.getElementById('planted-near-miss')?.remove();
    });

    // (a) A control with no accessible name. `button-name` is CRITICAL, it
    //     is the single most common real defect in a keyboard-first app,
    //     and it is exactly what an icon-only button ships as.
    await app.page.evaluate(() => {
      const el = document.createElement('button');
      el.id = 'planted-nameless';
      document.body.appendChild(el);
    });
    const nameless = await axeFindings(app.page);
    expect(nameless.map((f) => f.id)).toContain('button-name');

    // (b) Text nobody can read. `color-contrast` is SERIOUS and is the rule
    //     that caught the real `#state-strip` defect in Sc15, so proving it
    //     is live here is proving THAT row is live.
    await app.page.evaluate(() => {
      const el = document.createElement('p');
      el.id = 'planted-faint';
      el.textContent = 'CANNOT BE READ';
      el.style.color = '#7a7a7a';
      el.style.backgroundColor = '#6e6e6e';
      document.body.appendChild(el);
    });
    expect((await axeFindings(app.page)).map((f) => f.id)).toContain(
      'color-contrast',
    );

    // (c) A green nothing in the token sheet could have produced: the
    //     system green, set through the CSSOM, which is precisely the path
    //     a source scan cannot see.
    await app.page.evaluate(() => {
      document.body.style.borderTopColor = '#34c759';
    });
    const greens = await runtimeGreenOffenders(app.page);
    expect(greens.length).toBeGreaterThan(0);
    expect(greens.join('\n')).toContain('border-top-color');

    // (d) A declaration the browser will throw away, and one it will not,
    //     declared as a SHORTHAND because that is the case the legality
    //     check could not originally see: a shorthand carrying a `var()` is
    //     stored as a pending substitution and every one of its longhands
    //     reads back as the empty string, so the first version of the check
    //     walked past the exact declaration it was written to catch. The
    //     near-miss beside it is the SAME TOKEN in the property it belongs
    //     in, which must stay silent — so what is being proved is that the
    //     check judges the property, not that it dislikes a token.
    //
    //     The duration token, not the material one, and the first version
    //     of this plant used the material one and was wrong: this block
    //     runs in the judgeable variant, the judgeable variant is the
    //     reduced one, and reduced transparency sets the material token to
    //     `none`, which is a perfectly legal background. The plant passed
    //     while the product was broken and then went quiet the moment the
    //     product was fixed, for a reason that had nothing to do with
    //     either. A `<time>` is illegal as a background in every variant.
    await app.page.evaluate(() => {
      const style = document.createElement('style');
      style.id = 'planted-sheet';
      style.textContent = [
        '#planted-dead { background: var(--dur-base); }',
        '#planted-live { transition-duration: var(--dur-base); }',
      ].join('\n');
      document.head.appendChild(style);
    });
    const legality = await declarationLegality(app.page);
    expect(
      legality.dead.map(
        (d) => `${d.selector} { ${d.property}: ${d.authored} }`,
      ),
      'the legality check did not see a shorthand it cannot honour',
    ).toContain('#planted-dead { background: var(--dur-base) }');
    expect(
      legality.dead.map((d) => d.selector),
      'the legality check flagged the token in the property it belongs in',
    ).not.toContain('#planted-live');
    expect(legality.unjudged, 'a planted rule went unjudged').toEqual(
      expect.not.arrayContaining([expect.stringContaining('#planted-')]),
    );
    await app.page.evaluate(() => {
      document.getElementById('planted-sheet')?.remove();
    });

    // Removed, and both instruments fall silent — which is what makes the
    // empty results everywhere else evidence rather than absence.
    await app.page.evaluate(() => {
      document.getElementById('planted-nameless')?.remove();
      document.getElementById('planted-faint')?.remove();
      document.body.style.borderTopColor = '';
    });
    expect(await axeFindings(app.page)).toEqual([]);
    expect(await runtimeGreenOffenders(app.page)).toEqual([]);
  }, 300_000);
});

/* ── the contrast contract, which is where the base is known ──────────── */

/**
 * Whether a flagged node's own paint is opaque, measured from pixels.
 *
 * This is the whole of the "proven otherwise" clause, and it is a
 * measurement rather than a list. Axe computes contrast by walking up the
 * ancestors accumulating background colours; when it reaches the root with
 * the stack still unterminated it has to assume a canvas, and it assumes
 * white. On this app that assumption is FALSE and provably so: the window
 * carries `vibrancy: 'sidebar'`, Electron 44 propagates transparency to the
 * WebContents whenever a vibrancy is set, and the capture confirms it —
 * `html` and `body` both compute `rgba(0, 0, 0, 0)` and 91% of the window's
 * pixels come back with alpha below 255. What is actually under the theme
 * is the macOS material, which is not in the page and cannot be sampled.
 *
 * So the finding is not dismissed, it is DIRECTED. Where the node's own
 * pixels are opaque the base is ours and the number is a fact, and the row
 * fails. Where they are not, the number is axe's white assumption and the
 * claim is deferred to the same scheme's reduced-transparency variant,
 * where every pixel is opaque by construction and the identical node is
 * scanned again with a base that is real. A token pair that is genuinely
 * unreadable fails there. Nothing is filtered, no rule is disabled, no
 * selector is excluded and the scanned root is the whole document; the
 * allowlist in `apps/desktop/test/a11y-allowlist.json` stays empty, which
 * `test/arch.spec.ts` row 15 checks.
 */
async function nodeIsOpaque(
  app: LaunchedApp,
  selector: string,
): Promise<boolean> {
  const locator = app.page.locator(selector).first();
  if ((await locator.count()) === 0) return true; // gone: judge it, do not excuse it
  const shot = await locator.screenshot({ omitBackground: true });
  return modalAlpha(shot) === 255;
}

/**
 * A scan's findings, split by whether THIS variant is entitled to judge
 * them, and collapsed to root causes.
 *
 * The base-aware contrast contract, stated once. `color-contrast` needs a
 * background, and when the ancestor stack never terminates in an opaque
 * colour axe assumes a white canvas and computes a ratio against a colour
 * nothing ever painted. Under vibrancy that is every element in the window:
 * the alpha census in the reduced-transparency block below measures 91.5%
 * of pixels carrying alpha < 255 in the transparent variants and EXACTLY
 * zero in the reduced ones, so "can this variant judge a contrast number"
 * has a measured, window-wide, non-arbitrary answer: only if it is reduced.
 *
 * That is a deferral, not a dismissal, and it is only honest because the
 * DOM is identical across a state's four variants — the loop enters each
 * state ONCE and changes only the rendering, and a row below asserts the
 * element census is the same number in all four. So every node deferred in
 * a transparent variant was scanned, opaquely, in the reduced variant of
 * the same scheme. Nothing is lost; the judgement is merely made where the
 * instrument works.
 *
 * Everything that is NOT `color-contrast` is judged in every variant,
 * because alpha has no bearing on whether an attribute is allowed on a
 * role or whether a control has a name.
 *
 * `causes` is the same information keyed by what is actually WRONG. A
 * whole-product sweep reports one bad token pair as a thousand selectors,
 * and a thousand selectors is not a report. Grouping by the resolved
 * (foreground, background, ratio, requirement) tuple turned 1 625 node
 * findings into five. The mapping is total — a contrast finding whose
 * nodes carried no arithmetic falls back to its selector — so `causes`
 * being empty is exactly equivalent to `defects` being empty, and both
 * are asserted.
 */
interface Triaged {
  readonly defects: string[];
  readonly causes: string[];
  readonly deferred: string[];
}

function triage(s: Scan, v: Variant): Triaged {
  const defects: string[] = [];
  const causes: string[] = [];
  const deferred: string[] = [];
  for (const finding of s.findings) {
    const judgeable = finding.id !== 'color-contrast' || v.reduced;
    for (const node of finding.nodes) {
      const label = `${s.surface} @ ${s.variant} :: ${finding.id} [${finding.impact}] ${node}`;
      if (judgeable) defects.push(label);
      else deferred.push(`${finding.id} ${node}`);
    }
    if (!judgeable) continue;
    if (finding.contrast.length === 0)
      for (const node of finding.nodes)
        causes.push(
          `${s.variant} :: ${finding.id} [${finding.impact}] ${node}`,
        );
    else
      for (const c of finding.contrast)
        causes.push(
          `${s.variant} :: ${finding.id} :: ${c.fg} on ${c.bg} = ${c.ratio.toFixed(2)}:1, needs ${c.required.toFixed(1)}:1`,
        );
  }
  return { defects, causes: [...new Set(causes)], deferred };
}

/* ══ the sweep ════════════════════════════════════════════════════════ */

describe('s8 Sc17 — the wait that went dark in CI now says what it saw', () => {
  /**
   * The instrument, exercised. An error path nobody has ever run is a
   * liability at exactly the moment it matters: `whyNoRows` runs INSIDE a
   * `catch`, so a throw of its own would replace the failure it was written
   * to explain with a failure about itself, and the run that needed it would
   * come back with less information than before rather than more.
   *
   * `4242` is not reachable: the sweep seeds twenty and this row seeds one.
   * So the wait is guaranteed to expire, which is the point — the 30 second
   * budget is spent here on purpose, once, to prove the sentence is right.
   * The row's own ceiling is raised to accommodate that and NOTHING else;
   * the budget inside `rows` is untouched, and C-11 is about deadlines the
   * product has to meet, not about a row whose subject is a deadline
   * expiring.
   */
  it('names the store, the document and the daemon when the count never comes', async () => {
    const fixture = await bootHere();
    const app = await launchHere(fixture);
    await waitForConnected(app.page);
    const sweep: Sweep = {
      app,
      fixture,
      seeded: [],
      ruleId: '',
      scheduleId: '',
    };

    const draft = await fixture.directClient.createDraft({
      chatGuid: CHAT,
      body: 'Reply 1: confirming receipt.',
      ttlMinutes: LONG_TTL,
    });
    sweep.seeded.push(`${draft.id}:${draft.state}`);
    // The happy path first, so the row proves the wait still WORKS. Without
    // this line a `rows` that had been broken into always-throwing would
    // pass every assertion below.
    await rows(sweep, 1);

    const unreachable = 4242;
    const err = await rows(sweep, unreachable).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const said = (err as Error | null)?.message ?? '';
    expect(said).toContain(`the store never reported ${String(unreachable)}`);
    // The three numbers that split the failure space. Each is read from a
    // different place — the document, the daemon, the sweep's own ledger —
    // because the whole value of the sentence is in their disagreement.
    expect(said).toContain('"rows":"1"');
    expect(said).toContain('daemon holds: 1 draft(s)');
    expect(said).toContain('this sweep seeded 1');
    // And it ADDS to the old failure rather than replacing it: the Playwright
    // call log, which names the selector, is still reachable underneath.
    expect(String((err as { cause?: unknown }).cause)).toContain('Timeout');
  }, 120_000);
});

describe('s8 Sc17 — every screen, every state, every rendering variant', () => {
  it('scans the whole product and finds nothing an operator could not use', async () => {
    const fixture = await bootHere();
    const app = await launchHere(fixture);
    await waitForConnected(app.page);

    const rule = await fixture.directClient.createRule({
      name: 'a11y sweep',
      matcher: { kind: 'regex', pattern: '.' },
      adapterId: 'agent-one',
      priority: 40,
    });
    const schedule = await fixture.directClient.createSchedule({
      name: 'a11y window',
      timezone: 'America/Los_Angeles',
      windows: [{ days: ['mon'], start: '09:00', end: '17:00' }],
    });
    const sweep: Sweep = {
      app,
      fixture,
      seeded: [],
      ruleId: rule.rule.id,
      scheduleId: schedule.id,
    };

    const before = await fixture.directClient.listDrafts({});
    const requestsBefore = fixture.requests.requests().length;

    /**
     * Deferred contrast findings, keyed by scheme, so the reduced variant
     * of the SAME scheme can be asked to judge them. Populated by the
     * transparent variants and drained by the assertion after the loop —
     * a node that was deferred and then never judged is itself a failure.
     */
    const deferredBy = new Map<string, Set<string>>();
    const judgedBy = new Map<string, Set<string>>();
    /** Every judgeable finding in the product, collected before asserting. */
    const defects: string[] = [];
    const causes = new Set<string>();
    /**
     * The element count each surface reported, per variant. The deferral
     * contract above rests on these being equal: if flipping the theme
     * changed what is MOUNTED then a node deferred in one variant was
     * never present in the other to be judged.
     */
    const census = new Map<string, Map<string, number>>();

    /**
     * State outside, variant inside — and the nesting is load-bearing.
     *
     * The first version put the variant outside, which walked the whole
     * product four times and therefore entered every state four times.
     * That is fine for a state that only navigates and fatal for one that
     * seeds: the queue's EMPTY state waits for `data-store-rows="0"` and
     * POPULATED drafts twenty, so the second lap asked for an empty queue
     * that twenty drafts were sitting in and hung until the timeout. The
     * only ways out of that are to delete the drafts between laps, which
     * is a write this sweep must not make, or to enter each state ONCE and
     * flip the rendering underneath it. The second is also the truer test:
     * it holds the product still and changes only the appearance, which is
     * precisely the variable under study.
     */
    for (const screen of SCREENS)
      for (const state of SURFACES[screen]) {
        await state.enter(sweep);
        for (const variant of VARIANTS) {
          await applyVariant(app, variant);
          const s = await scan(
            app,
            `${screen}/${state.id}`,
            variant,
            state.witness,
          );
          const t = triage(s, variant);
          defects.push(...t.defects);
          for (const c of t.causes) causes.add(c);
          const byVariant = census.get(`${screen}/${state.id}`) ?? new Map();
          byVariant.set(variant.id, s.elements);
          census.set(`${screen}/${state.id}`, byVariant);
          const bucket = variant.reduced ? judgedBy : deferredBy;
          const set = bucket.get(variant.scheme) ?? new Set<string>();
          for (const d of t.deferred) set.add(d);
          bucket.set(variant.scheme, set);
          expectClean(s);
        }
        await state.leave?.(sweep);
      }

    // The DOM is the same in all four variants of a state. This is what
    // makes deferring a contrast finding to the opaque variant honest
    // rather than a way of never answering.
    for (const [surface, byVariant] of census)
      expect(
        [...new Set(byVariant.values())],
        `${surface}: the element count changed between variants, so the theme is remounting rather than repainting: ${[...byVariant].map(([k, n]) => `${k}=${String(n)}`).join(' ')}`,
      ).toHaveLength(1);

    // A token that is only ever declared on a component resolves on the
    // screen that mounts it and nowhere else, so `unjudged` is per-surface
    // noise and only its INTERSECTION is a real hole: a declaration no
    // screen in the whole sweep could resolve is a declaration this row
    // never actually checked, and saying so is the difference between a
    // total check and one that quietly skipped the interesting rules.
    const everUnjudged = scans
      .map((s) => new Set(s.unjudged))
      .reduce((a, b) => new Set([...a].filter((x) => b.has(x))));
    expect(
      [...everUnjudged].sort(),
      'no screen in the sweep could resolve these declarations',
    ).toEqual([]);

    // Every finding this sweep could judge, collapsed to what is actually
    // wrong, so one run says everything rather than the first thing.
    expect(
      [...causes].sort(),
      `${String(defects.length)} node-level findings across ${String(scans.length)} scans`,
    ).toEqual([]);
    expect(defects, 'causes was empty but defects was not').toHaveLength(0);

    // The reach of the zero above, stated per TOKEN rather than per screen.
    //
    // Every token `app.css` paints text with has to have been painted, in
    // every variant, somewhere in this sweep — otherwise its contrast was
    // never measured and the clean result above says nothing about it. The
    // enumeration is derived from the component sheet and the observation
    // is the resolved `color` census, so neither end is a hand-written list
    // that a token could be added outside of.
    //
    // This is not a hypothetical hole. `--warn` failed at 1.88:1 on every
    // light ground in the product and the sweep did not report it for two
    // whole runs, because the reduced-transparency branches were painting
    // dark panels under a light appearance and amber on near-black is
    // 8.27:1. One bug was hiding another, and a coverage claim measured in
    // screens rather than in tokens could not tell the difference.
    expect(
      INK_TOKENS.length,
      'no text token was derived from app.css',
    ).toBeGreaterThan(0);
    // Compared as three integers, because the two sides spell a colour
    // differently and neither spelling is wrong: the token resolves through
    // a probe element to an `Rgba`, and the census carries Chromium's own
    // serialization. `hex()` is deliberately NOT the bridge — `#0058c0`
    // re-parsed as numbers yields two of them, not three, which is the kind
    // of quiet wrongness that would make this row pass on nothing.
    const triple = (c: Rgba): string =>
      [c.r, c.g, c.b].map((v) => String(Math.round(v))).join(',');
    const parsed = (css: string): string => {
      const nums = css.match(/-?[\d.]+/g) ?? [];
      return nums
        .slice(0, 3)
        .map((n) => String(Math.round(Number(n))))
        .join(',');
    };
    const missing: string[] = [];
    for (const variant of VARIANTS) {
      await applyVariant(app, variant);
      const painted = new Set(
        scans
          .filter((sc) => sc.variant === variant.id)
          // `rgb(` and not `rgba(`, which is Chromium's way of saying the
          // alpha is 1. Fully transparent text serializes as
          // `rgba(0, 0, 0, 0)` and would otherwise stand in as a witness
          // that black had been painted, which is the opposite of true.
          .flatMap((sc) => sc.inks.filter((v) => v.startsWith('rgb(')))
          .map(parsed),
      );
      for (const token of INK_TOKENS) {
        const value = await resolveColour(app.page, `var(${token})`);
        expect(
          value,
          `${variant.id}: ${token} resolves to nothing`,
        ).not.toBeNull();
        if (!painted.has(triple(value as Rgba)))
          missing.push(`${variant.id} :: ${token}`);
      }
    }
    expect(
      missing.sort(),
      'these text tokens were never painted, so the sweep never judged them',
    ).toEqual([]);

    // Nothing may be deferred without being judged. A `color-contrast` node
    // parked in a transparent variant has to come back clean in the opaque
    // one; anything still outstanding here would be a finding this file
    // quietly lost, which is the failure mode the whole contract exists to
    // prevent. The reduced variants deferred nothing (every pixel is opaque
    // there), so these sets must be empty.
    for (const scheme of ['dark', 'light'])
      expect(
        [...(judgedBy.get(scheme) ?? [])],
        `${scheme}: a reduced-transparency variant deferred a finding, which it cannot do`,
      ).toEqual([]);

    // The coverage claim, stated as a number derived from the table rather
    // than typed in: six screens, fifteen states, four variants.
    const states = SCREENS.reduce((n, s) => n + SURFACES[s].length, 0);
    expect(scans.length).toBe(states * VARIANTS.length);
    expect(new Set(scans.map((s) => s.surface)).size).toBe(states);
    expect(new Set(scans.map((s) => s.variant)).size).toBe(VARIANTS.length);

    // INV-2, and it is the point. A sweep that drives every screen and
    // every state of a product whose whole purpose is sending messages
    // must not have sent one. Four independent witnesses.
    expect(fixture.loopback.callCount()).toBe(0);
    expect(fixture.loopback.calls()).toEqual([]);
    // Every draft in the store is one the fixture handed over or one this
    // sweep SEEDED, and each is in the state it was handed over or seeded
    // in. Seeding goes through the DIRECT client, which bypasses the tee on
    // purpose: what the tee holds is then the GUI's own traffic and nothing
    // else, which is what makes the read-only assertion below mean anything.
    //
    // The first version of this row compared the store before and after and
    // could never have passed. The queue's populated state seeds twenty
    // drafts, so the row said a sweep whose job includes rendering a full
    // queue must finish with an empty one. It went unnoticed for two runs
    // because a contrast failure earlier in the test stopped execution
    // before it — which is its own small lesson about where to put the
    // cheap assertions.
    const after = await fixture.directClient.listDrafts({});
    expect(
      after.map((d) => `${d.id}:${d.state}`).sort(),
      'a draft is not in the state the sweep found or seeded it in',
    ).toEqual(
      [...before.map((d) => `${d.id}:${d.state}`), ...sweep.seeded].sort(),
    );
    // And the row is not vacuous: a sweep that seeded nothing would compare
    // an empty store to an empty store and call it proof.
    expect(
      sweep.seeded.length,
      'the sweep seeded no drafts, so the row above compared nothing',
    ).toBe(DRAFTS);
    const written = fixture.requests
      .requests()
      .slice(requestsBefore)
      .filter((r) => r.method !== 'GET');
    expect(written.map((r) => `${r.method} ${r.url}`)).toEqual([]);
    // And the word itself, which cannot simply be banned: the audit screen
    // filters by event type and one of the event types is spelled
    // `auto.approved`, so a substring hunt finds a GET that is a READ of a
    // log. Narrowing the pattern until it stops matching would delete the
    // row, so the read is admitted and then bounded from three sides.
    const touched = fixture.requests
      .requests()
      .slice(requestsBefore)
      .filter((r) => /approve|dispatch/i.test(r.url));
    // (a) Every one of them is a read.
    expect(
      touched
        .filter((r) => r.method !== 'GET')
        .map((r) => `${r.method} ${r.url}`),
      'the sweep issued a write to a URL naming approval or dispatch',
    ).toEqual([]);
    // (b) The word appears only as a query VALUE, never in the PATH. This is
    //     the derived half and it is the one with teeth: approving a draft is
    //     `POST /v1/drafts/:id/approve`, so the word in a path is exactly the
    //     shape this row exists to catch, whatever the method.
    expect(
      touched
        .filter((r) =>
          /approve|dispatch/i.test(
            new URL(r.url, 'http://tee.invalid').pathname,
          ),
        )
        .map((r) => r.url),
      'a request PATH names approval or dispatch',
    ).toEqual([]);
    // (c) And the whole list, pinned, so a second one has to be looked at by
    //     a person rather than absorbed by a pattern.
    expect(
      [...new Set(touched.map((r) => `${r.method} ${r.url}`))].sort(),
      'the enumerated legitimate reads have changed',
    ).toEqual(['GET /v1/audit?event=auto.approved&limit=1000']);
  }, 900_000);
});

/* ══ the computed tree, which is the thing a screen reader is handed ═══ */

/**
 * ARIA attributes are the INPUT. This block reads the OUTPUT.
 *
 * Every row in this repo before Sc17 that touched accessibility asserted
 * markup: `aria-activedescendant` is set, `role="option"` is present,
 * `tabIndex={0}` is on the listbox. All of that proves only that we wrote
 * what we wrote. A screen reader never sees any of it. It sees the tree
 * Chromium COMPUTES from that markup, and the computation drops things.
 *
 * It dropped something here. `role="option"` does not allow
 * `aria-expanded` in ARIA 1.2, so Chromium refuses the attribute and the
 * property is absent from the computed node — the queue's cards have been
 * carrying an attribute that reaches nobody. The markup row that asserted
 * it was there passed the whole time. Reading the tree is what found it,
 * and axe agrees independently (`aria-allowed-attr`, critical), which is
 * the two-witness standard this slice keeps.
 *
 * `page.accessibility` was removed from playwright-core before 1.63, so
 * the tree is read over CDP directly: `Accessibility.enable` then
 * `Accessibility.getFullAXTree`, which is the same protocol the browser's
 * own devtools uses.
 */
describe('s8 Sc17 — the tree the platform computes, not the attributes we wrote', () => {
  it('is what the queue, and every other screen, actually exposes', async () => {
    const fixture = await bootHere();
    const app = await launchHere(fixture);
    await waitForConnected(app.page);
    await applyVariant(app, VARIANTS[0] as Variant);

    const ids: string[] = [];
    for (let i = 0; i < DRAFTS; i += 1)
      ids.push(
        (
          await fixture.directClient.createDraft({
            chatGuid: CHAT,
            body: `Reply ${String(i + 1)}: confirming receipt.`,
            ttlMinutes: LONG_TTL,
          })
        ).id,
      );
    await app.page.waitForSelector(
      `html[data-store-rows="${String(DRAFTS)}"]`,
      {
        timeout: 30_000,
      },
    );

    /* ── row 1: no option is focusable, anywhere in the product ──────── */

    /**
     * This, and not "there is exactly one tab stop", is the claim that is
     * true product-wide.
     *
     * The one-tab-stop invariant Sc7 pinned and Sc8's checkpoint rests on
     * is a QUEUE invariant: measured from the tree, the focusable node
     * count is 2 on the queue (the root and the listbox), 3 on rules, 2 on
     * schedule, 11 on people, 28 on audit and 21 on settings, because
     * those screens are forms and a form is made of tab stops. Writing
     * "exactly one tab stop" as a product-wide row would have been a row
     * that is false and that this file would then have had to weaken.
     *
     * What IS product-wide is the thing the invariant exists to protect:
     * no option in an ARIA listbox ever owns focus. That is the whole
     * reason the queue uses `aria-activedescendant` instead of roving
     * tabindex — the list is virtualized, and a focused option that
     * scrolls out of the mounted window unmounts under the focus ring and
     * drops focus to `<body>`, taking every subsequent keystroke with it.
     * A roving-tabindex regression would show up here as a focusable
     * option, on whichever screen someone introduced it.
     *
     * The first version of this row said "no option is focusable" flatly,
     * and it was WRONG about the product rather than the product being
     * wrong about accessibility: the audit screen's event filter is a
     * native `<select>`, and a native option is focusable because the
     * platform, not this app, owns that widget's focus. The fix is not an
     * exclusion list. It is to say which options the claim is about, using
     * the tree's own parentage: an option parented by a `listbox` is one
     * of ours, an option parented by a `MenuListPopup` is the OS's. And
     * then to pin the exception from the other side too — the number of
     * focusable options on a screen must equal the number of native
     * `<option>` elements in its DOM, so the escape hatch cannot widen by
     * one without this row noticing.
     */
    const perScreen = new Map<Screen, AxNode[]>();
    for (const screen of SCREENS) {
      await go(
        { app, fixture, seeded: ids, ruleId: '', scheduleId: '' },
        screen,
      );
      await settle(app);
      const nodes = await axTree(app.app, app.page);
      perScreen.set(screen, nodes);
      const parents = axParentRole(nodes);
      const options = axByRole(nodes, 'option');
      expect(
        options
          .filter(
            (n) =>
              parents.get(n.nodeId) === 'listbox' &&
              n.properties.focusable === 'true',
          )
          .map((n) => n.name),
        `${screen}: a listbox option owns focus, which virtualization will drop`,
      ).toEqual([]);
      expect(
        options.filter((n) => n.properties.focusable === 'true').length,
        `${screen}: focusable options should be exactly the native <select>'s`,
      ).toBe(
        await app.page.evaluate(
          () => document.querySelectorAll('select option').length,
        ),
      );
    }
    // Non-vacuous: the sweep above found options to have an opinion about.
    expect(
      axByRole(perScreen.get('queue') ?? [], 'option').length,
    ).toBeGreaterThan(0);

    /* ── row 2: the queue's single tab stop, from the tree AND the DOM ── */

    await go(
      { app, fixture, seeded: ids, ruleId: '', scheduleId: '' },
      'queue',
    );
    await settle(app);
    const queueTree = await axTree(app.app, app.page);
    expect(
      queueTree
        .filter((n) => !n.ignored && n.properties.focusable === 'true')
        .map((n) => n.role)
        .sort(),
      'the queue should expose the listbox and nothing else as focusable',
    ).toEqual(['RootWebArea', 'listbox']);
    expect(
      await app.page.evaluate(
        () =>
          [
            ...document.querySelectorAll<HTMLElement>(
              'a[href], button, input, select, textarea, [tabindex]',
            ),
          ].filter((e) => e.tabIndex >= 0).length,
      ),
      'the DOM half of the same claim',
    ).toBe(1);

    /* ── row 3: the cursor is an idref that RESOLVES, and it moves ───── */

    /**
     * `aria-activedescendant` is typed `idref` in the CDP protocol and its
     * answer lives in `relatedNodes`, never in `value.value`. The first
     * version of the helper flattened every property through
     * `String(p.value?.value ?? '')`, so this read back as `''` and a row
     * written against it would have asserted the empty string and passed
     * against a cursor pointing anywhere, or nowhere. Chromium publishes a
     * `relatedNodes` entry only once the idref RESOLVES to a live node, so
     * this row also proves the cursor names something that exists — which
     * is the failure a virtualized list actually has.
     */
    const queueListbox = axByRole(queueTree, 'listbox')[0];
    expect(queueListbox, 'the queue exposes no listbox at all').toBeDefined();
    const cursorFromTree = queueListbox?.related.activedescendant ?? [];
    expect(
      cursorFromTree,
      'the cursor did not resolve to a live node',
    ).toHaveLength(1);
    const cursorFromDom = await app.page.getAttribute(
      '#queue-list',
      'aria-activedescendant',
    );
    expect(cursorFromTree[0]).toBe(cursorFromDom);
    expect(ids).toContain(String(cursorFromDom).replace('draft-', ''));

    await app.page.focus('#queue-list');
    await app.page.keyboard.press('ArrowDown');
    await expect
      .poll(
        async () =>
          await app.page.getAttribute('#queue-list', 'aria-activedescendant'),
        { timeout: 30_000 },
      )
      .not.toBe(cursorFromDom);
    const moved = await axTree(app.app, app.page);
    const movedCursor =
      axByRole(moved, 'listbox')[0]?.related.activedescendant ?? [];
    expect(
      movedCursor,
      'the cursor moved in the DOM but not in the tree',
    ).toEqual([
      await app.page.getAttribute('#queue-list', 'aria-activedescendant'),
    ]);

    /* ── row 4: what an option's PARENT is, per the tree's own child lists ── */

    /**
     * An option whose parent stopped being a listbox still has its
     * attribute and is no longer an option to a screen reader, so the
     * parentage has to come from the tree rather than from
     * `closest('[role=listbox]')`, which answers about markup.
     *
     * The expectation is DERIVED from each screen's DOM rather than typed
     * in, because there is a legitimate near-miss: the audit screen has a
     * native `<select>`, and Chromium parents a native `<option>` under a
     * `MenuListPopup`, not under a listbox. A hand-written list of allowed
     * parents would have had to grow an exception for it; asking the DOM
     * how many of each kind exist means the row states the relationship
     * instead of the answer.
     */
    for (const screen of SCREENS) {
      await go(
        { app, fixture, seeded: ids, ruleId: '', scheduleId: '' },
        screen,
      );
      await settle(app);
      const nodes = await axTree(app.app, app.page);
      const parents = axParentRole(nodes);
      const counted = await app.page.evaluate(() => ({
        listbox: document.querySelectorAll('[role="listbox"] [role="option"]')
          .length,
        native: document.querySelectorAll('select option').length,
      }));
      const options = axByRole(nodes, 'option');
      expect(
        options.length,
        `${screen}: the tree and the DOM disagree about how many options exist`,
      ).toBe(counted.listbox + counted.native);
      const roles = [
        ...new Set(options.map((n) => parents.get(n.nodeId) ?? 'ORPHAN')),
      ].sort();
      const expected = [
        ...(counted.native > 0 ? ['MenuListPopup'] : []),
        ...(counted.listbox > 0 ? ['listbox'] : []),
      ].sort();
      expect(roles, `${screen}: option parentage`).toEqual(expected);
    }

    /* ── row 5: the state reaches a screen reader without colour ─────── */

    /**
     * §1.7 requires the status word to be uppercase and the slice bans
     * colour as the sole carrier. Both are usually checked in the DOM. The
     * question this row asks is the one that matters: does the word survive
     * the name computation and land in the accessible name, which is the
     * only thing spoken. The vocabulary is read off `data-state` rather
     * than typed here, so a seventh draft state is covered the day it
     * ships instead of the day somebody remembers this list.
     */
    await go(
      { app, fixture, seeded: ids, ruleId: '', scheduleId: '' },
      'queue',
    );
    await settle(app);
    const domStates = await app.page.evaluate(() =>
      [
        ...document.querySelectorAll<HTMLElement>(
          '[role="option"][data-state]',
        ),
      ].map((e) => (e.dataset.state ?? '').toUpperCase()),
    );
    expect(new Set(domStates).size).toBeGreaterThan(0);
    const words = [...new Set(domStates)];
    const named = axByRole(await axTree(app.app, app.page), 'option');
    expect(named.length).toBe(domStates.length);
    expect(
      named
        .filter((n) => !words.some((w) => n.name.startsWith(w)))
        .map((n) => n.name),
      `an option's accessible name does not open with one of ${words.join(', ')}`,
    ).toEqual([]);

    /* ── row 6: the attribute the tree refuses, refused at the source ── */

    /**
     * Two independent statements of the same defect. The first is about
     * the product's markup and is the one that has to change; the second
     * is about the computed tree and is what proves the first one matters
     * — an attribute Chromium drops is an attribute that was never doing
     * anything, so the markup row is not a style preference.
     */
    expect(
      await app.page.evaluate(() =>
        [...document.querySelectorAll('[role="option"][aria-expanded]')].map(
          (e) => e.id,
        ),
      ),
      'role="option" does not allow aria-expanded in ARIA 1.2',
    ).toEqual([]);
    expect(
      named.filter((n) => 'expanded' in n.properties).map((n) => n.name),
      'the computed tree kept an expanded property on an option',
    ).toEqual([]);
  }, 300_000);

  it('notices a planted option that owns focus and one that claims to expand', async () => {
    const fixture = await bootHere();
    const app = await launchHere(fixture);
    await waitForConnected(app.page);
    await applyVariant(app, VARIANTS[0] as Variant);

    // The tree instrument has no zero of its own to be non-vacuous about —
    // rows 1 and 6 above both assert an EMPTY list, which is what a broken
    // reader returns. So both are shown biting on a planted node first.
    const focusableListboxOptions = (nodes: readonly AxNode[]): string[] => {
      const parents = axParentRole(nodes);
      return axByRole(nodes, 'option')
        .filter(
          (n) =>
            parents.get(n.nodeId) === 'listbox' &&
            n.properties.focusable === 'true',
        )
        .map((n) => n.name);
    };

    const before = await axTree(app.app, app.page);
    expect(before.length, 'the tree came back empty').toBeGreaterThan(10);
    expect(focusableListboxOptions(before)).toEqual([]);

    await app.page.evaluate(() => {
      const list = document.createElement('div');
      list.id = 'planted-listbox';
      list.setAttribute('role', 'listbox');
      const opt = document.createElement('div');
      opt.id = 'planted-option';
      opt.setAttribute('role', 'option');
      opt.setAttribute('aria-expanded', 'true');
      opt.setAttribute('tabindex', '0');
      opt.textContent = 'PLANTED';
      list.appendChild(opt);
      document.body.appendChild(list);
    });

    const after = await axTree(app.app, app.page);
    expect(
      focusableListboxOptions(after),
      'row 1 did not see a focusable option inside a listbox',
    ).toEqual(['PLANTED']);
    expect(
      await app.page.evaluate(
        () =>
          document.querySelectorAll('[role="option"][aria-expanded]').length,
      ),
      'row 6 did not see the attribute',
    ).toBe(1);
    // And the tree agrees with row 6's premise: Chromium drops it.
    expect(
      axByRole(after, 'option').find((n) => n.name === 'PLANTED')?.properties,
    ).not.toHaveProperty('expanded');

    await app.page.evaluate(() => {
      document.getElementById('planted-listbox')?.remove();
    });
    const back = await axTree(app.app, app.page);
    expect(focusableListboxOptions(back)).toEqual([]);
    expect(
      await app.page.evaluate(
        () =>
          document.querySelectorAll('[role="option"][aria-expanded]').length,
      ),
    ).toBe(0);
  }, 300_000);
});

/* ══ reduced transparency, measured because the API does not exist ════ */

/**
 * The plan's row 3 for this scenario says to read `win.getVibrancy()`.
 * There is no such method on Electron 44's `BrowserWindow` — vibrancy is
 * write-only, which is precisely why `main/window.ts` mirrors what it last
 * applied into `__wmTestState.vibrancy` and why Sc4's row 4 reads that
 * mirror. Sc16 flagged the plan line; this is the scenario that had to do
 * something about it.
 *
 * `emulateMedia` cannot help either. playwright-core 1.63 accepts exactly
 * `colorScheme`, `contrast`, `forcedColors`, `media` and `reducedMotion`,
 * so `@media (prefers-reduced-transparency: reduce)` is not merely
 * unreliable to drive, it is structurally unreachable from a test. That is
 * the whole reason `tokens.css` carries the swap twice — once behind the
 * media query for the person who set the preference before the app
 * started, once behind `:root[data-reduced-transparency='on']` for main's
 * `nativeTheme` listener — and the reason one of the rows below parses the
 * sheet: the media branch has no other witness in this repo at all.
 *
 * So the observable is pixels, and the measurement is an EQUALITY rather
 * than a threshold. `#app` covers the viewport and paints `--layer-1`, so
 * the thinnest pixel in the window is predictable from the token:
 * 0.72 × 255 = 184 in dark, 0.78 × 255 = 199 in light, 1 × 255 = 255 when
 * the reduced branch swaps the token for an opaque hex. Predicting the
 * number and hitting it is a much stronger statement than "more than some
 * fraction of pixels changed", and it needs no floor anybody chose.
 */
describe('s8 Sc17 — reduced transparency, in pixels, because there is no getter', () => {
  it('turns a translucent window opaque, and says so in four independent ways', async () => {
    const fixture = await bootHere();
    const app = await launchHere(fixture);
    await waitForConnected(app.page);

    const shots = new Map<string, Buffer>();
    for (const variant of VARIANTS) {
      await applyVariant(app, variant);

      // (i) The tokens themselves. `--layer-0` is an opaque hex in both
      //     schemes already; the two glass layers are what the reduced
      //     branch replaces.
      const layers = [
        await resolveColour(app.page, 'var(--layer-0)'),
        await resolveColour(app.page, 'var(--layer-1)'),
        await resolveColour(app.page, 'var(--layer-2)'),
      ];
      expect(
        layers.map((c) => c === null),
        variant.id,
      ).toEqual([false, false, false]);
      const alphas = layers.map((c) => (c as Rgba).a);
      if (variant.reduced) expect(alphas, variant.id).toEqual([1, 1, 1]);
      else {
        expect(
          alphas[0],
          `${variant.id}: --layer-0 is opaque in every variant`,
        ).toBe(1);
        expect(alphas[1], `${variant.id}: --layer-1`).toBeLessThan(1);
        expect(alphas[2], `${variant.id}: --layer-2`).toBeLessThan(1);
      }

      // (ii) The blur token, and every element that consumes it.
      const backdrop = await app.page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue('--backdrop')
          .trim(),
      );
      const filtered = await app.page.evaluate(
        () =>
          [...document.querySelectorAll('*')].filter(
            (e) => getComputedStyle(e).backdropFilter !== 'none',
          ).length,
      );
      if (variant.reduced) {
        expect(backdrop, variant.id).toBe('none');
        expect(
          filtered,
          `${variant.id}: something still blurs its backdrop`,
        ).toBe(0);
      } else {
        expect(backdrop, variant.id).toContain('blur(');
        // Non-vacuity for the row above: the count it asserts to be zero
        // is demonstrably not always zero.
        expect(filtered, variant.id).toBeGreaterThan(0);
      }

      // (iii) The window's own material, from main's mirror of the setter.
      expect(
        await app.app.evaluate(
          () =>
            (
              globalThis as unknown as {
                __wmTestState?: { vibrancy: string | null };
              }
            ).__wmTestState?.vibrancy ?? null,
        ),
        `${variant.id}: the WINDOW's vibrancy`,
      ).toBe(variant.reduced ? null : 'sidebar');

      // (iv) The pixels, which is the only witness that owes nothing to
      //      what the stylesheet claims.
      const shot = await app.page.screenshot({ omitBackground: true });
      shots.set(variant.id, shot);
      const total = pixelCount(shot);
      const translucent = translucentPixels(shot);
      const predicted = Math.round(255 * (alphas[1] ?? 1));
      expect(
        minAlpha(shot),
        `${variant.id}: the thinnest pixel should be exactly --layer-1's alpha`,
      ).toBe(predicted);
      if (variant.reduced)
        expect(
          translucent,
          `${variant.id}: reduced transparency left ${String(translucent)} translucent pixels`,
        ).toBe(0);
      else
        expect(
          translucent / total,
          `${variant.id}: only ${String(translucent)} of ${String(total)} pixels are translucent`,
        ).toBeGreaterThan(0.5);
    }

    /* ── the diff, with its own calibration ──────────────────────────── */

    /**
     * No threshold here, deliberately. A "the render changed by at least N
     * percent" row invites the number to be lowered later, and the alpha
     * census above already carries the magnitude with an exact zero on one
     * side. What the diff adds is the two facts alpha cannot give: that
     * the instrument reads zero when nothing changed, and that the flip is
     * REVERSIBLE — a theme that could not get back to where it started
     * would be a one-way animation, and every reading taken after it would
     * be measuring the animation instead of the mode.
     */
    await applyVariant(app, VARIANTS[0] as Variant);
    const again = await app.page.screenshot({ omitBackground: true });
    expect(
      pixelDiff(shots.get('dark/transparent') as Buffer, again).differing,
      'two captures of an unchanged window differ, so nothing below means anything',
    ).toBe(0);

    await applyVariant(app, VARIANTS[1] as Variant);
    await applyVariant(app, VARIANTS[0] as Variant);
    const roundtrip = await app.page.screenshot({ omitBackground: true });
    expect(
      pixelDiff(shots.get('dark/transparent') as Buffer, roundtrip).differing,
      'the window did not come back to where it started',
    ).toBe(0);

    expect(
      pixelDiff(
        shots.get('dark/transparent') as Buffer,
        shots.get('dark/reduced') as Buffer,
      ).differing,
      'reducing transparency changed nothing on screen',
    ).toBeGreaterThan(0);

    /* ── the pixel instruments, calibrated against a known token ─────── */

    /**
     * `modalColour` claims to read the colour an element actually paints.
     * A function that returned any plausible-looking average would pass
     * every row that only ever asks it for inequalities, so it is aimed at
     * an element whose background is an opaque token and required to come
     * back with that token EXACTLY. `#state-strip` is the one chrome
     * surface in the app that is opaque, which is itself Sc15's fix.
     */
    for (const variant of VARIANTS) {
      await applyVariant(app, variant);
      const layer0 = (await resolveColour(app.page, 'var(--layer-0)')) as Rgba;
      const strip = await app.page
        .locator('#state-strip')
        .screenshot({ omitBackground: true });
      expect(hex(modalColour(strip)), `${variant.id}: #state-strip`).toBe(
        hex(layer0),
      );
      expect(
        modalAlpha(strip),
        `${variant.id}: #state-strip is the opaque surface Sc15 made it`,
      ).toBe(255);
      // And the other direction, so "opaque" is a measurement rather than
      // a constant this helper always returns: the app container is glass
      // in the transparent variants and is not in the reduced ones.
      expect(await nodeIsOpaque(app, '#app'), `${variant.id}: #app`).toBe(
        variant.reduced,
      );
    }
  }, 300_000);

  /**
   * The media-query branch of the swap has no runtime witness anywhere in
   * this repo, because playwright cannot emulate the query. This row is
   * the only thing standing between it and silent drift: if somebody fixes
   * a colour in the attribute branch and forgets the media branch, an
   * operator who set the preference in System Settings before launching
   * gets the old, unfixed rendering and nothing fails.
   *
   * Parsed from the sheet rather than read through the CSSOM for the same
   * reason: the CSSOM only ever reports the branch that currently matches.
   */
  it('declares the same swap in both branches, for every scheme', () => {
    const sheet = readFileSync(TOKENS_CSS, 'utf8');
    const block = (open: string): Record<string, string> => {
      // Exactly one, so a second copy of a branch cannot hide behind the
      // first: `indexOf` would silently read the earlier one and the later
      // one, which is the one the cascade actually applies, would go
      // unchecked. The dark attribute branch opens at column 0 and the light
      // one is indented inside its media block, which is what makes the two
      // openers distinguishable as plain strings.
      expect(
        sheet.split(open).length - 1,
        `tokens.css should hold exactly one ${JSON.stringify(open)}`,
      ).toBe(1);
      const at = sheet.indexOf(open);
      const body = sheet.slice(at + open.length, sheet.indexOf('}', at));
      const out: Record<string, string> = {};
      for (const m of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g))
        out[m[1] as string] = (m[2] as string).trim();
      return out;
    };
    // Both schemes. Until Sc 17 there was only a dark pair, both halves of it
    // agreed, and the agreement was worthless: they agreed on values that are
    // wrong under a light appearance. Parity is necessary and not sufficient,
    // so the sweep above is what judges the values and this row only judges
    // that the media path and the attribute path say the same thing.
    const pairs: readonly (readonly [string, string, string])[] = [
      [
        'dark',
        '@media (prefers-reduced-transparency: reduce) {\n  :root {',
        "\n:root[data-reduced-transparency='on'] {",
      ],
      [
        'light',
        '@media (prefers-reduced-transparency: reduce) and (prefers-color-scheme: light) {\n  :root {',
        "@media (prefers-color-scheme: light) {\n  :root[data-reduced-transparency='on'] {",
      ],
    ];
    for (const [scheme, mediaOpen, attributeOpen] of pairs) {
      const media = block(mediaOpen);
      expect(
        Object.keys(media).length,
        `the ${scheme} media branch declares nothing`,
      ).toBeGreaterThan(0);
      expect(
        block(attributeOpen),
        `the ${scheme} reduced-transparency branches have drifted`,
      ).toEqual(media);
    }
    // And the two schemes are actually different, so a future edit that
    // "unifies" them back into one set of neutrals fails here rather than
    // silently reinstating the dark-panels-under-light-ink bug.
    expect(
      block(pairs[0]?.[1] as string)['--layer-1'],
      'the two schemes declare the same layer, which is the Sc 17 bug',
    ).not.toBe(block(pairs[1]?.[1] as string)['--layer-1']);
  });
});

describe('s8 Sc17 — the light danger red passes on a precondition, so the precondition is a row', () => {
  /**
   * Why this row exists, and why the token was NOT repainted instead.
   *
   * `--danger` is #ff453a in both schemes. On the light layers it scores
   * 3.4:1. Normal text needs 4.5:1 and large text needs 3:1, so every light
   * appearance of this token passes for exactly one reason: the text is
   * large. The margin is 0.4 and a font-size edit anywhere in the sheet
   * spends it, at which point the sweep above turns red with no clue as to
   * which of twenty `color: var(--danger)` sites moved — and a reviewer
   * looking at a one-line size change has no reason to suspect contrast.
   *
   * Darkening the token was the obvious alternative and it is wrong. A red
   * dark enough for 4.5:1 on white reads brown, and a semantic colour that
   * no longer reads as danger has failed at the only job it has. The
   * contrast number is fine. What is fragile is the PRECONDITION it leans
   * on, so the precondition is asserted directly, where a violation names
   * the element and its size instead of arriving as an axe finding three
   * abstractions away.
   *
   * And there is a second, larger reason, found while writing this row.
   * axe's `color-contrast` rule SILENTLY SKIPS an element whose whole text
   * is one symbol character. The plant below proves it: `⊘` and a word,
   * same token, same background, same 14px/600, and axe reports the word
   * and says nothing at all about the glyph. So the sweep's zero is not a
   * statement about single-glyph text — it never looked. This census does,
   * which is why the exempt set below is PINNED rather than emptied: the
   * product ships exactly one such glyph, the kill-switch state marker,
   * and the row names it so that a second one cannot arrive unnoticed.
   *
   * That one is defensible and is NOT quietly excused. It is a single
   * character, it sits beside `.kill-word` which says KILLED in `--ink` at
   * full contrast, and colour is never its only carrier — the same closed
   * glyph set the state strip uses. WCAG's incidental-decoration exception
   * is the clause it lives under. It should still get `aria-hidden` so a
   * screen reader stops announcing a slashed circle, and that is a product
   * change rather than a guard, so it is written down and left for S9.
   */
  it('holds every light-mode danger ink to large text, and names the one glyph axe cannot see', async () => {
    // (a) The product, as the sweep actually found it.
    const light = scans.filter((s) => LIGHT_IDS.has(s.variant));
    expect(
      light.length,
      'this row reads the census the sweep collects: run the whole file',
    ).toBeGreaterThan(0);
    const painted = light.flatMap((s) =>
      s.danger.map((d) => ({ ...d, where: `${s.surface} @ ${s.variant}` })),
    );
    expect(
      painted.length,
      'no light-mode surface painted the danger token at all, so this row proves nothing',
    ).toBeGreaterThan(0);
    const small = painted.filter((d) => !d.large);
    // The element, not the path to it: a wrapper added three levels up is
    // not a contrast change and should not read as one. Every entry has to
    // carry an id, so an anonymous node cannot join the set unnamed.
    const leaf = (d: { readonly path: string }): string =>
      d.path.split('>').at(-1) ?? '';
    expect(
      small.map(leaf).filter((l) => !l.includes('#')),
      'danger ink at normal size on an element with no id: name it before excusing it',
    ).toEqual([]);
    expect(
      [...new Set(small.map(leaf))].sort(),
      'the set of normal-size danger sites changed; each one is text axe cannot judge, so it has to be justified here',
    ).toEqual(['span#kill-glyph']);
    // Earned, not asserted: the exemption is for ONE character, which is
    // the only thing axe's blind spot covers and the only thing the
    // adjacent word can stand in for.
    expect(
      small.map((d) => `${d.where}: ${leaf(d)} = ${JSON.stringify(d.text)}`),
      'a multi-character danger string is claiming the glyph exemption',
    ).toEqual(
      small.map((d) => `${d.where}: ${leaf(d)} = ${JSON.stringify('⊘')}`),
    );

    // (b) The plant: the whole truth table, in one place, so neither the
    //     emptiness above nor the pin above is the emptiness of a predicate
    //     that never says no.
    const fixture = await bootHere();
    const app = await launchHere(fixture);
    await waitForConnected(app.page);
    await applyVariant(app, LIGHT_JUDGEABLE);
    expect(
      await axeFindings(app.page),
      'the light appearance was not clean before the plant',
    ).toEqual([]);

    // Their own background, named as the token the 3.4:1 was computed
    // against, so what axe judges is the pairing this row is about rather
    // than whatever happened to be under the body.
    await app.page.evaluate(() => {
      const host = document.createElement('div');
      host.id = 'planted-danger';
      for (const [id, text] of [
        ['planted-glyph', '⊘'],
        ['planted-words', 'THE SAME RED, IN WORDS'],
      ] as const) {
        const el = document.createElement('span');
        el.id = id;
        el.textContent = text;
        el.style.color = 'var(--danger)';
        el.style.background = 'var(--layer-1)';
        el.style.display = 'block';
        el.style.fontWeight = '600';
        el.style.fontSize = '14px';
        host.appendChild(el);
      }
      document.body.appendChild(host);
    });
    const normal = (await dangerInk(app)).found.filter((d) =>
      d.path.includes('#planted-'),
    );
    expect(
      normal.map(
        (d) => `${d.path.split('>').at(-1) ?? ''} large=${String(d.large)}`,
      ),
      'the census did not see both plants at normal size',
    ).toEqual([
      'span#planted-glyph large=false',
      'span#planted-words large=false',
    ]);
    // axe sees ONE of the two. Same colour, same background, same size,
    // same weight — the only difference is that one of them is a single
    // symbol, and that is enough for the rule to skip it entirely.
    const judged = await axeFindings(app.page);
    expect(
      judged.flatMap((f) => f.nodes),
      'axe no longer skips single-glyph text, which is the blind spot this row exists to cover',
    ).toEqual(['#planted-words']);
    expect(
      judged.flatMap((f) => f.contrast.map((c) => `${c.ratio.toFixed(1)}:1`)),
      'the danger red is no longer the marginal number this row was written for',
    ).toEqual(['3.4:1']);

    // One property changes, on both.
    await app.page.evaluate(() => {
      for (const id of ['planted-glyph', 'planted-words']) {
        const el = document.getElementById(id);
        if (el !== null) el.style.fontSize = '24px';
      }
    });
    const big = (await dangerInk(app)).found.filter((d) =>
      d.path.includes('#planted-'),
    );
    expect(big.map((d) => d.large)).toEqual([true, true]);
    expect(
      await axeFindings(app.page),
      'axe refused the danger token at large size, which is the whole reason the sweep is green',
    ).toEqual([]);

    // And quiet again, so the finding above belonged to the plant.
    await app.page.evaluate(() => {
      document.getElementById('planted-danger')?.remove();
    });
    expect(await axeFindings(app.page)).toEqual([]);
  }, 600_000);
});
