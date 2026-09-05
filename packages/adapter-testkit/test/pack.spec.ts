/**
 * s7-execution Scenario 12 — what a stranger actually receives (F-94).
 *
 * Everything else in this repo is checked as source. This file is the only
 * place that checks the ARTIFACT: the three tarballs `pnpm pack` produces for
 * `@wemessage/core`, `@wemessage/protocol` and `@wemessage/adapter-testkit`,
 * which are the entire public surface of the project and the only part of it
 * a person outside this tree will ever hold.
 *
 * A packing test that asserts `pnpm pack` exits 0 asserts nothing. Exit 0 is
 * the state the repo was already in at the top of this scenario, with a
 * tarball that carried `src/`, `test/`, every `.map`, both tsconfigs, and no
 * README or LICENSE at all. So every row here opens the tarball:
 *
 *   - the file LIST, in both directions: what must be there, and what must
 *     not. `dist/**` and the docs in; sources, specs, maps and tsconfigs out.
 *   - the packed MANIFEST, which is not the one on disk — pnpm rewrites
 *     `workspace:*` to a concrete version at pack time, so the published
 *     dependency graph is only observable here.
 *   - the CONTENTS of every text file, through the Sc 11 public-string
 *     sweep. A tarball is the worst possible place to discover an operator's
 *     home directory or a token-shaped string, because it is immutable and
 *     mirrored the moment it is published.
 *   - the shipped IMPORT graph. `files` is a whitelist of paths, not of
 *     dependencies: a `dist/` module that imports a devDependency packs
 *     cleanly and fails on a stranger's machine at `require` time. Row 9's
 *     second half resolves every bare specifier in every shipped file
 *     against the packed `dependencies` and the Node builtins.
 *
 * NOTHING IS PUBLISHED HERE. `pnpm pack` writes a local tarball into a temp
 * directory and the temp directory is removed; there is no `npm publish`, no
 * `--dry-run` against the registry, and no login. F-94 keeps the versions at
 * 0.1.0 and defers the first real publish to F1.
 *
 * COST. Packing runs the real packer against three packages, so it is done
 * ONCE in `beforeAll` rather than per row, with an explicit hook timeout;
 * the default 5s would flake on a cold filesystem. `afterAll` removes the
 * directory and runs whether the rows passed or failed, which is the
 * property that matters — a failing packaging suite must not leave tarballs
 * behind for the next run to read as fresh.
 */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publicStringOffenders } from '../../cli/test/helpers/transcript-lint.js';
// The quickstart lists the six checks by name. They are a runtime value, so
// the list can be diffed rather than trusted.
import { CHECK_NAMES } from '../src/checks.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** F-94's publish set, and the dependency graph each member may ship. */
const PUBLISH_SET = [
  { name: '@wemessage/core', dir: 'packages/core', deps: [] },
  {
    name: '@wemessage/protocol',
    dir: 'packages/protocol',
    deps: ['@wemessage/core'],
  },
  {
    name: '@wemessage/adapter-testkit',
    dir: 'packages/adapter-testkit',
    deps: ['@wemessage/protocol', 'ws'],
  },
] as const satisfies readonly {
  name: string;
  dir: string;
  deps: readonly string[];
}[];

interface Entry {
  /** Path inside the tarball with npm's `package/` prefix removed. */
  readonly path: string;
  /** The mode string as the archive records it, e.g. `-rwxr-xr-x`. */
  readonly mode: string;
}
interface Packed {
  readonly entries: readonly Entry[];
  readonly paths: readonly string[];
  readonly manifest: Record<string, unknown>;
  /** Absolute path to the extracted `package/` directory. */
  readonly root: string;
}

let work = '';
const packed = new Map<string, Packed>();

function pack(dir: string): Packed {
  const dest = join(work, dir.replace(/\//g, '_'));
  mkdirSync(dest, { recursive: true });
  execFileSync('pnpm', ['pack', '--pack-destination', dest], {
    cwd: join(REPO, dir),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tgz = readdirSync(dest).find((f) => f.endsWith('.tgz'));
  if (tgz === undefined) throw new Error(`no tarball produced for ${dir}`);
  const archive = join(dest, tgz);

  // `tar -tzv` is the only listing that carries the mode bits, which row 7
  // needs: extracting and stat-ing would read the umask of whoever ran the
  // suite rather than what the archive recorded.
  const entries = execFileSync('tar', ['-tzvf', archive], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((line) => {
      const cols = line.trim().split(/\s+/);
      return {
        mode: cols[0] ?? '',
        path: (cols.at(-1) ?? '').replace(/^package\//, ''),
      };
    })
    .filter((e) => !e.path.endsWith('/'));

  const root = join(dest, 'x');
  mkdirSync(root, { recursive: true });
  execFileSync('tar', ['-xzf', archive, '-C', root]);

  const manifest: unknown = JSON.parse(
    readFileSync(join(root, 'package', 'package.json'), 'utf8'),
  );
  return {
    entries,
    paths: entries.map((e) => e.path).sort(),
    manifest: manifest as Record<string, unknown>,
    root: join(root, 'package'),
  };
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'wemessage-pack-'));
  for (const p of PUBLISH_SET) packed.set(p.name, pack(p.dir));
}, 300_000);

afterAll(() => {
  if (work !== '') rmSync(work, { recursive: true, force: true });
});

function tarball(name: string): Packed {
  const p = packed.get(name);
  if (p === undefined) throw new Error(`${name} was not packed`);
  return p;
}

/** Every file under `dir`, relative to it. */
function walk(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? walk(join(dir, d.name), base)
      : [relative(base, join(dir, d.name))],
  );
}

/* ── row 6: the three packages pack, and pack the right files ───────────── */

describe('s7 Sc12 row 6: the publish set produces publishable tarballs', () => {
  for (const pkg of PUBLISH_SET) {
    it(`${pkg.name} ships a public, licensed, documented manifest`, () => {
      const { manifest } = tarball(pkg.name);
      expect(manifest['name']).toBe(pkg.name);
      // The `private: true` flip. npm refuses to publish a private package,
      // so a stray `private` key is the difference between a publish set and
      // three packages that silently cannot be installed.
      expect(Object.keys(manifest)).not.toContain('private');
      expect(manifest['license']).toBe('Apache-2.0');
      expect(manifest['version']).toBe('0.1.0'); // F-94: no version bump here
      expect(manifest['publishConfig']).toMatchObject({ access: 'public' });
      // pnpm rewrites `workspace:*` at pack time. If one survives, the
      // published package is uninstallable outside this monorepo.
      expect(JSON.stringify(manifest)).not.toContain('workspace:');
    });

    it(`${pkg.name} ships dist, README and LICENSE`, () => {
      const { paths } = tarball(pkg.name);
      expect(paths).toContain('package.json');
      expect(paths).toContain('README.md');
      expect(paths).toContain('LICENSE');
      expect(
        paths.filter((p) => /^dist\/.*\.js$/.test(p)).length,
      ).toBeGreaterThan(0);
      expect(
        paths.filter((p) => /^dist\/.*\.d\.ts$/.test(p)).length,
      ).toBeGreaterThan(0);
    });

    it(`${pkg.name} ships no source, no spec, no map and no tsconfig`, () => {
      const { paths } = tarball(pkg.name);
      /**
       * `src/schemas/**` is the one deliberate exception, and only for JSON.
       * The schemas are not our source: `packages/protocol/src/index.ts` says
       * in as many words that they "exist for third parties, not for us", and
       * PROTOCOL.md prints each one's `$id` to a reader who is writing a
       * validator. Publishing the document and withholding the files it
       * names would be the shape of helpfulness without the substance. The
       * glob is `*.json`, so no TypeScript rides along with them.
       */
      const banned = paths.filter(
        (p) =>
          (p.startsWith('src/') && !/^src\/schemas\/.*\.json$/.test(p)) ||
          p.startsWith('test/') ||
          p.startsWith('fixtures/') ||
          /\.map$/.test(p) ||
          /(^|\/)tsconfig[^/]*\.json$/.test(p) ||
          /\.spec\.[cm]?[jt]s$/.test(p) ||
          /vitest\.config\./.test(p) ||
          /^\.(git|npm|eslint)/.test(p),
      );
      expect(banned).toEqual([]);
    });

    if (pkg.name === '@wemessage/protocol')
      it('ships every JSON Schema its own PROTOCOL.md names', () => {
        /**
         * The document is in the tarball; so are the files it points at. A
         * reader who runs `npm i @wemessage/protocol` to build a validator
         * gets both, and this row fails the moment a schema is added to the
         * repo, printed in the document, and left out of `files`.
         */
        const { root, paths } = tarball('@wemessage/protocol');
        const doc = readFileSync(join(root, 'PROTOCOL.md'), 'utf8');
        const ids = [
          ...new Set(
            [
              ...doc.matchAll(
                /https:\/\/wemessage\.dev\/schemas\/v1\/([A-Za-z0-9./-]+)\.json/g,
              ),
            ].map((m) => m[1] ?? ''),
          ),
        ];
        expect(ids.length).toBeGreaterThanOrEqual(26);
        const shipped = new Set(
          paths.filter((p) => p.startsWith('src/schemas/')),
        );
        const missing = ids
          .map((id) => `src/schemas/${id}.json`)
          .filter((f) => !shipped.has(f));
        expect(missing).toEqual([]);
      });

    it(`${pkg.name} carries no operator string, token or home path`, () => {
      // Every text file in the tarball, through the Sc 11 sweep. This is the
      // last point at which a `/Users/` path or a brand string can be caught;
      // after publication it is permanent.
      const { root } = tarball(pkg.name);
      const offenders: string[] = [];
      for (const file of walk(root)) {
        if (statSync(join(root, file)).size > 1_000_000) continue;
        const text = readFileSync(join(root, file), 'utf8');
        // A tarball is not a transcript, so only the public-string arms
        // apply; prose rules like colour-carries-state are swept over the
        // DOCUMENTS in test/arch.spec.ts, where the policy lives.
        for (const o of publicStringOffenders(text))
          offenders.push(`${file}: ${o.rule} ${o.detail}`);
      }
      expect(offenders).toEqual([]);
    });
  }
});

/* ── row 7: the testkit's bin survives packing, executable ──────────────── */

describe('s7 Sc12 row 7: the testkit ships a runnable bin', () => {
  const BIN = 'bin/wemessage-adapter-testkit.mjs';

  it('declares the bin and ships the file it points at', () => {
    const { manifest, paths } = tarball('@wemessage/adapter-testkit');
    const bin = manifest['bin'];
    expect(bin, 'the testkit package.json has no bin key').toBeDefined();
    // Sc 5's `wemessage adapters test` refusal prints this exact invocation,
    // and it only becomes true at publish time — which is here.
    expect(bin).toMatchObject({
      'wemessage-adapter-testkit': `./${BIN}`,
      'adapter-testkit': `./${BIN}`,
    });
    expect(paths).toContain(BIN);
  });

  it('records the bin as executable in the archive', () => {
    const entry = tarball('@wemessage/adapter-testkit').entries.find(
      (e) => e.path === BIN,
    );
    expect(entry, `${BIN} is not in the tarball`).toBeDefined();
    // Mode as the archive stores it, not as this machine's umask would
    // recreate it. `npx` on a stranger's machine execs this file directly.
    expect(entry?.mode).toMatch(/^-rwxr-xr-x/);
  });

  it('the bin resolves to a file the tarball also ships', () => {
    const { root } = tarball('@wemessage/adapter-testkit');
    const glue = readFileSync(join(root, BIN), 'utf8');
    const target = /from\s+'([^']+)'|import\('([^']+)'\)/.exec(glue);
    const spec = target?.[1] ?? target?.[2] ?? '';
    expect(spec, 'the bin imports nothing').not.toBe('');
    expect(spec.startsWith('../dist/')).toBe(true);
    expect(tarball('@wemessage/adapter-testkit').paths).toContain(
      spec.replace(/^\.\.\//, ''),
    );
  });
});

/* ── row 8: the examples a stranger copies are in the box ───────────────── */

describe('s7 Sc12 row 8: the testkit ships its worked examples', () => {
  it('ships the reference adapter and the stdio child', () => {
    const { paths } = tarball('@wemessage/adapter-testkit');
    expect(paths).toContain('examples/reference-adapter.mjs');
    expect(paths).toContain('examples/stdio-child.mjs');
  });

  it('ships no example that exists to fail', () => {
    // `broken-sends.mjs` is a fixture for our own conformance suite: an
    // adapter that attempts a send frame. Shipping it next to the reference
    // adapter would put working code for the forbidden thing in a stranger's
    // node_modules, which is the opposite of what this document set is for.
    expect(tarball('@wemessage/adapter-testkit').paths).not.toContain(
      'examples/broken-sends.mjs',
    );
  });

  it('the quickstart names the six checks the shipped code runs', () => {
    // A README that lists five of six, or lists a check that was renamed, is
    // a stranger debugging against a document instead of against their code.
    const readme = readFileSync(
      join(tarball('@wemessage/adapter-testkit').root, 'README.md'),
      'utf8',
    );
    expect(CHECK_NAMES).toHaveLength(6);
    for (const name of CHECK_NAMES)
      expect(readme, `the quickstart does not name: ${name}`).toContain(name);
  });

  it('the shipped reference adapter is the one the quickstart embeds', () => {
    const { root } = tarball('@wemessage/adapter-testkit');
    const shipped = readFileSync(
      join(root, 'examples/reference-adapter.mjs'),
      'utf8',
    );
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    expect(readme).toContain(shipped.trim());
  });
});

/* ── row 9: the published dependency graph is exactly what it claims ────── */

describe('s7 Sc12 row 9: nothing dev-only reaches the published surface', () => {
  const BUILTIN = new Set([
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
  ]);

  for (const pkg of PUBLISH_SET) {
    it(`${pkg.name} declares exactly ${JSON.stringify(pkg.deps)}`, () => {
      const { manifest } = tarball(pkg.name);
      const deps = (manifest['dependencies'] ?? {}) as Record<string, string>;
      expect(Object.keys(deps).sort()).toEqual([...pkg.deps].sort());
    });

    it(`${pkg.name} imports nothing it does not declare`, () => {
      // The row that `files` cannot express. A shipped module importing a
      // devDependency packs fine and explodes on first require.
      const { manifest, root } = tarball(pkg.name);
      const declared = new Set(
        Object.keys((manifest['dependencies'] ?? {}) as Record<string, string>),
      );
      const undeclared: string[] = [];
      for (const file of walk(root).filter((f) =>
        /\.(js|mjs|d\.ts)$/.test(f),
      )) {
        const text = readFileSync(join(root, file), 'utf8');
        // Real module specifiers only. A first cut matched the word `from`
        // anywhere, which read `transition from 'approved'` out of a JSDoc
        // comment and reported `approved` as an undeclared package: a row
        // that fails on prose is a row people learn to ignore.
        const specs = [
          ...text.matchAll(
            /^\s*(?:import|export)\s[^'"\n]*from\s*['"]([^'"]+)['"]/gm,
          ),
          ...text.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
          ...text.matchAll(/\b(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g),
          ...text.matchAll(/\bfrom\s*\(?\s*['"]([^'"]+)['"]\)?\s*;?\s*$/gm),
        ].map((m) => m[1] ?? '');
        for (const spec of specs) {
          if (spec.startsWith('.') || BUILTIN.has(spec)) continue;
          // `ws/index.js` counts as `ws`; `@scope/pkg/sub` as `@scope/pkg`.
          const parts = spec.split('/');
          const base = spec.startsWith('@')
            ? parts.slice(0, 2).join('/')
            : (parts[0] ?? '');
          if (!declared.has(base)) undeclared.push(`${file}: ${spec}`);
        }
      }
      expect(undeclared).toEqual([]);
    });
  }

  it('licenses:check reaches every dependency the publish set ships', () => {
    /**
     * pnpm does not hoist, so `ws` lives in `packages/adapter-testkit/
     * node_modules` and a checker run from the repo root never sees it. That
     * did not matter while the kit was `private: true` and nobody could
     * install it. This scenario flipped the flag, so `ws` is now a licence a
     * stranger inherits by running `npx @wemessage/adapter-testkit`, and a
     * root-only scan would be a green check that proves nothing about the
     * thing we publish.
     *
     * The fix is a second `--start` at each ROOT of the publish graph: a
     * member no other member depends on. Today that is the testkit alone,
     * and scanning it reaches protocol, core and ws. If a later scenario
     * publishes a package nothing else depends on, this row fails until the
     * script grows a `--start` for it.
     */
    const script = String(
      (
        JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
          scripts?: Record<string, string>;
        }
      ).scripts?.['licenses:check'] ?? '',
    );
    expect(script).not.toBe('');
    const dependedOn = new Set<string>(PUBLISH_SET.flatMap((p) => p.deps));
    const roots = PUBLISH_SET.filter((p) => !dependedOn.has(p.name));
    expect(roots.length).toBeGreaterThan(0);
    for (const root of roots)
      expect(
        script,
        `licenses:check never scans ${root.dir}, so its dependencies are unchecked`,
      ).toContain(`--start ${root.dir}`);
  });

  it('no workspace-internal package outside the publish set is reachable', () => {
    // fixtures, the adapters and the daemon are not published. If one of
    // their names appears in a shipped manifest at all, the graph is wrong.
    const published = new Set(PUBLISH_SET.map((p) => p.name));
    for (const pkg of PUBLISH_SET) {
      const deps = (tarball(pkg.name).manifest['dependencies'] ?? {}) as Record<
        string,
        string
      >;
      for (const dep of Object.keys(deps))
        if (dep.startsWith('@wemessage/'))
          expect(
            published,
            `${pkg.name} depends on unpublished ${dep}`,
          ).toContain(dep);
    }
  });
});
