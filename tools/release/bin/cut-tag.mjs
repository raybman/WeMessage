#!/usr/bin/env node
/**
 * `release:cut-tag` — create the annotated release tag, or refuse and say why.
 *
 * s9 Scenario 14. The decision lives in `../src/tag.ts` (consumed here through
 * its compiled `../dist/tag.js`), which is a pure function over facts this
 * file gathers. That split is the whole design: `planTag` can be called a
 * hundred times with synthetic inputs in `test/release/versions.spec.ts`
 * without a git repository anywhere near it, and this file stays small enough
 * to read in one sitting.
 *
 * IT NEVER PUSHES. No remote is named in this file or in `tag.ts`, so there
 * is nothing here that could push if it wanted to. Cutting a tag and
 * publishing a release are two decisions and a human makes the second one.
 *
 * THE `tools/` FENCE. Nothing under `tools/` imports a workspace package, not
 * even a type. `node:*`, `yaml`, and relative paths are the whole permitted
 * set, so the release machinery keeps working on a tree whose build is
 * broken, which is exactly the tree somebody reaches for it on. The three
 * imports below are all relative and all inside `tools/release`.
 *
 * WHY THE `return`s AFTER `process.exit()` ARE NOT REDUNDANT: `process.exit()`
 * schedules the exit, it does not abandon the current stack frame, so without
 * the `return` the next statement still runs. Same idiom as `cask.mjs`.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cutTag } from '../dist/tag.js';
import { versionDrift } from './check-versions.mjs';
import { sectionFor } from './release-notes.mjs';

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

const USAGE =
  'usage: pnpm release:cut-tag <version>\n' +
  '  e.g. pnpm release:cut-tag 1.0.0-rc.1\n\n' +
  'A bare GA version (no prerelease suffix) additionally needs exactly one of:\n' +
  '  NOTARIZATION_ACCEPTED_ID=<ticket>   the notarized lane\n' +
  '  UNSIGNED_RELEASE_ACKNOWLEDGED=1     the unsigned lane, recorded in the tag\n';

/** The CHANGELOG, or `null` when there is not one. `planTag` refuses on null. */
const changelogSection = (version) => {
  try {
    return sectionFor(
      readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8'),
      version,
    );
  } catch {
    return null;
  }
};

const main = () => {
  // Usage error, exit 2. A refusal by a gate is exit 1. The two are different
  // events: one means "you called this wrong", the other means "the tree is
  // not in a state that may be tagged", and a caller should be able to tell
  // them apart without parsing stderr.
  const version = process.argv.slice(2).find((a) => !a.startsWith('-'));
  if (version === undefined || version.length === 0) {
    process.stderr.write(`release:cut-tag: no version given.\n\n${USAGE}`);
    process.exit(2);
    return;
  }

  const result = cutTag(version, {
    cwd: repoRoot,
    env: {
      NOTARIZATION_ACCEPTED_ID: process.env.NOTARIZATION_ACCEPTED_ID,
      UNSIGNED_RELEASE_ACKNOWLEDGED: process.env.UNSIGNED_RELEASE_ACKNOWLEDGED,
    },
    versionProblems: versionDrift(version),
    changelogSection: changelogSection(version),
  });

  if (!result.ok) {
    process.stderr.write(`release:cut-tag: ${result.message}\n`);
    process.exit(1);
    return;
  }

  process.stdout.write(
    `release:cut-tag: created annotated tag ${result.tagName}.\n` +
      'Nothing was pushed. Review it, then push it yourself:\n' +
      `  git push origin ${result.tagName}\n`,
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
