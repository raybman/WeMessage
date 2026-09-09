#!/usr/bin/env node
/**
 * `release:check-versions` — every workspace package carries the same version.
 *
 * s9 Scenario 14. This repository versions in LOCKSTEP: seventeen packages
 * plus the root all move together, because they are not independently
 * consumable. `@wemessage/protocol@1.2.0` and `@wemessage/daemon@1.0.4` in
 * the same install is a support conversation nobody wants to have about a
 * program that ships as one app bundle.
 *
 * WHY IT ENUMERATES THE WORKSPACE INSTEAD OF A HARD-CODED LIST. A list in
 * this file is a list that is right on the day it is written. The failure it
 * would miss is the only failure that matters here: a package added after
 * this tool was written, whose version nobody bumped, shipping inside the
 * bundle at 0.1.0 forever. So the globs come from `pnpm-workspace.yaml`,
 * which is the same file the package manager reads, and a new package is
 * visible to this check the moment it is visible to `pnpm install`.
 *
 * THE `tools/` FENCE. Nothing here imports a workspace package, not even a
 * type. The workspace globs are read with a six-line reader rather than a
 * YAML parser so that this tool has no dependency at all and keeps working
 * on a tree whose `node_modules` is empty, which is exactly the tree
 * somebody reaches for it on.
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

/**
 * The `packages:` list out of `pnpm-workspace.yaml`.
 *
 * A real YAML parse would be more general and less honest: this file is a
 * flat sequence of quoted scalars under one key, the reader below fails
 * loudly on anything else, and a tool that must run with no dependencies
 * cannot import one. Comment lines are skipped, and so is anything that is
 * not a `- ` item, which is what ends the list.
 */
export const workspaceGlobs = (yamlText) => {
  const out = [];
  let inside = false;
  for (const raw of yamlText.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (/^packages:\s*$/.test(line)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (/^\s*#/.test(line) || line.length === 0) continue;
    const item = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*$/.exec(line);
    if (item === null) break;
    out.push(item[1]);
  }
  if (out.length === 0)
    throw new Error('pnpm-workspace.yaml has no packages: list');
  return out;
};

/** Expand `a/*` and literal paths into directories that hold a package.json. */
const expand = (glob) => {
  if (!glob.includes('*'))
    return existsSync(join(repoRoot, glob, 'package.json')) ? [glob] : [];
  const parent = glob.slice(0, glob.lastIndexOf('/'));
  let entries;
  try {
    entries = readdirSync(join(repoRoot, parent), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => `${parent}/${e.name}`)
    .filter((rel) => existsSync(join(repoRoot, rel, 'package.json')))
    .sort();
};

/** Every `package.json` in the workspace, the root first. */
export const manifestPaths = () => {
  const globs = workspaceGlobs(
    readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'),
  );
  return ['.', ...globs.flatMap(expand)].map((d) =>
    d === '.' ? 'package.json' : `${d}/package.json`,
  );
};

/**
 * The drift report. Returns `[]` when every manifest agrees.
 *
 * `expected` is optional: with it the check is "everything is at THIS
 * version", which is what the tag verb needs; without it the check is
 * "everything agrees with the root", which is what a pre-commit needs.
 */
/**
 * The one source file that also carries the version, and why it is here.
 *
 * `wemessage --version` and `wemessaged --version` cannot read a
 * `package.json` at runtime: inside an app bundle there is not one to read,
 * and a binary that reports a different version depending on where it was
 * copied to is worse than one that reports none. So the version is baked into
 * a source constant, which makes it a NINETEENTH place the version lives, and
 * an unchecked nineteenth place is a guaranteed drift at the next bump.
 *
 * Read by text rather than imported, because of the `tools/` fence: nothing
 * here may import a workspace package, not even for a constant, so that this
 * check still runs on a tree whose build is broken.
 */
export const APP_VERSION_FILE = 'packages/protocol/src/index.ts';
const APP_VERSION_RE = /^export const APP_VERSION = '([^']*)';$/m;

/** The declared constant, or `null` when the declaration is not there at all. */
export const declaredAppVersion = () => {
  let text;
  try {
    text = readFileSync(join(repoRoot, APP_VERSION_FILE), 'utf8');
  } catch {
    return null;
  }
  return APP_VERSION_RE.exec(text)?.[1] ?? null;
};

export const versionDrift = (expected) => {
  const paths = manifestPaths();
  const read = (rel) => JSON.parse(readFileSync(join(repoRoot, rel), 'utf8'));
  const target = expected ?? read('package.json').version;
  const problems = [];
  if (typeof target !== 'string' || target.length === 0)
    return [
      'package.json has no version field, so there is nothing to agree with',
    ];
  for (const rel of paths) {
    const v = read(rel).version;
    if (v === undefined)
      problems.push(`${rel} has no version field (want ${target})`);
    else if (v !== target) problems.push(`${rel} is ${v}, want ${target}`);
  }
  const declared = declaredAppVersion();
  if (declared === null)
    problems.push(
      `${APP_VERSION_FILE} declares no APP_VERSION (want ${target})`,
    );
  else if (declared !== target)
    problems.push(
      `${APP_VERSION_FILE} declares APP_VERSION ${declared}, want ${target}`,
    );
  return problems;
};

const main = () => {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--expect');
  const expected = i === -1 ? undefined : argv[i + 1];
  const problems = versionDrift(expected);
  if (problems.length > 0) {
    process.stderr.write(
      `release:check-versions: ${problems.length} package(s) out of lockstep\n` +
        problems.map((p) => `  ${p}\n`).join(''),
    );
    process.exit(1);
    return;
  }
  const n = manifestPaths().length;
  const at =
    expected ??
    JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
  process.stdout.write(
    `release:check-versions: ${n} manifests + ${APP_VERSION_FILE}, all at ${at}\n`,
  );
};

// Importable for the spec, runnable as a bin. Compared through `realpathSync`
// rather than `resolve`, because on macOS a path under `/var` and the same
// path under `/private/var` are the same file and `resolve` says they are
// not. Getting that wrong is not a cosmetic bug: the guard silently declines
// to run `main()`, the process exits 0 having done nothing, and a release
// script that succeeds by doing nothing is the exact shape this lane refuses
// everywhere else. Any throw (a path that is not there) means "not us".
const sameFile = (a, b) => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};
if (sameFile(process.argv[1] ?? '', fileURLToPath(import.meta.url))) main();
