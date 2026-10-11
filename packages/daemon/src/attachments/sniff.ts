/**
 * v2 F6b: the Content-Type of a served attachment comes from its first
 * bytes, over a closed set (D-F6-9). The `mime_type` chat.db stores was
 * written by the sender's device and is never trusted for the header: a
 * file that claims text/html and starts with a PNG signature is a PNG, and
 * a file this set does not know is `application/octet-stream`.
 */

export type SniffedMime =
  | 'image/jpeg'
  | 'image/png'
  | 'image/gif'
  | 'image/webp'
  | 'image/heic'
  | 'video/mp4'
  | 'video/quicktime'
  | 'application/pdf'
  | 'audio/x-caf';

/** How many leading bytes `sniff` needs to see. */
export const SNIFF_BYTES = 16;

const HEIC_BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'mif1',
  'msf1',
]);
const MP4_BRANDS = new Set(['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V ']);

function ascii(b: Uint8Array, from: number, to: number): string {
  if (b.length < to) return '';
  return String.fromCharCode(...b.subarray(from, to));
}

function startsWith(b: Uint8Array, bytes: readonly number[]): boolean {
  if (b.length < bytes.length) return false;
  return bytes.every((v, i) => b[i] === v);
}

export function sniff(head: Uint8Array): SniffedMime | null {
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  const six = ascii(head, 0, 6);
  if (six === 'GIF87a' || six === 'GIF89a') return 'image/gif';
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (ascii(head, 4, 8) === 'ftyp') {
    const brand = ascii(head, 8, 12);
    if (HEIC_BRANDS.has(brand)) return 'image/heic';
    if (MP4_BRANDS.has(brand)) return 'video/mp4';
    if (brand === 'qt  ') return 'video/quicktime';
    return null;
  }
  if (ascii(head, 0, 5) === '%PDF-') return 'application/pdf';
  if (ascii(head, 0, 4) === 'caff') return 'audio/x-caf';
  return null;
}
