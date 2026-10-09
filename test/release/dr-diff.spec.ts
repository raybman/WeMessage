/**
 * v2 S5b: the designated requirement, diffed per tag.
 *
 * macOS keys every privacy grant (Full Disk Access, Automation, Contacts) on
 * the app's designated requirement, and for a self-signed build that is the
 * certificate leaf. A release signed with a different leaf than the one
 * before it silently resets every user's grants. So the release lane
 * compares the new DESIGNATED_REQUIREMENT.txt with the previous release's,
 * and a change ships only when CHANGELOG.md says so, under THIS version's
 * heading, naming both leaves.
 *
 * The comparison is pure (`tools/release/src/dr-diff.ts`) and tested here
 * with no network. The bin (`tools/release/bin/dr-diff.mjs`) is the only
 * part that talks to GitHub, and its exit codes are proved at the bottom
 * against a fake `gh` on PATH.
 *
 * Every 40-hex value is built at run time: a literal one in a tracked file
 * is something the HEX40 arch row refuses.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import {
  changelogSection,
  compareDesignatedRequirement,
  exitCodeFor,
  leafOf,
  pickPreviousRelease,
} from '../../tools/release/src/dr-diff.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const X = 'ab12'.repeat(10);
const Y = 'cd34'.repeat(10);
const Z = 'ef56'.repeat(10);
const dr = (leaf: string, root = true): string =>
  `designated => identifier "sh.wemessage.gateway" and certificate ${root ? 'root' : 'leaf'} = H"${leaf.toUpperCase()}"\n`;
const rotated = (from: string, to: string): string =>
  `- Signing identity rotated: ${from} -> ${to}`;

const changelog = (sections: Record<string, string[]>): string =>
  [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    ...Object.entries(sections).flatMap(([v, lines]) => [
      `## [${v}] - 2026-10-09`,
      '',
      ...lines,
      '',
    ]),
  ].join('\n');

describe('v2 S5b: dr-diff, the pure comparison', () => {
  it('reads the leaf from a designated requirement, root or leaf spelling, any case', () => {
    expect(leafOf(dr(X))).toBe(X);
    expect(leafOf(dr(X, false))).toBe(X);
    expect(leafOf(dr(X).replace(X.toUpperCase(), X))).toBe(X);
    expect(() => leafOf('designated => identifier "x"')).toThrow(
      /no certificate leaf/,
    );
  });

  it('first-release: no previous release carries a designated requirement', () => {
    const r = compareDesignatedRequirement({
      previous: null,
      current: dr(X),
      changelogSection: '',
    });
    expect(r).toEqual({ kind: 'first-release' });
    expect(exitCodeFor(r)).toBe(0);
  });

  it('same: the previous release has the same designated requirement', () => {
    const r = compareDesignatedRequirement({
      previous: { tag: 'v1.0.0', requirement: dr(X) },
      current: dr(X),
      changelogSection: '',
    });
    expect(r).toEqual({ kind: 'same', previousTag: 'v1.0.0' });
    expect(exitCodeFor(r)).toBe(0);
  });

  it('rotated, justified: the line under this version names both leaves', () => {
    const log = changelog({
      '1.1.0': ['### Changed', '', rotated(X, Y)],
      '1.0.0': ['First.'],
    });
    const r = compareDesignatedRequirement({
      previous: { tag: 'v1.0.0', requirement: dr(X) },
      current: dr(Y),
      changelogSection: changelogSection(log, 'v1.1.0'),
    });
    expect(r).toEqual({
      kind: 'rotated',
      previousTag: 'v1.0.0',
      justified: true,
      changelogLine: rotated(X, Y),
    });
    expect(exitCodeFor(r)).toBe(0);
  });

  it('rotated, unjustified: no line at all exits 6', () => {
    const log = changelog({ '1.1.0': ['### Changed', '', '- Nothing.'] });
    const r = compareDesignatedRequirement({
      previous: { tag: 'v1.0.0', requirement: dr(X) },
      current: dr(Y),
      changelogSection: changelogSection(log, 'v1.1.0'),
    });
    expect(r).toMatchObject({
      kind: 'rotated',
      previousTag: 'v1.0.0',
      justified: false,
    });
    expect(exitCodeFor(r)).toBe(6);
  });

  it('a justification with the wrong hash on either side is unjustified', () => {
    for (const line of [
      rotated(Z, Y), // the old leaf is not the previous release's
      rotated(X, Z), // the new leaf is not this build's
      rotated(Y, X), // reversed
      rotated(X, Y)
        .toUpperCase()
        .replace('- SIGNING IDENTITY ROTATED', '- Signing identity rotated'),
      `${rotated(X, Y)} (planned)`, // the line must be exactly the line
      `  ${rotated(X, Y)}`,
    ]) {
      const r = compareDesignatedRequirement({
        previous: { tag: 'v1.0.0', requirement: dr(X) },
        current: dr(Y),
        changelogSection: changelogSection(
          changelog({ '1.1.0': [line] }),
          'v1.1.0',
        ),
      });
      expect([line, r.kind, 'justified' in r && r.justified]).toEqual([
        line,
        'rotated',
        false,
      ]);
    }
  });

  // teeth: S5b tooth 1 (accept a rotation line under the previous heading)
  // turns this row red.
  it('the line must sit under the CURRENT version heading, not an older one', () => {
    const log = changelog({
      '1.1.0': ['### Changed', '', '- Nothing about signing.'],
      '1.0.0': [rotated(X, Y)],
    });
    const section = changelogSection(log, 'v1.1.0');
    expect(section).not.toContain('Signing identity rotated');
    expect(section).toContain('Nothing about signing');
    const r = compareDesignatedRequirement({
      previous: { tag: 'v1.0.0', requirement: dr(X) },
      current: dr(Y),
      changelogSection: section,
    });
    expect(r).toMatchObject({ kind: 'rotated', justified: false });
    expect(exitCodeFor(r)).toBe(6);
    // Nor under [Unreleased]: a released version names its own heading.
    const unreleased = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      rotated(X, Y),
      '',
      '## [1.1.0] - 2026-10-09',
      '',
      '- Nothing.',
    ].join('\n');
    expect(changelogSection(unreleased, 'v1.1.0')).not.toContain('rotated');
  });

  it('finds the heading in each spelling, and an absent heading is an empty section', () => {
    for (const heading of [
      '## [1.1.0] - 2026-10-09',
      '## [1.1.0]',
      '## 1.1.0',
      '## v1.1.0',
      '## [v1.1.0] - 2026-10-09',
    ]) {
      const log = `# Changelog\n\n${heading}\n\n${rotated(X, Y)}\n\n## [1.0.0]\n\n- Old.\n`;
      expect([heading, changelogSection(log, 'v1.1.0')]).toEqual([
        heading,
        `\n${rotated(X, Y)}\n`,
      ]);
    }
    // A prefix of another version is not that version.
    const log = `## [1.1.0-rc.1]\n\n${rotated(X, Y)}\n`;
    expect(changelogSection(log, 'v1.1.0')).toBe('');
    expect(changelogSection(log, 'v1.1.0-rc.1')).toBe(`\n${rotated(X, Y)}\n`);
  });

  it('a changed requirement with the same leaf is still a change, and a leaf line cannot justify it', () => {
    const previous = `designated => identifier "sh.wemessage.other" and certificate root = H"${X}"\n`;
    const r = compareDesignatedRequirement({
      previous: { tag: 'v1.0.0', requirement: previous },
      current: dr(X),
      changelogSection: rotated(X, X),
    });
    expect(r).toMatchObject({ kind: 'rotated', justified: false });
  });

  it('picks the newest published release other than this tag, prereleases included', () => {
    const releases = [
      { tagName: 'v1.2.0', isDraft: false },
      { tagName: 'v1.1.0-rc.2', isDraft: true },
      { tagName: 'v1.1.0', isDraft: false },
      { tagName: 'v1.0.0', isDraft: false },
    ];
    expect(pickPreviousRelease(releases, 'v1.2.0')).toEqual([
      'v1.1.0',
      'v1.0.0',
    ]);
    expect(pickPreviousRelease(releases, 'v1.3.0')).toEqual([
      'v1.2.0',
      'v1.1.0',
      'v1.0.0',
    ]);
    expect(pickPreviousRelease([], 'v1.0.0')).toEqual([]);
  });
});

describe('v2 S5b: dr-diff.mjs, the exit codes, against a fake gh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dr-diff-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(repoRoot, 'tools/release/bin/dr-diff.mjs');
  const distBuilt = (() => {
    try {
      readFileSync(join(repoRoot, 'tools/release/dist/dr-diff.js'));
      return true;
    } catch {
      return false;
    }
  })();

  /**
   * A `gh` that answers the three calls the bin makes from files: the
   * release list as JSON, each release's asset names, and the download of
   * DESIGNATED_REQUIREMENT.txt into `-D <dir>`.
   */
  function fakeGh(
    releases: { tagName: string; isDraft: boolean }[],
    drs: Record<string, string>,
  ): string {
    const ghDir = mkdtempSync(join(dir, 'gh-'));
    writeFileSync(join(ghDir, 'releases.json'), JSON.stringify(releases));
    for (const [tag, text] of Object.entries(drs))
      writeFileSync(join(ghDir, `${tag}.dr`), text);
    const script = `#!/usr/bin/env bash
set -euo pipefail
here="${ghDir}"
printf '%s\\n' "$*" >> "$here/log"
case "$1 $2" in
  "release list") cat "$here/releases.json" ;;
  "release view")
    if [ -f "$here/$3.dr" ]; then printf '{"assets":[{"name":"DESIGNATED_REQUIREMENT.txt"}]}\\n'
    else printf '{"assets":[{"name":"other.zip"}]}\\n'; fi ;;
  "release download")
    out=""; prev=""
    for a in "$@"; do [ "$prev" = "-D" ] && out="$a"; prev="$a"; done
    cp "$here/$3.dr" "$out/DESIGNATED_REQUIREMENT.txt" ;;
  *) echo "fake gh: unexpected $*" >&2; exit 64 ;;
esac
`;
    writeFileSync(join(ghDir, 'gh'), script);
    chmodSync(join(ghDir, 'gh'), 0o755);
    return ghDir;
  }

  function run(
    ghDir: string,
    current: string,
    log: string,
    tag: string,
  ): { status: number | null; stdout: string; stderr: string } {
    const cur = join(ghDir, 'current.txt');
    const cl = join(ghDir, 'CHANGELOG.md');
    writeFileSync(cur, current);
    writeFileSync(cl, log);
    const r = spawnSync(
      process.execPath,
      [
        bin,
        '--repo',
        'example/example',
        '--tag',
        tag,
        '--current',
        cur,
        '--changelog',
        cl,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${ghDir}:${process.env['PATH'] ?? ''}` },
      },
    );
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  it.skipIf(!distBuilt)(
    'exit 0 on first-release, same and justified; exit 6 on unjustified',
    () => {
      const none = fakeGh([], {});
      expect(run(none, dr(X), '', 'v1.0.0')).toMatchObject({ status: 0 });
      expect(run(none, dr(X), '', 'v1.0.0').stdout).toContain('first-release');

      // An older release with no designated requirement (the Electron era)
      // is skipped, not compared.
      const legacy = fakeGh(
        [
          { tagName: 'v1.1.0', isDraft: false },
          { tagName: 'v1.0.0', isDraft: false },
        ],
        { 'v1.1.0': dr(X) },
      );
      const same = run(legacy, dr(X), '', 'v1.2.0');
      expect(same).toMatchObject({ status: 0 });
      expect(same.stdout).toContain('same as v1.1.0');

      const justified = run(
        legacy,
        dr(Y),
        changelog({ '1.2.0': [rotated(X, Y)] }),
        'v1.2.0',
      );
      expect(justified).toMatchObject({ status: 0 });
      expect(justified.stdout).toContain('rotated, justified');

      const unjustified = run(
        legacy,
        dr(Y),
        changelog({ '1.2.0': ['- Nothing.'], '1.1.0': [rotated(X, Y)] }),
        'v1.2.0',
      );
      expect(unjustified.status).toBe(6);
      expect(unjustified.stderr).toContain('Signing identity rotated:');

      // The bin asked only read questions of GitHub.
      const calls = readFileSync(join(legacy, 'log'), 'utf8')
        .split('\n')
        .filter((l) => l.length > 0);
      for (const c of calls)
        expect([c, /^release (list|view|download) /.test(c)]).toEqual([
          c,
          true,
        ]);
      expect(
        calls.some(
          (c) => c.startsWith('release list') && c.includes('--exclude-drafts'),
        ),
      ).toBe(true);
    },
  );

  it.skipIf(!distBuilt)(
    'refuses with exit 2 on a missing argument or an unreadable requirement',
    () => {
      const none = fakeGh([], {});
      expect(run(none, 'not a requirement', '', 'v1.0.0').status).toBe(2);
      const r = spawnSync(process.execPath, [bin, '--tag', 'v1.0.0'], {
        encoding: 'utf8',
      });
      expect(r.status).toBe(2);
    },
  );

  it('the dist module is present when the gate has built the workspace', () => {
    // The gate runs `pnpm -r build` first, so the two rows above are not
    // silently skipped in the gate. A bare `vitest` run without a build may
    // skip them; this row says so out loud there instead of passing quietly.
    expect(distBuilt).toBe(true);
  });
});
