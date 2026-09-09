/**
 * s9 Sc 5 — the daemon and CLI as bundles under Electron-as-Node.
 *
 * The shipped app has ONE Mach-O (F-121): `WeMessage.app` is both the GUI and,
 * with `ELECTRON_RUN_AS_NODE=1`, the daemon's runtime. That buys one signature,
 * one Team ID, one notarization surface and one TCC identity. What it costs is
 * this file: the daemon has to survive being bundled away from its workspace,
 * and it has to refuse to run under anything that is not Electron.
 *
 * WHAT F-139 CHANGED HERE, AND WHY THE ROWS BELOW LOOK LESS DRAMATIC THAN THE
 * SPEC'S. Sc 5 was ratified against `better-sqlite3` 12.x, a node-gyp module
 * with one binary per ABI, so the bundle step had to fetch the Electron-shaped
 * one and the tooth was to fetch the Node-shaped one instead. On 13.0.3 the
 * module is N-API via prebuildify: ONE `prebuilds/darwin-arm64.node` loads
 * under Electron 44 (abi 149) and under plain Node 25 (abi 141) alike. So:
 *
 *  - the exact listing names `prebuilds/darwin-arm64.node`, not
 *    `build/Release/better_sqlite3.node`, which 13.0.3 does not ship at all;
 *  - `TN-node-abi-in-the-bundle` is retired as UNRUNNABLE (it says to copy a
 *    file that does not exist) and replaced by `TN-wrong-arch-prebuild`;
 *  - row 4 can no longer lean on an ABI mismatch to fail under plain Node,
 *    because there isn't one. The banner check is now the ENTIRE mechanism,
 *    which is why row 4 asserts the message and the exit code rather than
 *    hoping for `ERR_DLOPEN_FAILED`.
 *
 * NO TIMER CALLS. `test/arch.spec.ts` bans them under this whole tree as a
 * text scan, so readiness is observed off the child's stdout, never slept on.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { createRequire, isBuiltin } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const need = createRequire(import.meta.url);
/** Electron's runtime export is the path to its binary, not its API surface. */
const ELECTRON_BIN = need('electron') as string;

const DESKTOP = fileURLToPath(new URL('..', import.meta.url));
const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const BUNDLER = join(DESKTOP, 'scripts', 'bundle-daemon.mjs');
const OUT = join(DESKTOP, 'dist-bundle');

/** Generous; this only ever converts a hang into a named failure. */
const BOOT_BUDGET_MS = 20_000;

const temps: string[] = [];
function tempDir(prefix = 'wemessage-bundle-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

async function freePort(): Promise<number> {
  return await new Promise((ok, bad) => {
    const srv = createServer();
    srv.on('error', bad);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        bad(new Error('no port'));
        return;
      }
      const { port } = addr;
      srv.close(() => {
        ok(port);
      });
    });
  });
}

/**
 * Poll a predicate on the macrotask queue. `setTimeout` is banned under this
 * tree, and `setImmediate` is not a timer: it yields to I/O, which is exactly
 * what a test waiting on a child's stdout needs.
 */
async function waitFor(
  cond: () => boolean,
  what: string,
  budgetMs: number,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((ok) => {
      setImmediate(ok);
    });
  }
}

interface Launched {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function launch(cmd: string, args: string[], env: NodeJS.ProcessEnv): Launched {
  const child = spawn(cmd, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout?.on('data', (b: Buffer) => (out += b.toString()));
  child.stderr?.on('data', (b: Buffer) => (err += b.toString()));
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((ok) => {
    child.on('close', (code, signal) => {
      ok({ code, signal });
    });
  });
  return { child, stdout: () => out, stderr: () => err, exited };
}

/** A chat.db the daemon can tail without touching the operator's real one. */
function bed(): { dir: string; chatDb: string } {
  const dir = tempDir();
  const dbDir = tempDir('wemessage-chatdb-');
  const chatDb = join(dbDir, 'fixture.db');
  const fixtures = need('../../../fixtures/dist/index.js') as {
    createChatDb: (p: string) => { close: () => void };
  };
  fixtures.createChatDb(chatDb).close();
  return { dir, chatDb };
}

/** Every file under `dir`, repo-relative, sorted. */
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

let metaPath = '';
let meta: Metafile;
/** The workspace module's bytes, captured BEFORE the bundler runs (row 7). */
let workspacePrebuild = { path: '', hash: '' };

beforeAll(() => {
  const wsPrebuild = join(
    REPO,
    'node_modules/.pnpm/better-sqlite3@13.0.3/node_modules/better-sqlite3',
    'prebuilds/darwin-arm64.node',
  );
  workspacePrebuild = { path: wsPrebuild, hash: sha256(wsPrebuild) };

  metaPath = join(tempDir('wemessage-meta-'), 'meta.json');
  rmSync(OUT, { recursive: true, force: true });
  execFileSync(process.execPath, [BUNDLER, '--metafile', metaPath], {
    cwd: DESKTOP,
    stdio: 'pipe',
  });
  meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Metafile;
}, 180_000);

afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/* ── row 1 ────────────────────────────────────────────────────────────── */

describe('s9 Sc5 row 1: the bundle is an exact listing, not a directory that grew', () => {
  it('emits the files the app ships, the one prebuild, and nothing else', () => {
    expect(listing(OUT)).toEqual([
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
    ]);
  });

  it('is reachable as a package script, so the pack step has one command', () => {
    const pkg = JSON.parse(
      readFileSync(join(DESKTOP, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts['bundle:daemon']).toBe('node scripts/bundle-daemon.mjs');
  });

  /*
   * The exact listing above pins ONE migration BY NAME, deliberately: a second
   * file in `packages/store/migrations` should be a conscious edit to this
   * bundle, not a silent inheritance. This row is the other half of that pin,
   * and the load-bearing half. It asserts the shipped SQL is byte-identical to
   * the SQL the suite migrates against, so the bundle can never boot a schema
   * no test has ever seen.
   */
  it('ships the store migrations byte-for-byte, not a stale copy', () => {
    const src = join(REPO, 'packages/store/migrations');
    const names = readdirSync(src)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) {
      expect(sha256(join(OUT, 'migrations', n))).toBe(sha256(join(src, n)));
    }
  });

  it('ships exactly one native binary, and it is the arm64 one (F-135)', () => {
    const natives = listing(OUT).filter((f) => f.endsWith('.node'));
    expect(natives).toEqual([
      'daemon/node_modules/better-sqlite3/prebuilds/darwin-arm64.node',
    ]);
  });

  it('refuses to build for x64, because nothing has ever smoked one (F-135)', () => {
    let refused = '';
    try {
      execFileSync(process.execPath, [BUNDLER, '--arch', 'x64'], {
        cwd: DESKTOP,
        stdio: 'pipe',
      });
    } catch (e) {
      refused = String((e as { stderr?: Buffer }).stderr ?? '');
    }
    expect(refused).toContain('arm64');
  });
});

/* ── row 2 ────────────────────────────────────────────────────────────── */

describe('s9 Sc5 row 2: the workspace is inlined; the externals are a closed set', () => {
  it('leaves no @wemessage/ import to resolve at run time', () => {
    const src = readFileSync(join(OUT, 'daemon/main.mjs'), 'utf8');
    // Assembled so this assertion is not itself a match for the thing it bans.
    const scope = '@' + 'wemessage/';
    expect(src.includes(`require("${scope}`)).toBe(false);
    expect(src.includes(`from "${scope}`)).toBe(false);
  });

  /*
   * The externals are a CLOSED SET, and the filter is `isBuiltin` rather than
   * a `node:` prefix test on purpose. esbuild reports a builtin by whatever
   * specifier the source used, so `node:events` and a bare `events` both
   * appear; a prefix test would quietly let a bare-named package through if
   * one ever shared a name with a builtin.
   *
   * Three, not one. `bufferutil` and `utf-8-validate` are `ws`'s optional
   * native accelerators, required inside a try/catch and absent from this
   * workspace, so `ws` falls back to JavaScript. They are asserted here for
   * the same reason they are named in the bundler: an external nobody
   * declared is an external nobody reviewed.
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
    expect(externals).toEqual([
      'better-sqlite3',
      'bufferutil',
      'utf-8-validate',
    ]);
  });

  /*
   * THE EXTERNAL HAS TO BE REACHABLE FROM WHOEVER IMPORTS IT.
   *
   * `better-sqlite3` stays external, which means Node resolves it at run time
   * by walking `node_modules` upward from the importing file, and F-121 pins
   * it to `daemon/node_modules`. So an entry that imports it is only correct
   * if it sits at or below `daemon/`. `bin/wemessaged.mjs` did not, and it
   * died at module load with ERR_MODULE_NOT_FOUND before it could parse a
   * flag, which no other row here would have noticed: rows 3 and 4 exercise
   * `main.mjs`, and row 5 exercises the CLI, which needs no database.
   *
   * This is deliberately a directory rule rather than a filename rule, so it
   * keeps holding when Sc 6 packs the same tree into `Contents/Resources/`.
   */
  it('keeps every importer of the native module under daemon/', () => {
    const entries = listing(OUT).filter((f) => f.endsWith('.mjs'));
    expect(entries.length).toBeGreaterThan(0);
    for (const f of entries) {
      const imports = readFileSync(join(OUT, f), 'utf8').includes(
        'better-sqlite3',
      );
      expect(
        imports && !f.startsWith('daemon/'),
        `${f} cannot resolve it`,
      ).toBe(false);
    }
  });
});

/* ── row 3 ────────────────────────────────────────────────────────────── */

describe('s9 Sc5 row 3: it runs under Electron-as-Node and says which runtime it is', () => {
  it('answers /v1/doctor with the electron runtime it was built for', async () => {
    const { dir, chatDb } = bed();
    const port = await freePort();
    const d = launch(ELECTRON_BIN, [join(OUT, 'daemon/main.mjs')], {
      ELECTRON_RUN_AS_NODE: '1',
      WEMESSAGE_DIR: dir,
      WEMESSAGE_PORT: String(port),
      WEMESSAGE_CHATDB: chatDb,
    });
    try {
      await waitFor(
        () => d.stdout().includes('listening on 127.0.0.1'),
        `the bundled daemon to listen (stderr: ${d.stderr()})`,
        BOOT_BUDGET_MS,
      );
      const token = readFileSync(join(dir, 'daemon.token'), 'utf8').trim();
      const res = await fetch(`http://127.0.0.1:${String(port)}/v1/doctor`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        runtime?: { electron?: string; node?: string; abi?: number };
      };
      expect(body.runtime, 'the doctor report carries a runtime').toBeDefined();
      expect(body.runtime?.electron).toMatch(/^\d+\.\d+\.\d+/);
      expect(body.runtime?.node).toMatch(/^\d+\.\d+\.\d+/);
      expect(typeof body.runtime?.abi).toBe('number');
    } finally {
      d.child.kill('SIGTERM');
      await d.exited;
    }
  });
});

/* ── row 4 ────────────────────────────────────────────────────────────── */

describe('s9 Sc5 row 4: under anything that is not Electron it refuses, deterministically', () => {
  it('exits 1 naming the runtime it needs, and never opens a database', async () => {
    const { dir, chatDb } = bed();
    const port = await freePort();
    const d = launch(process.execPath, [join(OUT, 'daemon/main.mjs')], {
      WEMESSAGE_DIR: dir,
      WEMESSAGE_PORT: String(port),
      WEMESSAGE_CHATDB: chatDb,
      ELECTRON_RUN_AS_NODE: '',
    });
    const end = await d.exited;
    expect(end.code).toBe(1);
    expect(d.stderr()).toContain(
      'this bundle runs under Electron (ELECTRON_RUN_AS_NODE=1)',
    );
    expect(d.stdout()).toBe('');
    // It refused before doing any work: no lock, no token, no store.
    expect(readdirSync(dir)).toEqual([]);
  });

  it('declares the runtime it was built for, so the refusal is checkable', () => {
    const abi = JSON.parse(
      readFileSync(join(OUT, 'daemon/ABI.json'), 'utf8'),
    ) as { runtime: string; version: string; abi: number };
    expect(abi.runtime).toBe('electron');
    expect(abi.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(abi.abi).toBeTypeOf('number');
    // The declaration must describe the Electron we actually ship against.
    const real = execFileSync(
      ELECTRON_BIN,
      ['-e', 'process.stdout.write(process.versions.modules)'],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' },
    );
    expect(String(abi.abi)).toBe(real.trim());
  });
});

/* ── row 6 ────────────────────────────────────────────────────────────── */

/**
 * The `<array>` under `ProgramArguments`, in order.
 *
 * Thirty lines of regex rather than a plist dependency, for the same reason
 * `packages/daemon/src/launchd/plist.ts` has its own reader: the subset this
 * project emits is small, and a parser in the path of an assertion about
 * launchd should not be a package somebody has to audit.
 */
function programArguments(plist: string): string[] {
  const block =
    /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist);
  if (block === null) throw new Error('the plist has no ProgramArguments');
  const [, body = ''] = block;
  return [...body.matchAll(/<string>([^<]*)<\/string>/g)].map(
    ([, value]) => value ?? '',
  );
}

describe('s9 Sc5 row 6: `service install` derives the plist from where it sits', () => {
  /*
   * WHY THIS BUILDS A FAKE .app INSTEAD OF INSTALLING FROM `dist-bundle/`.
   *
   * `resolveProgramArguments` recognises the packaged layout by the literal
   * `/Contents/Resources/` in the daemon entry's own path, and `plist.ts`
   * refuses any argv that is neither the packaged shape nor the dev shape.
   * A raw `dist-bundle/` is a third layout, and the right response to that is
   * the refusal we get, not a third entry on the allowlist.
   *
   * So the row asserts the claim that actually matters for Sc 6: DROP THIS
   * BUNDLE INTO `Contents/Resources/` AND THE PLIST IS CORRECT WITH NOBODY
   * CONFIGURING ANYTHING. The app root here is a temp directory that did not
   * exist when the bundle was built, which is what makes "derived" mean
   * something. Electron is invoked directly rather than through `bin/`s shim
   * because this fake app has no `Contents/MacOS/WeMessage` to exec; the
   * shim's own resolution is row 5's row.
   */
  let args: string[] = [];
  let appRoot = '';
  let plist = '';

  beforeAll(() => {
    appRoot = join(tempDir('wemessage-app-'), 'WeMessage.app');
    mkdirSync(join(appRoot, 'Contents', 'MacOS'), { recursive: true });
    cpSync(OUT, join(appRoot, 'Contents', 'Resources'), { recursive: true });

    // F-120: the test label prefix, `--no-load` so launchd is never asked to
    // do anything, and both directories inside the temp root the CLI's own
    // G4 guard insists on.
    const dir = tempDir('wemessage-svc-');
    const agents = tempDir('wemessage-agents-');
    execFileSync(
      ELECTRON_BIN,
      [
        join(appRoot, 'Contents/Resources/daemon/wemessaged.mjs'),
        'service',
        'install',
        '--no-load',
        '--label-prefix',
        'sh.wemessage.test.',
        '--dir',
        dir,
        '--launch-agents-dir',
        agents,
      ],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' },
    );
    const written = readdirSync(agents).filter((f) => f.endsWith('.plist'));
    expect(written).toHaveLength(1);
    plist = readFileSync(join(agents, written[0] ?? ''), 'utf8');
    args = programArguments(plist);
  }, 120_000);

  it('names the app executable and the bundled main.mjs, by suffix', () => {
    expect(args).toHaveLength(2);
    const [exe = '', main = ''] = args;
    expect(exe.endsWith('/WeMessage.app/Contents/MacOS/WeMessage')).toBe(true);
    expect(
      main.endsWith('/WeMessage.app/Contents/Resources/daemon/main.mjs'),
    ).toBe(true);
  });

  it('derives both entries from ONE root, which is the temp app, not a constant', () => {
    const [exe = '', main = ''] = args;
    const root = exe.slice(0, exe.indexOf('/Contents/'));
    expect(root).not.toBe('');
    expect(main.startsWith(`${root}/Contents/`)).toBe(true);
    // The bundle was built inside the repo and installed from outside it. If
    // any part of this were baked in at build time it would say so here.
    expect(exe.includes(REPO)).toBe(false);
    expect(main.includes(REPO)).toBe(false);
    expect(root.endsWith('WeMessage.app')).toBe(true);
  });

  it('tells launchd to re-enter the app as Node, which is the whole of F-121', () => {
    expect(plist).toContain('<key>ELECTRON_RUN_AS_NODE</key>');
    expect(plist).toContain('<key>KeepAlive</key>');
  });
});

/* ── row 5 ────────────────────────────────────────────────────────────── */

describe('s9 Sc5 row 5: the CLI bundle, and a shim with no machine in it', () => {
  it('prints the S7 help under Electron-as-Node', () => {
    const help = execFileSync(
      ELECTRON_BIN,
      [join(OUT, 'bin/wemessage.mjs'), '--help'],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' },
    );
    expect(help).toContain('wemessage');
    expect(help).toContain('drafts');
  });

  it('carries no absolute path, so it works from any checkout or any /Applications', () => {
    for (const shim of ['bin/wemessage', 'bin/wemessaged']) {
      const src = readFileSync(join(OUT, shim), 'utf8');
      expect(src, shim).toContain('ELECTRON_RUN_AS_NODE=1');
      for (const abs of ['/Users', '/opt', '/usr/local', homedir()]) {
        expect(src.includes(abs), `${shim} names ${abs}`).toBe(false);
      }
    }
  });

  it('is executable, because a shim nobody can run is a file', () => {
    for (const shim of ['bin/wemessage', 'bin/wemessaged']) {
      expect((statSync(join(OUT, shim)).mode & 0o777).toString(8), shim).toBe(
        '755',
      );
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
      OUT,
      'daemon/node_modules/better-sqlite3/prebuilds/darwin-arm64.node',
    );
    expect(statSync(bundled).isSymbolicLink()).toBe(false);
    // N-API: same bytes, two independent files. That is the point of F-139.
    expect(sha256(bundled)).toBe(workspacePrebuild.hash);
  });
});

/* ── row 8 ────────────────────────────────────────────────────────────── */

describe('s9 Sc5 row 8: the daemon bundle is not an Electron app', () => {
  it('imports no electron module at all', () => {
    const inputs = Object.keys(meta.inputs);
    expect(inputs.filter((i) => /(^|\/)electron(\/|$)/.test(i))).toEqual([]);
    const src = readFileSync(join(OUT, 'daemon/main.mjs'), 'utf8');
    expect(src.includes('from "electron"')).toBe(false);
    expect(src.includes('require("electron")')).toBe(false);
  });

  it('creates no Application Support directory of its own', async () => {
    const support = join(homedir(), 'Library/Application Support');
    const before = existsSync(support) ? readdirSync(support) : [];
    const { dir, chatDb } = bed();
    const port = await freePort();
    const d = launch(ELECTRON_BIN, [join(OUT, 'daemon/main.mjs')], {
      ELECTRON_RUN_AS_NODE: '1',
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
    } finally {
      d.child.kill('SIGTERM');
      await d.exited;
    }
    const after = existsSync(support) ? readdirSync(support) : [];
    expect(after.filter((n) => !before.includes(n))).toEqual([]);
  });
});

/* ── row 9 ────────────────────────────────────────────────────────────── */

describe('s9 Sc5 row 9: a size budget, so an accidental import fails loudly', () => {
  it('keeps main.mjs under 3 MB and the native module under 4 MB', () => {
    const mainBytes = statSync(join(OUT, 'daemon/main.mjs')).size;
    const nodeBytes = statSync(
      join(
        OUT,
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
