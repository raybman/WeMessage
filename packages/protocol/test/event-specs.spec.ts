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
import type { GatewayEventName } from '../src/index.js';
import { schemaErrors, type JsonSchema } from './helpers/schema-check.js';

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
  it('exports 17 distinct names, sorted, with a runtime membership guard', () => {
    expect(GATEWAY_EVENT_NAMES).toHaveLength(17);
    expect(new Set(GATEWAY_EVENT_NAMES).size).toBe(17);
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
      // counted seventeen times into the frame's optional union.
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

  it('keeps event.json a closed enum over the 17, and refuses a stranger', () => {
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
