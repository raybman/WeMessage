/**
 * v2 S6c. The daemon bundle the Swift app ships, built by
 * `tools/release/bin/bundle-daemon.mjs`.
 *
 * These rows lived in the previous desktop app's test directory (s9 Sc 5 and
 * v2 S2b) beside the flavour that app shipped. S6c deleted that app and that
 * flavour, and moved the rows that hold the surviving one here, into the root
 * project, so the bundler keeps every assertion it had about the bundle the
 * Swift app actually ships. Rows that only ever described the deleted flavour
 * went with it; the s9 Sc 5 row numbers are kept where a row survived, so the
 * history still reads.
 *
 * WHY FOUR BUILDS, AND LOCKS WRITTEN BY THE TEST. The guard's Node major comes
 * from tools/swift/node.lock.json, and CI runs a different Node from the one
 * the app ships. A bundle built against the real lock refuses the runner's
 * own Node, which is correct, and is also the only thing it can be made to do
 * here. So each build's lock isolates the one clause its row is about:
 *
 *   N  the runner's Node: the host variable is the only variable;
 *   M  the runner's major plus one: only the major clause can refuse;
 *   D  no --lock at all: the real lock, read for its pin and never executed;
 *   T  the runner's Node again, with a metafile, for the import-graph rows.
 *
 * `--node` is the runner's Node in every build. ABI.json is read from it, and
 * the bundle never needs a second Node to be built.
 *
 * NO TIMER CALLS. Readiness is observed off the child's stdout, never slept
 * on (`helpers/bundle-lane.ts`).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isBuiltin } from 'node:module';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bed,
  cleanupTemps,
  freePort,
  launch,
  tempDir,
  waitFor,
} from './helpers/bundle-lane.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const BUNDLER = join(REPO, 'tools', 'release', 'bin', 'bundle-daemon.mjs');

/** Generous; this only ever converts a hang into a named failure. */
const BOOT_BUDGET_MS = 20_000;

const REFUSAL_NODE =
  'this bundle runs under the WeMessage app host (wemessage --daemon)';

/**
 * WHETHER THIS HOST CAN EXECUTE THE ARTEFACT. The bundle ships ONE native
 * binary, `prebuilds/darwin-arm64.node` (F-135). On any other host
 * `better-sqlite3` finds no prebuild and the daemon dies inside its first
 * require, so the one row that boots a daemon to completion is gated on this.
 * Every row that READS the bundle, and every refusal, runs everywhere. The
 * gate is checked against the listing rather than trusted, in row 1.
 */
const RUNS_THE_BUNDLE =
  process.platform === 'darwin' && process.arch === 'arm64';

/** Every file under `dir`, relative, sorted. */
function listing(dir: string): string[] {
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
    );
  return walk(dir)
    .map((p) => relative(dir, p).replace(/\\/g, '/'))
    .sort();
}

function sha256(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

interface Metafile {
  inputs: Record<string, unknown>;
  outputs: Record<string, { imports?: { path: string; external?: boolean }[] }>;
}

const runner = process.versions.node;
const runnerMajor = Number(runner.split('.')[0]);
const built = { N: '', M: '', D: '', T: '' };
let meta: Metafile;
/** The workspace module's bytes, captured BEFORE the bundler runs (row 7). */
let workspacePrebuild = { path: '', hash: '' };

/** A lock carrying only what the bundler reads from it. */
function lockFor(version: string): string {
  const p = join(tempDir('wemessage-lock-'), 'node.lock.json');
  const major = Number(version.split('.')[0]);
  writeFileSync(p, `${JSON.stringify({ version, major }, null, 2)}\n`);
  return p;
}

function buildBundle(lock: string | null, extra: string[] = []): string {
  const dir = tempDir('wemessage-node-bundle-');
  execFileSync(
    process.execPath,
    [
      BUNDLER,
      '--runtime',
      'node',
      '--out',
      dir,
      '--node',
      process.execPath,
      ...(lock === null ? [] : ['--lock', lock]),
      ...extra,
    ],
    { cwd: REPO, stdio: 'pipe' },
  );
  return dir;
}

beforeAll(() => {
  const wsPrebuild = join(
    REPO,
    'node_modules/.pnpm/better-sqlite3@13.0.3/node_modules/better-sqlite3',
    'prebuilds/darwin-arm64.node',
  );
  workspacePrebuild = { path: wsPrebuild, hash: sha256(wsPrebuild) };
  const metaPath = join(tempDir('wemessage-meta-'), 'meta.json');
  built.N = buildBundle(lockFor(runner));
  built.M = buildBundle(lockFor(`${String(runnerMajor + 1)}.0.0`));
  built.D = buildBundle(null);
  built.T = buildBundle(lockFor(runner), ['--metafile', metaPath]);
  meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Metafile;
}, 240_000);

afterAll(() => {
  cleanupTemps();
});

/**
 * Run a bundled entry that is expected to refuse, and never leave it running
 * if it does not. A guard that has stopped refusing boots a daemon that would
 * outlive the row, so the wait ends on EITHER an exit or the listening line,
 * and a daemon caught listening is stopped before the row convicts it.
 */
async function runToRefusal(
  entry: string,
  env: NodeJS.ProcessEnv,
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  touched: string[];
}> {
  const { dir, chatDb } = bed();
  const port = await freePort();
  const d = launch(process.execPath, [entry], {
    WEMESSAGE_DIR: dir,
    WEMESSAGE_PORT: String(port),
    WEMESSAGE_CHATDB: chatDb,
    ...env,
  });
  let gone = false;
  void d.exited.then(() => {
    gone = true;
  });
  await waitFor(
    () => gone || d.stdout().includes('listening on 127.0.0.1'),
    'the bundle to refuse, or to listen',
    BOOT_BUDGET_MS,
  );
  if (!gone) await d.stop();
  const end = await d.exited;
  return {
    code: end.code,
    stdout: d.stdout(),
    stderr: d.stderr(),
    touched: readdirSync(dir),
  };
}

/* ── row 1 ────────────────────────────────────────────────────────────── */

describe('s9 Sc5 row 1: the bundle is an exact listing, not a directory that grew', () => {
  // teeth: TN-wrong-arch-prebuild (row 1), re-run in v2 S6c against this port: copying prebuilds/darwin-x64.node in place of darwin-arm64 in the bundler made the listing row show darwin-x64.node, the one-native row fail, and the gate row name the x64 file it carried. Three rows red, bundler restored.
  it('emits the files the app ships, the one prebuild, and nothing else', () => {
    expect(listing(built.N)).toEqual([
      'bin/wemessage',
      'bin/wemessage.mjs',
      'bin/wemessaged',
      'daemon/ABI.json',
      'daemon/main.mjs',
      'daemon/node_modules/better-sqlite3/lib/binding.js',
      'daemon/node_modules/better-sqlite3/lib/database.js',
      'daemon/node_modules/better-sqlite3/lib/index.js',
      'daemon/node_modules/better-sqlite3/lib/methods/aggregate.js',
      'daemon/node_modules/better-sqlite3/lib/methods/backup.js',
      'daemon/node_modules/better-sqlite3/lib/methods/explain.js',
      'daemon/node_modules/better-sqlite3/lib/methods/function.js',
      'daemon/node_modules/better-sqlite3/lib/methods/inspect.js',
      'daemon/node_modules/better-sqlite3/lib/methods/pragma.js',
      'daemon/node_modules/better-sqlite3/lib/methods/serialize.js',
      'daemon/node_modules/better-sqlite3/lib/methods/table.js',
      'daemon/node_modules/better-sqlite3/lib/methods/transaction.js',
      'daemon/node_modules/better-sqlite3/lib/methods/wrappers.js',
      'daemon/node_modules/better-sqlite3/lib/sqlite-error.js',
      'daemon/node_modules/better-sqlite3/lib/util.js',
      'daemon/node_modules/better-sqlite3/package.json',
      'daemon/node_modules/better-sqlite3/prebuilds/darwin-arm64.node',
      'daemon/wemessaged.mjs',
      'migrations/0001_init.sql',
      'migrations/0002_thread_state.sql',
    ]);
  });

  it('builds the same listing whichever lock it was given', () => {
    const want = listing(built.N);
    for (const [name, dir] of Object.entries(built)) {
      expect([name, listing(dir)]).toEqual([name, want]);
    }
  });

  /*
   * The exact listing above pins every migration BY NAME, deliberately: a new
   * file in `packages/store/migrations` should be a conscious edit to this
   * bundle, not a silent inheritance (v2 F3 made that edit for
   * 0002_thread_state.sql). This row is the load-bearing half: the
   * shipped SQL is byte-identical to the SQL the suite migrates against.
   */
  it('ships the store migrations byte-for-byte, not a stale copy', () => {
    const src = join(REPO, 'packages/store/migrations');
    const names = readdirSync(src)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) {
      expect(sha256(join(built.N, 'migrations', n))).toBe(sha256(join(src, n)));
    }
  });

  it('ships exactly one native binary, and it is the arm64 one (F-135)', () => {
    const natives = listing(built.N).filter((f) => f.endsWith('.node'));
    expect(natives).toEqual([
      'daemon/node_modules/better-sqlite3/prebuilds/darwin-arm64.node',
    ]);
  });

  /*
   * The teeth on `RUNS_THE_BUNDLE`. A platform gate is a way to lose coverage
   * quietly, so this row re-derives the answer from the ONE prebuild the
   * bundle actually contains.
   */
  it('gates the executing row on the one prebuild the bundle ships', () => {
    const natives = listing(built.N).filter((f) => f.endsWith('.node'));
    expect(natives).toHaveLength(1);
    const host = `${process.platform}-${process.arch}.node`;
    expect(
      RUNS_THE_BUNDLE,
      `this host is ${host}; the bundle carries ${natives[0] ?? 'nothing'}`,
    ).toBe(natives[0]?.endsWith(`/${host}`) === true);
  });
});

/* ── row 2 ────────────────────────────────────────────────────────────── */

describe('s9 Sc5 row 2: the workspace is inlined; the externals are a closed set', () => {
  it('leaves no @wemessage/ import to resolve at run time', () => {
    const src = readFileSync(join(built.N, 'daemon/main.mjs'), 'utf8');
    // Assembled so this assertion is not itself a match for the thing it bans.
    const scope = '@' + 'wemessage/';
    expect(src.includes(`require("${scope}`)).toBe(false);
    expect(src.includes(`from "${scope}`)).toBe(false);
  });

  /*
   * A CLOSED SET, filtered with `isBuiltin` rather than a `node:` prefix test:
   * esbuild reports a builtin by whatever specifier the source used. One, not
   * three: `ws`'s optional natives are compiled out by the bundler's `define`
   * (v2 S2c.1), so an external that reappears here means a require came back.
   */
  it('declares a closed set of externals, builtins aside', () => {
    const out = Object.entries(meta.outputs).find(([p]) =>
      p.endsWith('daemon/main.mjs'),
    );
    expect(out, 'the metafile describes main.mjs').toBeDefined();
    const externals = [
      ...new Set(
        (out?.[1].imports ?? [])
          .filter((i) => i.external === true)
          .map((i) => i.path),
      ),
    ]
      .filter((p) => !isBuiltin(p))
      .sort();
    expect(externals).toEqual(['better-sqlite3']);
  });

  /*
   * `better-sqlite3` is resolved at run time by walking `node_modules` upward
   * from the importing file, and F-121 pins it to `daemon/node_modules`. So an
   * entry that imports it is only correct at or below `daemon/`.
   */
  it('keeps every importer of the native module under daemon/', () => {
    const entries = listing(built.N).filter((f) => f.endsWith('.mjs'));
    expect(entries.length).toBeGreaterThan(0);
    for (const f of entries) {
      const imports = readFileSync(join(built.N, f), 'utf8').includes(
        'better-sqlite3',
      );
      expect(
        imports && !f.startsWith('daemon/'),
        `${f} cannot resolve it`,
      ).toBe(false);
    }
  });
});

/* ── v2 S2b rows 3 to 6: the guard, ABI.json and the shims ─────────────── */

describe('v2 S2b rows 3 to 6: built for the Swift host', () => {
  it.each<[string, string | undefined]>([
    ['unset', undefined],
    ['empty', ''],
    ['in the wrong case', 'SWIFT'],
  ])('row 3: refuses when WEMESSAGE_HOST is %s', async (_, host) => {
    const r = await runToRefusal(join(built.N, 'daemon/main.mjs'), {
      WEMESSAGE_HOST: host,
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(REFUSAL_NODE);
    expect(r.stdout).toBe('');
    // It refused before doing any work: no lock, no token, no store.
    expect(r.touched).toEqual([]);
  });

  it.skipIf(!RUNS_THE_BUNDLE)(
    'row 3: runs as the Swift host, and /v1/doctor says kind node, host swift',
    async () => {
      const { dir, chatDb } = bed();
      const port = await freePort();
      const d = launch(process.execPath, [join(built.N, 'daemon/main.mjs')], {
        WEMESSAGE_HOST: 'swift',
        WEMESSAGE_DIR: dir,
        WEMESSAGE_PORT: String(port),
        WEMESSAGE_CHATDB: chatDb,
      });
      try {
        await waitFor(
          () => d.stdout().includes('listening on 127.0.0.1'),
          'the bundled daemon to listen',
          BOOT_BUDGET_MS,
        );
        const token = readFileSync(join(dir, 'daemon.token'), 'utf8').trim();
        const res = await fetch(`http://127.0.0.1:${String(port)}/v1/doctor`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.status, d.stderr()).toBe(200);
        const body = (await res.json()) as { runtime?: unknown };
        expect(body.runtime).toStrictEqual({
          kind: 'node',
          host: 'swift',
          node: runner,
          abi: Number(process.versions.modules),
        });
      } finally {
        await d.stop();
        await d.exited;
      }
    },
    BOOT_BUDGET_MS * 2,
  );

  it('row 4: refuses a Node whose major is not the locked one, Swift host or not', async () => {
    const r = await runToRefusal(join(built.M, 'daemon/main.mjs'), {
      WEMESSAGE_HOST: 'swift',
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(REFUSAL_NODE);
    expect(r.stdout).toBe('');
    expect(r.touched).toEqual([]);
  });

  it('row 4: with no --lock, the pinned major is the one in tools/swift/node.lock.json', () => {
    const lock = JSON.parse(
      readFileSync(join(REPO, 'tools/swift/node.lock.json'), 'utf8'),
    ) as { version: string; major: number };
    expect(Number.isInteger(lock.major)).toBe(true);
    expect(lock.version.startsWith(`${String(lock.major)}.`)).toBe(true);
    const pinned = /process\.versions\.node\.split\("\."\)\[0\]\) !== (\d+)\)/;
    for (const entry of ['daemon/main.mjs', 'daemon/wemessaged.mjs']) {
      const src = readFileSync(join(built.D, entry), 'utf8');
      expect(pinned.exec(src)?.[1], entry).toBe(String(lock.major));
    }
  });

  it('row 4: the guard heads both daemon entries and the CLI carries none', () => {
    for (const entry of ['daemon/main.mjs', 'daemon/wemessaged.mjs']) {
      const src = readFileSync(join(built.N, entry), 'utf8');
      expect(src.includes(REFUSAL_NODE), entry).toBe(true);
    }
    const cli = readFileSync(join(built.N, 'bin/wemessage.mjs'), 'utf8');
    expect(cli.includes(REFUSAL_NODE)).toBe(false);
  });

  it("v2 S2c.1: neither daemon entry requires ws's optional natives at run time", () => {
    // No leading \b: esbuild emits `__require(`, and `_` is a word character.
    const RUNTIME_REQUIRE =
      /require\(\s*["'](?:bufferutil|utf-8-validate)["']\s*\)/;
    // Non-vacuity: the reader convicts the exact shape esbuild emits.
    expect(RUNTIME_REQUIRE.test('m = __require("bufferutil");')).toBe(true);
    expect(RUNTIME_REQUIRE.test("require('utf-8-validate')")).toBe(true);
    expect(RUNTIME_REQUIRE.test('"bufferutil" is prose')).toBe(false);
    for (const entry of ['daemon/main.mjs', 'daemon/wemessaged.mjs']) {
      const src = readFileSync(join(built.N, entry), 'utf8');
      expect(src.includes(REFUSAL_NODE), entry).toBe(true);
      expect(RUNTIME_REQUIRE.exec(src)?.[0], entry).toBeUndefined();
    }
  });

  it('row 5: ABI.json declares the Node it was read from, byte for byte', () => {
    expect(readFileSync(join(built.N, 'daemon/ABI.json'), 'utf8')).toBe(
      `${JSON.stringify(
        {
          runtime: 'node',
          version: runner,
          abi: Number(process.versions.modules),
        },
        null,
        2,
      )}\n`,
    );
  });

  it("row 6: the shims run the app's own Node as the Swift host, and name no machine", () => {
    for (const [shim, entry] of [
      ['bin/wemessage', '"$here/wemessage.mjs"'],
      ['bin/wemessaged', '"$here/../daemon/wemessaged.mjs"'],
    ] as const) {
      const src = readFileSync(join(built.N, shim), 'utf8');
      expect(src, shim).toContain(
        `WEMESSAGE_HOST=swift exec "$here/../daemon/node" ${entry} "$@"\n`,
      );
      expect(src, shim).toContain('readlink -f');
      for (const banned of [
        'MacOS/WeMessage',
        '/Users',
        '/opt',
        '/usr/local',
        homedir(),
      ]) {
        expect(src.includes(banned), `${shim} names ${banned}`).toBe(false);
      }
      expect(
        (statSync(join(built.N, shim)).mode & 0o777).toString(8),
        shim,
      ).toBe('755');
    }
  });
});

/* ── row 7 ────────────────────────────────────────────────────────────── */

describe('s9 Sc5 row 7: bundling does not reach back into the workspace', () => {
  it('leaves the module `pnpm test` itself runs on byte-identical', () => {
    expect(sha256(workspacePrebuild.path)).toBe(workspacePrebuild.hash);
  });

  it('copies the prebuild rather than linking to it', () => {
    const bundled = join(
      built.N,
      'daemon/node_modules/better-sqlite3/prebuilds/darwin-arm64.node',
    );
    expect(statSync(bundled).isSymbolicLink()).toBe(false);
    // N-API: same bytes, two independent files. That is the point of F-139.
    expect(sha256(bundled)).toBe(workspacePrebuild.hash);
  });
});

/* ── row 9 ────────────────────────────────────────────────────────────── */

describe('s9 Sc5 row 9: a size budget, so an accidental import fails loudly', () => {
  it('keeps main.mjs under 3 MB and the native module under 4 MB', () => {
    const mainBytes = statSync(join(built.N, 'daemon/main.mjs')).size;
    const nodeBytes = statSync(
      join(
        built.N,
        'daemon/node_modules/better-sqlite3/prebuilds/darwin-arm64.node',
      ),
    ).size;
    expect(mainBytes, `main.mjs is ${String(mainBytes)} bytes`).toBeLessThan(
      3 * 1024 * 1024,
    );
    expect(
      nodeBytes,
      `the prebuild is ${String(nodeBytes)} bytes`,
    ).toBeLessThan(4 * 1024 * 1024);
  });
});

/* ── refusals ─────────────────────────────────────────────────────────── */

describe('v2 S2b: the bundler refuses what it cannot honour, before writing anything', () => {
  it('names the flag it objects to and exits 1', () => {
    const foreign = tempDir('wemessage-foreign-');
    writeFileSync(join(foreign, 'keep.txt'), 'not a bundle\n');
    const cases: ReadonlyArray<readonly [string, readonly string[], string]> = [
      ['an unknown runtime', ['--runtime', 'deno'], 'deno'],
      ['no --out', ['--node', process.execPath], '--out'],
      ['no --node', ['--out', tempDir('wemessage-empty-')], '--node'],
      [
        'x64, which nothing has ever smoked (F-135)',
        ['--arch', 'x64', '--out', tempDir('wemessage-empty-')],
        'arm64',
      ],
      [
        'the repo itself',
        ['--out', REPO, '--node', process.execPath],
        'refusing to build into',
      ],
      [
        'the home directory',
        ['--out', homedir(), '--node', process.execPath],
        'refusing to build into',
      ],
      [
        'a directory that is not a bundle',
        ['--out', foreign, '--node', process.execPath],
        'not empty',
      ],
    ];
    for (const [what, args, says] of cases) {
      let status: number | null = 0;
      let stderr = '';
      try {
        execFileSync(process.execPath, [BUNDLER, ...args], {
          cwd: REPO,
          stdio: 'pipe',
        });
      } catch (e) {
        const err = e as { status?: number | null; stderr?: Buffer };
        status = err.status ?? null;
        stderr = String(err.stderr ?? '');
      }
      expect([what, status], stderr).toEqual([what, 1]);
      expect(stderr, what).toContain(says);
    }
    expect(readdirSync(foreign)).toEqual(['keep.txt']);
    expect(existsSync(join(REPO, 'daemon'))).toBe(false);
  }, 60_000);
});
