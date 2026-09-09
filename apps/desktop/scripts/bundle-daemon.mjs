/**
 * s9 Sc 5 — build the daemon and CLI as bundles the shipped app can run.
 *
 * The app has one Mach-O (F-121). `WeMessage.app/Contents/MacOS/WeMessage` is
 * the GUI, and with `ELECTRON_RUN_AS_NODE=1` it is also the daemon's Node. So
 * the daemon cannot ship as a workspace: it has to arrive as one ESM file plus
 * the one native module esbuild cannot inline.
 *
 * WHY THE ENTRIES ARE `dist/`, NOT `src/`. Bundling the TypeScript directly
 * would mean teaching esbuild to resolve NodeNext's `./daemon.js` specifiers
 * back to `./daemon.ts`. `tsc -b` already emits exactly the module graph the
 * tests run against, so the bundle is built from the same bytes `pnpm test`
 * exercised rather than from a second, subtly different compile.
 *
 * WHY `better-sqlite3` IS EXTERNAL AND COPIED. It is a native module; esbuild
 * cannot inline a `.node`. Under F-139 it is N-API via prebuildify, so exactly
 * one `prebuilds/darwin-arm64.node` serves both Electron 44 (abi 149) and
 * plain Node (abi 141). There is no `prebuild-install --runtime electron` step
 * any more, and no per-ABI fetch to get wrong.
 *
 * WHY THE BANNER IS THE WHOLE REFUSAL. `better-sqlite3` being N-API means a
 * plain-Node run no longer dies of `ERR_DLOPEN_FAILED`; it would happily boot
 * a daemon whose TCC identity is the terminal rather than the app. The banner
 * is prepended ahead of every bundled module body, so the check runs before
 * any daemon code, and the refusal is deterministic instead of incidental.
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const need = createRequire(import.meta.url);
const DESKTOP = fileURLToPath(new URL('..', import.meta.url));
const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const OUT = join(DESKTOP, 'dist-bundle');

/**
 * The one arch that has ever been smoked (F-135). An x64 artefact nobody has
 * run is a bug report generator, so this refuses rather than best-efforts.
 */
const ARCH = 'arm64';

/** `lib/` minus the per-platform entry shims, which `main` never requires. */
const SQLITE_LIB = [
  'index.js',
  'binding.js',
  'database.js',
  'sqlite-error.js',
  'util.js',
  'methods/aggregate.js',
  'methods/backup.js',
  'methods/explain.js',
  'methods/function.js',
  'methods/inspect.js',
  'methods/pragma.js',
  'methods/serialize.js',
  'methods/table.js',
  'methods/transaction.js',
  'methods/wrappers.js',
];

const REFUSAL = 'this bundle runs under Electron (ELECTRON_RUN_AS_NODE=1)';

/*
 * THE CLOSED SET OF THINGS NOT INLINED, AND WHY IT IS THREE AND NOT ONE.
 *
 * `better-sqlite3` is external because it is native; esbuild cannot inline a
 * `.node`, and F-121 pins where the binary lives.
 *
 * `bufferutil` and `utf-8-validate` are `ws`'s optional native accelerators.
 * `ws` requires them inside a try/catch and falls back to its JavaScript
 * implementations when they are absent, which they are: neither is installed
 * in this workspace. They are NAMED HERE rather than left to esbuild because
 * esbuild's handling of an unresolvable require-in-a-try-catch is a warning
 * plus an implicit external, and this bundle used to run with
 * `logLevel: 'silent'`, which meant the build was making a decision about the
 * shipped artefact and telling nobody. Naming them turns an unread warning
 * into a line somebody can disagree with, and lets row 2 assert the external
 * set is closed rather than merely small.
 */
const EXTERNALS = ['better-sqlite3', 'bufferutil', 'utf-8-validate'];

/*
 * ESM OUTPUT NEEDS A REAL `require`, AND THIS IS NOT OPTIONAL.
 *
 * Fastify and its dependency avvio are CommonJS. Bundling them into `format:
 * esm` leaves esbuild's `__require` shim in the output, and that shim throws
 * `Dynamic require of "node:events" is not supported` unless a `require`
 * binding exists in scope: it is written as `typeof require !== "undefined" ?
 * require : <throw>`. Defining one here is what makes that ternary take its
 * first branch.
 *
 * Rooting it at `import.meta.url` is also what makes the sibling
 * `daemon/node_modules/better-sqlite3` resolvable, which is why the native
 * module is copied to exactly that path and not somewhere tidier.
 */
const REQUIRE_SHIM =
  'import { createRequire as __wemessageCreateRequire } from "node:module";';
const REQUIRE_BIND =
  'const require = __wemessageCreateRequire(import.meta.url);';

/*
 * Prepended ahead of every bundled module body. Only true externals hoist
 * above it, and the only external is `better-sqlite3`, whose import is a
 * dlopen and nothing else: no file is created and no database is opened
 * before this has had its say. Verified: under plain Node the bundle exits 1
 * leaving its WEMESSAGE_DIR completely empty.
 */
const GUARD = `if (!process.versions.electron) {
  process.stderr.write(${JSON.stringify(REFUSAL)} + "\\n");
  process.exit(1);
}`;

/** The guard runs first, so a refusal never reaches the require shim. */
const bannerFor = (guard) =>
  [REQUIRE_SHIM, guard ? GUARD : '', REQUIRE_BIND].filter(Boolean).join('\n');

/** A shim that names no machine: every path is relative to the shim itself. */
function shim(entry) {
  return `#!/bin/sh
# s9 Sc 5. Two layouts, one script, and NO ABSOLUTE PATHS: a tracked file in a
# public repo may not carry a developer's home directory (arch row 13), and a
# shim baked to one checkout would not survive being copied into /Applications.
#
#   shipped: WeMessage.app/Contents/Resources/bin/ -> ../../MacOS/WeMessage
#   dev:     apps/desktop/dist-bundle/bin/         -> ../../node_modules/electron
#
# "readlink -f" FIRST, and the reason is the Homebrew cask: its two binary
# stanzas do not COPY these files, they SYMLINK them into a directory on
# PATH. Invoked through such a link, "$0" is the link, so a plain dirname
# puts "here" in the link's directory and both hops above then point at
# nothing. The app is not found, the dev fallback is not found either, and
# the shim dies "cannot execute: No such file or directory" with status
# 126, which would be the first thing this program ever said to somebody
# who had just run brew install. Following the link first makes "here" the
# directory the shim actually lives in, which is the only directory those
# hops were ever relative to. "pwd -P" is the same problem one level up,
# for a parent directory that is itself a link.
here=$(cd -- "$(dirname -- "$(readlink -f "$0")")" && pwd -P)
app="$here/../../MacOS/WeMessage"
if [ ! -x "$app" ]; then
  app="$here/../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
fi
ELECTRON_RUN_AS_NODE=1 exec "$app" "$here/${entry}" "$@"
`;
}

function parseArgs(argv) {
  const opts = { metafile: null, arch: ARCH };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--metafile') {
      i += 1;
      opts.metafile = argv[i];
    } else if (argv[i] === '--arch') {
      i += 1;
      opts.arch = argv[i];
    }
  }
  return opts;
}

export async function bundleDaemon(argv = []) {
  const opts = parseArgs(argv);
  if (opts.arch !== ARCH) {
    throw new Error(
      `refusing to build for ${String(opts.arch)}: 1.0 ships ${ARCH} only ` +
        `(F-135), and an artefact nobody has smoked is worse than no artefact`,
    );
  }

  /*
   * Resolved from `packages/store`, not from here. `better-sqlite3` is not a
   * dependency of `apps/desktop` and must not become one: the app never opens
   * a database, the daemon does. Rooting the lookup in the package that really
   * depends on it also guarantees the bundle ships the exact module `pnpm test`
   * ran against, rather than whatever a second declaration might drift to.
   */
  const storeRequire = createRequire(join(REPO, 'packages/store/package.json'));
  const sqliteDir = dirname(
    storeRequire.resolve('better-sqlite3/package.json'),
  );
  const prebuild = join(sqliteDir, 'prebuilds', `darwin-${ARCH}.node`);
  if (!existsSync(prebuild)) {
    throw new Error(
      `no prebuild at ${prebuild}; better-sqlite3 must be the N-API build ` +
        `(F-139). Run pnpm install.`,
    );
  }

  /*
   * WHY `wemessaged.mjs` IS UNDER `daemon/` AND NOT UNDER `bin/`.
   *
   * `better-sqlite3` stays external, so Node resolves it at run time by
   * walking `node_modules` UP from the importing file. F-121 and the F-139
   * amendment both pin the module to `Resources/daemon/node_modules`, which
   * means only files at or below `daemon/` can find it. Both daemon entries
   * open a database (`main.js` to serve, `bin.js` because `service install`
   * writes an audit row), so both live there. The CLI does not open one, it
   * speaks HTTP to the daemon, so it stays in `bin/` where it reads as what
   * it is. The shims in `bin/` reach across; a shim is a path, not an import.
   *
   * Found the hard way: with `wemessaged.mjs` in `bin/`, `service install`
   * died at module load with ERR_MODULE_NOT_FOUND before parsing a flag.
   */
  const entries = [
    {
      src: 'packages/daemon/dist/main.js',
      out: 'daemon/main.mjs',
      guard: true,
    },
    {
      src: 'packages/daemon/dist/bin.js',
      out: 'daemon/wemessaged.mjs',
      guard: true,
    },
    { src: 'packages/cli/dist/bin.js', out: 'bin/wemessage.mjs', guard: false },
  ];
  for (const e of entries) {
    if (!existsSync(join(REPO, e.src))) {
      throw new Error(`${e.src} is missing; run pnpm build first`);
    }
  }

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, 'bin'), { recursive: true });
  mkdirSync(join(OUT, 'daemon'), { recursive: true });

  const merged = { inputs: {}, outputs: {} };
  for (const e of entries) {
    const result = await build({
      entryPoints: [join(REPO, e.src)],
      outfile: join(OUT, e.out),
      bundle: true,
      platform: 'node',
      format: 'esm',
      // Electron 44 runs Node 24; targeting lower would down-level syntax the
      // runtime supports natively and make the bundle harder to read in a crash.
      target: 'node24',
      external: EXTERNALS,
      banner: { js: bannerFor(e.guard) },
      metafile: true,
      // Not 'silent'. A warning about the shipped artefact that nobody sees is
      // a decision nobody made; see EXTERNALS above for the one that hid here.
      logLevel: 'warning',
    });
    Object.assign(merged.inputs, result.metafile.inputs);
    Object.assign(merged.outputs, result.metafile.outputs);
  }

  // The native module, copied rather than linked: a symlink out of the bundle
  // would not survive being signed, notarized or dragged to /Applications.
  const dest = join(OUT, 'daemon/node_modules/better-sqlite3');
  mkdirSync(join(dest, 'prebuilds'), { recursive: true });
  cpSync(prebuild, join(dest, 'prebuilds', `darwin-${ARCH}.node`));
  for (const f of SQLITE_LIB) {
    const to = join(dest, 'lib', f);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(sqliteDir, 'lib', f), to);
  }
  const sqlitePkg = JSON.parse(
    readFileSync(join(sqliteDir, 'package.json'), 'utf8'),
  );
  writeFileSync(
    join(dest, 'package.json'),
    `${JSON.stringify(
      {
        name: sqlitePkg.name,
        version: sqlitePkg.version,
        main: sqlitePkg.main,
        license: sqlitePkg.license,
      },
      null,
      2,
    )}\n`,
  );

  /*
   * THE MIGRATIONS SHIP AS DATA, AND THE `../` IS LOAD-BEARING.
   *
   * `packages/store/src/migrate.ts` resolves its SQL with
   * `new URL('../migrations/', import.meta.url)` and reads the directory at
   * run time, so the statements are never in the module graph and esbuild
   * cannot inline them. From `dist-bundle/daemon/main.mjs` that URL is
   * `dist-bundle/migrations/`, and from the packed
   * `Resources/daemon/main.mjs` it is `Resources/migrations/`. The same hop
   * is correct in both layouts, which is why this ships beside the bundle
   * rather than inside `daemon/`.
   */
  const migrationsSrc = join(REPO, 'packages/store/migrations');
  mkdirSync(join(OUT, 'migrations'), { recursive: true });
  for (const f of readdirSync(migrationsSrc).filter((n) =>
    n.endsWith('.sql'),
  )) {
    cpSync(join(migrationsSrc, f), join(OUT, 'migrations', f));
  }

  // What runtime this bundle was built for, declared rather than inferred, so
  // a refusal at boot can be checked against a file instead of a guess.
  const electronBin = need('electron');
  const abi = execFileSync(
    electronBin,
    ['-e', 'process.stdout.write(process.versions.modules)'],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' },
  ).trim();
  const electronVersion = JSON.parse(
    readFileSync(need.resolve('electron/package.json'), 'utf8'),
  ).version;
  writeFileSync(
    join(OUT, 'daemon/ABI.json'),
    `${JSON.stringify(
      { runtime: 'electron', version: electronVersion, abi: Number(abi) },
      null,
      2,
    )}\n`,
  );

  for (const [name, entry] of [
    ['wemessage', 'wemessage.mjs'],
    ['wemessaged', '../daemon/wemessaged.mjs'],
  ]) {
    const p = join(OUT, 'bin', name);
    writeFileSync(p, shim(entry));
    chmodSync(p, 0o755);
  }

  if (opts.metafile) {
    writeFileSync(opts.metafile, `${JSON.stringify(merged, null, 2)}\n`);
  }
  return merged;
}

// `process.argv[1]` is undefined under `node -e`, and pathToFileURL throws on
// undefined rather than returning nothing, so the guard is written to answer
// "was I the script" without assuming there was one.
const invokedAs = process.argv[1];
if (
  invokedAs !== undefined &&
  import.meta.url === pathToFileURL(invokedAs).href
) {
  bundleDaemon(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
