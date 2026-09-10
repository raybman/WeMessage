/**
 * s9 Sc 13 rows 5 to 8 - the launch GIF encoder.
 *
 * WHAT THIS FILE IS NOT, AND WHY. The scenario text asks for one script that
 * "runs the S8 harness against the fixture daemon" and encodes the result.
 * Half of that cannot live here: `.dependency-cruiser.cjs`'s
 * `nobody-imports-daemon` fences `^packages/daemon` off from everything under
 * `^apps` with exactly ONE carve-out, `^apps/desktop/test/`, and the comment
 * on the rule says why in as many words: the desktop e2e harness is the one
 * place in the house allowed to boot a real daemon in process (F-102). A
 * generator script that imported the harness would be a second such place,
 * and the honest response to a guard that says no is to fit the design to it
 * rather than to widen it (E.3).
 *
 * So the work is split at the process boundary the fence already draws:
 *
 *  - `apps/desktop/test/gif.spec.ts` owns the CAPTURE. It boots the S8
 *    harness, drives the queue by keyboard, and writes one PNG per step.
 *  - this file owns the ENCODE. It reads those PNGs and nothing else, and it
 *    imports no workspace package at all, so it is outside every fence in the
 *    cruise by construction rather than by exemption.
 *
 * The two halves meet over argv and a JSON record on stdout, which is also
 * what makes the encoder testable twice over: the spec runs it, reads the
 * record back, and then decodes the artefact with the repo's OWN GIF reader
 * (`test/helpers/raster-decode.ts`) rather than with gifenc, so a decoder
 * that agreed with its encoder could not make the sweep pass.
 *
 * WHY THE FRAMES ARE DIFFED. A capture is 1200x750, and eight of them at 256
 * colours do not fit in the 1.5 MB budget once each step is held long enough
 * for a human to read it. Every frame after the first is written with the
 * pixels that did NOT change set to a reserved transparent index and
 * `dispose: 1`, so the previous frame shows through. That is a size decision
 * and NOT a sweep hole: frame 0 carries every pixel, and a pixel that ever
 * takes a new value differs from its predecessor and is therefore encoded in
 * the frame where it takes it. The hue sweep sees every distinct value the
 * animation ever puts on screen.
 *
 * WHY 8 CENTISECONDS. GIF stores a frame delay in hundredths of a second, so
 * 12 fps is not expressible: 1/12 s is 8.33 cs. 8 cs is the nearest the
 * format has, and it is what this writes. The record says so in `delayCs` and
 * `fps` rather than rounding the number and calling it twelve.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * `gifenc` publishes a CJS `main` with no `exports` field, so it is asked for
 * the way `test/e2e/harness.ts` asks for `playwright-core`: with
 * `createRequire`, which is the shape the package actually is. Its licence is
 * MIT, which both `licenses.allow` and `licenses.allow.dev` already carry.
 */
const need = createRequire(import.meta.url);
const { GIFEncoder, quantize, applyPalette } = need('gifenc');
const { PNG } = need('pngjs');

/* ── the contract the spec asserts against ────────────────────────────── */

/** CSS pixels. The site lays the GIF out at this width (F-132). */
const WIDTH = 1200;
/** CSS pixels. The renderer's content box, so no OS chrome can be in shot. */
const HEIGHT = 750;
/** Milliseconds per frame. gifenc rounds to centiseconds; this lands on 8. */
const DELAY_MS = 80;
/** How many encoded frames each capture is held for: 9 * 8 cs = 0.72 s. */
const HOLD = 9;
/** Colours the quantizer may mint. 255, so index 255 is free for the diff. */
const PALETTE_COLOURS = 255;
/** The reserved diff index. Never returned by `applyPalette` above. */
const TRANSPARENT_INDEX = 255;
/** F-132's ceiling. Bytes, not mebibytes: the smaller of the two readings. */
const MAX_BYTES = 1_500_000;

/* ── frames in ─────────────────────────────────────────────────────────── */

/**
 * Every `frame-NNN.png` in `dir`, in name order, decoded to RGBA.
 *
 * Name order and not `readdir` order: `readdir` is filesystem order on some
 * volumes, and an animation whose frames are in the order the disk felt like
 * is an animation that plays differently on two machines. The zero padding is
 * what makes the string sort and the numeric sort the same sort.
 */
function readFrames(dir) {
  const names = readdirSync(dir)
    .filter((n) => /^frame-\d{3}\.png$/.test(n))
    .sort();
  if (names.length === 0) throw new Error(`no frame-NNN.png files in ${dir}`);
  return names.map((name) => {
    const png = PNG.sync.read(readFileSync(join(dir, name)));
    if (png.width !== WIDTH || png.height !== HEIGHT)
      throw new Error(
        `${name} is ${String(png.width)}x${String(png.height)}, ` +
          `expected ${String(WIDTH)}x${String(HEIGHT)}`,
      );
    // A COPY, deliberately. `applyPalette` and `quantize` both do
    // `new Uint32Array(rgba.buffer)`, which reads the whole underlying buffer
    // rather than the view: a pngjs Buffer can be a window onto Node's shared
    // pool, and handing that in silently quantizes somebody else's memory.
    return { name, rgba: new Uint8Array(png.data) };
  });
}

/* ── frames out ────────────────────────────────────────────────────────── */

/**
 * Encode the captures into one GIF, and say what was encoded.
 *
 * Determinism is the whole point of this function's shape (C-11, row 7). The
 * palette is built ONCE, from every capture's pixels concatenated in frame
 * order, so it cannot depend on which frame the quantizer saw first; there is
 * no randomness, no dithering and no clock anywhere in the path; and the only
 * input is the bytes on disk. Identical PNGs in, identical bytes out.
 */
function encode(frames) {
  const pixels = WIDTH * HEIGHT;
  const all = new Uint8Array(frames.length * pixels * 4);
  frames.forEach((frame, i) => all.set(frame.rgba, i * pixels * 4));
  const palette = quantize(all, PALETTE_COLOURS, { format: 'rgb565' });
  const indexed = frames.map((frame) =>
    applyPalette(frame.rgba, palette, 'rgb565'),
  );

  const gif = GIFEncoder();
  const held = new Uint8Array(pixels).fill(TRANSPARENT_INDEX);
  const changed = [];
  let written = 0;
  indexed.forEach((index, n) => {
    if (n === 0) {
      changed.push(pixels);
      gif.writeFrame(index, WIDTH, HEIGHT, {
        palette,
        delay: DELAY_MS,
        repeat: 0,
      });
    } else {
      const previous = indexed[n - 1];
      const diff = new Uint8Array(pixels);
      let count = 0;
      for (let p = 0; p < pixels; p += 1) {
        if (index[p] === previous[p]) diff[p] = TRANSPARENT_INDEX;
        else {
          diff[p] = index[p];
          count += 1;
        }
      }
      changed.push(count);
      gif.writeFrame(diff, WIDTH, HEIGHT, {
        delay: DELAY_MS,
        transparent: true,
        transparentIndex: TRANSPARENT_INDEX,
        // 1 = leave the previous frame in place. gifenc defaults a
        // transparent frame to 2 (restore to background), which would clear
        // the screen to the background colour under every unchanged pixel
        // and leave one step's worth of queue on a blank canvas.
        dispose: 1,
      });
    }
    written += 1;
    for (let h = 1; h < HOLD; h += 1) {
      gif.writeFrame(held, WIDTH, HEIGHT, {
        delay: DELAY_MS,
        transparent: true,
        transparentIndex: TRANSPARENT_INDEX,
        dispose: 1,
      });
      written += 1;
    }
  });
  gif.finish();
  return { bytes: Buffer.from(gif.bytes()), frames: written, changed };
}

/* ── the command ───────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (typeof key !== 'string' || !key.startsWith('--') || value === undefined)
      throw new Error(`usage: make-gif.mjs --frames <dir> --out <file>`);
    out[key.slice(2)] = value;
  }
  if (out.frames === undefined || out.out === undefined)
    throw new Error(`usage: make-gif.mjs --frames <dir> --out <file>`);
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const captures = readFrames(args.frames);
  const encoded = encode(captures);
  if (encoded.bytes.length > MAX_BYTES)
    throw new Error(
      `${String(encoded.bytes.length)} bytes exceeds the ` +
        `${String(MAX_BYTES)} byte budget (F-132)`,
    );
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, encoded.bytes);
  const record = {
    out: args.out,
    bytes: encoded.bytes.length,
    sha256: createHash('sha256').update(encoded.bytes).digest('hex'),
    width: WIDTH,
    height: HEIGHT,
    captures: captures.length,
    frames: encoded.frames,
    hold: HOLD,
    delayMs: DELAY_MS,
    delayCs: Math.round(DELAY_MS / 10),
    fps: 100 / Math.round(DELAY_MS / 10),
    paletteColours: PALETTE_COLOURS,
    transparentIndex: TRANSPARENT_INDEX,
    maxBytes: MAX_BYTES,
    /** Pixels each capture changed from the one before it. */
    changed: encoded.changed,
    sources: captures.map((c) => c.name),
  };
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

main();
