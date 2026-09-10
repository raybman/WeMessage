/**
 * s9 Sc 1 row 3 — decoding the rasters the ship era commits.
 *
 * S8's raster rule is a BAN with an empty allowlist, and a ban is only the
 * right rule while the answer is "none". The ship era needs three rasters
 * that no SVG can be: the `.icns` macOS wants for a bundle, the DMG
 * background Finder composites behind the drag-to-Applications arrow, and
 * the launch animation on the site. The moment one is admitted, "the app
 * ships no green" stops being a question a text sweep can answer, because
 * the green would be in the PIXELS.
 *
 * So the allowlist is not an exemption, it is a PROMOTION: a file on the
 * list is not skipped, it is decoded and swept pixel by pixel under the same
 * `greenVerdict` the token sheet is held to (F-130, zero tolerance). A path
 * that cannot be decoded is an offender, not a pass — an allowlist entry
 * this file cannot read is an allowlist entry nobody is checking.
 *
 * Three formats, three readers, no dependency:
 *
 *  - PNG. Chunk walk, IDAT concatenation, `zlib.inflateSync`, per-scanline
 *    unfilter, colour-type expansion to RGBA. `pngjs` is a devDependency of
 *    this package and could have done it in one line, which is exactly why
 *    it does not: the fixtures these readers are proved against are ENCODED
 *    with `pngjs` and `gifenc`, and a decoder that shared an implementation
 *    with its encoder would prove only that it agreed with itself.
 *  - GIF. Logical screen descriptor, global/local colour tables, the LZW
 *    reader below, every frame decoded independently. Independently and not
 *    composited on purpose: a green pixel in frame 40 of a launch animation
 *    is a green pixel, and composition could only hide it.
 *  - ICNS. Entry table walk, and TWO readers rather than one, because
 *    `iconutil` writes ONE icon in two encodings. Every slot from 32px up
 *    carries a whole PNG, so the PNG reader is reused on the embedded
 *    bytes; the 16pt and 32pt slots are ARGB, four run-length-encoded
 *    planes behind an `ARGB` magic, read by `decodeIcnsArgb` below. Raw
 *    24-bit RLE (`is32`, `il32`) and JPEG-2000 entries are still reported
 *    as UNDECODED rather than skipped.
 *
 * KNOWN SHARP EDGE, recorded for the slice that first puts a photograph on
 * the list: `greenVerdict`'s hue arm has no tolerance band, so a pixel on an
 * antialiased edge between two hues can land inside [75, 165] even when
 * neither neighbour is green. Every raster this project has committed to
 * date is flat-colour vector art rendered to a raster, where that does not
 * happen. A photographic DMG background would need the rule argued again
 * rather than the tolerance widened quietly.
 */
import { inflateSync } from 'node:zlib';
import { greenVerdict } from '../../../../packages/cli/test/helpers/transcript-lint.js';

export interface RasterFrame {
  /** Where in the file this came from: `png`, `gif#3`, `icns:ic09`. */
  readonly label: string;
  readonly width: number;
  readonly height: number;
  /** Row-major RGBA, four bytes per pixel. */
  readonly rgba: Uint8Array;
}

export interface DecodedRaster {
  readonly frames: readonly RasterFrame[];
  /**
   * Sub-images the readers refused. Non-empty means "this file was not
   * swept", which the row treats as a failure rather than as silence.
   */
  readonly undecoded: readonly string[];
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const u32 = (b: Uint8Array, i: number): number =>
  ((b[i] ?? 0) << 24) |
  ((b[i + 1] ?? 0) << 16) |
  ((b[i + 2] ?? 0) << 8) |
  (b[i + 3] ?? 0);
const u16le = (b: Uint8Array, i: number): number =>
  (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const startsWithPng = (b: Uint8Array): boolean =>
  PNG_MAGIC.every((v, i) => b[i] === v);

// ---------------------------------------------------------------------------
// PNG

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function decodePng(label: string, bytes: Uint8Array): DecodedRaster {
  if (!startsWithPng(bytes))
    return { frames: [], undecoded: [`${label}: not a PNG`] };
  let width = 0;
  let height = 0;
  let depth = 0;
  let colour = 0;
  let interlace = 0;
  let palette: Uint8Array = new Uint8Array(0);
  let paletteAlpha: Uint8Array = new Uint8Array(0);
  const idat: Uint8Array[] = [];
  let i = 8;
  while (i + 8 <= bytes.length) {
    const len = u32(bytes, i);
    const type = String.fromCharCode(...bytes.subarray(i + 4, i + 8));
    const data = bytes.subarray(i + 8, i + 8 + len);
    if (type === 'IHDR') {
      width = u32(data, 0);
      height = u32(data, 4);
      depth = data[8] ?? 0;
      colour = data[9] ?? 0;
      interlace = data[12] ?? 0;
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS' && colour === 3) paletteAlpha = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    i += 12 + len;
  }
  if (depth !== 8)
    return { frames: [], undecoded: [`${label}: bit depth ${String(depth)}`] };
  if (interlace !== 0)
    return { frames: [], undecoded: [`${label}: interlaced (Adam7)`] };
  const channels = CHANNELS[colour];
  if (channels === undefined)
    return {
      frames: [],
      undecoded: [`${label}: colour type ${String(colour)}`],
    };
  const raw = inflateSync(Buffer.concat(idat.map((d) => Buffer.from(d))));
  const stride = width * channels;
  const flat = new Uint8Array(height * stride);
  // Unfilter. Every scanline is prefixed with its filter byte and refers to
  // the RECONSTRUCTED bytes above and to the left, never to the raw ones.
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const cur = raw[src + x] ?? 0;
      const a = x >= channels ? (flat[dst + x - channels] ?? 0) : 0;
      const b = y > 0 ? (flat[dst - stride + x] ?? 0) : 0;
      const c =
        y > 0 && x >= channels ? (flat[dst - stride + x - channels] ?? 0) : 0;
      let v = cur;
      if (filter === 1) v = cur + a;
      else if (filter === 2) v = cur + b;
      else if (filter === 3) v = cur + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      flat[dst + x] = v & 0xff;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p += 1) {
    const s = p * channels;
    const d = p * 4;
    if (colour === 0) {
      const g = flat[s] ?? 0;
      rgba[d] = g;
      rgba[d + 1] = g;
      rgba[d + 2] = g;
      rgba[d + 3] = 255;
    } else if (colour === 2) {
      rgba[d] = flat[s] ?? 0;
      rgba[d + 1] = flat[s + 1] ?? 0;
      rgba[d + 2] = flat[s + 2] ?? 0;
      rgba[d + 3] = 255;
    } else if (colour === 3) {
      const idx = flat[s] ?? 0;
      rgba[d] = palette[idx * 3] ?? 0;
      rgba[d + 1] = palette[idx * 3 + 1] ?? 0;
      rgba[d + 2] = palette[idx * 3 + 2] ?? 0;
      rgba[d + 3] = paletteAlpha[idx] ?? 255;
    } else if (colour === 4) {
      const g = flat[s] ?? 0;
      rgba[d] = g;
      rgba[d + 1] = g;
      rgba[d + 2] = g;
      rgba[d + 3] = flat[s + 1] ?? 0;
    } else {
      rgba[d] = flat[s] ?? 0;
      rgba[d + 1] = flat[s + 1] ?? 0;
      rgba[d + 2] = flat[s + 2] ?? 0;
      rgba[d + 3] = flat[s + 3] ?? 0;
    }
  }
  return { frames: [{ label, width, height, rgba }], undecoded: [] };
}

// ---------------------------------------------------------------------------
// GIF

/** The variable-width LZW the GIF image data is packed with. */
function lzwDecode(
  minCodeSize: number,
  data: Uint8Array,
  expected: number,
): Uint8Array {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const firstOf = new Uint8Array(4096);
  for (let i = 0; i < clear; i += 1) {
    prefix[i] = -1;
    suffix[i] = i;
    firstOf[i] = i;
  }
  const out = new Uint8Array(expected);
  const stack = new Uint8Array(4096);
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  let prev = -1;
  let bitBuf = 0;
  let bitCount = 0;
  let pos = 0;
  let o = 0;
  while (o < expected) {
    while (bitCount < codeSize) {
      if (pos >= data.length) return out.subarray(0, o);
      bitBuf |= (data[pos] ?? 0) << bitCount;
      pos += 1;
      bitCount += 8;
    }
    const code = bitBuf & ((1 << codeSize) - 1);
    bitBuf >>>= codeSize;
    bitCount -= codeSize;
    if (code === clear) {
      codeSize = minCodeSize + 1;
      next = eoi + 1;
      prev = -1;
      continue;
    }
    if (code === eoi) break;
    let cur = code;
    let sp = 0;
    if (code === next && prev >= 0) {
      stack[sp] = firstOf[prev] ?? 0;
      sp += 1;
      cur = prev;
    } else if (code > next) break;
    while (cur >= clear) {
      stack[sp] = suffix[cur] ?? 0;
      sp += 1;
      cur = prefix[cur] ?? -1;
      if (cur < 0) return out.subarray(0, o);
    }
    const firstByte = cur & 0xff;
    stack[sp] = firstByte;
    sp += 1;
    while (sp > 0 && o < expected) {
      sp -= 1;
      out[o] = stack[sp] ?? 0;
      o += 1;
    }
    if (prev >= 0 && next < 4096) {
      prefix[next] = prev;
      suffix[next] = firstByte;
      firstOf[next] = firstOf[prev] ?? 0;
      next += 1;
      if (next === 1 << codeSize && codeSize < 12) codeSize += 1;
    }
    prev = code;
  }
  return out;
}

/** GIF sub-blocks: a length byte, that many bytes, repeat until length 0. */
function readSubBlocks(bytes: Uint8Array, start: number): [Uint8Array, number] {
  const parts: Uint8Array[] = [];
  let i = start;
  while (i < bytes.length) {
    const len = bytes[i] ?? 0;
    i += 1;
    if (len === 0) break;
    parts.push(bytes.subarray(i, i + len));
    i += len;
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const joined = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    joined.set(p, o);
    o += p.length;
  }
  return [joined, i];
}

const INTERLACE_PASSES: ReadonlyArray<readonly [number, number]> = [
  [0, 8],
  [4, 8],
  [2, 4],
  [1, 2],
];

function decodeGif(label: string, bytes: Uint8Array): DecodedRaster {
  const magic = String.fromCharCode(...bytes.subarray(0, 6));
  if (magic !== 'GIF87a' && magic !== 'GIF89a')
    return { frames: [], undecoded: [`${label}: not a GIF`] };
  const packed = bytes[10] ?? 0;
  let i = 13;
  // `bytes.subarray(0, 0)`, not `new Uint8Array(0)`: under
  // `exactOptionalPropertyTypes`-era lib types a `Uint8Array` literal is
  // `Uint8Array<ArrayBuffer>` while a subarray of a parameter is
  // `Uint8Array<ArrayBufferLike>`, and the two do not assign in the
  // direction this variable is reassigned. An empty slice of the input has
  // the input's own buffer type and is the same zero bytes.
  let globalTable = bytes.subarray(0, 0);
  if ((packed & 0x80) !== 0) {
    const size = 3 * (1 << ((packed & 0x07) + 1));
    globalTable = bytes.subarray(i, i + size);
    i += size;
  }
  const frames: RasterFrame[] = [];
  const undecoded: string[] = [];
  let transparent = -1;
  let n = 0;
  while (i < bytes.length) {
    const marker = bytes[i] ?? 0;
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      const kind = bytes[i + 1] ?? 0;
      const [block, after] = readSubBlocks(bytes, i + 2);
      if (kind === 0xf9)
        transparent = ((block[0] ?? 0) & 0x01) !== 0 ? (block[3] ?? 0) : -1;
      i = after;
      continue;
    }
    if (marker !== 0x2c) {
      undecoded.push(
        `${label}#${String(n)}: unknown block 0x${marker.toString(16)}`,
      );
      break;
    }
    const w = u16le(bytes, i + 5);
    const h = u16le(bytes, i + 7);
    const local = bytes[i + 9] ?? 0;
    let j = i + 10;
    let table = globalTable;
    if ((local & 0x80) !== 0) {
      const size = 3 * (1 << ((local & 0x07) + 1));
      table = bytes.subarray(j, j + size);
      j += size;
    }
    const minCodeSize = bytes[j] ?? 0;
    const [data, after] = readSubBlocks(bytes, j + 1);
    const indices = lzwDecode(minCodeSize, data, w * h);
    const rgba = new Uint8Array(w * h * 4);
    const interlaced = (local & 0x40) !== 0;
    const rowOf: number[] = [];
    if (interlaced)
      for (const [start, step] of INTERLACE_PASSES)
        for (let y = start; y < h; y += step) rowOf.push(y);
    else for (let y = 0; y < h; y += 1) rowOf.push(y);
    for (let src = 0; src < w * h; src += 1) {
      const y = rowOf[Math.floor(src / w)] ?? 0;
      const d = (y * w + (src % w)) * 4;
      const idx = indices[src] ?? 0;
      rgba[d] = table[idx * 3] ?? 0;
      rgba[d + 1] = table[idx * 3 + 1] ?? 0;
      rgba[d + 2] = table[idx * 3 + 2] ?? 0;
      rgba[d + 3] = idx === transparent ? 0 : 255;
    }
    frames.push({ label: `${label}#${String(n)}`, width: w, height: h, rgba });
    n += 1;
    i = after;
  }
  if (frames.length === 0 && undecoded.length === 0)
    undecoded.push(`${label}: no image blocks`);
  return { frames, undecoded };
}

// ---------------------------------------------------------------------------
// ICNS

/** Entry types that carry no image: a table of contents, a version, names. */
const ICNS_METADATA = new Set(['TOC ', 'icnV', 'name', 'info']);

/**
 * The ARGB entry types, and the square each one covers.
 *
 * NOT a legacy concern, which is what this file assumed until s9 Sc 6 read
 * the artefact instead of the format's history. `iconutil` on macOS 15 emits
 * a modern `.icns` in TWO encodings: every slot from `icon_16x16@2x` upward
 * is a whole PNG, and the 16pt and 32pt slots are ARGB. So the bundle icon,
 * built the supported way from a standard `.iconset`, arrives here as nine
 * PNGs and two ARGBs — and a reader that knows only PNG leaves the two
 * SMALLEST renderings unswept. Those are the Finder list icon and the
 * menu-bar-size icon: precisely the two a designer hand-tunes when the
 * vector stops reading at size, which is precisely when a new colour gets
 * introduced.
 *
 * The square cannot be recovered from the payload. An ARGB entry is a magic
 * followed by a byte stream, with the dimensions implied by the OSType
 * alone, so this map is their only source and an ARGB type that is not in it
 * is REPORTED rather than guessed at.
 */
const ICNS_ARGB_SIDE = new Map<string, number>([
  ['ic04', 16],
  ['ic05', 32],
]);

const startsWithArgb = (d: Uint8Array): boolean =>
  String.fromCharCode(...d.subarray(0, 4)) === 'ARGB';

/**
 * Apple's PackBits variant, as used by every run-length entry in an `.icns`.
 *
 * It is NOT stock TIFF PackBits, and the difference is silent: the control
 * byte is unsigned, and a run's length is `c - 125` (3..130) rather than
 * `257 - c`. Decoding one as the other yields plausible-looking noise, never
 * an error. So the caller is given no room to accept a partial read: `want`
 * comes in, and a stream that does not fill it EXACTLY while consuming
 * EXACTLY all of its input returns null, which the caller reports as
 * undecoded. Landing on both totals by accident is not a thing a wrong
 * variant does twice.
 */
function unpackIcnsRle(src: Uint8Array, want: number): Uint8Array | null {
  const out = new Uint8Array(want);
  let s = 0;
  let d = 0;
  while (d < want && s < src.length) {
    const c = src[s] ?? 0;
    s += 1;
    if (c >= 0x80) {
      const run = c - 125;
      if (s >= src.length || d + run > want) return null;
      out.fill(src[s] ?? 0, d, d + run);
      s += 1;
      d += run;
    } else {
      const run = c + 1;
      if (s + run > src.length || d + run > want) return null;
      out.set(src.subarray(s, s + run), d);
      s += run;
      d += run;
    }
  }
  return d === want && s === src.length ? out : null;
}

/**
 * One ARGB entry: four planes, A then R then G then B, each `side * side`
 * bytes, run-length-encoded as one continuous stream behind the magic.
 *
 * The stored alpha is STRAIGHT, not premultiplied, and this reader does not
 * touch it. `iconutil` does round the colour through premultiplied space on
 * the way in, which visibly shifts RGB on low-alpha edge pixels — brand blue
 * `rgb(10, 132, 255)` at alpha 1 comes back as cyan `rgb(0, 255, 255)`, and
 * at alpha 29 as `rgb(9, 132, 255)`. That is a property of the committed
 * artefact rather than of this reader, and un-rounding it here would be the
 * decoder deciding what the sweep is allowed to see. Those are real pixels
 * in the shipped icon; they get a real verdict.
 */
function decodeIcnsArgb(
  label: string,
  type: string,
  data: Uint8Array,
): DecodedRaster {
  const side = ICNS_ARGB_SIDE.get(type);
  if (side === undefined)
    return {
      frames: [],
      undecoded: [`${label}:${type}: an ARGB entry of no recorded size`],
    };
  const n = side * side;
  const planes = unpackIcnsRle(data.subarray(4), n * 4);
  if (planes === null)
    return {
      frames: [],
      undecoded: [
        `${label}:${type}: ARGB stream is not ${String(side)}x${String(side)}`,
      ],
    };
  const rgba = new Uint8Array(n * 4);
  for (let p = 0; p < n; p += 1) {
    rgba[p * 4] = planes[n + p] ?? 0;
    rgba[p * 4 + 1] = planes[n * 2 + p] ?? 0;
    rgba[p * 4 + 2] = planes[n * 3 + p] ?? 0;
    rgba[p * 4 + 3] = planes[p] ?? 0;
  }
  return {
    frames: [{ label: `${label}:${type}`, width: side, height: side, rgba }],
    undecoded: [],
  };
}

function decodeIcns(label: string, bytes: Uint8Array): DecodedRaster {
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'icns')
    return { frames: [], undecoded: [`${label}: not an ICNS`] };
  const total = Math.min(u32(bytes, 4), bytes.length);
  const frames: RasterFrame[] = [];
  const undecoded: string[] = [];
  let i = 8;
  while (i + 8 <= total) {
    const type = String.fromCharCode(...bytes.subarray(i, i + 4));
    const len = u32(bytes, i + 4);
    if (len < 8) break;
    const data = bytes.subarray(i + 8, i + len);
    if (!ICNS_METADATA.has(type)) {
      if (startsWithPng(data)) {
        const inner = decodePng(`${label}:${type}`, data);
        frames.push(...inner.frames);
        undecoded.push(...inner.undecoded);
      } else if (startsWithArgb(data)) {
        const inner = decodeIcnsArgb(label, type, data);
        frames.push(...inner.frames);
        undecoded.push(...inner.undecoded);
      } else {
        // Raw 24-bit RLE (`is32`, `il32`) and JPEG-2000. Reported, never
        // skipped: an entry this reader cannot see is an entry the hue
        // sweep did not sweep.
        undecoded.push(`${label}:${type}: not an embedded PNG or ARGB`);
      }
    }
    i += len;
  }
  if (frames.length === 0 && undecoded.length === 0)
    undecoded.push(`${label}: no icon entries`);
  return { frames, undecoded };
}

// ---------------------------------------------------------------------------
// the sweep

/** Dispatch on the MAGIC, then on the extension. Content wins. */
export function decodeRaster(rel: string, bytes: Uint8Array): DecodedRaster {
  const lower = rel.toLowerCase();
  if (startsWithPng(bytes)) return decodePng(rel, bytes);
  if (String.fromCharCode(...bytes.subarray(0, 3)) === 'GIF')
    return decodeGif(rel, bytes);
  if (String.fromCharCode(...bytes.subarray(0, 4)) === 'icns')
    return decodeIcns(rel, bytes);
  return {
    frames: [],
    undecoded: [
      `${rel}: unrecognised container (extension says ${lower.slice(lower.lastIndexOf('.'))})`,
    ],
  };
}

/**
 * Every green pixel in a raster, plus every part of it that was not read.
 *
 * Fully transparent pixels are skipped: their RGB is undefined by the
 * format, encoders write garbage there, and a verdict on garbage is noise.
 * Everything else gets the same `greenVerdict` as the token sheet.
 */
/**
 * How many offending PIXELS one call may NAME before it starts counting.
 *
 * Found the hard way while proving this sweep bites. The launch GIF is 72
 * frames of 1200x750, so a mutation that turns a COMMON palette entry green
 * makes tens of millions of pixels offenders at once, and a list with one
 * string per offender is hundreds of megabytes of message for a failure whose
 * information content is "this file is green". The first attempt at that
 * tooth did not report a failure at all: it killed the vitest worker on
 * memory, which reads as an infrastructure flake rather than as the red row
 * it actually was.
 *
 * The cap is on the MESSAGE and not on the sweep. Every pixel of every frame
 * is still examined, the true total is still counted and still printed, and
 * the returned array is still non-empty for a single offending pixel, so
 * every caller's `toEqual([])` and `length === 0` mean exactly what they
 * meant before. What changes is only that a catastrophic failure now prints
 * two dozen examples and a number instead of trying to print all of them.
 */
const OFFENDER_SAMPLE_CAP = 24;

export function rasterGreenOffenders(rel: string, bytes: Uint8Array): string[] {
  const decoded = decodeRaster(rel, bytes);
  const out = decoded.undecoded.map((u) => `${u} (UNDECODED, so unswept)`);
  let green = 0;
  for (const frame of decoded.frames)
    for (let p = 0; p < frame.width * frame.height; p += 1) {
      const d = p * 4;
      if ((frame.rgba[d + 3] ?? 0) === 0) continue;
      const literal = `rgb(${String(frame.rgba[d] ?? 0)}, ${String(
        frame.rgba[d + 1] ?? 0,
      )}, ${String(frame.rgba[d + 2] ?? 0)})`;
      const verdict = greenVerdict(literal);
      if (verdict?.green === true) {
        green += 1;
        if (green <= OFFENDER_SAMPLE_CAP)
          out.push(
            `${frame.label}@${String(p % frame.width)},${String(
              Math.floor(p / frame.width),
            )}: ${literal} — ${verdict.why}`,
          );
      }
    }
  if (green > OFFENDER_SAMPLE_CAP)
    out.push(
      `${rel}: and ${String(green - OFFENDER_SAMPLE_CAP)} further green` +
        ` pixels, ${String(green)} in all; the ${String(OFFENDER_SAMPLE_CAP)}` +
        ' named above are the first the sweep reached, in frame order',
    );
  return out;
}
