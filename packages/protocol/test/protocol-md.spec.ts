/**
 * s7-execution Scenario 12 — the protocol reference, GENERATED and DIFFED.
 *
 * `PROTOCOL.md` is the first artifact in this repo whose entire audience is
 * outside it: a stranger writing an adapter, reading a file rather than our
 * TypeScript. That makes it the one document with a failure mode worse than
 * being wrong, which is being CONFIDENTLY wrong — a hand-written protocol
 * reference is correct on the day it is written and quietly false forever
 * after, and every reader who trusts it builds on the falsehood.
 *
 * So it is not written. It is rendered from the runtime tables and diffed:
 *
 *   FRAME_SPECS          the nine frames, their keys and their direction
 *   GATEWAY_EVENT_NAMES  the twenty-one event names
 *   EVENT_SPECS          each event's required and optional keys
 *   CLOSE_CODES          the four close codes the transport actually sends
 *   src/schemas/**.json   the `$id` a validator resolves, per frame and event
 *   WIRE_VERSION         the number in every envelope
 *
 * Six sources, none of them prose. Changing any of them changes this file's
 * expected bytes, and row 1 fails until the document is regenerated. That is
 * the whole design: the document cannot be stale, because staleness is a
 * build failure rather than a reading comprehension problem.
 *
 * THE IDIOM IS SC 11'S, deliberately not a second one. `skills/claude/
 * DRYRUN.md` established it: the suite ALWAYS compares, and an environment
 * variable only controls whether the comparison is preceded by a rewrite.
 * CI never sets it, so CI never writes; a builder who changed a source of
 * truth runs
 *
 *   WEMESSAGE_WRITE_PROTOCOL_MD=1 pnpm vitest run --project protocol protocol-md
 *
 * and commits the diff. A generator with its own `pnpm gen:docs` script would
 * be a second idiom for one problem and a step somebody eventually forgets.
 *
 * INV-2 IS A ROW HERE (C-6 taxonomy pin, and §0.4). The single worst bug this
 * scenario could ship is a generated document that describes a send frame,
 * because that document is what a stranger implements against — it would be
 * this repo publishing an invitation to build the one thing the whole system
 * exists to prevent. Row 4 asserts the negative from three directions: the
 * rendered frame set has nine members and no send-shaped name, the document
 * carries the sentence under its own heading, and the only path it describes
 * to a recipient runs through a human approval.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CLOSE_CODES,
  EVENT_SPECS,
  FRAME_SPECS,
  GATEWAY_EVENT_NAMES,
  WIRE_VERSION,
} from '../src/index.js';
import {
  readProtocolMdSources,
  renderProtocolMarkdown,
} from './helpers/gen-protocol-md.js';

const here = dirname(fileURLToPath(import.meta.url));
const DOC_PATH = join(here, '../PROTOCOL.md');
const doc = (): string => readFileSync(DOC_PATH, 'utf8');

/* ── row 1: the document is the generator's output ──────────────────────── */

describe('s7 Sc12 row 1: PROTOCOL.md is generated, never hand-maintained', () => {
  it('the committed file equals the generator, byte for byte', () => {
    const rendered = renderProtocolMarkdown(readProtocolMdSources());
    // Written only when asked for. A CI run that could rewrite the artifact
    // it is checking would be checking nothing at all.
    if (process.env['WEMESSAGE_WRITE_PROTOCOL_MD'] === '1')
      writeFileSync(DOC_PATH, rendered);
    expect(doc()).toBe(rendered);
  });

  it('is deterministic: two renders of the same sources agree', () => {
    // No timestamp, no clock, no `Date`, no ordering that depends on a
    // filesystem walk. A document that changes when nothing changed is a
    // document whose diff nobody reads.
    const sources = readProtocolMdSources();
    expect(renderProtocolMarkdown(sources)).toBe(
      renderProtocolMarkdown(sources),
    );
    expect(renderProtocolMarkdown(readProtocolMdSources())).toBe(
      renderProtocolMarkdown(sources),
    );
    // The document holds one fixed example timestamp on purpose, so a bare
    // date-shaped regex would be a false positive. Ask the two questions
    // that actually matter instead: the renderer never reaches for a clock,
    // and nothing it produced is today.
    const genSrc = readFileSync(
      join(here, 'helpers/gen-protocol-md.ts'),
      'utf8',
    );
    expect(genSrc).not.toMatch(/\bnew Date\b|\bDate\.now\b/);
    expect(rendered()).not.toContain(new Date().toISOString().slice(0, 10));
  });
});

function rendered(): string {
  return renderProtocolMarkdown(readProtocolMdSources());
}

/* ── row 2: every source of truth reaches the page ──────────────────────── */

describe('s7 Sc12 row 2: the document enumerates what the runtime enumerates', () => {
  const schemaDir = join(here, '../src/schemas');

  it('carries a section per frame, with direction, keys and schema $id', () => {
    const body = doc();
    const names = Object.keys(FRAME_SPECS);
    expect(names).toHaveLength(9);
    for (const name of names) {
      const spec = FRAME_SPECS[name as keyof typeof FRAME_SPECS];
      expect(body, `no section for frame ${name}`).toContain(`### \`${name}\``);
      expect(body, `no direction for ${name}`).toContain(spec.direction);
      for (const key of spec.required)
        expect(body, `${name}.${key} missing`).toContain(key);
      for (const key of spec.optional)
        expect(body, `${name}.${key} missing`).toContain(key);
      const schema: unknown = JSON.parse(
        readFileSync(join(schemaDir, `${name}.json`), 'utf8'),
      );
      const id = (schema as { $id?: string }).$id ?? '';
      expect(id).not.toBe('');
      expect(body, `${name} schema $id missing`).toContain(id);
    }
  });

  it('carries a section per event, with its keys and schema $id', () => {
    const body = doc();
    // s8 Sc 2 (F-107): 17 -> 21, the four owed `draft.*` lifecycle names.
    expect(GATEWAY_EVENT_NAMES).toHaveLength(21);
    for (const name of GATEWAY_EVENT_NAMES) {
      expect(body, `no section for event ${name}`).toContain(`### \`${name}\``);
      for (const key of EVENT_SPECS[name].required)
        expect(body, `${name}.${key} missing`).toContain(key);
      for (const key of EVENT_SPECS[name].optional)
        expect(body, `${name}.${key} missing`).toContain(key);
      const schema: unknown = JSON.parse(
        readFileSync(join(schemaDir, 'events', `${name}.json`), 'utf8'),
      );
      const id = (schema as { $id?: string }).$id ?? '';
      expect(body, `${name} schema $id missing`).toContain(id);
    }
  });

  it('carries the close-code table and the wire version', () => {
    const body = doc();
    for (const [name, spec] of Object.entries(CLOSE_CODES)) {
      expect(body, `close code ${name} missing`).toContain(String(spec.code));
      expect(body, `close code ${name} unexplained`).toContain(spec.meaning);
    }
    expect(body).toContain(`wire version ${String(WIRE_VERSION)}`);
  });

  it('accounts for every schema file on disk, in both directories', () => {
    // The reverse of the two rows above. Those prove every runtime name has
    // a section; this proves the disk holds nothing the document forgot,
    // which is the direction a stale generator fails in.
    const frameFiles = readdirSync(schemaDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
    // `event.json` is the loose frame-level union, not a frame of its own.
    expect(frameFiles).toEqual([...Object.keys(FRAME_SPECS)].sort());
    const eventFiles = readdirSync(join(schemaDir, 'events'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
    expect(eventFiles).toEqual([...GATEWAY_EVENT_NAMES].sort());
  });
});

/* ── row 3: nothing in the document is invented ─────────────────────────── */

describe('s7 Sc12 row 3: the document names no frame or event that exists', () => {
  /**
   * Every backticked dotted token whose prefix belongs to the wire. Scoped
   * to the prefixes the protocol actually uses so that `example.com`,
   * `chat.db` and `package.json` are not read as claims about frames; and
   * to `[a-z]+` on both halves so that audit labels like
   * `adapter.no-send-frame`, which are hyphenated and are not frames, are
   * out of the grammar rather than exempted from it.
   */
  const WIRE_TOKEN =
    /`((?:draft|proactive|adapter|arming|connection|gate|gateway|message|rule|toggle|event)\.[a-z]+)`/g;

  it('every wire-shaped token in the document is a real name', () => {
    const known = new Set<string>([
      ...Object.keys(FRAME_SPECS),
      ...GATEWAY_EVENT_NAMES,
    ]);
    const offenders = [
      ...new Set([...doc().matchAll(WIRE_TOKEN)].map((m) => m[1] ?? '')),
    ]
      .filter((name) => !known.has(name))
      .sort();
    expect(offenders).toEqual([]);
  });

  it('the grammar is not vacuous: it sees the names that are there', () => {
    // A reverse check that costs one line and stops the row above from
    // passing because the regex stopped matching anything at all.
    const seen = new Set(
      [...doc().matchAll(WIRE_TOKEN)].map((m) => m[1] ?? ''),
    );
    for (const name of ['draft.request', 'draft.submit', 'draft.created'])
      expect(seen, `${name} not seen by the drift grammar`).toContain(name);
    expect(seen.size).toBeGreaterThanOrEqual(20);
  });
});

/* ── row 4: INV-2, in the public document ───────────────────────────────── */

describe('s7 Sc12 row 4: the generated document has no send frame (INV-2)', () => {
  it('renders nine frames and not one of them is send-shaped', () => {
    const body = doc();
    expect(Object.keys(FRAME_SPECS)).toHaveLength(9);
    // The rendered frame headings, read back out of the document rather than
    // out of the table that produced them. Scoped to the `## Frames` section
    // because `draft.delta` is BOTH a frame and an event and appears under
    // two headings, which is a fact about the wire and not a duplicate.
    const frames = body.slice(
      body.indexOf('\n## Frames\n'),
      body.indexOf('\n## Events\n'),
    );
    const headings = [...body.matchAll(/^### `([a-z.]+)`$/gm)].map(
      (m) => m[1] ?? '',
    );
    const frameHeadings = [...frames.matchAll(/^### `([a-z.]+)`$/gm)]
      .map((m) => m[1] ?? '')
      .sort();
    expect(frameHeadings).toEqual([...Object.keys(FRAME_SPECS)].sort());
    for (const h of headings) expect(h).not.toMatch(/(^|\.)send($|\.)/);
    // And no rendered table row claims a type this repo cannot parse.
    expect(body).not.toMatch(/"type"\s*:\s*"send"/);
  });

  it('says so in words, under its own heading', () => {
    const body = doc();
    const at = body.indexOf('## What the protocol cannot do');
    expect(at, 'the heading INV-2 lives under is missing').toBeGreaterThan(-1);
    const section = body.slice(at, body.indexOf('\n## ', at + 1));
    expect(section).toContain('There is no send frame.');
  });

  it('documents approve-before-send as the path, and is honest about POST /v1/send', () => {
    const body = doc();
    const at = body.indexOf('## What the protocol cannot do');
    const section = body.slice(at, body.indexOf('\n## ', at + 1));
    // The model a stranger should build against.
    expect(section).toContain('POST /v1/drafts/:id/approve');
    expect(section).toMatch(/approve/i);
    // The route that exists and is not that model. Sc 11 found it mints its
    // own approval and dispatches in one call, which is why `send *` is on
    // SKILL.md's never list; a public document that let a reader mistake it
    // for "how an agent sends" would undo the entire approval gate.
    expect(section).toContain('POST /v1/send');
    expect(section).toContain('cannot reach it');
    // It is never offered as an adapter's option.
    expect(body).not.toMatch(/adapters?[^.\n]{0,40}POST \/v1\/send/i);
  });
});
