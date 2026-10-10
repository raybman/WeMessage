/**
 * v2 F2a: the search index over the mirror.
 *
 * Real temp-dir SqliteStore, fake Clock. Every row here names one promise
 * the coverage line makes to the operator: what is findable, what is not,
 * and that nothing they unsent can be found again.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  INDEX_BATCH,
  SEARCH_MATCH_CAP,
  SETTING_SEARCH_INDEXED_THROUGH,
  type Clock,
  type Message,
  type MirrorQuery,
} from '@wemessage/core';
import { openStore, type SqliteStore } from '@wemessage/store';

function fakeClock(iso = '2026-09-01T12:00:00.000Z'): Clock {
  return { now: () => iso, nowMs: () => Date.parse(iso) };
}

const MAYA = 'iMessage;-;+15550100001';
const THEO = 'iMessage;-;+15550100002';

let seq = 0;
function msg(partial: Partial<Message> & { guid: string }): Message {
  seq += 1;
  return {
    sourceRowid: seq,
    chatGuid: MAYA,
    handle: '+15550100001',
    isFromMe: false,
    isGroup: false,
    service: 'imessage',
    kind: 'text',
    text: 'hello',
    attachments: [],
    sentAt: `2026-09-01T09:${String(seq % 60).padStart(2, '0')}:00.000Z`,
    receivedAt: '2026-09-01T09:00:01.000Z',
    ...partial,
  };
}

function q(partial: Partial<MirrorQuery> = {}): MirrorQuery {
  return {
    ftsMatch: null,
    shortTerms: [],
    has: [],
    cap: SEARCH_MATCH_CAP,
    ...partial,
  };
}

function phrase(term: string): string {
  return '"' + term.replaceAll('"', '""') + '"';
}

describe('store search index (v2 F2a)', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    seq = 0;
    dir = mkdtempSync(join(tmpdir(), 'wemessage-search-'));
    store = openStore({ dir, clock: fakeClock() });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function put(...messages: Message[]): void {
    for (const m of messages) store.insertInboundMessage(m);
  }
  function guids(query: MirrorQuery): string[] {
    return store.searchMirror(query).matches.map((m) => m.guid);
  }
  function docCount(): number {
    return (
      store.db.prepare('SELECT COUNT(*) AS n FROM search_doc').get() as {
        n: number;
      }
    ).n;
  }

  it('indexesOnlyEligibleKinds: tapbacks, unsends and empty text are never indexed', () => {
    put(
      msg({ guid: 'text', text: 'the cabin key' }),
      msg({ guid: 'tap', kind: 'tapback', text: 'Loved “the cabin key”' }),
      msg({ guid: 'unsent', kind: 'unsend', text: null }),
      msg({ guid: 'edited', kind: 'edit', text: 'cabin, edited' }),
      msg({ guid: 'voice', kind: 'audio', text: 'cabin voice note' }),
      msg({ guid: 'pic', kind: 'attachment-only', text: 'cabin photo' }),
      msg({ guid: 'bare', kind: 'attachment-only', text: null }),
      msg({ guid: 'blank', text: '' }),
    );
    expect(store.indexPending(INDEX_BATCH)).toEqual({
      indexed: 4,
      throughRowid: 8,
    });
    expect(guids(q({ ftsMatch: phrase('cabin') })).sort()).toEqual(
      ['edited', 'pic', 'text', 'voice'].sort(),
    );
    expect(docCount()).toBe(4);
    expect(store.searchCoverage()).toMatchObject({
      indexed: 4,
      eligible: 4,
      throughRowid: 8,
    });
  });

  it('unsendScrubsHit: an unsent message is gone from the index when the update returns', () => {
    const m = msg({ guid: 'u1', text: 'the secret cabin code is 4417' });
    put(m, msg({ guid: 'keep', text: 'cabin weekend' }));
    store.indexPending(INDEX_BATCH);
    expect(guids(q({ ftsMatch: phrase('4417') }))).toEqual(['u1']);

    store.updateInboundMessage({ ...m, kind: 'unsend', text: null });

    expect(guids(q({ ftsMatch: phrase('4417') }))).toEqual([]);
    expect(guids(q({ ftsMatch: phrase('cabin') }))).toEqual(['keep']);
    // The doc id is released too, so coverage does not count a ghost.
    expect(docCount()).toBe(1);
    expect(store.searchCoverage()).toMatchObject({ indexed: 1, eligible: 1 });
    // And the FTS row itself is gone, not just unreachable through the map.
    const live = store.db
      .prepare('SELECT COUNT(*) AS n FROM message_fts_docsize')
      .get() as { n: number };
    expect(live.n).toBe(1);
  });

  it('editReindexes: the new text is findable and the old text is not', () => {
    const m = msg({ guid: 'e1', text: 'meet at the lake' });
    put(m);
    store.indexPending(INDEX_BATCH);
    const docBefore = store.db
      .prepare('SELECT doc_id FROM search_doc WHERE guid = ?')
      .get('e1');

    store.updateInboundMessage({
      ...m,
      kind: 'edit',
      text: 'meet at the cabin',
      editedAt: '2026-09-01T10:00:00.000Z',
    });

    expect(guids(q({ ftsMatch: phrase('cabin') }))).toEqual(['e1']);
    expect(guids(q({ ftsMatch: phrase('lake') }))).toEqual([]);
    // Same doc id: VACUUM-stable identity survives an edit.
    expect(
      store.db
        .prepare('SELECT doc_id FROM search_doc WHERE guid = ?')
        .get('e1'),
    ).toEqual(docBefore);
  });

  it('an edit to a row the backfill has not reached yet waits for the backfill', () => {
    const m = msg({ guid: 'late', text: 'first words' });
    put(m);
    store.updateInboundMessage({ ...m, kind: 'edit', text: 'cabin words' });
    expect(docCount()).toBe(0);
    store.indexPending(INDEX_BATCH);
    expect(guids(q({ ftsMatch: phrase('cabin') }))).toEqual(['late']);
  });

  it('a row that becomes searchable behind the mark is indexed by the update', () => {
    const m = msg({ guid: 'pic', kind: 'attachment-only', text: null });
    put(m);
    store.indexPending(INDEX_BATCH);
    expect(docCount()).toBe(0);
    store.updateInboundMessage({ ...m, kind: 'edit', text: 'cabin caption' });
    expect(guids(q({ ftsMatch: phrase('cabin') }))).toEqual(['pic']);
  });

  it('guidNeverIndexedTwice: re-walking the same rows adds nothing', () => {
    put(
      msg({ guid: 'a', text: 'cabin one' }),
      msg({ guid: 'b', text: 'cabin two' }),
    );
    store.indexPending(INDEX_BATCH);
    store.resetIndexThrough(0);
    expect(store.indexPending(INDEX_BATCH)).toEqual({
      indexed: 0,
      throughRowid: 2,
    });
    expect(docCount()).toBe(2);
    const fts = store.db
      .prepare(
        'SELECT COUNT(*) AS n FROM message_fts WHERE message_fts MATCH \'"cabin"\'',
      )
      .get() as { n: number };
    expect(fts.n).toBe(2);
    expect(guids(q({ ftsMatch: phrase('cabin') })).sort()).toEqual(['a', 'b']);
  });

  it('restoreHealReindexesNewRows: rows arriving under reused ROWIDs after a heal are indexed', () => {
    put(
      msg({ guid: 'old-1', sourceRowid: 1, text: 'cabin a' }),
      msg({ guid: 'old-2', sourceRowid: 2, text: 'cabin b' }),
      msg({ guid: 'old-3', sourceRowid: 3, text: 'cabin c' }),
      msg({ guid: 'old-4', sourceRowid: 4, text: 'cabin d' }),
    );
    expect(store.indexPending(INDEX_BATCH).throughRowid).toBe(4);

    // chat.db restored from an older backup: the cursor heals to 2 and the
    // next message Messages writes reuses ROWID 3.
    store.resetIndexThrough(2);
    expect(store.getSetting(SETTING_SEARCH_INDEXED_THROUGH)).toBe('2');
    put(msg({ guid: 'new-3', sourceRowid: 3, text: 'cabin after restore' }));

    expect(store.indexPending(INDEX_BATCH)).toEqual({
      indexed: 1,
      throughRowid: 4,
    });
    expect(guids(q({ ftsMatch: phrase('restore') }))).toEqual(['new-3']);
    expect(docCount()).toBe(5);

    // Lowering never raises: a reset above the mark is a no-op.
    store.resetIndexThrough(99);
    expect(store.searchCoverage().throughRowid).toBe(4);
  });

  it('diacriticAndCaseFold: Café matches cafe and CAFÉ, CABIN matches cabin', () => {
    put(msg({ guid: 'c', text: 'Café by the CABIN' }));
    store.indexPending(INDEX_BATCH);
    for (const term of ['cafe', 'CAFÉ', 'café', 'cabin', 'Cabin']) {
      expect(guids(q({ ftsMatch: phrase(term) })), term).toEqual(['c']);
    }
  });

  it('ordersBySentTimeThenGuid: newest sent first, ties on guid ascending, whatever the rowid order', () => {
    put(
      msg({
        guid: 'mid',
        sentAt: '2024-05-01T00:00:00.000Z',
        text: 'cabin mid',
      }),
      msg({
        guid: 'z-tie',
        sentAt: '2025-01-01T00:00:00.000Z',
        text: 'cabin tie z',
      }),
      msg({
        guid: 'oldest',
        sentAt: '2019-07-04T00:00:00.000Z',
        text: 'cabin 2019',
      }),
      msg({
        guid: 'a-tie',
        sentAt: '2025-01-01T00:00:00.000Z',
        text: 'cabin tie a',
      }),
      msg({
        guid: 'newest',
        sentAt: '2026-09-01T00:00:00.000Z',
        text: 'cabin now',
      }),
    );
    store.indexPending(INDEX_BATCH);
    const expected = ['newest', 'a-tie', 'z-tie', 'mid', 'oldest'];
    expect(guids(q({ ftsMatch: phrase('cabin') }))).toEqual(expected);
    // Filter-only queries order the same way.
    expect(guids(q({ after: '2000-01-01T00:00:00.000Z' }))).toEqual(expected);
  });

  it('capReportsCapped: more matches than the cap keeps the newest by arrival and says so', () => {
    for (let i = 1; i <= 5; i += 1) {
      put(msg({ guid: `m${String(i)}`, text: `cabin ${String(i)}` }));
    }
    store.indexPending(INDEX_BATCH);
    const capped = store.searchMirror(q({ ftsMatch: phrase('cabin'), cap: 3 }));
    expect(capped.capped).toBe(true);
    expect(capped.matches.map((m) => m.guid).sort()).toEqual([
      'm3',
      'm4',
      'm5',
    ]);
    const exact = store.searchMirror(q({ ftsMatch: phrase('cabin'), cap: 5 }));
    expect(exact.capped).toBe(false);
    expect(exact.matches).toHaveLength(5);
    // Filter-only queries cap too.
    const filterOnly = store.searchMirror(q({ fromMe: false, cap: 2 }));
    expect(filterOnly.capped).toBe(true);
    expect(filterOnly.matches).toHaveLength(2);
  });

  it('shortTermNeverSilentZero: a 2-letter term finds its message, alone or beside a long one', () => {
    put(
      msg({ guid: 'ok', text: 'ok see you at the cabin' }),
      msg({ guid: 'no', text: 'see you never' }),
    );
    store.indexPending(INDEX_BATCH);
    const alone = store.searchMirror(q({ shortTerms: ['OK'] }));
    expect(alone.matches.map((m) => m.guid)).toEqual(['ok']);
    // Alone, it ran over a window, and the result says so.
    expect(alone.shortTermWindowed).toBe(true);

    const beside = store.searchMirror(
      q({ ftsMatch: phrase('see'), shortTerms: ['ok'] }),
    );
    expect(beside.matches.map((m) => m.guid)).toEqual(['ok']);
    expect(beside.shortTermWindowed).toBe(false);
    expect(guids(q({ ftsMatch: phrase('see'), shortTerms: ['zz'] }))).toEqual(
      [],
    );
  });

  it('filters narrow: from, handles, chats, has, before/after', () => {
    put(
      msg({
        guid: 'me',
        isFromMe: true,
        text: 'cabin from me',
        sentAt: '2019-03-01T00:00:00.000Z',
      }),
      msg({
        guid: 'maya',
        text: 'cabin from maya https://example.com/map',
        sentAt: '2020-03-01T00:00:00.000Z',
      }),
      msg({
        guid: 'theo',
        chatGuid: THEO,
        handle: '+15550100002',
        text: 'cabin photo',
        sentAt: '2021-03-01T00:00:00.000Z',
        attachments: [
          {
            path: 'Attachments/ab/photo.jpg',
            mimeType: 'image/jpeg',
            bytes: 10,
            transferName: 'photo.jpg',
          },
        ],
      }),
      msg({
        guid: 'audio',
        kind: 'audio',
        text: 'cabin voice',
        sentAt: '2022-03-01T00:00:00.000Z',
      }),
    );
    store.indexPending(INDEX_BATCH);
    const cabin = phrase('cabin');
    expect(guids(q({ ftsMatch: cabin, fromMe: true }))).toEqual(['me']);
    expect(guids(q({ ftsMatch: cabin, handleNeedle: '0100002' }))).toEqual([
      'theo',
    ]);
    expect(guids(q({ ftsMatch: cabin, handles: ['+15550100001'] }))).toEqual([
      'audio',
      'maya',
    ]);
    expect(guids(q({ ftsMatch: cabin, chatGuids: [THEO] }))).toEqual(['theo']);
    expect(guids(q({ ftsMatch: cabin, chatGuids: [] }))).toEqual([]);
    // null means the filter could not run; it does not narrow.
    expect(guids(q({ ftsMatch: cabin, chatGuids: null }))).toHaveLength(4);
    expect(guids(q({ ftsMatch: cabin, has: ['attachment'] }))).toEqual([
      'theo',
    ]);
    expect(guids(q({ ftsMatch: cabin, has: ['link'] }))).toEqual(['maya']);
    expect(guids(q({ ftsMatch: cabin, has: ['voice'] }))).toEqual(['audio']);
    // after is inclusive, before is exclusive: the client's own semantics.
    expect(
      guids(
        q({
          ftsMatch: cabin,
          after: '2020-03-01T00:00:00.000Z',
          before: '2022-03-01T00:00:00.000Z',
        }),
      ),
    ).toEqual(['theo', 'maya']);
    const hit = store.searchMirror(q({ ftsMatch: cabin, chatGuids: [THEO] }))
      .matches[0];
    expect(hit).toEqual({
      guid: 'theo',
      chatGuid: THEO,
      handle: '+15550100002',
      isFromMe: false,
      isGroup: false,
      kind: 'text',
      text: 'cabin photo',
      sentAt: '2021-03-01T00:00:00.000Z',
      hasAttachment: true,
    });
  });

  it('survives VACUUM: hits stay attached to their own messages', () => {
    put(
      msg({ guid: 'gone', text: 'alpha words' }),
      msg({ guid: 'b', text: 'bravo words' }),
      msg({ guid: 'c', text: 'charlie words' }),
    );
    store.indexPending(INDEX_BATCH);
    // A mirror row removed outside the indexer, then a VACUUM: SQLite is
    // free to renumber every implicit rowid in inbound_messages.
    store.db.prepare("DELETE FROM inbound_messages WHERE guid = 'gone'").run();
    // This SQLite build's VACUUM happens to keep rowids, so renumber by hand
    // first to stand in for what VACUUM is documented to be allowed to do.
    store.db.exec('UPDATE inbound_messages SET rowid = rowid + 1000');
    store.db.exec('VACUUM');
    expect(guids(q({ ftsMatch: phrase('charlie') }))).toEqual(['c']);
    expect(guids(q({ ftsMatch: phrase('bravo') }))).toEqual(['b']);
    expect(guids(q({ ftsMatch: phrase('alpha') }))).toEqual([]);
  });

  it('indexPending is bounded by its limit and walks in ROWID order', () => {
    for (let i = 1; i <= 5; i += 1)
      put(msg({ guid: `r${String(i)}`, text: `cabin ${String(i)}` }));
    expect(store.indexPending(2)).toEqual({ indexed: 2, throughRowid: 2 });
    expect(store.searchCoverage()).toMatchObject({
      indexed: 2,
      eligible: 5,
      throughRowid: 2,
    });
    expect(store.indexPending(2)).toEqual({ indexed: 2, throughRowid: 4 });
    expect(store.indexPending(2)).toEqual({ indexed: 1, throughRowid: 5 });
    expect(store.indexPending(2)).toEqual({ indexed: 0, throughRowid: 5 });
  });

  it('searchCoverage dates the mirror by the cursor', () => {
    expect(store.searchCoverage()).toEqual({
      indexed: 0,
      eligible: 0,
      throughRowid: 0,
      mirrorAsOf: null,
    });
    store.setCursor({ lastRowid: 9, lastScanAt: '2026-09-19T16:12:00.000Z' });
    expect(store.searchCoverage().mirrorAsOf).toBe('2026-09-19T16:12:00.000Z');
  });
});
