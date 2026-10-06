/**
 * v2 A0t + A0p: what `main.ts` composes. The tick loop and the park live in
 * the one file no in-process harness boots (it is a top-level script that
 * takes a lock, listens on a port and probes the machine), so these rows
 * read its source. They pin the four claims a refactor could silently drop:
 *
 *  1. the daemon is composed parked, with a literal, never from config/env;
 *  2. something actually calls `daemon.tick()` on an interval;
 *  3. the interval does not keep the process alive on its own;
 *  4. shutdown stops the loop and drains the running tick BEFORE the
 *     daemon (and its store) goes down.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.ts'),
  'utf8',
);

describe('main.ts: the park is a literal', () => {
  it("composes startDaemon with autonomy: 'parked'", () => {
    expect(src).toMatch(/startDaemon\(\{[\s\S]*?autonomy: 'parked',/);
  });
  it('never reads autonomy from the environment or a setting', () => {
    expect(src).not.toMatch(/autonomy:\s*(process\.env|store\.|argv)/);
    expect(src.match(/autonomy:/g)).toHaveLength(1);
  });
});

describe('main.ts: the tick loop', () => {
  it('calls daemon.tick() on an interval, and unrefs it', () => {
    expect(src).toMatch(/setInterval\(\(\) => \{[\s\S]*?daemon\s*\.tick\(\)/);
    expect(src).toMatch(/tickLoop\.unref\(\)/);
  });
  it('a failing tick is caught, so the loop survives it', () => {
    expect(src).toMatch(/\.tick\(\)\s*\.catch\(/);
  });
  it('shutdown clears the loop and drains the tick before daemon.stop()', () => {
    const body = src.slice(src.indexOf('const shutdown = async'));
    const clear = body.indexOf('clearInterval(tickLoop)');
    const drain = body.indexOf('await drainTick()');
    const stop = body.indexOf('await daemon.stop()');
    expect(clear).toBeGreaterThan(-1);
    expect(drain).toBeGreaterThan(clear);
    expect(stop).toBeGreaterThan(drain);
  });
});

describe('main.ts: who supervises it (S2a row 13)', () => {
  it("WEMESSAGE_SUPERVISOR accepts 'launchd' and 'app' only", () => {
    // S2a adds a third launch shape, not a third supervisor: under the host
    // shape launchd still supervises (the host plist says so), and 'app'
    // stays legal and unused in S2. Read from source because this file
    // boots on import; the enum is the whole contract.
    const hits = [
      ...src.matchAll(/WEMESSAGE_SUPERVISOR: z\.enum\(\[([^\]]*)\]\)/g),
    ];
    expect(hits).toHaveLength(1);
    expect(hits[0]?.[1]).toBe("'launchd', 'app'");
  });
});
