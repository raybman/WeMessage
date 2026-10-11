/**
 * v2 F4: the pure half of rich turns. Delivery is a ladder claimed only as
 * far as chat.db proves it; reactions fold one per sender, latest wins, a
 * removal clears; a file is a basename, a type and a size, never a path.
 */
import { describe, expect, it } from 'vitest';
import {
  deliveryOf,
  fileOf,
  foldReactions,
  reactionKind,
  type DeliveryInput,
  type FileDbRow,
  type ReactionRow,
} from '@wemessage/ingest';

const NS = 1_000_000_000n;
/** Apple-epoch ns for minute `m` past 10:00 on 2026-03-01. */
const ns = (m: number): bigint =>
  BigInt(
    Date.parse(`2026-03-01T10:${String(m).padStart(2, '0')}:00.000Z`) / 1000 -
      978_307_200,
  ) * NS;
const iso = (m: number): string =>
  `2026-03-01T10:${String(m).padStart(2, '0')}:00.000Z`;

const outbound: DeliveryInput = {
  isFromMe: 1n,
  service: 'imessage',
  isGroup: false,
  error: 0n,
  isSent: 0n,
  isDelivered: 0n,
  dateDelivered: 0n,
  dateRead: 0n,
};

describe('deliveryOf (v2 F4)', () => {
  it('deliveryLadder: one row per rung, first match wins', () => {
    const everything = {
      ...outbound,
      isSent: 1n,
      isDelivered: 1n,
      dateDelivered: ns(2),
      dateRead: ns(3),
    };
    expect(deliveryOf(everything)).toEqual({ state: 'read', at: iso(3) });
    expect(deliveryOf({ ...everything, dateRead: 0n })).toEqual({
      state: 'delivered',
      at: iso(2),
    });
    expect(
      deliveryOf({ ...everything, dateRead: 0n, dateDelivered: 0n }),
    ).toEqual({ state: 'delivered', at: null });
    expect(
      deliveryOf({ ...outbound, isDelivered: 0n, dateDelivered: ns(4) }),
    ).toEqual({ state: 'delivered', at: iso(4) });
    expect(deliveryOf({ ...outbound, isSent: 1n })).toEqual({
      state: 'sent',
      at: null,
    });
    expect(deliveryOf(outbound)).toBeNull();
  });

  it('deliveryLadder: SMS stops at delivered, never read', () => {
    for (const service of ['sms', 'rcs', 'unknown'] as const) {
      expect(
        deliveryOf({
          ...outbound,
          service,
          isDelivered: 1n,
          dateDelivered: ns(2),
          dateRead: ns(3),
        }),
      ).toEqual({ state: 'delivered', at: iso(2) });
    }
  });

  it('deliveryLadder: a group stops at delivered, never read', () => {
    expect(
      deliveryOf({
        ...outbound,
        isGroup: true,
        isSent: 1n,
        dateDelivered: ns(2),
        dateRead: ns(3),
      }),
    ).toEqual({ state: 'delivered', at: iso(2) });
  });

  it('deliveryLadder: an inbound turn never carries a delivery', () => {
    expect(
      deliveryOf({ ...outbound, isFromMe: 0n, isSent: 1n, dateRead: ns(3) }),
    ).toBeUndefined();
    expect(deliveryOf({ ...outbound, isFromMe: null })).toBeUndefined();
  });

  it('failedCarriesErrorCode, above every other rung', () => {
    expect(
      deliveryOf({ ...outbound, error: 22n, isSent: 1n, dateRead: ns(3) }),
    ).toEqual({ state: 'failed', at: null, errorCode: 22 });
  });

  it('every NULL column is a rung not proven', () => {
    expect(
      deliveryOf({
        isFromMe: 1n,
        service: 'imessage',
        isGroup: false,
        error: null,
        isSent: null,
        isDelivered: null,
        dateDelivered: null,
        dateRead: null,
      }),
    ).toBeNull();
  });
});

/** A tapback row aimed at `target`. */
function tap(
  rowid: number,
  type: number,
  target: string,
  opts: { m?: number; me?: boolean; handle?: string } = {},
): ReactionRow {
  return {
    rowid: BigInt(rowid),
    date: ns(opts.m ?? rowid),
    type: BigInt(type),
    target,
    isFromMe: opts.me === true ? 1n : 0n,
    handle: opts.me === true ? null : (opts.handle ?? '+15550100001'),
  };
}

describe('foldReactions (v2 F4)', () => {
  const page = new Set(['G1', 'G2']);

  it('removalClearsSender', () => {
    const folded = foldReactions(
      [tap(1, 2000, 'p:0/G1'), tap(2, 3000, 'p:0/G1')],
      page,
    );
    expect(folded.get('G1')).toBeUndefined();
  });

  it('a removal with no prior add is a no-op', () => {
    const folded = foldReactions(
      [tap(1, 3001, 'p:0/G1'), tap(2, 2003, 'p:0/G2')],
      page,
    );
    expect(folded.get('G1')).toBeUndefined();
    expect(folded.get('G2')).toEqual([
      { kind: 'laugh', from: 'them', handle: '+15550100001' },
    ]);
  });

  it('latestPerSenderWins, by date then ROWID', () => {
    const folded = foldReactions(
      [
        tap(5, 2000, 'p:0/G1', { m: 1 }),
        tap(3, 2001, 'p:0/G1', { m: 2 }),
        // Same date as rowid 3, higher ROWID: wins the tie.
        tap(4, 2004, 'p:0/G1', { m: 2 }),
        tap(6, 2002, 'p:0/G1', { m: 1, handle: '+15550100002' }),
      ],
      page,
    );
    expect(folded.get('G1')).toEqual([
      { kind: 'dislike', from: 'them', handle: '+15550100002' },
      { kind: 'emphasize', from: 'them', handle: '+15550100001' },
    ]);
  });

  it('partAndBpFold onto the whole turn', () => {
    const folded = foldReactions(
      [
        tap(1, 2000, 'p:1/G1'),
        tap(2, 2001, 'bp:G1', { handle: '+15550100002' }),
        tap(3, 2005, 'p:0/G1', { me: true }),
      ],
      page,
    );
    expect(folded.get('G1')).toEqual([
      { kind: 'love', from: 'them', handle: '+15550100001' },
      { kind: 'like', from: 'them', handle: '+15550100002' },
      { kind: 'question', from: 'me' },
    ]);
  });

  it('emojiTapbackIsOther, and so is a sticker tapback', () => {
    expect(reactionKind(2006)).toBe('other');
    expect(reactionKind(2007)).toBe('other');
    expect([2000, 2001, 2002, 2003, 2004, 2005].map(reactionKind)).toEqual([
      'love',
      'like',
      'dislike',
      'laugh',
      'emphasize',
      'question',
    ]);
  });

  it('ignores rows aimed outside the page and rows that are not tapbacks', () => {
    const folded = foldReactions(
      [
        tap(1, 2000, 'p:0/ELSEWHERE'),
        tap(2, 1000, 'p:0/G1'),
        tap(3, 0, 'p:0/G1'),
        { ...tap(4, 2000, 'p:0/G1'), target: null },
      ],
      page,
    );
    expect(folded.size).toBe(0);
  });
});

const fileRow: FileDbRow = {
  messageRowid: 1n,
  id: 'AT-RICH-1',
  transferName: 'IMG_0412.heic',
  mimeType: 'image/heic',
  uti: 'public.heic',
  totalBytes: 2_400_000n,
  isSticker: 0n,
  hidden: 0n,
};

describe('fileOf (v2 F4)', () => {
  it('maps every column, never a path', () => {
    expect(fileOf(fileRow)).toEqual({
      id: 'AT-RICH-1',
      name: 'IMG_0412.heic',
      mime: 'image/heic',
      uti: 'public.heic',
      bytes: 2_400_000,
      sticker: false,
      hidden: false,
    });
    expect(Object.keys(fileOf(fileRow))).not.toContain('path');
  });

  it('basenameOnly: "a/b/../x.pdf" is "x.pdf"', () => {
    expect(fileOf({ ...fileRow, transferName: 'a/b/../x.pdf' }).name).toBe(
      'x.pdf',
    );
    expect(
      fileOf({
        ...fileRow,
        transferName: '~/Library/Messages/Attachments/ab/12/x.pdf',
      }).name,
    ).toBe('x.pdf');
    for (const none of [null, '', 'a/', '..', 'a/.']) {
      expect(fileOf({ ...fileRow, transferName: none }).name).toBeNull();
    }
    expect(
      fileOf({ ...fileRow, transferName: `${'n'.repeat(400)}.pdf` }).name
        ?.length,
    ).toBe(255);
  });

  it('zeroBytesIsNull, and so is a NULL size', () => {
    expect(fileOf({ ...fileRow, totalBytes: 0n }).bytes).toBeNull();
    expect(fileOf({ ...fileRow, totalBytes: null }).bytes).toBeNull();
  });

  it('flags sticker and hidden', () => {
    expect(fileOf({ ...fileRow, isSticker: 1n, hidden: 1n })).toMatchObject({
      sticker: true,
      hidden: true,
    });
  });
});
