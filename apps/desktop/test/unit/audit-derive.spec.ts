/**
 * s8-execution Scenario 13 — the audit screen's decisions, without a DOM.
 *
 * The audit log is the one surface in this product where the GUI is a
 * READER and nothing else, and where being a faithful reader is the entire
 * product value. §1.8 says "the log is the record, the event is the
 * courtesy"; a screen that paraphrased the record would be offering a third
 * thing, which is neither.
 *
 * Four claims live here, each a pure function of rows the daemon already
 * stored, so the e2e can spend its Electron launches proving that these
 * strings reach a window rather than re-deriving them through one:
 *
 *  - **The drawer is verbatim or it is nothing.** `AuditRowPayload` carries
 *    `eventJson` and `actorJson` as the exact strings the chain hashed
 *    (`packages/store/src/store.ts` hashes what it stores). A drawer titled
 *    "what you see is what was hashed" that re-serialised them would be
 *    showing something whose hash nobody can check — key order, spacing and
 *    unicode escapes all move under `JSON.parse` + `JSON.stringify`. So the
 *    projection carries the raw strings THROUGH, and a row proves a payload
 *    whose re-serialisation differs still renders the original.
 *  - **The table is a summary and the drawer is the record.** A
 *    `draft.created` row carries a full `Draft` snapshot, message body
 *    included. The list may not draw it — an audit list is scanned in front
 *    of other people — so the summary is built from a closed set of
 *    IDENTIFIER keys and can structurally never reach a body. Opening the
 *    row shows everything, because that is what the operator asked for.
 *  - **An unreadable row is a row, not a crash.** Tamper is the point of
 *    this screen. After `UPDATE audit_log SET event = 'not json'` the
 *    projection must still produce a row with a seq, a hash and an honest
 *    word for the parts it could not read, or the screen that exists to
 *    show you the damage is the screen that breaks when there is some.
 *  - **The deny vocabulary is closed, and unknown is a value in it.** The
 *    twelve `GateDenyReason` members are re-declared here because INV-1
 *    keeps `@wemessage/core` out of the renderer (an arch row ties the two
 *    lists together, and the S6 dormant-literal guard now names this file).
 *    A thirteenth reason from a newer daemon renders the literal under a
 *    `?` glyph rather than being dropped or crashing: forward compatibility,
 *    not invention.
 *
 * No clock is read anywhere below, by the same ban Sc11 and Sc12 live
 * under: every instant is an argument. Synthetic handles only (`+1555…`)
 * and synthetic ids, as everywhere in this PUBLIC repo.
 */
import { describe, expect, it } from 'vitest';
import type { AuditRowPayload } from '@wemessage/client';
import {
  ABSENT,
  DENY_GLYPH,
  DENY_REASONS,
  UNKNOWN_GLYPH,
  UNREADABLE,
  auditRows,
  ceilingLine,
  eventTypes,
  filterAuditRows,
  moreLine,
  scopeLine,
  type AuditRowView,
} from '../../src/renderer/derive/auditRows.js';

const NOW = '2026-03-02T18:00:00.000Z';

/** A row as the daemon stores it: the two JSON columns are strings. */
function row(
  seq: number,
  at: string,
  event: unknown,
  actor: unknown,
): AuditRowPayload {
  return {
    seq,
    at,
    eventJson: typeof event === 'string' ? event : JSON.stringify(event),
    actorJson: typeof actor === 'string' ? actor : JSON.stringify(actor),
    prevHash: 'a'.repeat(64),
    hash: 'b'.repeat(64),
  };
}

const HUMAN = { kind: 'human', via: 'gui' };
const AGENT = { kind: 'agent', adapterId: 'agent-one' };
const SYSTEM = { kind: 'system', reason: 'expiry' };

const DRAFT_ID = '01HQ0000000000000000000AUD';

function only(rows: readonly AuditRowView[]): AuditRowView {
  expect(rows).toHaveLength(1);
  return rows[0] as AuditRowView;
}

/* ── the vocabulary ───────────────────────────────────────────────────── */

describe('s8 Sc13: the deny vocabulary is closed, and this is the copy', () => {
  it('names the twelve reasons, sorted, with no duplicates', () => {
    expect([...DENY_REASONS].sort()).toEqual([...DENY_REASONS]);
    expect(new Set(DENY_REASONS).size).toBe(DENY_REASONS.length);
    expect(DENY_REASONS).toHaveLength(12);
  });

  it('renders a known reason as a glyph, an uppercase word and a state', () => {
    const view = only(
      auditRows({
        nowIso: NOW,
        rows: [
          row(
            9,
            NOW,
            { type: 'gate.denied', reason: 'kill-switch', guid: 'p:1' },
            SYSTEM,
          ),
        ],
      }),
    );
    expect(view.deny).not.toBeNull();
    expect(view.deny?.reason).toBe('kill-switch');
    expect(view.deny?.word).toBe('KILL-SWITCH');
    expect(view.deny?.glyph).toBe(DENY_GLYPH);
    expect(view.deny?.state).toBe('KNOWN');
  });

  it('renders a reason from a newer daemon under the ? glyph, verbatim', () => {
    const view = only(
      auditRows({
        nowIso: NOW,
        rows: [
          row(
            9,
            NOW,
            { type: 'gate.denied', reason: 'quarantined', guid: 'p:1' },
            SYSTEM,
          ),
        ],
      }),
    );
    expect(view.deny?.state).toBe('UNKNOWN');
    expect(view.deny?.glyph).toBe(UNKNOWN_GLYPH);
    // The LITERAL, not a placeholder: an operator who greps the daemon's
    // source for the word on their screen has to find it.
    expect(view.deny?.word).toBe('QUARANTINED');
    expect(view.deny?.reason).toBe('quarantined');
  });

  it('gives a row that is not a denial no chip at all', () => {
    const view = only(
      auditRows({
        nowIso: NOW,
        rows: [
          row(9, NOW, { type: 'draft.approved', draftId: DRAFT_ID }, HUMAN),
        ],
      }),
    );
    expect(view.deny).toBeNull();
  });
});

/* ── verbatim ─────────────────────────────────────────────────────────── */

describe('s8 Sc13: what you see is what was hashed', () => {
  it('carries the stored strings through untouched', () => {
    // Key order reversed against the type declaration, two spaces of
    // padding, and a unicode escape: every one of these survives storage
    // and every one of them would be normalised by a re-serialise.
    const stored =
      '{"reason":"kill-switch",  "type":"gate.denied","n":"\\u00e9"}';
    const view = only(
      auditRows({ nowIso: NOW, rows: [row(4, NOW, stored, HUMAN)] }),
    );
    expect(view.eventJson).toBe(stored);
    expect(view.eventJson).not.toBe(JSON.stringify(JSON.parse(stored)));
    // …and the row is still READ, so the verbatim string is not a fallback
    // for "we gave up".
    expect(view.kind).toBe('gate.denied');
    expect(view.deny?.reason).toBe('kill-switch');
  });

  it('carries the actor string through untouched too', () => {
    const stored = '{"via":"gui","kind":"human"}';
    const view = only(
      auditRows({ nowIso: NOW, rows: [row(4, NOW, {}, stored)] }),
    );
    expect(view.actorJson).toBe(stored);
    expect(view.actor).toBe('HUMAN');
    expect(view.actorLabel).toBe('HUMAN · GUI');
  });

  it('passes the chain fields straight through', () => {
    const src = row(
      7,
      NOW,
      { type: 'draft.expired', draftId: DRAFT_ID },
      SYSTEM,
    );
    const view = only(auditRows({ nowIso: NOW, rows: [src] }));
    expect(view.seq).toBe(7);
    expect(view.prevHash).toBe(src.prevHash);
    expect(view.hash).toBe(src.hash);
  });
});

/* ── the summary can never reach a body ───────────────────────────────── */

describe('s8 Sc13: the list summarises, the drawer discloses', () => {
  const BODY = 'the front desk will call you back about the deposit';
  const created = row(
    3,
    NOW,
    {
      type: 'draft.created',
      draftId: DRAFT_ID,
      draft: {
        id: DRAFT_ID,
        chatGuid: 'iMessage;-;+15550000001',
        body: BODY,
        originalBody: BODY,
        state: 'pending',
      },
    },
    AGENT,
  );

  it('never puts the message body in a row the table draws', () => {
    const view = only(auditRows({ nowIso: NOW, rows: [created] }));
    expect(view.summary).not.toContain(BODY);
    expect(view.summary).not.toContain('deposit');
    // Non-vacuous twice over: the payload really does carry the body, and
    // the drawer really does disclose it.
    expect(created.eventJson).toContain(BODY);
    expect(view.eventJson).toContain(BODY);
  });

  it('summarises by IDENTIFIER, so what it names is a thing to look up', () => {
    const view = only(auditRows({ nowIso: NOW, rows: [created] }));
    expect(view.kind).toBe('draft.created');
    expect(view.summary).toContain(DRAFT_ID);
  });

  it('says so in words when there is no identifier to name', () => {
    const view = only(
      auditRows({
        nowIso: NOW,
        rows: [row(3, NOW, { type: 'kill.armed' }, HUMAN)],
      }),
    );
    expect(view.summary).toBe(ABSENT);
  });
});

/* ── an unreadable row is a row ───────────────────────────────────────── */

describe('s8 Sc13: after the tamper, the screen still draws the damage', () => {
  it('renders a row whose event column is not JSON at all', () => {
    const view = only(
      auditRows({ nowIso: NOW, rows: [row(5, NOW, 'DOCTORED', HUMAN)] }),
    );
    expect(view.seq).toBe(5);
    expect(view.kind).toBe(UNREADABLE);
    expect(view.kindKnown).toBe(false);
    expect(view.summary).toBe(ABSENT);
    expect(view.deny).toBeNull();
    // Verbatim, still. This is the row an auditor most needs to see raw.
    expect(view.eventJson).toBe('DOCTORED');
  });

  it('renders a row whose actor column is not JSON at all', () => {
    const view = only(
      auditRows({
        nowIso: NOW,
        rows: [row(5, NOW, { type: 'draft.expired', draftId: DRAFT_ID }, '')],
      }),
    );
    expect(view.actor).toBe(UNREADABLE);
    expect(view.actorLabel).toBe(UNREADABLE);
    // …and the half that IS readable is still read.
    expect(view.kind).toBe('draft.expired');
  });

  it('renders a JSON row that is the wrong shape without inventing one', () => {
    for (const payload of ['[1,2,3]', 'null', '"a string"', '{"type":7}']) {
      const view = only(
        auditRows({ nowIso: NOW, rows: [row(5, NOW, payload, HUMAN)] }),
      );
      expect(view.kind, payload).toBe(UNREADABLE);
      expect(view.eventJson, payload).toBe(payload);
    }
  });

  it('renders an unparseable instant as the absent mark, not as an epoch', () => {
    const view = only(
      auditRows({
        nowIso: NOW,
        rows: [row(5, 'not-a-date', { type: 'kill.armed' }, HUMAN)],
      }),
    );
    expect(view.age).toBe(ABSENT);
    // The stored string is still shown: it is what was hashed.
    expect(view.at).toBe('not-a-date');
  });
});

/* ── the actor ladder ─────────────────────────────────────────────────── */

describe('s8 Sc13: three kinds of actor, and a fourth for the unreadable', () => {
  it('labels each kind with its own second field', () => {
    const rows = auditRows({
      nowIso: NOW,
      rows: [
        row(3, NOW, { type: 'kill.armed' }, HUMAN),
        row(2, NOW, { type: 'rule.matched', ruleId: DRAFT_ID }, AGENT),
        row(1, NOW, { type: 'draft.expired', draftId: DRAFT_ID }, SYSTEM),
      ],
    });
    expect(rows.map((r) => r.actor)).toEqual(['HUMAN', 'AGENT', 'SYSTEM']);
    expect(rows.map((r) => r.actorLabel)).toEqual([
      'HUMAN · GUI',
      'AGENT · AGENT-ONE',
      'SYSTEM · EXPIRY',
    ]);
  });

  it('does not invent a second field the actor did not carry', () => {
    const view = only(
      auditRows({
        nowIso: NOW,
        rows: [row(3, NOW, { type: 'kill.armed' }, { kind: 'human' })],
      }),
    );
    expect(view.actor).toBe('HUMAN');
    expect(view.actorLabel).toBe(`HUMAN · ${ABSENT}`);
  });

  it('treats an actor kind it has never heard of as unreadable', () => {
    const view = only(
      auditRows({
        nowIso: NOW,
        rows: [row(3, NOW, { type: 'kill.armed' }, { kind: 'daemon' })],
      }),
    );
    expect(view.actor).toBe(UNREADABLE);
  });
});

/* ── ordering, ages and the client-side filter ────────────────────────── */

describe('s8 Sc13: reverse chronological, and the filter is honest about it', () => {
  const three = () =>
    auditRows({
      nowIso: NOW,
      rows: [
        row(
          3,
          '2026-03-02T17:59:58.000Z',
          { type: 'draft.approved', draftId: DRAFT_ID },
          HUMAN,
        ),
        row(
          2,
          '2026-03-02T17:55:00.000Z',
          { type: 'rule.matched', ruleId: 'R1' },
          AGENT,
        ),
        row(
          1,
          '2026-03-02T15:00:00.000Z',
          { type: 'draft.expired', draftId: 'D1' },
          SYSTEM,
        ),
      ],
    });

  it('keeps the newest first however the rows arrive', () => {
    const shuffled = auditRows({
      nowIso: NOW,
      rows: [
        row(
          1,
          '2026-03-02T15:00:00.000Z',
          { type: 'draft.expired', draftId: 'D1' },
          SYSTEM,
        ),
        row(
          3,
          '2026-03-02T17:59:58.000Z',
          { type: 'draft.approved', draftId: DRAFT_ID },
          HUMAN,
        ),
        row(
          2,
          '2026-03-02T17:55:00.000Z',
          { type: 'rule.matched', ruleId: 'R1' },
          AGENT,
        ),
      ],
    });
    expect(shuffled.map((r) => r.seq)).toEqual([3, 2, 1]);
  });

  it('ages every row against the instant it was handed', () => {
    expect(three().map((r) => r.age)).toEqual(['2S AGO', '5M AGO', '3H AGO']);
  });

  it('narrows by actor, and the counts are about LOADED rows', () => {
    const rows = three();
    expect(
      filterAuditRows(rows, { actor: 'AGENT', search: '' }).map((r) => r.seq),
    ).toEqual([2]);
    expect(filterAuditRows(rows, { actor: '', search: '' })).toHaveLength(3);
    expect(scopeLine(rows.length)).toBe('CLIENT-SIDE OVER 3 LOADED ROWS');
  });

  it('narrows by free text over the words the row shows, case-blind', () => {
    const rows = three();
    expect(
      filterAuditRows(rows, { actor: '', search: 'draft.' }).map((r) => r.seq),
    ).toEqual([3, 1]);
    expect(
      filterAuditRows(rows, { actor: '', search: 'AGENT-ONE' }).map(
        (r) => r.seq,
      ),
    ).toEqual([2]);
    expect(
      filterAuditRows(rows, { actor: '', search: 'agent-one' }).map(
        (r) => r.seq,
      ),
    ).toEqual([2]);
  });

  it('never lets free text reach a message body it declined to draw', () => {
    const rows = auditRows({
      nowIso: NOW,
      rows: [
        row(
          1,
          NOW,
          {
            type: 'draft.created',
            draftId: DRAFT_ID,
            draft: { id: DRAFT_ID, body: 'the deposit is refundable' },
          },
          AGENT,
        ),
      ],
    });
    // A search that matched the hidden body would be a channel through
    // which the table discloses what it deliberately did not draw.
    expect(filterAuditRows(rows, { actor: '', search: 'refundable' })).toEqual(
      [],
    );
    expect(
      filterAuditRows(rows, { actor: '', search: 'draft.created' }),
    ).toHaveLength(1);
  });

  it('offers the event types the LOADED rows actually contain, sorted', () => {
    expect(eventTypes(three())).toEqual([
      'draft.approved',
      'draft.expired',
      'rule.matched',
    ]);
    // …and never offers a type nobody can select rows for.
    expect(eventTypes([])).toEqual([]);
  });

  it('leaves the unreadable rows out of the type list but in the table', () => {
    const rows = auditRows({
      nowIso: NOW,
      rows: [
        row(2, NOW, 'DOCTORED', HUMAN),
        row(1, NOW, { type: 'kill.armed' }, HUMAN),
      ],
    });
    expect(rows).toHaveLength(2);
    expect(eventTypes(rows)).toEqual(['kill.armed']);
  });
});

/* ── the ceiling the route actually has ───────────────────────────────── */

describe('s8 Sc13: the window says what it is hiding, and what it cannot reach', () => {
  it('names both numbers when the drawn window is smaller than the load', () => {
    expect(moreLine(60, 500)).toBe('SHOWING 60 OF 500 LOADED ROWS');
    expect(moreLine(500, 500)).toBe('');
  });

  it('says the route ceiling in words once the load is at the cap', () => {
    // `GET /v1/audit` takes `since`, `event` and `limit` and NOTHING that
    // bounds the page from above, and the store orders by `seq DESC`. So a
    // second page of OLDER rows is not reachable, at any limit, and a
    // LOAD MORE that implied otherwise would be lying to an auditor about
    // whether they had seen everything.
    expect(ceilingLine(1000, 1000)).toMatch(/NEWEST 1000/);
    expect(ceilingLine(1000, 1000)).toMatch(/NARROW/);
    expect(ceilingLine(500, 1000)).toBe('');
  });
});
