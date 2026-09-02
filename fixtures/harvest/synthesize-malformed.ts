// Synthesizes the degrade-path corpus (spec Part 3.1: malformed blobs are
// "synthesized in-repo (truncate/byte-flip a synthetic blob programmatically)",
// not harvested). Deterministic: same input blob -> same outputs.
//
// Usage: pnpm tsx fixtures/harvest/synthesize-malformed.ts <corpusDir>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: synthesize-malformed.ts <corpusDir>');

const plain = readFileSync(join(dir, 'plain-ascii.bin'));

// Truncated mid-structure: cut inside the object graph, past the header.
writeFileSync(join(dir, 'malformed-truncated.bin'), plain.subarray(0, 40));

// Corrupted header: byte-flip inside the "streamtyped" signature.
const header = Buffer.from(plain);
header[2] ^= 0xff;
header[6] ^= 0xff;
writeFileSync(join(dir, 'malformed-header.bin'), header);

// Deterministic pseudo-random bytes (xorshift32, fixed seed).
let x = 0x12345678 >>> 0;
const random = Buffer.alloc(96);
for (let i = 0; i < random.length; i++) {
  x ^= (x << 13) >>> 0;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= (x << 5) >>> 0;
  x >>>= 0;
  random[i] = x & 0xff;
}
writeFileSync(join(dir, 'malformed-random.bin'), random);

console.log(`wrote malformed-{truncated,header,random}.bin to ${dir}`);
