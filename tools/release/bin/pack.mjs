#!/usr/bin/env node
/**
 * `pack:adhoc` / `pack:release` — s9 Sc 6.
 *
 * THE LANE LIVES HERE, NOT IN `electron-builder.yml`. That file describes the
 * app: what goes in the asar, what rides beside it, what the Info.plist says.
 * This file describes the SIGNATURE, and the two are separated because a lane
 * that can be selected by editing a config is a lane that can be selected by
 * accident. `pnpm pack:release` on a machine with no certificate must fail,
 * loudly, rather than quietly producing an ad-hoc bundle with a release
 * artefact name that somebody then uploads.
 *
 * THE FENCE (s9 Sc 1, `tools-import-runtime-nothing`): nothing under `tools/`
 * may import a workspace package, not even for a type. The release lane has
 * to work on the day the daemon does not compile, because that is the day
 * somebody is shipping a fix. `node:*` and relative paths are the whole set.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DESKTOP = join(REPO, 'apps', 'desktop');

const args = new Set(process.argv.slice(2));
const lane = args.has('--release')
  ? 'release'
  : args.has('--adhoc')
    ? 'adhoc'
    : null;

function refuse(message) {
  process.stderr.write(`pack: ${message}\n`);
  process.exit(2);
}

if (lane === null) refuse('name a lane: --adhoc or --release');

/**
 * The release lane's precondition, checked BEFORE anything is built, because
 * a fifteen-minute pack that fails at the signing step has wasted fifteen
 * minutes to tell you something knowable in the first millisecond.
 */
if (lane === 'release' && !process.env.CSC_NAME && !process.env.CSC_LINK) {
  refuse(
    'the release lane needs a Developer ID Application certificate (CSC_NAME or\n' +
      'CSC_LINK). There is none in this environment. See F-136 in the s9 spec for\n' +
      'the exact credential and the operator steps that produce it. To build an\n' +
      'unsigned artefact on purpose, run `pnpm pack:adhoc`.',
  );
}

function run(what, cmd, argv, env) {
  process.stderr.write(`pack: ${what}\n`);
  const r = spawnSync(cmd, argv, {
    cwd: REPO,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (r.error) refuse(`${what}: ${r.error.message}`);
  if (r.status !== 0) refuse(`${what}: exited ${String(r.status)}`);
}

// The three build steps, named rather than assumed. `pnpm build` covers the
// app; `bundle:daemon` is separate because it is the ONLY step that needs a
// native module resolved against a specific Electron, and keeping it separate
// is what lets Sc 5's spec rebuild it without rebuilding the GUI.
run('building the workspace', 'pnpm', ['build']);
run('bundling the daemon', 'pnpm', [
  '--filter',
  '@wemessage/desktop',
  'run',
  'bundle:daemon',
]);

for (const required of [
  'dist-bundle/daemon/main.mjs',
  'dist-bundle/bin/wemessage',
  'dist-bundle/migrations',
]) {
  if (!existsSync(join(DESKTOP, required))) {
    refuse(`the build did not produce apps/desktop/${required}`);
  }
}

/**
 * Ad-hoc signing is REAL signing, not skipped signing. `identity: '-'` makes
 * electron-builder sign every Mach-O with the ad-hoc identity, which is what
 * lets the app run on Apple Silicon at all (an unsigned arm64 binary is
 * killed by the kernel) and what makes the hardened-runtime flag mean
 * something. What it does not produce is a stable code identity, which is why
 * the artefacts say UNSIGNED in their names and why F-142 exists.
 */
const laneArgs =
  lane === 'adhoc'
    ? [
        '--config.mac.identity=-',
        '--config.mac.entitlements=build/entitlements.adhoc.plist',
        '--config.mac.entitlementsInherit=build/entitlements.adhoc.plist',
        '--config.artifactName=${productName}-${version}-${arch}-UNSIGNED.${ext}',
      ]
    : ['--config.artifactName=${productName}-${version}-${arch}.${ext}'];

const laneEnv =
  lane === 'adhoc' ? { CSC_IDENTITY_AUTO_DISCOVERY: 'false' } : {};

run(
  `packing the ${lane} lane`,
  'pnpm',
  [
    '--filter',
    '@wemessage/desktop',
    'exec',
    'electron-builder',
    '--mac',
    '--arm64',
    '--publish',
    'never',
    ...laneArgs,
  ],
  laneEnv,
);

process.stderr.write(`pack: ${lane} lane complete — apps/desktop/dist-pack\n`);
