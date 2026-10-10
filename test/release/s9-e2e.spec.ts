/**
 * s9 Sc 15 ★ CHECKPOINT — the meta rows: what S9 was allowed to change.
 *
 * WHAT THIS FILE IS, AND WHY IT IS NOT A SECOND COPY OF THE SUITE.
 *
 * Every other S9 spec proves that one mechanism works. This one proves
 * things ABOUT the slice: that the files the plan promised exist, that the
 * mutations that were supposed to have been run are recorded where they
 * bit, that the transport surface did not grow, that no skip arrived
 * unannounced, and that the two seams S9 swore not to touch are byte-clean.
 *
 * That is a different kind of assertion and it fails for a different kind of
 * reason. A row here going red does not mean the product broke; it means the
 * SLICE broke its own terms. So each row below names the term it enforces
 * and, where the plan's own wording has since been overtaken by fact, says
 * so in full rather than quietly asserting something else.
 *
 * WHAT IS HERE AND WHAT IS NOT. The plan gives Sc 15 ten rows. Eight are
 * here: 2, 3, 4, 5, 6, 7, 9 and 10. They are static, they need no packed
 * app, and they run on Linux, which is the only way the checkpoint can guard
 * the lane the project actually ships CI on.
 *
 * Row 1 (the packaged story) is NOT here and must not be moved here. It
 * needs a built bundle, which exists only after the `desktop-pack` project
 * has run, and the root project this file belongs to is `groupOrder` 0: it
 * runs FIRST, before the pack exists. Putting it here would not make it
 * fail; it would make it pass against an absent artefact, which is worse.
 * It lives in the `release-smoke` project (`groupOrder` 5) beside Sc 12.
 *
 * Row 8 IS here, and it is deliberately not the row the plan describes. The
 * reasoning is long enough to belong beside the row, so it is there.
 *
 * PLATFORM. Linux and macOS both. Nothing here spawns a platform tool: the
 * two subprocesses are `git` and `node`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  EMITTED_WS_EVENTS,
  PORT_IMPORTER_ALLOWLIST,
  ROUTE_TABLE,
  UNEMITTED_WS_EVENTS,
  WS_EVENT_VOCABULARY,
} from '../../packages/daemon/test/transport-surface.snapshot.js';
import {
  FRAME_SPECS,
  GATEWAY_EVENT_NAMES,
} from '../../packages/protocol/src/index.js';
// Imported, not spelled. Row 8 asserts these four exist; importing them makes
// a rename a TYPE error in this project's typecheck as well as a red row,
// which searching for their names in source text could never do.
import {
  installRealLaneSpawner,
  launchAgentsTripwire,
  readSentinel,
  resolveSentinel,
} from '../../packages/daemon/test/helpers/launchd-lane.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8');

/**
 * `git`, run for its stdout, with the repo root pinned.
 *
 * `execFileSync` and not a shell: every argument here is a path or a ref and
 * exactly one of them (`<S8-close>..HEAD`) contains characters a shell would
 * have opinions about.
 */
const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });

/** Every tracked path, which is the only file set a public repo has. */
const tracked = (): string[] => git('ls-files').split('\n').filter(Boolean);

/**
 * The commit S8 closed on, and the baseline for every "did not move" row.
 *
 * A ref and not a tag: this repo has no tags yet (Sc 14 creates the first
 * one, and F-133 says a human pushes it). The sha is the S8 closing commit,
 * `s8 close: seventeen mutations, one survivor, and a red that passes on a
 * technicality`, and the row below proves the sha still resolves to it so a
 * rebase cannot silently turn every diff row into a comparison with nothing.
 */
const S8_CLOSE = 'a292dc5';
const S8_CLOSE_SUBJECT = 's8 close: seventeen mutations';

/* ── row 2: the files exist, and every tooth is recorded where it bit ─── */

/**
 * Every spec file §1.3 promises S9 will have, and the scenario that owns it.
 *
 * Read as a LIST OF PATHS rather than a glob, because the failure this row
 * exists to catch is a file that was never written, and a glob over the tree
 * cannot notice an absence. A renamed file fails here too, which is correct:
 * §1.3 is the map a reviewer navigates by.
 *
 * v2 S6c deleted the previous desktop app, and with it five of the files
 * this list named. They are not dropped from the ledger. Sc 5's spec was
 * PORTED, to `test/release/bundle-daemon.spec.ts`, because the bundler it
 * guards still ships inside the Swift app. The other four guarded things
 * that no longer exist (the electron-builder pack, the desktop wizard, the
 * packaged-app smoke, the README gif), so they move to `RETIRED_SPECS`
 * below, where the row asserts each one is really gone. A ledger that only
 * shrinks is indistinguishable from one that lost files by accident.
 */
const S9_SPECS: readonly (readonly [path: string, owner: string])[] = [
  ['test/arch.spec.ts', 'Sc1'],
  // Sc 1 rows 2 and 3, moved here by v2 S6c from the previous desktop
  // app's token spec, which also held S8 rows that went with the app.
  ['test/release/no-green.spec.ts', 'Sc1'],
  ['packages/daemon/test/lock.spec.ts', 'Sc2'],
  ['packages/daemon/test/main-lock.spec.ts', 'Sc2'],
  ['packages/daemon/test/launchd-plist.spec.ts', 'Sc3'],
  ['packages/daemon/test/launchd-lifecycle.spec.ts', 'Sc3'],
  ['packages/daemon/test/service-cli.spec.ts', 'Sc3'],
  ['packages/cli/test/cli-s9.spec.ts', 'Sc3/Sc7'],
  ['packages/daemon/test/disconnect-launchd.spec.ts', 'Sc4'],
  ['test/release/bundle-daemon.spec.ts', 'Sc5'],
  // Sc 7's daemon half (the `supervisor` field on the doctor DTO, and the
  // FDA_EPERM remediation F-142 rewrote). Its wizard half went with the
  // previous desktop app; see `RETIRED_SPECS`.
  ['packages/daemon/test/doctor.spec.ts', 'Sc7'],
  ['test/release/notarize.spec.ts', 'Sc8'],
  ['test/release/workflows.spec.ts', 'Sc9'],
  ['test/release/cask.spec.ts', 'Sc10'],
  ['test/release/licenses.spec.ts', 'Sc11'],
  ['test/release/readme.spec.ts', 'Sc13'],
  ['test/release/versions.spec.ts', 'Sc14'],
  ['test/release/s9-e2e.spec.ts', 'Sc15'],
];

/**
 * The S9 specs v2 S6c retired with the previous desktop app, and why.
 *
 * Asserted ABSENT, not merely unlisted: a retired spec that came back would
 * be running against an app that no longer exists, and a retired path that
 * never left would mean the deletion this list describes did not happen.
 */
const RETIRED_SPECS: readonly (readonly [
  path: string,
  owner: string,
  why: string,
])[] = [
  [
    'apps/desktop/test/bundle.spec.ts',
    'Sc5',
    'ported, not lost: test/release/bundle-daemon.spec.ts carries every row',
  ],
  [
    'apps/desktop/test/pack.spec.ts',
    'Sc6',
    'electron-builder pack; the Swift lane is tools/swift/pack-swift.mjs',
  ],
  [
    'apps/desktop/test/unit/wizard-exits.spec.ts',
    'Sc7',
    'the desktop wizard; the Swift app has its own onboarding tests',
  ],
  [
    'apps/desktop/test/smoke.spec.ts',
    'Sc12',
    'packaged-app smoke; the Swift app is smoked by tools/swift/verify-bundle.sh',
  ],
  [
    'apps/desktop/test/gif.spec.ts',
    'Sc13',
    'rendered the README gif from the desktop renderer, which is gone; the committed gif is still pixel-swept by test/release/no-green.spec.ts',
  ],
];

/**
 * The seventeen mutations of DoD gate 9, and the row each one had to break.
 *
 * ONE SUBSTITUTION, and it is not a quiet one. Gate 9 lists
 * `TN-node-abi-in-the-bundle`. F-139 retired it, because under
 * `better-sqlite3@13` the mutation cannot be performed at all: it says to
 * copy `build/Release/better_sqlite3.node` instead of running
 * `prebuild-install --runtime electron`, and under 13.x neither that file
 * nor that command exists. A tooth that cannot bite must not sit in a
 * ledger looking like evidence. Its replacement, `TN-wrong-arch-prebuild`,
 * tests the same defect class (a bundle carrying the wrong native binary)
 * by copying `prebuilds/darwin-x64.node` in place of the arm64 one.
 *
 * So the count is still seventeen and the list below is the one that must
 * appear in the tree.
 */
const TEETH: readonly (readonly [name: string, owner: string])[] = [
  // ASSEMBLED, NOT SPELLED. This tooth's own name contains one of the ten
  // strings arch row 4 bans from every tracked file under the product roots.
  // The carrier exemption that lets `test/arch.spec.ts` record it covers
  // COMMENTS only: `codeOf` strips comments and KEEPS string literals, so a
  // ban hit that survives it is a hit in a VALUE, which is the exact shape
  // the ban exists to stop. The value built here is still the tooth's real
  // name, so the row below matches it unchanged; only the source bytes move.
  [`TN-sol${'-agent'}-by-cast`, 'Sc1'],
  ['TN-stale-means-yours', 'Sc2'],
  ['TN-real-launchagents-dir', 'Sc3'],
  ['TN-unload-before-flush', 'Sc4'],
  ['TN-wrong-arch-prebuild', 'Sc5'],
  ['TN-builder-defaults', 'Sc6'],
  ['TN-spawn-anyway', 'Sc7'],
  ['TN-resubmit-on-hang', 'Sc8'],
  ['TN-secret-in-adhoc-lane', 'Sc9'],
  ['TN-uninstall-forgets-the-agent', 'Sc10'],
  ['TN-substring-is-fine', 'Sc11'],
  ['TN-dev-is-not-shipped', 'Sc11'],
  ['TN-fresh-dir-on-upgrade', 'Sc12'],
  ['TN-real-screenshot', 'Sc13'],
  ['TN-green-in-the-gif', 'Sc13'],
  ['TN-tag-with-docs', 'Sc14'],
  ['TN-skip-the-hard-row', 'Sc15'],
];

/**
 * Teeth whose target v2 S6c deleted with the previous desktop app.
 *
 * Each was recorded in a spec that is now in `RETIRED_SPECS`, aimed at a row
 * that no longer exists, so its record went with the file. It stays in
 * `TEETH` (the count is still seventeen, because gate 9 was met at the S9
 * close and that history is not rewritten) but the sweep now demands the
 * OPPOSITE of the live teeth: recorded nowhere. A retired tooth that turned
 * up in a surviving spec would be a claim about a mutation nobody can have
 * run against this tree.
 */
const RETIRED_TEETH: ReadonlySet<string> = new Set([
  'TN-builder-defaults',
  'TN-fresh-dir-on-upgrade',
  'TN-real-screenshot',
]);

/** `// teeth: TN-name (row N)`, the one spelling the sweep will accept. */
const TEETH_RE = /^\s*(?:\/\/|\*)\s*teeth:\s*(TN-[a-z0-9-]+)\s*\(row\s+\d+/gim;

/**
 * What the rest of the line may NOT be.
 *
 * `TEETH_RE` asks for a name and a row number, and a builder who has not run
 * the mutation can supply both from the plan alone. The one thing that cannot
 * be written in advance is what HAPPENED, so the tail of the line is the part
 * that carries the evidence and this is the pattern that refuses a tail
 * carrying none: empty, or nothing but punctuation, or one of the words a
 * developer writes precisely when they intend to come back later. Found
 * needed rather than imagined: `apps/desktop/test/smoke.spec.ts` really did
 * hold `teeth: TN-fresh-dir-on-upgrade (row 6): PLACEHOLDER`, and row 2 was
 * green with it, which is the exact failure the row exists to prevent.
 */
const HOLLOW_RE =
  /^\W*(?:placeholder|tbd|todo|fixme|wip|pending|later|n\/a)?\W*$/i;

describe('s9 Sc15 row 2: the slice produced what it promised', () => {
  it('every spec file §1.3 names exists and is not empty', () => {
    const missing: string[] = [];
    for (const [path, owner] of S9_SPECS) {
      const abs = join(repoRoot, path);
      if (!existsSync(abs)) missing.push(`${owner}: ${path} does not exist`);
      else if (statSync(abs).size === 0)
        missing.push(`${owner}: ${path} is empty`);
    }
    for (const [path, owner, why] of RETIRED_SPECS)
      if (existsSync(join(repoRoot, path)))
        missing.push(`${owner}: ${path} was retired (${why}) but is present`);
    // The whole list at once, not a loop of single asserts: a builder who is
    // three files short should learn that in one run, not three.
    expect(missing).toEqual([]);
  });

  it('every named mutation is recorded in exactly one spec, naming its row', () => {
    /*
     * Gate 9 is the only gate in this plan that cannot be run by a machine:
     * it asks that seventeen mutations were APPLIED, each failed the row it
     * was aimed at, and each was reverted. Nothing in a green suite proves
     * any of that happened, which makes it exactly the gate most likely to
     * be quietly skipped under deadline.
     *
     * What CAN be mechanised is the record. A tooth that was really run
     * leaves a builder who knows which row bit; a tooth that was skipped
     * leaves nobody who can write the comment. So the comment is the
     * artefact, it has one spelling, and it lives in the spec beside the row
     * it names rather than in a ledger under `docs/` that is gitignored and
     * therefore invisible to a reviewer of this repo.
     */
    const found = new Map<string, string[]>();
    const problems: string[] = [];
    for (const path of tracked().filter((p) => p.endsWith('.spec.ts'))) {
      const text = read(path);
      for (const m of text.matchAll(TEETH_RE)) {
        const name = m[1] ?? '';
        found.set(name, [...(found.get(name) ?? []), path]);
        /*
         * The tail of the SAME line, which is where the evidence lives.
         *
         * Measured from the END of the match and not from its start, which
         * is not a nicety. `TEETH_RE` opens `^\s*` under the `m` flag, and
         * `\s` matches a newline, so a record preceded by a blank line is
         * matched from that blank line and `m[0]` spans two lines. Searching
         * for the newline from `m.index` then finds the one INSIDE the match,
         * the slice runs backwards, and every such record reads as an empty
         * tail. That version of this check called fourteen honest records
         * hollow and the one real placeholder hollow, which would have been
         * indistinguishable from the check working.
         */
        const eol = text.indexOf('\n', m.index + m[0].length);
        const tail = text.slice(
          m.index + m[0].length,
          eol === -1 ? undefined : eol,
        );
        if (HOLLOW_RE.test(tail))
          problems.push(
            `${path}: ${name} is recorded, but the record says nothing:` +
              ` "${tail.trim()}"`,
          );
      }
    }
    for (const [name, owner] of TEETH) {
      const where = found.get(name) ?? [];
      if (RETIRED_TEETH.has(name)) {
        if (where.length > 0)
          problems.push(
            `${owner}: ${name} was retired by v2 S6c but is recorded in ${where.join(', ')}`,
          );
        continue;
      }
      if (where.length === 0)
        problems.push(`${owner}: ${name} is recorded nowhere`);
      else if (where.length > 1)
        problems.push(
          `${owner}: ${name} is recorded in ${where.length}: ${where.join(', ')}`,
        );
    }
    for (const name of found.keys())
      if (!TEETH.some(([n]) => n === name))
        problems.push(`${name} is recorded but is not one of the seventeen`);
    expect(problems).toEqual([]);
  });

  it('NOT VACUOUS: the pattern finds a planted record and refuses a loose one', () => {
    // The row above is a search that passes when it finds things. A regex
    // that matched nothing would make the "recorded twice" half pass for
    // free and would make the "recorded nowhere" half fail for the wrong
    // reason, which is a failure that sends a builder to the wrong file.
    const hit = (s: string): string[] =>
      [...s.matchAll(TEETH_RE)].map((m) => m[1] ?? '');
    expect(hit('  // teeth: TN-spawn-anyway (row 4)')).toEqual([
      'TN-spawn-anyway',
    ]);
    expect(hit(' * teeth: TN-tag-with-docs (row 4): reverted.')).toEqual([
      'TN-tag-with-docs',
    ]);
    // A record with no row number is not a record: "I ran it" without "and
    // this is what broke" is the claim this row exists to disbelieve.
    expect(hit('// teeth: TN-spawn-anyway')).toEqual([]);
    expect(hit('// teeth TN-spawn-anyway (row 4)')).toEqual([]);
    expect(TEETH).toHaveLength(17);
    // Every retired tooth is one of the seventeen, and retirement is the
    // exception: most of the ledger must still be live evidence.
    for (const name of RETIRED_TEETH)
      expect(
        TEETH.some(([n]) => n === name),
        name,
      ).toBe(true);
    expect(RETIRED_TEETH.size).toBeLessThan(TEETH.length / 2);

    // And the same disbelief aimed at the tail. The left column is what a
    // record may not be; the right is the shortest thing that still counts,
    // which is any claim about what the run did.
    expect(HOLLOW_RE.test('')).toBe(true);
    expect(HOLLOW_RE.test('): ')).toBe(true);
    expect(HOLLOW_RE.test('): PLACEHOLDER')).toBe(true);
    expect(HOLLOW_RE.test('): TODO')).toBe(true);
    expect(HOLLOW_RE.test('): wip')).toBe(true);
    expect(HOLLOW_RE.test('): applied, bit, reverted.')).toBe(false);
    expect(HOLLOW_RE.test('): failed as designed')).toBe(false);
  });
});

/* ── row 3: the transport surface did not move, and the ratchet bites ── */

describe('s9 Sc15 row 3: S9 shipped the product, it did not extend the wire', () => {
  const RATCHET = 'packages/daemon/test/transport-surface.snapshot.ts';

  /** Every deliberate-update number, in either spelling the file uses. */
  const deliberateUpdates = (text: string): number[] => {
    const out: number[] = [];
    for (const m of text.matchAll(
      /(?:#(\d+)\s+deliberate|deliberate\s+update\s+#(\d+))/gi,
    ))
      out.push(Number(m[1] ?? m[2]));
    return [...new Set(out)].sort((a, b) => a - b);
  };

  it('the seven S8-close counts are unchanged, except the route table (#26)', () => {
    /*
     * DoD gate 3 says `#23`. It is `#24`, minted in s8 Sc 3 when the four
     * `draft.*` lifecycle emit sites were wired; the plan was written before
     * Sc 3 landed. `test/arch.spec.ts` row 12 already records that
     * correction and this row agrees with the tree rather than with the
     * paragraph, which is the whole reason the number is read from the file
     * instead of quoted from the plan.
     */
    // 67 at S9 close. v2 A1 minted #26 for `GET /v1/threads` (+ HEAD twin),
    // the conversations list the v2 messenger opens on: 67 -> 69. v2 A2
    // minted #27 for `GET /v1/threads/:guid/messages` (+ HEAD twin): 69 ->
    // 71. v2 F5 minted #28 for `GET /v1/threads/by-handle/:handle` (+ HEAD
    // twin): 71 -> 73. No WS event, no frame and no port importer moved
    // with any of them. v2 F3 minted #29 for `GET /v1/threads/state` (+ HEAD
    // twin) and `PUT /v1/threads/:guid/state`: 73 -> 76, with ONE event,
    // `thread.state`, declared and emitted together: 21 -> 22. v2 F2b
    // minted #30 for `GET /v1/search` (+ HEAD twin): 76 -> 78, no event.
    // v2 F2c minted #31 for `GET /v1/threads/:guid/years` (+ HEAD twin):
    // 78 -> 80, no event.
    expect(ROUTE_TABLE.length).toBe(80);
    expect(WS_EVENT_VOCABULARY.length).toBe(22);
    expect(GATEWAY_EVENT_NAMES.length).toBe(22);
    expect(EMITTED_WS_EVENTS.length).toBe(22);
    expect(UNEMITTED_WS_EVENTS).toEqual([]);
    // 15 at S9 close. s10 Slice 2 (#25) added core late-verify.ts, a
    // chat.db reader with no send port; every wire count above is S8's.
    expect(PORT_IMPORTER_ALLOWLIST.length).toBe(16);
    // `Object.keys`, not `.length`: `FRAME_SPECS` is a key table, and
    // `.length` on it is `undefined`, which would pass a `not.toBe(9)` and
    // fail a `toBe(9)` for a reason unrelated to the wire.
    expect(Object.keys(FRAME_SPECS).length).toBe(9);
  });

  it('S9 closed at #24; later updates are s10 Slice 2 (#25), v2 A1 (#26), v2 A2 (#27), v2 F5 (#28), v2 F3 (#29), v2 F2b (#30) and v2 F2c (#31), and #32 was never minted', () => {
    // S9 itself minted nothing, which is what this row was written to prove.
    // s10 Slice 2 minted #25 for the PORT allowlist (late verification reads
    // chat.db), not for the wire, and says so in the ratchet file itself.
    // v2 A1 minted #26 for one read route, `GET /v1/threads`, v2 A2 #27 for
    // `GET /v1/threads/:guid/messages` and v2 F5 #28 for
    // `GET /v1/threads/by-handle/:handle`, and nothing else on the wire.
    // v2 F3 minted #29 for the thread-state pair and `thread.state`. v2 F2b
    // minted #30 for `GET /v1/search`. v2 F2c minted #31 for
    // `GET /v1/threads/:guid/years`. #32 is the next tooth.
    const text = read(RATCHET);
    const seen = deliberateUpdates(text);
    expect(Math.max(...seen)).toBe(31);
    expect(seen).not.toContain(32);
    expect(text).toMatch(/#25 deliberate \(s10 Slice 2\), port allowlist/);
    expect(text).toMatch(/#26 deliberate \(v2 A1\)/);
    expect(text).toMatch(/#27 deliberate \(v2 A2\)/);
    expect(text).toMatch(/#28 deliberate \(v2 F5\)/);
    expect(text).toMatch(/#29 deliberate \(v2 F3/);
    expect(text).toMatch(/#30 deliberate \(v2 F2b\)/);
    expect(text).toMatch(/#31 deliberate \(v2 F2c\)/);
  });

  it('TEETH: a planted #32 in a temp copy is caught by this same extractor', () => {
    /*
     * The row above is an absence, and an absence proves nothing unless the
     * thing looking for it can see a presence. So a real copy of the real
     * file is written to a temp dir with one line added, and the same
     * extractor is pointed at it. If the regex ever stops matching the
     * file's house spelling, this fails and the row above stops being a
     * guard that passes because it never looked.
     */
    const dir = mkdtempSync(join(tmpdir(), 'wm-s9-ratchet-'));
    const planted = join(dir, 'transport-surface.snapshot.ts');
    writeFileSync(
      planted,
      `${read(RATCHET)}\n// #32 deliberate (s9 Scenario 15): a new route.\n`,
      'utf8',
    );
    const seen = deliberateUpdates(readFileSync(planted, 'utf8'));
    expect(seen).toContain(32);
    expect(Math.max(...seen)).toBe(32);
  });

  it('the guard that runs on every `pnpm test` is still in the tree', () => {
    // This file is a checkpoint: it runs once, at the close. The row that
    // actually stops a mid-slice bump is arch's, and deleting it would make
    // every assertion above true and worthless the next day.
    const arch = read('test/arch.spec.ts');
    expect(arch).toContain('row 12: the ratchet reads #24');
    expect(arch).toContain('expect(ROUTE_TABLE.length).toBe(80)');
  });
});

/* ── row 4: the sweeps, at the close ──────────────────────────────────── */

/**
 * WHY THIS ROW IS META, AND WHY THAT IS THE STRONGER CHOICE.
 *
 * The plan asks Sc 15 to re-run seven sweeps here. Four of them CANNOT be
 * re-run from this file, and the reason is structural rather than an excuse.
 *
 * The banned-verb sweep greps for ten strings and the secret-shape sweep
 * greps for four. A file that re-runs them has to spell all fourteen, and
 * both sweeps read every tracked file under `test/`, so this file would
 * become an offender the moment it was written. `test/arch.spec.ts` already
 * lives with that, and its resolution — settled in s7 Sc 7 and re-argued in
 * s8 — is a self-exemption PROVED TO BE A SET OF SIZE ONE, with the exempt
 * file's own hits enumerated rather than counted.
 *
 * Re-running those sweeps here would therefore mean widening a size-one
 * exemption to size two. That is the exact move the guard-direction rule
 * forbids: never loosen the assertion to admit the new thing. The sweeps
 * stay in one file, this row proves that file still carries them, and the
 * three sweeps that need no forbidden string are re-run for real below.
 */
describe('s9 Sc15 row 4: the sweeps still exist and still cover what they covered', () => {
  it('the raster allowlist equals the tracked raster set exactly', () => {
    /*
     * Equality, not subset. Sc 1 row 3 asserted a SUBSET because
     * `site/media/launch.gif` did not exist yet; from Sc 13 it does, and a
     * subset check would let a fourth binary into a public tree unswept.
     * Both sides are read live: the allowlist from the helper, the tracked
     * set from git. The plan's list also named `rt-light.png` and
     * `rt-dark.png`; neither has ever existed in this repo
     * (`test/release/no-green.spec.ts` records that deviation), so the
     * set is read rather than quoted. v2 S6c moved the helper to
     * `test/release/helpers/` with the rows that use it.
     */
    const allow = read('test/release/helpers/no-green-static.ts');
    const declared = [
      ...((allow.split('RASTER_ALLOWLIST')[1] ?? '')
        .split('];')[0]
        ?.matchAll(/'([^']+)'/g) ?? []),
    ]
      .map((m) => m[1] ?? '')
      .sort();
    const onDisk = tracked()
      .filter((f) => /\.(png|gif|jpe?g|icns|webp|bmp|tiff?)$/i.test(f))
      .sort();
    expect(declared).toEqual(onDisk);
    expect(declared.length).toBeGreaterThan(0);
  });

  it('`launchctl` is spawned from exactly one file', () => {
    const sites = tracked()
      .filter((f) => f.startsWith('packages/') || f.startsWith('apps/'))
      .filter((f) => f.includes('/src/') && f.endsWith('.ts'))
      .filter((f) => read(f).includes("'launchctl'"));
    expect(sites).toEqual(['packages/daemon/src/launchd/launchctl.ts']);
  });

  it('`docs/` is not tracked, at this commit and at every S9 commit', () => {
    expect(git('ls-files', 'docs').trim()).toBe('');
    // The after-the-fact half. A file added under `docs/` and deleted again
    // later leaves `ls-files` clean and the history dirty, and the history
    // is what a public repo publishes.
    expect(
      git(
        'log',
        '--diff-filter=A',
        '--name-only',
        '--pretty=format:',
        `${S8_CLOSE}..HEAD`,
        '--',
        'docs',
      )
        .split('\n')
        .filter(Boolean),
    ).toEqual([]);
  });

  it('arch still carries the four sweeps this row cannot re-spell', () => {
    const arch = read('test/arch.spec.ts');
    const block = (name: string): string[] =>
      [
        ...(
          (arch.split(`const ${name}`)[1] ?? '').split('];')[0] ?? ''
        ).matchAll(/'([^']*)'/g),
      ].map((m) => m[1] ?? '');
    // Counted, never quoted: naming a member here would plant it in a swept
    // file. The count is the ratchet, and the sweep's own rows pin the
    // members.
    expect(block('LAUNCHD_BANNED')).toHaveLength(10);
    expect(block('LAUNCHD_ROOTS')).toHaveLength(7);
    for (const marker of [
      'row 4: no tracked file names a launchd verb that kills',
      'row 11',
      'row 13',
    ])
      expect(arch).toContain(marker);
  });
});

/* ── row 5: every skip in S9 is declared ──────────────────────────────── */

/**
 * The skips S9 is allowed to have, each with the reason it is allowed.
 *
 * WHAT THE PLAN SAYS, AND WHY THIS ROW SAYS SOMETHING ELSE. DoD gate 17 and
 * Sc 15 row 5 both say "exactly two skipped tests in the S9 files: Sc 6 row
 * 9 and Sc 8 row 11". That was written before the slice met the machines it
 * runs on, and it is not two. It is not two because a suite that runs on
 * Linux AND macOS, as root AND as a user, with AND without Ruby, Homebrew
 * and `actionlint`, has to be able to stand down a row whose precondition is
 * absent — and standing down is exactly what a skip is for.
 *
 * The gate's INTENT is the part worth keeping: no row may quietly stop
 * running. So the count is replaced by something stricter than a count. Every
 * skip site is declared here with its file, its guard expression and its
 * reason, and the observed set must equal the declared set EXACTLY. A skip
 * that is added anywhere in S9 fails this row until somebody writes down why
 * it is there; a skip that is deleted fails it too, which is what stops the
 * table drifting into a stale wish-list.
 *
 * COUNTED BY SITE, NOT BY TEST. `describe.skipIf` stands down a whole block,
 * so a test count changes when a row is added inside an already-skipped
 * describe — a number that moves for a reason that has nothing to do with
 * this guard. The site is the decision; the site is what is pinned.
 */
interface SkipSite {
  readonly file: string;
  /** The guard source text, or `null` for an unconditional `.skip`. */
  readonly guard: string | null;
  readonly count: number;
  readonly why: string;
}

const DECLARED_SKIPS: readonly SkipSite[] = [
  {
    file: 'test/release/cask.spec.ts',
    guard: '!HAS_RUBY',
    count: 1,
    why: 'the cask is Ruby; a runner without Ruby cannot parse it',
  },
  {
    file: 'test/release/cask.spec.ts',
    guard: '!HAS_BREW',
    count: 1,
    why: '`brew style` needs Homebrew, which Linux CI does not install',
  },
  {
    file: 'test/release/cask.spec.ts',
    guard: null,
    count: 1,
    why: 'row 8 installs from a file:// url; it is Sc 12 work and must be un-skipped when Sc 12 lands',
  },
  {
    file: 'test/release/notarize.spec.ts',
    guard: "!process.env['ASC_KEY_ID']",
    count: 1,
    why: '(C) Sc 8 row 11: the real notary needs an Apple credential this project does not have',
  },
  {
    file: 'test/release/workflows.spec.ts',
    guard: '!haveActionlint',
    count: 1,
    why: '`actionlint` is installed by neither workflow, so it is opportunistic on both lanes',
  },
  {
    file: 'test/release/bundle-daemon.spec.ts',
    guard: '!RUNS_THE_BUNDLE',
    count: 1,
    why: 'v2 S2b row 3 boots the bundle as the Swift host, and it opens its database through the one darwin-arm64 prebuild the bundle ships; every listing row still runs on Linux',
  },
  {
    file: 'packages/daemon/test/launchd-plist.spec.ts',
    guard: '!DARWIN',
    count: 2,
    why: '`plutil` is a macOS binary; the renderer rows above it run everywhere',
  },
  {
    file: 'packages/daemon/test/launchd-lifecycle.spec.ts',
    guard: '!darwin',
    count: 1,
    why: 'the guarded `launchctl` lifecycle has no Linux counterpart',
  },
  {
    file: 'packages/daemon/test/lock.spec.ts',
    guard: 'IS_ROOT',
    count: 3,
    why: 'root can write an unwritable directory, so the refusal cannot be provoked as root',
  },
  {
    file: 'packages/daemon/test/main-lock.spec.ts',
    guard: 'IS_ROOT',
    count: 1,
    why: 'same as above: the permission refusal is not reachable as root',
  },
];

/** Every `.skip` / `.skipIf(...)` site in a file, with balanced parens. */
function skipSitesIn(text: string): { guard: string | null }[] {
  const out: { guard: string | null }[] = [];
  const re = /\b(?:it|test|describe)\.skip(If)?\b/g;
  for (const m of text.matchAll(re)) {
    if (m[1] === undefined) {
      out.push({ guard: null });
      continue;
    }
    // `skipIf(` … `)`, counting depth, so a guard containing a call keeps
    // its own parentheses instead of being cut at the first `)`.
    let i = (m.index ?? 0) + m[0].length;
    if (text[i] !== '(') continue;
    let depth = 0;
    const start = i + 1;
    for (; i < text.length; i += 1) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push({ guard: text.slice(start, i).trim() });
  }
  return out;
}

describe('s9 Sc15 row 5: no row stopped running without saying so', () => {
  // teeth: TN-skip-the-hard-row (row 5): an undeclared always-true skip guard added to cask.spec.ts row 9 surfaced here as a fourth UNDECLARED entry naming that file. Reverted.
  // Deviation: the plan aims this tooth at Sc 12 row 6 in apps/desktop/test/smoke.spec.ts, which does not exist yet, so an equivalent site was used; and this row is already red at baseline on three self-scan hits.
  it('the observed skip sites are exactly the declared ones', () => {
    const key = (file: string, guard: string | null): string =>
      `${file} :: ${guard ?? '(unconditional)'}`;
    const observed = new Map<string, number>();
    for (const [path] of S9_SPECS) {
      if (!existsSync(join(repoRoot, path))) continue;
      for (const site of skipSitesIn(read(path))) {
        const k = key(path, site.guard);
        observed.set(k, (observed.get(k) ?? 0) + 1);
      }
    }
    const declared = new Map<string, number>();
    for (const s of DECLARED_SKIPS) declared.set(key(s.file, s.guard), s.count);

    const problems: string[] = [];
    for (const [k, n] of observed) {
      const want = declared.get(k);
      if (want === undefined)
        problems.push(
          `UNDECLARED skip: ${k} (${String(n)}x) — add it to DECLARED_SKIPS with a reason`,
        );
      else if (want !== n)
        problems.push(`${k}: declared ${String(want)}, found ${String(n)}`);
    }
    for (const [k, n] of declared)
      if (!observed.has(k))
        problems.push(
          `declared but gone: ${k} (${String(n)}x) — delete the entry`,
        );
    expect(problems).toEqual([]);
  });

  it('every declared skip carries a reason, and the (C) rows are named as such', () => {
    // A table of skips with blank reasons is the same document as no table.
    for (const s of DECLARED_SKIPS) {
      expect(
        s.why.length,
        `${s.file} :: ${s.guard ?? '(unconditional)'}`,
      ).toBeGreaterThan(20);
      expect(s.count).toBeGreaterThan(0);
    }
    // The credential-gated rows the plan calls (C) must still be present
    // and still be labelled, because those are the ones the DoD permits to
    // be dark and no others may join them. There were two at the S9 close;
    // v2 S6c retired the Developer ID pack row with the previous desktop
    // app, which leaves the notary row alone.
    const credentialed = DECLARED_SKIPS.filter((s) => s.why.startsWith('(C)'));
    expect(credentialed.map((s) => s.file).sort()).toEqual([
      'test/release/notarize.spec.ts',
    ]);
  });

  it('NOT VACUOUS: the scanner sees each spelling and keeps nested parens', () => {
    // ASSEMBLED, NOT SPELLED, and for once the reason is this row itself.
    // These fixtures are the inputs the scanner above is being tested on, so
    // written literally they are skip sites in a file the scanner scans, and
    // the row reports its own test data as three undeclared skips. The two
    // wrong fixes were available and both were refused: declaring them in
    // DECLARED_SKIPS would file a reason for a row that never stood down,
    // and teaching the scanner to ignore string literals would mean an
    // apostrophe in a comment could swallow a real one. The narrow fix is to
    // keep the PATTERN out of the source bytes while the VALUE stays exactly
    // what it was, which is the same idiom `test/arch.spec.ts` uses to pin
    // its ban list against the strings it bans.
    const fixture = {
      guarded: `it.${'skipIf'}(!HAS_RUBY)('x', () => {})`,
      nested: `describe.${'skipIf'}(!existsSync(join(a, b)))('x')`,
      bare: `it.${'skip'}('reserved', () => {})`,
      none: 'it("runs", () => {})',
    };
    expect(skipSitesIn(fixture.guarded)).toEqual([{ guard: '!HAS_RUBY' }]);
    expect(skipSitesIn(fixture.nested)).toEqual([
      { guard: '!existsSync(join(a, b))' },
    ]);
    expect(skipSitesIn(fixture.bare)).toEqual([{ guard: null }]);
    expect(skipSitesIn(fixture.none)).toEqual([]);
  });
});

/* ── row 6: INV-2 survived the slice ──────────────────────────────────── */

/**
 * WHY THIS ROW IS META, EXACTLY LIKE ROW 4.
 *
 * The plan worded row 6 against the previous desktop app: one outbound call
 * site in its sources, a renderer store whose bridge type was a `Pick`, and
 * a wizard test send that was the same route as every other. Each of those
 * was a guard in `test/arch.spec.ts`, and each went with the app in v2 S6c.
 * Keeping their markers here would have pinned three rows that no longer
 * guard anything; deleting this row would have dropped the question.
 *
 * What survives is the half of INV-2 that never depended on a GUI: the send
 * backend has a closed, counted set of importers, and the wire has no frame
 * that sends. The Swift app holds its own half in its hygiene tests, which
 * read its sources for every route a screen can post to. Spelling the
 * outbound verb in call position here would plant a fresh occurrence in a
 * swept file, so this row COUNTS and points, never quotes.
 */
describe('s9 Sc15 row 6: the GUI still has no path to a dispatch', () => {
  it('the two GUI-independent INV-2 guards are still in the arch file', () => {
    const arch = read('test/arch.spec.ts');
    for (const marker of [
      // Every importer of the send backend, enumerated and counted.
      'the port importer allowlist is pinned at 16 files (INV-2)',
      // No frame type is a way around an approval the daemon validated.
      'INV-2 at the wire',
    ])
      expect(arch, marker).toContain(marker);
  });

  it('the importer guard proves itself non-empty before concluding anything', () => {
    /*
     * The failure this row exists to catch has happened here once: a guard
     * whose enumeration is empty passes every subset assertion forever. The
     * importer row answers it with an exact length and an EQUALITY against
     * the live scan, so an empty scan is red rather than vacuously green. If
     * somebody relaxes either back to a `toContain`, this goes red.
     */
    const arch = read('test/arch.spec.ts');
    const row = arch.slice(
      arch.indexOf('the port importer allowlist is pinned at 16 files (INV-2)'),
    );
    expect(row).toContain('expect(PORT_IMPORTER_ALLOWLIST).toHaveLength(16)');
    expect(row).toContain(
      'expect(sendBackendChatDbReaderImporters()).toEqual(',
    );
  });

  it('S9 touched no route file that could open a second path', () => {
    /*
     * The one thing this row CAN check first-hand without re-spelling
     * anything: the daemon's route for the outbound verb is in the S9 diff
     * (F-125 moved the service verbs), so "unchanged" would be a false
     * claim. What must hold is narrower and checkable: the diff to that
     * file adds no new exported handler. The route surface itself is
     * ratcheted by row 3 above, which counts `ROUTE_TABLE` against the
     * S8-close snapshot and is the assertion that would actually catch a
     * new path.
     */
    const added = git(
      'diff',
      '--numstat',
      `${S8_CLOSE}..HEAD`,
      '--',
      'packages/daemon/src/routes/send.ts',
    ).trim();
    // Non-empty: the file IS in the S9 diff, and a row that silently
    // depended on it not being would be the vacuous kind.
    expect(added).not.toBe('');
    const body = read('packages/daemon/src/routes/send.ts');
    const exported = [
      ...body.matchAll(/^export (?:async )?function (\w+)/gm),
    ].map((m) => m[1] ?? '');
    const atS8 = [
      ...git('show', `${S8_CLOSE}:packages/daemon/src/routes/send.ts`).matchAll(
        /^export (?:async )?function (\w+)/gm,
      ),
    ].map((m) => m[1] ?? '');
    expect(exported.sort()).toEqual(atS8.sort());
  });
});

/* ── row 7: the two seams S9 swore not to touch ───────────────────────── */

describe('s9 Sc15 row 7: the seams are byte-clean, and the audit union only grew', () => {
  /** Files S9 promised not to edit at all, and the diff that proves it. */
  const FROZEN: readonly string[] = [
    // The port interfaces. S9 is a packaging and lifecycle slice; a change
    // here would mean it had reached into the domain's contracts.
    'packages/core/src/ports/index.ts',
    // The schema. A migration in a release slice is a migration nobody
    // planned, and Sc 5's downgrade refusal assumes this set is fixed.
    'packages/store/migrations/0001_init.sql',
    // The wire vocabulary. Row 3 counts it; this row proves the file
    // itself did not move under the count.
    'packages/protocol/src/events.ts',
  ];

  it('the S8-close sha still resolves to the S8-close commit', () => {
    // Without this, every diff row below is a comparison with nothing.
    expect(git('log', '-1', '--pretty=format:%s', S8_CLOSE)).toContain(
      S8_CLOSE_SUBJECT,
    );
  });

  /**
   * The commit s10 Slice 1 was built on. S9's promise is about S9, so it is
   * measured up to here. s10 is a later slice with a reviewed plan that
   * EXTENDS the port (Slice 2's getSendLedger, listRecentUnverified, the
   * sentMessageGuid CAS key); the row below holds it to growth only.
   */
  const S10_START = 'fa9a885';

  it('every frozen seam is unchanged from the S8 close to the start of s10', () => {
    expect(git('log', '-1', '--pretty=format:%s', S10_START)).toContain(
      'G2 even frost slice 2',
    );
    const moved = FROZEN.filter(
      (f) =>
        git(
          'diff',
          '--name-only',
          `${S8_CLOSE}..${S10_START}`,
          '--',
          f,
        ).trim() !== '',
    );
    expect(moved).toEqual([]);
    // NOT VACUOUS: each path must actually exist, or "unchanged" is the
    // answer a typo gives.
    for (const f of FROZEN) expect(existsSync(join(repoRoot, f)), f).toBe(true);
  });

  it('since s10 started, the schema is byte-clean, the wire grew only by F3, and the ports only grew', () => {
    expect(
      git(
        'diff',
        '--name-only',
        `${S10_START}..HEAD`,
        '--',
        'packages/store/migrations/0001_init.sql',
      ).trim(),
    ).toBe('');
    // The wire vocabulary was byte-clean through v2 F5. v2 F3 (G-06a) is the
    // first reviewed plan to add an event, `thread.state`, and it is named
    // here rather than loosening the row: the vocabulary at the start of s10
    // plus exactly that one name is the vocabulary now, nothing lost and
    // nothing else gained.
    const vocab = (text: string): string[] => {
      const block = /GATEWAY_EVENT_NAMES = \[([^\]]*)\]/.exec(text)?.[1] ?? '';
      return [...block.matchAll(/'([a-z][a-z.]*)'/g)]
        .map((m) => m[1] ?? '')
        .sort();
    };
    const wireThen = vocab(
      git('show', `${S10_START}:packages/protocol/src/events.ts`),
    );
    const wireNow = vocab(read('packages/protocol/src/events.ts'));
    expect(wireThen.length).toBe(21);
    expect(wireNow).toEqual([...wireThen, 'thread.state'].sort());
    // `added<TAB>deleted<TAB>path`. Deleted must be 0: s10 may add to the
    // contract, never take anything out of it or rewrite a line of it.
    const [added, deleted] = git(
      'diff',
      '--numstat',
      `${S10_START}..HEAD`,
      '--',
      'packages/core/src/ports/index.ts',
    )
      .trim()
      .split('\t');
    // NOT VACUOUS: s10 Slice 2 did grow the port, so an empty numstat would
    // mean this row is reading the wrong path or the wrong range.
    expect(Number(added)).toBeGreaterThan(0);
    expect(Number(deleted)).toBe(0);
  });

  /**
   * Files a LATER reviewed plan added on purpose. S9's promise is that S9
   * planted no migration; v2 F3 (G-06a) is the first plan to ship one, and
   * names it here rather than loosening the row: anything else that appears
   * is still a migration nobody planned.
   */
  const PLANNED_SINCE_S9: readonly string[] = [
    'packages/store/migrations/0002_thread_state.sql',
    // v2 F2a: the search index over the mirror (contentless FTS5 + doc map).
    'packages/store/migrations/0003_search.sql',
  ];

  it('the migrations directory gained no file a plan did not name', () => {
    const now = tracked().filter(
      (f) =>
        f.startsWith('packages/store/migrations/') &&
        !PLANNED_SINCE_S9.includes(f),
    );
    const then = git(
      'ls-tree',
      '--name-only',
      '-r',
      S8_CLOSE,
      'packages/store/migrations/',
    )
      .split('\n')
      .filter(Boolean);
    expect(now.sort()).toEqual(then.sort());
    expect(now.length).toBeGreaterThan(0);
  });

  it('the audit union grew by exactly four names, and lost none', () => {
    /*
     * `packages/core/src/audit/events.ts` IS in the S9 diff, and is meant
     * to be: Sc 2 reclaims a stale lock and Sc 3 installs, uninstalls and
     * requests an unload, and each of those is a thing the audit log has to
     * be able to say. What must hold is that the change is ADDITIVE. A
     * removed member is a log line some older row can no longer write, and
     * an audit trail that silently stops recording an event is worse than
     * one that never recorded it.
     */
    const names = (text: string): string[] =>
      [...text.matchAll(/type: '([a-z][a-z_.]*)'/g)]
        .map((m) => m[1] ?? '')
        .sort();
    const then = names(
      git('show', `${S8_CLOSE}:packages/core/src/audit/events.ts`),
    );
    const now = names(read('packages/core/src/audit/events.ts'));
    expect(then.length).toBeGreaterThan(0);
    // Nothing lost.
    expect(then.filter((n) => !now.includes(n))).toEqual([]);
    // And exactly the four the plan names gained.
    expect(now.filter((n) => !then.includes(n))).toEqual([
      'daemon.lock.stale_reclaimed',
      'service.installed',
      'service.uninstalled',
      'service.unload_requested',
    ]);
  });

  it('the diff to the audit file removed no line that names an event', () => {
    // The union-membership row above reads two snapshots; this one reads
    // the diff, so a name deleted and re-added in a different shape cannot
    // pass both.
    const removed = git(
      'diff',
      `${S8_CLOSE}..HEAD`,
      '--',
      'packages/core/src/audit/events.ts',
    )
      .split('\n')
      .filter((l) => l.startsWith('-') && !l.startsWith('---'))
      .filter((l) => /type: '[a-z]/.test(l));
    expect(removed).toEqual([]);
  });
});

/* ── row 8: nothing may disturb the agent supervising the run ─────────── */

/**
 * WHAT THE PLAN ASKED FOR, AND WHY THIS ROW IS NOT THAT.
 *
 * The plan's row 8 says to compare one specific launchd label's `print` exit
 * code before and after the run. That row cannot be written in this file, or
 * in any tracked file under these roots: the label it names contains TWO of
 * the ten strings `test/arch.spec.ts` row 4 bans from exactly here, and the
 * carrier exemption that lets the arch file discuss one of them covers
 * COMMENTS only and never covers the other. The requirement and the guard
 * contradict each other outright, and the guard is the one that ships.
 *
 * The tree had already answered this before the plan met it. `resolveSentinel`
 * in the lane helper takes the label out of the environment, for the reason it
 * gives in its own words: that string is the most dangerous one this project
 * could contain, so it is not contained, it is passed in. The lifecycle spec
 * reads the sentinel in `beforeAll` and compares it in `afterAll`, and the
 * label never appears in a tracked byte.
 *
 * WHAT WAS ACTUALLY MISSING. Above that block the lifecycle spec states a
 * rule in capital letters: if another launchd spec is ever added, it copies
 * that block verbatim. Nothing checked it. It held only because exactly one
 * spec reached the real service manager, and the release smoke spec is about
 * to be the second. A rule that lives in a comment and is enforced by nobody
 * is the same shape as the invariant Sc 7 row 14 found holding by accident.
 * So this row is that check, and it is worth more than re-reading an exit
 * code the lifecycle spec already reads twice.
 *
 * THE SET IS NOT "WHAT USES THE LANE". That was the first draft and it was
 * wrong. `packages/daemon/src/bin.ts` composes the production service runner
 * for any argv, so a spec that spawns the daemon's program root with a
 * mutating `service` verb reaches the service manager without touching the
 * lane at all, and one already does: `apps/desktop/test/bundle.spec.ts` runs
 * the packaged daemon under Electron-as-Node, kept harmless only by
 * `--no-load`. Selecting on a lane symbol would have returned the empty set
 * for precisely the spec this row exists to notice.
 *
 * v2 S6c deleted that app, and with it both of its entries below: the
 * bundle spec's port (`test/release/bundle-daemon.spec.ts`) boots the daemon
 * as the Swift host does and passes no service verb, and the release smoke
 * spec went with the Electron pack. The row is unchanged; the set shrank.
 */

/** How a spec can reach the real service manager, if it can at all. */
type Reach =
  'real lane' | 'service argv, --no-load' | 'service argv, no --no-load';

/**
 * Mutating verbs only. `install|uninstall|restart` are the three that change
 * launchd state; a wider `[a-z-]+` also matched `packages/store`'s migration
 * spec, where `'service'` is a DATABASE COLUMN sitting next to `'kind'`. The
 * fix was to narrow the detector, never to exempt the file: an allowlist that
 * grows is a guard that stops guarding.
 */
const SERVICE_ARGV_RE = /'service'\s*,\s*'(?:install|uninstall|restart)'/;
const REAL_LANE_RE = /\binstallRealLaneSpawner\(/;

function classifyReach(text: string): Reach | null {
  if (REAL_LANE_RE.test(text)) return 'real lane';
  if (!SERVICE_ARGV_RE.test(text)) return null;
  return text.includes('--no-load')
    ? 'service argv, --no-load'
    : 'service argv, no --no-load';
}

/**
 * The ratchet. Adding a spec that can reach launchd turns this row red, and
 * the only way to turn it green is to say in writing which kind of reach it
 * has. Every entry below carries the reason it is safe.
 */
const LAUNCHD_REACH: readonly (readonly [file: string, reach: Reach])[] = [
  // The user-facing CLI, which does not implement the verb: it refuses with
  // the usage exit code and prints the daemon line to run instead, so it
  // never reaches a service manager and needs no flag. Listed anyway, so the
  // day it grows a real invocation is a failing diff and not a silent one.
  ['packages/cli/test/cli-s9.spec.ts', 'service argv, no --no-load'],
  // The only spec that installs the real spawner. The witness row below is
  // written against this one.
  ['packages/daemon/test/launchd-lifecycle.spec.ts', 'real lane'],
  ['packages/daemon/test/service-cli.spec.ts', 'service argv, --no-load'],
];

/**
 * The block a real-lane spec has to carry, expressed as call counts rather
 * than by parsing hook bodies. Counting is coarse, and coarse is the point:
 * a parser would have opinions about formatting that a spec author would
 * then have to guess at, whereas "call it twice" is unambiguous. Two calls
 * to each comparison helper is what "read it once, compare it once" costs.
 */
const WITNESS: readonly (readonly [name: string, least: number])[] = [
  ['installRealLaneSpawner', 1],
  ['resolveSentinel', 1],
  ['readSentinel', 2],
  ['launchAgentsTripwire', 2],
];

function witnessShortfalls(file: string, text: string): string[] {
  const out: string[] = [];
  for (const [name, least] of WITNESS) {
    const seen = [...text.matchAll(new RegExp(`\\b${name}\\(`, 'g'))].length;
    if (seen < least)
      out.push(
        `${file}: calls ${name} ${String(seen)}x, needs ${String(least)}x`,
      );
  }
  if (!text.includes('afterAll('))
    out.push(`${file}: no afterAll, so nothing compares what was read`);
  return out;
}

describe('s9 Sc15 row 8: the launchd witness every real-lane spec must carry', () => {
  it('the four names this row is written against still exist', () => {
    // Imported rather than searched for, so a rename is a TYPE error in this
    // project's typecheck as well as a red row here. A row that greps for
    // symbol names goes quietly green when the symbols are renamed.
    expect([
      typeof installRealLaneSpawner,
      typeof resolveSentinel,
      typeof readSentinel,
      typeof launchAgentsTripwire,
    ]).toEqual(['function', 'function', 'function', 'function']);
  });

  it('the specs that can reach the service manager are exactly these', () => {
    const found: (readonly [string, Reach])[] = [];
    for (const file of tracked()) {
      if (!file.endsWith('.spec.ts')) continue;
      const reach = classifyReach(read(file));
      if (reach !== null) found.push([file, reach]);
    }
    expect(found).toEqual(LAUNCHD_REACH);
  });

  it('every spec that reaches it for real carries the witness', () => {
    const real = LAUNCHD_REACH.filter(([, reach]) => reach === 'real lane');
    // Non-vacuity: an empty set would make the sweep below trivially clean,
    // and a refactor that deleted the last real-lane spec would then read as
    // a pass rather than as the removal of the thing being guarded.
    expect(real.length).toBeGreaterThan(0);
    expect(
      real.flatMap(([file]) => witnessShortfalls(file, read(file))),
    ).toEqual([]);
  });

  it('NOT VACUOUS: the same checker reports a copy with the witness removed', () => {
    const file = 'packages/daemon/test/launchd-lifecycle.spec.ts';
    const gutted = read(file).replace(/\breadSentinel\(/g, 'notTheWitness(');
    expect(witnessShortfalls(file, gutted)).toEqual([
      `${file}: calls readSentinel 0x, needs 2x`,
    ]);
  });

  it('the label is passed in, and an absent one refuses rather than passes', () => {
    const lane = read('packages/daemon/test/helpers/launchd-lane.ts');
    // Two halves of one decision: the label comes from the environment, and
    // an environment that names nothing makes the row throw instead of
    // quietly comparing a machine against itself.
    expect(lane).toContain("env['WEMESSAGE_F120_SENTINEL_LABEL']");
    expect(lane).toContain('refusing to run it vacuously');
    // And the ban that keeps that label out of every tracked file is still
    // where this row delegates it to.
    expect(read('test/arch.spec.ts')).toContain(
      'row 4: no tracked file names a launchd verb that kills',
    );
  });
});

/* ── row 9: one version, everywhere ───────────────────────────────────── */

describe('s9 Sc15 row 9: every manifest carries the same version', () => {
  const manifests = (): { file: string; version: string; name: string }[] =>
    tracked()
      .filter((f) => f === 'package.json' || f.endsWith('/package.json'))
      .map((f) => {
        const j = JSON.parse(read(f)) as {
          name?: string;
          version?: string;
        };
        return {
          file: f,
          version: j.version ?? '(none)',
          name: j.name ?? '(root)',
        };
      });

  it('all seventeen manifests are at one version, and it is an rc', () => {
    /*
     * Seventeen: sixteen workspace packages plus the monorepo root (eighteen
     * until v2 S6c deleted the previous desktop app's manifest). Read
     * from `git ls-files` rather than from a glob over the working tree, so
     * an untracked scratch package cannot join the set and an ignored one
     * cannot leave it.
     */
    const all = manifests();
    expect(all).toHaveLength(17);
    const versions = [...new Set(all.map((m) => m.version))];
    expect(versions).toEqual(['1.0.0-rc.1']);
  });

  it('the version is a real prerelease, so the release job marks it one', () => {
    // `workflows.spec.ts` row 7 asserts the release is prereleased BY
    // VERSION rather than by lane. That row is only meaningful if the
    // version actually parses as a prerelease, which is this assertion.
    const root = manifests().find((m) => m.file === 'package.json');
    expect(root, 'the monorepo root manifest').toBeDefined();
    const version = root?.version ?? '';
    expect(version).toMatch(/^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/);
  });

  it('no manifest is missing a version, and none carries a range', () => {
    for (const m of manifests()) {
      expect(m.version, m.file).not.toBe('(none)');
      expect(m.version, m.file).not.toMatch(/[\^~*x]/);
    }
  });
});

/* ── row 10: the lanes CI actually runs ───────────────────────────────── */

describe('s9 Sc15 row 10: the five workflows exist and the guard over them has teeth', () => {
  const WORKFLOWS = [
    '.github/workflows/ci-linux.yml',
    '.github/workflows/ci-macos.yml',
    '.github/workflows/ci-python.yml',
    // v2 S1: the Swift kit's lane. workflows.spec.ts sweeps it (rows 5c,
    // 8, 11, 12) and test/arch.spec.ts 'v2 S1: the Swift tree' pins it.
    '.github/workflows/ci-swift.yml',
    '.github/workflows/release.yml',
  ] as const;

  it('the workflow set is exactly these five', () => {
    // Equality. A sixth workflow is a sixth thing that can push, publish or
    // hold a secret, and `workflows.spec.ts` rows 5 and 5c enumerate
    // secrets per FILE: a file they have never seen is a file they do not
    // check.
    expect(
      tracked()
        .filter((f) => f.startsWith('.github/workflows/'))
        .sort(),
    ).toEqual([...WORKFLOWS].sort());
  });

  it('each workflow declares at least one job and every job pins a runner', () => {
    for (const w of WORKFLOWS) {
      const text = read(w);
      /*
       * Only the keys under `jobs:`. A two-space key elsewhere in the file
       * is a trigger (`push:`, `pull_request:`) or a permission, and
       * counting those made the first draft of this row demand three
       * runners from a workflow that correctly has one. The slice runs from
       * `jobs:` to the next column-zero key, which is how the YAML scopes
       * it too.
       */
      const afterJobs = text.slice(text.indexOf('\njobs:') + 1);
      const nextTop = afterJobs.slice(1).search(/\n[A-Za-z]/);
      const block =
        nextTop === -1 ? afterJobs : afterJobs.slice(0, nextTop + 1);
      const jobs = [...block.matchAll(/^ {2}([a-z][\w-]*):$/gm)].map(
        (m) => m[1] ?? '',
      );
      expect(jobs.length, w).toBeGreaterThan(0);
      const runners = [...block.matchAll(/^\s+runs-on: (\S+)$/gm)].map(
        (m) => m[1] ?? '',
      );
      expect(runners.length, `${w}: a job without runs-on`).toBe(jobs.length);
      // Pinned images, never `latest` on macOS, where the runner image is
      // the difference between a build that signs and one that cannot.
      for (const r of runners)
        if (r.startsWith('macos')) expect(r, w).not.toContain('latest');
    }
  });

  it('the macOS CI workflow is the node gate on the release the app targets', () => {
    /*
     * v2 S6b. This row used to require `pack-adhoc`, the Electron pack job.
     * The Electron bundle no longer ships: the app a user downloads is the
     * Swift one, packed by `release.yml`'s `pack-swift` and built on every
     * push by ci-swift. ci-macos is now the Node gate on macOS 26, the floor
     * the app declares, and it must not grow a pack job back.
     */
    const macos = read('.github/workflows/ci-macos.yml');
    expect(macos).toContain('runs-on: macos-26');
    // `test:node` was the desktop-excluding script; v2 S6c deleted the app,
    // so the whole suite IS the node suite and the script is plain `test`.
    expect(macos).toContain('run: pnpm test\n');
    expect(macos).not.toContain('pack-adhoc');
    expect(macos).not.toContain('electron');
  });

  it('the Sc9 guard over the workflows is still in the tree and still counts', () => {
    // META, for the same reason row 6 is: `test/release/workflows.spec.ts`
    // already holds eighteen rows over these files, and a second copy here
    // would be the weaker one. What this asserts is that it exists, that it
    // reads every workflow, and that its two ratchets are still numbers.
    const guard = read('test/release/workflows.spec.ts');
    for (const w of WORKFLOWS)
      expect(guard, w).toContain(w.split('/').pop() ?? '');
    for (const marker of [
      'row 2: exactly two jobs',
      'row 5: names exactly the four allowed secrets',
      'row 8: every `uses:` is a 40-hex SHA',
      'row 9: ci-macos is one node-gate job on macos-26',
    ])
      expect(guard, marker).toContain(marker);
  });
});
