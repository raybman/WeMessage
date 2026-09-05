/**
 * s7-execution Scenario 2 — the §3.4 event vocabulary as DATA (F-83).
 *
 * Until this file, the only runtime list of gateway event names in the repo
 * lived in a daemon TEST snapshot (`transport-surface.snapshot.ts`), which no
 * consumer can import: the protocol package shipped `GatewayEventPayload` as a
 * TYPE and nothing else. That was survivable while the only reader was our own
 * TypeScript. It stops being survivable the moment an SSE filter has to refuse
 * an unknown name at runtime (Sc 3), a doc generator has to enumerate per-event
 * shapes (Sc 12), or a stranger's adapter has to validate a frame it did not
 * compile against.
 *
 * So the vocabulary becomes what the frame vocabulary already was: a data
 * table (`EVENT_SPECS`, the `FRAME_SPECS` idiom) plus one JSON Schema per
 * member, with the guard, the schemas and the TYPE pinned to each other. The
 * type stays the source of truth for TypeScript consumers — `events.ts` carries
 * compile-time `Equals` assertions in both directions, so a new variant that
 * forgets its row does not compile — and these rows are the runtime half of
 * that same pin, because the JSON Schemas are files on disk that the compiler
 * cannot see at all.
 *
 * The negative rows are the point (C-3). A schema that cannot say no is
 * decoration.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EVENT_SPECS,
  FRAME_SPECS,
  GATEWAY_EVENT_NAMES,
  isGatewayEventName,
} from '../src/index.js';
import type {
  DraftSummary,
  GatewayEventName,
  GatewayEventPayload,
} from '../src/index.js';
// Type-only, exactly as `src/index.ts` reaches for them: the point of the
// clamp rows below is that `clampedBy` is the SAME union in both places, and
// a copy of the twelve words here would be the parallel vocabulary C-6 bans.
import type { GateDecision, GateDenyReason } from '@wemessage/core';
// s7 Sc 3 relocated this checker into `@wemessage/fixtures` (the repo's
// test-support package) so the daemon's WS/SSE parity rows can use the very
// same validator against real wire bytes. Import path only; behaviour identical.
import { schemaErrors, type JsonSchema } from '@wemessage/fixtures';

const here = dirname(fileURLToPath(import.meta.url));
const eventSchemaDir = join(here, '../src/schemas/events');
const frameSchemaDir = join(here, '../src/schemas');
// The fixtures live at the repo root (Part 3) rather than inside this package
// because Sc 3 broadcasts the same 17 files through the daemon's real sink and
// Sc 13 replays them end to end. One canonical payload per event, or three
// slices quietly disagree about what a `draft.sent` looks like.
const fixtureDir = join(here, '../../../fixtures/events');

function readJson(path: string): JsonSchema {
  return JSON.parse(readFileSync(path, 'utf8')) as JsonSchema;
}

function eventSchema(name: GatewayEventName): JsonSchema {
  return readJson(join(eventSchemaDir, `${name}.json`));
}

function fixture(name: GatewayEventName): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(fixtureDir, `${name}.json`), 'utf8'),
  ) as Record<string, unknown>;
}

describe('gateway event vocabulary as data (s7 Scenario 2, F-83)', () => {
  it('exports 21 distinct names, sorted, with a runtime membership guard', () => {
    // s8 Scenario 2 (F-107): 17 -> 21. The four `draft.*` lifecycle names
    // S4's F-39 deferred, S5 Scenario 7 re-deferred, and the ratchet's own
    // comment #17 assigned to S8 BY NAME. They are DECLARED here and emitted
    // by nothing until Sc 3; the gap is enumerated and asserted in
    // `packages/daemon/test/transport-surface.ratchet.spec.ts` rather than
    // tolerated, so "declared" cannot quietly mean "forgotten".
    expect(GATEWAY_EVENT_NAMES).toHaveLength(21);
    expect(new Set(GATEWAY_EVENT_NAMES).size).toBe(21);
    // Sorted because the daemon ratchet snapshot is sorted and the two are
    // asserted deepEqual over there: an unsorted list here would make that
    // pin a diff-ordering puzzle instead of a review.
    expect([...GATEWAY_EVENT_NAMES]).toEqual([...GATEWAY_EVENT_NAMES].sort());
    for (const name of GATEWAY_EVENT_NAMES) {
      expect(isGatewayEventName(name), name).toBe(true);
    }
    // The guard is what the SSE filter will call on a query string, so it has
    // to refuse the shapes a query string can actually carry.
    for (const notAName of [
      'draft.previewed',
      'draft.sent ',
      'DRAFT.SENT',
      '',
      'toString',
      'constructor',
      null,
      undefined,
      42,
      ['draft.sent'],
    ]) {
      expect(isGatewayEventName(notAName), String(notAName)).toBe(false);
    }
  });

  it('has exactly one EVENT_SPECS row per name, keys disjoint and unique', () => {
    expect(Object.keys(EVENT_SPECS).sort()).toEqual([...GATEWAY_EVENT_NAMES]);
    for (const name of GATEWAY_EVENT_NAMES) {
      const spec = EVENT_SPECS[name];
      const all = [...spec.required, ...spec.optional];
      expect(new Set(all).size, `${name}: duplicate key`).toBe(all.length);
      // `event` is the discriminant, carried by the schema's `required` and by
      // FRAME_SPECS.event.required — never by a per-event row, or it would be
      // counted twenty-one times into the frame's optional union.
      expect(all, name).not.toContain('event');
      expect(all.length, `${name}: no keys at all`).toBeGreaterThan(0);
    }
  });

  it('ships one JSON Schema per name, in parity with its EVENT_SPECS row', () => {
    const files = readdirSync(eventSchemaDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
    expect(files).toEqual([...GATEWAY_EVENT_NAMES]);

    for (const name of GATEWAY_EVENT_NAMES) {
      const schema = eventSchema(name);
      const spec = EVENT_SPECS[name];
      expect(schema.type, name).toBe('object');
      expect(schema.additionalProperties, name).toBe(false);
      expect(schema.$id, name).toBe(
        `https://wemessage.dev/schemas/v1/events/${name}.json`,
      );
      expect([...(schema.required ?? [])].sort(), name).toEqual(
        ['event', ...spec.required].sort(),
      );
      expect(Object.keys(schema.properties ?? {}).sort(), name).toEqual(
        ['event', ...spec.required, ...spec.optional].sort(),
      );
      // The discriminant is pinned per file, so a copy-pasted schema that
      // forgot to change one word is a failure rather than a permissive twin.
      expect(schema.properties?.['event']?.const, name).toBe(name);
    }
  });

  it('derives FRAME_SPECS.event.optional from the per-event rows', () => {
    const union = new Set<string>();
    for (const name of GATEWAY_EVENT_NAMES) {
      for (const key of EVENT_SPECS[name].required) union.add(key);
      for (const key of EVENT_SPECS[name].optional) union.add(key);
    }
    expect([...FRAME_SPECS.event.required]).toEqual(['event']);
    expect([...FRAME_SPECS.event.optional]).toEqual([...union].sort());
    // ...and `event.json` cannot drift from the per-event files either: the
    // frame schema's key set is the same union, checked by the S5 parity row
    // in wire-protocol.spec.ts. Here we pin the direction that row cannot see:
    // that the union is not merely equal by luck but covers every event key.
    const frameSchema = readJson(join(frameSchemaDir, 'event.json'));
    for (const key of union) {
      expect(Object.keys(frameSchema.properties ?? {}), key).toContain(key);
    }
  });

  it('validates each canonical fixture, and refuses two mutations of it', () => {
    const fixtures = readdirSync(fixtureDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
    expect(fixtures).toEqual([...GATEWAY_EVENT_NAMES]);

    for (const name of GATEWAY_EVENT_NAMES) {
      const schema = eventSchema(name);
      const payload = fixture(name);
      expect(payload['event'], name).toBe(name);
      expect(schemaErrors(schema, payload), name).toEqual([]);

      // (a) one extra key. This is the mutation that matters most: a v2 peer's
      // new field arriving at a v1 reader, which `payloadKeysOk` already
      // refuses on the wire and which the schema must refuse too, or a
      // stranger's validator would accept frames our own guard rejects.
      const widened = { ...payload, unexpectedKey: 'x' };
      expect(schemaErrors(schema, widened).join('; '), name).toContain(
        "additional key 'unexpectedKey'",
      );

      // (b) one required key removed, walked over EVERY required key rather
      // than the first: a schema that lists a key in `properties` but forgot
      // it in `required` passes the single-key version by accident.
      for (const key of ['event', ...EVENT_SPECS[name].required]) {
        const narrowed = { ...payload };
        delete narrowed[key];
        expect(
          schemaErrors(schema, narrowed).join('; '),
          `${name} minus ${key}`,
        ).toContain(`missing required key '${key}'`);
      }
    }
  });

  it('keeps event.json a closed enum over the 21, and refuses a stranger', () => {
    const frameSchema = readJson(join(frameSchemaDir, 'event.json'));
    expect([...(frameSchema.properties?.['event']?.enum ?? [])].sort()).toEqual(
      [...GATEWAY_EVENT_NAMES],
    );
    // Every canonical fixture also validates against the union schema, which
    // is what an adapter that does not branch on the name will use.
    for (const name of GATEWAY_EVENT_NAMES) {
      expect(schemaErrors(frameSchema, fixture(name)), name).toEqual([]);
    }
    // A name nobody minted is refused by the union schema, not merely by the
    // per-event lookup failing to find a file.
    const impostor = { ...fixture('draft.sent'), event: 'draft.previewed' };
    expect(schemaErrors(frameSchema, impostor).join('; ')).toContain(
      'is not one of the enum',
    );
  });
});

/* ────────────────────────────────────────────────────────────────────── *
 * s8 Scenario 2 (F-107): the four owed `draft.*` lifecycle events, and the
 * clamp reason on the live draft frame.
 *
 * These four names are the oldest debt in the transport surface. S4's F-39
 * deferred `draft.expired` / `draft.superseded` / `draft.redrafted` because
 * nothing could read them; S5 Scenario 7 re-deferred them for the same
 * reason while shipping `draft.delta`; S6's F-72 minted the fourth
 * (`draft.requeued`) as an audit row with no wire twin. A queue that a human
 * WATCHES rather than polls cannot be built on a vocabulary that never says
 * a card left the queue, so S8 mints them — and mints them here, in the
 * protocol package, one scenario BEFORE any daemon constructs one.
 *
 * That ordering is the S5/S7 rule (a protocol change gets its own parity
 * test before an emitter exists) and it has a cost this scenario pays
 * openly: between this commit and Sc 3 the declared vocabulary is WIDER than
 * what the daemon emits. The alternative — declare and emit in one commit —
 * would put a wire-format change and a behaviour change in the same diff,
 * which is the shape of commit the whole ratchet exists to prevent. So the
 * gap is made explicit instead: `UNEMITTED_WS_EVENTS` in the daemon's
 * deliberate-update snapshot names these four and only these four, the
 * partition row there asserts emitted ∪ unemitted == this list exactly, and
 * Sc 3 cannot land without emptying it.
 * ────────────────────────────────────────────────────────────────────── */

/** Type-level equality, invariant in both directions (the `Assert` idiom). */
type Assert<T extends true> = T;
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

describe('the four owed draft lifecycle events (s8 Scenario 2, F-107)', () => {
  /** Sorted, because that is how they sit in the vocabulary. */
  const OWED = [
    'draft.expired',
    'draft.redrafted',
    'draft.requeued',
    'draft.superseded',
  ] as const;

  it('row 1: the four join the vocabulary in sorted position, and are real names', () => {
    // Written as the whole list rather than four membership checks: the
    // ORDER is load-bearing (the daemon snapshot is sorted and pinned
    // deepEqual to this array), and a list literal is the only assertion
    // that fails when a name lands in the wrong place.
    expect([...GATEWAY_EVENT_NAMES]).toEqual([
      'adapter.health',
      'arming.changed',
      'connection.state',
      'draft.approved',
      'draft.created',
      'draft.delta',
      'draft.expired',
      'draft.failed',
      'draft.recalled',
      'draft.redrafted',
      'draft.rejected',
      'draft.requeued',
      'draft.sent',
      'draft.superseded',
      'gate.denied',
      'gateway.disconnected',
      'message.edited',
      'message.received',
      'message.unsent',
      'rule.matched',
      'toggle.changed',
    ]);
    for (const name of OWED) {
      expect(isGatewayEventName(name), name).toBe(true);
    }
  });

  it('row 2: each row carries the ids a subscriber reconciles on, and nothing else', () => {
    /**
     * `draftId` is the anchor in EVERY `draft.*` variant already on the wire
     * (`draft.approved`, `draft.sent`, `draft.failed`), so it is the anchor
     * here too: a subscriber's reconciliation reads `payload.draftId` to
     * find the card, and a variant that called its subject `fromDraftId`
     * would make one of twelve draft events need a special case.
     *
     * The AUDIT rows for the same three facts spell it differently
     * (`draft.redrafted {fromDraftId, toDraftId}`, `draft.superseded
     * {draftId, supersededBy?}`), and that divergence is deliberate rather
     * than an oversight: an audit row is a ledger entry in which both ids are
     * equal citizens and there is no "subject", while a wire frame is
     * addressed AT a card somebody is looking at. Same fact, two readers,
     * two shapes — and the emit sites Sc 3 wires supply both ids in every
     * case, so nothing here is optional out of doubt.
     *
     * `draft.requeued` carries no `reason`, and that is the loudest choice
     * in this row. The requeue site in `core/src/sending/dispatcher.ts` has
     * the `GateDenyReason` in hand and writes TWO audit rows with it — a
     * `draft.requeued` saying what became of the draft and a `gate.denied`
     * saying why — and the daemon already broadcasts the `gate.denied` frame
     * from that same path. Repeating the word in this frame would put one
     * reason on two frames from one event, and the first subscriber that
     * rendered both would show the operator the same denial twice.
     */
    expect(EVENT_SPECS['draft.expired']).toEqual({
      required: ['draftId'],
      optional: [],
    });
    expect(EVENT_SPECS['draft.superseded']).toEqual({
      required: ['draftId', 'byDraftId'],
      optional: [],
    });
    expect(EVENT_SPECS['draft.redrafted']).toEqual({
      required: ['draftId', 'newDraftId'],
      optional: [],
    });
    expect(EVENT_SPECS['draft.requeued']).toEqual({
      required: ['draftId'],
      optional: [],
    });
  });

  it('row 2b: four names cost two payload keys and ZERO frames (INV-2)', () => {
    // The whole derived union as a literal, 22 -> 24. Written out rather
    // than checked with `toContain` because the arithmetic is the claim:
    // three of the four new variants reuse `draftId`, so a vocabulary that
    // grew by four names widened the frame's key set by exactly two.
    expect([...FRAME_SPECS.event.optional]).toEqual([
      'actor',
      'adapterId',
      'armed',
      'batchId',
      'byDraftId',
      'chatGuid',
      'correlation',
      'draft',
      'draftId',
      'error',
      'guid',
      'key',
      'message',
      'newDraftId',
      'newText',
      'reason',
      'ruleId',
      'sentMessageGuid',
      'seq',
      'state',
      'status',
      'textDelta',
      'until',
      'value',
    ]);
    // INV-2, restated where it could plausibly be broken: growing the event
    // vocabulary must not grow the FRAME vocabulary. Nine frames, no send.
    expect(Object.keys(FRAME_SPECS)).toHaveLength(9);
    expect(Object.keys(FRAME_SPECS).filter((t) => /send/i.test(t))).toEqual([]);
  });

  it('row 3: each ships a schema and a canonical fixture that its schema accepts', () => {
    for (const name of OWED) {
      const schema = eventSchema(name);
      const payload = fixture(name);
      expect(schema.$id, name).toBe(
        `https://wemessage.dev/schemas/v1/events/${name}.json`,
      );
      expect(schemaErrors(schema, payload), name).toEqual([]);
      // Every id on these frames is a ULID on the wire, and the fixtures use
      // the synthetic 26-character shapes the rest of `fixtures/events` uses.
      for (const key of EVENT_SPECS[name].required) {
        expect(String(payload[key]), `${name}.${key}`).toMatch(
          /^[0-9A-HJKMNP-TV-Z]{26}$/,
        );
      }
      // ...and the two link keys point somewhere ELSE. A frame whose
      // `byDraftId` equalled its `draftId` would be a card superseding
      // itself, which is a bug the schema cannot see and a reader would
      // silently render as a no-op.
      const link = EVENT_SPECS[name].required.find((k) => k !== 'draftId');
      if (link !== undefined) {
        expect(payload[link], `${name}.${link}`).not.toBe(payload['draftId']);
      }
    }
  });

  it('row 4: clampedBy rides the nested draft, closed over the deny taxonomy', () => {
    /**
     * F-64's clamp channel reaches the wire. `clampedBy` is the SAME
     * `GateDenyReason` the allow-arm of `GateDecision` carries — not a
     * parallel "held reason" vocabulary — because S6's organising principle
     * is that a clamp and a deny for one cause are one word in two places.
     * The compile witness below is what actually pins that; the schema enum
     * is the same claim spelled for a stranger who has no compiler of ours.
     *
     * It is a closed `enum` while `gate.denied`'s `reason` is an open
     * `{"type":"string"}`, and the asymmetry is deliberate: this field is
     * minted in this commit and may be born closed at no cost to anyone,
     * while narrowing a field that has been on the published wire since S5
     * would break a stranger's validator in a commit that has no mandate to.
     */
    const schema = eventSchema('draft.created');
    const draftSchema = schema.properties?.['draft'];
    expect(
      draftSchema,
      'draft.created schema must describe its draft',
    ).toBeDefined();
    const CLOSED: readonly GateDenyReason[] = [
      'adapter-disabled',
      'circuit-open',
      'contact-denied',
      'disconnected',
      'group-auto-forbidden',
      'kill-switch',
      'loop-detected',
      'outside-window',
      'rate-limited',
      'read-only',
      'sms-auto-forbidden',
      'unapproved',
    ];
    expect(
      [...(draftSchema?.properties?.['clampedBy']?.enum ?? [])].sort(),
    ).toEqual([...CLOSED]);

    // Every clamp the §1.7 order can produce validates...
    const base = fixture('draft.created');
    const draft = base['draft'] as Record<string, unknown>;
    for (const reason of CLOSED) {
      const clamped = { ...base, draft: { ...draft, clampedBy: reason } };
      expect(schemaErrors(schema, clamped), reason).toEqual([]);
    }
    // ...and a thirteenth word does not. Case matters, and so does empty
    // string: a clamp channel that accepted `''` would let a reader render a
    // clamped card with a blank reason and no way to tell it from a bug.
    for (const impostor of ['held', 'because-i-said-so', 'RATE-LIMITED', '']) {
      expect(
        schemaErrors(schema, {
          ...base,
          draft: { ...draft, clampedBy: impostor },
        }).join('; '),
        impostor,
      ).toContain('is not one of the enum');
    }

    // The UNION schema stays coarse here on purpose, and the row says so out
    // loud rather than leaving a reader to wonder whether it was forgotten.
    // `event.json` describes the envelope: every nested object key on it
    // (`message`, `actor`, `error`, `correlation`, `draft`) is a bare
    // `{"type":"object"}`, because its job is "which keys may appear on an
    // event frame at all", and the per-event file is where a shape is
    // pinned. Closing `clampedBy` in both would put the twelve words in two
    // files, and the second copy is the one that rots.
    const union = readJson(join(frameSchemaDir, 'event.json'));
    expect(union.properties?.['draft']).toEqual({ type: 'object' });

    // exactOptionalPropertyTypes: an unclamped draft OMITS the key. The
    // canonical fixture is an unclamped draft and says so by absence, never
    // by `null` and never by `undefined` (which JSON would drop anyway,
    // making a round-trip assertion on it vacuous).
    expect('clampedBy' in draft).toBe(false);
    expect(Object.keys(draft)).not.toContain('clampedBy');
  });

  it('row 5: the types refuse a frame that omits its id, and one that invents a key', () => {
    // The runtime rows above all read files. This one reads the compiler,
    // which is the only reader that sees `GatewayEventPayload` itself.
    const expired: GatewayEventPayload = {
      event: 'draft.expired',
      draftId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
    };
    const superseded: GatewayEventPayload = {
      event: 'draft.superseded',
      draftId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
      byDraftId: '01BBBBBBBBBBBBBBBBBBBBBBBB',
    };
    const redrafted: GatewayEventPayload = {
      event: 'draft.redrafted',
      draftId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
      newDraftId: '01BBBBBBBBBBBBBBBBBBBBBBBB',
    };
    const requeued: GatewayEventPayload = {
      event: 'draft.requeued',
      draftId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
    };
    expect(
      [expired, superseded, redrafted, requeued].map((e) => e.event),
    ).toEqual([
      'draft.expired',
      'draft.superseded',
      'draft.redrafted',
      'draft.requeued',
    ]);

    // @ts-expect-error a lifecycle frame without its draftId is not a payload
    const noId: GatewayEventPayload = { event: 'draft.expired' };
    // @ts-expect-error draft.superseded needs the id that replaced it
    const noLink: GatewayEventPayload = {
      event: 'draft.superseded',
      draftId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
    };
    const wrongKey: GatewayEventPayload = {
      event: 'draft.expired',
      draftId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
      // @ts-expect-error the link key belongs to draft.superseded, not expiry.
      // The directive sits on the KEY rather than on the declaration because
      // excess-property errors are reported at the offending member, and a
      // directive one line too high reports "unused" while the real error
      // goes unclaimed — a negative row that passes for the wrong reason.
      byDraftId: '01BBBBBBBBBBBBBBBBBBBBBBBB',
    };
    expect([noId, noLink, wrongKey]).toHaveLength(3);
  });
});

/**
 * The clamp channel is the deny taxonomy, invariantly, in both the place the
 * gate DECIDES it and the place the wire CARRIES it. Erased at build time and
 * exported only so it is not an unused local.
 *
 * A structural `extends` pair would pass for a widened copy of the union;
 * `Equals` is invariant, so a `DraftSummary.clampedBy` that quietly grew a
 * thirteenth word — or lost one — is a build error here rather than a schema
 * enum somebody forgets to regenerate.
 */
export type ClampedByIsTheDenyTaxonomy = [
  Assert<Equals<NonNullable<DraftSummary['clampedBy']>, GateDenyReason>>,
  Assert<
    Equals<
      NonNullable<Extract<GateDecision, { allow: true }>['clampedBy']>,
      GateDenyReason
    >
  >,
];
