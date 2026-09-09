#!/usr/bin/env node
/**
 * `release:notes` — turn one CHANGELOG section into the body of a release.
 *
 * s9 Scenario 9 row 7. The release workflow attaches `RELEASE_NOTES.md` to
 * the draft it creates. That file is generated, never hand-written, for the
 * same reason the Homebrew cask is generated: a release body typed into the
 * GitHub UI at the moment of shipping is a second source of truth for what
 * changed, and the two drift within one release.
 *
 * WHY IT REFUSES RATHER THAN FALLING BACK. If the CHANGELOG has no section
 * for the version being released, the honest outcomes are "stop" or "ship a
 * release whose notes say nothing". This exits 1. A release with an empty
 * body is indistinguishable from a release nobody wrote notes for, and the
 * workflow would go green either way.
 *
 * THE `tools/` FENCE. Nothing under `tools/` imports a workspace package,
 * not even a type. `node:*`, `yaml`, and relative paths are the whole
 * permitted set, so that the release machinery keeps working on a tree whose
 * build is broken, which is exactly the tree somebody reaches for it on.
 */
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

/** Minimal long-flag parser. No dependency, and no positional arguments. */
const parseArgs = (argv) => {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq !== -1) out[token.slice(2, eq)] = token.slice(eq + 1);
    else {
      out[token.slice(2)] = argv[i + 1] ?? '';
      i += 1;
    }
  }
  return out;
};

/**
 * Extract one version's body from a Keep a Changelog 1.1.0 document.
 *
 * Matches the heading `## [<version>]` with anything after it (the date), and
 * stops at the next `## ` at column zero or at the link-reference block. The
 * regex is anchored with `m` and the version is escaped, because a version
 * string is user input from argv and `1.0.0-rc.1` contains a `.` that would
 * otherwise match any character, which would silently return the WRONG
 * section when two versions differ only in punctuation.
 */
export const sectionFor = (changelog, version) => {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = new RegExp(`^## \\[${escaped}\\][^\\n]*$`, 'm').exec(changelog);
  if (start === null) return null;
  const after = changelog.slice(start.index + start[0].length);
  const next = /^(?:## |\[[^\]]+\]:)/m.exec(after);
  const body = (next === null ? after : after.slice(0, next.index)).trim();
  return body.length === 0 ? null : body;
};

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  const version =
    args.version ??
    JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
  if (typeof version !== 'string' || version.length === 0) {
    process.stderr.write(
      'release:notes: no --version given and the root package.json has no version field.\n',
    );
    process.exit(1);
  }
  const changelogPath = join(repoRoot, 'CHANGELOG.md');
  let changelog;
  try {
    changelog = readFileSync(changelogPath, 'utf8');
  } catch {
    process.stderr.write(
      'release:notes: CHANGELOG.md not found at the repo root.\n',
    );
    process.exit(1);
    return;
  }
  const body = sectionFor(changelog, version);
  if (body === null) {
    process.stderr.write(
      `release:notes: CHANGELOG.md has no non-empty section for ${version}.\n` +
        'Refusing rather than shipping a release with an empty body.\n',
    );
    process.exit(1);
    return;
  }
  if (args.out === undefined) {
    process.stdout.write(`${body}\n`);
    return;
  }
  writeFileSync(join(repoRoot, args.out), `${body}\n`, 'utf8');
  process.stderr.write(`release:notes: wrote ${args.out} for ${version}\n`);
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
