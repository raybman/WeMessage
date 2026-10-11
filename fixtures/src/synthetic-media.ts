/**
 * v2 F6: media bytes made in the test, never read from a real file.
 *
 * `syntheticPng` writes a valid, decodable greyscale PNG with node:zlib, so
 * a test can serve real image bytes without a single image checked in.
 * `syntheticHeader` writes just enough of each closed-set format's magic for
 * a sniffer to recognise it, padded with zeros; it is not a decodable file
 * and nothing that renders should be handed one.
 */
import { deflateSync } from 'node:zlib';

const CRC_TABLE: readonly number[] = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t.push(c >>> 0);
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([len, typed, crc]);
}

/** A `w` x `h` 8-bit greyscale PNG, every pixel `grey` (0-255). */
export function syntheticPng(w: number, h: number, grey = 128): Buffer {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
    throw new Error('syntheticPng: width and height must be positive integers');
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: greyscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const row = Buffer.alloc(w + 1, grey & 0xff);
  row[0] = 0; // filter: none
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** Every format the daemon's closed sniff set knows, plus two it must not. */
export type SyntheticKind =
  | 'jpeg'
  | 'png'
  | 'gif'
  | 'webp'
  | 'heic'
  | 'heif'
  | 'mp4'
  | 'mov'
  | 'pdf'
  | 'caf'
  | 'html'
  | 'zip';

function ftyp(brand: string): Buffer {
  const b = Buffer.alloc(16);
  b.writeUInt32BE(16, 0);
  b.write('ftyp', 4, 'ascii');
  b.write(brand, 8, 'ascii');
  return b;
}

/** The leading bytes of a `kind` file, zero-padded to `size` (default 64). */
export function syntheticHeader(kind: SyntheticKind, size = 64): Buffer {
  const head: Buffer = (() => {
    switch (kind) {
      case 'jpeg':
        return Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
      case 'png':
        return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      case 'gif':
        return Buffer.from('GIF89a', 'ascii');
      case 'webp':
        return Buffer.concat([
          Buffer.from('RIFF', 'ascii'),
          Buffer.from([0x24, 0, 0, 0]),
          Buffer.from('WEBP', 'ascii'),
        ]);
      case 'heic':
        return ftyp('heic');
      case 'heif':
        return ftyp('mif1');
      case 'mp4':
        return ftyp('isom');
      case 'mov':
        return ftyp('qt  ');
      case 'pdf':
        return Buffer.from('%PDF-1.7\n', 'ascii');
      case 'caf':
        return Buffer.from('caff', 'ascii');
      case 'html':
        return Buffer.from('<!doctype html><script>', 'ascii');
      case 'zip':
        return Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    }
  })();
  const out = Buffer.alloc(Math.max(size, head.length));
  head.copy(out, 0);
  return out;
}
