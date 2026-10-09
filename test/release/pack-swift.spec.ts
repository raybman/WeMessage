/**
 * v2 S2d: WeMessage.app assembled from the Swift host and the bundled Node,
 * without Xcode. v2 S5a: signed, with one self-signed identity.
 *
 * STATIC, LIKE pack.spec. Every row here reads a script, a plist or a config
 * file and asserts its shape. Nothing is executed: assembling the bundle
 * needs a release Swift build and a fetched Node, and signing it needs an
 * identity, and neither belongs in a unit lane that also runs on Linux.
 * The end-to-end proof is the release.yml `pack-swift` job, which runs the
 * lane this file pins, twice, on macos-26, with a throwaway identity it
 * mints and deletes. test/swift/sign.sh.spec.ts runs sign.sh and the
 * identity half of verify-bundle.sh against a miniature app with stubbed
 * tools; the rows here pin the text those runs cannot see.
 *
 * WHAT THE ROWS ARE FOR. A bundle layout fails in two quiet ways. A file is
 * missing and the app dies on a user's Mac at first launch, or a file is
 * present that names the builder's machine (a home directory, a Homebrew
 * prefix) and the app works on exactly one Mac. Row 9 makes the verifier
 * check both against the real tree; rows 2 and 3 keep the scripts that build
 * the tree from writing anywhere but their own output directories.
 *
 * Rows 11 and 12 (S5a) pin sign.sh and the identity half of
 * verify-bundle.sh. Each row here is its own describe so they could be
 * added without touching the others.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ASSOCIATED_BUNDLE_IDENTIFIER,
  BUNDLE_DAEMON_MAIN_SUFFIX,
  BUNDLE_EXECUTABLE_SUFFIX,
  parseLaunchAgentPlist,
  type PlistDict,
  type PlistValue,
} from '../../packages/daemon/src/launchd/plist.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8');

const LOCK = 'tools/swift/node.lock.json';
const NODE_FETCH = 'tools/swift/node-fetch.sh';
const BUNDLE = 'tools/swift/bundle.sh';
const VERIFY = 'tools/swift/verify-bundle.sh';
const SIGN = 'tools/swift/sign.sh';
const PACK_SWIFT = 'tools/release/bin/pack-swift.mjs';
const INFO_PLIST = 'apps/mac/Resources/Info.plist';
const APP_ENTITLEMENTS = 'apps/mac/Resources/WeMessage.entitlements';
const NODE_ENTITLEMENTS = 'apps/mac/Resources/node.entitlements';
const BUNDLER = 'tools/release/bin/bundle-daemon.mjs';
const ICON = 'apps/mac/Resources/icon.icns';

/**
 * The bundle tree, relative to WeMessage.app (plan section 4.4 as redrawn by
 * RESOLVED B3). `migrations/` sits BESIDE `daemon/`: the store's loader hops
 * `../migrations` from the daemon module, so moving it inside breaks boot.
 */
const TREE: readonly string[] = [
  'Contents/Info.plist',
  'Contents/PkgInfo',
  'Contents/MacOS/WeMessage',
  'Contents/Resources/AppIcon.icns',
  'Contents/Resources/daemon/node',
  'Contents/Resources/daemon/main.mjs',
  'Contents/Resources/daemon/wemessaged.mjs',
  'Contents/Resources/daemon/ABI.json',
  'Contents/Resources/daemon/node_modules/better-sqlite3/package.json',
  'Contents/Resources/daemon/node_modules/better-sqlite3/lib/index.js',
  'Contents/Resources/daemon/node_modules/better-sqlite3/prebuilds/darwin-arm64.node',
  'Contents/Resources/migrations/0001_init.sql',
  'Contents/Resources/bin/wemessage',
  'Contents/Resources/bin/wemessage.mjs',
  'Contents/Resources/bin/wemessaged',
  'Contents/Resources/licenses/LICENSE.node.txt',
];

/** `100755` when the index records the exec bit. */
const indexMode = (rel: string): string => {
  const out = execFileSync('git', ['ls-files', '-s', '--', rel], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return out.split(/\s/)[0] ?? '';
};

// ---------------------------------------------------------------------------
// The writes linter (rows 2 and 3).
//
// "Never writes outside --out" cannot be proved by running the script here,
// so it is proved on the text: every command that can create, replace or
// delete a path must name a destination that starts with one of the
// script's own output variables. Deliberately simple shell: comments are
// stripped, single-quoted strings are blanked (awk programs and printf
// formats live there), continuations are joined, and the text is cut into
// simple commands. A script that defeats this linter with clever shell is a
// script that should be simpler, so the linter does not try harder.
// ---------------------------------------------------------------------------

interface Write {
  readonly command: string;
  readonly target: string;
}

const simpleCommands = (sh: string): string[] =>
  sh
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .join('\n')
    .replace(/'[^'\n]*'/g, "''")
    .replace(/\\\n/g, ' ')
    .split(/&&|\|\||;|\||\n/)
    .map((s) =>
      s
        .trim()
        .replace(/^(?:(?:if|then|else|elif|do|while|!|\{|\()\s+)+/, '')
        .replace(/^\w+="?\$\(/, ''),
    )
    .filter((s) => s.length > 0);

const ALL_OPERANDS = new Set(['mkdir', 'rm', 'touch', 'chmod']);
const LAST_OPERAND = new Set(['ditto', 'cp', 'mv', 'install', 'ln']);
const MODE_ARG = /^(?:[0-7]{3,4}|[ugoa]*[-+=][rwxX]+)$/;

const writesOf = (sh: string): Write[] => {
  const out: Write[] = [];
  for (const cmd of simpleCommands(sh)) {
    const tokens = (cmd.match(/"[^"]*"|\S+/g) ?? [])
      .map((t) => t.replace(/\)+"?$/, ''))
      .filter((t) => t.length > 0 && t !== '"');
    const head = tokens[0] ?? '';
    const operands = tokens.slice(1).filter((t) => !t.startsWith('-'));
    const name = head.split('/').pop() ?? head;
    if (ALL_OPERANDS.has(name))
      for (const t of operands)
        if (!(name === 'chmod' && MODE_ARG.test(t)))
          out.push({ command: cmd, target: t });
    if (LAST_OPERAND.has(name) || name === 'PlistBuddy' || name === 'mktemp') {
      const last = operands[operands.length - 1];
      if (last !== undefined) out.push({ command: cmd, target: last });
    }
    for (const [flag, cmdName] of [
      ['-C', 'tar'],
      ['-o', 'curl'],
    ] as const)
      if (name === cmdName) {
        const i = tokens.indexOf(flag);
        const t = i === -1 ? undefined : tokens[i + 1];
        if (t !== undefined) out.push({ command: cmd, target: t });
      }
    for (const m of cmd.matchAll(/\d?>>?(?!&)\s*("[^"]*"|[^\s;|&)]+)/g)) {
      const t = m[1] ?? '';
      if (t !== '/dev/null') out.push({ command: cmd, target: t });
    }
  }
  return out;
};

const escapes = (sh: string, allowed: readonly string[]): Write[] =>
  writesOf(sh).filter((w) => !allowed.some((p) => w.target.startsWith(p)));

// ---------------------------------------------------------------------------

describe('row 1: node.lock.json pins Node 24.21.0 by sha256', () => {
  const lock = JSON.parse(read(LOCK)) as {
    version?: unknown;
    major?: unknown;
    source?: unknown;
    'darwin-arm64'?: { sha256?: unknown };
  };

  it('version 24.21.0, major 24, and the two agree', () => {
    expect(lock.version).toBe('24.21.0');
    expect(lock.major).toBe(24);
    expect(String(lock.version).startsWith(`${String(lock.major)}.`)).toBe(
      true,
    );
  });

  it('a 64-hex sha256 for darwin-arm64 and the nodejs.org source', () => {
    expect(String(lock['darwin-arm64']?.sha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(lock.source).toBe(
      `https://nodejs.org/dist/v${String(lock.version)}/`,
    );
  });
});

describe('row 2: node-fetch.sh verifies twice and writes only under .build/node', () => {
  it('exists, is bash under set -euo pipefail, and is executable', () => {
    expect(existsSync(join(repoRoot, NODE_FETCH))).toBe(true);
    const text = read(NODE_FETCH);
    expect(text.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(text).toContain('set -euo pipefail');
    expect(indexMode(NODE_FETCH)).toBe('100755');
  });

  it('checks the tarball against the lock AND SHASUMS256.txt, refusing with exit 2', () => {
    const text = read(NODE_FETCH);
    for (const needed of [
      'shasum -a 256',
      'node.lock.json',
      'SHASUMS256.txt',
      'exit 2',
      'apps/mac/.build/node',
    ])
      expect([needed, text.includes(needed)]).toEqual([needed, true]);
  });

  it('every write lands under $cache or $stage', () => {
    const text = read(NODE_FETCH);
    expect(writesOf(text).length).toBeGreaterThanOrEqual(5);
    expect(escapes(text, ['"$cache', '"$stage'])).toEqual([]);
  });

  it('PLANTED: a copy to /tmp is convicted', () => {
    const planted = `${read(NODE_FETCH)}\ncp "$cache/x" "/tmp/y"\n`;
    expect(
      escapes(planted, ['"$cache', '"$stage']).map((w) => w.target),
    ).toEqual(['"/tmp/y"']);
  });
});

describe('row 3: bundle.sh lays out the tree and writes only under --out', () => {
  it('exists, is bash under set -euo pipefail, and is executable', () => {
    expect(existsSync(join(repoRoot, BUNDLE))).toBe(true);
    const text = read(BUNDLE);
    expect(text.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(text).toContain('set -euo pipefail');
    expect(indexMode(BUNDLE)).toBe('100755');
  });

  it('takes --exe --node --bundle --out and refuses with exit 2', () => {
    const text = read(BUNDLE);
    for (const arm of ['--exe)', '--node)', '--bundle)', '--out)'])
      expect([arm, text.includes(arm)]).toEqual([arm, true]);
    expect(text).toContain('exit 2');
    expect(text).toContain('app="$out/WeMessage.app"');
  });

  it('copies with ditto, writes PkgInfo, patches both versions from package.json', () => {
    const text = read(BUNDLE);
    for (const needed of [
      'ditto',
      'APPL????',
      'PkgInfo',
      '/usr/libexec/PlistBuddy',
      'Set :CFBundleShortVersionString',
      'Set :CFBundleVersion',
      'package.json',
      'LICENSE.node.txt',
      ICON,
      'apps/mac/Resources/Info.plist',
    ])
      expect([needed, text.includes(needed)]).toEqual([needed, true]);
  });

  it('names every path of the tree it does not copy wholesale', () => {
    // bin/, daemon/ and migrations/ arrive by ditto from dist-bundle-node;
    // everything else is placed by name.
    const text = read(BUNDLE);
    for (const rel of [
      'Contents/MacOS/WeMessage',
      'Contents/PkgInfo',
      'Contents/Info.plist',
      'Contents/Resources/AppIcon.icns',
      'Contents/Resources/daemon/node',
      'Contents/Resources/licenses/LICENSE.node.txt',
      'Contents/Resources/bin',
      'Contents/Resources/daemon',
      'Contents/Resources/migrations',
    ])
      expect([rel, text.includes(rel)]).toEqual([rel, true]);
  });

  it('every write lands under $app or is $out itself', () => {
    const text = read(BUNDLE);
    expect(writesOf(text).length).toBeGreaterThanOrEqual(6);
    expect(escapes(text, ['"$app', '"$out"'])).toEqual([]);
  });

  it('PLANTED: a write beside --out is convicted', () => {
    const planted = `${read(BUNDLE)}\nprintf x > "$out/../stray"\n`;
    expect(escapes(planted, ['"$app', '"$out"']).map((w) => w.target)).toEqual([
      '"$out/../stray"',
    ]);
  });
});

describe('row 4: Info.plist', () => {
  const plist = (): PlistDict => parseLaunchAgentPlist(read(INFO_PLIST));

  const KEYS = [
    'CFBundleDevelopmentRegion',
    'CFBundleExecutable',
    'CFBundleIconFile',
    'CFBundleIdentifier',
    'CFBundleInfoDictionaryVersion',
    'CFBundleName',
    'CFBundlePackageType',
    'CFBundleShortVersionString',
    'CFBundleVersion',
    'LSApplicationCategoryType',
    'LSMinimumSystemVersion',
    'NSAppleEventsUsageDescription',
    'NSContactsUsageDescription',
    'NSHumanReadableCopyright',
  ];

  it('identifier and executable agree with the daemon constants', () => {
    const p = plist();
    expect(p['CFBundleIdentifier']).toBe('sh.wemessage.gateway');
    expect(p['CFBundleIdentifier']).toBe(ASSOCIATED_BUNDLE_IDENTIFIER);
    expect(p['CFBundleExecutable']).toBe('WeMessage');
    expect(BUNDLE_EXECUTABLE_SUFFIX).toBe(
      `/Contents/MacOS/${String(p['CFBundleExecutable'])}`,
    );
    expect(BUNDLE_DAEMON_MAIN_SUFFIX).toBe(
      '/Contents/Resources/daemon/main.mjs',
    );
    expect(p['CFBundlePackageType']).toBe('APPL');
    expect(p['LSMinimumSystemVersion']).toBe('26.0');
    expect(p['CFBundleIconFile']).toBe('AppIcon');
  });

  it('the Automation prompt, copyright and category are pinned literals', () => {
    // v2 S6a: these were held equal to apps/desktop/electron-builder.yml,
    // which S6c deletes. They are the strings the Electron app shipped, now
    // pinned here so the Swift lane reads nothing under the Electron app.
    const p = plist();
    expect(p['NSAppleEventsUsageDescription']).toBe(
      'WeMessage sends replies through Messages on your behalf, and only ones you have approved.',
    );
    expect(p['NSHumanReadableCopyright']).toBe(
      'Copyright © 2026 the WeMessage authors',
    );
    expect(p['LSApplicationCategoryType']).toBe(
      'public.app-category.productivity',
    );
  });

  it('carries placeholder versions that bundle.sh patches, never a real one', () => {
    // A real version here would be a twentieth place the version lives,
    // and check-versions does not read plists.
    const p = plist();
    expect(p['CFBundleShortVersionString']).toBe('0.0.0');
    expect(p['CFBundleVersion']).toBe('0.0.0');
  });

  it('no LSUIElement and no CFBundleURLTypes at any depth', () => {
    const keys: string[] = [];
    const walk = (v: PlistValue): void => {
      if (Array.isArray(v)) for (const x of v as PlistValue[]) walk(x);
      else if (typeof v === 'object')
        for (const [k, x] of Object.entries(v as PlistDict)) {
          keys.push(k);
          walk(x);
        }
    };
    walk(plist());
    expect(keys).not.toContain('LSUIElement');
    expect(keys).not.toContain('CFBundleURLTypes');
  });

  it('exactly the fourteen keys', () => {
    expect(Object.keys(plist()).sort()).toEqual(KEYS);
  });

  it("v2 S4g: the Contacts prompt is ProvisionalUI's D-UI-9 copy, not retyped", () => {
    // The Swift source holds the one copy (AppHygiene's D-UI row keeps it
    // out of every other Swift file); the plist must say the same words.
    const swift = read('apps/mac/Sources/WeMessageApp/ProvisionalUI.swift');
    const match = /public static let contactsUsage =\s*"([^"\\\n]+)"/.exec(
      swift,
    );
    expect(match).not.toBeNull();
    const copy = match?.[1] ?? '';
    expect(copy.length).toBeGreaterThan(40);
    expect(plist()['NSContactsUsageDescription']).toBe(copy);
  });
});

describe('row 5: entitlements', () => {
  const keysOf = (rel: string): string[] => {
    const p = parseLaunchAgentPlist(read(rel));
    for (const [k, v] of Object.entries(p)) expect([k, v]).toEqual([k, true]);
    return Object.keys(p).sort();
  };

  it('the app has exactly automation.apple-events and personal-information.addressbook', () => {
    // v2 S5e (plan 3.4, default A): the released app is hardened (sign.sh
    // passes --options runtime), and a hardened app is denied Contacts
    // without the resource-access entitlement, whatever Info.plist says. The
    // CI ui build is not hardened, so only this row can see the defect.
    expect(keysOf(APP_ENTITLEMENTS)).toEqual([
      'com.apple.security.automation.apple-events',
      'com.apple.security.personal-information.addressbook',
    ]);
  });

  it('node has exactly the four it needs', () => {
    // JIT for V8; disable-library-validation because a self-signed leaf has
    // no Team ID for validation to match against the addon.
    expect(keysOf(NODE_ENTITLEMENTS)).toEqual([
      'com.apple.security.automation.apple-events',
      'com.apple.security.cs.allow-jit',
      'com.apple.security.cs.allow-unsigned-executable-memory',
      'com.apple.security.cs.disable-library-validation',
    ]);
  });

  it('neither carries get-task-allow or allow-dyld-environment-variables', () => {
    for (const rel of [APP_ENTITLEMENTS, NODE_ENTITLEMENTS]) {
      const text = read(rel);
      for (const banned of [
        'get-task-allow',
        'allow-dyld-environment-variables',
      ])
        expect([rel, banned, text.includes(banned)]).toEqual([
          rel,
          banned,
          false,
        ]);
    }
  });
});

describe('row 6: pack-swift.mjs drives the lane in order', () => {
  const body = (): string => read(PACK_SWIFT);
  const code = (): string =>
    body()
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

  it('exists and imports node builtins only', () => {
    expect(existsSync(join(repoRoot, PACK_SWIFT))).toBe(true);
    const specs = [...code().matchAll(/\bfrom\s+'([^']+)'/g)].map(
      (m) => m[1] ?? '',
    );
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs)
      expect([
        s,
        ['node:child_process', 'node:fs', 'node:path'].includes(s),
      ]).toEqual([s, true]);
    expect(code()).not.toMatch(/\bimport\s*\(/);
    for (const banned of ['../src/', '../dist/', '@wemessage/'])
      expect([banned, body().includes(banned)]).toEqual([banned, false]);
  });

  it('spawns, and refuses with exit 2', () => {
    expect(code()).toMatch(/\bspawnSync\s*\(/);
    expect(code()).toContain('process.exit(2)');
  });

  it('v2 S5a: sign.sh is present, so the lane signs, and verifies the leaf it signed with', () => {
    // Flipped from S2d's "refuses, naming S2e, while sign.sh is absent".
    expect(existsSync(join(repoRoot, SIGN))).toBe(true);
    expect(indexMode(SIGN)).toBe('100755');
    for (const needed of [
      '--identity',
      'tools/swift/sign.sh',
      "'--expect-leaf',\n  identity,",
      '--throwaway',
      '-throwaway.zip',
    ])
      expect([needed, body().includes(needed)]).toEqual([needed, true]);
    expect(body()).not.toContain('S2e');
  });

  it('runs the ten steps in order', () => {
    const src = code();
    const calls: string[] = [];
    for (
      let i = src.indexOf('run(');
      i !== -1;
      i = src.indexOf('run(', i + 4)
    ) {
      const end = src.indexOf(');', i);
      calls.push(src.slice(i, end === -1 ? undefined : end));
    }
    // Script names are matched quoted, so 'bundle.sh' cannot be found
    // inside 'verify-bundle.sh' or 'bundle-daemon.mjs'.
    const STEPS: readonly (readonly string[])[] = [
      ["'node-fetch.sh'"],
      ["'pnpm'", "'build'"],
      ["'bundle-daemon.mjs'"],
      ["'swift.sh'", "'release'"],
      ["'bundle.sh'"],
      ["'sign.sh'"],
      ["'verify-bundle.sh'"],
      ["'ditto'"],
      ["'shasum'"],
      ["'codesign'"],
    ];
    const at = STEPS.map((tokens) =>
      calls.findIndex((c) => tokens.every((t) => c.includes(t))),
    );
    for (const [i, tokens] of STEPS.entries())
      expect([tokens.join(' '), (at[i] ?? -1) >= 0]).toEqual([
        tokens.join(' '),
        true,
      ]);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(new Set(at).size).toBe(at.length);
  });
});

describe('v2 S6a: the lane reads its inputs from outside the Electron app', () => {
  it('step 3 invokes tools/release/bin/bundle-daemon.mjs', () => {
    expect(existsSync(join(repoRoot, BUNDLER))).toBe(true);
    const text = read(PACK_SWIFT);
    expect(text).toContain(
      "join(REPO, 'tools', 'release', 'bin', 'bundle-daemon.mjs')",
    );
    // The bundle step writes where bundle.sh is then told to read.
    expect(text).toContain(
      "const DIST_BUNDLE_NODE = join(REPO, 'apps', 'mac', 'dist-bundle-node');",
    );
    // The moved bundler still carries the node flavour step 3 asks for.
    for (const needed of ["'--runtime'", "'node'", "'--out'", "'--node'"])
      expect([needed, text.includes(needed)]).toEqual([needed, true]);
    expect(read(BUNDLER)).toContain("opts.runtime === 'node'");
  });

  it('bundle.sh reads apps/mac/Resources/icon.icns, and it is a whole icns file', () => {
    expect(read(BUNDLE)).toContain(`icon="$repo/${ICON}"`);
    const abs = join(repoRoot, ICON);
    expect(existsSync(abs)).toBe(true);
    const bytes = readFileSync(abs);
    // An icns file opens with the 'icns' magic and a big-endian length that
    // is the whole file, so a truncated or substituted copy fails here.
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('icns');
    expect(bytes.readUInt32BE(4)).toBe(bytes.length);
    expect(bytes.length).toBeGreaterThan(1024);
  });
});

describe('row 7: the root script', () => {
  it("pack:swift is 'node tools/release/bin/pack-swift.mjs'", () => {
    const pkg = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['pack:swift']).toBe(
      'node tools/release/bin/pack-swift.mjs',
    );
  });
});

describe('row 8: build outputs are ignored', () => {
  it('.gitignore carries the four lines', () => {
    const lines = read('.gitignore').split('\n');
    for (const line of [
      '/apps/mac/dist-app/',
      '/apps/mac/dist-pack/',
      '/apps/mac/dist-pack-2/',
      'dist-bundle-node/',
    ])
      expect([line, lines.includes(line)]).toEqual([line, true]);
    expect(read('.prettierignore').split('\n')).toContain(
      '**/dist-bundle-node/**',
    );
  });

  it('git agrees, and the sources are not ignored', () => {
    const ignored = (rel: string): number | null =>
      spawnSync('git', ['check-ignore', '-q', rel], { cwd: repoRoot }).status;
    for (const rel of [
      'apps/mac/dist-app/WeMessage.app/Contents/Info.plist',
      'apps/mac/dist-pack/SHA256SUMS',
      'apps/mac/dist-pack-2/SHA256SUMS',
      'apps/mac/dist-bundle-node/daemon/main.mjs',
    ])
      expect([rel, ignored(rel)]).toEqual([rel, 0]);
    for (const rel of [INFO_PLIST, BUNDLE, PACK_SWIFT])
      expect([rel, ignored(rel)]).toEqual([rel, 1]);
  });
});

describe('row 9: verify-bundle.sh, the structure half', () => {
  it('exists, is bash under set -euo pipefail, and is executable', () => {
    expect(existsSync(join(repoRoot, VERIFY))).toBe(true);
    const text = read(VERIFY);
    expect(text.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(text).toContain('set -euo pipefail');
    expect(indexMode(VERIFY)).toBe('100755');
  });

  it('requires every path of the tree', () => {
    const text = read(VERIFY);
    expect(text).toContain('required=(');
    for (const rel of TREE)
      expect([rel, text.includes(rel)]).toEqual([rel, true]);
  });

  it('checks ABI.json against the lock, the identifier, leftovers and machine paths', () => {
    const text = read(VERIFY);
    for (const needed of [
      'ABI.json',
      'runtime',
      'node.lock.json',
      'CFBundleIdentifier',
      'sh.wemessage.gateway',
      'dist-bundle',
      '$HOME',
      '/opt/',
      '/usr/local',
      '--app)',
      '--expect-leaf',
      'exit 2',
    ])
      expect([needed, text.includes(needed)]).toEqual([needed, true]);
  });

  it('compares ABI.json to the lock, and never types an ABI number', () => {
    const text = read(VERIFY);
    for (const comparison of [
      '[ "$runtime" = "node" ]',
      '[ "$abi_version" = "$pinned" ]',
      "awk '!/^[1-9][0-9]*$/ {exit 1}'",
    ])
      expect([comparison, text.includes(comparison)]).toEqual([
        comparison,
        true,
      ]);
    // The ABI is read from the bundle; 137 and 141 are both real values today.
    expect(text.match(/\b\d{3}\b/g) ?? []).toEqual([]);
  });
});

describe('row 10: shell hygiene', () => {
  it('no grep in any of the four scripts, and awk reads the text', () => {
    for (const rel of [NODE_FETCH, BUNDLE, VERIFY, SIGN]) {
      expect([rel, read(rel).includes('grep')]).toEqual([rel, false]);
    }
    // bundle.sh only copies; the scripts that read text do it with awk.
    for (const rel of [NODE_FETCH, VERIFY, SIGN]) {
      expect([rel, /\bawk\b/.test(read(rel))]).toEqual([rel, true]);
    }
  });
});

describe('row 11 (v2 S5a): sign.sh signs inside-out, hardened, by SHA-1', () => {
  const text = (): string => read(SIGN);
  /** The script without comment lines, so a comment cannot satisfy a row. */
  const code = (): string =>
    text()
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');

  it('exists, is bash under set -euo pipefail, and is executable', () => {
    expect(text().startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(code()).toContain('set -euo pipefail');
    expect(indexMode(SIGN)).toBe('100755');
  });

  it('every codesign call carries --options runtime and --timestamp=none (tooth 1)', () => {
    const calls = code()
      .split('\n')
      .filter((l) => /^\s*codesign\b/.test(l));
    expect(calls).toEqual([
      '  codesign --force --options runtime --timestamp=none --sign "$identity" "$@" "$target" || {',
    ]);
  });

  it('signs the addon, node, the host, then the app, in that order (tooth 2)', () => {
    const order = code()
      .split('\n')
      .filter((l) => /^sign "\$/.test(l));
    expect(order).toEqual([
      'sign "$addon" --identifier sh.wemessage.gateway.better-sqlite3',
      'sign "$node" --identifier sh.wemessage.gateway.node --entitlements "$res/node.entitlements"',
      'sign "$exe" --identifier sh.wemessage.gateway --entitlements "$res/WeMessage.entitlements"',
      'sign "$app" --identifier sh.wemessage.gateway --entitlements "$res/WeMessage.entitlements"',
    ]);
  });

  it('the identity is a 40-hex SHA-1, never a name, and must be a valid code-signing identity', () => {
    expect(code()).toContain(
      "awk 'length($0) != 40 || $0 ~ /[^0-9A-Fa-f]/ {exit 1}'",
    );
    expect(code()).toContain('security find-identity -v -p codesigning');
    // One read-only question of the keychain, and no other security verb.
    const verbs = [...code().matchAll(/\bsecurity\s+([a-z-]+)/g)].map(
      (m) => m[1],
    );
    expect(verbs).toEqual(['find-identity']);
  });

  it('exits 2 usage, 3 identity, 4 codesign, 5 a stray Mach-O', () => {
    for (const n of ['exit 2', 'exit 3', 'exit 4', 'exit 5'])
      expect([n, code().includes(n)]).toEqual([n, true]);
    expect(
      // `{exit 1}` inside an awk program is awk's, not the script's.
      code()
        .match(/(?<!\{)\bexit [0-9]+/g)
        ?.sort(),
    ).toEqual(['exit 2', 'exit 3', 'exit 4', 'exit 5']);
  });

  it('the Mach-O sweep reads magic numbers, every byte order and fat', () => {
    expect(code()).toContain('od -An -tx1 -N4');
    for (const magic of [
      'cffaedfe',
      'cefaedfe',
      'feedfacf',
      'feedface',
      'cafebabe',
      'bebafeca',
    ])
      expect([magic, code().includes(magic)]).toEqual([magic, true]);
    expect(code()).toContain('find "$app/Contents" -type f -print0');
  });

  it('reads no secret, unlocks no keychain, and writes nothing but signatures', () => {
    for (const banned of [
      'secrets',
      'p12',
      'unlock-keychain',
      'security import',
      'login.keychain',
      '--deep',
    ])
      expect([banned, code().includes(banned)]).toEqual([banned, false]);
    expect(escapes(text(), [])).toEqual([]);
  });
});

describe('row 12 (v2 S5a): verify-bundle.sh, the identity half', () => {
  const text = (): string => read(VERIFY);

  it('the S2d refusal of --expect-leaf is lifted: 40-hex or any', () => {
    expect(text()).toContain('--expect-leaf) expect_leaf=');
    expect(text()).toContain('[ "$expect_leaf" != "any" ]');
    expect(text()).toContain(
      "awk 'length($0) != 40 || $0 ~ /[^0-9A-Fa-f]/ {exit 1}'",
    );
    expect(text()).not.toContain('S2e');
  });

  it('codesign verifies deep and strict, and the four signed objects are listed', () => {
    expect(text()).toContain('codesign --verify --deep --strict --verbose=2');
    for (const row of [
      'better-sqlite3/prebuilds/darwin-arm64.node|sh.wemessage.gateway.better-sqlite3|-"',
      'daemon/node|sh.wemessage.gateway.node|$res/node.entitlements"',
      'MacOS/WeMessage|sh.wemessage.gateway|$res/WeMessage.entitlements"',
      '"$app|sh.wemessage.gateway|$res/WeMessage.entitlements"',
    ])
      expect([row, text().includes(row)]).toEqual([row, true]);
  });

  it('one leaf, the runtime flag, the entitlements, and spctl recorded but never fatal', () => {
    for (const needed of [
      'codesign -d -r-',
      'certificate ',
      'codesign -dvv',
      'runtime',
      'codesign -d --entitlements - --xml',
      'plutil -convert xml1',
      'do not share one certificate leaf',
      'spctl -a -t exec -vv "$app" 2>&1 || true',
    ])
      expect([needed, text().includes(needed)]).toEqual([needed, true]);
  });
});

describe('row 13 (v2 S5e): verify-bundle.sh, packed entitlements equal the source file', () => {
  const text = (): string => read(VERIFY);

  // The ent_pairs awk program, lifted out of verify-bundle.sh so this row
  // runs the verifier's own parser and not a copy that could drift.
  const entPairsProgram = (): string => {
    const fn = text().match(/ent_pairs\(\) \{[\s\S]*?\n {2}\}/)?.[0] ?? '';
    const program = fn.match(/\| awk '([\s\S]*?)'\s*\| sort/)?.[1];
    expect(program, 'ent_pairs awk program').toBeTruthy();
    return program ?? '';
  };

  it('compares the whole set for equality, never a subset', () => {
    expect(text()).toContain('want_ents="$(ent_pairs "$ents")"');
    expect(text()).toContain('got_ents="$(ent_pairs "$scratch/ents.plist")"');
    expect(text()).toContain('[ "$got_ents" = "$want_ents" ]');
    // A subset or grep test would let an extra or a missing key through.
    expect(text()).not.toMatch(/grep[^\n]*want_ents|grep[^\n]*got_ents/);
  });

  it('the host and the app are held to WeMessage.entitlements, the node to node.entitlements', () => {
    const rows = [...text().matchAll(/^\s*"([^"|]+)\|([^"|]+)\|([^"|]+)"\s*$/gm)].map(
      (m) => [m[1]?.replace(/^.*\/(?=[^/]+\/[^/]+$)/, ''), m[3]],
    );
    expect(rows).toContainEqual(['MacOS/WeMessage', '$res/WeMessage.entitlements']);
    expect(rows).toContainEqual(['$app', '$res/WeMessage.entitlements']);
    expect(rows).toContainEqual(['daemon/node', '$res/node.entitlements']);
  });

  it("the verifier's parser reads exactly the two app keys from the source file", () => {
    const run = spawnSync('awk', [entPairsProgram(), join(repoRoot, APP_ENTITLEMENTS)], {
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(run.stdout.split('\n').filter(Boolean).sort()).toEqual([
      'com.apple.security.automation.apple-events=true',
      'com.apple.security.personal-information.addressbook=true',
    ]);
  });

  it('no comment in the entitlements file can be mistaken for a key', () => {
    const comments = read(APP_ENTITLEMENTS).match(/<!--[\s\S]*?-->/g) ?? [];
    for (const c of comments) expect(c).not.toMatch(/<key>|<true\/>|<false\/>/);
  });
});
