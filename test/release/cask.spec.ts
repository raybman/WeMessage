import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  CASK_STANZA_ORDER,
  CaskRepoInvalid,
  CaskSha256Invalid,
  CaskVersionInvalid,
  renderCask,
} from '../../tools/release/src/cask.js';

// s9 Sc10: the Homebrew cask renderer.
//
// `renderCask` is a PURE function: {version, sha256, repo} in, a complete
// Ruby cask body out, no filesystem access (mirrors `tools/release/src/
// notarize.ts`'s pure state machine, see that file's own doc comment for
// the fuller argument). Everything that touches disk, `.github/workflows/
// release.yml`'s `pnpm release:cask --dmg ...` call included, lives in
// `tools/release/bin/cask.mjs`, which this file does not import: a CLI
// wrapper's job is to get bytes from argv/disk to the pure function and the
// rendered string back to disk, and a bug in that plumbing should never be
// indistinguishable from a bug in the render itself.
//
// WHY A LINE REGEX, NOT A RUBY PARSER: this suite has no Ruby AST available
// to it (adding one would be a `tools/`-fence violation the moment it tried
// to import a gem's worth of anything), so "stanzas are in the canonical
// order" is checked the same way `brew style`'s human reader would notice
// a misplaced stanza: read the file top to bottom, keep only the lines
// that start a top-level stanza. That is only a faithful proxy if every
// top-level stanza starts at a KNOWN, FIXED indent and nothing nested
// shares it, which is why the renderer's contract (documented again next
// to CASK_STANZA_ORDER in cask.ts) is: top-level stanzas sit at exactly
// two spaces, everything nested (the `url :url` inside `livecheck`, the
// continuation lines of `uninstall`, the body of the `zap` array, the
// caveats heredoc) sits at four or more. Row 1's regex is anchored to that
// contract; row 9 depends on the SAME contract to avoid colliding with it.
//
// WHY EMPIRICAL RUBY/BREW CHECKS AT ALL: a hand-rolled regex can confirm
// this suite's OWN opinions about the output, but it cannot confirm the
// output is valid Ruby, still less that Homebrew's own cop suite is happy
// with it. `ruby -c` and `brew style`/`brew audit` are the actual
// authorities on those two questions respectively, so rows 1 and 7 shell
// out to them instead of re-implementing any part of what they check.
// Neither tool is guaranteed to be on every machine or CI runner this
// suite ever runs on (a Linux runner may have ruby but not brew, for
// instance), so both rows are `skipIf`-ed on the tool's absence, counted
// as a skip rather than silently omitted: see the vitest summary line
// this suite reports, not just "did it exit 0".

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const CASK_RB_PATH = join(REPO, 'homebrew', 'Casks', 'wemessage.rb');
const LOCK_PATH = join(REPO, 'homebrew', 'cask.lock.json');
const README_PATH = join(REPO, 'homebrew', 'README.md');
const BUILDER_YML_PATH = join(REPO, 'apps', 'desktop', 'electron-builder.yml');

// FACTS (s9 Sc10): the repo this cask tracks releases from. Fixed, not an
// input the lock file carries, because it does not change release to
// release the way {version, sha256} do; see row 5's own comment.
const REPO_SLUG = 'raybman/WeMessage';

// A syntactically valid 64-lowercase-hex sha256 for the rows that only
// need "a well-formed digest", not "the real digest of a real DMG" (that
// is row 5's and row 8's concern, sourced from the committed lock file and
// a packed artefact respectively, neither of which this constant touches).
const SHA_64 = '0123456789abcdef'.repeat(4);

function commandExists(cmd: string): boolean {
  const result = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
  const err = result.error as NodeJS.ErrnoException | undefined;
  return !(err && err.code === 'ENOENT');
}

const HAS_RUBY = commandExists('ruby');
const HAS_BREW = commandExists('brew');

describe('s9 Sc10: the Homebrew cask renderer (tools/release/src/cask.ts)', () => {
  it.skipIf(!HAS_RUBY)(
    'row 1: valid Ruby, and stanzas appear in the canonical Homebrew order',
    () => {
      const rb = renderCask({
        version: '1.0.0-rc.1',
        sha256: SHA_64,
        repo: REPO_SLUG,
      });

      // `ruby -c` only checks SYNTAX, never the DSL's semantics: it would
      // happily accept a cask with every stanza in the wrong order, or
      // with a top-level method call brew has never heard of. It still
      // earns its own assertion, because it is the one check in this row
      // that would point at an unbalanced quote or a dangling comma
      // directly, instead of the line regex below just quietly finding
      // nothing where it expected a stanza.
      const syntax = spawnSync('ruby', ['-c'], { input: rb, encoding: 'utf8' });
      expect(syntax.stdout + syntax.stderr).toContain('Syntax OK');
      expect(syntax.status).toBe(0);

      // Anchored to EXACTLY two leading spaces: the top-level stanza indent
      // inside `cask "wemessage" do ... end`. Anything nested one level
      // deeper (the `url :url` inside `livecheck do ... end`, the
      // continuation lines of `uninstall`, the body of the `zap` array,
      // the caveats heredoc) sits at four-plus and is invisible to this
      // pattern. Without that anchor, `url :url` inside livecheck (row 9)
      // would read as a second top-level `url` stanza and this row could
      // never pass at the same time as that one.
      const STANZA_LINE =
        /^ {2}(version|sha256|url|name|desc|homepage|livecheck|depends_on|app|binary|uninstall|zap|caveats)\b/gm;
      const found = [...rb.matchAll(STANZA_LINE)].map((m) => m[1]);

      // Transcribed independently from the FACTS this suite was given,
      // not read back from CASK_STANZA_ORDER, so a renderer bug that
      // happens to match its OWN (wrong) exported contract still gets
      // caught here.
      expect(found).toEqual([
        'version',
        'sha256',
        'url',
        'name',
        'desc',
        'homepage',
        'livecheck',
        'depends_on',
        'depends_on',
        'app',
        'binary',
        'binary',
        'uninstall',
        'zap',
        'caveats',
      ]);

      // The renderer's own exported contract, checked separately: this
      // catches the OTHER class of bug, where CASK_STANZA_ORDER drifts
      // from what the template actually emits (someone updates one and
      // not the other).
      expect(found).toEqual(CASK_STANZA_ORDER);
    },
  );

  it('row 2: url interpolates #{version} literally, sha256 is the argument, depends_on macos/arch', () => {
    const rb = renderCask({
      version: '1.0.0-rc.1',
      sha256: SHA_64,
      repo: REPO_SLUG,
    });

    // The LITERAL string '#{version}', not the interpolated value: a point
    // release must be a one-line diff to the `version` stanza alone, and
    // if the url line ever baked in '1.0.0-rc.1' instead of the
    // placeholder, this exact assertion is what would still find
    // '#{version}' missing and fail, rather than passing by accident
    // because '1.0.0-rc.1' happens to appear somewhere else in the file.
    expect(rb).toContain(
      'url "https://github.com/raybman/WeMessage/releases/download/v#{version}/WeMessage-#{version}-arm64-UNSIGNED.dmg"',
    );
    expect(rb).not.toContain('/v1.0.0-rc.1/');
    expect(rb).not.toContain('WeMessage-1.0.0-rc.1-arm64-UNSIGNED.dmg');

    expect(rb).toContain(`sha256 "${SHA_64}"`);
    // Bare `:sequoia`, not a `">= :sequoia"` comparison string: Homebrew's
    // own `Homebrew/OSDependsOn` style cop (see row 7) treats the symbol
    // form of `depends_on macos:` as already meaning "this OS or later",
    // so a `>=` string is redundant, not more precise, and `brew style
    // --fix` rewrites it on sight.
    expect(rb).toContain('depends_on macos: :sequoia');
    expect(rb).toContain('depends_on arch: :arm64');
  });

  it('row 3: uninstall has exactly launchctl/quit/delete, and nothing else', () => {
    const rb = renderCask({
      version: '1.0.0-rc.1',
      sha256: SHA_64,
      repo: REPO_SLUG,
    });

    // Captured as ONE exact block, not probed key by key: "and nothing
    // else" is a claim about the ABSENCE of a fourth key, and the only way
    // an absence claim is actually tested is a full-block equality. Three
    // separate `toContain`s would sail straight through a fourth,
    // unasserted key. This is exactly the shape of TN-uninstall-forgets-
    // the-agent (see this suite's Teeth step): dropping the `launchctl:`
    // line still leaves valid, brew-style-clean Ruby behind, and only an
    // exact match on the whole stanza notices it is gone.
    const uninstallMatch = /^ {2}uninstall[\s\S]*?(?=\n\n)/m.exec(rb);
    expect(uninstallMatch?.[0]).toBe(
      // Values, not just keys, aligned to the widest key ("launchctl:")
      // per RuboCop's Layout/HashAlignment as `brew style --fix` (row 7)
      // actually rewrites this stanza: verified empirically against a
      // real tap during Sc10's GREEN step, not guessed from convention.
      [
        '  uninstall launchctl: "sh.wemessage.gateway",',
        '            quit:      "sh.wemessage.gateway",',
        '            delete:    "~/Library/LaunchAgents/sh.wemessage.gateway.plist"',
      ].join('\n'),
    );

    const zapMatch = /^ {2}zap trash: \[[\s\S]*?\n {2}\]/m.exec(rb);
    expect(zapMatch?.[0]).toBe(
      [
        '  zap trash: [',
        '    "~/Library/Application Support/WeMessage",',
        '    "~/Library/Logs/WeMessage",',
        '    "~/Library/Preferences/sh.wemessage.gateway.plist",',
        '    "~/Library/Saved Application State/sh.wemessage.gateway.savedState",',
        '  ]',
      ].join('\n'),
    );
  });

  it('row 4: caveats names the permissions, the Gatekeeper flow and the right install verb; no hex colour, no handle', () => {
    const rb = renderCask({
      version: '1.0.0-rc.1',
      sha256: SHA_64,
      repo: REPO_SLUG,
    });

    const caveatsIdx = rb.indexOf('  caveats do');
    expect(caveatsIdx).toBeGreaterThan(-1);
    const caveatsBlock = rb.slice(caveatsIdx);

    expect(caveatsBlock).toContain('Full Disk Access');
    expect(caveatsBlock).toContain('Automation');

    /*
     * THE VERB IS ON THE DAEMON. `service install|uninstall|status` are
     * defined in `packages/daemon/src/launchd/cli.ts`; the control CLI has
     * no `service` command at all, so an operator who copies the caveats
     * line as it used to read gets commander's "unknown command" and exit
     * 2 as the very first thing this program ever says to them.
     *
     * This row asserted the wrong string until now, which is why nothing
     * caught it. That is a MIS-TRANSCRIPTION of the plan, not a guard being
     * relaxed: `docs/plans/slices/s9-execution.md:522` names
     * `wemessaged service install`, and the assertion below restores it.
     * The negative is what makes the pair non-vacuous. `\b` after
     * `wemessage` cannot match inside `wemessaged`, since `d` is a word
     * character, so the two assertions genuinely disagree with each other.
     */
    expect(caveatsBlock).toContain('wemessaged service install');
    expect(rb).not.toMatch(/\bwemessage service\b/);

    /*
     * AND THE STEP BEFORE ANY OF THAT. This cask ships an unsigned build,
     * Homebrew quarantines what it downloads exactly as a browser would,
     * and macOS 15 removed the right-click-Open escape hatch for unsigned
     * apps. So the very first thing that happens after a successful `brew
     * install --cask` is a refusal, and the caveats block is the only text
     * the operator is shown between those two events. A cask that installs
     * an app the operator cannot then open has not installed anything.
     */
    expect(caveatsBlock).toContain('UNSIGNED');
    expect(caveatsBlock).toContain('Open Anyway');
    expect(caveatsBlock).toContain('com.apple.quarantine');

    // No hex colour, checked across the WHOLE rendered string rather than
    // only inside caveats: a colour is exactly the kind of thing that
    // leaks in from a copy-pasted brand snippet, and nothing about this
    // renderer's other stanzas has a legitimate reason to contain one.
    // '#{version}' and '#{appdir}' do not false-positive here: a Ruby
    // interpolation opens with '{', never a hex digit, immediately after
    // the '#'.
    expect(rb).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    // No social handle: an '@' followed by a plausible handle. Nothing in
    // this renderer's vocabulary (paths, a GitHub owner/repo slug, Ruby
    // symbols) legitimately contains a bare '@word'.
    expect(rb).not.toMatch(/@\w[\w-]{1,30}\b/);
  });

  describe('row 5: the committed cask is generated, never hand-edited', () => {
    it('homebrew/Casks/wemessage.rb on disk equals renderCask() of the committed lock file', () => {
      const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as {
        version: string;
        sha256: string;
      };
      const expected = renderCask({
        version: lock.version,
        sha256: lock.sha256,
        // repo is fixed (FACTS, s9 Sc10): not part of the lock file, which
        // tracks only the two fields that change release to release.
        repo: REPO_SLUG,
      });
      const onDisk = readFileSync(CASK_RB_PATH, 'utf8');
      expect(onDisk).toBe(expected);
    });
  });

  describe('row 6: renderCask refuses malformed input, by a distinct error class per defect', () => {
    const valid = { version: '1.0.0-rc.1', sha256: SHA_64, repo: REPO_SLUG };

    it('a non-semver version', () => {
      expect(() => renderCask({ ...valid, version: '1.0' })).toThrow(
        CaskVersionInvalid,
      );
      expect(() => renderCask({ ...valid, version: 'v1.0.0' })).toThrow(
        CaskVersionInvalid,
      );
      expect(() => renderCask({ ...valid, version: '' })).toThrow(
        CaskVersionInvalid,
      );
    });

    it('a sha256 that is not exactly 64 lowercase hex characters', () => {
      expect(() =>
        renderCask({ ...valid, sha256: SHA_64.toUpperCase() }),
      ).toThrow(CaskSha256Invalid);
      expect(() =>
        renderCask({ ...valid, sha256: SHA_64.slice(0, 63) }),
      ).toThrow(CaskSha256Invalid);
      expect(() =>
        renderCask({ ...valid, sha256: `${SHA_64.slice(0, 63)}g` }),
      ).toThrow(CaskSha256Invalid);
    });

    it('a repo that is not exactly owner/name', () => {
      expect(() => renderCask({ ...valid, repo: 'raybman' })).toThrow(
        CaskRepoInvalid,
      );
      expect(() =>
        renderCask({ ...valid, repo: 'raybman/We Message' }),
      ).toThrow(CaskRepoInvalid);
      expect(() => renderCask({ ...valid, repo: 'a/b/c' })).toThrow(
        CaskRepoInvalid,
      );
    });

    it('three distinct classes, not one shared one doing triple duty', () => {
      // instanceof only means something if a catch site can tell these
      // apart. A single shared `CaskInputInvalid` would pass every
      // `toThrow(...)` above too (a subtype check is satisfied by an exact
      // match), so that failure mode needs its own assertion, not a hope
      // that the three tests above happen to imply it.
      expect(CaskVersionInvalid).not.toBe(CaskSha256Invalid);
      expect(CaskSha256Invalid).not.toBe(CaskRepoInvalid);
      expect(CaskVersionInvalid).not.toBe(CaskRepoInvalid);
    });
  });

  it.skipIf(!HAS_BREW)(
    'row 7: brew style and brew audit --strict accept the committed cask',
    () => {
      const env = {
        ...process.env,
        HOMEBREW_NO_AUTO_UPDATE: '1',
        HOMEBREW_NO_ANALYTICS: '1',
        HOMEBREW_NO_ENV_HINTS: '1',
      };

      // brew REFUSES to style or audit a loose .rb file outside a tap
      // ("Homebrew requires casks to be in a tap"; verified empirically
      // during Sc10's GREEN step, not documented in `brew style --help`).
      // A real, throwaway tap is the only way to ask brew's own tools
      // whether the COMMITTED cask is valid, so this row builds one,
      // copies the committed file into it byte for byte, checks it there,
      // and tears the tap down again whether the checks pass or not.
      const tapQualified = 'sc10-cask-spec-scratch/wemessage';

      // Defensive: a previous run crashing between tap-new and untap would
      // otherwise make THIS run's tap-new fail on "already exists".
      spawnSync('brew', ['untap', tapQualified], { encoding: 'utf8', env });

      const tapNew = spawnSync('brew', ['tap-new', tapQualified, '--no-git'], {
        encoding: 'utf8',
        env,
      });
      expect(tapNew.status, tapNew.stdout + tapNew.stderr).toBe(0);

      const tapDirResult = spawnSync('brew', ['--repository', tapQualified], {
        encoding: 'utf8',
        env,
      });
      const tapDir = tapDirResult.stdout.trim();
      expect(
        tapDir.length,
        tapDirResult.stdout + tapDirResult.stderr,
      ).toBeGreaterThan(0);

      const tapCaskPath = join(tapDir, 'Casks', 'wemessage.rb');

      try {
        mkdirSync(dirname(tapCaskPath), { recursive: true });
        writeFileSync(tapCaskPath, readFileSync(CASK_RB_PATH, 'utf8'));

        const style = spawnSync('brew', ['style', '--cask', tapCaskPath], {
          encoding: 'utf8',
          env,
        });
        expect(style.status, style.stdout + style.stderr).toBe(0);

        // `brew audit [path ...]` is disabled on this Homebrew version
        // ("Calling `brew audit [path ...]` is disabled! Use `brew audit
        // [name ...]` instead"; verified empirically). The FULLY QUALIFIED
        // name (owner/repo/token) is also what lets audit resolve the cask
        // WITHOUT tripping the separate "untrusted tap" gate a bare token
        // name hits: qualifying the name removes the ambiguity that gate
        // exists to guard against.
        const audit = spawnSync(
          'brew',
          ['audit', '--cask', '--strict', `${tapQualified}/wemessage`],
          { encoding: 'utf8', env },
        );
        expect(audit.status, audit.stdout + audit.stderr).toBe(0);
      } finally {
        spawnSync('brew', ['untap', tapQualified], { encoding: 'utf8', env });
      }
    },
    // tap-new + style + audit + untap, all real Ruby process spin-up, run
    // past vitest's 5s default on this machine; 30s leaves headroom
    // without letting a genuinely hung `brew` invocation stall the suite.
    30_000,
  );

  // row 8: install from a local file:// url via `brew install --cask`,
  // asserting the bundle lands under /Applications, the symlinked binaries
  // run, and `brew uninstall --zap` removes them cleanly. Needs a packed,
  // unsigned DMG at a real path, which does not exist yet: Scenario 10
  // ships the renderer and a placeholder lock entry only (see row 5's
  // comment on the lock file, and homebrew/cask.lock.json's own note on
  // its placeholder sha256). Scenario 12 (release smoke) is where a real
  // packed DMG first exists in this repo, and is the one that turns this
  // row on.
  it.skip('row 8: installs from a local file:// url and uninstalls cleanly (Scenario 12)', () => {
    // Intentionally empty: enabled by Scenario 12, not before.
  });

  it('row 9: livecheck uses url :url and strategy :github_latest, with no appcast', () => {
    const rb = renderCask({
      version: '1.0.0-rc.1',
      sha256: SHA_64,
      repo: REPO_SLUG,
    });

    const livecheckMatch = /^ {2}livecheck do[\s\S]*?\n {2}end/m.exec(rb);
    expect(livecheckMatch?.[0]).toBe(
      [
        '  livecheck do',
        '    url :url',
        '    strategy :github_latest',
        '  end',
      ].join('\n'),
    );
    // `appcast` is the OLD, deprecated way a cask points livecheck at a
    // feed; this renderer never emits it, since GitHub releases already
    // give `:github_latest` everything it needs from the `url` stanza
    // alone.
    expect(rb).not.toContain('appcast');
  });

  describe('row 10: homebrew/README.md tells the operator how to stand up the tap', () => {
    it('names the tap repo and the install commands, and carries no hex colour or handle', () => {
      const readme = readFileSync(README_PATH, 'utf8');

      expect(readme).toContain('raybman/homebrew-wemessage');
      expect(readme).toContain('brew tap raybman/wemessage');
      expect(readme).toContain('brew install --cask wemessage');

      expect(readme).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(readme).not.toMatch(/@\w[\w-]{1,30}\b/);
    });

    it('the commands it hands the owner are ones brew will actually accept', () => {
      /*
       * THE DIFFERENCE BETWEEN PROSE AND A COMMAND, which is the whole
       * reason this row reads only the fenced blocks.
       *
       * This section used to say, in a block meant to be pasted:
       *
       *   brew style --cask homebrew/Casks/wemessage.rb
       *   brew audit --cask --strict --online=false homebrew/Casks/wemessage.rb
       *
       * Neither works. `brew style` on a loose path exits 1 and prints
       * NOTHING, which an owner reads as "the cask is broken" on the day
       * they are trying to ship it. `brew audit` refuses paths outright
       * ("Calling `brew audit [path ...]` is disabled"), and `--online` is
       * not a flag that takes a value, so that line could not have run even
       * if the path form were allowed. Row 7 has always done it correctly,
       * through a real tap; the README simply never matched row 7.
       *
       * The prose below the block now QUOTES both broken forms on purpose,
       * to say why they are broken. So a naive `not.toContain` over the
       * whole file would fail on the explanation itself. Only the fenced
       * blocks are copy-pasteable, so only they are held to this.
       */
      const readme = readFileSync(README_PATH, 'utf8');
      const fenced = [...readme.matchAll(/```[^\n]*\n([\s\S]*?)```/g)]
        .map((m) => m[1] ?? '')
        .join('\n');
      // Not vacuous: this README is mostly command blocks.
      expect(fenced.length).toBeGreaterThan(200);

      // The tap-qualified name is the form that resolves without tripping
      // the untrusted-tap gate, and it is what row 7 itself runs.
      expect(fenced).toContain(
        'brew audit --cask --strict raybman/wemessage/wemessage',
      );
      // And nothing pasteable points either tool at the loose file.
      expect(fenced).not.toMatch(/brew (?:style|audit)[^\n]*homebrew\/Casks/);
      // `--online` takes no value; the broken form did not even parse.
      expect(fenced).not.toContain('--online=');
    });
  });

  /* ── row 11: the cask and the packer agree on where the shims are ───── */

  /*
   * THE BUG THIS ROW IS NAMED AFTER, because every row above it passed
   * while it was live.
   *
   * The renderer emitted `Contents/MacOS/wemessaged` and
   * `Contents/MacOS/wemessage`. Neither file has ever existed. The bundle
   * carries exactly ONE Mach-O (arch F-121: `Contents/MacOS/` holds only
   * `WeMessage`), and the two things the cask wants on PATH are `/bin/sh`
   * shims that `apps/desktop/scripts/bundle-daemon.mjs` writes into
   * `dist-bundle/bin`, which `electron-builder.yml` then copies to `bin`
   * under `Contents/Resources`. Homebrew does not shrug at a `binary`
   * stanza whose source is missing, it raises "source is not there" and
   * the install fails, so the committed cask was UNINSTALLABLE and the
   * whole of this file was green.
   *
   * Rows 1 through 10 could not have caught it. Every one of them asks
   * this renderer about itself: the stanza order it emits, the version it
   * interpolates, the words in its caveats. `brew style` and `brew audit`
   * in row 7 are linters and never fetch anything, so they are equally
   * blind to a path that does not resolve. The missing assertion is the
   * only kind that could have caught it: one that reads a SECOND file,
   * owned by a different tool, and insists the two agree.
   *
   * So this row derives the expected prefix rather than restating it. If
   * someone moves the shims by editing `extraResources`, this row fails
   * and names the new location; it does not quietly keep asserting the old
   * one. That is the difference between a coupling test and a copy.
   *
   * What it deliberately does NOT do is check that the files exist on
   * disk. They only exist after a bundle, which is minutes of work and
   * darwin/arm64-only; `apps/desktop/test/pack.spec.ts` already asserts
   * both are present under `Contents/Resources/bin` in a real packed app,
   * and `apps/desktop/test/bundle.spec.ts` asserts a shim survives being
   * invoked through a symlink, which is the form a `binary` stanza
   * actually installs it in. This row is the cheap, always-on link
   * between those two and the string this renderer writes.
   */
  it('row 11: binary stanza paths are derived from electron-builder extraResources', () => {
    const builder = parse(readFileSync(BUILDER_YML_PATH, 'utf8')) as {
      extraResources?: readonly { from?: unknown; to?: unknown }[];
    };
    const resources = builder.extraResources ?? [];
    // Not vacuous: a parse that silently produced nothing would make every
    // assertion below unreachable and this row would pass having read air.
    expect(resources.length).toBeGreaterThanOrEqual(2);

    const binEntry = resources.find((e) => e.from === 'dist-bundle/bin');
    expect(
      binEntry,
      'electron-builder.yml no longer copies dist-bundle/bin; the cask ' +
        'binary stanzas below point at wherever it went, so say where',
    ).toBeDefined();
    const to = String(binEntry?.to ?? '');
    expect(to).not.toBe('');

    const rb = renderCask({
      version: '1.0.0-rc.1',
      sha256: SHA_64,
      repo: REPO_SLUG,
    });

    const stanzas = [
      ...rb.matchAll(
        /^ {2}binary "#\{appdir\}\/WeMessage\.app\/([^"]+)", target: "([^"]+)"$/gm,
      ),
    ].map(([, path, target]) => ({ path, target }));

    // Two, matching CASK_STANZA_ORDER's two `binary` entries. A regex that
    // matched none would make the loop below a no-op.
    expect(stanzas.map((b) => b.target)).toEqual(['wemessaged', 'wemessage']);

    for (const { path, target } of stanzas)
      expect([target, path]).toEqual([
        target,
        `Contents/Resources/${to}/${String(target)}`,
      ]);

    // And the negative that states the rule in its own right: nothing this
    // cask links onto PATH may live in `Contents/MacOS`, which holds the
    // single Mach-O and nothing else.
    expect(rb).not.toContain('Contents/MacOS');
  });
});
