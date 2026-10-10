/**
 * v2 S5b: tools/swift/dmg.sh, run for real against stub tools.
 *
 * NO KEYCHAIN IS TOUCHED AND NO IMAGE IS MADE. `hdiutil`, `codesign` and
 * `security` are the stubs in fixtures/swift/mini-app/stubs, first on PATH
 * for the one process each row starts. The hdiutil stub writes the "image"
 * as a text manifest of what it would hold, so a row can read back the
 * volume name, the format and every entry. The real image is the release
 * workflow's `dmg-swift` step, signed with the same leaf as the app.
 *
 * What these rows pin: the volume is named WeMessage and holds the app and
 * an Applications symlink and nothing else (D-UI-181); the image is
 * verified, then signed with the 40-hex leaf, then verified again, and its
 * requirement must name that leaf; the exit codes. Every 40-hex value is
 * built at runtime, as the arch sweep requires.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const DMG = join(repoRoot, 'tools/swift/dmg.sh');
const STUBS = join(repoRoot, 'fixtures/swift/mini-app/stubs');

/** Each row starts bash a handful of times; a loaded runner is slow. */
const SLOW = { timeout: 60_000 };

const LEAF = 'ab12'.repeat(10);
const OTHER = 'cd34'.repeat(10);

let work = '';
let app = '';
let out = '';
let state = '';

beforeEach(() => {
  // Real path: dmg.sh resolves --app and --out with `pwd -P`, and the
  // codesign stub keys its state by the path it is handed.
  work = realpathSync(mkdtempSync(join(tmpdir(), 'wm-dmg-')));
  app = join(work, 'WeMessage.app');
  out = join(work, 'out', 'WeMessage-1.2.3-arm64.dmg');
  state = join(work, 'state');
  mkdirSync(state);
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(app, 'Contents', 'Info.plist'), '<plist/>\n');
  writeFileSync(join(app, 'Contents', 'MacOS', 'WeMessage'), 'exe\n');
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(args: readonly string[], env: Record<string, string> = {}): Run {
  const r = spawnSync('bash', [DMG, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${STUBS}:${process.env.PATH ?? ''}`,
      FAKE_CODESIGN_STATE: state,
      FAKE_SECURITY_IDENTITY: LEAF.toUpperCase(),
      ...env,
    },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const dmg = (env: Record<string, string> = {}): Run =>
  run(['--app', app, '--out', out, '--identity', LEAF], env);

const lines = (file: string): string[] =>
  existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : [];

const codesignCalls = (): string[] => lines(join(state, 'log'));
const hdiutilCalls = (): string[] => lines(join(state, 'hdiutil.log'));

describe('v2 S5b dmg.sh: the image', SLOW, () => {
  it('is named WeMessage, UDZO, and holds the app and an Applications symlink only', () => {
    expect(dmg().status).toBe(0);
    // The stub appends one byte when it signs; drop it to read the manifest.
    const manifest = readFileSync(out, 'utf8').replace(/S$/, '').trim();
    const [head, ...entries] = manifest.split('\n');
    expect(head).toBe('fake-dmg volname=WeMessage format=UDZO');
    const top = entries.filter((e) => !e.split(' -> ')[0]?.includes('/'));
    expect(top).toEqual(['Applications -> /Applications', 'WeMessage.app']);
    expect(entries).toContain('WeMessage.app/Contents/MacOS/WeMessage');
  });

  it('hdiutil only: create, then verify, and nothing else', () => {
    expect(dmg().status).toBe(0);
    const calls = hdiutilCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(
      /^create -volname WeMessage -srcfolder \S+ -ov -format UDZO /,
    );
    expect(calls[0]?.endsWith(` ${out}`)).toBe(true);
    expect(calls[1]).toBe(`verify ${out}`);
  });

  it('the image is signed with the leaf, after it is built, then verified', () => {
    expect(dmg().status).toBe(0);
    expect(codesignCalls()).toEqual([
      `--force --timestamp=none --sign ${LEAF} ${out}`,
      `--verify --verbose=2 ${out}`,
      `-d -r- ${out}`,
    ]);
  });

  it('reports the image and the leaf on stdout', () => {
    const r = dmg();
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(
      `dmg.sh: ${out}, signed and verified with ${LEAF}`,
    );
  });

  it('leaves no staging folder behind', () => {
    expect(dmg().status).toBe(0);
    const src = /-srcfolder (\S+)/.exec(hdiutilCalls()[0] ?? '')?.[1] ?? '';
    expect(src).not.toBe('');
    expect(existsSync(src)).toBe(false);
  });
});

describe('v2 S5b dmg.sh: the argument contract (exit 2)', SLOW, () => {
  const cases: readonly [string, readonly string[]][] = [
    ['no arguments', []],
    ['no --identity', ['--app', '@app', '--out', '@out']],
    ['no --out', ['--app', '@app', '--identity', LEAF]],
    ['no --app', ['--out', '@out', '--identity', LEAF]],
    [
      'an identity by common name',
      ['--app', '@app', '--out', '@out', '--identity', 'WeMessage Throwaway'],
    ],
    [
      'a 39-hex identity',
      ['--app', '@app', '--out', '@out', '--identity', LEAF.slice(1)],
    ],
    [
      'an output that is not a .dmg',
      ['--app', '@app', '--out', '@work/x.zip', '--identity', LEAF],
    ],
    [
      'an app that is not a bundle',
      ['--app', '@work', '--out', '@out', '--identity', LEAF],
    ],
    [
      'an unknown flag',
      ['--app', '@app', '--out', '@out', '--identity', LEAF, '--window'],
    ],
  ];
  for (const [what, args] of cases)
    it(`${what} exits 2 and builds nothing`, () => {
      const r = run(
        args.map((a) =>
          a.replace('@app', app).replace('@out', out).replace('@work', work),
        ),
      );
      expect([what, r.status]).toEqual([what, 2]);
      expect(hdiutilCalls()).toEqual([]);
      expect(codesignCalls()).toEqual([]);
    });
});

describe('v2 S5b dmg.sh: the refusals', SLOW, () => {
  it('another identity in the search list: exit 3, nothing built', () => {
    const r = dmg({ FAKE_SECURITY_IDENTITY: OTHER.toUpperCase() });
    expect(r.status).toBe(3);
    expect(hdiutilCalls()).toEqual([]);
  });

  it('hdiutil create fails: exit 4, nothing signed', () => {
    const r = dmg({ FAKE_HDIUTIL_FAIL: 'create' });
    expect(r.status).toBe(4);
    expect(codesignCalls()).toEqual([]);
  });

  it('hdiutil verify fails: exit 4, nothing signed', () => {
    const r = dmg({ FAKE_HDIUTIL_FAIL: 'verify' });
    expect(r.status).toBe(4);
    expect(codesignCalls()).toEqual([]);
  });

  it('codesign fails on the image: exit 4', () => {
    const r = dmg({ FAKE_CODESIGN_FAIL: 'WeMessage-1.2.3-arm64.dmg' });
    expect(r.status).toBe(4);
  });

  it('the image changes after it is signed: exit 5', () => {
    const r = dmg({ FAKE_CODESIGN_TAMPER: 'WeMessage-1.2.3-arm64.dmg' });
    expect(r.status).toBe(5);
    expect(r.stderr).toContain('does not verify');
  });

  it('the image comes back signed by another leaf: exit 5', () => {
    const r = dmg({ FAKE_CODESIGN_SIGNED_AS: OTHER });
    expect(r.status).toBe(5);
    expect(r.stderr).toContain(`signed by ${OTHER.toUpperCase()}`);
  });
});
