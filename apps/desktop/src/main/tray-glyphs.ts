/**
 * The five tray icons, drawn rather than loaded.
 *
 * §1.7 asked for template SVGs under `apps/desktop/assets/tray/`. That file
 * cannot exist for two independent reasons, and both are worth writing down
 * because the obvious fix for either one is wrong.
 *
 *  1. `nativeImage` on this Electron decodes PNG and JPEG. There is no SVG
 *     path — not `createFromPath`, not `createFromDataURL`, not with a
 *     `data:image/svg+xml` payload. An asset that cannot be decoded is a
 *     transparent 0×0 image and a tray that silently shows nothing.
 *  2. Sc1 row 4 bans every raster under `apps/desktop/src` and
 *     `apps/desktop/assets` with an allowlist that is deliberately EMPTY,
 *     because a binary in a public repo is a thing nobody reviews. Adding a
 *     PNG would mean widening that allowlist to make an icon possible.
 *
 * So the glyphs are functions. That turns out to be the better answer rather
 * than the grudging one: MONOCHROME becomes a fact about bytes that a test
 * can assert directly, instead of a fact about a designer's export settings.
 *
 * **Why five shapes and not five colours.** On macOS a tray image is a
 * TEMPLATE image: the system paints it with the menu bar's own ink and
 * inverts it in dark mode, so the icon physically cannot carry a hue. That
 * makes §1.7's "colour is never the sole carrier of state" structural here.
 * The five postures are five distinct SILHOUETTES — a filled disc, a ring
 * with a quarter in it, a ring with a half in it, a struck-through ring, and
 * four loose dots — and the uppercase WORD in the menu and in the tooltip
 * carries the same fact in language.
 *
 * Every pixel is written with red, green and blue at ZERO and only the alpha
 * varying. That is what a template image wants, and it also means Skia's
 * premultiplication cannot perturb the colour channels: 0 × anything is 0. An
 * e2e row reads the bitmap back off the running app and asserts exactly that.
 *
 * This module imports nothing at all — not Electron, not `node:*`. It hands
 * back plain buffers and `tray.ts` is the one file that turns one into a
 * `NativeImage`, which is what keeps `createFromBitmap(` a one-namer row.
 */

/**
 * 18 logical points, which is the menu-bar height macOS actually wants.
 *
 * Deliberately NOT scaled: a `@2x` representation would double every buffer
 * for a shape whose whole job is to be legible at a glance, and the shapes
 * below are drawn from a distance field rather than from pixel art, so they
 * are already smooth at this size.
 */
export const GLYPH_SIZE = 18;

/** Bytes per pixel in the BGRA buffer `createFromBitmap` expects. */
const STRIDE = 4;

/**
 * A raw icon, in the exact shape `nativeImage.createFromBitmap` takes.
 *
 * Carrying the dimensions alongside the bytes rather than making the caller
 * remember them: a buffer handed to `createFromBitmap` with the wrong
 * `width` is not an error, it is a garbled image.
 */
export interface TrayBitmap {
  readonly width: number;
  readonly height: number;
  readonly buffer: Uint8Array;
}

/** Geometry, in pixel centres. */
const CENTRE = (GLYPH_SIZE - 1) / 2;
/** Outer edge of every ring and of the filled disc. */
const OUTER = 7.2;
/** Inner edge of a ring, so the stroke is a little under two pixels. */
const INNER = 5.3;

/**
 * Draw one glyph by asking a predicate about every pixel.
 *
 * `ink` answers coverage in 0..1 rather than a boolean, which is the whole of
 * the anti-aliasing story: a shape defined by a distance gets a soft edge for
 * free, and a soft edge is the difference between a legible 18-point circle
 * and a lump.
 */
function draw(ink: (x: number, y: number) => number): TrayBitmap {
  const buffer = new Uint8Array(GLYPH_SIZE * GLYPH_SIZE * STRIDE);
  for (let y = 0; y < GLYPH_SIZE; y += 1) {
    for (let x = 0; x < GLYPH_SIZE; x += 1) {
      const coverage = Math.max(0, Math.min(1, ink(x, y)));
      if (coverage === 0) continue;
      const at = (y * GLYPH_SIZE + x) * STRIDE;
      // B, G, R stay at 0. Only A moves. A template image is a mask, and a
      // mask with colour in it is a mask that will fight the menu bar.
      buffer[at + 3] = Math.round(coverage * 255);
    }
  }
  return { width: GLYPH_SIZE, height: GLYPH_SIZE, buffer };
}

/** Signed distance from the centre, in pixels. */
function radius(x: number, y: number): number {
  const dx = x - CENTRE;
  const dy = y - CENTRE;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Coverage of a soft-edged half-plane: 1 well inside, 0 well outside. */
function feather(distance: number): number {
  return 0.5 - distance;
}

/** A filled disc out to `OUTER`. */
function disc(x: number, y: number): number {
  return feather(radius(x, y) - OUTER);
}

/** The ring stroke every hollow glyph is built on. */
function ring(x: number, y: number): number {
  const r = radius(x, y);
  return Math.min(feather(r - OUTER), feather(INNER - r));
}

/**
 * Angle in turns, measured clockwise from twelve o'clock.
 *
 * Screen coordinates put `y` downward, so "clockwise from the top" is the
 * ordinary `atan2(dx, -dy)` with the arguments in that order. Written out
 * because getting it wrong produces a glyph that is merely mirrored, which is
 * the kind of bug an eye slides straight over.
 */
function turns(x: number, y: number): number {
  const angle = Math.atan2(x - CENTRE, CENTRE - y);
  return (angle / (Math.PI * 2) + 1) % 1;
}

/** ● ARMED — solid. The one posture where outbound is genuinely live. */
export function armedTemplate(): TrayBitmap {
  return draw(disc);
}

/** ◔ DRAFT ONLY — a ring with the first quarter filled in. */
export function draftOnlyTemplate(): TrayBitmap {
  return draw((x, y) => {
    const inside = feather(radius(x, y) - INNER);
    const quarter = turns(x, y) < 0.25 ? inside : 0;
    return Math.max(ring(x, y), quarter);
  });
}

/** ◐ IN FLIGHT — a ring with the right half filled in. */
export function sendingTemplate(): TrayBitmap {
  return draw((x, y) => {
    const inside = feather(radius(x, y) - INNER);
    const half = x >= CENTRE ? inside : 0;
    return Math.max(ring(x, y), half);
  });
}

/** ⊘ KILLED — a ring struck through. The only glyph with a straight line. */
export function killedTemplate(): TrayBitmap {
  return draw((x, y) => {
    const dx = x - CENTRE;
    const dy = y - CENTRE;
    // Distance to the line y = -x, i.e. the stroke that runs from the lower
    // left to the upper right, clipped to the disc so it does not poke out.
    const toLine = Math.abs(dx + dy) / Math.SQRT2;
    const slash = Math.min(
      feather(toLine - 0.9),
      feather(radius(x, y) - OUTER),
    );
    return Math.max(ring(x, y), slash);
  });
}

/**
 * DISCONNECTED — four dots where the ring would be. Nothing is being held.
 *
 * The plan's glyph for this posture is a DOTTED circle, and a dotted circle
 * is what this started as: `ring()` masked by an angular duty cycle. At 18
 * points a two-pixel stroke cut into arcs comes out as gravel, because the
 * dash boundary lands mid-pixel at a different fraction on every dash. Four
 * explicit dots at the compass points say the same thing and survive the
 * grid, which is the whole reason these are functions and not an export from
 * a drawing tool: the shape could be tried, looked at, and changed.
 */
export function disconnectedTemplate(): TrayBitmap {
  const RING = 6.0;
  const DOT = 1.75;
  const dots = [
    [CENTRE, CENTRE - RING],
    [CENTRE + RING, CENTRE],
    [CENTRE, CENTRE + RING],
    [CENTRE - RING, CENTRE],
  ] as const;
  return draw((x, y) => {
    let best = 0;
    for (const [cx, cy] of dots) {
      const d = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
      best = Math.max(best, feather(d - DOT));
    }
    return best;
  });
}

/**
 * The five builders under the names `TRAY_POSTURE_SPEC` uses.
 *
 * Keyed by the STRING the model carries rather than by `TrayPosture`, so that
 * this file stays free of any import at all — the posture union lives next
 * door, and reaching for it would put a module edge on a file whose entire
 * argument is that it has none. `tray.ts` is where the two meet, and it is
 * the caller's job to fail loudly when a name has no builder.
 */
export const TRAY_GLYPHS: Readonly<Record<string, () => TrayBitmap>> = {
  armedTemplate,
  draftOnlyTemplate,
  sendingTemplate,
  killedTemplate,
  disconnectedTemplate,
};
