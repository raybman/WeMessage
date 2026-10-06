#!/usr/bin/env node
/**
 * `pack:swift`, v2 S2d: WeMessage.app from the Swift host and the bundled
 * Node, signed, checked, zipped.
 *
 *   pnpm pack:swift --identity <sha1> [--out apps/mac/dist-pack] [--skip-build]
 *
 * THE STEPS, IN ORDER, AND WHY THE ORDER IS THE CONTRACT:
 *   1. tools/swift/node-fetch.sh      the pinned Node, verified twice
 *   2. pnpm -w build                  the workspace the daemon bundle reads
 *   3. bundle-daemon.mjs --runtime node   apps/desktop/dist-bundle-node
 *   4. tools/swift/swift.sh build -c release   the host
 *   5. tools/swift/bundle.sh          apps/mac/dist-app/WeMessage.app
 *   6. tools/swift/sign.sh            inside-out, one identity (S2e)
 *   7. tools/swift/verify-bundle.sh   layout, ABI, machine paths
 *   8. ditto -c -k --keepParent       the zip
 *   9. shasum -a 256                  SHA256SUMS
 *  10. codesign -d -r-                DESIGNATED_REQUIREMENT.txt
 * Verify runs after signing so that what is checked is what ships, and the
 * designated requirement is captured last, from the app that was zipped.
 *
 * --skip-build reuses the outputs of steps 2 to 4 and repeats everything
 * else. The S2e lane packs twice that way and compares the two designated
 * requirements, which is the whole proof that the signature is stable.
 *
 * REFUSALS EXIT 2, BEFORE ANYTHING IS BUILT where they can be: no
 * --identity, or no tools/swift/sign.sh. An unsigned zip is not an artefact
 * this lane produces, so until sign.sh lands (S2e) the lane says so rather
 * than packing something that cannot be launched under TCC.
 *
 * THE FENCE (`tools-import-runtime-nothing`): node builtins only.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const SWIFT = join(REPO, 'tools', 'swift');
const SIGN = join(SWIFT, 'sign.sh');
const DIST_BUNDLE_NODE = join(REPO, 'apps', 'desktop', 'dist-bundle-node');
const DIST_APP = join(REPO, 'apps', 'mac', 'dist-app');
const APP = join(DIST_APP, 'WeMessage.app');

function refuse(message) {
  process.stderr.write(`pack-swift: ${message}\n`);
  process.exit(2);
}

/**
 * One step. `capture` returns the child's stdout ('stdout') or stdout and
 * stderr together ('both', for codesign, which splits its report across the
 * two); otherwise the child's output streams straight through.
 */
function run(what, cmd, argv, opts = {}) {
  process.stderr.write(`pack-swift: ${what}\n`);
  const r = spawnSync(cmd, argv, {
    cwd: opts.cwd ?? REPO,
    encoding: 'utf8',
    stdio: opts.capture
      ? ['ignore', 'pipe', opts.capture === 'both' ? 'pipe' : 'inherit']
      : 'inherit',
  });
  if (r.error) refuse(`${what}: ${r.error.message}`);
  if (r.status !== 0) {
    if (opts.capture === 'both') process.stderr.write(`${r.stdout}${r.stderr}`);
    refuse(`${what}: exited ${String(r.status)}`);
  }
  return opts.capture === 'both'
    ? `${r.stdout}${r.stderr}`
    : `${r.stdout ?? ''}`;
}

const argv = process.argv.slice(2);
let identity = '';
let out = join(REPO, 'apps', 'mac', 'dist-pack');
let skipBuild = false;
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--identity') identity = argv[++i] ?? '';
  else if (a === '--out') out = resolve(REPO, argv[++i] ?? '');
  else if (a === '--skip-build') skipBuild = true;
  else refuse(`unknown argument: ${a}`);
}

if (!/^[0-9A-Fa-f]{40}$/.test(identity))
  refuse('--identity <sha1> is required: the SHA-1 of the signing certificate');
if (!existsSync(SIGN))
  refuse(
    'tools/swift/sign.sh is absent. Signing arrives in S2e, and this lane does\n' +
      'not pack an unsigned app.',
  );

const version = JSON.parse(
  readFileSync(join(REPO, 'package.json'), 'utf8'),
).version;
if (typeof version !== 'string' || version.length === 0)
  refuse('package.json has no version');

const nodeBin = run(
  'fetch the pinned Node',
  'bash',
  [join(SWIFT, 'node-fetch.sh')],
  { capture: 'stdout' },
).trim();
if (!existsSync(nodeBin))
  refuse(`node-fetch.sh printed no node binary: ${nodeBin}`);

if (!skipBuild) {
  run('build the workspace', 'pnpm', ['-w', 'build']);
  run('bundle the daemon for plain Node', process.execPath, [
    join(REPO, 'apps', 'desktop', 'scripts', 'bundle-daemon.mjs'),
    '--runtime',
    'node',
    '--out',
    DIST_BUNDLE_NODE,
    '--node',
    nodeBin,
  ]);
  run('build the host', 'sh', [
    join(SWIFT, 'swift.sh'),
    'build',
    '-c',
    'release',
    '--package-path',
    'apps/mac',
    '--product',
    'WeMessage',
  ]);
}
const binPath = run(
  'locate the host',
  'sh',
  [
    join(SWIFT, 'swift.sh'),
    'build',
    '-c',
    'release',
    '--package-path',
    'apps/mac',
    '--show-bin-path',
  ],
  { capture: 'stdout' },
).trim();
const exe = join(binPath, 'WeMessage');
if (!existsSync(exe)) refuse(`no host at ${exe}; run without --skip-build`);
if (!existsSync(join(DIST_BUNDLE_NODE, 'daemon', 'ABI.json')))
  refuse(`no daemon bundle at ${DIST_BUNDLE_NODE}; run without --skip-build`);

rmSync(DIST_APP, { recursive: true, force: true });
run('assemble WeMessage.app', 'bash', [
  join(SWIFT, 'bundle.sh'),
  '--exe',
  exe,
  '--node',
  dirname(dirname(nodeBin)),
  '--bundle',
  DIST_BUNDLE_NODE,
  '--out',
  DIST_APP,
]);
run('sign WeMessage.app', 'bash', [
  join(SWIFT, 'sign.sh'),
  '--app',
  APP,
  '--identity',
  identity,
]);
run('verify WeMessage.app', 'bash', [
  join(SWIFT, 'verify-bundle.sh'),
  '--app',
  APP,
]);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const zip = `WeMessage-${version}-arm64.zip`;
run('zip WeMessage.app', 'ditto', [
  '-c',
  '-k',
  '--keepParent',
  APP,
  join(out, zip),
]);
writeFileSync(
  join(out, 'SHA256SUMS'),
  run('checksum the zip', 'shasum', ['-a', '256', zip], {
    cwd: out,
    capture: 'stdout',
  }),
);

// Only the requirement line: the `Executable=` line names a path, and the
// S2e lane compares this file byte for byte across two packs.
const report = run(
  'record the designated requirement',
  'codesign',
  ['-d', '-r-', APP],
  {
    capture: 'both',
  },
);
const designated = report
  .split('\n')
  .filter((l) => l.startsWith('designated => '));
if (designated.length !== 1)
  refuse(
    `expected one designated requirement, codesign printed ${String(designated.length)}`,
  );
writeFileSync(join(out, 'DESIGNATED_REQUIREMENT.txt'), `${designated[0]}\n`);

process.stderr.write(`pack-swift: ${join(out, zip)}\n`);
