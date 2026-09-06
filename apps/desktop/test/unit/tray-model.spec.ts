import { describe, expect, it } from 'vitest';

import type { DraftPayload } from '@wemessage/client';
import type { GatewayEventPayload } from '@wemessage/protocol';
import { GATEWAY_EVENT_NAMES } from '@wemessage/protocol';
import {
  PREVIEW_LIMIT,
  SHORTCUT_LINE,
  SHORTCUT_STATES,
  TRAY_ACCELERATOR,
  TRAY_MENU_ROWS,
  TRAY_POSTURES,
  TRAY_POSTURE_SPEC,
  TRAY_REFRESH_ON,
  badgeFor,
  previewOf,
  shortcutStateOf,
  trayBadge,
  trayMenu,
  trayPosture,
  trayQueueOf,
  trayTooltip,
  traySignificant,
  type TrayItem,
  type TrayModel,
} from '../../src/main/tray-model.js';

/**
 * Scenario 16 — the tray, as a value.
 *
 * A `Tray` is the one surface in this app that Playwright's page API cannot
 * see: there is no DOM, no accessibility tree the harness can query, and on
 * this Electron version no `tray.getImage()` to read back. The plan's answer
 * was to mirror the menu into a `data-tray-menu` attribute on `<html>` and
 * assert on that, which proves the mirror was written and nothing else. This
 * file takes the other half of the answer: everything the tray SAYS is
 * computed by a pure function over a value, so the words, the ordering, the
 * enabled/disabled flags and — most of all — the set of commands a menu item
 * is even capable of carrying are decided here, in a plain Node worker. The
 * e2e then reads the REAL `Tray` and the REAL `Menu` out of main and checks
 * they were built from this.
 *
 * The load-bearing row in this file is the last one. `TrayCommand` is a
 * closed union with no approve, no send, no bulk and no un-kill in it. A tray
 * that could approve is not a bug that a test catches, it is a shape that
 * does not compile.
 */

const ISO = '2026-04-18T09:30:00.000Z';

function draft(over: Partial<DraftPayload>): DraftPayload {
  return {
    id: '01HQ00000000000000000SC16A',
    chatGuid: 'iMessage;-;+15550000001',
    body: 'the front desk will call you back',
    state: 'pending',
    stateChangedAt: ISO,
    expiresAt: null,
    createdAt: ISO,
    ...over,
  } as DraftPayload;
}

function model(over: Partial<TrayModel> = {}): TrayModel {
  return {
    conn: 'connected',
    killSwitch: false,
    armed: { reason: 'armed', until: null },
    adapters: [],
    queue: { count: 0, oldest: [], inFlight: 0 },
    shortcut: 'registered',
    lastSync: ISO,
    ...over,
  };
}

/** Every item in the tree, submenus included, in render order. */
function flatten(items: readonly TrayItem[]): TrayItem[] {
  const out: TrayItem[] = [];
  for (const item of items) {
    out.push(item);
    if (item.submenu !== undefined) out.push(...flatten(item.submenu));
  }
  return out;
}

const idsOf = (items: readonly TrayItem[]): string[] =>
  flatten(items).map((i) => i.id);

const labelsOf = (items: readonly TrayItem[]): string[] =>
  flatten(items).map((i) => i.label);

/* ── the badge ────────────────────────────────────────────────────────── */

describe('s8 Sc16 — the badge is total over number', () => {
  it('renders 0 as nothing and caps at 9+', () => {
    expect(badgeFor(0, true)).toBe('');
    expect(badgeFor(1, true)).toBe('1');
    expect(badgeFor(9, true)).toBe('9');
    expect(badgeFor(10, true)).toBe('9+');
    expect(badgeFor(1_000_000, true)).toBe('9+');
  });

  it('says nothing at all while disconnected', () => {
    // A count that was true when the socket dropped is a count that is
    // getting less true every second it stays on screen. The badge is the
    // one carrier with no room for a qualifier, so it goes silent.
    for (const n of [0, 1, 9, 10, 400]) expect(badgeFor(n, false)).toBe('');
  });

  it('refuses a number that is not one', () => {
    for (const n of [-1, -0.5, Number.NaN, Infinity, -Infinity, 1.5]) {
      expect(badgeFor(n, true)).toMatch(/^(|[1-9]|9\+)$/);
    }
    expect(badgeFor(-1, true)).toBe('');
    expect(badgeFor(Number.NaN, true)).toBe('');
    expect(badgeFor(Infinity, true)).toBe('9+');
  });

  it('only ever produces one of eleven strings', () => {
    const seen = new Set<string>();
    for (let n = -3; n < 40; n += 1) {
      seen.add(badgeFor(n, true));
      seen.add(badgeFor(n, false));
    }
    expect([...seen].sort()).toEqual([
      '',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '9+',
    ]);
  });
});

/* ── posture ──────────────────────────────────────────────────────────── */

describe('s8 Sc16 — the posture is decided in one place', () => {
  it('has a glyph, an uppercase word and an image name for every posture', () => {
    expect(Object.keys(TRAY_POSTURE_SPEC).sort()).toEqual(
      [...TRAY_POSTURES].sort(),
    );
    const glyphs = new Set<string>();
    const images = new Set<string>();
    for (const posture of TRAY_POSTURES) {
      const spec = TRAY_POSTURE_SPEC[posture];
      // §3.10's closed glyph set, not a new one.
      expect('●◐◔⊘◌').toContain(spec.glyph);
      expect(spec.word).toBe(spec.word.toUpperCase());
      expect(spec.word.length).toBeGreaterThan(0);
      // The plan's asset names, which the e2e checks against the real images.
      expect(spec.image).toMatch(/Template$/);
      glyphs.add(spec.glyph);
      images.add(spec.image);
    }
    // Five distinct SHAPES. On macOS a template image is monochrome by
    // definition, so the icon cannot carry colour at all and the shape is
    // the whole signal; §1.7's "colour is never the sole carrier" is
    // satisfied structurally rather than by a rule anyone has to remember.
    expect(glyphs.size).toBe(TRAY_POSTURES.length);
    expect(images.size).toBe(TRAY_POSTURES.length);
    expect([...images]).toEqual([
      'armedTemplate',
      'draftOnlyTemplate',
      'sendingTemplate',
      'killedTemplate',
      'disconnectedTemplate',
    ]);
  });

  it('reads DISCONNECTED before anything else, because nothing else is known', () => {
    for (const conn of ['reconnecting', 'down'] as const) {
      expect(trayPosture(model({ conn, killSwitch: true }))).toBe(
        'disconnected',
      );
      expect(
        trayPosture(
          model({ conn, queue: { count: 2, oldest: [], inFlight: 1 } }),
        ),
      ).toBe('disconnected');
    }
  });

  it('reads KILLED before SENDING, because a deny outranks a hypothesis', () => {
    expect(
      trayPosture(
        model({
          killSwitch: true,
          queue: { count: 0, oldest: [], inFlight: 3 },
        }),
      ),
    ).toBe('killed');
  });

  it('reads an unknown kill switch as DRAFT-ONLY, never as ARMED', () => {
    // `killSwitch: null` is the daemon saying it has no answer. The safe
    // rendering of "we do not know whether sending is on" is the one that
    // does not claim it is.
    expect(trayPosture(model({ killSwitch: null }))).toBe('draft-only');
  });

  it('reads SENDING while something is in flight and ARMED when nothing is', () => {
    expect(
      trayPosture(model({ queue: { count: 4, oldest: [], inFlight: 1 } })),
    ).toBe('sending');
    expect(trayPosture(model())).toBe('armed');
  });

  it('reads DRAFT-ONLY whenever the daemon is not armed', () => {
    for (const reason of ['quiet-hours', 'outside-window', 'disarmed', '']) {
      expect(trayPosture(model({ armed: { reason, until: null } }))).toBe(
        'draft-only',
      );
    }
    expect(trayPosture(model({ armed: null }))).toBe('draft-only');
  });
});

/* ── the title and the tooltip: the two public strings ────────────────── */

describe('s8 Sc16 — nothing private reaches the two strings on the screen', () => {
  const secretish = draft({
    id: '01HQ00000000000000000SC16B',
    chatGuid: 'iMessage;-;+15550000009',
    body: 'wm_notatoken shhh secret body text',
  });

  it('the badge is a count and nothing else', () => {
    const m = model({
      queue: { count: 3, oldest: [{ ...previewRow(secretish) }], inFlight: 0 },
    });
    expect(trayBadge(m)).toBe('3');
    expect(trayBadge(m)).not.toContain('15550000009');
  });

  it('the tooltip carries a posture and a count, never content', () => {
    const m = model({
      queue: { count: 3, oldest: [previewRow(secretish)], inFlight: 0 },
    });
    const tip = trayTooltip(m);
    expect(tip).toContain(TRAY_POSTURE_SPEC.armed.word);
    expect(tip).toContain(TRAY_POSTURE_SPEC.armed.glyph);
    expect(tip).toContain('3');
    for (const leak of [
      'secret',
      'shhh',
      '15550000009',
      '+1555',
      `wm${'_'}`,
      '01HQ',
      'iMessage;',
    ]) {
      expect(tip).not.toContain(leak);
    }
    // §1.7: a status line is uppercase. The tooltip is one.
    expect(tip.replace(/[^A-Za-z]/g, '')).toBe(
      tip.replace(/[^A-Za-z]/g, '').toUpperCase(),
    );
  });

  it('says DISCONNECTED rather than a stale number when the socket is gone', () => {
    const m = model({
      conn: 'down',
      queue: { count: 7, oldest: [], inFlight: 0 },
    });
    expect(trayBadge(m)).toBe('');
    expect(trayTooltip(m)).toContain(TRAY_POSTURE_SPEC.disconnected.word);
    expect(trayTooltip(m)).not.toContain('7');
  });
});

function previewRow(d: DraftPayload): {
  id: string;
  createdAt: string;
  preview: string;
} {
  return { id: d.id, createdAt: d.createdAt, preview: previewOf(d.body) };
}

/* ── the preview ──────────────────────────────────────────────────────── */

describe('s8 Sc16 — a preview is bounded and single-line', () => {
  it('collapses whitespace and truncates at the limit', () => {
    const long = 'a'.repeat(400);
    expect(previewOf(long).length).toBeLessThanOrEqual(PREVIEW_LIMIT);
    expect(previewOf('one\n\ttwo   three')).toBe('one two three');
    expect(previewOf('   ')).toBe('');
  });

  it('never emits a newline, whatever it is given', () => {
    for (const body of [
      'a\nb',
      'a\r\nb',
      '\u2028line separator',
      '\u0000null',
      'e\u0301'.repeat(80),
    ]) {
      const out = previewOf(body);
      expect(out).not.toMatch(/[\r\n\u2028\u2029]/);
      expect(out.length).toBeLessThanOrEqual(PREVIEW_LIMIT);
    }
  });
});

/* ── what the tray reads, and when it re-reads it ─────────────────────── */

describe('s8 Sc16 — the tray re-reads on events, never on a clock', () => {
  it('has an entry for every event the protocol can emit', () => {
    // Compile-time total already (`Readonly<Record<GatewayEventName, …>>`);
    // this is the runtime half, which catches a vocabulary that grew while
    // the type was widened somewhere else.
    expect(Object.keys(TRAY_REFRESH_ON).sort()).toEqual(
      [...GATEWAY_EVENT_NAMES].sort(),
    );
  });

  it('re-reads on every draft event and on nothing that is not one', () => {
    for (const name of GATEWAY_EVENT_NAMES) {
      const expected = name.startsWith('draft.');
      expect([name, TRAY_REFRESH_ON[name]]).toEqual([name, expected]);
    }
  });

  it('is asked about a frame, not about a string', () => {
    expect(
      traySignificant({
        event: 'draft.created',
      } as unknown as GatewayEventPayload),
    ).toBe(true);
    expect(
      traySignificant({
        event: 'message.received',
      } as unknown as GatewayEventPayload),
    ).toBe(false);
    // An event name nobody has declared is not a licence to guess.
    expect(
      traySignificant({
        event: 'draft.invented',
      } as unknown as GatewayEventPayload),
    ).toBe(false);
  });
});

describe('s8 Sc16 — the queue projection is a filter, not a fold', () => {
  it('counts pending, keeps the three oldest, and counts what is in flight', () => {
    const rows = [
      draft({ id: 'D5', createdAt: '2026-04-18T09:05:00.000Z' }),
      draft({ id: 'D1', createdAt: '2026-04-18T09:01:00.000Z' }),
      draft({ id: 'D3', createdAt: '2026-04-18T09:03:00.000Z' }),
      draft({ id: 'D2', createdAt: '2026-04-18T09:02:00.000Z' }),
      draft({ id: 'A1', state: 'approved' }),
      draft({ id: 'S1', state: 'sending' }),
      draft({ id: 'X1', state: 'sent' }),
      draft({ id: 'X2', state: 'expired' }),
    ];
    const queue = trayQueueOf(rows);
    expect(queue.count).toBe(4);
    expect(queue.inFlight).toBe(2);
    expect(queue.oldest.map((r) => r.id)).toEqual(['D1', 'D2', 'D3']);
    expect(queue.oldest).toHaveLength(TRAY_MENU_ROWS);
    for (const row of queue.oldest) {
      expect(row.preview.length).toBeLessThanOrEqual(PREVIEW_LIMIT);
    }
  });

  it('is empty for an empty list, and never throws on a short one', () => {
    expect(trayQueueOf([])).toEqual({ count: 0, oldest: [], inFlight: 0 });
    expect(trayQueueOf([draft({})]).oldest).toHaveLength(1);
  });
});

/* ── the menu ─────────────────────────────────────────────────────────── */

describe('s8 Sc16 — the menu says what it does', () => {
  it('opens with the posture, mirroring the strip', () => {
    const menu = trayMenu(
      model({ queue: { count: 2, oldest: [], inFlight: 0 } }),
    );
    const header = menu[0];
    expect(header?.id).toBe('posture');
    expect(header?.enabled).toBe(false);
    expect(header?.label).toContain(TRAY_POSTURE_SPEC.armed.glyph);
    expect(header?.label).toContain(TRAY_POSTURE_SPEC.armed.word);
    expect(header?.label).toContain('2 PENDING');
  });

  it('lists the three oldest drafts, each of which only navigates', () => {
    const rows = [
      draft({ id: 'D1', createdAt: '2026-04-18T09:01:00.000Z' }),
      draft({ id: 'D2', createdAt: '2026-04-18T09:02:00.000Z' }),
      draft({ id: 'D3', createdAt: '2026-04-18T09:03:00.000Z' }),
      draft({ id: 'D4', createdAt: '2026-04-18T09:04:00.000Z' }),
    ];
    const menu = trayMenu(model({ queue: trayQueueOf(rows) }));
    const drafts = flatten(menu).filter((i) => i.id.startsWith('draft:'));
    expect(drafts.map((i) => i.id)).toEqual([
      'draft:D1',
      'draft:D2',
      'draft:D3',
    ]);
    for (const item of drafts) {
      expect(item.enabled).toBe(true);
      expect(item.command).toEqual({
        kind: 'navigate',
        screen: 'queue',
        draftId: item.id.slice('draft:'.length),
      });
    }
  });

  it('offers no draft rows and no count while disconnected, and offers repair instead', () => {
    const menu = trayMenu(
      model({
        conn: 'down',
        queue: trayQueueOf([draft({ id: 'D1' })]),
        lastSync: '2026-04-18T09:30:00.000Z',
      }),
    );
    const ids = idsOf(menu);
    expect(ids).not.toContain('draft:D1');
    expect(ids).toContain('retry');
    expect(ids).toContain('doctor');
    expect(ids).toContain('last-sync');
    const sync = flatten(menu).find((i) => i.id === 'last-sync');
    expect(sync?.enabled).toBe(false);
    // Strengthened while implementing: the `Z` is load-bearing. This string
    // is sliced out of the daemon's own ISO instant with no `Date` and no
    // timezone conversion anywhere, so it is UTC; a label that read
    // `LAST SYNC 09:30` next to a wall clock showing 02:30 would be read as a
    // bug in the app rather than as the operator's own offset. Pinning the
    // suffix also pins the derivation: a future `toLocaleTimeString` cannot
    // satisfy this regex.
    expect(sync?.label).toMatch(/^LAST SYNC \d\d:\d\dZ$/);
    // Nothing that acts on the queue is offered when the queue is unknown.
    expect(ids).not.toContain('pause');
  });

  it('says LAST SYNC NEVER rather than inventing an instant', () => {
    const menu = trayMenu(model({ conn: 'down', lastSync: null }));
    expect(flatten(menu).find((i) => i.id === 'last-sync')?.label).toBe(
      'LAST SYNC NEVER',
    );
  });
});

/* ── the deny / clamp distinction, in the menu's own words ────────────── */

describe('s8 Sc16 — a deny may be tightened from here, never released', () => {
  it('offers the kill switch when it is off', () => {
    const kill = flatten(trayMenu(model({ killSwitch: false }))).find(
      (i) => i.id === 'kill',
    );
    expect(kill?.enabled).toBe(true);
    expect(kill?.command).toEqual({ kind: 'kill' });
    expect(kill?.label).toContain('KILL OUTBOUND');
  });

  it('refuses to release it from a menu, and says where to go instead', () => {
    // The organising principle of this scenario: a control that binds
    // EVERYONE — the operator included — is not released from a surface that
    // can be opened, mis-clicked and dismissed while nobody is looking at
    // the screen. Arming it needs no context and is always safe; releasing
    // it needs the banner, the horizon and the note that only the window
    // carries. So the tray tightens, and the window is what loosens.
    const items = flatten(trayMenu(model({ killSwitch: true })));
    const kill = items.find((i) => i.id === 'kill');
    expect(kill?.enabled).toBe(false);
    expect(kill?.command).toBeUndefined();
    expect(kill?.label).toContain('KILLED');
    expect(kill?.label.toUpperCase()).toContain('WINDOW');
    // And OPEN is right there, because a dead end is not an answer.
    expect(items.find((i) => i.id === 'open')?.enabled).toBe(true);
  });

  it('offers pause and resume symmetrically, because a clamp binds only autonomy', () => {
    // `evaluateGate` answers the kill switch as a DENY (`allow: false`) and
    // reaches `clampedBy = 'outside-window'` for a pause with `allow: true`
    // and `mode: 'draft-only'`. A paused daemon still sends what a human
    // approves; a killed one refuses the human too. That difference is why
    // one of these is reversible from a menu and the other is not.
    const paused = model({ armed: { reason: 'paused', until: ISO } });
    const items = flatten(trayMenu(paused));
    expect(items.find((i) => i.id === 'pause:resume')?.enabled).toBe(true);
    expect(items.find((i) => i.id === 'pause:resume')?.command).toEqual({
      kind: 'resume',
    });
    expect(items.find((i) => i.id === 'pause:1h')?.command).toEqual({
      kind: 'pause',
      until: '1h',
    });
    expect(items.find((i) => i.id === 'pause:tomorrow')?.command).toEqual({
      kind: 'pause',
      until: 'until-tomorrow',
    });
    expect(items.find((i) => i.id === 'pause:window')?.command).toEqual({
      kind: 'pause',
      until: 'rest-of-window',
    });
  });

  it('calls a clamp a clamp, in the submenu, in words', () => {
    const note = flatten(trayMenu(model())).find((i) => i.id === 'pause:note');
    expect(note?.enabled).toBe(false);
    expect(note?.label).toContain('CLAMP');
    expect(note?.label).toContain('NOT A DENY');
    // And the half operators get wrong: coming back does not flush.
    expect(note?.label).toContain('RELEASES NOTHING');
  });

  it('shows the paused horizon as a time, never as a countdown', () => {
    const paused = model({
      armed: { reason: 'paused', until: '2026-04-18T14:30:00.000Z' },
    });
    const label = flatten(trayMenu(paused)).find(
      (i) => i.id === 'pause',
    )?.label;
    expect(label).toMatch(/^PAUSED UNTIL \d\d:\d\d/);
    // No "in 42 minutes", no "4h left": every one of those is a value that
    // is wrong one second after it is written, and this menu has no timer to
    // correct it with. A wall-clock instant stays true until the daemon says
    // otherwise, and the daemon says so with `arming.changed`.
    expect(label).not.toMatch(/\b(IN|LEFT|REMAINING|AGO)\b/);
  });

  it('does not call a schedule or a deny a pause, even though both carry a horizon', () => {
    // This row is the correction of an earlier version of THIS file, which
    // built the paused case out of `reason: 'outside-window'` and passed.
    // `resolveArming` reports the winning hold of five and an `until` that is
    // the EARLIEST horizon among all of them, so a daemon that is merely
    // out of hours arrives with a reason and an instant and no pause at all.
    // Rendering that as PAUSED UNTIL would be a lie the operator could act
    // on: RESUME NOW would be lit, and clicking it clears a setting nobody
    // set while the silence carries on.
    for (const reason of ['outside-window', 'kill-switch', 'circuit-open']) {
      const items = flatten(trayMenu(model({ armed: { reason, until: ISO } })));
      expect([reason, items.find((i) => i.id === 'pause')?.label]).toEqual([
        reason,
        'PAUSE',
      ]);
      expect([
        reason,
        items.find((i) => i.id === 'pause:resume')?.enabled,
      ]).toEqual([reason, false]);
    }
  });

  it('names the third pause item by what the daemon does with it', () => {
    // The plan says this item passes `armed.until` and is disabled with "no
    // window is armed" when that is null. It does neither: the daemon takes
    // the TOKEN `rest-of-window`, resolves it through `armedWindowClose`,
    // and answers 409 `not-armed` when there is no schedule window — a fact
    // about the SCHEDULE dimension, which `armed.until` does not report.
    // A GUI that disabled the item on `armed.until === null` would hide it
    // exactly when a window is open but unbounded.
    const item = flatten(
      trayMenu(model({ armed: { reason: 'armed', until: null } })),
    ).find((i) => i.id === 'pause:window');
    expect(item?.enabled).toBe(true);
    expect(item?.command).toEqual({ kind: 'pause', until: 'rest-of-window' });
  });
});

/* ── the global shortcut, said out loud ───────────────────────────────── */

describe('s8 Sc16 — the shortcut is a summon, and says so', () => {
  it('has a sentence for every state it can be in', () => {
    expect(Object.keys(SHORTCUT_LINE).sort()).toEqual(
      [...SHORTCUT_STATES].sort(),
    );
    for (const state of SHORTCUT_STATES) {
      const line = SHORTCUT_LINE[state];
      expect(line).toBe(line.toUpperCase());
      expect(line).toContain('⌘⇧K');
      expect(line.length).toBeGreaterThan(10);
    }
    expect(TRAY_ACCELERATOR).toBe('CommandOrControl+Shift+K');
  });

  it('never claims the chord does something to outbound', () => {
    // The chord SUMMONS. It does not toggle. A system-wide keystroke has no
    // context: the operator pressing it cannot see which state they are in,
    // so half the time the chord meant to STOP the world would RELEASE the
    // deny. One extra keystroke in the case that matters buys the removal of
    // an entire class of catastrophic misfire.
    for (const state of SHORTCUT_STATES) {
      const line = SHORTCUT_LINE[state];
      expect(line).not.toMatch(/\b(KILLS?|TOGGLES?|STOPS?|PAUSES?|SENDS?)\b/);
    }
    expect(SHORTCUT_LINE.registered).toContain('FORWARD');
    expect(SHORTCUT_LINE.taken).toContain('ANOTHER APPLICATION');
  });

  it('maps the two booleans the OS gives us onto the three states', () => {
    // Strengthened while implementing, because the row that used to cover
    // this was factually wrong. The plan (and the e2e's first draft) assumed
    // `globalShortcut.register` returns false when another application owns
    // the combination. Probed on the installed Electron 44.2.0 under darwin
    // 25.5.0: two concurrent processes both registering
    // `CommandOrControl+Shift+K` each got `register() === true` AND
    // `isRegistered() === true`. A genuine collision is therefore not
    // reproducible on demand on this platform, so an e2e that claimed to
    // provoke one was asserting a premise rather than a behaviour.
    //
    // The honest split: the TABLE is pure and is proved exhaustively here,
    // for all four inputs, including the state the platform would not hand
    // us today. The WIRING is proved in the e2e, which checks that whatever
    // state was recorded agrees with `globalShortcut.isRegistered` and that
    // the same words reach both the kill pane and the tray.
    expect(shortcutStateOf(true, true)).toBe('registered');
    // Accepted and then lost: the OS took it and something else took it back.
    expect(shortcutStateOf(true, false)).toBe('declined');
    // Refused outright, which is the only case with a named owner.
    expect(shortcutStateOf(false, false)).toBe('taken');
    expect(shortcutStateOf(false, true)).toBe('taken');
    // Total: every input lands in the declared set, so the renderer's
    // `SHORTCUT_LINE[state]` lookup can never miss.
    for (const accepted of [true, false]) {
      for (const registered of [true, false]) {
        expect(SHORTCUT_STATES as readonly string[]).toContain(
          shortcutStateOf(accepted, registered),
        );
      }
    }
  });

  it('puts the chord’s own state in the menu, so a dead chord is visible', () => {
    const taken = flatten(trayMenu(model({ shortcut: 'taken' })));
    const line = taken.find((i) => i.id === 'shortcut');
    expect(line?.enabled).toBe(false);
    expect(line?.label).toBe(SHORTCUT_LINE.taken);
  });
});

/* ── the negative row: no verb exists that could approve ──────────────── */

describe('s8 Sc16 — the tray cannot act on a draft, structurally', () => {
  const everyModel: TrayModel[] = [
    model(),
    model({ killSwitch: true }),
    model({ killSwitch: null }),
    model({ conn: 'down' }),
    model({ conn: 'reconnecting' }),
    model({ armed: null }),
    model({ armed: { reason: 'outside-window', until: ISO } }),
    model({ armed: { reason: 'paused', until: ISO } }),
    model({ shortcut: 'taken' }),
    model({ shortcut: 'declined' }),
    model({
      queue: trayQueueOf([
        draft({ id: 'D1', createdAt: '2026-04-18T09:01:00.000Z' }),
        draft({ id: 'D2', createdAt: '2026-04-18T09:02:00.000Z' }),
        draft({ id: 'D3', createdAt: '2026-04-18T09:03:00.000Z' }),
        draft({ id: 'A1', state: 'approved' }),
      ]),
    }),
  ];

  it('offers no label that reads like an approval or a send, in any state', () => {
    for (const m of everyModel) {
      for (const label of labelsOf(trayMenu(m))) {
        expect(label).not.toMatch(/approve|send|dispatch|reject|recall/i);
      }
    }
  });

  it('emits only commands from the closed non-acting set', () => {
    const kinds = new Set<string>();
    for (const m of everyModel) {
      for (const item of flatten(trayMenu(m))) {
        if (item.command !== undefined) kinds.add(item.command.kind);
      }
    }
    // Every verb this menu can carry. `kill` ARMS a deny and takes no
    // argument, so there is no spelling of it that releases one; `navigate`
    // selects and nothing else; `retry` and `doctor` are the daemon's own
    // repair reads. Nothing here touches a draft.
    expect([...kinds].sort()).toEqual([
      'doctor',
      'kill',
      'navigate',
      'open',
      'pause',
      'quit',
      'resume',
      'retry',
    ]);
  });

  it('gives every enabled item a command and every disabled item none', () => {
    for (const m of everyModel) {
      for (const item of flatten(trayMenu(m))) {
        if (item.separator === true) continue;
        if (item.submenu !== undefined) continue;
        expect([item.id, item.enabled]).toEqual([
          item.id,
          item.command !== undefined,
        ]);
      }
    }
  });

  it('uses a stable id for every item, so the e2e can name one', () => {
    for (const m of everyModel) {
      const ids = flatten(trayMenu(m))
        .filter((i) => i.separator !== true)
        .map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
