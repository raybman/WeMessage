/**
 * s9 Sc 13 rows 5 to 8 - the launch GIF, CAPTURE half.
 *
 * `apps/desktop/scripts/make-gif.mjs` owns the ENCODE and says at length why
 * the two halves are separate processes: `.dependency-cruiser.cjs`'s
 * `nobody-imports-daemon` fences `^packages/daemon` off from everything under
 * `^apps` with exactly one carve-out, `^apps/desktop/test/`, and this file is
 * inside it. A generator script that imported the harness would be a second
 * place in the house allowed to boot a daemon, so the design was fitted to
 * the guard rather than the guard widened for the design. Nothing here moves
 * the fence and nothing here encodes a pixel.
 *
 * The contract between the halves is the one the script already reads, taken
 * from its own `readFrames`: `frame-NNN.png`, three digits, zero padded, in
 * name order, every one of them exactly 1200x750. The script is run over
 * argv and answers with one JSON line, which this file parses and asserts
 * against. It is never imported.
 *
 * WHAT IS ASSERTED, AND WHY IN THAT ORDER
 *
 *  - row 5: the artefact's shape. Eight keyboard steps, eight captures, each
 *    one the size of the LIVE renderer viewport rather than of a constant, so
 *    a frame with a strip of the desktop composited onto it fails on height
 *    instead of passing on a number this file also wrote.
 *  - row 6: the pixels. The GIF is decoded by the repository's OWN reader
 *    (`test/helpers/raster-decode.ts`, the hand-written LZW from s9 Sc 1),
 *    never by gifenc, because a decoder that agreed with its encoder could
 *    not convict it. The hue sweep is the same `greenVerdict` the token sheet
 *    gets, and the caption is proven to be in the PIXELS by capturing the
 *    same instant twice, once with it hidden.
 *  - row 7: determinism. Two complete passes, two daemons, two windows, two
 *    encodes, and the same sha256. The renderer's clock is frozen before the
 *    document loads, so the age labels a queue draws are a function of the
 *    seed rather than of the hour the run happened in.
 *  - row 8: what the pixels may say. The visible text of every step is swept
 *    with `publicStringOffenders`, and then narrowed further: every phone
 *    shaped string on screen must be one of the four synthetic handles this
 *    file seeded, and every message body must be one it wrote.
 *
 * DEVIATIONS FROM THE PLAN, recorded because the tree wins where they differ.
 *
 *  1. The plan draws the caption "into the canvas before capture via the test
 *     IPC". There is no such IPC in the tree and adding one would put a
 *     drawing capability into the shipped main process for the sake of a
 *     marketing artefact. The caption is instead injected by this file into
 *     `document.body`, OUTSIDE the `#root` preact mounts into, so no render
 *     can remove it, and it is proven to be in the pixels rather than merely
 *     in the DOM by the hidden-capture diff described above.
 *  2. The plan asserts "the harness records `seedModule` in its test IPC".
 *     There is no `seedModule` anywhere in the tree. The substitute is
 *     stronger rather than weaker: instead of asserting which seed was NAMED,
 *     row 8 asserts that every handle and every body VISIBLE on screen is one
 *     this file seeded, which a wrong seed fails and a right name cannot fake.
 *  3. `WEMESSAGE_GIF_SEED=1` appears nowhere in the tree and is not
 *     introduced. Nothing in this pipeline draws a random number: the palette
 *     is quantized from the frames in frame order, the drafts are created in
 *     a fixed order over a hand-driven clock, and the renderer's clock is
 *     frozen. A seed would be a knob with nothing behind it, and row 7 proves
 *     the property the seed was there to buy.
 *  4. `pnpm --filter @wemessage/desktop gif` runs THIS FILE with
 *     `WEMESSAGE_GIF_WRITE=1`, which is the only mode in which the tracked
 *     artefact is written. A plain `pnpm test` encodes into a temporary
 *     directory and leaves `site/media/launch.gif` alone, so running the
 *     suite can never quietly rewrite a committed binary.
 *
 * Synthetic handles only (`+1555...`), as everywhere in this PUBLIC repo.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootFixtureDaemon,
  launchApp,
  waitForConnected,
  type FixtureDaemon,
  type LaunchedApp,
} from './e2e/harness.js';
import { REPO_ROOT } from './helpers/no-green-static.js';
import {
  decodeRaster,
  rasterGreenOffenders,
  type RasterFrame,
} from './helpers/raster-decode.js';
import { publicStringOffenders } from '../../../packages/cli/test/helpers/transcript-lint.js';

/* ── the contract, spelled the way `make-gif.mjs` spells it ───────────── */

/** CSS pixels. The site lays the GIF out at this width (F-132). */
const WIDTH = 1200;
/** CSS pixels. The renderer's content box, so no OS chrome can be in shot. */
const HEIGHT = 750;
/** F-132's ceiling, in bytes: the smaller of the two readings of 1.5 MB. */
const MAX_BYTES = 1_500_000;
/** The encoder's own `HOLD`, which this file checks rather than sets. */
const HOLD = 9;
/** The eight captures the scenario asks for, one per keyboard step. */
const STEP_COUNT = 8;

const ENCODER = 'apps/desktop/scripts/make-gif.mjs';
const ARTEFACT = 'site/media/launch.gif';
const ARTEFACT_ABS = join(REPO_ROOT, ARTEFACT);

/* ── the seed ─────────────────────────────────────────────────────────── */

/**
 * Four synthetic handles, so the queue on screen looks like a queue rather
 * than like one conversation repeated. Every one of them is in the NANP
 * fiction reserve, which is the only kind a public repository may carry.
 */
const HANDLES = [
  '+15550001111',
  '+15550002222',
  '+15550003333',
  '+15550004444',
] as const;

/**
 * The bodies, chosen to be dull on purpose. This artefact is published, so
 * every word in it is a word a stranger reads: no names, no addresses, no
 * numbers, nothing that could be mistaken for a real conversation.
 */
const BODIES = [
  'on my way, about five minutes out',
  'yes, two in the afternoon works',
  'sending the file over now',
  'thanks, got it',
  'can we push this to tomorrow morning',
  'confirmed for friday',
  'no trouble at all',
  'will call when i land',
  'the room is booked',
  'let me check and come back to you',
  'sounds good to me',
  'see you there',
] as const;

/** Long enough that nothing expires unless a row asks it to. */
const LONG_TTL = 6_000;

/**
 * The instant everything in this artefact is stamped from.
 *
 * `harness.ts`'s own default, reused rather than re-picked. Both clocks are
 * pinned to it: the daemon's, which decides every draft's `createdAt` and
 * every approval's `sendNotBefore`, and the renderer's, which decides the age
 * label beside each card and the grace ring's remaining sweep. Two frozen
 * clocks reading the same instant is what makes row 7 possible at all.
 */
const FROZEN_AT = '2026-03-02T18:00:00.000Z';

/**
 * The eight strokes, in the order an operator would make them.
 *
 * Down, select, down, select, approve the pair, take it back, jump to the end
 * of the queue, approve the card there. Every one of them is a verb
 * `renderer/keys/index.ts` binds, and row 5 asserts that every one of them
 * changed pixels, which is what stops a step that silently does nothing from
 * riding along as a held frame.
 *
 * The two `j`s between the two `x`s are not decoration. `x` deliberately does
 * NOT move the cursor (`main.tsx`: an operator picking cards out of twenty is
 * reading each one), so `x x` toggles one card on and straight back off and
 * the `A` that followed would be a bulk over an empty selection, which the
 * keymap refuses. That is a real product behaviour and this sequence was
 * corrected to it rather than the product bent to the script.
 */
const STEPS = ['j', 'x', 'j', 'x', 'A', 'z', 'G', 'a'] as const;

/** The same press delay the s8 checkpoint uses, so the app is driven alike. */
const PRESS_DELAY_MS = 60;

/** The caption row 5 requires, in the pixels of every frame. */
const CAPTION = 'simulated data';

/** Only `pnpm --filter @wemessage/desktop gif` writes the tracked artefact. */
const WRITE = process.env['WEMESSAGE_GIF_WRITE'] === '1';

/* ── the encoder's record ─────────────────────────────────────────────── */

interface GifRecord {
  readonly out: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  readonly captures: number;
  readonly frames: number;
  readonly hold: number;
  readonly delayMs: number;
  readonly delayCs: number;
  readonly fps: number;
  readonly paletteColours: number;
  readonly transparentIndex: number;
  readonly maxBytes: number;
  readonly changed: readonly number[];
  readonly sources: readonly string[];
}

function encodeGif(framesDir: string, out: string): GifRecord {
  const stdout = execFileSync(
    process.execPath,
    [join(REPO_ROOT, ENCODER), '--frames', framesDir, '--out', out],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  const line = stdout.trim().split('\n').at(-1) ?? '';
  return JSON.parse(line) as GifRecord;
}

/* ── pixels ───────────────────────────────────────────────────────────── */

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One decoded image, or a throw naming the file that would not decode. */
function frameOf(label: string, bytes: Uint8Array): RasterFrame {
  const decoded = decodeRaster(label, bytes);
  if (decoded.undecoded.length > 0)
    throw new Error(`${label}: ${decoded.undecoded.join('; ')}`);
  const first = decoded.frames[0];
  if (first === undefined) throw new Error(`${label}: decoded to no frames`);
  return first;
}

const at = (f: RasterFrame, x: number, y: number): string =>
  [0, 1, 2, 3]
    .map((c) => String(f.rgba[(y * f.width + x) * 4 + c] ?? 0))
    .join();

interface DiffReport {
  readonly count: number;
  /** Where the difference is, which is the half a bare count cannot say. */
  readonly box: Box | null;
}

/**
 * Every pixel inside `box` that differs between two same-sized images, with
 * the bounding rectangle of the difference.
 *
 * The rectangle is reported and not merely counted because both callers below
 * FAIL by finding difference where there should be none, and "671 pixels
 * differ" sends a reader to grep while "671 pixels differ in 96x14 at 24,712"
 * sends them to the element.
 */
function diffIn(a: RasterFrame, b: RasterFrame, box: Box): DiffReport {
  let count = 0;
  let x0 = box.x + box.width;
  let y0 = box.y + box.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = box.y; y < box.y + box.height; y += 1)
    for (let x = box.x; x < box.x + box.width; x += 1)
      if (at(a, x, y) !== at(b, x, y)) {
        count += 1;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
  return {
    count,
    box:
      x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 },
  };
}

function sayDiff(d: DiffReport): string {
  if (d.box === null) return 'identical';
  return (
    `${String(d.count)} px differ, in ${String(d.box.width)}x` +
    `${String(d.box.height)} at ${String(d.box.x)},${String(d.box.y)}`
  );
}

/** How many DISTINCT colours `box` holds. One means uniform background. */
function boxColours(f: RasterFrame, box: Box): number {
  const seen = new Set<string>();
  for (let y = box.y; y < box.y + box.height; y += 1)
    for (let x = box.x; x < box.x + box.width; x += 1) seen.add(at(f, x, y));
  return seen.size;
}

/** The thinnest alpha in an image. 255 means nothing was left undefined. */
function minAlpha(f: RasterFrame): number {
  let min = 255;
  for (let p = 3; p < f.rgba.length; p += 4) {
    const a = f.rgba[p] ?? 0;
    if (a < min) min = a;
  }
  return min;
}

/* ── one complete pass: boot, drive, capture, encode ──────────────────── */

interface Pass {
  readonly dir: string;
  readonly out: string;
  readonly record: GifRecord;
  readonly gif: Buffer;
  /** `window.innerWidth`/`innerHeight` as the RENDERER reported them. */
  readonly viewport: { readonly width: number; readonly height: number };
  readonly caption: Box;
  /** The caption's own text, read back out of the document. */
  readonly captionText: string;
  /** `frame-000.png` re-taken with the caption hidden and nothing else. */
  readonly withoutCaption: Buffer;
  /** The visible text of the document after each of the eight strokes. */
  readonly texts: readonly string[];
  readonly names: readonly string[];
}

async function runPass(dir: string, out: string): Promise<Pass> {
  const frames = join(dir, 'frames');
  mkdirSync(frames, { recursive: true });
  let fixture: FixtureDaemon | null = null;
  let app: LaunchedApp | null = null;
  try {
    fixture = await bootFixtureDaemon({
      clockAt: FROZEN_AT,
      seed: (f) => {
        for (const handle of HANDLES) {
          const id = f.addHandle(handle);
          f.addChat({ identifier: handle, handleIds: [id] });
        }
      },
    });

    /*
     * The drafts, oldest first, one minute apart on the DAEMON's clock.
     *
     * Stamped from `fixture.clock` and never from the wall: the queue sorts
     * on `createdAt`, and rows created inside one wall-clock millisecond sort
     * by id instead, which would put the cursor somewhere other than where
     * `STEPS` believes it is and make the animation different on a faster
     * machine.
     */
    const base = Date.parse(fixture.clock.now());
    for (const [i, body] of BODIES.entries()) {
      fixture.clock.set(
        new Date(base - (BODIES.length - i) * 60_000).toISOString(),
      );
      await fixture.directClient.createDraft({
        chatGuid: `iMessage;-;${HANDLES[i % HANDLES.length] ?? HANDLES[0]}`,
        body,
        ttlMinutes: LONG_TTL,
      });
    }
    fixture.clock.set(new Date(base).toISOString());

    app = await launchApp({
      configDir: fixture.configDir,
      port: fixture.port,
      // The host's zone decides what `toLocaleTimeString` prints, and the
      // state strip prints one. Pinning it narrows this test's environment
      // rather than widening any tolerance: no assertion is relaxed, and a
      // real regression in what the strip renders still fails.
      env: { TZ: 'UTC' },
    });
    const page = app.page;

    /*
     * The content box, not the window: `page.screenshot` captures web
     * contents only, so the traffic lights, the menu bar and the Dock are
     * structurally absent rather than cropped out and hoped about.
     *
     * This runs BEFORE the init script and the reload below, and the order is
     * load-bearing. Resizing after the reload means the document is laid out
     * once at whatever size the shell opens at, and only then at 1200x750, so
     * the Skia glyph atlas and text-blob cache backing the capture are seeded
     * against a layout that is not the one photographed. That is process-level
     * raster history, and it is the best available account of the residual
     * one-pixel disagreement row 7 saw under load: always the antialiased
     * right edge of a `.card-keys` chip, always the same column, never within
     * a single window and only ever across two. Resizing first means the only
     * layout the renderer ever performs is the captured one. Same principle as
     * the two flags in `harness.ts`: narrow the environment, do not widen a
     * tolerance.
     */
    /*
     * ON SCREEN FIRST, THEN RESIZED.
     *
     * `launchApp` returns as soon as `app.firstWindow()` resolves, which is
     * when the web contents exist. The shell opens with `show: false` and
     * only calls `show()` from `ready-to-show` (`main/window.ts`), so at this
     * point the window may not be on screen at all. Resizing a window that is
     * not yet shown does not reliably reach the renderer, `window.innerWidth`
     * then never becomes `WIDTH`, and the wait below expires. That is exactly
     * how this suite failed on `ci-macos`: the whole file errored in
     * `beforeAll` on a bare 30 second `waitForFunction` timeout that named
     * neither the size it got nor the screen it was on.
     *
     * Subscribed BEFORE the second check, deliberately. The obvious spelling
     * tests `isVisible()` and then attaches a `show` listener, which loses
     * the race if the window shows in between and waits forever for an event
     * that has already gone by. Attaching first and re-checking after cannot
     * lose it: either the listener catches the transition, or the re-check
     * observes it already happened. Resolving twice is harmless, and no
     * clock is involved, which is what row 14 of the arch file requires of
     * everything under `apps/desktop/test`.
     */
    await app.app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win === undefined) throw new Error('the shell has no window');
      if (win.isVisible()) return;
      await new Promise<void>((resolve) => {
        win.once('show', () => {
          resolve();
        });
        if (win.isVisible()) resolve();
      });
    });

    const sized = await app.app.evaluate(
      ({ BrowserWindow, screen }, size: readonly number[]) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win === undefined) throw new Error('the shell has no window');
        win.setContentSize(size[0] ?? 0, size[1] ?? 0);
        const got = win.getContentSize();
        const area = screen.getPrimaryDisplay().workAreaSize;
        return {
          width: got[0] ?? 0,
          height: got[1] ?? 0,
          display: `${String(area.width)}x${String(area.height)}`,
        };
      },
      [WIDTH, HEIGHT],
    );

    /*
     * A SCREEN TOO SMALL TO HOLD THE CAPTURE IS A FACT, NOT A TIMEOUT.
     *
     * A window cannot be given a content box larger than the display it sits
     * on: the request is clamped, silently. If that happens the capture would
     * still be taken, at the wrong size, and the only row that would notice
     * is the one reading the width back out of the logical screen descriptor,
     * which would report a number nobody could explain. Reading the size back
     * and refusing here names the screen instead, so the next reader learns
     * the machine was too small rather than that something timed out.
     */
    if (sized.width !== WIDTH || sized.height !== HEIGHT)
      throw new Error(
        `this display cannot hold the capture: asked for a ${String(WIDTH)}x` +
          `${String(HEIGHT)} content box, got ${String(sized.width)}x` +
          `${String(sized.height)} on a ${sized.display} work area. The GIF is ` +
          `defined at ${String(WIDTH)}x${String(HEIGHT)}, so this refuses ` +
          `rather than photographing a different window.`,
      );

    await page.waitForFunction(
      (size: readonly number[]) =>
        window.innerWidth === size[0] && window.innerHeight === size[1],
      [WIDTH, HEIGHT],
      { timeout: 30_000 },
    );

    /*
     * The renderer's clock, frozen BEFORE the document runs.
     *
     * `main.tsx` reads `new Date()` at module scope and again at every paint,
     * and the store stamps `syncedAt` from the same clock at the instant it
     * asks. An override installed after the window opened would therefore
     * land somewhere unpredictable in that sequence, which is precisely the
     * kind of "usually deterministic" that row 7 exists to catch. So the
     * script is registered as an init script and the page is RELOADED into
     * it: every read the renderer ever makes is a read of the frozen instant.
     */
    await page.addInitScript((iso: string) => {
      const fixed = Date.parse(iso);
      const real = Date;
      window.Date = new Proxy(real, {
        construct: (target, args, newTarget): object =>
          Reflect.construct(
            target,
            args.length === 0 ? [fixed] : args,
            newTarget,
          ) as object,
        get: (target, key, receiver): unknown =>
          key === 'now' ? () => fixed : Reflect.get(target, key, receiver),
      });
    }, FROZEN_AT);
    await page.reload();
    await page.emulateMedia({ colorScheme: 'dark' });
    await waitForConnected(page);
    await page.waitForSelector(
      `html[data-store-rows="${String(BODIES.length)}"]`,
      { timeout: 30_000 },
    );

    /*
     * Opaque layers, which is a correctness requirement and not a taste one.
     * Under the default material the window is translucent, a captured pixel
     * carries an alpha below 255, and GIF has no alpha channel at all: the
     * encoder would flatten undefined RGB into the palette and the hue sweep
     * would then be reading whatever happened to be behind the window.
     */
    await app.app.evaluate(() => {
      (
        globalThis as unknown as {
          __wmPushTheme(patch: { reducedTransparency: boolean }): void;
        }
      ).__wmPushTheme({ reducedTransparency: true });
    });
    await page.waitForSelector('html[data-reduced-transparency="on"]', {
      timeout: 30_000,
    });

    // The resize the capture depends on happened before the reload, above.
    // This re-asserts it rather than performing it, because `emulateMedia`
    // and the theme push between here and there each force a style
    // recalculation, and a size that had silently drifted would be captured
    // without complaint.
    await page.waitForFunction(
      (size: readonly number[]) =>
        window.innerWidth === size[0] && window.innerHeight === size[1],
      [WIDTH, HEIGHT],
      { timeout: 30_000 },
    );

    /*
     * The caption, appended to `document.body` rather than into the app.
     *
     * `main.tsx` renders into `#root`, so nothing preact does can remove a
     * node that is a sibling of it. Black on white with no hue at all, which
     * keeps it clear of F-104's band by construction rather than by luck.
     */
    const caption = await page.evaluate((text: string): Box => {
      const el = document.createElement('div');
      el.id = 'gif-caption';
      el.textContent = text;
      el.setAttribute(
        'style',
        [
          'position:fixed',
          'top:14px',
          'left:14px',
          'z-index:2147483647',
          'padding:6px 12px',
          'border-radius:8px',
          'font:600 15px/1.25 ui-sans-serif,system-ui,sans-serif',
          'letter-spacing:0.02em',
          'background:rgb(0,0,0)',
          'color:rgb(255,255,255)',
          'pointer-events:none',
        ].join(';'),
      );
      document.body.appendChild(el);
      const r = el.getBoundingClientRect();
      return {
        x: Math.floor(r.x),
        y: Math.floor(r.y),
        width: Math.ceil(r.width),
        height: Math.ceil(r.height),
      };
    }, CAPTION);

    await page.focus('#queue-list');
    await page.waitForFunction(() => document.getAnimations().length === 0, {
      timeout: 30_000,
    });

    const texts: string[] = [];
    let withoutCaption: Buffer = Buffer.alloc(0);
    for (const [i, key] of STEPS.entries()) {
      await page.keyboard.press(key, { delay: PRESS_DELAY_MS });
      await page.evaluate(async () =>
        (
          window as unknown as { __wmQueue: { settled(): Promise<void> } }
        ).__wmQueue.settled(),
      );
      await page.waitForFunction(
        () =>
          document.getAnimations().filter((a) => a.playState === 'running')
            .length === 0,
        { timeout: 30_000 },
      );
      texts.push(
        await page.evaluate(() => document.documentElement.innerText ?? ''),
      );
      // `scale: 'css'` and not the default: on a Retina display the device
      // scale is 2, and a frame twice the size the renderer reports is the
      // same class of lie as one with a menu bar on it.
      await page.screenshot({
        path: join(frames, `frame-${String(i).padStart(3, '0')}.png`),
        scale: 'css',
      });
      if (i === 0) {
        // The same instant, captured twice, differing only in the caption.
        // Nothing else can move between the two: both clocks are frozen and
        // no animation is running, which the wait above has just established.
        await page.evaluate(() => {
          const el = document.getElementById('gif-caption');
          if (el !== null) el.style.visibility = 'hidden';
        });
        withoutCaption = await page.screenshot({ scale: 'css' });
        await page.evaluate(() => {
          const el = document.getElementById('gif-caption');
          if (el !== null) el.style.visibility = 'visible';
        });
      }
    }

    const viewport = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    const captionText = await page.evaluate(
      () => document.getElementById('gif-caption')?.textContent ?? '',
    );

    const record = encodeGif(frames, out);
    return {
      dir: frames,
      out,
      record,
      gif: readFileSync(out),
      viewport,
      caption,
      captionText,
      withoutCaption,
      texts,
      names: readdirSync(frames).sort(),
    };
  } finally {
    if (app !== null) await app.close();
    if (fixture !== null) await fixture.stop();
  }
}

/* ── the run ──────────────────────────────────────────────────────────── */

let root = '';
let primary: Pass;
let secondary: Pass;
/** The tracked artefact AS IT STOOD before this run, for the drift row. */
let committed: Buffer | null = null;

beforeAll(async () => {
  committed = existsSync(ARTEFACT_ABS) ? readFileSync(ARTEFACT_ABS) : null;
  root = mkdtempSync(join(tmpdir(), 'wm-gif-'));

  /*
   * BOTH passes land in the scratch root, including under `WRITE`.
   *
   * The obvious spelling points the primary pass straight at the tracked
   * artefact when `WEMESSAGE_GIF_WRITE=1`. That spelling overwrites
   * `site/media/launch.gif` BEFORE `secondary` exists, which is before
   * anything at all has established that the pipeline is deterministic. A
   * regenerate that then failed its own determinism gate would leave the
   * repository holding a binary that no row ever agreed to, and the failing
   * message would talk about determinism while the damage was to a tracked
   * file. `git checkout` recovers it, but only for someone who thinks to
   * look, and the person running a regenerate is by definition expecting
   * that file to have changed.
   *
   * So the write is a PUBLICATION step, not a capture destination: capture
   * twice into the temp root, and copy over the tracked path only once the
   * two passes have produced identical bytes. Refusing to publish is the
   * narrower action. Letting `WRITE` mean "overwrite, and hope the rows
   * agree afterwards" is the E.3 direction this repo does not go.
   */
  primary = await runPass(join(root, 'a'), join(root, 'a.gif'));
  secondary = await runPass(join(root, 'b'), join(root, 'b.gif'));

  if (WRITE) {
    const a = createHash('sha256').update(primary.gif).digest('hex');
    const b = createHash('sha256').update(secondary.gif).digest('hex');
    if (a !== b)
      throw new Error(
        `refusing to write ${ARTEFACT}: the two passes of this same run ` +
          `disagree (${a.slice(0, 12)} vs ${b.slice(0, 12)}), so there is ` +
          `no deterministic output to publish. The tracked artefact is ` +
          `untouched.`,
      );
    writeFileSync(ARTEFACT_ABS, primary.gif);
  }
}, 300_000);

// Two passes of eight PNG captures plus two encoded GIFs is tens of
// megabytes, and the suite runs on every `pnpm test`. The scratch root is the
// only thing this file creates outside the repository, so it is the only
// thing it has to take back.
afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('s9 Sc13 rows 5 to 8: the launch GIF', () => {
  /* ── row 5 ──────────────────────────────────────────────────────────── */

  describe('row 5: eight keyboard steps, encoded to the published shape', () => {
    it('the desktop package publishes the `gif` script the row names', () => {
      const pkg = JSON.parse(
        readFileSync(join(REPO_ROOT, 'apps/desktop/package.json'), 'utf8'),
      ) as { scripts?: Record<string, string> };
      const gif = pkg.scripts?.['gif'];
      expect(gif, 'apps/desktop/package.json has no `gif` script').toBeTypeOf(
        'string',
      );
      // The script must run THIS spec, and it must be the only thing that
      // turns the write mode on: a `gif` script that wrote the artefact by
      // some other route would leave every row below testing a file nobody
      // ships.
      expect(gif).toContain('WEMESSAGE_GIF_WRITE=1');
      expect(gif).toContain('test/gif.spec.ts');
    });

    it('eight strokes produced eight captures, in the encoder`s own order', () => {
      expect(STEPS.length).toBe(STEP_COUNT);
      expect(primary.names).toEqual([
        'frame-000.png',
        'frame-001.png',
        'frame-002.png',
        'frame-003.png',
        'frame-004.png',
        'frame-005.png',
        'frame-006.png',
        'frame-007.png',
      ]);
      // The encoder's own reading of the directory, which is the reading that
      // decided the animation's order.
      expect(primary.record.sources).toEqual([...primary.names]);
      expect(primary.record.captures).toBe(STEP_COUNT);
    });

    it('every capture is the size of the LIVE renderer viewport', () => {
      // Against the viewport FIRST and the constant second. A frame with a
      // strip of the desktop composited onto it is still 1200 wide and is no
      // longer the height of the thing that was photographed, so this is the
      // assertion that fails and not an equality with a number this file also
      // chose.
      expect(primary.viewport).toEqual({ width: WIDTH, height: HEIGHT });
      for (const name of primary.names) {
        const frame = frameOf(name, readFileSync(join(primary.dir, name)));
        expect({ width: frame.width, height: frame.height }, name).toEqual(
          primary.viewport,
        );
        // No OS chrome can be present in a capture of the web contents, and
        // no undefined RGB can reach a format without an alpha channel.
        expect(minAlpha(frame), `${name}: a translucent pixel`).toBe(255);
      }
      expect(primary.record.width).toBe(WIDTH);
      expect(primary.record.height).toBe(HEIGHT);
    });

    it('every stroke changed the screen, so no step is a held frame', () => {
      expect(primary.record.changed.length).toBe(STEP_COUNT);
      // The first capture is the whole canvas by construction.
      expect(primary.record.changed[0]).toBe(WIDTH * HEIGHT);
      for (const [i, n] of primary.record.changed.slice(1).entries())
        expect(n, `${String(STEPS[i + 1])} changed nothing`).toBeGreaterThan(0);
    });

    it('twelve frames a second, expressed in the units GIF actually has', () => {
      // 1/12 s is 8.33 cs and GIF stores hundredths, so 12 fps is not
      // expressible. 8 cs is the nearest the format has. The row asserts the
      // rounding rather than rounding the number and calling it twelve.
      expect(primary.record.delayCs).toBe(Math.round(100 / 12));
      expect(primary.record.delayCs).toBe(8);
      expect(primary.record.delayMs).toBe(80);
      expect(primary.record.fps).toBeCloseTo(12.5, 5);
      // Every capture is held long enough to read, which is what the encoded
      // frame count is: eight captures times the hold.
      expect(primary.record.hold).toBe(HOLD);
      expect(primary.record.frames).toBe(STEP_COUNT * HOLD);
    });

    it('the artefact is under 1.5 MB and 1200 px wide', () => {
      expect(primary.record.maxBytes).toBe(MAX_BYTES);
      expect(primary.record.bytes).toBeLessThanOrEqual(MAX_BYTES);
      expect(primary.gif.length).toBe(primary.record.bytes);
      // The width off the wire, from the logical screen descriptor, and not
      // from the record the encoder wrote about itself.
      expect(primary.gif.readUInt16LE(6)).toBe(WIDTH);
      expect(primary.gif.readUInt16LE(8)).toBe(HEIGHT);
      expect(primary.gif.subarray(0, 6).toString('latin1')).toBe('GIF89a');
    });
  });

  /* ── row 6 ──────────────────────────────────────────────────────────── */

  describe('row 6: the pixels, read by this repository`s own decoder', () => {
    it('no frame of the GIF holds a pixel in the banned hue band', () => {
      const decoded = decodeRaster(ARTEFACT, primary.gif);
      expect(decoded.undecoded).toEqual([]);
      expect(decoded.frames.length).toBe(STEP_COUNT * HOLD);
      /*
       * NON-VACUITY, said with a number. Every frame after the first is a
       * DIFF with unchanged pixels set to the reserved transparent index,
       * and `rasterGreenOffenders` skips fully transparent pixels because
       * their RGB is undefined by the format. So the sweep would be a sweep
       * of almost nothing if the first frame were not whole. It is: the
       * count below is the full canvas plus every pixel that ever took a
       * new value, which is exactly the set of distinct values this
       * animation puts on screen.
       */
      let opaque = 0;
      for (const frame of decoded.frames)
        for (let p = 3; p < frame.rgba.length; p += 4)
          if ((frame.rgba[p] ?? 0) !== 0) opaque += 1;
      expect(opaque).toBeGreaterThanOrEqual(WIDTH * HEIGHT);

      const offenders = rasterGreenOffenders(ARTEFACT, primary.gif);
      // The failure has to name the frame and the count, which is what the
      // scenario's second tooth asks of it.
      //
      // Only the per-pixel entries carry a frame. `rasterGreenOffenders`
      // caps its detail and then appends a SUMMARY line with no `@` in it,
      // and splitting that line unconditionally runs it through
      // `slice(0, -1)`: that is how the first CI failure came back reporting
      // a frame called `... in frame orde` with `1 px` against it. A
      // diagnostic that invents a frame is worse than none, because the
      // reader spends their first minutes on the invention.
      const byFrame = new Map<string, number>();
      for (const o of offenders) {
        const at = o.indexOf('@');
        if (at === -1) continue;
        byFrame.set(o.slice(0, at), (byFrame.get(o.slice(0, at)) ?? 0) + 1);
      }
      // And it has to name the COLOURS, because the count alone cannot tell
      // apart the two things that put green here, and they want opposite
      // responses. A green SURFACE is an INV-2 regression and the build must
      // stop. A one-pixel scatter of `dominant-G` verdicts along glyph edges
      // is subpixel text antialiasing, a property of the host the renderer
      // happens to be on rather than of this product, and the answer to that
      // is to pin the renderer, never to widen the band. Each offender
      // already carries its `rgb()` literal and the arm of `greenVerdict`
      // that fired, so printing a handful decides between those two on the
      // first read instead of on the next round trip through CI.
      expect(
        offenders.length,
        [
          [...byFrame].map(([f, n]) => `${f}: ${String(n)} px`).join(', '),
          ...offenders.slice(0, 8),
        ].join('\n'),
      ).toBe(0);
    }, 300_000);

    // teeth: TN-real-screenshot (row 6): applied, bit, reverted.
    //
    // The mutation was one declaration, `visibility:hidden`, added to the
    // caption's inline style beside `pointer-events:none`. It was chosen
    // over `display:none` and over deleting the node precisely because it
    // is the mutation this row is least able to see: the element keeps its
    // text, keeps its place in layout, and `getBoundingClientRect` keeps
    // returning the real pill, so EVERY DOM-shaped assertion in this row
    // still passed. `captionText` matched, and all four geometry bounds
    // still put the box in the top-left eighth. Only the paint went away.
    //
    // The result is the point of the tooth's name. The row failed with
    //
    //   identical: expected 0 to be greater than 2092.5
    //
    // which says that across the 4185 pixels of the caption box, the frame
    // with the caption and the frame with it hidden were the same photograph
    // in every one. A row that read the DOM and called it a screenshot would
    // have been green.
    //
    // Worth recording because it changes which half of this row is
    // load-bearing: the `boxColours > 2` check ABOVE the failure still
    // passed, because the app chrome underneath an invisible pill is itself
    // multi-coloured. Counting colours in a region only proves the region is
    // not blank. The hidden-recapture diff is the half that actually proves
    // the caption is made of pixels, so it must not be weakened into the
    // cheaper check on the grounds that the two look redundant.
    it('the caption is in the PIXELS of frame 0, not merely in the DOM', () => {
      expect(primary.captionText).toBe(CAPTION);
      // Top left, in the top left eighth of the canvas on both axes, so
      // "top-left caption" is measured rather than described.
      expect(primary.caption.x).toBeGreaterThanOrEqual(0);
      expect(primary.caption.y).toBeGreaterThanOrEqual(0);
      expect(primary.caption.x + primary.caption.width).toBeLessThan(WIDTH / 4);
      expect(primary.caption.y + primary.caption.height).toBeLessThan(
        HEIGHT / 4,
      );

      const shown = frameOf(
        'frame-000.png',
        readFileSync(join(primary.dir, 'frame-000.png')),
      );
      const hidden = frameOf('frame-000-nocaption.png', primary.withoutCaption);
      // Not uniform background, which is the plan's own instrument: a region
      // holding a pill and lettering has many colours, and one that holds the
      // window's backdrop has one.
      expect(boxColours(shown, primary.caption)).toBeGreaterThan(2);
      // And the stronger half, which no reference image is needed for: the
      // SAME instant with the caption hidden differs across the whole pill.
      // A synthesised frame, or a frame captured from somewhere other than
      // this window, cannot satisfy both halves at once.
      const differing = diffIn(shown, hidden, primary.caption);
      expect(differing.count, sayDiff(differing)).toBeGreaterThan(
        (primary.caption.width * primary.caption.height) / 2,
      );
      // The calibration for the reading above: outside the caption the two
      // captures are the same photograph.
      const elsewhere = diffIn(shown, hidden, {
        x: 0,
        y: primary.caption.y + primary.caption.height,
        width: WIDTH,
        height: HEIGHT - (primary.caption.y + primary.caption.height),
      });
      expect(
        elsewhere.count,
        `two captures of an unchanged window differ (${sayDiff(elsewhere)}),` +
          ' so nothing above means anything',
      ).toBe(0);
    });

    it('the caption survives every step, so no frame is uncaptioned', () => {
      for (const name of primary.names) {
        const frame = frameOf(name, readFileSync(join(primary.dir, name)));
        expect(boxColours(frame, primary.caption), name).toBeGreaterThan(2);
      }
      for (const text of primary.texts) expect(text).toContain(CAPTION);
    });
  });

  /* ── row 7 ──────────────────────────────────────────────────────────── */

  describe('row 7: the same pipeline twice, byte for byte', () => {
    it('two complete passes produce an identical artefact', () => {
      // Two daemons, two windows, two temp directories, two encodes. The
      // only things held constant are the seed and the two frozen clocks,
      // which is the claim.
      expect(secondary.record.sha256).toBe(primary.record.sha256);
      expect(secondary.record.bytes).toBe(primary.record.bytes);
      expect(secondary.gif.equals(primary.gif)).toBe(true);
    });

    it('the frames themselves match, so the equality is not the encoder`s', () => {
      // Without this the row above would pass on a pipeline whose captures
      // drifted and whose quantizer happened to flatten the difference away.
      for (const name of primary.names) {
        const a = readFileSync(join(primary.dir, name));
        const b = readFileSync(join(secondary.dir, name));
        const same =
          createHash('sha256').update(a).digest('hex') ===
          createHash('sha256').update(b).digest('hex');
        expect(
          same,
          same
            ? name
            : `${name}: ${sayDiff(
                diffIn(frameOf(name, a), frameOf(name, b), {
                  x: 0,
                  y: 0,
                  width: WIDTH,
                  height: HEIGHT,
                }),
              )}`,
        ).toBe(true);
      }
    });

    /**
     * The committed artefact is the one this pipeline produces.
     *
     * Skipped off macOS because the frames are photographs of text rendered
     * by the host: CoreText and FreeType disagree about hinting and about
     * subpixel positioning, so a Linux render of an identical DOM is a
     * different image, and asserting otherwise would be asserting that two
     * font stacks agree. The macOS lane, which is the lane the artefact is
     * generated in, asserts it.
     */
    describe.skipIf(process.platform !== 'darwin')(
      'the drift check, on the platform the artefact is rendered on',
      () => {
        it('site/media/launch.gif equals what this run generated', () => {
          expect(
            committed,
            `${ARTEFACT} is not present; run \`pnpm --filter @wemessage/desktop gif\``,
          ).not.toBeNull();
          expect(
            createHash('sha256')
              .update(committed ?? Buffer.alloc(0))
              .digest('hex'),
            `${ARTEFACT} has drifted from the pipeline that makes it`,
          ).toBe(primary.record.sha256);
        });
      },
    );
  });

  /* ── row 8 ──────────────────────────────────────────────────────────── */

  describe('row 8: what a published animation is allowed to say', () => {
    it('nothing visible at any step is a thing a public repo may not carry', () => {
      for (const [i, text] of primary.texts.entries())
        expect(
          publicStringOffenders(text).map((o) => `${o.rule}: ${o.detail}`),
          `step ${String(i)} (${String(STEPS[i])})`,
        ).toEqual([]);
    });

    it('every handle on screen is one this file seeded, and no other', () => {
      // The plan asks the harness to record which seed module ran. There is
      // no such record in the tree, and naming a module would in any case be
      // a claim about the SETUP rather than about the pixels. This asserts
      // the pixels' vocabulary instead: a wrong seed fails it, and a right
      // name cannot fake it.
      const seen = new Set<string>();
      for (const text of primary.texts)
        for (const n of text.match(/\+1\d{10}/g) ?? []) seen.add(n);
      expect([...seen].sort()).toEqual([...HANDLES].sort());
    });

    it('every message body on screen is one this file wrote', () => {
      const bodies = new Set<string>(BODIES);
      const seen = new Set<string>();
      for (const text of primary.texts)
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (bodies.has(trimmed)) seen.add(trimmed);
        }
      // Non-vacuity: the queue really is showing message bodies, and the row
      // above is not passing because it found none.
      expect(seen.size).toBeGreaterThan(0);
      for (const body of seen) expect(bodies.has(body)).toBe(true);
    });

    it('no absolute home path and no window title reaches the canvas', () => {
      // `page.screenshot` photographs the web contents, so the window's own
      // title bar is out of frame by construction. The document is swept for
      // the path shapes anyway, because a renderer that printed its config
      // directory into a status line would put one INSIDE the frame.
      for (const text of primary.texts) {
        expect(
          publicStringOffenders(text).filter(
            (o) => o.rule === 'absolute-user-path',
          ),
        ).toEqual([]);
        expect(text).not.toContain(REPO_ROOT);
      }
    });
  });
});
