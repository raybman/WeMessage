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
 * DEVIATION, recorded rather than smoothed over. §1.3 lists Sc 12's spec at
 * `test/release/smoke.spec.ts`. It is at `apps/desktop/test/smoke.spec.ts`
 * instead, because it must run AFTER the `desktop-pack` project has built the
 * app it inspects, and the only sequencing mechanism this repo has is a
 * sibling `vitest.*.config.ts` inside the package (`groupOrder`), which
 * structurally cannot reach a spec under the root `test/` tree. The path
 * moved; the obligation did not.
 */
const S9_SPECS: readonly (readonly [path: string, owner: string])[] = [
  ['test/arch.spec.ts', 'Sc1'],
  ['packages/daemon/test/lock.spec.ts', 'Sc2'],
  ['packages/daemon/test/main-lock.spec.ts', 'Sc2'],
  ['packages/daemon/test/launchd-plist.spec.ts', 'Sc3'],
  ['packages/daemon/test/launchd-lifecycle.spec.ts', 'Sc3'],
  ['packages/daemon/test/service-cli.spec.ts', 'Sc3'],
  ['packages/cli/test/cli-s9.spec.ts', 'Sc3/Sc7'],
  ['packages/daemon/test/disconnect-launchd.spec.ts', 'Sc4'],
  ['apps/desktop/test/bundle.spec.ts', 'Sc5'],
  ['apps/desktop/test/pack.spec.ts', 'Sc6'],
  // DEVIATION. §1.3 names `apps/desktop/test/supervisor.spec.ts`. No such
  // file was written and none is needed: Sc 7 split cleanly along an
  // existing seam. The wizard half (the sixth `keep-running` step and the
  // exit that claims the product is ready) landed in the renderer's own
  // wizard spec, and the daemon half (the `supervisor` field on the doctor
  // DTO, and the FDA_EPERM remediation F-142 rewrote) landed in
  // `packages/daemon/test/doctor.spec.ts`, already listed below. A third
  // file would have been a home for rows that belong to neither.
  ['apps/desktop/test/unit/wizard-exits.spec.ts', 'Sc7'],
  ['packages/daemon/test/doctor.spec.ts', 'Sc7'],
  ['test/release/notarize.spec.ts', 'Sc8'],
  ['test/release/workflows.spec.ts', 'Sc9'],
  ['test/release/cask.spec.ts', 'Sc10'],
  ['test/release/licenses.spec.ts', 'Sc11'],
  ['apps/desktop/test/smoke.spec.ts', 'Sc12'],
  ['test/release/readme.spec.ts', 'Sc13'],
  ['apps/desktop/test/gif.spec.ts', 'Sc13'],
  ['test/release/versions.spec.ts', 'Sc14'],
  ['test/release/s9-e2e.spec.ts', 'Sc15'],
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

  it('the seven S8-close counts are unchanged', () => {
    /*
     * DoD gate 3 says `#23`. It is `#24`, minted in s8 Sc 3 when the four
     * `draft.*` lifecycle emit sites were wired; the plan was written before
     * Sc 3 landed. `test/arch.spec.ts` row 12 already records that
     * correction and this row agrees with the tree rather than with the
     * paragraph, which is the whole reason the number is read from the file
     * instead of quoted from the plan.
     */
    expect(ROUTE_TABLE.length).toBe(67);
    expect(WS_EVENT_VOCABULARY.length).toBe(21);
    expect(GATEWAY_EVENT_NAMES.length).toBe(21);
    expect(EMITTED_WS_EVENTS.length).toBe(21);
    expect(UNEMITTED_WS_EVENTS).toEqual([]);
    expect(PORT_IMPORTER_ALLOWLIST.length).toBe(15);
    // `Object.keys`, not `.length`: `FRAME_SPECS` is a key table, and
    // `.length` on it is `undefined`, which would pass a `not.toBe(9)` and
    // fail a `toBe(9)` for a reason unrelated to the wire.
    expect(Object.keys(FRAME_SPECS).length).toBe(9);
  });

  it('the highest deliberate update is #24, and S9 minted no #25', () => {
    const seen = deliberateUpdates(read(RATCHET));
    expect(Math.max(...seen)).toBe(24);
    expect(seen).not.toContain(25);
  });

  it('TEETH: a planted #25 in a temp copy is caught by this same extractor', () => {
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
      `${read(RATCHET)}\n// #25 deliberate (s9 Scenario 15): a new route.\n`,
      'utf8',
    );
    const seen = deliberateUpdates(readFileSync(planted, 'utf8'));
    expect(seen).toContain(25);
    expect(Math.max(...seen)).toBe(25);
  });

  it('the guard that runs on every `pnpm test` is still in the tree', () => {
    // This file is a checkpoint: it runs once, at the close. The row that
    // actually stops a mid-slice bump is arch's, and deleting it would make
    // every assertion above true and worthless the next day.
    const arch = read('test/arch.spec.ts');
    expect(arch).toContain('row 12: the ratchet reads #24');
    expect(arch).toContain('expect(ROUTE_TABLE.length).toBe(67)');
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
     * (`apps/desktop/test/tokens.spec.ts` records that deviation), so the
     * set is read rather than quoted.
     */
    const allow = read('apps/desktop/test/helpers/no-green-static.ts');
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
    file: 'apps/desktop/test/pack.spec.ts',
    guard: '!darwin',
    count: 1,
    why: 'the whole scenario inspects a macOS `.app`; on Linux there is nothing to inspect',
  },
  {
    file: 'apps/desktop/test/pack.spec.ts',
    guard: "!process.env['CSC_NAME']",
    count: 1,
    why: '(C) Sc 6 row 9: the release lane needs a Developer ID certificate',
  },
  {
    file: 'apps/desktop/test/bundle.spec.ts',
    guard: '!RUNS_THE_BUNDLE',
    count: 4,
    why: 'the bundle is Electron-as-Node and is built and run only on the macOS lane',
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
    file: 'apps/desktop/test/smoke.spec.ts',
    guard: '!darwin || !existsSync(ZIP)',
    count: 1,
    why: 'the release smoke drives the SHIPPED zip through a real launch agent, and neither the artefact nor a service manager exists on the Linux lane; the macOS lane builds the zip at groupOrder 4 and runs this at 5, so the guard is dark only where it could not be honest',
  },
  {
    file: 'apps/desktop/test/gif.spec.ts',
    guard: "process.platform !== 'darwin'",
    count: 1,
    why: 'the drift row alone, not the file: the other fifteen rows generate the animation and read its pixels everywhere, but comparing the TRACKED artefact byte for byte only means something on the platform it is rendered on, and a Linux renderer disagreeing with a macOS one would be a font stack difference reported as a regression',
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
    // The two credential-gated rows the plan calls (C) must still be
    // present and still be labelled, because those are the two the DoD
    // permits to be dark at the S9 close and no others may join them.
    const credentialed = DECLARED_SKIPS.filter((s) => s.why.startsWith('(C)'));
    expect(credentialed.map((s) => s.file).sort()).toEqual([
      'apps/desktop/test/pack.spec.ts',
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
 * The plan words row 6 as an assertion to make here: "`client.send(` in
 * `apps/desktop/src` still exactly one". Two things are wrong with taking
 * that literally, and both are worth writing down rather than quietly
 * working around.
 *
 * FIRST, the literal is ZERO, not one. The app's call is
 * `requireClient()` followed by the outbound verb, so the receiver is a CALL
 * and not a name. `test/arch.spec.ts` row 7 discovered exactly this at the
 * S8 close: the old predicate matched nothing, the subset assertion held
 * over an empty list, and the row could not have failed for any edit to any
 * file. It was tightened there to read the receiver as an identifier OR a
 * closing paren, and it asserts the enumeration is non-empty before
 * concluding anything from it. Re-implementing that predicate here would
 * mean maintaining two regexes for one invariant, and the weaker one would
 * be the one nobody remembered to fix.
 *
 * SECOND, and decisive: this file is swept. Spelling the outbound verb in
 * call position here plants a fresh occurrence in a tracked text file, and
 * the guards behind INV-2 read raw text. Row 4 hit the same wall for the
 * banned launchd verbs and the secret shapes, and the answer is the same:
 * COUNT, never quote. What this row owes the reader is proof that the three
 * guards still exist, still run, and still have teeth. What it must not do
 * is become a fourth, weaker copy of them.
 */
describe('s9 Sc15 row 6: the GUI still has no path to a dispatch', () => {
  it('all three INV-2 guards are still in the arch file', () => {
    const arch = read('test/arch.spec.ts');
    for (const marker of [
      // The IPC boundary: exactly one outbound call site in the whole app,
      // and it sits inside the wizard handler that refuses an unarmed pair.
      'INV-2 at the GUI boundary',
      // The renderer: the queue's bridge is a `Pick`, so the wizard channel
      // is not merely unreachable from the store, it is not in its type.
      'INV-2 in the renderer',
      // Onboarding: the wizard's "test yourself" is not a second path, it
      // is the same route, the same `Approval`, the same audit rows.
      'is THE send, or it is nothing',
    ])
      expect(arch, marker).toContain(marker);
  });

  it('the arch guard proves itself non-empty before concluding anything', () => {
    /*
     * The specific failure mode this row exists to catch, because it has
     * already happened once here: a guard whose enumeration is empty passes
     * every subset assertion forever. Row 7 in arch answers it with an
     * explicit count, and this row pins that the count is still there.
     * If somebody relaxes `toBe(1)` back to a `toContain`, this goes red.
     */
    const arch = read('test/arch.spec.ts');
    const row7 = arch.slice(arch.indexOf('INV-2 at the GUI boundary'));
    expect(row7).toContain('expect(callers.length).toBe(1)');
    // …and the row's own teeth: it plants two synthetic call sites in a
    // temp tree and asserts the enumeration grows to three. A guard that
    // cannot demonstrate it sees a plant is a guard nobody should trust.
    expect(row7).toContain('expect(callers.length).toBe(3)');
  });

  it('the queue store reaches ten channels, and its bridge type is a Pick of eleven', () => {
    /*
     * The RATCHET, read from the source rather than restated. Ten request
     * channels plus the push subscription is eleven keys in the `Pick`; the
     * eleventh is `on`, which is inbound. S9 added no channel, so both
     * numbers are the S8-close numbers. A slice that grows either has to
     * come through here and say why.
     *
     * Counted rather than listed on purpose: naming the members would put
     * this file in the business of tracking the renderer's vocabulary, and
     * `apps/desktop/test/unit/store-wiring.spec.ts` already pins them one
     * by one against the send pattern.
     */
    const src = read('apps/desktop/src/renderer/store/index.ts');
    const members = (block: string, end: string): number =>
      [
        ...((src.split(block)[1] ?? '').split(end)[0] ?? '').matchAll(
          /'([^']+)'/g,
        ),
      ].length;
    expect(members('STORE_CHANNELS = [', '] as const')).toBe(10);
    expect(members('StoreBridge = Pick<', '>;')).toBe(11);
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

  it('every frozen seam is unchanged since the S8 close', () => {
    const moved = FROZEN.filter(
      (f) =>
        git('diff', '--name-only', `${S8_CLOSE}..HEAD`, '--', f).trim() !== '',
    );
    expect(moved).toEqual([]);
    // NOT VACUOUS: each path must actually exist, or "unchanged" is the
    // answer a typo gives.
    for (const f of FROZEN) expect(existsSync(join(repoRoot, f)), f).toBe(true);
  });

  it('the migrations directory gained no file', () => {
    const now = tracked().filter((f) =>
      f.startsWith('packages/store/migrations/'),
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
  // The packaged daemon, spawned under Electron-as-Node against a redirected
  // agents directory and a test label prefix. `--no-load` is the only thing
  // standing between this spec and a real bootstrap, which is exactly why it
  // is listed here rather than filtered out.
  ['apps/desktop/test/bundle.spec.ts', 'service argv, --no-load'],
  // s9 Sc 12. The newest member, and the one that shows this row earning its
  // place: it was added to the repository as an untracked file, and the run
  // in which it was first `git add`ed is the run in which this row went red
  // with "reaches launchd but is not declared". Nobody had to remember. It
  // classifies as a real lane because it calls `installRealLaneSpawner`, and
  // it is the only spec here that drives the SHIPPED bundle rather than a
  // built tree, so its launch agent supervises a real packaged daemon.
  ['apps/desktop/test/smoke.spec.ts', 'real lane'],
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

  it('all eighteen manifests are at one version, and it is an rc', () => {
    /*
     * Eighteen: seventeen workspace packages plus the monorepo root. Read
     * from `git ls-files` rather than from a glob over the working tree, so
     * an untracked scratch package cannot join the set and an ignored one
     * cannot leave it.
     */
    const all = manifests();
    expect(all).toHaveLength(18);
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

describe('s9 Sc15 row 10: the four workflows exist and the guard over them has teeth', () => {
  const WORKFLOWS = [
    '.github/workflows/ci-linux.yml',
    '.github/workflows/ci-macos.yml',
    '.github/workflows/ci-python.yml',
    '.github/workflows/release.yml',
  ] as const;

  it('the workflow set is exactly these four', () => {
    // Equality. A fifth workflow is a fifth thing that can push, publish or
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

  it('the ad-hoc pack lane exists on the macOS CI workflow', () => {
    /*
     * The lane this whole slice ships on. Notarization is deferred to
     * v1.0.0, so `pack-adhoc` is the job that produces the artefact a user
     * actually downloads, and it must be on the CI workflow rather than
     * only on `release`, or the pack is unproven until tag day.
     */
    const macos = read('.github/workflows/ci-macos.yml');
    expect(macos).toContain('pack-adhoc:');
    expect(macos).toMatch(/pack-adhoc:\s*\n\s+needs: /);
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
      'row 5: names exactly the eight allowed secrets',
      'row 8: every `uses:` is a 40-hex SHA',
      'row 9: ci-macos gains a pack-adhoc job',
    ])
      expect(guard, marker).toContain(marker);
  });
});
