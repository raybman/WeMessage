/**
 * S2 Scenario 5 — Store: rules CRUD + recent-inbound + mirror update.
 * Spec: docs/plans/slices/s2-execution.md Part 2 Scenario 5; §1.5 Store body
 * extensions. Real temp-dir SqliteStore, fake Clock (§4.0 hand-rolled fakes).
 *
 * Covered here:
 *  - insert→get→list round-trip preserves EVERY `Rule` field, each
 *    `RuleMatcher` variant incl. nested combinators. Note: the §2.3 `rules`
 *    DDL has no `match_attachment_only` column and S2 adds no migration
 *    (spec §1.1), so `matchAttachmentOnly` travels "through the JSON matcher
 *    column" (Scenario 5 RED wording) as a stored envelope.
 *  - listRules ordering: priority ASC, id ASC tiebreak.
 *  - updateRule full-row semantics + throw-on-absent; deleteRule true/false.
 *  - FK: rule referencing a nonexistent schedule_id is REJECTED
 *    (foreign_keys=ON asserted via pragma, not assumed).
 *  - listRecentInboundMessages(n): received_at DESC, limit honored, Message
 *    fully rebuilt from mirror+meta JSON (tapback/thread/attachments survive
 *    — load-bearing for dry-run fidelity).
 *  - getInboundMessage / updateInboundMessage: edit refresh changes text,
 *    kind, edited_at in place; guid stable; insertInboundMessage stays
 *    DO-NOTHING idempotent (S1 contract untouched).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Clock, Message, Rule, RuleMatcher } from '@wemessage/core';
import { openStore, type SqliteStore } from '@wemessage/store';

function fakeClock(iso = '2026-09-01T12:00:00.000Z'): Clock {
  return { now: () => iso, nowMs: () => Date.parse(iso) };
}

/** Full Rule factory — every field explicit so toStrictEqual has teeth. */
function makeRule(partial: Partial<Rule> & { id: string }): Rule {
  return {
    name: `rule-${partial.id}`,
    enabled: true,
    matcher: { kind: 'keyword', keywords: ['hi'], mode: 'any' },
    adapterId: 'echo',
    respondMode: 'draft-only',
    scheduleId: null,
    outsideWindow: 'draft-only',
    allowGroupDrafts: false,
    matchAttachmentOnly: false,
    draftTtlMinutes: 240,
    priority: 100,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...partial,
  };
}

/** Full Message factory — every field explicit. */
function makeMessage(partial: Partial<Message> & { guid: string }): Message {
  return {
    sourceRowid: 1,
    chatGuid: 'iMessage;-;+15550001111',
    handle: '+15550001111',
    isFromMe: false,
    isGroup: false,
    service: 'imessage',
    kind: 'text',
    text: 'hello',
    attachments: [],
    sentAt: '2026-09-01T09:00:00.000Z',
    receivedAt: '2026-09-01T09:00:01.000Z',
    ...partial,
  };
}

describe('store: rules CRUD + recent-inbound + mirror update (s2 Scenario 5)', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wemessage-rules-store-'));
    store = openStore({ dir, clock: fakeClock() });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('rules CRUD round-trip', () => {
    const MATCHER_VARIANTS: Array<[string, RuleMatcher]> = [
      [
        'keyword (all optionals set)',
        {
          kind: 'keyword',
          keywords: ['café', 'On My Way'],
          mode: 'all',
          caseSensitive: true,
          wholeWord: true,
        },
      ],
      ['regex', { kind: 'regex', pattern: 'order #[0-9]{4}' }],
      [
        'theme (inert but persisted)',
        { kind: 'theme', themes: ['travel'], minConfidence: 0.8 },
      ],
      [
        'contact',
        { kind: 'contact', handles: ['+15551234567', 'a@example.com'] },
      ],
      [
        'nested combinators (all-of over any-of)',
        {
          kind: 'all-of',
          matchers: [
            { kind: 'keyword', keywords: ['eta'], mode: 'any' },
            {
              kind: 'any-of',
              matchers: [
                { kind: 'contact', handles: ['+15551234567'] },
                { kind: 'regex', pattern: 'urgent' },
              ],
            },
          ],
        },
      ],
    ];

    for (const [label, matcher] of MATCHER_VARIANTS) {
      it(`round-trips every Rule field with ${label} matcher`, () => {
        const rule = makeRule({
          id: '01J00000000000000000000001',
          matcher,
          matchAttachmentOnly: true, // no dedicated column — must survive anyway
          enabled: false,
          priority: 7,
          outsideWindow: 'queue',
          allowGroupDrafts: true,
          draftTtlMinutes: 30,
          respondMode: 'auto',
          adapterId: 'sol',
        });
        store.insertRule(rule);
        expect(store.getRule(rule.id)).toStrictEqual(rule);
        expect(store.listRules()).toStrictEqual([rule]);
      });
    }

    it('round-trips a non-null scheduleId when the schedule exists', () => {
      store.db
        .prepare(
          'INSERT INTO schedules (id, name, timezone, windows, enabled) ' +
            "VALUES (?, 'work', 'America/Los_Angeles', '[]', 1)",
        )
        .run('01JSCHED00000000000000001');
      const rule = makeRule({
        id: '01J00000000000000000000002',
        scheduleId: '01JSCHED00000000000000001',
      });
      store.insertRule(rule);
      expect(store.getRule(rule.id)).toStrictEqual(rule);
    });

    it('getRule returns null for an absent id', () => {
      expect(store.getRule('01JNOPE0000000000000000000')).toBeNull();
    });

    it('listRules orders by priority ASC then id ASC', () => {
      const z = makeRule({ id: '01Z0000000000000000000000Z', priority: 20 });
      const b = makeRule({ id: '01B0000000000000000000000B', priority: 10 });
      const a = makeRule({ id: '01A0000000000000000000000A', priority: 10 });
      const c = makeRule({ id: '01C0000000000000000000000C', priority: 5 });
      // Insert deliberately out of order.
      store.insertRule(z);
      store.insertRule(b);
      store.insertRule(a);
      store.insertRule(c);
      expect(store.listRules().map((r) => r.id)).toEqual([
        c.id,
        a.id,
        b.id,
        z.id,
      ]);
    });

    it('updateRule replaces the full row keyed on id', () => {
      const rule = makeRule({ id: '01J00000000000000000000003' });
      store.insertRule(rule);
      const updated: Rule = {
        ...rule,
        name: 'renamed',
        enabled: false,
        matcher: { kind: 'regex', pattern: 'invoice' },
        matchAttachmentOnly: true,
        priority: 3,
        updatedAt: '2026-09-01T11:00:00.000Z',
      };
      store.updateRule(updated);
      expect(store.getRule(rule.id)).toStrictEqual(updated);
    });

    it('updateRule throws when the rule is absent', () => {
      expect(() =>
        store.updateRule(makeRule({ id: '01JABSENT00000000000000000' })),
      ).toThrow(/01JABSENT00000000000000000/);
    });

    it('deleteRule returns true when a row was removed, false when absent', () => {
      const rule = makeRule({ id: '01J00000000000000000000004' });
      store.insertRule(rule);
      expect(store.deleteRule(rule.id)).toBe(true);
      expect(store.getRule(rule.id)).toBeNull();
      expect(store.deleteRule(rule.id)).toBe(false);
    });

    it('enforces the schedules FK: foreign_keys=ON is asserted, not assumed', () => {
      expect(store.db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(() =>
        store.insertRule(
          makeRule({
            id: '01J00000000000000000000005',
            scheduleId: '01JNOSUCHSCHEDULE000000000',
          }),
        ),
      ).toThrow(/FOREIGN KEY/i);
    });
  });

  describe('listRecentInboundMessages', () => {
    it('returns newest-first by received_at with the limit honored', () => {
      for (let i = 1; i <= 5; i += 1) {
        store.insertInboundMessage(
          makeMessage({
            guid: `guid-${i}`,
            sourceRowid: i,
            receivedAt: `2026-09-01T09:0${i}:00.000Z`,
          }),
        );
      }
      const recent = store.listRecentInboundMessages(3);
      expect(recent.map((m) => m.guid)).toEqual(['guid-5', 'guid-4', 'guid-3']);
    });

    it('fully rebuilds Message from mirror+meta JSON (tapback/thread/attachments survive)', () => {
      const rich = makeMessage({
        guid: 'guid-rich',
        sourceRowid: 42,
        kind: 'attachment-only',
        text: null,
        attachments: [
          {
            path: '/tmp/att/IMG_1.heic',
            mimeType: 'image/heic',
            bytes: 12345,
            transferName: 'IMG_1.heic',
          },
        ],
        tapback: { targetGuid: 'guid-target', type: 2000 },
        threadOriginatorGuid: 'guid-thread-origin',
        editedAt: '2026-09-01T09:30:00.000Z',
      });
      store.insertInboundMessage(rich);
      const [rebuilt] = store.listRecentInboundMessages(1);
      // toStrictEqual: optional keys must be PRESENT with values, and a plain
      // message below proves they are ABSENT (not undefined) when unset.
      expect(rebuilt).toStrictEqual(rich);
    });

    it('omits optional keys entirely when unset (exactOptionalPropertyTypes fidelity)', () => {
      const plain = makeMessage({ guid: 'guid-plain' });
      store.insertInboundMessage(plain);
      const rebuilt = store.getInboundMessage('guid-plain');
      expect(rebuilt).toStrictEqual(plain);
      expect(rebuilt).not.toBeNull();
      expect(Object.keys(rebuilt as Message)).not.toContain('editedAt');
      expect(Object.keys(rebuilt as Message)).not.toContain('tapback');
      expect(Object.keys(rebuilt as Message)).not.toContain(
        'threadOriginatorGuid',
      );
    });
  });

  describe('getInboundMessage / updateInboundMessage', () => {
    it('getInboundMessage returns null for an absent guid', () => {
      expect(store.getInboundMessage('guid-none')).toBeNull();
    });

    it('an edit refresh changes text, kind, edited_at in place; guid stable', () => {
      const original = makeMessage({ guid: 'guid-edit', text: 'v1' });
      store.insertInboundMessage(original);
      const edited: Message = {
        ...original,
        kind: 'edit',
        text: 'v2',
        editedAt: '2026-09-01T09:45:00.000Z',
      };
      store.updateInboundMessage(edited);
      expect(store.getInboundMessage('guid-edit')).toStrictEqual(edited);
      // In place: still exactly one mirror row for the guid.
      const count = store.db
        .prepare('SELECT COUNT(*) AS n FROM inbound_messages WHERE guid = ?')
        .get('guid-edit') as { n: number };
      expect(count.n).toBe(1);
    });

    it('an unsend refresh nulls text and flips kind', () => {
      const original = makeMessage({ guid: 'guid-unsend', text: 'oops' });
      store.insertInboundMessage(original);
      const unsent: Message = { ...original, kind: 'unsend', text: null };
      store.updateInboundMessage(unsent);
      expect(store.getInboundMessage('guid-unsend')).toStrictEqual(unsent);
    });

    it('insertInboundMessage remains DO-NOTHING idempotent (S1 contract untouched)', () => {
      const first = makeMessage({ guid: 'guid-idem', text: 'first' });
      store.insertInboundMessage(first);
      store.insertInboundMessage(
        makeMessage({ guid: 'guid-idem', text: 'second wins? no.' }),
      );
      expect(store.getInboundMessage('guid-idem')).toStrictEqual(first);
    });
  });
});
