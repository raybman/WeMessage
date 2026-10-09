/**
 * v2 S5e: the RELEASING.md sections S5e adds, and the README's Contacts
 * paragraph.
 *
 * STATIC. Every row reads a document and asserts its shape; nothing here
 * runs a custody command, and nothing here could: the custody section is a
 * procedure for a person, on an explicit go, on their own Mac.
 *
 * WHAT THE ROWS ARE FOR. Three ways these sections go wrong quietly:
 *
 *   - The custody section loses a field name, and the next run puts the p12
 *     in 1Password under a name the release workflow's secrets do not read
 *     from. The field and secret names are pinned.
 *   - Somebody "helpfully" pastes the real leaf, or any hash, into the
 *     custody section of a PUBLIC repository. The section is pinned to
 *     carry no 40-hex run and no colon fingerprint, in either case. The
 *     real leaf belongs in the Identity section only, which is also the only
 *     place release.yml's compare step may find it: the custody section
 *     must never say the phrase that step searches for, or a stale
 *     placeholder line could satisfy it.
 *   - The Contacts sheet text in the runbook drifts from Info.plist, and the
 *     person running the experiment fails a correct build. The runbook's
 *     sentence is compared with the plist's, verbatim.
 *
 * Any 40-hex value this file needs is built at run time, so the file is not
 * itself a carrier for the arch row that bans them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8');

const RELEASING = 'RELEASING.md';
const README = 'README.md';
const INFO_PLIST = 'apps/mac/Resources/Info.plist';

const CUSTODY = "## Signing custody (S5d, on the maintainer's explicit go)";
const SMOKE = '## Human release smoke (the Swift build)';
const RUNBOOK = '## First install on a Mac (the Swift build)';
const CONTACTS = '### The Contacts experiment';

/** The text from `heading` to the next heading of the same or higher level. */
const sectionOf = (text: string, heading: string): string => {
  const at = text.indexOf(`${heading}\n`);
  if (at < 0) return '';
  const level = /^#+/.exec(heading)?.[0].length ?? 2;
  const rest = text.slice(at + heading.length + 1);
  const next = new RegExp(`^#{1,${String(level)}} `, 'm').exec(rest);
  return rest.slice(0, next === null ? rest.length : next.index);
};

const custody = (): string => sectionOf(read(RELEASING), CUSTODY);
const smoke = (): string => sectionOf(read(RELEASING), SMOKE);
const contacts = (): string =>
  sectionOf(sectionOf(read(RELEASING), RUNBOOK), CONTACTS);

/** The NSContactsUsageDescription string, read from the plist. */
const usageString = (): string =>
  /<key>NSContactsUsageDescription<\/key>\s*<string>([^<]+)<\/string>/.exec(
    read(INFO_PLIST),
  )?.[1] ?? '';

/** Any run of 40 hex digits, either case, standing alone. */
const HEX40 = /(?<![0-9A-Fa-f])[0-9A-Fa-f]{40}(?![0-9A-Fa-f])/;
/** A colon-separated SHA-256 fingerprint, as openssl prints it. */
const COLON_FP = /(?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}/;

describe('v2 S5e: RELEASING.md custody section (S5d runs it, on an explicit go)', () => {
  it('exists once, and after the first install runbook', () => {
    const text = read(RELEASING);
    expect(text.split(`${CUSTODY}\n`).length - 1).toBe(1);
    expect(text.indexOf(`${CUSTODY}\n`)).toBeGreaterThan(
      text.indexOf(`${RUNBOOK}\n`),
    );
    expect(custody()).toMatch(/explicit go|says go/);
  });

  it('names the 1Password item, its five fields, and the two repository secrets', () => {
    const body = custody();
    for (const needed of [
      'wemessage-signing-p12',
      'p12-base64',
      'password',
      'leaf-sha1',
      'sha256-fingerprint',
      'not-after',
      'op item create',
      'WEMESSAGE_SIGN_P12',
      'WEMESSAGE_SIGN_P12_PASSWORD',
    ])
      expect([needed, body.includes(needed)]).toEqual([needed, true]);
    // The command that creates the item writes each field under that name,
    // and the fields table lists the same five: the prose elsewhere naming
    // a field does not count.
    const create = /op item create(?:[^\n\\]|\\\n)*/.exec(body)?.[0] ?? '';
    const table =
      [...body.matchAll(/```\n(Field\s[\s\S]*?)```/g)][0]?.[1] ?? '';
    for (const field of [
      'p12-base64',
      'password',
      'leaf-sha1',
      'sha256-fingerprint',
      'not-after',
    ]) {
      expect([field, create.includes(`"${field}[`)]).toEqual([field, true]);
      expect([field, new RegExp(`^${field}\\s`, 'm').test(table)]).toEqual([
        field,
        true,
      ]);
    }
    // Each secret is set from the item, on stdin, for this repository.
    for (const [secret, field] of [
      ['WEMESSAGE_SIGN_P12', 'p12-base64'],
      ['WEMESSAGE_SIGN_P12_PASSWORD', 'password'],
    ] as const) {
      const line = body
        .split('\n')
        .find((l) => l.includes(`gh secret set ${secret} `));
      expect([secret, line ?? '']).toEqual([
        secret,
        expect.stringContaining(`/wemessage-signing-p12/${field}" |`),
      ]);
      expect(line).toContain('--repo raybman/WeMessage');
      expect(line).not.toContain('--body');
    }
  });

  it('gives the whole command sequence, with the -legacy / LibreSSL p12 note', () => {
    const body = custody();
    for (const needed of [
      'mktemp -d',
      'CN = WeMessage Self-Signed',
      'extendedKeyUsage = critical, codeSigning',
      'openssl req -x509 -newkey rsa:3072',
      '-days 3650',
      'openssl pkcs12 -export $legacy',
      '-legacy',
      'LibreSSL',
      '/usr/bin/openssl',
      'security import',
      'rm -P -rf "$d"',
    ])
      expect([needed, body.includes(needed)]).toEqual([needed, true]);
    // The order a person runs it in: make, export, store, hand over, erase.
    const order = [
      'openssl req -x509',
      'openssl pkcs12 -export',
      'op item create',
      'gh secret set WEMESSAGE_SIGN_P12 ',
      'rm -P -rf',
    ].map((s) => body.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('states the isolation rule: the custody commit touches exactly RELEASING.md and CHANGELOG.md', () => {
    const body = custody();
    expect(body).toMatch(
      /touches exactly `RELEASING\.md` and `CHANGELOG\.md`, nothing else/,
    );
    expect(body).toContain('git show --stat --format= HEAD');
  });

  it('checks the downloaded artefact with codesign -dvv against the leaf-sha1 field', () => {
    const body = custody();
    for (const needed of [
      'gh release download',
      'codesign -dvv',
      '--extract-certificates',
      'op://<vault>/wemessage-signing-p12/leaf-sha1',
      'Authority=WeMessage Self-Signed',
    ])
      expect([needed, body.includes(needed)]).toEqual([needed, true]);
  });

  it('carries placeholders only: no 40-hex run, no fingerprint, and never the compare phrase', () => {
    const body = custody();
    expect(body.length).toBeGreaterThan(0);
    expect(HEX40.test(body)).toBe(false);
    expect(COLON_FP.test(body)).toBe(false);
    for (const placeholder of [
      '<leaf-sha1>',
      '<sha256-fingerprint>',
      '<not-after>',
      '<vault>',
    ])
      expect([placeholder, body.includes(placeholder)]).toEqual([
        placeholder,
        true,
      ]);
    // release.yml's compare-leaf-with-releasing step looks for this phrase
    // on the line carrying the leaf; only the Identity section may say it.
    expect(body.toLowerCase()).not.toContain('certificate leaf');
    // Non-vacuity: the detectors do see what they are for.
    const leaf = 'ab12'.repeat(10);
    expect(HEX40.test(`leaf ${leaf}`)).toBe(true);
    expect(HEX40.test(`leaf ${leaf.toUpperCase()}`)).toBe(true);
    expect(HEX40.test(`x ${leaf}0 y`)).toBe(false);
    const fp = Array.from({ length: 32 }, () => 'AB').join(':');
    expect(COLON_FP.test(`sha256 ${fp}`)).toBe(true);
  });
});

describe('v2 S5e: RELEASING.md human release smoke', () => {
  it('exists once, after the custody section', () => {
    const text = read(RELEASING);
    expect(text.split(`${SMOKE}\n`).length - 1).toBe(1);
    expect(text.indexOf(`${SMOKE}\n`)).toBeGreaterThan(
      text.indexOf(`${CUSTODY}\n`),
    );
  });

  it('runs on a clean user on a named Mac, never the development laptop', () => {
    const body = smoke();
    expect(body).toContain('<the Mac the maintainer names>');
    expect(body).toMatch(/Never\s+the development laptop/);
    expect(body).toMatch(/clean\s+macOS user account/);
  });

  it('is a checklist naming each manual act, in the order a new user meets them', () => {
    const body = smoke();
    const items = body.split('\n').filter((l) => l.startsWith('- [ ] '));
    expect(items.length).toBeGreaterThanOrEqual(8);
    const acts = [
      'WeMessage-<version>-arm64.dmg',
      'Open Anyway',
      'wemessaged service install',
      'Full Disk Access',
      'Contacts sheet',
      "Don't Allow",
      'tccutil reset AddressBook sh.wemessage.gateway',
      'Electron',
    ];
    const at = acts.map((a) => items.findIndex((l) => l.includes(a)));
    expect(acts.map((a, i) => [a, at[i]! >= 0])).toEqual(
      acts.map((a) => [a, true]),
    );
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('the denial step asks for the fallback avatar and no second sheet', () => {
    const deny =
      smoke()
        .split('\n')
        .find((l) => l.includes("Don't Allow")) ?? '';
    expect(deny).toMatch(/fallback/);
    expect(deny).toMatch(/no error/);
    expect(deny).toMatch(/no second sheet/);
  });

  it('the Electron upgrade note: same identifier, never side by side, service install once, FDA again', () => {
    const upgrade =
      smoke()
        .split('\n')
        .find((l) => l.includes('Electron')) ?? '';
    for (const needed of [
      'sh.wemessage.gateway',
      'side by side',
      'wemessaged service install',
      'once',
      'Full Disk Access again',
      'designated requirement',
    ])
      expect([needed, upgrade.includes(needed)]).toEqual([needed, true]);
  });
});

describe('v2 S5e: the Contacts experiment in the first install runbook', () => {
  it('sits between the FDA experiment and the double-click check', () => {
    const runbook = sectionOf(read(RELEASING), RUNBOOK);
    const fda = runbook.indexOf('### The FDA experiment\n');
    const here = runbook.indexOf(`${CONTACTS}\n`);
    const dbl = runbook.indexOf('### Double-click while the daemon runs\n');
    expect(fda).toBeGreaterThanOrEqual(0);
    expect(here).toBeGreaterThan(fda);
    expect(dbl).toBeGreaterThan(here);
  });

  it('carries the Info.plist sheet text verbatim, and the experiment table has a Contacts row', () => {
    const body = contacts();
    const usage = usageString();
    expect(usage.length).toBeGreaterThan(40);
    expect(body).toContain(usage);
    // The fenced experiment table: an FDA row and a Contacts row, Pass and Fail.
    const fences = [...body.matchAll(/```\n([\s\S]*?)```/g)].map(
      (m) => m[1] ?? '',
    );
    const table =
      fences.find((f) => /^Experiment\s+When\s+Pass\s+Fail/m.test(f)) ?? '';
    expect(table).toMatch(/^FDA\s/m);
    expect(table).toMatch(/^Contacts\s/m);
    expect(table).toContain('once');
    expect(body).toContain('tccutil reset AddressBook sh.wemessage.gateway');
    expect(body).toContain(
      'com.apple.security.personal-information.addressbook',
    );
  });

  it('asks on the first opened thread, never when the list first draws (D-UI-54)', () => {
    const body = contacts();
    expect(body).toContain('D-UI-54');
    expect(body).toMatch(/first thread you open/);
    expect(body).toMatch(/never when the list first\s+draws/);
  });
});

describe('v2 S5e: README Permissions names Contacts as optional', () => {
  it('says what Contacts is for and what a refusal does, inside Permissions', () => {
    const permissions = sectionOf(read(README), '## Permissions');
    expect(permissions).toContain('**Contacts** is optional');
    expect(permissions).toMatch(/names and photos/);
    expect(permissions).toMatch(/initials/);
    expect(permissions).toMatch(/nothing is uploaded/i);
    expect(permissions).toMatch(/no error/);
  });
});
