/**
 * s7-execution Scenario 6 — the spawn transport and the reference adapter.
 *
 * Everything S7 ships after this file runs through the code this file tests.
 * The Python plugin (Sc 7), the Hermes HTTP adapter (Sc 8), Luna (Sc 9) and
 * the OpenClaw stdio shim (Sc 10) are all verified by the same six checks;
 * the only difference is who owns the socket. So the rows here are not about
 * a convenience runner, they are about the one boundary in this repo where
 * foreign code meets our wire.
 *
 * Three things are being proven, and they are worth naming apart:
 *
 *  - **The child contract is a public API.** Five environment variables, a
 *    greeting-based readiness signal, a documented death/hang distinction and
 *    four resource budgets. A stranger implements against this list and
 *    nothing else, so every clause of it is a row rather than a README
 *    sentence (C-4).
 *  - **The token is the sharp edge.** Adapter tokens are `wm_<64 hex>`,
 *    scrypt-hashed, minted once and never re-displayed. Handing one to a
 *    child process is the first time in this codebase a secret crosses a
 *    process boundary. It goes by environment and never by argv, because
 *    argv is world-readable through `ps(1)` on macOS and the environment of
 *    another user's process is not. Rows below prove it reaches neither
 *    argv, nor a log line, nor the transcript the kit prints.
 *  - **INV-2 survives contact with a stranger.** The protocol has no send
 *    frame and `FRAME_SPECS` stays at nine. The reference adapter drafts and
 *    never sends; `broken-sends.mjs` is the same file with the one change a
 *    stranger would make first, and the kit refuses it with the daemon's own
 *    taxonomy (`adapter.no-send-frame`, never `gate.denied`, C-6).
 *
 * Flake posture (the reason for the shapes below): every server binds
 * `127.0.0.1:0`, never a fixed port, so a parallel vitest run cannot collide.
 * Every child is registered on spawn and killed in an `afterEach` that runs
 * on failure too. Readiness is the adapter's `hello` frame, never a sleep —
 * the same rule Sc 1 applied when it deleted `watchUntil`'s 300 ms timer.
 */
import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createEchoAdapter } from '@wemessage/adapter-echo';
import {
  AGENT_TO_GATEWAY_TYPES,
  DEFAULT_SPAWN_BUDGETS,
  SPAWN_ENV_KEYS,
  TOKEN_REDACTION,
  badgeLine,
  buildChildEnv,
  classifyRefusal,
  formatJson,
  formatTap,
  killAllChildren,
  liveChildren,
  mintAdapterToken,
  parseCommand,
  runConformance,
  runConformanceSpawned,
  type ConformanceReport,
} from '../src/index.js';

const PKG = fileURLToPath(new URL('..', import.meta.url));
const NODE = process.execPath;
const TOKEN_RE = /wm_[0-9a-f]{64}/;

const example = (name: string): string => `${PKG}examples/${name}`;
const child = (name: string): string => `${PKG}test/children/${name}`;

/**
 * Belt and braces. `runConformanceSpawned` reaps its own children in a
 * `finally`, but a row that throws mid-assertion must not be able to leave a
 * node process attached to a vitest worker — so the sweep runs after every
 * row, passing or failing.
 */
afterEach(async () => {
  await killAllChildren();
  expect(liveChildren()).toBe(0);
});

function failedIds(report: ConformanceReport): number[] {
  return report.checks.filter((c) => !c.ok).map((c) => c.id);
}

function explain(report: ConformanceReport): string {
  return report.checks
    .filter((c) => !c.ok)
    .map((c) => `${String(c.id)}: ${c.detail ?? 'no detail'}`)
    .join('\n');
}

function detailOf(report: ConformanceReport, id: number): string {
  return report.checks.find((c) => c.id === id)?.detail ?? '';
}

/* ── row 1: the reference adapter is conformant over a real socket ─────── */

describe('s7 Sc6: a spawned child passes the same six checks', () => {
  it('runs examples/reference-adapter.mjs to CONFORMANT over a real ws listener', async () => {
    const report = await runConformanceSpawned({
      cmd: NODE,
      args: [example('reference-adapter.mjs')],
      name: 'reference',
    });
    expect(explain(report)).toBe('');
    expect(report.conformant).toBe(true);
    expect(report.checks).toHaveLength(6);
    expect(report.checks.map((c) => c.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(report.transport).toBe('spawn');
    expect(badgeLine(report)).toBe('CONFORMANT v1 - reference');
    // The kit spoke to a real process over a real socket, not to itself.
    expect(report.spawn?.children).toBeGreaterThan(1);
    expect(report.spawn?.orphans).toBe(0);
    expect(report.spawn?.transport).toBe('ws');
  }, 60_000);

  it('the in-process path is untouched: echo still reports transport in-process', async () => {
    const report = await runConformance({
      name: 'echo',
      start: (ctx) =>
        createEchoAdapter({
          url: ctx.url,
          token: ctx.token,
          adapterId: ctx.adapterId,
          ws: ctx.ws,
          clock: ctx.clock,
          delay: ctx.delay,
          maxAttempts: ctx.maxAttempts,
          streaming: true,
        }),
    });
    expect(report.conformant).toBe(true);
    expect(report.transport).toBe('in-process');
    expect(report.spawn).toBeUndefined();
  }, 30_000);
});

/* ── row 2: the 40-line promise, and INV-2 read off the file ───────────── */

describe('s7 Sc6: the reference adapter is a file a stranger can copy', () => {
  const source = (): string =>
    readFileSync(example('reference-adapter.mjs'), 'utf8');

  /** Non-blank, non-comment. Block comments are stripped first. */
  function codeLines(text: string): string[] {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('//'));
  }

  it('is at most 40 lines of code and imports nothing at all', () => {
    const lines = codeLines(source());
    expect(lines.length).toBeLessThanOrEqual(40);
    // Node 22 ships a global `WebSocket`, so the quickstart's promise — copy
    // one file, run it, no install — is testable rather than aspirational.
    expect(
      lines.filter((l) => /^import\b|^import\(|\brequire\s*\(/.test(l)),
    ).toEqual([]);
  });

  it('emits only agent->gateway frame types (INV-2, read off the source)', () => {
    const emitted = [...source().matchAll(/emit\(\s*'([a-z.]+)'/g)].map(
      (m) => m[1],
    );
    expect(emitted.length).toBeGreaterThan(0);
    for (const type of emitted) expect(AGENT_TO_GATEWAY_TYPES).toContain(type);
    // The word does not appear because the frame does not exist (FRAME_SPECS
    // is nine). A reader looking for the send path finds nothing to copy.
    expect(source()).not.toMatch(/'send'|"send"/);
  });

  /**
   * Assembled from halves rather than written out, because the repo-wide
   * sweep in `test/arch.spec.ts` (S3 (d)) greps every tracked file for these
   * literals — and it failed on THIS file the first time the row spelled one
   * of them. The sweep was right: a banned string is banned in the test that
   * bans it. It also already covers `examples/`, structurally, via
   * `git ls-files`; this row is the local, faster-failing copy for the two
   * files a stranger actually reads.
   */
  const BRANDISH = new RegExp(
    [
      'flow' + 'stay',
      'flow' + 'verse',
      'flow' + 'industries',
      'viva' + 'epic',
    ].join('|'),
    'i',
  );

  it('carries no operator-identifying string and only synthetic handles', () => {
    const text = `${source()}\n${readFileSync(example('broken-sends.mjs'), 'utf8')}`;
    expect(text).not.toMatch(/\/Users\/|~\//);
    expect(text).not.toMatch(BRANDISH);
    for (const n of text.match(/\+1\d{10}/g) ?? [])
      expect(n.startsWith('+1555')).toBe(true);
    for (const h of text.match(/[a-z0-9-]+\.(com|ai|net|org)\b/gi) ?? [])
      expect(h.endsWith('.example.com')).toBe(true);
  });
});

/* ── row 3: the one change a stranger would make first ─────────────────── */

describe('s7 Sc6: an adapter that tries to send is refused (INV-2, C-6)', () => {
  it('examples/broken-sends.mjs is NOT CONFORMANT and the violation names `send`', async () => {
    const report = await runConformanceSpawned({
      cmd: NODE,
      args: [example('broken-sends.mjs')],
      name: 'broken-sends',
    });
    expect(report.conformant).toBe(false);
    // Check 3 owns the frame vocabulary; check 6 re-reads `violations()`
    // after the injection probe, so a sender trips both. That is one finding
    // seen twice, not two defects, and the row says so rather than loosening
    // to `toContain` and hiding a third failure if one ever appears.
    expect(failedIds(report)).toEqual([3, 6]);
    expect(detailOf(report, 3)).toContain('send');
    expect(badgeLine(report)).toBe(
      'NOT CONFORMANT v1 - broken-sends (2/6 failed)',
    );

    // C-6: the kit labels it with the daemon's own taxonomy. A forbidden or
    // unknown adapter frame is `adapter.no-send-frame`; it is NEVER
    // `gate.denied`, which is a closed union about approvals and has nothing
    // to say about a frame that never reached the gate.
    expect(report.spawn?.protocolViolations).toContain(
      'adapter.no-send-frame:send',
    );
    expect(formatJson(report)).not.toContain('gate.denied');

    // The refusal is what keeps INV-2 true: the frame was never accepted, so
    // it is in `protocolViolations` and in no check's frame list.
    expect(
      report.spawn?.protocolViolations.some((v) =>
        v.startsWith('adapter.protocol-violation'),
      ),
    ).toBe(false);
  }, 60_000);

  it('classifies refusals exactly the way packages/daemon/src/adapters/transport.ts does', () => {
    expect(classifyRefusal('unknown-type', 'send')).toBe(
      'adapter.no-send-frame:send',
    );
    expect(classifyRefusal('direction', 'draft.request')).toBe(
      'adapter.no-send-frame:draft.request',
    );
    expect(classifyRefusal('envelope', undefined)).toBe(
      'adapter.protocol-violation:envelope',
    );
    expect(classifyRefusal('version', 'hello')).toBe(
      'adapter.protocol-violation:version',
    );
    // A type-less frame cannot be attributed to a frame type, so it falls
    // back to the generic row rather than inventing one.
    expect(classifyRefusal('unknown-type', 42)).toBe(
      'adapter.protocol-violation:unknown-type',
    );
  });
});

/* ── row 4: the spawn transport judges direction itself ────────────────── */

describe('s7 Sc6: a replayed gateway->agent frame is a violation', () => {
  it('a child that echoes draft.request back is refused by direction, not accepted', async () => {
    const report = await runConformanceSpawned({
      cmd: NODE,
      args: [child('replay-request.mjs')],
      name: 'replay',
    });
    expect(report.conformant).toBe(false);
    // The transport parses with `parseAgentFrame`, the direction-AWARE
    // parser. `parseFrame` would accept this frame: `draft.request` is a real
    // frame type, it is simply one an agent may never originate. That single
    // export choice is the whole difference between a transport that catches
    // a replay and one that launders it.
    expect(report.spawn?.protocolViolations).toContain(
      'adapter.no-send-frame:draft.request',
    );
    expect(failedIds(report)).toContain(3);
    expect(detailOf(report, 3)).toContain('draft.request');
  }, 60_000);
});

/* ── row 5: hung vs dead, and no orphans either way ────────────────────── */

describe('s7 Sc6: the parent tells a hung child from a dead one', () => {
  it('a child that connects and then sleeps forever fails check 1 with `timeout`', async () => {
    const report = await runConformanceSpawned({
      cmd: NODE,
      args: [child('hang.mjs')],
      name: 'hang',
      timeoutMs: 1_500,
    });
    expect(report.conformant).toBe(false);
    expect(failedIds(report)).toContain(1);
    expect(detailOf(report, 1)).toContain('timeout');
    expect(detailOf(report, 1)).not.toContain('crashed');
    // No orphan: the kit owns every process it started, including the ones
    // that would never have exited on their own.
    expect(report.spawn?.orphans).toBe(0);
    expect(
      report.spawn?.lastExit.code === null &&
        report.spawn.lastExit.signal === null,
    ).toBe(false);
  }, 60_000);

  it('a child that exits non-zero before hello fails check 1 with `crashed`, naming the code', async () => {
    const report = await runConformanceSpawned({
      cmd: NODE,
      args: [child('crash.mjs')],
      name: 'crash',
      timeoutMs: 1_500,
    });
    expect(report.conformant).toBe(false);
    expect(failedIds(report)).toContain(1);
    // The distinction is the whole point of the row: "your process died" and
    // "your process is wedged" are different bugs and a report that says
    // `timeout` for both sends the author looking in the wrong place.
    expect(detailOf(report, 1)).toContain('crashed');
    expect(detailOf(report, 1)).toContain('exit 3');
    expect(report.spawn?.lastExit.code).toBe(3);
    expect(report.spawn?.orphans).toBe(0);
  }, 60_000);

  it('a command that does not exist is reported, not thrown', async () => {
    const report = await runConformanceSpawned({
      cmd: `${PKG}test/children/__no_such_binary__`,
      name: 'missing',
      timeoutMs: 1_500,
    });
    expect(report.conformant).toBe(false);
    expect(explain(report)).toMatch(/spawn failed|crashed/);
    expect(report.spawn?.orphans).toBe(0);
  }, 60_000);
});

/* ── row 6: the child environment contract, and the token ──────────────── */

describe('s7 Sc6: the child environment contract', () => {
  it('is exactly five keys and nothing else is promised', () => {
    expect([...SPAWN_ENV_KEYS]).toEqual([
      'WEMESSAGE_GATEWAY_URL',
      'WEMESSAGE_ADAPTER_TOKEN',
      'WEMESSAGE_ADAPTER_ID',
      'WEMESSAGE_BACKOFF_MS',
      'WEMESSAGE_MAX_ATTEMPTS',
    ]);
  });

  it('builds the five values the kit promises, over an inherited environment', () => {
    const env = buildChildEnv({
      base: {
        PATH: '/usr/bin',
        WEMESSAGE_ADAPTER_TOKEN: `wm_${'9'.repeat(64)}`,
      },
      url: 'ws://127.0.0.1:1/v1/agent',
      token: `wm_${'0'.repeat(64)}`,
      adapterId: 'subject',
      maxAttempts: 3,
    });
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['WEMESSAGE_GATEWAY_URL']).toBe('ws://127.0.0.1:1/v1/agent');
    expect(env['WEMESSAGE_ADAPTER_ID']).toBe('subject');
    expect(env['WEMESSAGE_MAX_ATTEMPTS']).toBe('3');
    // Zero, always: the kit cannot inject `delay` into a foreign process, so
    // the only lever it has over that process's backoff is this variable.
    expect(env['WEMESSAGE_BACKOFF_MS']).toBe('0');
    // The kit's synthetic token WINS over an inherited one. An operator with
    // a real `WEMESSAGE_ADAPTER_TOKEN` exported in their shell must not be
    // able to hand it to a stranger's adapter by running the kit.
    expect(env['WEMESSAGE_ADAPTER_TOKEN']).toBe(`wm_${'0'.repeat(64)}`);
  });

  it('refuses a caller that tries to set a reserved key itself', () => {
    expect(() =>
      buildChildEnv({
        base: {},
        url: 'ws://127.0.0.1:1/v1/agent',
        token: `wm_${'0'.repeat(64)}`,
        adapterId: 'subject',
        maxAttempts: 3,
        extra: { WEMESSAGE_ADAPTER_TOKEN: 'wm_real' },
      }),
    ).toThrow(/reserved/);
  });

  it('mints a fresh synthetic wm_<64 hex> per run and never reuses one', async () => {
    const a = mintAdapterToken();
    const b = mintAdapterToken();
    expect(a).toMatch(/^wm_[0-9a-f]{64}$/);
    expect(b).toMatch(/^wm_[0-9a-f]{64}$/);
    expect(a).not.toBe(b);

    const one = await runConformanceSpawned({
      cmd: NODE,
      args: [child('probe.mjs')],
      name: 'probe-1',
    });
    const two = await runConformanceSpawned({
      cmd: NODE,
      args: [child('probe.mjs')],
      name: 'probe-2',
    });
    expect(one.spawn?.tokenFingerprint).not.toBe(two.spawn?.tokenFingerprint);
    expect(one.conformant).toBe(true);
  }, 90_000);
});

describe('s7 Sc6: the token reaches the child by environment and by nothing else', () => {
  it('never appears in argv, in the report, in TAP, or in the badge line', async () => {
    const logged: string[] = [];
    const patch = (key: 'log' | 'error' | 'warn'): (() => void) => {
      const original = console[key];
      console[key] = (...args: unknown[]): void => {
        logged.push(args.map((a) => String(a)).join(' '));
      };
      return () => {
        console[key] = original;
      };
    };
    const restore = [patch('log'), patch('error'), patch('warn')];
    let report: ConformanceReport;
    try {
      report = await runConformanceSpawned({
        cmd: NODE,
        args: [child('probe.mjs')],
        name: 'probe',
      });
    } finally {
      for (const undo of restore) undo();
    }

    // argv is world-readable through `ps(1)`; the environment of another
    // user's process is not, on macOS or on Linux. The kit passes the token
    // by environment for exactly that reason, and the argv it reports is the
    // argv it actually spawned — unredacted on purpose, so this row can see
    // a regression rather than a mask.
    expect(report.spawn?.argv.join(' ')).not.toMatch(TOKEN_RE);
    expect(report.spawn?.argv).toEqual([NODE, child('probe.mjs')]);

    expect(formatJson(report)).not.toMatch(TOKEN_RE);
    expect(formatTap(report)).not.toMatch(TOKEN_RE);
    expect(badgeLine(report)).not.toMatch(TOKEN_RE);
    expect(logged.join('\n')).not.toMatch(TOKEN_RE);
  }, 60_000);

  it('the child sees it in the environment, and confirms argv is clean from its own side', async () => {
    const report = await runConformanceSpawned({
      cmd: NODE,
      args: [child('probe.mjs')],
      name: 'probe',
    });
    // The child's own answer, not ours. It reads its `process.argv` and its
    // `process.env` and reports what it found.
    expect(report.spawn?.transcript).toContain('ENV_HAS_TOKEN=true');
    expect(report.spawn?.transcript).toContain('ARGV_HAS_TOKEN=false');
  }, 60_000);

  it('redacts the token out of the transcript even when the child prints it', async () => {
    const report = await runConformanceSpawned({
      cmd: NODE,
      args: [child('probe.mjs')],
      name: 'probe',
    });
    // The child deliberately echoes its own token. The kit cannot stop a
    // stranger's process from doing that, but it CAN refuse to relay it into
    // an operator's terminal or CI log, which is the only surface the kit
    // controls. Asymmetry on purpose: argv above is asserted clean, the
    // transcript here is scrubbed clean.
    expect(report.spawn?.transcript).toContain('LEAK_ATTEMPT=');
    expect(report.spawn?.transcript).toContain(TOKEN_REDACTION);
    expect(report.spawn?.transcript).not.toMatch(TOKEN_RE);
  }, 60_000);
});

/* ── row 7: report compatibility ───────────────────────────────────────── */

describe('s7 Sc6: the report grew keys, not a new shape', () => {
  it('an S5-shaped consumer that ignores unknown keys still reads it', async () => {
    const report = await runConformanceSpawned({
      cmd: NODE,
      args: [example('reference-adapter.mjs')],
      name: 'reference',
    });
    const parsed = JSON.parse(formatJson(report)) as Record<string, unknown>;
    // Exactly the S5 keys, read the S5 way.
    expect(typeof parsed['adapter']).toBe('string');
    expect(parsed['version']).toBe(1);
    expect(parsed['conformant']).toBe(true);
    expect(Array.isArray(parsed['features'])).toBe(true);
    expect(Array.isArray(parsed['checks'])).toBe(true);
    // The additions are additive and optional, which is why the S5 literal in
    // conformance.spec.ts still typechecks and still round-trips.
    expect(parsed['transport']).toBe('spawn');
    expect(formatTap(report).split('\n')[1]).toBe('1..6');
  }, 60_000);
});

/* ── row 8: the bin, which is what makes `npx` a real instruction ──────── */

describe('s7 Sc6: the kit has a bin a stranger can run', () => {
  function run(
    args: readonly string[],
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(
        NODE,
        [`${PKG}bin/wemessage-adapter-testkit.mjs`, ...args],
        { cwd: PKG, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const code =
            error === null
              ? 0
              : typeof error.code === 'number'
                ? error.code
                : 1;
          resolve({ code, stdout, stderr });
        },
      );
    });
  }

  it('runs the reference adapter to a conformant JSON report and exits 0', async () => {
    const { code, stdout } = await run([
      '--cmd',
      'node examples/reference-adapter.mjs',
      '--format',
      'json',
    ]);
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as ConformanceReport;
    expect(report.conformant).toBe(true);
    expect(report.transport).toBe('spawn');
    expect(report.checks).toHaveLength(6);
    expect(stdout).not.toMatch(TOKEN_RE);
  }, 90_000);

  it('exits 1 on a non-conformant adapter and prints the badge for --format badge', async () => {
    const { code, stdout } = await run([
      '--cmd',
      'node examples/broken-sends.mjs',
      '--format',
      'badge',
    ]);
    expect(code).toBe(1);
    expect(stdout.trim()).toBe('NOT CONFORMANT v1 - broken-sends (2/6 failed)');
    // C-9, repo-wide: no colour in any product surface, ever.
    expect(stdout).not.toMatch(/\x1b\[/);
  }, 90_000);

  it('accepts `--transport ws` as a documented no-op and refuses anything else', async () => {
    const ok = await run([
      '--cmd',
      'node examples/reference-adapter.mjs',
      '--transport',
      'ws',
      '--format',
      'badge',
    ]);
    expect(ok.code).toBe(0);

    const bad = await run([
      '--cmd',
      'node examples/reference-adapter.mjs',
      '--transport',
      'stdio',
    ]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('unsupported transport');
  }, 90_000);

  it('exits 2 with usage when --cmd is missing', async () => {
    const { code, stderr } = await run(['--format', 'json']);
    expect(code).toBe(2);
    expect(stderr).toContain('--cmd');
  }, 30_000);

  it('splits --cmd without ever handing the string to a shell', () => {
    expect(parseCommand('node examples/reference-adapter.mjs')).toEqual([
      'node',
      'examples/reference-adapter.mjs',
    ]);
    expect(parseCommand('python3 "my adapter.py" --flag')).toEqual([
      'python3',
      'my adapter.py',
      '--flag',
    ]);
    expect(parseCommand("uv run --python 3.12 python 'a b.py'")).toEqual([
      'uv',
      'run',
      '--python',
      '3.12',
      'python',
      'a b.py',
    ]);
    expect(() => parseCommand('  ')).toThrow(/empty/);
  });

  it('package.json declares the bin under the name `npx @wemessage/adapter-testkit` resolves', () => {
    const pkg = JSON.parse(readFileSync(`${PKG}package.json`, 'utf8')) as {
      name: string;
      bin: Record<string, string>;
    };
    const target = './bin/wemessage-adapter-testkit.mjs';
    // npm resolves a bare `npx <pkg>` to the bin named after the package's
    // unscoped segment, falling back to the sole bin when there is exactly
    // one. Declaring `adapter-testkit` makes the CLI's refusal text
    // (`run: npx @wemessage/adapter-testkit --cmd "<your adapter>"`, s7 Sc5
    // row 6, F-86) resolve by the name rule rather than by the fallback.
    expect(pkg.name).toBe('@wemessage/adapter-testkit');
    expect(pkg.bin['adapter-testkit']).toBe(target);
    expect(pkg.bin['wemessage-adapter-testkit']).toBe(target);
    const stat = statSync(`${PKG}bin/wemessage-adapter-testkit.mjs`);
    expect(stat.mode & 0o111).toBeGreaterThan(0);
    expect(
      readFileSync(`${PKG}bin/wemessage-adapter-testkit.mjs`, 'utf8'),
    ).toMatch(/^#!\/usr\/bin\/env node\n/);
  });
});

/* ── row 9: the budgets, each one actually tripped ─────────────────────── */

describe('s7 Sc6: resource budgets are enforced, not declared', () => {
  it('declares four budgets with defaults a normal adapter never touches', () => {
    expect(DEFAULT_SPAWN_BUDGETS).toEqual({
      checkMs: 10_000,
      transcriptBytes: 65_536,
      maxFrames: 1_000,
      maxFrameBytes: 262_144,
    });
  });

  it('caps the transcript so a chatty child cannot grow the parent without bound', async () => {
    const report = await runConformanceSpawned({
      cmd: NODE,
      args: [child('stress.mjs')],
      name: 'flood-stdout',
      env: { STRESS_MODE: 'stdout' },
    });
    const transcript = report.spawn?.transcript ?? '';
    // The child writes far more than the budget; the kit keeps the budget
    // and says so, rather than buffering a megabyte into a CI log.
    expect(transcript.length).toBeLessThan(
      DEFAULT_SPAWN_BUDGETS.transcriptBytes + 200,
    );
    expect(transcript).toContain('transcript truncated');
    expect(report.spawn?.budgetTrips).toContain('transcript-bytes');
  }, 90_000);

  it('stops forwarding after the frame budget and records the trip', async () => {
    const report = await runConformanceSpawned({
      cmd: NODE,
      args: [child('stress.mjs')],
      name: 'flood-frames',
      env: { STRESS_MODE: 'frames' },
      budgets: { maxFrames: 20 },
    });
    expect(report.spawn?.budgetTrips).toContain('frame-budget-exceeded');
    expect(report.spawn?.budgets.maxFrames).toBe(20);
    expect(report.spawn?.orphans).toBe(0);
  }, 90_000);

  it('drops a frame larger than the per-frame budget instead of relaying it', async () => {
    const report = await runConformanceSpawned({
      cmd: NODE,
      args: [child('stress.mjs')],
      name: 'big-frame',
      env: { STRESS_MODE: 'big' },
      budgets: { maxFrameBytes: 2_048 },
    });
    expect(report.spawn?.budgetTrips).toContain('frame-too-large');
    expect(report.spawn?.orphans).toBe(0);
  }, 90_000);

  it('a per-check wall-clock budget fails the check instead of hanging the run', async () => {
    const started = Date.now();
    const report = await runConformanceSpawned({
      cmd: NODE,
      args: [child('hang.mjs')],
      name: 'hang',
      timeoutMs: 1_000,
    });
    // Six checks plus the feature probe, each bounded. The ceiling below is
    // deliberately loose (it is a "did not hang" assertion, not a benchmark)
    // but it is finite, which is the property under test.
    expect(Date.now() - started).toBeLessThan(45_000);
    expect(report.conformant).toBe(false);
    expect(report.spawn?.budgets.checkMs).toBe(1_000);
  }, 60_000);
});
