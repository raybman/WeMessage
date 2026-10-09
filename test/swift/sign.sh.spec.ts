/**
 * v2 S5a: tools/swift/sign.sh, and the identity half of
 * tools/swift/verify-bundle.sh, run for real against a miniature app.
 *
 * NO KEYCHAIN IS TOUCHED. `codesign`, `security` and `spctl` are the stubs in
 * fixtures/swift/mini-app/stubs, put first on PATH for the one process each
 * row starts. The stubs sign nothing: they log every call, and keep enough
 * state per target to answer the questions verify-bundle.sh asks. Real
 * signing, with a throwaway identity minted on the runner, is the
 * release.yml `pack-swift` job; these rows pin everything that does not need
 * a certificate: the argument contract, the exit codes, the order, the
 * flags, the identifiers, the entitlements, and that the verifier reads all
 * of it back.
 *
 * THE APP. fixtures/swift/mini-app/WeMessage.app holds the text files of the
 * bundle layout. What the tree cannot hold is written per test into a
 * temporary copy: Info.plist and daemon/ABI.json (their versions follow
 * package.json and node.lock.json, which move every release), the icon
 * (any tracked .icns joins the raster allowlist the s9 sweep holds), the
 * better-sqlite3 files (any `node_modules/` path is gitignored) and the three
 * Mach-Os (a Mach-O header is raw bytes, and no tracked text file carries
 * control bytes). Every 40-hex value is built at runtime for the same
 * reason the arch sweep bans them in tracked text.
 */
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const SIGN = join(repoRoot, 'tools/swift/sign.sh');
const VERIFY = join(repoRoot, 'tools/swift/verify-bundle.sh');
const FIXTURE = join(repoRoot, 'fixtures/swift/mini-app');
const RES = join(repoRoot, 'apps/mac/Resources');

const DARWIN = process.platform === 'darwin';

/** Each row starts bash two to five times; a loaded runner is slow. */
const SLOW = { timeout: 60_000 };

const LEAF = 'ab12'.repeat(10);
const OTHER = 'cd34'.repeat(10);

const ADDON =
  'Contents/Resources/daemon/node_modules/better-sqlite3/prebuilds/darwin-arm64.node';
const NODE = 'Contents/Resources/daemon/node';
const EXE = 'Contents/MacOS/WeMessage';

/** A 64-bit little-endian Mach-O header, then padding. */
const MACHO = Buffer.from([
  0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
]);

const json = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(repoRoot, rel), 'utf8')) as Record<
    string,
    unknown
  >;

let work = '';
let app = '';
let state = '';

function put(rel: string, body: string | Buffer, mode = 0o644): void {
  const p = join(app, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
  chmodSync(p, mode);
}

beforeEach(() => {
  // Real path: both scripts resolve --app with `pwd -P`, and the stub keys
  // its state by the path it is handed.
  work = realpathSync(mkdtempSync(join(tmpdir(), 'wm-sign-')));
  app = join(work, 'WeMessage.app');
  state = join(work, 'state');
  mkdirSync(state);
  cpSync(join(FIXTURE, 'WeMessage.app'), app, { recursive: true });
  const version = String(json('package.json').version);
  const pinned = String(json('tools/swift/node.lock.json').version);
  put(
    'Contents/Info.plist',
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      '<key>CFBundleIdentifier</key><string>sh.wemessage.gateway</string>',
      '<key>CFBundleExecutable</key><string>WeMessage</string>',
      `<key>CFBundleShortVersionString</key><string>${version}</string>`,
      `<key>CFBundleVersion</key><string>${version}</string>`,
      '</dict></plist>',
      '',
    ].join('\n'),
  );
  put(
    'Contents/Resources/daemon/ABI.json',
    `${JSON.stringify({ runtime: 'node', version: pinned, abi: 137 })}\n`,
  );
  // Written, not tracked: an .icns in the tree is a raster to the s9 sweep.
  put('Contents/Resources/AppIcon.icns', 'not an icon\n');
  const sqlite = 'Contents/Resources/daemon/node_modules/better-sqlite3';
  put(`${sqlite}/package.json`, '{"name":"better-sqlite3"}\n');
  put(`${sqlite}/lib/index.js`, '// fixture\n');
  put(ADDON, MACHO);
  put(NODE, MACHO, 0o755);
  put(EXE, MACHO, 0o755);
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(
  script: string,
  args: readonly string[],
  env: Record<string, string> = {},
): Run {
  const r = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(FIXTURE, 'stubs')}:${process.env.PATH ?? ''}`,
      FAKE_CODESIGN_STATE: state,
      FAKE_SECURITY_IDENTITY: LEAF.toUpperCase(),
      ...env,
    },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const sign = (env: Record<string, string> = {}): Run =>
  run(SIGN, ['--app', app, '--identity', LEAF], env);

/** The codesign calls that signed something, in order. */
function signCalls(): string[] {
  const log = join(state, 'log');
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((l) => l.includes(' --sign '));
}

describe('v2 S5a sign.sh: the argument contract (exit 2)', SLOW, () => {
  const cases: readonly [string, readonly string[]][] = [
    ['no arguments', []],
    ['no --identity', ['--app', '@app']],
    ['no --app', ['--identity', LEAF]],
    [
      'an identity by common name',
      ['--app', '@app', '--identity', 'WeMessage Throwaway'],
    ],
    ['a 39-hex identity', ['--app', '@app', '--identity', LEAF.slice(1)]],
    ['a 41-hex identity', ['--app', '@app', '--identity', `${LEAF}a`]],
    ['the ad-hoc identity', ['--app', '@app', '--identity', '-']],
    ['an unknown flag', ['--app', '@app', '--identity', LEAF, '--deep']],
    [
      'an app that is not a directory',
      ['--app', '@app/nope', '--identity', LEAF],
    ],
  ];
  for (const [what, args] of cases)
    it(`${what} exits 2 and signs nothing`, () => {
      const r = run(
        SIGN,
        args.map((a) => a.replace('@app', app)),
      );
      expect([what, r.status]).toEqual([what, 2]);
      expect(signCalls()).toEqual([]);
    });

  it('a tree missing the bundled node is not an assembled app: exit 2', () => {
    rmSync(join(app, NODE));
    const r = sign();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('missing Contents/Resources/daemon/node');
    expect(signCalls()).toEqual([]);
  });
});

describe('v2 S5a sign.sh: the identity must be valid (exit 3)', SLOW, () => {
  it('another identity in the search list: exit 3, nothing signed', () => {
    const r = sign({ FAKE_SECURITY_IDENTITY: OTHER.toUpperCase() });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain(`no valid code-signing identity ${LEAF}`);
    expect(signCalls()).toEqual([]);
  });

  it('no valid identity at all: exit 3', () => {
    expect(sign({ FAKE_SECURITY_IDENTITY: '' }).status).toBe(3);
  });

  it('asks the keychain one read-only question and nothing else', () => {
    expect(sign().status).toBe(0);
    expect(
      readFileSync(join(state, 'security.log'), 'utf8').trim().split('\n'),
    ).toEqual(['find-identity -v -p codesigning']);
  });
});

describe(
  'v2 S5a sign.sh: no unsigned Mach-O outside the set (exit 5)',
  SLOW,
  () => {
    const strays: readonly [string, number[]][] = [
      ['a 64-bit addon', [0xcf, 0xfa, 0xed, 0xfe]],
      ['a big-endian 64-bit binary', [0xfe, 0xed, 0xfa, 0xcf]],
      ['a 32-bit binary', [0xce, 0xfa, 0xed, 0xfe]],
      ['a universal binary', [0xca, 0xfe, 0xba, 0xbe]],
    ];
    for (const [what, magic] of strays)
      it(`${what}, without the exec bit, exits 5 before anything is signed`, () => {
        const rel =
          'Contents/Resources/daemon/node_modules/better-sqlite3/build/Release/stray.node';
        put(rel, Buffer.from([...magic, 0, 0, 0, 0]));
        const r = sign();
        expect([what, r.status]).toEqual([what, 5]);
        expect(r.stderr).toContain(
          `unsigned Mach-O outside the signed set: ${rel}`,
        );
        expect(signCalls()).toEqual([]);
      });

    it('a text file that merely starts with the letters of a magic is not a Mach-O', () => {
      put('Contents/Resources/notes.txt', 'cffaedfe is a magic number\n');
      expect(sign().status).toBe(0);
    });
  },
);

describe('v2 S5a sign.sh: codesign failing is exit 4', SLOW, () => {
  it('a failure on the node stops the run there', () => {
    const r = sign({ FAKE_CODESIGN_FAIL: 'node' });
    expect(r.status).toBe(4);
    expect(r.stderr).toContain(`codesign failed on ${NODE}`);
    // The addon was signed, the failing node was attempted, and nothing after.
    expect(signCalls().map((l) => l.split(' ').at(-1))).toEqual([
      join(app, ADDON),
      join(app, NODE),
    ]);
  });
});

describe('v2 S5a sign.sh: inside-out, hardened, one identity', SLOW, () => {
  it('signs the addon, the node, the host, then the app, in that order (tooth 2)', () => {
    const r = sign();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`signed addon, node, host and app with ${LEAF}`);
    expect(signCalls().map((l) => l.split(' ').at(-1))).toEqual([
      join(app, ADDON),
      join(app, NODE),
      join(app, EXE),
      app,
    ]);
  });

  it('every call is --force --options runtime --timestamp=none --sign <leaf> (tooth 1)', () => {
    expect(sign().status).toBe(0);
    const calls = signCalls();
    expect(calls).toHaveLength(4);
    for (const call of calls)
      expect(call).toMatch(
        new RegExp(
          `^--force --options runtime --timestamp=none --sign ${LEAF} --identifier `,
        ),
      );
  });

  it('each target gets its identifier and entitlements', () => {
    expect(sign().status).toBe(0);
    const rest = signCalls().map((l) =>
      l
        .replace(/^.*? --identifier /, '')
        .replace(/ \S+$/, '')
        .replace(RES, '<res>'),
    );
    expect(rest).toEqual([
      'sh.wemessage.gateway.better-sqlite3',
      'sh.wemessage.gateway.node --entitlements <res>/node.entitlements',
      'sh.wemessage.gateway --entitlements <res>/WeMessage.entitlements',
      'sh.wemessage.gateway --entitlements <res>/WeMessage.entitlements',
    ]);
  });

  it('accepts the identity in upper case and passes it through as given', () => {
    const r = run(SIGN, ['--app', app, '--identity', LEAF.toUpperCase()]);
    expect(r.status).toBe(0);
    expect(signCalls()[0]).toContain(`--sign ${LEAF.toUpperCase()} `);
  });
});

// verify-bundle.sh reads every plist and JSON value through plutil, a macOS
// binary, so this block runs on the macOS lane (ci-macos runs `pnpm test`)
// and stands down on Linux. The sign.sh rows above run on both.
describe.skipIf(!DARWIN)(
  'v2 S5a verify-bundle.sh: the identity half reads the signature back',
  SLOW,
  () => {
    it('the fixture passes the structure half unsigned (it is a real layout)', () => {
      const r = run(VERIFY, ['--app', app]);
      expect([r.status, r.stderr]).toEqual([0, '']);
      expect(r.stdout).toContain('structure ok');
    });

    it('an unsigned app fails --expect-leaf', () => {
      const r = run(VERIFY, ['--app', app, '--expect-leaf', LEAF]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(
        'codesign --verify --deep --strict rejects the app',
      );
    });

    it('a signed app passes with its own leaf, in either case, and with any', () => {
      expect(sign().status).toBe(0);
      for (const leaf of [LEAF, LEAF.toUpperCase(), 'any']) {
        const r = run(VERIFY, ['--app', app, '--expect-leaf', leaf]);
        expect([leaf, r.status, r.stderr]).toEqual([leaf, 0, '']);
        expect(r.stdout).toContain('structure and identity ok');
        // spctl's rejection is recorded, never fatal.
        expect(r.stdout).toContain('spctl (recorded, never fatal):');
        expect(r.stdout).toContain('rejected');
      }
    });

    it('another leaf is refused', () => {
      expect(sign().status).toBe(0);
      const r = run(VERIFY, ['--app', app, '--expect-leaf', OTHER]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`signed with leaf ${LEAF}, expected ${OTHER}`);
    });

    it('a common name, or a short hash, is a usage error', () => {
      for (const bad of ['WeMessage Throwaway', LEAF.slice(2)])
        expect(run(VERIFY, ['--app', app, '--expect-leaf', bad]).status).toBe(
          2,
        );
    });

    it('nested code signed after the app breaks the seal', () => {
      expect(sign().status).toBe(0);
      appendFileSync(join(app, NODE), 'x');
      const r = run(VERIFY, ['--app', app, '--expect-leaf', LEAF]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('rejects the app');
    });

    it('two leaves across the four objects are refused', () => {
      expect(sign().status).toBe(0);
      // Re-sign the node with another identity, then reseal the app with the
      // first, so only the leaf comparison can catch it.
      const resign = (target: string, id: string, extra: string[]): void => {
        const r = spawnSync(
          'codesign',
          [
            '--force',
            '--options',
            'runtime',
            '--timestamp=none',
            '--sign',
            id,
            ...extra,
            target,
          ],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: `${join(FIXTURE, 'stubs')}:${process.env.PATH ?? ''}`,
              FAKE_CODESIGN_STATE: state,
            },
          },
        );
        expect(r.status).toBe(0);
      };
      resign(join(app, NODE), OTHER, [
        '--identifier',
        'sh.wemessage.gateway.node',
        '--entitlements',
        join(RES, 'node.entitlements'),
      ]);
      resign(app, LEAF, [
        '--identifier',
        'sh.wemessage.gateway',
        '--entitlements',
        join(RES, 'WeMessage.entitlements'),
      ]);
      const r = run(VERIFY, ['--app', app, '--expect-leaf', 'any']);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(
        'do not share one certificate leaf (2 distinct)',
      );
    });

    it('an object signed without the hardened runtime is refused', () => {
      expect(sign().status).toBe(0);
      const env = {
        ...process.env,
        PATH: `${join(FIXTURE, 'stubs')}:${process.env.PATH ?? ''}`,
        FAKE_CODESIGN_STATE: state,
      };
      for (const [target, extra] of [
        [
          join(app, EXE),
          ['--entitlements', join(RES, 'WeMessage.entitlements')],
        ],
        [app, ['--entitlements', join(RES, 'WeMessage.entitlements')]],
      ] as const)
        expect(
          spawnSync(
            'codesign',
            [
              '--force',
              '--timestamp=none',
              '--sign',
              LEAF,
              '--identifier',
              'sh.wemessage.gateway',
              ...extra,
              target,
            ],
            { env },
          ).status,
        ).toBe(0);
      const r = run(VERIFY, ['--app', app, '--expect-leaf', LEAF]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(
        'Contents/MacOS/WeMessage is not signed with the hardened runtime',
      );
      expect(r.stderr).toContain(
        'WeMessage.app is not signed with the hardened runtime',
      );
    });

    it('the node carrying the app entitlements is refused', () => {
      expect(sign().status).toBe(0);
      const env = {
        ...process.env,
        PATH: `${join(FIXTURE, 'stubs')}:${process.env.PATH ?? ''}`,
        FAKE_CODESIGN_STATE: state,
      };
      for (const [target, id] of [
        [join(app, NODE), 'sh.wemessage.gateway.node'],
        [app, 'sh.wemessage.gateway'],
      ] as const)
        expect(
          spawnSync(
            'codesign',
            [
              '--force',
              '--options',
              'runtime',
              '--timestamp=none',
              '--sign',
              LEAF,
              '--identifier',
              id,
              '--entitlements',
              join(RES, 'WeMessage.entitlements'),
              target,
            ],
            { env },
          ).status,
        ).toBe(0);
      const r = run(VERIFY, ['--app', app, '--expect-leaf', LEAF]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(
        'Contents/Resources/daemon/node carries entitlements',
      );
    });
  },
);
