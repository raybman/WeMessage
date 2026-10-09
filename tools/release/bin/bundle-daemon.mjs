/**
 * Build the daemon and CLI as bundles the shipped app can run (s9 Sc 5,
 * v2 S2b, v2 S6c).
 *
 * The Swift app ships its own Node beside the daemon (`daemon/node`, copied
 * in at pack time) and runs it with WEMESSAGE_HOST=swift. So the daemon
 * cannot ship as a workspace: it has to arrive as one ESM file plus the one
 * native module esbuild cannot inline.
 *
 * WHY THE ENTRIES ARE `dist/`, NOT `src/`. Bundling the TypeScript directly
 * would mean teaching esbuild to resolve NodeNext's `./daemon.js` specifiers
 * back to `./daemon.ts`. `tsc -b` already emits exactly the module graph the
 * tests run against, so the bundle is built from the same bytes `pnpm test`
 * exercised rather than from a second, subtly different compile.
 *
 * WHY `better-sqlite3` IS EXTERNAL AND COPIED. It is a native module; esbuild
 * cannot inline a `.node`. Under F-139 it is N-API via prebuildify, so exactly
 * one `prebuilds/darwin-arm64.node` serves every Node the app could ship, and
 * there is no per-ABI fetch to get wrong.
 *
 * WHY THE BANNER IS THE WHOLE REFUSAL. `better-sqlite3` being N-API means a
 * bare `node main.mjs` would happily boot a daemon whose TCC identity is the
 * terminal rather than the app. The banner is prepended ahead of every
 * bundled module body, so the check runs before any daemon code, and the
 * refusal is deterministic instead of incidental. It asks two questions: the
 * Swift host (WEMESSAGE_HOST=swift) and the Node major pinned by
 * tools/swift/node.lock.json, inlined at build time.
 *
 * ONE FLAVOUR (v2 S6c). Until S6c this script also built a second flavour for
 * the previous desktop app, into that app's own directory. That app is
 * deleted, so `--runtime` accepts `node` only (and defaults to it), and
 * `--out` and `--node` are required. The script lives in tools/release/bin
 * (v2 S6a) and `esbuild` is a devDependency of `@wemessage/release`.
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
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));

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

const REFUSAL_NODE =
  'this bundle runs under the WeMessage app host (wemessage --daemon)';

/** The one host a bundle can be built for. Anything else is refused. */
const RUNTIMES = ['node'];

/** Where the node flavour reads its pinned major when no `--lock` is given. */
const NODE_LOCK = join(REPO, 'tools/swift/node.lock.json');

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
 * before this has had its say. Two refusals, each closing a way to boot a
 * daemon under an identity that is not the app's:
 *
 *  - `WEMESSAGE_HOST !== "swift"`: the app's shims and the Swift host set it
 *    on the child they start, and a bare `node main.mjs` does not;
 *  - the Node major: the one Node this bundle was built to ship beside,
 *    inlined as a number at build time so the check costs no file read.
 *
 * The comparison stays on one line on purpose: bundle-daemon.spec reads the
 * pinned major back out of the built file with one regex.
 */
const guardNode = (major) =>
  `if (process.env.WEMESSAGE_HOST !== "swift" || Number(process.versions.node.split(".")[0]) !== ${String(major)}) {
  process.stderr.write(${JSON.stringify(REFUSAL_NODE)} + "\\n");
  process.exit(1);
}`;

/** The guard runs first, so a refusal never reaches the require shim. */
const bannerFor = (guard, guardText) =>
  [REQUIRE_SHIM, guard ? guardText : '', REQUIRE_BIND]
    .filter(Boolean)
    .join('\n');

/** The shim: the app's own Node, told which host it serves. */
function nodeShim(entry) {
  return `#!/bin/sh
# v2 S2b. The Swift app's shim. NO ABSOLUTE PATHS: a tracked file in a public
# repo may not carry a developer's home directory (arch row 13), and a shim
# baked to one checkout would not survive being copied into /Applications.
# Every hop is relative to the directory this file really lives in, which is
# why "readlink -f" comes first: the Homebrew cask SYMLINKS these files onto
# PATH, and "$0" is then the link, so a plain dirname would put "here" in the
# link's directory and every hop below would point at nothing.
#
#   shipped: WeMessage.app/Contents/Resources/bin/ -> ../daemon/node
#
# There is no dev fallback. daemon/node is copied in at pack time, and a
# bundle without it has nothing to run on. WEMESSAGE_HOST=swift is how the
# daemon knows its host; the bundle's guard refuses to start without it.
here=$(cd -- "$(dirname -- "$(readlink -f "$0")")" && pwd -P)
WEMESSAGE_HOST=swift exec "$here/../daemon/node" "$here/${entry}" "$@"
`;
}

/** The flags that take a value and name the flavour. */
const FLAVOUR_FLAGS = new Map([
  ['--runtime', 'runtime'],
  ['--out', 'out'],
  ['--node', 'node'],
  ['--lock', 'lock'],
]);

/*
 * `--metafile <path>` and `--arch <arch>`, plus the flavour flags:
 * `--runtime node` (the default, and the only value accepted), `--out <dir>`
 * (required), `--node <path>` (required, the Node the app will ship) and
 * `--lock <path>` (default tools/swift/node.lock.json). A flavour flag with
 * no value is refused here rather than read as `undefined` further down.
 */
function parseArgs(argv) {
  const opts = {
    metafile: null,
    arch: ARCH,
    runtime: 'node',
    out: null,
    node: null,
    lock: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--metafile') {
      i += 1;
      opts.metafile = argv[i];
    } else if (argv[i] === '--arch') {
      i += 1;
      opts.arch = argv[i];
    } else if (FLAVOUR_FLAGS.has(argv[i])) {
      const flag = argv[i];
      i += 1;
      if (argv[i] === undefined || argv[i] === '') {
        throw new Error(`${flag} needs a value`);
      }
      opts[FLAVOUR_FLAGS.get(flag)] = argv[i];
    }
  }
  return opts;
}

/** `a` is `b`, or a directory `b` lives somewhere under. */
function isSelfOrAncestor(a, b) {
  const r = relative(a, b);
  return !isAbsolute(r) && r.split(sep)[0] !== '..';
}

/*
 * WHERE A BUILD MAY WRITE, DECIDED BEFORE ANYTHING IS DELETED.
 *
 * The build starts by deleting its output directory, so an explicit `--out`
 * is checked first. It may not contain the repo or the home directory. And a
 * directory that
 * already has something in it is only replaced when it is a bundle this
 * script wrote, which it recognises by `daemon/ABI.json`; anything else is
 * refused untouched, because nothing in it is this script's to delete.
 */
function outDir(opts) {
  if (opts.out === null) {
    throw new Error(
      '--out <dir> is required: the bundle is built into a directory you name',
    );
  }
  const out = resolve(opts.out);
  for (const precious of [resolve(REPO), homedir()]) {
    if (isSelfOrAncestor(out, precious)) {
      throw new Error(`refusing to build into ${out}: it holds ${precious}`);
    }
  }
  if (existsSync(out)) {
    if (!statSync(out).isDirectory()) {
      throw new Error(`refusing to build into ${out}: not a directory`);
    }
    if (
      readdirSync(out).length > 0 &&
      !existsSync(join(out, 'daemon/ABI.json'))
    ) {
      throw new Error(
        `refusing to build into ${out}: not empty, and not a bundle (no ` +
          `daemon/ABI.json), so nothing in it is this script's to delete`,
      );
    }
  }
  return out;
}

/*
 * THE LOCK IS READ FOR ITS MAJOR, AND THE VERSION ONLY HAS TO AGREE WITH IT.
 *
 * The bundle pins the major the app's Node will report, nothing finer: a
 * patch release of the same Node is the same runtime as far as this bundle
 * is concerned. Deliberately NOT cross-checked against `--node`. The lock
 * says what the bundle will run under and `--node` says what ABI.json was
 * measured from; the pack step hands in both from the same tarball, and
 * bundle.spec builds with the runner's Node against locks it writes, which
 * is how each guard clause gets a row of its own on a CI Node that is not 24.
 */
function lockedMajor(path) {
  let lock;
  try {
    lock = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read the Node lock ${path}: ${err.message}`);
  }
  const { version, major } = lock ?? {};
  if (
    !Number.isInteger(major) ||
    major <= 0 ||
    typeof version !== 'string' ||
    !version.startsWith(`${String(major)}.`)
  ) {
    throw new Error(
      `${path} must carry a positive integer "major" and a "version" that ` +
        `starts with it, not ${JSON.stringify({ version, major })}`,
    );
  }
  return major;
}

/*
 * ABI.json, measured from the `--node` binary rather than typed. Runs before
 * anything is deleted.
 */
function nodeRuntime(bin) {
  let reply;
  try {
    reply = execFileSync(
      bin,
      [
        '-p',
        'JSON.stringify([process.versions.node, process.versions.modules])',
      ],
      { encoding: 'utf8' },
    );
  } catch (err) {
    throw new Error(`--node ${bin} could not be run: ${err.message}`);
  }
  const [version, modules] = JSON.parse(reply);
  return { runtime: 'node', version, abi: Number(modules) };
}

export async function bundleDaemon(argv = []) {
  const opts = parseArgs(argv);
  if (!RUNTIMES.includes(opts.runtime)) {
    throw new Error(
      `unknown --runtime ${opts.runtime}: this script builds node only`,
    );
  }
  if (opts.arch !== ARCH) {
    throw new Error(
      `refusing to build for ${String(opts.arch)}: 1.0 ships ${ARCH} only ` +
        `(F-135), and an artefact nobody has smoked is worse than no artefact`,
    );
  }

  /*
   * Every refusal the flags can earn, before any file is touched: where the
   * build may write, the pinned major, and the measured Node.
   */
  const out = outDir(opts);
  if (opts.node === null) {
    throw new Error(
      '--node <path> is required: the Node the app will ship, which ' +
        'ABI.json is measured from',
    );
  }
  const guardText = guardNode(lockedMajor(opts.lock ?? NODE_LOCK));
  const declared = nodeRuntime(opts.node);

  /*
   * Resolved from `packages/store`, not from here. `better-sqlite3` is not a
   * dependency of `@wemessage/release` and must not become one: the release
   * tooling never opens a database, the daemon does. Rooting the lookup in the package that really
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

  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'bin'), { recursive: true });
  mkdirSync(join(out, 'daemon'), { recursive: true });

  const merged = { inputs: {}, outputs: {} };
  for (const e of entries) {
    const result = await build({
      entryPoints: [join(REPO, e.src)],
      outfile: join(out, e.out),
      bundle: true,
      platform: 'node',
      format: 'esm',
      // The pinned Node is 24 or later; targeting lower would down-level syntax
      // the runtime supports natively and make the bundle harder to read in a
      // crash.
      target: 'node24',
      external: EXTERNALS,
      // ws reads these two keys before it tries its optional native requires,
      // so defining them makes both requires dead code that esbuild drops.
      // A bundle that never names bufferutil or
      // utf-8-validate cannot load one planted beside it (v2 S2c.1 P0-3).
      define: {
        'process.env.WS_NO_BUFFER_UTIL': '"1"',
        'process.env.WS_NO_UTF_8_VALIDATE': '"1"',
      },
      banner: { js: bannerFor(e.guard, guardText) },
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
  const dest = join(out, 'daemon/node_modules/better-sqlite3');
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
   * cannot inline them. From `<out>/daemon/main.mjs` that URL is
   * `<out>/migrations/`, and from the packed `Resources/daemon/main.mjs` it
   * is `Resources/migrations/`. The same hop
   * is correct in both layouts, which is why this ships beside the bundle
   * rather than inside `daemon/`.
   */
  const migrationsSrc = join(REPO, 'packages/store/migrations');
  mkdirSync(join(out, 'migrations'), { recursive: true });
  for (const f of readdirSync(migrationsSrc).filter((n) =>
    n.endsWith('.sql'),
  )) {
    cpSync(join(migrationsSrc, f), join(out, 'migrations', f));
  }

  // What runtime this bundle was built for, declared rather than inferred, so
  // a refusal at boot can be checked against a file instead of a guess.
  writeFileSync(
    join(out, 'daemon/ABI.json'),
    `${JSON.stringify(declared, null, 2)}\n`,
  );

  for (const [name, entry] of [
    ['wemessage', 'wemessage.mjs'],
    ['wemessaged', '../daemon/wemessaged.mjs'],
  ]) {
    const p = join(out, 'bin', name);
    writeFileSync(p, nodeShim(entry));
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
