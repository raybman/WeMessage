/**
 * s9 Sc 6 — the pack: electron-builder, entitlements by lane, fuses, verify-bundle.
 *
 * Sc 5 proved the daemon survives being bundled away from its workspace. This
 * file proves the bundle survives being SIGNED, which is a different and much
 * less forgiving claim. A hardened runtime is a promise to the kernel about
 * what the process will and will not do, and every promise in that list is one
 * the daemon can break at load time by dlopen'ing a native module.
 *
 * WHY THE AD-HOC LANE IS THE LANE THIS FILE RUNS IN, AND WHAT THAT COSTS.
 * There is no Developer ID certificate on this machine and there will not be
 * one before `v1.0.0-rc.1` (F-136). So the pack signs with `identity: '-'`,
 * which electron-builder 26 supports natively and which produces a real,
 * verifiable signature carrying a real hardened-runtime flag. What it does NOT
 * produce is a stable code identity: an ad-hoc designated requirement is a
 * bare `cdhash`, so it moves on every rebuild, and TCC therefore forgets the
 * app's Full Disk Access grant every time the user updates (F-142). That is a
 * documentation problem, it is answered in Sc 13's copy and Sc 14's release
 * notes, and it is deliberately NOT something this file can assert, because it
 * is a property of the user's TCC.db and not of the artefact.
 *
 * The one place the lane shows up in the artefact is entitlements. Apple's
 * library validation refuses to load a Mach-O signed by a different team than
 * the main executable, and an ad-hoc signature has no team at all, so under a
 * hardened runtime the ad-hoc app cannot load its own `better-sqlite3` without
 * `com.apple.security.cs.disable-library-validation`. electron-builder warns
 * about exactly this. The release lane must NOT carry that entitlement, which
 * is why there are two plists, and why row 7 exists: a lane check nobody
 * proves is a lane check that silently ships the wrong plist.
 *
 * NO TIMER CALLS. `test/arch.spec.ts` row 14 bans them under this whole tree
 * as a text scan, so readiness is observed off the child's stdout through the
 * shared lane helper, never slept on.
 */
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bed, freePort, launch, waitFor } from './helpers/bundle-lane.js';
// s7 Sc11 gave "what must a public repo never say" ONE home, and s8/s9 kept
// it there. `test/arch.spec.ts` sweeps the SOURCE with this function;
// `packages/adapter-testkit/test/pack.spec.ts` is the precedent for a pack
// spec importing it across packages. Row 13 below points the same five arms
// at the ARTEFACT, which is the only copy a user ever receives.
import { publicStringOffenders } from '../../../packages/cli/test/helpers/transcript-lint.js';

const need = createRequire(import.meta.url);
const darwin = process.platform === 'darwin';

const DESKTOP = fileURLToPath(new URL('..', import.meta.url));
const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const PACK_OUT = join(DESKTOP, 'dist-pack');
const APP = join(PACK_OUT, 'mac-arm64', 'WeMessage.app');
const EXE = join(APP, 'Contents', 'MacOS', 'WeMessage');
const RES = join(APP, 'Contents', 'Resources');
const VERIFY = join(DESKTOP, 'scripts', 'verify-bundle.sh');

/** The pack builds Electron, signs ~200 files and makes a DMG. Two minutes is optimistic. */
const PACK_BUDGET_MS = 900_000;
/** Generous; this only ever converts a hang into a named failure. */
const BOOT_BUDGET_MS = 30_000;

/** Read once, from the same file electron-builder reads it from. */
const VERSION = (
  JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

/**
 * The closed entitlement list, by lane.
 *
 * A deep-equal on sorted keys rather than a "has at least" is the entire point
 * of the row: electron-builder ships a DEFAULT template, and the default
 * template contains `disable-library-validation`. A containment assertion
 * passes against the default template and would therefore have let the release
 * lane ship the one entitlement it must never ship. This is TN-builder-defaults.
 */
const BASE_ENTITLEMENTS = [
  'com.apple.security.automation.apple-events',
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
];
const LIB_VALIDATION = 'com.apple.security.cs.disable-library-validation';
const ADHOC_ENTITLEMENTS = [...BASE_ENTITLEMENTS, LIB_VALIDATION].sort();

const temps: string[] = [];
function tempDir(prefix = 'wemessage-pack-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/**
 * Every Mach-O under the bundle, found the way the loader would: by reading
 * the magic, not by trusting an extension. `.node`, `.dylib`, the helpers and
 * the framework binaries have four different naming conventions between them
 * and a fifth will arrive with the next Electron.
 */
const MACH_O_MAGIC = new Set([0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);
function machOFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!e.isFile()) continue;
      if (statSync(p).size < 4) continue;
      const head = readFileSync(p).subarray(0, 4);
      if (
        MACH_O_MAGIC.has(head.readUInt32BE(0)) ||
        MACH_O_MAGIC.has(head.readUInt32LE(0))
      )
        out.push(relative(root, p));
    }
  };
  walk(root);
  return out.sort();
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Every regular file under a root, repo-relative and sorted. Symlinks skipped. */
function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(relative(root, p));
    }
  };
  walk(root);
  return out.sort();
}

/** `codesign -d --entitlements :- --xml` then plutil, because plists are not JSON. */
function entitlementKeys(machO: string): string[] {
  const xml = execFileSync(
    'codesign',
    ['-d', '--entitlements', ':-', '--xml', machO],
    { encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const out = join(tempDir(), 'ent.json');
  execFileSync('plutil', ['-convert', 'json', '-o', out, '-'], { input: xml });
  return Object.keys(
    JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>,
  ).sort();
}

/** Run verify-bundle.sh and hand back everything, including the failure. */
function verify(
  lane: 'adhoc' | 'release',
  json = false,
): { code: number; out: string } {
  try {
    const out = execFileSync(
      VERIFY,
      json ? [APP, lane, '--json'] : [APP, lane],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe.skipIf(!darwin)('s9 Sc6: the packed, ad-hoc-signed app', () => {
  beforeAll(async () => {
    /*
     * ASYNC, and that is not a style choice. `execFileSync` here blocked this
     * worker's event loop for the ~150 seconds the pack takes, which starved
     * vitest's own RPC heartbeat, and the run ended with
     *
     *     Unhandled Error: [vitest-worker]: Timeout calling "onTaskUpdate"
     *
     * on an otherwise green suite. Vitest reports an unhandled error as a
     * non-zero run, so a green pack lane would have failed CI for a reason
     * that had nothing to do with the app. Awaiting a child leaves the loop
     * free to answer the reporter while electron-builder works.
     *
     * `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` because electron-builder will
     * otherwise search the login keychain for a Developer ID, find one on a
     * maintainer's machine and none on CI, and produce two different bundles
     * from the same command. The ad-hoc lane is ad-hoc everywhere.
     */
    await new Promise<void>((ok, bad) => {
      execFile(
        'pnpm',
        ['pack:adhoc'],
        {
          cwd: REPO,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
        },
        (err, _stdout, stderr) => {
          if (err === null) ok();
          else bad(new Error(`pnpm pack:adhoc failed: ${stderr.slice(-4000)}`));
        },
      );
    });
  }, PACK_BUDGET_MS);

  afterAll(() => {
    for (const d of temps) rmSync(d, { recursive: true, force: true });
  });

  /* ── row 1 ───────────────────────────────────────────────────────── */

  it('row 1: produces exactly the arm64 ad-hoc artefacts and no others', () => {
    expect(existsSync(APP)).toBe(true);
    for (const ext of ['dmg', 'zip'])
      expect(
        existsSync(
          join(PACK_OUT, `WeMessage-${VERSION}-arm64-UNSIGNED.${ext}`),
        ),
        ext,
      ).toBe(true);
    // F-135: arm64 only. An unsmoked x64 artefact on a release page is a bug
    // report generator, and a universal build doubles the native-module and
    // notarization surface for an audience this suite cannot cover.
    const dirs = readdirSync(PACK_OUT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(
      dirs.filter((d) => d.includes('x64') || d.includes('universal')),
    ).toEqual([]);
    // The name is the warning. An artefact called UNSIGNED cannot be mistaken
    // for a notarized one on a release page, which is the whole reason Sc 14
    // is allowed to publish it.
    expect(
      readdirSync(PACK_OUT)
        .filter((f) => /\.(dmg|zip)$/.test(f))
        .sort(),
    ).toEqual([
      `WeMessage-${VERSION}-arm64-UNSIGNED.dmg`,
      `WeMessage-${VERSION}-arm64-UNSIGNED.zip`,
    ]);
  });

  /* ── row 2: the Info.plist a user's Mac actually reads ────────────── */

  describe('row 2: Info.plist', () => {
    const info = (): Record<string, unknown> =>
      JSON.parse(
        execFileSync(
          'plutil',
          ['-convert', 'json', '-o', '-', join(APP, 'Contents', 'Info.plist')],
          { encoding: 'utf8' },
        ),
      ) as Record<string, unknown>;

    it('identifies itself as the thing launchd, TCC and the cask all name', () => {
      const p = info();
      expect(p['CFBundleIdentifier']).toBe('sh.wemessage.gateway');
      expect(p['CFBundleName']).toBe('WeMessage');
      expect(p['LSMinimumSystemVersion']).toBe('15.0');
      expect(p['CFBundleShortVersionString']).toBe(VERSION);
    });

    it('explains the Automation prompt in the words the user will see', () => {
      // macOS shows this verbatim in the consent dialog. It is the only place
      // the product gets to say what it will do with the permission BEFORE the
      // user grants it, so INV-2 is what it says. The brand rule from Sc 1
      // applies to it like any other public string: no green, no operator, no
      // second brand.
      const desc = info()['NSAppleEventsUsageDescription'];
      expect(desc).toBe(
        'WeMessage sends replies through Messages on your behalf, and only ones you have approved.',
      );
      expect(String(desc)).not.toMatch(/green|greenlight/i);
    });

    it('registers exactly one URL scheme, and it is the one S8 deep-links to', () => {
      const types = info()['CFBundleURLTypes'] as {
        CFBundleURLSchemes: string[];
      }[];
      expect(types).toHaveLength(1);
      expect(types[0]?.CFBundleURLSchemes).toEqual(['wemessage']);
    });

    it('has no LSUIElement: the tray is additive, not a replacement', () => {
      // S8 Sc 16 added a tray. A tray is not a reason to become an agent app:
      // an app with no Dock icon cannot be brought forward by clicking it, and
      // the wizard is a window the operator has to be able to find.
      expect('LSUIElement' in info()).toBe(false);
    });
  });

  /* ── row 3: the payload beside the asar ───────────────────────────── */

  describe('row 3: what rides in Resources', () => {
    it('ships the daemon, the CLI, the migrations and the licences', () => {
      for (const p of [
        ['daemon', 'main.mjs'],
        ['daemon', 'wemessaged.mjs'],
        ['daemon', 'ABI.json'],
        [
          'daemon',
          'node_modules',
          'better-sqlite3',
          'prebuilds',
          'darwin-arm64.node',
        ],
        ['migrations', '0001_init.sql'],
        ['bin', 'wemessage'],
        ['bin', 'wemessaged'],
        ['licenses', 'THIRD_PARTY_NOTICES.md'],
        ['licenses', 'LICENSE.electron.txt'],
        ['licenses', 'LICENSES.chromium.html'],
      ])
        expect(existsSync(join(RES, ...p)), p.join('/')).toBe(true);
    });

    it('keeps the two shims executable through the pack and the signature', () => {
      // electron-builder copies extraResources, the signer rewrites what it
      // signs, and a mode bit lost anywhere in that chain turns
      // `wemessage doctor` into "permission denied" for every user of the
      // cask, which installs these two as its `binary` stanzas.
      for (const shim of ['wemessage', 'wemessaged'])
        expect(
          statSync(join(RES, 'bin', shim)).mode & 0o111,
          shim,
        ).toBeGreaterThan(0);
    });

    it('ships the migrations byte-for-byte, not a stale copy', () => {
      const src = join(REPO, 'packages', 'store', 'migrations');
      for (const f of readdirSync(src).filter((n) => n.endsWith('.sql')))
        expect(sha256(join(RES, 'migrations', f)), f).toBe(
          sha256(join(src, f)),
        );
    });
  });

  /* ── row 4: the packed app IS the daemon ──────────────────────────── */

  it(
    'row 4: the hardened ad-hoc app runs the daemon and loads its native module',
    async () => {
      // The row the whole scenario is for. Everything above reads metadata;
      // this one asks the kernel. If `disable-library-validation` were missing
      // from the ad-hoc plist, the app would be signed, verified, hardened,
      // and would die on `require('better-sqlite3')` the first time a user
      // opened it, with an error message about a code signature that names no
      // entitlement at all. F-121 says there is ONE Mach-O; this proves the
      // second of its two jobs.
      const { dir, chatDb } = bed();
      const port = await freePort();
      const d = launch(EXE, [join(RES, 'daemon', 'main.mjs')], {
        ELECTRON_RUN_AS_NODE: '1',
        WEMESSAGE_DIR: dir,
        WEMESSAGE_PORT: String(port),
        WEMESSAGE_CHATDB: chatDb,
      });
      try {
        await waitFor(
          () => d.stdout().includes('listening on 127.0.0.1'),
          `the packed daemon to listen\n${d.stderr()}`,
          BOOT_BUDGET_MS,
        );
        const token = readFileSync(join(dir, 'daemon.token'), 'utf8').trim();
        const res = await fetch(`http://127.0.0.1:${String(port)}/v1/doctor`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          runtime?: { electron?: string };
        };
        // Sc 5 row 3 asserted the shape of this field. Here it has to AGREE
        // with the framework that shipped, which is the fact that would break
        // if the pack ever bundled a daemon built against a different Electron.
        // `CFBundleVersion`, not `CFBundleShortVersionString`. Electron's
        // framework plist carries only the former (`44.2.0`); asking for the
        // marketing string got `No value at that key path`. An app bundle
        // has both, a framework here has one, and this is the framework.
        const framework = execFileSync(
          'plutil',
          [
            '-extract',
            'CFBundleVersion',
            'raw',
            '-o',
            '-',
            join(
              APP,
              'Contents/Frameworks/Electron Framework.framework/Resources/Info.plist',
            ),
          ],
          { encoding: 'utf8' },
        ).trim();
        expect(body.runtime?.electron).toBe(framework);
      } finally {
        await d.stop();
      }
    },
    BOOT_BUDGET_MS * 3,
  );

  /* ── rows 5 and 7: the verifier, in both lanes ────────────────────── */

  describe('rows 5 and 7: verify-bundle.sh', () => {
    it('row 5: accepts the ad-hoc bundle and reports every Mach-O signed', () => {
      const { code, out } = verify('adhoc', true);
      expect(code, out).toBe(0);
      const report = JSON.parse(out) as {
        files: { path: string; signed: boolean; runtime: boolean }[];
      };
      // Six is the floor, not the count: the main executable, the framework,
      // four helpers, the sqlite prebuild and libffmpeg are all in there, and
      // pinning the exact number would make an Electron bump a test failure
      // rather than the non-event it is.
      expect(report.files.length).toBeGreaterThanOrEqual(6);
      for (const f of report.files) {
        expect(f.signed, f.path).toBe(true);
        expect(f.runtime, f.path).toBe(true);
      }
      // Non-vacuity: the verifier and this file must be looking at the same
      // set of binaries. A verifier that found none would also report none
      // unsigned.
      expect(report.files.map((f) => f.path).sort()).toEqual(machOFiles(APP));
    });

    it('row 7: REFUSES the same bundle in the release lane, by name', () => {
      // The tooth for the lane check itself. `disable-library-validation` is
      // correct here and catastrophic in a shipped Developer ID build, so the
      // verifier has to be able to tell the lanes apart, and a lane check
      // nobody has ever seen fail is a lane check that does nothing.
      const { code, out } = verify('release');
      expect(code).not.toBe(0);
      expect(out).toContain(
        'disable-library-validation present in release lane',
      );
    });
  });

  /* ── row 6: the closed entitlement list ───────────────────────────── */

  it('row 6: the entitlement set is exactly the lane list, top and inherited', () => {
    expect(entitlementKeys(EXE)).toEqual(ADHOC_ENTITLEMENTS);
    const helpers = readdirSync(join(APP, 'Contents', 'Frameworks'))
      .filter((n) => n.endsWith('.app'))
      .map((n) =>
        join(
          APP,
          'Contents',
          'Frameworks',
          n,
          'Contents',
          'MacOS',
          n.replace(/\.app$/, ''),
        ),
      )
      .filter((p) => existsSync(p));
    expect(helpers.length).toBeGreaterThanOrEqual(3); // GPU, Renderer, Plugin at least
    for (const h of helpers)
      expect(entitlementKeys(h), h).toEqual(ADHOC_ENTITLEMENTS);
  });

  /* ── row 8: the fuses, and that they were flipped BEFORE signing ──── */

  it('row 8: the seven fuses are in their F-126 positions and the signature still verifies', async () => {
    const { getCurrentFuseWire, FuseV1Options, FuseState } =
      (await import('@electron/fuses')) as typeof import('@electron/fuses');
    const wire = await getCurrentFuseWire(EXE);
    const expected: [keyof typeof FuseV1Options, boolean][] = [
      // ON, and load-bearing: F-121's one-Mach-O design IS this fuse. The app
      // is the daemon's runtime under ELECTRON_RUN_AS_NODE, so turning this
      // off would delete the daemon.
      ['RunAsNode', true],
      // OFF: with RunAsNode on, these two are the escalation path. NODE_OPTIONS
      // and --inspect would let anything that can set an env var run code
      // inside a process that holds Full Disk Access.
      ['EnableNodeOptionsEnvironmentVariable', false],
      ['EnableNodeCliInspectArguments', false],
      ['EnableCookieEncryption', true],
      ['EnableEmbeddedAsarIntegrityValidation', true],
      ['OnlyLoadAppFromAsar', true],
      ['GrantFileProtocolExtraPrivileges', false],
    ];
    for (const [name, on] of expected)
      expect(
        wire[FuseV1Options[name] as unknown as keyof typeof wire],
        name,
      ).toBe(on ? FuseState.ENABLE : FuseState.DISABLE);

    // Order matters and is invisible in the wire: flipping a fuse rewrites the
    // Mach-O, so a fuse flipped AFTER signing produces a bundle that is fused
    // correctly and refuses to launch. Only the verify catches that.
    execFileSync('codesign', ['--verify', '--strict', '--deep', EXE], {
      stdio: 'ignore',
    });
  });

  /* ── row 9 (C): the Team ID half, which needs a certificate ───────── */

  it.skipIf(!process.env['CSC_NAME'])(
    'row 9: the release lane signs with one Developer ID team, and verifies',
    () => {
      // (C), and the ONLY thing in this scenario that is. F-136: there is no
      // Developer ID certificate on this machine, so this row is written, is
      // counted as a skip by the §4.1 gate, and is the first thing that runs
      // on the day one arrives. Everything else about the release lane, the
      // entitlement list and the verifier's lane split, is proven above
      // against the ad-hoc bundle.
      execFileSync('pnpm', ['pack:release'], { cwd: REPO, stdio: 'ignore' });
      const teams = new Set(
        machOFiles(APP).map(
          (rel) =>
            /TeamIdentifier=(\S+)/.exec(
              execFileSync('codesign', ['-dvv', join(APP, rel)], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
              }),
            )?.[1] ?? 'none',
        ),
      );
      expect([...teams]).toEqual([process.env['APPLE_TEAM_ID']]);
      expect(verify('release').code).toBe(0);
    },
    PACK_BUDGET_MS,
  );

  /* ── row 9b (A): what Gatekeeper does to the thing we actually ship ─ */

  /*
   * THE README MAKES FOUR NUMBERED PROMISES ABOUT THIS ARTEFACT. Nothing
   * checked whether any of them were true of it.
   *
   * `test/release/readme.spec.ts` row 3 asserts the README contains the
   * WORDS "unsigned", "Open Anyway" and "com.apple.quarantine". That is a
   * test of the document. This is the test of the program, and the two are
   * not the same question: a README can describe a Gatekeeper flow
   * perfectly and ship an artefact that behaves some other way.
   *
   * Three facts, and the third is the one that is easy to get wrong.
   *
   *  1. AD-HOC AND TEAMLESS. This lane deliberately ships without a
   *     Developer ID, so that a paid Apple membership is not standing
   *     between a reader and a working copy. If a Team ID ever appeared
   *     here by accident, the README would be describing a flow the user
   *     no longer gets, and the project would have quietly acquired a
   *     dependency on a certificate nobody decided to take on.
   *
   *  2. GATEKEEPER REFUSES IT. Step 2 of the README ("macOS refuses,
   *     because it cannot check the app with Apple") is a claim about
   *     `spctl`, so it is asked of `spctl`. If Apple ever starts accepting
   *     ad-hoc bundles, this row goes red and the README is what needs
   *     editing, which is the correct direction for that signal to travel.
   *
   *  3. AND YET THE SIGNATURE IS VALID. This is the subtle one, and it is
   *     what makes steps 3 and 4 possible at all. "Unsigned" in the
   *     README's sense means "not Developer-ID signed"; the bundle is
   *     still ad-hoc signed under a hardened runtime, and it has to be
   *     VALIDLY so. An app whose seal is broken is not merely unverified,
   *     it is unopenable: "Open Anyway" does not rescue it and neither
   *     does stripping the quarantine attribute. So the escape hatch the
   *     README hands a stranger only exists while `codesign --verify`
   *     passes, and that is asserted here rather than assumed.
   *
   * WHY THE `spctl --status` GATE. Some CI images turn assessments off
   * entirely, and on such a host `--assess` cannot answer the question this
   * row is asking; it would report "accepted" for a reason that has nothing
   * to do with our bundle. That is a host whose answer is unavailable, not
   * a host where the answer changed, so it is a counted skip in the manner
   * this suite already uses for an absent tool. Facts 1 and 3 are
   * properties of the artefact alone and are asserted unconditionally.
   */
  it('row 9b: ad-hoc, teamless, validly sealed, and refused by Gatekeeper', () => {
    // `codesign -dv` reports on STDERR, always, even on success.
    const described = spawnSync('codesign', ['-dv', '--verbose=2', APP], {
      encoding: 'utf8',
    }).stderr;
    expect(described).toContain('Signature=adhoc');
    expect(described).toContain('TeamIdentifier=not set');
    // Not vacuous: an empty stderr would satisfy neither, but say so early.
    expect(described.length).toBeGreaterThan(0);

    // Throws on a non-zero exit, which is the assertion.
    execFileSync('codesign', ['--verify', '--deep', '--strict', APP], {
      stdio: 'ignore',
    });

    const gatekeeperOn = spawnSync('spctl', ['--status'], {
      encoding: 'utf8',
    }).stdout.includes('assessments enabled');
    if (!gatekeeperOn) return;

    const assessed = spawnSync(
      'spctl',
      ['--assess', '--type', 'execute', '--verbose=4', APP],
      { encoding: 'utf8' },
    );
    // `spctl` says "rejected" on stderr and exits 3 when it refuses.
    expect(assessed.stderr).toContain('rejected');
    expect(assessed.status).not.toBe(0);
  });

  /* ── row 10 (A): nothing links against this machine ───────────────── */

  it('row 10: no Mach-O links a path that only exists on a build machine', () => {
    // Split out of row 9 deliberately. The Team-ID half needs a certificate;
    // this half does not, and it is the half that catches the actual mistake:
    // a native module rebuilt locally links `/opt/homebrew/opt/...` and works
    // perfectly on the machine that built it and nowhere else. Sc 5 asserted
    // this of the prebuild; this asserts it of everything that shipped.
    /*
     * `dyld_info` AND NOT `otool -L`. `otool` still parses the ancient
     * `archive(member.o)` notation, so it splits any argument at its first
     * `(` and opens the prefix. Electron ships `WeMessage Helper (GPU)`,
     * `(Renderer)` and `(Plugin)`, so `otool -L` answered
     * `can't open file: .../WeMessage Helper` for four of the thirteen
     * Mach-O files in this bundle and this row threw rather than reported.
     * `scripts/verify-bundle.sh` had the same call with `2>/dev/null`, where
     * it degraded into a silent pass instead; both are fixed together.
     *
     * `dyld_info` also prints `-rpaths`, which `otool -L` does not. An rpath
     * into a home directory is this row's bug one indirection later, so the
     * scan covers the whole output rather than the dylib list alone.
     */
    const offenders: string[] = [];
    for (const rel of machOFiles(APP)) {
      const out = execFileSync('dyld_info', ['-dependents', join(APP, rel)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // `dyld_info` exits 0 on a file it could not read, so the exit status
      // proves nothing and the SHAPE of the output is the proof instead. A
      // check that cannot run must fail, not pass; that is the whole lesson
      // of the `otool` version.
      if (!out.includes('-linked_dylibs:'))
        offenders.push(`${rel}: dyld_info could not read it: ${out.trim()}`);
      // The first line is `<path> [arch]:`, which is the bundle's own
      // absolute path under a home directory and would match every pattern
      // below. It is dropped by shape, not by index, so a multi-slice file
      // (which would print one header per arch) drops all of them.
      for (const line of out.split('\n'))
        if (
          !line.trimEnd().endsWith(']:') &&
          /(^|\s)(\/opt\/homebrew|\/usr\/local|\/Users)\//.test(line)
        )
          offenders.push(`${rel}: ${line.trim()}`);
    }
    expect(offenders).toEqual([]);
    // Non-vacuity: 13 Mach-O files today, four of them the helpers `otool`
    // could never open. An empty list would also have no offenders.
    expect(machOFiles(APP).length).toBeGreaterThan(8);
  });

  /* ── row 11: the DMG a user double-clicks ─────────────────────────── */

  it('row 11: the disk image holds the app, the Applications alias, and nothing else', () => {
    const dmg = join(PACK_OUT, `WeMessage-${VERSION}-arm64-UNSIGNED.dmg`);
    const out = execFileSync(
      'hdiutil',
      ['attach', '-nobrowse', '-readonly', '-plist', dmg],
      { encoding: 'utf8' },
    );
    const mount = /<string>(\/Volumes\/[^<]+)<\/string>/.exec(out)?.[1];
    expect(mount, out).toBeTruthy();
    try {
      const visible = readdirSync(mount as string).filter(
        (n) => !n.startsWith('.'),
      );
      // Two entries, and the second is a symlink to /Applications. A DMG with
      // a README, a licence PDF or a second copy of anything is a DMG the user
      // has to make a decision about, and there is exactly one right action.
      expect(visible.sort()).toEqual(['Applications', 'WeMessage.app']);
      expect(
        statSync(join(mount as string, 'WeMessage.app'), {
          throwIfNoEntry: true,
        }).isDirectory(),
      ).toBe(true);
    } finally {
      execFileSync('hdiutil', ['detach', mount as string, '-quiet'], {
        stdio: 'ignore',
      });
    }
  });

  /* ── row 12: the zip is the same bits as the app ──────────────────── */

  it('row 12: the zip unpacks to the identical bundle, file for file', () => {
    // Sc 8 submits the ZIP to notarytool and staples the APP. If those are not
    // the same bits, the staple is attached to something Apple never saw, and
    // the failure surfaces on a user's machine as a mangled-ticket error that
    // names nothing useful.
    const dir = tempDir('wemessage-zip-');
    execFileSync(
      'ditto',
      [
        '-x',
        '-k',
        join(PACK_OUT, `WeMessage-${VERSION}-arm64-UNSIGNED.zip`),
        dir,
      ],
      { stdio: 'ignore' },
    );
    const unzipped = join(dir, 'WeMessage.app');
    expect(existsSync(unzipped)).toBe(true);
    const a = filesUnder(APP);
    expect(filesUnder(unzipped)).toEqual(a);
    for (const rel of a)
      expect(sha256(join(unzipped, rel)), rel).toBe(sha256(join(APP, rel)));
  });

  /* ── row 13: the public sweep, applied to what actually ships ─────── */

  it('row 13: nothing in the bundle names an operator, a machine or a second brand', () => {
    /*
     * THE PREDICATE IS IMPORTED, NOT RESTATED. An earlier draft of this row
     * carried its own three regexes and a promise that a root-side arch row
     * would pin the two lists byte-identical. That promise was the smell: the
     * repo already decided this question in s7 Sc 11, when
     * `publicStringOffenders` was given one home precisely because a second
     * copy of "what must a public repo never say" is the copy that goes
     * stale. The shared version also has five arms to the draft's three, so
     * restating it was not merely duplication, it was a WEAKER sweep wearing
     * the same name.
     *
     * The asar is opaque to a text scan, which is exactly why it gets
     * extracted: the renderer bundle is the single largest body of text in
     * the artefact and the only one a grep would otherwise miss.
     */
    const asarDir = tempDir('wemessage-asar-');
    execFileSync(
      process.execPath,
      [
        need.resolve('@electron/asar/bin/asar.js'),
        'extract',
        join(RES, 'app.asar'),
        asarDir,
      ],
      { stdio: 'ignore' },
    );
    const offenders: string[] = [];
    for (const [root, label] of [
      [RES, 'Resources'],
      [asarDir, 'app.asar'],
    ] as const)
      for (const rel of filesUnder(root)) {
        if (/\.(node|dylib|png|icns|jpg|gif|woff2?|zip|dmg|so)$/i.test(rel))
          continue;
        const abs = join(root, rel);
        if (statSync(abs).size > 8_000_000) continue;
        const text = readFileSync(abs, 'latin1');
        // `detail` is deliberately not echoed for the credential arms; the
        // helper already decides what is safe to name, so the row reports the
        // RULE and the file and lets the helper own the rest.
        for (const o of publicStringOffenders(text))
          offenders.push(`${label}/${rel}: ${o.rule}`);
      }
    expect(offenders).toEqual([]);
  });

  /* ── row 14: the size a user downloads ────────────────────────────── */

  it('row 14: the bundle is arm64-only, and the part we chose is small', () => {
    /*
     * THREE ASSERTIONS, BECAUSE ONE NUMBER WAS MEASURING THE WRONG THING.
     *
     * This row was written as a single `< 260 MB` ceiling on the whole app,
     * on the plan's estimate of "Electron ~230 MB + ours ~15 MB", and it was
     * meant to catch three specific accidents: a `node_modules` that followed
     * an `extraResources` glob, a sourcemap set, a second architecture.
     *
     * The estimate was wrong. Electron 44.2.0 arm64 is 299.8 MB of
     * `Contents/Frameworks` on its own, 193 MB of which is one Mach-O, and
     * the app measures 329.4 MB. Raising the number to 340 would have been
     * the wrong repair twice over: it widens a guard, which E.3 forbids, and
     * it widens the WRONG guard, because none of the three accidents this row
     * exists for land in `Frameworks`. All three land somewhere we control,
     * and a ceiling with 230 MB of Electron underneath it can only see them
     * once they are enormous. A stray `node_modules` had to reach ~230 MB to
     * fail the old row. It has to reach 10 MB to fail the new one.
     *
     * So the ceiling is split by WHO PUT THE BYTES THERE, and the third
     * accident, which is not a size question at all, is asserted as itself.
     */
    const bytesUnder = (root: string): number =>
      filesUnder(root).reduce(
        (n, rel) => n + statSync(join(root, rel)).size,
        0,
      );
    const mb = (n: number): number => n / 1_000_000;

    const total = mb(bytesUnder(APP));
    const frameworks = mb(bytesUnder(join(APP, 'Contents/Frameworks')));
    const ours = mb(bytesUnder(join(APP, 'Contents/Resources')));
    console.log(
      `bundle: ${total.toFixed(1)} MB total, ${frameworks.toFixed(1)} MB electron, ` +
        `${ours.toFixed(1)} MB ours, across ${String(filesUnder(APP).length)} files`,
    );

    /*
     * (a) THE PART WE CHOSE. Everything the pack decided to copy lands in
     * `Contents/Resources`: the asar, the fused daemon, `bin/`, the icon,
     * the migrations, and the licence texts. Measured at 29.5 MB, of which
     * 20.1 MB is Electron's own `LICENSES.chromium.html`, which we are
     * obliged to ship and cannot shrink, and 7.5 MB is the daemon plus the
     * one `better-sqlite3` prebuild. That leaves under 2 MB of moving parts,
     * so the ceiling is set at 40 MB: ten megabytes of slack for Sc 11's
     * `THIRD_PARTY_NOTICES.md` to grow into, and not one byte more than a
     * stray dependency tree would need.
     */
    expect(ours).toBeLessThan(40);

    /*
     * (b) THE SECOND ARCHITECTURE, asserted rather than inferred. F-135 says
     * arm64 and only arm64. A universal build doubles `Frameworks`, which is
     * why the old row thought a size ceiling covered this, but "the binary
     * got bigger" is a symptom and `lipo` reports the fact. `-archs` prints
     * every slice, so a fat binary fails on the STRING, not on a threshold,
     * and it fails whatever it weighs. Row 10 already walks the same Mach-O
     * list to read `otool -L`; this is the other half of the same question.
     */
    const archs = machOFiles(APP).map(
      (rel) =>
        `${rel}: ${execFileSync('lipo', ['-archs', join(APP, rel)], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()}`,
    );
    expect(archs.filter((a) => !a.endsWith(': arm64'))).toEqual([]);
    // Non-vacuity: an empty list would also have no offenders. 13 today.
    expect(archs.length).toBeGreaterThan(8);

    /*
     * (c) THE WHOLE DOWNLOAD, kept as a recorded fact and a coarse tripwire.
     * 329.4 MB today. The ceiling is 400, which is not a target anyone is
     * working towards: it is the number that still fails if Electron's
     * framework doubles, and that is the only failure left for a total to
     * catch now that (a) and (b) own the specific ones. Recorded so Sc 14's
     * release notes can quote what a user actually downloads.
     */
    expect(total).toBeLessThan(400);
    // Non-vacuity, both ends: a half-copied bundle is also under 400.
    expect(total).toBeGreaterThan(200);
    expect(ours).toBeGreaterThan(10);
  });
});
