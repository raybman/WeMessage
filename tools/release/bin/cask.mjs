#!/usr/bin/env node
/**
 * `release:cask` — s9 Sc10: renders homebrew/Casks/wemessage.rb from a
 * built DMG, or from explicit inputs, via the pure `renderCask` in
 * `../src/cask.ts` (consumed here through its compiled `../dist/cask.js`;
 * a plain `node` invocation has no TypeScript loader registered in this
 * repo, so this file reaches for the same compiled output the package's
 * own "main"/"types" fields point at, not the `.ts` source vitest reaches
 * for directly in `test/release/cask.spec.ts`). See cask.ts's own header
 * for why the split between pure renderer and impure CLI exists at all.
 *
 * ARGV, two shapes:
 *
 *   --dmg <path> [--repo <owner/name>]
 *     The shape `.github/workflows/release.yml` calls:
 *       pnpm release:cask --dmg "$(ls dist-pack/*.dmg)"
 *     `version` is parsed from the artefact's own filename
 *     (`WeMessage-<version>-arm64-UNSIGNED.dmg`, the same shape the
 *     rendered `url` stanza expects to find on the GitHub release page)
 *     and `sha256` is computed from its bytes with node:crypto. See THE
 *     FENCE below for why no subprocess runs in this file at all.
 *
 *   --version <semver> --sha256 <64 lowercase hex> [--repo <owner/name>]
 *     Explicit inputs, for regenerating the committed cask and lock file
 *     with no packed DMG on hand. This is the shape that produced the
 *     `homebrew/Casks/wemessage.rb` and `homebrew/cask.lock.json` committed
 *     alongside this file: Scenario 10 ships the renderer and a documented
 *     placeholder digest, not a real artefact (Scenario 12, release smoke,
 *     is where a real packed DMG first exists in this repo; see
 *     homebrew/cask.lock.json's own comment on its placeholder).
 *
 * `--repo` defaults to raybman/WeMessage (FACTS, s9 Sc10) when omitted.
 *
 * THE FENCE (s9 Sc1, tools-import-runtime-nothing): node:* and relative
 * imports only, the same restriction `pack.mjs` and `notarize.ts` operate
 * under. Computing the digest in process with node:crypto rather than
 * shelling out to `shasum`, and reading the DMG's own filename rather than
 * shelling out to `basename`, keeps this file OUT of `test/arch.spec.ts`'s
 * child-process check for the STUBS list: that check exists to catch a
 * script that CLAIMS to be a harmless stub but secretly launches a
 * subprocess, and this file is not that; it never launches one, full stop.
 * Bad usage still refuses via `process.exit(2)` below, the same as an
 * actual stub would, which is what keeps that check satisfied regardless
 * of which list a future scenario decides this script belongs in.
 *
 * WHY THE if/else RETURNS BELOW LOOK REDUNDANT: `process.exit()` schedules
 * the process to terminate, it does not unwind the current call stack the
 * way a `throw` would. Code written as "refuse(...); useTheThingThatFailed"
 * on consecutive lines is one Node version away from a TypeError racing
 * the exit, instead of the clean `refuse` message this script exists to
 * print. Every `refuse(...)` call below is followed by an explicit
 * `return`, and every value it guards is read only on the branch where it
 * is known to be present, so the exit code this script produces never
 * depends on exactly when the process actually stops running.
 */
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { renderCask } from '../dist/cask.js';

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const CASK_RB_PATH = join(REPO_ROOT, 'homebrew', 'Casks', 'wemessage.rb');
const LOCK_PATH = join(REPO_ROOT, 'homebrew', 'cask.lock.json');
const DEFAULT_REPO_SLUG = 'raybman/WeMessage';

function refuse(message) {
  process.stderr.write(`release:cask: ${message}\n`);
  process.exit(2);
}

function flagValue(args, name) {
  const i = args.indexOf(name);
  if (i === -1) {
    return undefined;
  }
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) {
    refuse(`${name} needs a value`);
    return undefined;
  }
  return value;
}

function main() {
  const args = process.argv.slice(2);

  const dmgPath = flagValue(args, '--dmg');
  const explicitVersion = flagValue(args, '--version');
  const explicitSha256 = flagValue(args, '--sha256');
  const repo = flagValue(args, '--repo') ?? DEFAULT_REPO_SLUG;

  let version;
  let sha256;

  if (dmgPath !== undefined) {
    if (explicitVersion !== undefined || explicitSha256 !== undefined) {
      refuse('pass either --dmg, or --version/--sha256, not both');
      return;
    }

    const base = dmgPath.split('/').pop() ?? dmgPath;
    const match = /^WeMessage-(.+)-arm64-UNSIGNED\.dmg$/.exec(base);
    if (match === null) {
      refuse(
        `--dmg filename must look like WeMessage-<version>-arm64-UNSIGNED.dmg; got ${JSON.stringify(base)}`,
      );
      return;
    }
    version = match[1];

    let bytes;
    try {
      bytes = readFileSync(dmgPath);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      refuse(`could not read --dmg ${JSON.stringify(dmgPath)}: ${detail}`);
      return;
    }
    sha256 = createHash('sha256').update(bytes).digest('hex');
  } else if (explicitVersion !== undefined && explicitSha256 !== undefined) {
    version = explicitVersion;
    sha256 = explicitSha256;
  } else {
    refuse(
      'name inputs: --dmg <path>, or --version <semver> --sha256 <64 hex>',
    );
    return;
  }

  let rendered;
  try {
    rendered = renderCask({ version, sha256, repo });
  } catch (err) {
    refuse(err instanceof Error ? err.message : String(err));
    return;
  }

  mkdirSync(dirname(CASK_RB_PATH), { recursive: true });
  writeFileSync(CASK_RB_PATH, rendered);
  writeFileSync(LOCK_PATH, `${JSON.stringify({ version, sha256 }, null, 2)}\n`);

  process.stdout.write(
    `release:cask: wrote ${CASK_RB_PATH} and ${LOCK_PATH} (version ${version})\n`,
  );
}

main();
