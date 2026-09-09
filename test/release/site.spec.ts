/**
 * s9 Scenario 13, rows 10 and 11: the five pages behind the landing page.
 *
 * WHAT IS ACTUALLY BEING PROVED. `readme.spec.ts` covers the documents a
 * stranger meets inside the repository. This file covers the ones they meet
 * outside it, which is a different audience with a different failure mode: a
 * reader of `README.md` has already decided to look at the source, and a
 * reader of wemessage.app has not. So these five pages are held to four
 * structural promises rather than to a judgement about the prose:
 *
 *   - They EXIST and they LINK HOME. A docs page with no way back to `/` is
 *     a dead end, and a marketing site whose docs are unreachable from the
 *     docs is the shape a hand-written static site fails into first.
 *   - They PARSE. Static HTML has no build step here, which is the whole
 *     point of a single self-contained document, and the cost of no build
 *     step is that an unclosed `<div>` ships. The balance check below is
 *     twenty lines and no dependency, because the question being asked is
 *     "is every element closed", not "what does a browser make of this".
 *   - They hold NO COLOUR outside their own `:root{...}` block. This is S8's
 *     locality rule (F-104) restated for a page that carries its own token
 *     sheet instead of deferring to `tokens.css`. It is not the no-green
 *     sweep, which `apps/desktop/test/tokens.spec.ts` runs over `site/` for
 *     every ship surface. It is the stronger, narrower rule that makes "what
 *     colour is this page" a question with a fourteen-line answer.
 *   - They say the things the plan makes BINDING, in their own words: the
 *     Full Disk Access re-grant (F-142), the Gatekeeper step for an unsigned
 *     build, `wemessaged` and never `wemessage` for the service verbs
 *     (F-125), and no published inbox on the security page.
 *
 * WHY THE CONTENT ROWS ARE NOT DECORATION. Each one is a claim somebody
 * already got wrong once. F-142 is the update that silently breaks reads
 * while the switch still looks on, and the reason it is asserted on the site
 * as well as in the README and the daemon is that these are read at three
 * different moments by three different people. F-125 is the verb that lives
 * on the daemon and gets typed against the CLI. The security page's missing
 * address is a promise nobody is staffing an inbox, and an absence is
 * exactly the kind of intention that survives until the first edit.
 *
 * PLATFORM. Runs everywhere. These are files.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// The one home for "what must a public repo never say" (s7 Sc11). Imported
// rather than restated for the reason that move was made: a second copy of
// the brand, phone, token, path and operator rules is the copy that goes
// stale. The email arm is added locally below, the way `readme.spec.ts`
// spells it, because `publicStringOffenders` has never carried one.
import { publicStringOffenders } from '../../packages/cli/test/helpers/transcript-lint.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8');

const INDEX = 'site/index.html';
const INSTALL = 'site/docs/install.html';
const PERMISSIONS = 'site/docs/permissions.html';
const LAUNCHD = 'site/docs/launchd.html';
const UNINSTALL = 'site/docs/uninstall.html';
const SECURITY = 'site/docs/security.html';

/** The five, in the order the plan names them. */
const DOCS = [INSTALL, PERMISSIONS, LAUNCHD, UNINSTALL, SECURITY] as const;

/** The releases LIST. Not `releases/latest`, for `readme.spec.ts` row 2's reason. */
const RELEASES = 'https://github.com/raybman/WeMessage/releases';

/**
 * `#30D158`, assembled from fragments.
 *
 * The convention is `apps/desktop/test/tokens.spec.ts`, and the reason is
 * the same one that file gives: a spec that forbids a literal should not be
 * the file a search for that literal finds. Row 11 asserts the landing page
 * does not carry it; writing it whole here would make this spec the second
 * hit and the guard's own documentation a false positive.
 */
const GREEN_30 = `#30${'D158'}`;

const lineOf = (text: string, index: number): number =>
  text.slice(0, index).split('\n').length;

// ---------------------------------------------------------------------------
// the twenty-line parse (row 10c)
// ---------------------------------------------------------------------------

/** HTML5 void elements: no end tag, and not an error when one is absent. */
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

/**
 * Tag balance, with no dependency and no pretence of being a parser.
 *
 * Comments and the doctype are blanked to spaces rather than removed, so
 * that every line number a failure reports is the line number in the file.
 * A self-closing `/>` and a void element are both accepted and neither is
 * pushed. Everything else must close, in order.
 */
function unbalanced(html: string): string[] {
  const errors: string[] = [];
  const stack: [string, number][] = [];
  const src = html.replace(/<!--[\s\S]*?-->|<![a-zA-Z][^>]*>/g, (m) =>
    m.replace(/[^\n]/g, ' '),
  );
  for (const m of src.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)[^>]*?(\/?)>/g)) {
    const line = lineOf(src, m.index);
    const tag = (m[2] ?? '').toLowerCase();
    if (VOID_ELEMENTS.has(tag) || m[3] === '/') continue;
    if (m[1] !== '/') {
      stack.push([tag, line]);
      continue;
    }
    const open = stack.pop();
    if (open === undefined)
      errors.push(`line ${String(line)}: </${tag}> closes nothing`);
    else if (open[0] !== tag)
      errors.push(
        `line ${String(line)}: </${tag}> closes <${open[0]}> opened on line ${String(open[1])}`,
      );
  }
  for (const [tag, line] of stack)
    errors.push(`line ${String(line)}: <${tag}> is never closed`);
  return errors;
}

// ---------------------------------------------------------------------------
// the locality rule (row 10d)
// ---------------------------------------------------------------------------

/** The four hex lengths CSS accepts. Ordered longest-first so `#aabbccdd` is one match. */
const HEX_RE =
  /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g;

/** The `:root{ ... }` span as `[open, close)`, or `[-1, -1]` if there is none. */
function tokenBlockSpan(html: string): [number, number] {
  const open = html.indexOf(':root{');
  if (open === -1) return [-1, -1];
  const close = html.indexOf('}', open);
  return close === -1 ? [-1, -1] : [open, close + 1];
}

/** Every hex the page writes down outside its own token block, with a line. */
function hexOutsideTokenBlock(rel: string, html: string): string[] {
  const [open, close] = tokenBlockSpan(html);
  const out: string[] = [];
  for (const m of html.matchAll(HEX_RE)) {
    if (open !== -1 && m.index >= open && m.index < close) continue;
    out.push(`${rel}:${String(lineOf(html, m.index))}: ${m[0]}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// links
// ---------------------------------------------------------------------------

const hrefsOf = (html: string): string[] =>
  [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1] ?? '');

/**
 * A site-absolute href, resolved the way the static host resolves it: `/` is
 * `site/index.html`, and everything else is a path under `site/`.
 */
function resolveSiteHref(href: string): string | undefined {
  const path = (href.split('#')[0] ?? '').split('?')[0] ?? '';
  if (!path.startsWith('/')) return undefined;
  return path === '/' ? INDEX : `site${path}`;
}

/** `readme.spec.ts` row 7's email arm, which `publicStringOffenders` has never had. */
const EMAIL_RE = /[\w.-]+@[\w-]+\.[a-z]{2,}/i;

describe('s9 Sc13 rows 10 and 11: the site and its five docs pages', () => {
  /* ── row 1: the pages exist, and every one of them leads home ───────── */

  it('row 1: all five docs pages exist and link back to /', () => {
    // Deep-equal on the whole list rather than an `existsSync` per file, so
    // that the failure names every missing page at once instead of the
    // alphabetically first one. A slice that ships four of five pages is a
    // slice that looks done from the test output.
    expect(DOCS.filter((rel) => !existsSync(join(repoRoot, rel)))).toEqual([]);
    // `href="/"` exactly: the site root. Not `../index.html`, which is right
    // on disk and wrong once the host serves `/docs/` as a directory, and
    // not `/index.html`, which works but leaves two spellings of the home
    // page in the tree for a later editor to pick between.
    expect(DOCS.filter((rel) => !read(rel).includes('href="/"'))).toEqual([]);
  });

  /* ── row 2: the pages parse ─────────────────────────────────────────── */

  it('row 2: every docs page passes the tag-balance parse', () => {
    const failures: string[] = [];
    for (const rel of DOCS)
      for (const e of unbalanced(read(rel))) failures.push(`${rel}: ${e}`);
    expect(failures).toEqual([]);
    // Not vacuous. A checker that never sees a tag passes everything, so the
    // row proves the pages really are documents: five self-contained pages
    // with a nav, a main and a footer do not fit in forty elements.
    for (const rel of DOCS)
      expect([rel, [...read(rel).matchAll(/<[a-zA-Z]/g)].length > 40]).toEqual([
        rel,
        true,
      ]);
  });

  it('row 2 teeth: the parse convicts each way a page can be unbalanced', () => {
    // The three failures worth naming, each proved against a synthetic
    // string rather than against a file, because planting a broken page in
    // `site/` to prove the checker works is a plant that can be left behind.
    expect(unbalanced('<div><p>x</div></p>')).toEqual([
      'line 1: </div> closes <p> opened on line 1',
      'line 1: </p> closes <div> opened on line 1',
    ]);
    expect(unbalanced('<main>\n<section>\n<p>x</p>\n</main>')).toEqual([
      'line 4: </main> closes <section> opened on line 2',
      'line 1: <main> is never closed',
    ]);
    expect(unbalanced('<p>x</p>\n</span>')).toEqual([
      'line 2: </span> closes nothing',
    ]);
  });

  it('row 2 NEAR-MISS: void elements and self-closing SVG are not failures', () => {
    // The rule this checker must NOT have. `<meta>` and `<link>` never close,
    // `<br>` never closes, and an inline `<path/>` closes itself. A balance
    // check that called any of those an error would be a check somebody
    // deletes rather than satisfies, so the acceptance is asserted, not
    // assumed.
    expect(
      unbalanced(
        '<!doctype html>\n<!-- <div> in a comment -->\n<head><meta charset="utf-8"><link rel="icon" href="/favicon.svg"></head>\n<svg><rect x="1"/><path d="M0 0"/><br></svg>',
      ),
    ).toEqual([]);
    // And the doctype-and-comment blanking preserves line numbers, which is
    // the only reason a failure is worth reading.
    expect(unbalanced('<!doctype html>\n<!--\n\n-->\n<div>')).toEqual([
      'line 5: <div> is never closed',
    ]);
  });

  /* ── row 3: colour is written down in exactly one place per page ────── */

  it('row 3: no docs page writes a hex outside its own :root block', () => {
    const offenders: string[] = [];
    for (const rel of DOCS)
      offenders.push(...hexOutsideTokenBlock(rel, read(rel)));
    expect(offenders).toEqual([]);
  });

  it('row 3 non-vacuity: the token block exists and is where the colour is', () => {
    // The mask this rule depends on is `:root{ ... }`. If a page stopped
    // spelling it that way the span would be `[-1, -1]`, every hex would be
    // "outside", and row 3 would fail loudly. The failure worth guarding is
    // the opposite one: a page with NO hex anywhere passes row 3 while
    // proving nothing, and a page whose token block swallowed the whole
    // document would too. So both ends are pinned.
    for (const rel of DOCS) {
      const html = read(rel);
      const [open, close] = tokenBlockSpan(html);
      expect([rel, open >= 0 && close > open]).toEqual([rel, true]);
      const inside = [...html.slice(open, close).matchAll(HEX_RE)].map(
        (m) => m[0],
      );
      // The blue bubble at least, and the page background. If a page ever
      // held one colour it would be `--tint`, and it holds more than that.
      expect([rel, inside.length >= 2]).toEqual([rel, true]);
      // The block is a token sheet, not the page: it ends long before the
      // document does.
      expect([rel, close < html.length / 2]).toEqual([rel, true]);
    }
  });

  it('row 3 teeth: a hex planted outside the block is named with its line', () => {
    // The exact mutation the teeth proof plants by hand, run here against a
    // string so the row is self-contained. Two claims: it is caught, and the
    // finding carries the file and the line, because a sweep that says only
    // "there is a colour somewhere in site/" is a sweep nobody can act on.
    const page = [
      '<style>',
      '  :root{ --tint:#0A84FF; --bg:#08090c; }',
      '  .approve{background:var(--tint)}',
      `  .go{background:${GREEN_30}}`,
      '</style>',
    ].join('\n');
    expect(hexOutsideTokenBlock('site/docs/probe.html', page)).toEqual([
      `site/docs/probe.html:4: ${GREEN_30}`,
    ]);
    // NEAR-MISS: the same colour INSIDE the block is not this rule's finding.
    // Locality is what row 3 enforces; whether a token is green is the
    // no-green sweep's question, and it is asked over `site/` already.
    expect(
      hexOutsideTokenBlock(
        'site/docs/probe.html',
        `<style>\n  :root{ --go:${GREEN_30}; }\n</style>`,
      ),
    ).toEqual([]);
    // NEAR-MISS: a fragment link is not a colour. `#faq` and `#top` are the
    // two the landing page really carries, and a naive `#[0-9a-f]+` would
    // convict `#faq` of being a three-digit hex the moment somebody wrote
    // `#fab`. The word boundary is what stops it.
    expect(
      hexOutsideTokenBlock('site/index.html', '<a href="#faq">FAQ</a>'),
    ).toEqual([]);
  });

  /* ── row 4 (plan row 11): the landing page reaches the docs ─────────── */

  it('row 4: index.html links to the install page and to the releases list', () => {
    const html = read(INDEX);
    expect(html).toContain('href="/docs/install.html"');
    expect(html).toContain(`href="${RELEASES}"`);
    // The releases LIST, not `releases/latest`, which excludes prereleases
    // and therefore resolves to nothing while the newest published thing is
    // a release candidate. Same reasoning as `readme.spec.ts` row 2.
    expect(html).not.toContain('releases/latest');
    // Sc 1 row 2 stays green. This is asserted here as well as in the
    // no-green sweep because THIS is the file this scenario edits, and a row
    // that names the file it touched is the row that fails legibly.
    expect(html.toLowerCase()).not.toContain(GREEN_30.toLowerCase());
  });

  /* ── row 5: no dead links, on any of the six pages ──────────────────── */

  it('row 5: every site-absolute link on every page resolves to a real file', () => {
    const broken: string[] = [];
    let checked = 0;
    for (const rel of [INDEX, ...DOCS])
      for (const href of hrefsOf(read(rel))) {
        const target = resolveSiteHref(href);
        if (target === undefined) continue;
        checked += 1;
        if (!existsSync(join(repoRoot, target)))
          broken.push(`${rel}: ${href} -> ${target}`);
      }
    expect(broken).toEqual([]);
    // Not vacuous: six pages, each with a home link, a favicon and a nav
    // that names all five docs pages, is a lot more than a handful.
    expect(checked).toBeGreaterThanOrEqual(30);
  });

  /* ── row 6: the public sweep reaches the pages ──────────────────────── */

  it('row 6: no docs page leaks a brand, a contact, a token, a path or an inbox', () => {
    for (const rel of DOCS) {
      const text = read(rel);
      expect([
        rel,
        publicStringOffenders(text).map((o) => `${o.rule}: ${o.detail}`),
      ]).toEqual([rel, []]);
      expect([rel, EMAIL_RE.test(text)]).toEqual([rel, false]);
    }
    /*
     * Not vacuous: the predicate really does convict, on a string shaped
     * like the thing a docs page would plausibly grow.
     *
     * TWO things had to be got right here, and the first one caught this row
     * on its first run. The probe number must NOT be in the `+1555` block,
     * because that prefix is the synthetic fiction the whole suite writes
     * with and `publicStringOffenders` deliberately lets it through; a probe
     * using it proves the arm is silent rather than that it fires.
     *
     * And the number is ASSEMBLED, because this file is itself inside the
     * tree-wide sweep that `test/arch.spec.ts` runs. A real-shaped `+1`
     * literal sitting in the source would convict this spec of the thing
     * this spec is checking for. The fragments read as `+1${'...'}` on disk,
     * so the pattern only exists at runtime, which is the same move
     * `apps/desktop/test/tokens.spec.ts` makes with its green hexes.
     */
    const probe = `+1${'2025550100'}`;
    expect(
      publicStringOffenders(`ask the maintainer on ${probe} today`).map(
        (o) => o.rule,
      ),
    ).toEqual(['non-synthetic-contact']);
  });

  /* ── row 7: F-142, on the surface a user reads before updating ──────── */

  it('row 7: permissions.html makes all three Full Disk Access claims', () => {
    /*
     * The same three claims, asserted with the same three regexes, that
     * `readme.spec.ts` row 10 asserts against `README.md`, the rc.1
     * changelog section and `packages/daemon/src/doctor.ts`. Copied
     * deliberately rather than imported: those live in a different spec file
     * with a different subject, and what matters is that the SITE is held to
     * the standard the repo is held to, not that one array is shared.
     *
     * Claims, not phrases, because a paraphrase is fine and a missing claim
     * is not. An UPDATE is the trigger; the entry must be REMOVED and added
     * back rather than toggled; and the switch still LOOKS on while reads
     * fail. The third is the one a writer drops first and the one that stops
     * a reader concluding the instructions are wrong.
     */
    const text = read(PERMISSIONS);
    const claims: [string, RegExp][] = [
      [
        'names the update as the trigger',
        /after (?:an|you install a new|every) update/i,
      ],
      [
        'says to remove the existing entry',
        /remov(?:e|ing) (?:the )?(?:it|WeMessage|the entry)/i,
      ],
      [
        'says the switch still looks on',
        /(?:stays|still)[^.]{0,40}(?:switched on|on\b|filled|enabled)/i,
      ],
    ];
    expect(claims.filter(([, re]) => !re.test(text)).map(([c]) => c)).toEqual(
      [],
    );
    // And the fourth thing, which is not in the README's three because the
    // README says it in a sentence the regexes happen to cover: toggling is
    // NOT the fix. This is the step people skip, so the page has to say so
    // in words a reader cannot misread as a synonym for re-granting.
    expect(text).toMatch(/[Tt]oggling[^.]{0,60}does not work/);
    // Both grants are named, so the page is a permissions page and not a
    // page about one permission.
    expect(text).toContain('Full Disk Access');
    expect(text).toContain('Automation');
  });

  /* ── row 8: the unsigned lane, said on the page that sells the download */

  it('row 8: install.html documents Open Anyway and pins no version', () => {
    const text = read(INSTALL);
    expect(text.toLowerCase()).toContain('unsigned');
    // The macOS 15 flow by name. Right-click-Open stopped working for
    // unsigned apps in Sequoia, so a page that only said "right click and
    // choose Open" would send the reader in a circle.
    expect(text).toContain('Open Anyway');
    expect(text).toContain('com.apple.quarantine');
    expect(text).toContain('SHA256SUMS');
    // The releases list, and no file with a version in its name. A hex
    // colour is not a version and neither is a CSS length, so the sweep is
    // for a dotted triple, which is what a version actually looks like and
    // what `readme.spec.ts` row 2 greps for.
    expect(text).toContain(RELEASES);
    expect(text).not.toContain('releases/latest');
    expect([...text.matchAll(/\b\d+\.\d+\.\d+\b/g)].map((m) => m[0])).toEqual(
      [],
    );
    // Both install routes, so the page is not half a page.
    expect(text).toContain('brew tap raybman/wemessage');
    expect(text).toContain('brew install --cask wemessage');
  });

  /* ── row 9: the security page publishes no inbox ────────────────────── */

  it('row 9: security.html routes through GitHub and carries no address', () => {
    const text = read(SECURITY);
    // No `@` AT ALL, which is stricter than "no email" and is the version a
    // future editor cannot accidentally satisfy with a mangled address. It
    // is also why the shared stylesheet on these pages carries no at-rules:
    // one `@media` would be enough to end this row, and a page that has to
    // choose between a breakpoint and a guarantee should not have to.
    expect(text.split('@')).toHaveLength(1);
    expect(text).toContain('Report a vulnerability');
    // The unsigned lane is declared out of scope IN THE POLICY, in the same
    // words `SECURITY.md` uses, so a report saying "Gatekeeper rejects your
    // app" gets a documented answer rather than a maintainer's time.
    expect(text).toContain('not notarized');
    // Not vacuous: an empty file would pass every assertion above except the
    // two `toContain`s, and a nearly-empty one would pass all of them.
    expect(text.length).toBeGreaterThan(3000);
  });

  /* ── row 10: F-125, the verb is on the daemon ───────────────────────── */

  it('row 10: launchd.html puts service verbs on wemessaged, never wemessage', () => {
    const text = read(LAUNCHD);
    // Deep-equal on the whole verb set, so a page that documents three of
    // four fails naming the one it dropped.
    const verbs = ['install', 'uninstall', 'status', 'restart'] as const;
    expect(
      verbs.filter((v) => !text.includes(`wemessaged service ${v}`)),
    ).toEqual([]);
    /*
     * F-125. `service` is a subcommand of the DAEMON, and `wemessage` is the
     * operator CLI. The two names differ by one letter, the wrong one is the
     * one a reader has already typed a hundred times, and a docs page that
     * spells it wrong is a page that produces a support question rather than
     * a running service. The CLI itself refuses and points at the daemon;
     * this row is the same guard aimed at the prose.
     *
     * The word boundary is what makes this assertion possible at all:
     * `wemessaged service install` contains the substring `wemessage`, so a
     * naive `includes` check could never distinguish the right spelling from
     * the wrong one.
     */
    expect(text).not.toMatch(/\bwemessage service\b/);
    // The page also has to say WHERE the plist lands, or `service install` is
    // a command with an invisible effect.
    expect(text).toContain('sh.wemessage.gateway.plist');
    expect(text).toContain('LaunchAgents');
  });

  /* ── row 11: uninstall names all three things, not the polite two ───── */

  it('row 11: uninstall.html removes the agent, the app and the state', () => {
    const text = read(UNINSTALL);
    const required: [string, string][] = [
      ['the LaunchAgent', 'wemessaged service uninstall'],
      ['the app bundle', '/Applications/WeMessage.app'],
      // The state directory BY ITS VARIABLE NAME. The default path is only
      // the default: the daemon, the CLI and the app all read
      // `WEMESSAGE_DIR`, so a page that names the path and not the variable
      // tells an operator with a custom value to delete an empty directory
      // and call it done.
      ['the state directory', 'WEMESSAGE_DIR'],
      ['the default state path', 'Library/Application'],
    ];
    expect(
      required.filter(([, s]) => !text.includes(s)).map(([w]) => w),
    ).toEqual([]);
    // Revoking the grants is part of removing the app, and it is the part an
    // uninstaller structurally cannot do for you.
    expect(text).toContain('Full Disk Access');
    expect(text).not.toMatch(/\bwemessage service\b/);
  });
});
