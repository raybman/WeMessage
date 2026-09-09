/**
 * s9 Scenario 13: the documents a stranger reads first.
 *
 * WHAT IS ACTUALLY BEING PROVED HERE. Not that the prose is good, which no
 * test can say. What is proved is that the three documents a person meets
 * before they meet the program are STRUCTURALLY honest:
 *
 *   - The README's headings are the ones a reader of a macOS app looks for,
 *     in the order they look for them, and "In development" is gone. A README
 *     that still says the project is unfinished on the day it ships is the
 *     single most common way a release lands and nobody installs it.
 *   - Every relative link in the README points at a file that exists. Dead
 *     links in a README are invisible to the author, who knows what the file
 *     was called, and total to a reader, who does not.
 *   - The README says, in words, that the build is unsigned, and says what
 *     the user has to do about it. This project made a deliberate choice to
 *     ship without an Apple Developer ID so that a paid membership is not
 *     standing between a reader and a working copy. That choice is only
 *     defensible if it is DOCUMENTED. An unsigned build whose README does not
 *     mention Gatekeeper is not an open project, it is a broken download.
 *   - `SECURITY.md` publishes no address. A security contact is a promise
 *     that somebody is reading the inbox, and this project routes reports
 *     through GitHub's private reporting instead. The row asserts the absence
 *     mechanically, because "we should not add an email here" is exactly the
 *     kind of intention that survives until the first person edits the file.
 *
 * PLATFORM. Runs everywhere. These are files.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8');

const README = 'README.md';
const SECURITY = 'SECURITY.md';
const CHANGELOG = 'CHANGELOG.md';
const PUBLIC_DOCS = [README, SECURITY, CHANGELOG] as const;

const headingsOf = (text: string): string[] =>
  [...text.matchAll(/^## (.+)$/gm)].map((m) => (m[1] ?? '').trim());

describe('s9 Sc13: the README, the security policy and the changelog', () => {
  /* ── row 1: the shape a macOS reader expects ────────────────────────── */

  it('row 1: README headings are the expected set, in the expected order', () => {
    // Deep equality on the whole list, not a `toContain` per heading. The
    // failure a subset check misses is the one that matters: `Install` after
    // `Agents`, so the first thing a reader sees is a protocol document.
    expect(headingsOf(read(README))).toEqual([
      'Install',
      'What it does',
      'Permissions',
      'Keep it running',
      'Agents',
      'Security',
      'Uninstall',
      'Contributing',
      'License',
    ]);
    expect(read(README)).not.toContain('In development');
  });

  /* ── row 2: install is copy-pasteable and version-free ──────────────── */

  it('row 2: Install gives both routes and hard-codes no version', () => {
    const text = read(README);
    expect(text).toContain('brew tap raybman/wemessage');
    expect(text).toContain('brew install --cask wemessage');
    // The releases PAGE, not `releases/latest` and not a pinned tag. Two
    // separate failures are being avoided here. A README that names a version
    // is wrong one release later and nobody edits it. And `/releases/latest`
    // silently excludes prereleases, so while the newest thing published is a
    // release candidate, which is exactly the state this project ships in
    // first, that link resolves to nothing at all. The list page is right in
    // both states, which is why it is the one a stranger is handed.
    expect(text).toContain('https://github.com/raybman/WeMessage/releases)');
    expect(text).not.toContain('releases/latest');
    const versionHits = [...text.matchAll(/\d+\.\d+\.\d+/g)].map((m) => m[0]);
    expect(versionHits).toEqual([]);
  });

  /* ── row 3: the unsigned decision is stated, not buried ─────────────── */

  it('row 3: says the build is unsigned and says what to do about it', () => {
    const text = read(README);
    expect(text.toLowerCase()).toContain('unsigned');
    // The exact words of the macOS 15 flow. Right-click-Open stopped working
    // for unsigned apps in Sequoia, so a README that only says "right click
    // and choose Open" sends the reader in a circle.
    expect(text).toContain('Open Anyway');
    expect(text).toContain('com.apple.quarantine');
    // And the mitigation offered in place of a signature is named.
    expect(text).toContain('SHA256SUMS');
  });

  /* ── row 4: no dead links ───────────────────────────────────────────── */

  it('row 4: every relative link in the README resolves to a real file', () => {
    const broken: string[] = [];
    for (const m of read(README).matchAll(/\]\(([^)]+)\)/g)) {
      const href = (m[1] ?? '').split('#')[0] ?? '';
      if (href.length === 0) continue;
      if (/^[a-z]+:/i.test(href) || href.startsWith('//')) continue;
      const target = resolve(dirname(join(repoRoot, README)), href);
      if (!existsSync(target)) broken.push(href);
    }
    expect(broken).toEqual([]);
    // Not vacuous: the README does link to files in this repo.
    expect(
      [...read(README).matchAll(/\]\(([^):]+)\)/g)].length,
    ).toBeGreaterThanOrEqual(4);
  });

  /* ── row 5: the security policy publishes no inbox ──────────────────── */

  it('row 5: SECURITY.md routes through GitHub and names no address', () => {
    const text = read(SECURITY);
    // No `@` at all, which is stricter than "no email" and is the version a
    // future editor cannot accidentally satisfy with a mangled address.
    expect(text).not.toContain('@');
    expect(text).toContain('Report a vulnerability');
    // The unsigned lane is declared out of scope IN THE POLICY, so a report
    // saying "Gatekeeper rejects your app" gets a documented answer rather
    // than a maintainer's time.
    expect(text.toLowerCase()).toContain('not notarized');
  });

  /* ── row 6: the changelog parses as Keep a Changelog ────────────────── */

  it('row 6: CHANGELOG has Unreleased, a dated release, and closed categories', () => {
    const text = read(CHANGELOG);
    expect(text).toContain('## [Unreleased]');
    const releases = [
      ...text.matchAll(/^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})$/gm),
    ];
    expect(releases.length).toBeGreaterThanOrEqual(1);
    const categories = [...text.matchAll(/^### (.+)$/gm)].map(
      (m) => m[1] ?? '',
    );
    const allowed = new Set([
      'Added',
      'Changed',
      'Deprecated',
      'Removed',
      'Fixed',
      'Security',
    ]);
    expect(categories.filter((c) => !allowed.has(c))).toEqual([]);
    // Every version heading has a link reference at the bottom, so the
    // compare links in a rendered changelog are not dead.
    for (const [, version] of releases)
      expect([version, text.includes(`[${version}]: https://`)]).toEqual([
        version,
        true,
      ]);
    // The release candidate names the slices it is made of, so the first
    // release's notes are not the word "initial".
    expect(text).toContain('S9, ship');
  });

  /* ── row 7: the public sweeps reach these three files ───────────────── */

  it('row 7: no phone number, no email address, no hex colour', () => {
    for (const rel of PUBLIC_DOCS) {
      const text = read(rel);
      expect([rel, /\+1\s*\(?\d{3}/.test(text)]).toEqual([rel, false]);
      expect([rel, /[\w.-]+@[\w-]+\.[a-z]{2,}/i.test(text)]).toEqual([
        rel,
        false,
      ]);
      // A hex colour in a document a designer will later restyle is a colour
      // that will be wrong. The site owns colour; these files own words.
      expect([rel, /#[0-9a-fA-F]{6}\b/.test(text)]).toEqual([rel, false]);
    }
  });

  /* ── row 8: the licence promise the README makes is kept ────────────── */

  it('row 8: the files the README promises actually exist', () => {
    for (const rel of [
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
      CHANGELOG,
      SECURITY,
    ])
      expect([rel, existsSync(join(repoRoot, rel))]).toEqual([rel, true]);
  });

  /* ── row 9: one licence, said the same way everywhere ───────────────── */

  it('row 9: README, LICENSE and every manifest name the same licence', () => {
    // This row exists because they did not agree. The README said MIT while
    // `LICENSE` carried the Apache 2.0 text and every manifest said
    // `Apache-2.0`. Row 8 above was titled "the licence promise the README
    // makes is kept" and could not have caught it, because it asks whether
    // the FILE exists and never what it says. On a public repository the
    // licence line is not decoration: it is the sentence a stranger relies on
    // to decide whether they may use the thing at all, and a repo that gives
    // two different answers has not given them one.
    const declared = String(
      (JSON.parse(read('package.json')) as { license?: unknown }).license ?? '',
    );
    expect(declared).toBe('Apache-2.0');

    // The SPDX id and the way a README spells it out loud.
    const readme = read(README);
    expect(readme).toContain('Apache 2.0');
    // And no second answer anywhere in the file. A licence named twice, two
    // ways, is the failure this row is named after.
    for (const other of ['MIT', 'GPL', 'BSD', 'Mozilla Public'])
      expect([other, readme.includes(other)]).toEqual([other, false]);

    // The LICENSE file is the licence, not a stub that says its name.
    const license = read('LICENSE');
    expect(license).toContain('Apache License');
    expect(license.length).toBeGreaterThan(10_000);

    // Every workspace manifest agrees with the root, so that a new package
    // cannot arrive under a different licence by copying the wrong template.
    const manifests: [string, unknown][] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 4) return;
      for (const e of readdirSync(join(repoRoot, dir), {
        withFileTypes: true,
      })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const rel = join(dir, e.name);
        if (e.isDirectory()) walk(rel, depth + 1);
        else if (e.name === 'package.json')
          manifests.push([
            rel,
            (JSON.parse(read(rel)) as { license?: unknown }).license,
          ]);
      }
    };
    for (const root of ['packages', 'apps', 'tools', 'fixtures'])
      if (existsSync(join(repoRoot, root))) walk(root, 0);
    // Not vacuous: this monorepo has many packages, and a walk that found
    // none would pass the loop below without reading anything.
    expect(manifests.length).toBeGreaterThanOrEqual(10);
    for (const [rel, lic] of manifests)
      expect([rel, lic]).toEqual([rel, declared]);
  });
});
