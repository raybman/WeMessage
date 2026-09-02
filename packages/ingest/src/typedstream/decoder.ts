/**
 * Clean-room typedstream (NSArchiver "streamtyped") text extractor.
 *
 * Provenance (plan §2.2.1 / RD §3): knowledge ported from public typedstream
 * format documentation and from studying ReagentX's imessage-database
 * WRITE-UPS — never its GPL-3.0 code. Implemented from scratch in TypeScript
 * and validated byte-level against the synthetic corpus in
 * fixtures/typedstream/ (Apple's own NSArchiver output).
 *
 * Format facts this parser relies on (verified against corpus bytes):
 * - Header: 0x04 streamer version, length-prefixed signature "streamtyped",
 *   integer system version (1000 encodes as 0x81 0xE8 0x03).
 * - Integers: 0x00..0x7F literal; 0x81 = next 2 bytes LE; 0x82 = next 4 bytes
 *   LE. 0x83 is a float/double tag (unsupported here).
 * - Tags: 0x84 = inline ("new") value, 0x85 = nil, 0x86 = end of object.
 *   Bytes >= 0x92 are back-references into ONE shared table that registers
 *   type strings, classes, and objects in encounter order (index = byte-0x92).
 * - An archived NSAttributedString's first content value is its backing
 *   NSString; NSString content is a "+" typed value: byte length (integer,
 *   UTF-8 byte count) followed by UTF-8 bytes.
 *
 * Scope (S1, Scenario 5): extract the full plain text. Attribute runs after
 * the backing string are intentionally not consumed. Malformed input returns
 * a typed failure; no throw escapes this module (§2.2.1 degrade path).
 */

export type DecodeResult =
  | { ok: true; text: string }
  | { ok: false; error: { code: 'malformed'; message: string } };

const TAG_INT16 = 0x81;
const TAG_INT32 = 0x82;
const TAG_FLOAT = 0x83;
const TAG_NEW = 0x84;
const TAG_NIL = 0x85;
// (0x86 = TAG_END closes object contents; the extraction path stops at the
// backing string and never needs to consume it.)
const REF_BASE = 0x92;

class Malformed extends Error {}

interface ClassRef {
  refKind: 'class';
  name: string;
  chain: string[];
}
type TableEntry = string | ClassRef | { refKind: 'object'; className: string };

class Reader {
  private pos = 0;
  /** Shared back-reference table: type strings, classes, objects (in order). */
  readonly table: TableEntry[] = [];

  constructor(private readonly bytes: Uint8Array) {}

  private need(n: number): void {
    if (this.pos + n > this.bytes.length) {
      throw new Malformed(`unexpected end of stream at byte ${this.pos}`);
    }
  }

  byte(): number {
    this.need(1);
    return this.bytes[this.pos++]!;
  }

  peek(): number {
    this.need(1);
    return this.bytes[this.pos]!;
  }

  raw(n: number): Uint8Array {
    this.need(n);
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** Typedstream integer (lengths, versions). */
  int(): number {
    const b = this.byte();
    if (b < 0x80) return b;
    if (b === TAG_INT16) {
      const lo = this.byte();
      return lo | (this.byte() << 8);
    }
    if (b === TAG_INT32) {
      const b0 = this.byte();
      const b1 = this.byte();
      const b2 = this.byte();
      return (b0 | (b1 << 8) | (b2 << 16) | (this.byte() << 24)) >>> 0;
    }
    throw new Malformed(
      b === TAG_FLOAT
        ? 'unsupported float where integer expected'
        : `bad integer head 0x${b.toString(16)}`,
    );
  }

  /** Length-prefixed byte string (signature, class names, type strings). */
  pascalString(): string {
    const len = this.int();
    return latin1(this.raw(len));
  }

  /** Shared string: inline (registered) or back-reference. */
  sharedString(): string {
    const b = this.peek();
    if (b === TAG_NEW) {
      this.byte();
      const s = this.pascalString();
      this.table.push(s);
      return s;
    }
    if (b >= REF_BASE) {
      this.byte();
      const entry = this.table[b - REF_BASE];
      if (typeof entry !== 'string') {
        throw new Malformed(
          `string back-reference ${b - REF_BASE} is not a string`,
        );
      }
      return entry;
    }
    throw new Malformed(`bad shared-string head 0x${b.toString(16)}`);
  }

  /** Class (chain of name+version up to a nil superclass, or a reference). */
  clazz(): ClassRef {
    const b = this.peek();
    if (b === TAG_NIL) {
      this.byte();
      return { refKind: 'class', name: '', chain: [] };
    }
    if (b === TAG_NEW) {
      this.byte();
      // The class name is itself a shared string (0x84-inline or a ref).
      const name = this.sharedString();
      this.int(); // class version (unused for extraction)
      const self: ClassRef = { refKind: 'class', name, chain: [name] };
      this.table.push(self);
      const parent = this.clazz();
      self.chain.push(...parent.chain);
      return self;
    }
    if (b >= REF_BASE) {
      // Back-reference to an already-seen class (e.g. an NSObject superclass
      // terminating a chain). The text-extraction path never depends on the
      // referenced chain's contents — the inline names read before the ref
      // are what we match on — so accept it opaquely instead of re-deriving
      // the archiver's reference-numbering scheme.
      this.byte();
      return { refKind: 'class', name: '', chain: [] };
    }
    throw new Malformed(`bad class head 0x${b.toString(16)}`);
  }
}

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

const utf8 = new TextDecoder('utf-8', { fatal: false });

function readHeader(r: Reader): void {
  const version = r.byte();
  if (version !== 0x04) {
    throw new Malformed(
      `unsupported streamer version 0x${version.toString(16)}`,
    );
  }
  const signature = r.pascalString();
  if (signature !== 'streamtyped') {
    throw new Malformed(`bad signature ${JSON.stringify(signature)}`);
  }
  r.int(); // system version
}

/** Read an object head and return its class chain (registers the object). */
function objectClassChain(r: Reader): string[] {
  const b = r.peek();
  if (b === TAG_NEW) {
    r.byte();
    const cls = r.clazz();
    r.table.push({ refKind: 'object', className: cls.name });
    return cls.chain;
  }
  throw new Malformed(`bad object head 0x${b.toString(16)}`);
}

/** NSString-family object contents: "+" typed value = UTF-8 byte run. */
function readStringObject(r: Reader): string {
  const type = r.sharedString();
  if (type !== '+' && type !== '*') {
    throw new Malformed(
      `unexpected NSString content type ${JSON.stringify(type)}`,
    );
  }
  const byteLen = r.int();
  return utf8.decode(r.raw(byteLen));
}

/**
 * Decode an attributedBody typedstream blob to its full plain text.
 * Never throws: malformed input yields a typed failure (§2.2.1).
 */
export function decodeTypedstreamText(bytes: Uint8Array): DecodeResult {
  try {
    const r = new Reader(bytes);
    readHeader(r);

    const rootType = r.sharedString();
    if (!rootType.includes('@')) {
      throw new Malformed(`root value is not an object (type ${rootType})`);
    }
    const chain = objectClassChain(r);

    if (chain.includes('NSString') || chain.includes('NSMutableString')) {
      // Bare archived string (defensive; not produced by Messages).
      return { ok: true, text: readStringObject(r) };
    }
    if (!chain.includes('NSAttributedString')) {
      throw new Malformed(
        `root object is ${chain[0] ?? '?'}, not an attributed string`,
      );
    }

    // First content value of NS(Mutable)AttributedString: the backing string.
    const innerType = r.sharedString();
    if (!innerType.includes('@')) {
      throw new Malformed(`backing value is not an object (type ${innerType})`);
    }
    const innerChain = objectClassChain(r);
    if (!innerChain.includes('NSString')) {
      throw new Malformed(
        `backing object is ${innerChain[0] ?? '?'}, not a string`,
      );
    }
    return { ok: true, text: readStringObject(r) };
    // Attribute runs after the backing string are not needed for text.
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
