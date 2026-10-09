#!/usr/bin/env node
/**
 * `dr-diff`, v2 S5b: compare this build's designated requirement with the
 * previous published release's, and refuse an unjustified change.
 *
 *   node tools/release/bin/dr-diff.mjs --repo <owner/name> --tag <tag>
 *        --current <DESIGNATED_REQUIREMENT.txt> --changelog <CHANGELOG.md>
 *
 * The release workflow runs it in the selfsigned lane, after the second
 * pack and before any upload, so an unjustified change fails the job with
 * nothing published. The comparison itself is the pure
 * `compareDesignatedRequirement` in `../src/dr-diff.ts`, read here through
 * its compiled `../dist/dr-diff.js` (plain node has no TypeScript loader);
 * this file only does the reads:
 *
 *   gh release list   --exclude-drafts, newest first
 *   gh release view   the candidate's asset names
 *   gh release download <tag> -p DESIGNATED_REQUIREMENT.txt
 *
 * The previous release is the newest published one, other than this tag,
 * that carries DESIGNATED_REQUIREMENT.txt. Releases without one (the
 * Electron builds) are skipped. None at all is `first-release`.
 *
 * Exit 0: first-release, same, or rotated and justified. Exit 6: rotated
 * and unjustified. Exit 2: a usage error, an unreadable requirement, or a
 * failed read from GitHub (fail closed: a lane that cannot ask does not
 * ship).
 *
 * THE FENCE (`tools-import-runtime-nothing`): node builtins and relative
 * imports only.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  changelogSection,
  compareDesignatedRequirement,
  describeResult,
  exitCodeFor,
  pickPreviousRelease,
} from '../dist/dr-diff.js';

const ASSET = 'DESIGNATED_REQUIREMENT.txt';

function fail(message) {
  process.stderr.write(`dr-diff: ${message}\n`);
  process.exit(2);
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!['--repo', '--tag', '--current', '--changelog'].includes(key ?? ''))
      fail(`unknown argument ${key}`);
    if (value === undefined || value.startsWith('--'))
      fail(`${key} needs a value`);
    out[key.slice(2)] = value;
    i += 1;
  }
  for (const k of ['repo', 'tag', 'current', 'changelog'])
    if (out[k] === undefined)
      fail(
        'usage: dr-diff.mjs --repo <owner/name> --tag <tag> --current <file> --changelog <file>',
      );
  return out;
}

function gh(argv) {
  const r = spawnSync('gh', argv, { encoding: 'utf8' });
  if (r.error !== undefined) fail(`gh could not run: ${r.error.message}`);
  if (r.status !== 0)
    fail(
      `gh ${argv.slice(0, 2).join(' ')} exited ${r.status}: ${r.stderr.trim()}`,
    );
  return r.stdout;
}

const opts = args(process.argv.slice(2));

let current;
let changelog;
try {
  current = readFileSync(opts.current, 'utf8');
  changelog = readFileSync(opts.changelog, 'utf8');
} catch (e) {
  fail(`cannot read an input: ${e instanceof Error ? e.message : String(e)}`);
}

const listed = JSON.parse(
  gh([
    'release',
    'list',
    '--repo',
    opts.repo,
    '--exclude-drafts',
    '--limit',
    '100',
    '--json',
    'tagName,isDraft',
  ]),
);

let previous = null;
for (const tag of pickPreviousRelease(listed, opts.tag)) {
  const view = JSON.parse(
    gh(['release', 'view', tag, '--repo', opts.repo, '--json', 'assets']),
  );
  if (!(view.assets ?? []).some((a) => a.name === ASSET)) continue;
  const dir = mkdtempSync(join(tmpdir(), 'dr-diff-'));
  try {
    gh([
      'release',
      'download',
      tag,
      '--repo',
      opts.repo,
      '-p',
      ASSET,
      '-D',
      dir,
    ]);
    previous = { tag, requirement: readFileSync(join(dir, ASSET), 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  break;
}

let result;
try {
  result = compareDesignatedRequirement({
    previous,
    current,
    changelogSection: changelogSection(changelog, opts.tag),
  });
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}

const code = exitCodeFor(result);
(code === 0 ? process.stdout : process.stderr).write(
  `${describeResult(result)}\n`,
);
process.exit(code);
