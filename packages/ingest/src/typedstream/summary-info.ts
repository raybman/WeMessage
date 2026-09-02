/**
 * message_summary_info decoder (edited messages, plan §2.4 "Edited messages").
 *
 * chat.db stores message_summary_info as a plain binary plist (bplist00):
 *   { amc: int, ec: { "<partIndex>": [ { d: seconds, t: <typedstream data> },
 *     ... ] }, ... }
 * Each revision's `t` is an attributedBody-format typedstream blob; the last
 * array element is the current (post-edit) text.
 *
 * The bplist reader below is clean-room, written from Apple's published
 * binary-plist format description (CFBinaryPList format comments), supporting
 * only the object types this payload uses. Typed failures, never throws out.
 */
import { decodeTypedstreamText, type DecodeResult } from './decoder.js';

class Malformed extends Error {}

type PlistValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | PlistValue[]
  | { [key: string]: PlistValue };

function parseBplist(bytes: Uint8Array): PlistValue {
  if (bytes.length < 40 || latin1(bytes.subarray(0, 8)) !== 'bplist00') {
    throw new Malformed('not a bplist00 payload');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Trailer: last 32 bytes, big-endian.
  const t = bytes.length - 32;
  const offsetIntSize = bytes[t + 6]!;
  const objectRefSize = bytes[t + 7]!;
  const numObjects = Number(view.getBigUint64(t + 8));
  const topObject = Number(view.getBigUint64(t + 16));
  const offsetTableOffset = Number(view.getBigUint64(t + 24));

  function uintAt(pos: number, size: number): number {
    let v = 0;
    for (let i = 0; i < size; i++) {
      if (pos + i >= bytes.length) throw new Malformed('uint out of range');
      v = v * 256 + bytes[pos + i]!;
    }
    return v;
  }

  function objectOffset(ref: number): number {
    if (ref >= numObjects)
      throw new Malformed(`object ref ${ref} out of range`);
    return uintAt(offsetTableOffset + ref * offsetIntSize, offsetIntSize);
  }

  function parseAt(offset: number, depth: number): PlistValue {
    if (depth > 32) throw new Malformed('bplist nesting too deep');
    if (offset >= bytes.length)
      throw new Malformed('object offset out of range');
    const marker = bytes[offset]!;
    const type = marker >> 4;
    const info = marker & 0x0f;

    const sized = (): { count: number; start: number } => {
      if (info !== 0x0f) return { count: info, start: offset + 1 };
      // Extended length: an int object follows the marker.
      const intMarker = bytes[offset + 1]!;
      if (intMarker >> 4 !== 0x1) throw new Malformed('bad extended length');
      const size = 1 << (intMarker & 0x0f);
      return { count: uintAt(offset + 2, size), start: offset + 2 + size };
    };

    switch (type) {
      case 0x0: // null / bool
        if (info === 0x0) return null;
        if (info === 0x8) return false;
        if (info === 0x9) return true;
        throw new Malformed(
          `unsupported simple marker 0x${marker.toString(16)}`,
        );
      case 0x1: // int, 2^info bytes big-endian
        return uintAt(offset + 1, 1 << info);
      case 0x2: {
        // real, 2^info bytes
        const size = 1 << info;
        if (size === 4) return view.getFloat32(offset + 1);
        if (size === 8) return view.getFloat64(offset + 1);
        throw new Malformed(`unsupported real size ${size}`);
      }
      case 0x3: // date: 8-byte float (seconds since 2001-01-01)
        return view.getFloat64(offset + 1);
      case 0x4: {
        // data
        const { count, start } = sized();
        if (start + count > bytes.length)
          throw new Malformed('data out of range');
        return bytes.subarray(start, start + count);
      }
      case 0x5: {
        // ASCII string
        const { count, start } = sized();
        return latin1(bytes.subarray(start, start + count));
      }
      case 0x6: {
        // UTF-16BE string
        const { count, start } = sized();
        let s = '';
        for (let i = 0; i < count; i++) {
          s += String.fromCharCode(view.getUint16(start + 2 * i));
        }
        return s;
      }
      case 0xa: {
        // array of object refs
        const { count, start } = sized();
        const out: PlistValue[] = [];
        for (let i = 0; i < count; i++) {
          out.push(
            parseAt(
              objectOffset(uintAt(start + i * objectRefSize, objectRefSize)),
              depth + 1,
            ),
          );
        }
        return out;
      }
      case 0xd: {
        // dict: key refs then value refs
        const { count, start } = sized();
        const out: { [key: string]: PlistValue } = {};
        for (let i = 0; i < count; i++) {
          const key = parseAt(
            objectOffset(uintAt(start + i * objectRefSize, objectRefSize)),
            depth + 1,
          );
          const value = parseAt(
            objectOffset(
              uintAt(start + (count + i) * objectRefSize, objectRefSize),
            ),
            depth + 1,
          );
          if (typeof key !== 'string')
            throw new Malformed('non-string dict key');
          out[key] = value;
        }
        return out;
      }
      default:
        throw new Malformed(
          `unsupported bplist marker 0x${marker.toString(16)}`,
        );
    }
  }

  return parseAt(objectOffset(topObject), 0);
}

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

/**
 * Extract the CURRENT (latest revision) text of part 0 from a
 * message_summary_info payload. Typed failure on any malformation.
 */
export function decodeSummaryInfoLatestText(bytes: Uint8Array): DecodeResult {
  try {
    const root = parseBplist(bytes);
    if (root === null || typeof root !== 'object' || Array.isArray(root)) {
      throw new Malformed('summary info root is not a dict');
    }
    const ec = (root as { [key: string]: PlistValue })['ec'];
    if (
      ec === null ||
      ec === undefined ||
      typeof ec !== 'object' ||
      Array.isArray(ec)
    ) {
      throw new Malformed('summary info has no edit-content dict (ec)');
    }
    const parts = Object.keys(ec).sort();
    const first = parts[0];
    if (first === undefined) throw new Malformed('edit-content dict is empty');
    const revisions = (ec as { [key: string]: PlistValue })[first];
    if (!Array.isArray(revisions) || revisions.length === 0) {
      throw new Malformed('edit revisions missing');
    }
    const latest = revisions[revisions.length - 1];
    if (
      latest === null ||
      typeof latest !== 'object' ||
      Array.isArray(latest)
    ) {
      throw new Malformed('latest revision is not a dict');
    }
    const blob = (latest as { [key: string]: PlistValue })['t'];
    if (!(blob instanceof Uint8Array)) {
      throw new Malformed('latest revision has no typedstream payload (t)');
    }
    return decodeTypedstreamText(blob);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'malformed',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
