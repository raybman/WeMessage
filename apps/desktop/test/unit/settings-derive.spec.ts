/**
 * s8 Scenario 14, the pure half: the settings form's key list, the
 * Permissions pane's card table, the pause horizon and the reader that turns
 * a `PATCH /v1/settings` refusal back into the daemon's own words.
 *
 * Everything here is a function of an argument. No clock is read, no timer
 * is armed and no bridge is reached, which is exactly what makes these rows
 * runnable outside Electron — and what the arch rows in `test/arch.spec.ts`
 * pin structurally so a later screen cannot quietly acquire either.
 *
 * Four decisions this file is the record of:
 *
 * 1. **The screen re-declares the daemon's fifteen keys.** INV-1 leaves the
 *    renderer without a `@wemessage/core` dependency, and `packages/daemon`
 *    is not a dependency of anything in `apps/desktop/src/renderer` either,
 *    so `SETTINGS_SCHEMA` cannot be imported. It is re-declared, the way
 *    `derive/auditRows.ts` re-declares §1.6's twelve deny reasons, and tied
 *    back to `packages/daemon/src/settings/schema.ts` by an arch row that
 *    resolves the schema's `SETTING_*` constants to their literals.
 *
 * 2. **No bound is ever hardcoded here.** `SettingEntry` carries `floor`,
 *    `ceiling`, `type`, `default`, `version` and `use` on the wire, so the
 *    form renders the daemon's numbers. A field whose key the daemon did
 *    not answer renders as a row with no control rather than a row with an
 *    invented value: `fieldRows` is total over the eleven writable keys,
 *    `draftOf` is not total over anything.
 *
 * 3. **A settings refusal has no prose to borrow.** The rules editor renders
 *    zod's own `message` strings; `planPatch` answers with a STRUCTURE —
 *    `{error:'below-floor', key, floor}` — and no sentence. So the reader
 *    renders the refusal's own error NAME and its own datum, and invents
 *    neither. This is a divergence from the plan's "the daemon's own words"
 *    only in the sense that for this route the daemon's own words are five
 *    names and four numbers.
 *
 * 4. **A check that never ran is not a check that passed.** `evaluateDoctor`
 *    short-circuits: an FDA failure returns two checks and never probes
 *    Automation or Messages at all. So `checks` is routinely INCOMPLETE, and
 *    the fourth card state is the daemon's own consequence rather than an
 *    invented vocabulary. A report that could not be read at all renders the
 *    same four cards as NOT CHECKED — never anything a reader could mistake
 *    for a grant.
 */
import { describe, expect, it } from 'vitest';
import type {
  DoctorReportPayload,
  SettingEntry,
  SettingsPayload,
} from '@wemessage/client';
import { SYSTEM_SETTINGS_PANES } from '../../src/main/policy.js';
import {
  editForm,
  formOf,
  formPatch,
  issuesByPath,
} from '../../src/renderer/derive/form.js';
import {
  FIELDS,
  GROUPS,
  POINTERS,
  READ_ONLY_KEYS,
  WRITABLE_KEYS,
  draftOf,
  fieldRows,
  pauseHorizon,
  pointerRows,
  settingsIssue,
  type WritableKey,
} from '../../src/renderer/derive/settingsFields.js';
import {
  CARD_GLYPH,
  CARD_PANE,
  CARD_STATES,
  CHECK_IDS,
  NOT_CHECKED,
  permissionCards,
} from '../../src/renderer/derive/permissionCards.js';
import { settingsRefusalOf } from '../../src/renderer/store/refusal.js';

/* ── fixtures ───────────────────────────────────────────────────────── */

function intEntry(value: number, floor: number, ceiling: number): SettingEntry {
  return {
    value,
    default: floor,
    version: 1,
    type: 'int',
    readOnly: false,
    floor,
    ceiling,
  };
}

function boolEntry(value: boolean): SettingEntry {
  return { value, default: false, version: 1, type: 'bool', readOnly: false };
}

/** Everything the daemon answers, shaped the way `GET /v1/settings` does. */
function wholePayload(): SettingsPayload {
  const out: Record<string, SettingEntry> = {};
  for (const key of WRITABLE_KEYS)
    out[key] =
      key === 'send.retryAsSms' ? boolEntry(false) : intEntry(5, 1, 600);
  out['arming.pauseUntil'] = {
    value: null,
    default: null,
    version: -1,
    type: 'iso',
    readOnly: true,
    use: 'POST /v1/toggles/pause',
  };
  out['send.circuitOpenedAt'] = {
    value: null,
    default: null,
    version: -1,
    type: 'iso',
    readOnly: true,
    use: 'POST /v1/toggles/kill-switch {"circuit": true}',
  };
  out['send.globalMode'] = {
    // The daemon's own vocabulary: `readGateSettings` narrows this row to
    // `'auto' | 'draft-only'` and nothing else, so a fixture saying `draft`
    // would be pinning a value no daemon can produce.
    value: 'draft-only',
    default: 'draft-only',
    version: 1,
    type: 'enum',
    readOnly: true,
    use: 'POST /v1/toggles/global-mode',
  };
  out['send.killSwitch'] = {
    value: false,
    default: false,
    version: -1,
    type: 'bool',
    readOnly: true,
    use: 'POST /v1/toggles/kill-switch',
  };
  return out;
}

/* ── the key list, in both directions ───────────────────────────────── */

describe('the settings key list', () => {
  it('is eleven writable and four read-only, and the two are disjoint', () => {
    expect(WRITABLE_KEYS).toHaveLength(11);
    expect(READ_ONLY_KEYS).toHaveLength(4);
    const overlap = WRITABLE_KEYS.filter((k) =>
      (READ_ONLY_KEYS as readonly string[]).includes(k),
    );
    expect(overlap).toEqual([]);
    // No duplicates in either list: a key rendered twice is a knob whose
    // second copy silently loses whatever the first one wrote.
    expect(new Set(WRITABLE_KEYS).size).toBe(WRITABLE_KEYS.length);
    expect(new Set(READ_ONLY_KEYS).size).toBe(READ_ONLY_KEYS.length);
  });

  it('is total over FIELDS and POINTERS in both directions', () => {
    expect(Object.keys(FIELDS).sort()).toEqual([...WRITABLE_KEYS].sort());
    expect(Object.keys(POINTERS).sort()).toEqual([...READ_ONLY_KEYS].sort());
  });

  it('groups every writable key, and leaves no group empty', () => {
    for (const key of WRITABLE_KEYS)
      expect(GROUPS, key).toContain(FIELDS[key].group);
    for (const group of GROUPS)
      expect(
        WRITABLE_KEYS.filter((k) => FIELDS[k].group === group),
        group,
      ).not.toHaveLength(0);
  });

  it('labels every field and every pointer, in the uppercase §1.7 wants', () => {
    for (const key of WRITABLE_KEYS) {
      expect(FIELDS[key].label, key).toBe(FIELDS[key].label.toUpperCase());
      expect(FIELDS[key].note.length, key).toBeGreaterThan(0);
    }
    for (const key of READ_ONLY_KEYS) {
      expect(POINTERS[key].label, key).toBe(POINTERS[key].label.toUpperCase());
      expect(POINTERS[key].note.length, key).toBeGreaterThan(0);
    }
  });

  it('names no bound of its own: floors and ceilings come off the wire', () => {
    const rows = fieldRows(wholePayload());
    for (const row of rows) {
      expect(row.entry, row.key).not.toBeNull();
      expect(row.entry?.floor, row.key).toBeTypeOf(
        row.key === 'send.retryAsSms' ? 'undefined' : 'number',
      );
    }
    const capped = {
      ...wholePayload(),
      'send.capContactPerHour': intEntry(30, 1, 600),
    };
    const row = fieldRows(capped).find(
      (r) => r.key === 'send.capContactPerHour',
    );
    expect(row?.entry?.ceiling).toBe(600);
    // Moving the daemon's ceiling moves the screen's, with no edit here.
    const moved = {
      ...capped,
      'send.capContactPerHour': intEntry(30, 1, 900),
    };
    expect(
      fieldRows(moved).find((r) => r.key === 'send.capContactPerHour')?.entry
        ?.ceiling,
    ).toBe(900);
  });
});

/* ── rows are total; the draft is not ───────────────────────────────── */

describe('fieldRows and draftOf', () => {
  it('renders a row for every writable key, in GROUPS order', () => {
    const rows = fieldRows(wholePayload());
    expect(rows.map((r) => r.key).sort()).toEqual([...WRITABLE_KEYS].sort());
    const seen = rows.map((r) => FIELDS[r.key].group);
    const order = seen.map((g) => GROUPS.indexOf(g));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('still renders the row when the daemon answered no such key', () => {
    const partial = { ...wholePayload() };
    delete (partial as Record<string, unknown>)['send.undoGraceSeconds'];
    const rows = fieldRows(partial);
    expect(rows).toHaveLength(11);
    const row = rows.find((r) => r.key === 'send.undoGraceSeconds');
    expect(row?.entry).toBeNull();
    // …and the draft does NOT invent a value for it.
    expect('send.undoGraceSeconds' in draftOf(partial)).toBe(false);
  });

  it('drops an entry whose value contradicts its own declared type', () => {
    const wrong: SettingsPayload = {
      ...wholePayload(),
      'send.retryAsSms': { ...boolEntry(false), value: 7 },
      'send.undoGraceSeconds': { ...intEntry(5, 0, 600), value: 'soon' },
    };
    const draft = draftOf(wrong);
    expect('send.retryAsSms' in draft).toBe(false);
    expect('send.undoGraceSeconds' in draft).toBe(false);
    expect(draft['send.capContactPerHour']).toBe(5);
  });

  it('ignores keys the screen does not own, read-only ones included', () => {
    const draft = draftOf({
      ...wholePayload(),
      'send.somethingNewer': intEntry(3, 1, 9),
    });
    expect(Object.keys(draft).sort()).toEqual([...WRITABLE_KEYS].sort());
  });

  it('turns one edit into a one-key patch, through the shared form kit', () => {
    const form = formOf(draftOf(wholePayload()));
    const edited = editForm(form, 'send.capContactPerHour' as WritableKey, 42);
    expect(formPatch(edited)).toEqual({ 'send.capContactPerHour': 42 });
    // An edit back to where it started is not a write.
    expect(formPatch(editForm(edited, 'send.capContactPerHour', 5))).toEqual(
      {},
    );
  });
});

/* ── the read-only four point somewhere ─────────────────────────────── */

describe('pointerRows', () => {
  it('renders four rows and repeats the daemon route each one names', () => {
    const rows = pointerRows(wholePayload());
    expect(rows.map((r) => r.key).sort()).toEqual([...READ_ONLY_KEYS].sort());
    const pause = rows.find((r) => r.key === 'arming.pauseUntil');
    expect(pause?.use).toBe('POST /v1/toggles/pause');
    expect(rows.find((r) => r.key === 'send.killSwitch')?.use).toBe(
      'POST /v1/toggles/kill-switch',
    );
  });

  it('spells a value that is not set rather than showing a blank cell', () => {
    const rows = pointerRows(wholePayload());
    expect(rows.find((r) => r.key === 'arming.pauseUntil')?.value).toBe(
      'UNSET',
    );
    expect(rows.find((r) => r.key === 'send.killSwitch')?.value).toBe('OFF');
    expect(rows.find((r) => r.key === 'send.globalMode')?.value).toBe(
      'DRAFT-ONLY',
    );
  });

  it('survives a key the daemon did not answer', () => {
    const partial = { ...wholePayload() };
    delete (partial as Record<string, unknown>)['send.circuitOpenedAt'];
    const rows = pointerRows(partial);
    expect(rows).toHaveLength(4);
    const row = rows.find((r) => r.key === 'send.circuitOpenedAt');
    expect(row?.value).toBe('UNSET');
    expect(row?.use).toBe('');
  });
});

/* ── the horizon, without a clock and without a tick ────────────────── */

describe('pauseHorizon', () => {
  it('formats the daemon own instant, to the minute', () => {
    expect(pauseHorizon('2026-09-06T14:30:00.000Z')).toBe(
      'PAUSED UNTIL 2026-09-06 14:30Z',
    );
  });

  it('says NOT PAUSED for an absent horizon', () => {
    expect(pauseHorizon(null)).toBe('NOT PAUSED');
    expect(pauseHorizon(undefined)).toBe('NOT PAUSED');
    expect(pauseHorizon('')).toBe('NOT PAUSED');
  });

  it('repeats a value it cannot parse rather than guessing at one', () => {
    expect(pauseHorizon('later')).toBe('PAUSED UNTIL later');
    expect(pauseHorizon(1757168400000)).toBe('PAUSED UNTIL 1757168400000');
  });

  it('is a function of its argument and of nothing else', () => {
    const once = pauseHorizon('2026-09-06T14:30:00.000Z');
    const twice = pauseHorizon('2026-09-06T14:30:00.000Z');
    expect(once).toBe(twice);
  });
});

/* ── the refusal, in the daemon's own names and numbers ─────────────── */

describe('settingsIssue', () => {
  it('renders all five refusals, each carrying its own datum', () => {
    expect(settingsIssue({ error: 'unknown-key', key: 'send.nope' })).toEqual({
      path: 'send.nope',
      message: 'unknown-key',
    });
    expect(
      settingsIssue({
        error: 'read-only-key',
        key: 'arming.pauseUntil',
        use: 'POST /v1/toggles/pause',
      }),
    ).toEqual({
      path: 'arming.pauseUntil',
      message: 'read-only-key: use POST /v1/toggles/pause',
    });
    expect(
      settingsIssue({
        error: 'wrong-type',
        key: 'send.retryAsSms',
        expected: 'bool',
      }),
    ).toEqual({
      path: 'send.retryAsSms',
      message: 'wrong-type: expected bool',
    });
    expect(
      settingsIssue({
        error: 'below-floor',
        key: 'send.capContactPerHour',
        floor: 1,
      }),
    ).toEqual({
      path: 'send.capContactPerHour',
      message: 'below-floor: floor is 1',
    });
    expect(
      settingsIssue({
        error: 'above-ceiling',
        key: 'send.capContactPerHour',
        ceiling: 600,
      }),
    ).toEqual({
      path: 'send.capContactPerHour',
      message: 'above-ceiling: ceiling is 600',
    });
  });

  it('lands on the field it names, through the shared FIRST-WINS map', () => {
    const issue = settingsIssue({
      error: 'below-floor',
      key: 'send.capGlobalPerHour',
      floor: 1,
    });
    const map = issuesByPath([issue]);
    expect(map.get('send.capGlobalPerHour')).toBe('below-floor: floor is 1');
    expect(map.get('send.capContactPerHour')).toBeUndefined();
  });
});

describe('settingsRefusalOf', () => {
  /** How a 400 body reaches the renderer: wrapped twice, verbatim inside. */
  function overTheBridge(body: string): Error {
    return new Error(
      `Error invoking remote method 'wm:settingsWrite': Error: daemon request failed (HTTP 400): ${body}`,
    );
  }

  it('cuts the refusal back out of a doubly wrapped Error', () => {
    expect(
      settingsRefusalOf(
        overTheBridge(
          '{"error":"below-floor","key":"send.undoGraceSeconds","floor":0}',
        ),
      ),
    ).toEqual({
      error: 'below-floor',
      key: 'send.undoGraceSeconds',
      floor: 0,
    });
  });

  it('returns nothing for a body that names no key', () => {
    // `invalid-settings` says the body was not a patch at all, and inventing
    // a key for it would send an operator hunting for one they never sent.
    expect(
      settingsRefusalOf(
        overTheBridge('{"error":"invalid-settings","detail":{"issues":[]}}'),
      ),
    ).toBeNull();
  });

  it('returns nothing for an error that is not a refusal at all', () => {
    expect(settingsRefusalOf(overTheBridge('not json'))).toBeNull();
    expect(settingsRefusalOf(new Error('daemon unreachable'))).toBeNull();
    expect(settingsRefusalOf(undefined)).toBeNull();
    expect(
      settingsRefusalOf(overTheBridge('{"error":"teapot","key":"send.x"}')),
    ).toBeNull();
  });
});

/* ── the Permissions pane, and the state that is not a state ────────── */

describe('permissionCards', () => {
  const PROBED_AT = '2026-09-06T14:00:00.000Z';

  function report(
    checks: DoctorReportPayload['checks'],
    state: DoctorReportPayload['state'] = 'fully-connected',
  ): DoctorReportPayload {
    return { state, checks, probedAt: PROBED_AT };
  }

  it('has four states and a distinct glyph for each', () => {
    expect([...CARD_STATES]).toEqual(['OK', 'WARN', 'FAIL', NOT_CHECKED]);
    const glyphs = CARD_STATES.map((s) => CARD_GLYPH[s]);
    expect(new Set(glyphs).size).toBe(CARD_STATES.length);
    // The glyph set is the closed one `derive/state.ts` already teaches.
    for (const glyph of glyphs) expect('●◐⊘◌').toContain(glyph);
  });

  it('is total over the daemon four ids, in the order it probes them', () => {
    expect([...CHECK_IDS]).toEqual(['os', 'fda', 'automation', 'messages']);
    const cards = permissionCards(
      report([
        { id: 'os', status: 'ok' },
        { id: 'fda', status: 'ok' },
        { id: 'automation', status: 'ok' },
        { id: 'messages', status: 'ok' },
      ]),
    );
    expect(cards.map((c) => c.id)).toEqual([...CHECK_IDS]);
    expect(cards.map((c) => c.state)).toEqual(['OK', 'OK', 'OK', 'OK']);
  });

  it('reports NOT CHECKED for every id the short circuit never reached', () => {
    // The real shape of an FDA denial: `evaluateDoctor` returns two checks
    // and never probes Automation or Messages at all.
    const cards = permissionCards(
      report(
        [
          { id: 'os', status: 'ok', detail: 'schema verified' },
          { id: 'fda', status: 'fail', remediation: 'grant Full Disk Access' },
        ],
        'disconnected',
      ),
    );
    expect(cards.map((c) => c.state)).toEqual([
      'OK',
      'FAIL',
      NOT_CHECKED,
      NOT_CHECKED,
    ]);
    expect(cards[1]?.detail).toBe('grant Full Disk Access');
    expect(cards[2]?.detail.length).toBeGreaterThan(0);
  });

  it('keeps the granted-but-the-file-moved case distinct from a denial', () => {
    const cards = permissionCards(
      report(
        [
          { id: 'os', status: 'ok' },
          {
            id: 'fda',
            status: 'warn',
            remediation: 'No Messages history found at the chat.db path',
          },
        ],
        'read-only',
      ),
    );
    const fda = cards.find((c) => c.id === 'fda');
    expect(fda?.state).toBe('WARN');
    expect(fda?.glyph).toBe(CARD_GLYPH.WARN);
    expect(fda?.state).not.toBe('FAIL');
    expect(fda?.detail).toContain('chat.db');
  });

  it('renders NOT CHECKED, never a grant, when the report itself failed', () => {
    const cards = permissionCards(null);
    expect(cards).toHaveLength(4);
    expect(cards.map((c) => c.state)).toEqual([
      NOT_CHECKED,
      NOT_CHECKED,
      NOT_CHECKED,
      NOT_CHECKED,
    ]);
    for (const card of cards) {
      expect(card.glyph).toBe(CARD_GLYPH[NOT_CHECKED]);
      expect(card.detail.length).toBeGreaterThan(0);
    }
  });

  it('refuses a status it does not recognise rather than passing it', () => {
    const cards = permissionCards(
      report([
        { id: 'os', status: 'granted' },
        { id: 'fda', status: '' },
      ] as unknown as DoctorReportPayload['checks']),
    );
    expect(cards[0]?.state).toBe(NOT_CHECKED);
    expect(cards[1]?.state).toBe(NOT_CHECKED);
  });

  it('ignores a check id the daemon never declared', () => {
    const cards = permissionCards(
      report([
        { id: 'os', status: 'ok' },
        { id: 'icloud', status: 'ok' },
      ] as unknown as DoctorReportPayload['checks']),
    );
    expect(cards).toHaveLength(4);
    expect(cards.map((c) => c.id)).toEqual([...CHECK_IDS]);
  });

  it('takes the FIRST answer for a repeated id, never the friendlier one', () => {
    const cards = permissionCards(
      report([
        { id: 'os', status: 'ok' },
        { id: 'fda', status: 'fail', remediation: 'grant it' },
        { id: 'fda', status: 'ok' },
      ]),
    );
    expect(cards.find((c) => c.id === 'fda')?.state).toBe('FAIL');
  });
});

/* ── remedy is a NAME main already knows, never a URL ───────────────── */

describe('the remedy a card offers', () => {
  it('names a pane on main own allowlist, or names none at all', () => {
    for (const id of CHECK_IDS) {
      const pane = CARD_PANE[id];
      if (pane === null) continue;
      expect(
        Object.prototype.hasOwnProperty.call(SYSTEM_SETTINGS_PANES, pane),
        `${id} -> ${pane}`,
      ).toBe(true);
    }
  });

  it('offers a pane exactly where macOS has one to offer', () => {
    // `os` is a macOS VERSION, and `messages` is an application that is
    // running or is not. Neither is a grant, and neither has a pane: a
    // GRANT NOW button beside them would open a window that says nothing
    // about the thing that failed.
    expect(CARD_PANE.os).toBeNull();
    expect(CARD_PANE.messages).toBeNull();
    expect(CARD_PANE.fda).toBe('fullDisk');
    expect(CARD_PANE.automation).toBe('automation');
  });

  it('carries the pane through to the card the operator sees', () => {
    const cards = permissionCards({
      state: 'read-only',
      checks: [
        { id: 'os', status: 'ok' },
        { id: 'fda', status: 'ok' },
        { id: 'automation', status: 'fail', remediation: 'approve it' },
      ],
      probedAt: '2026-09-06T14:00:00.000Z',
    });
    expect(cards.find((c) => c.id === 'automation')?.pane).toBe('automation');
    expect(cards.find((c) => c.id === 'os')?.pane).toBeNull();
  });
});
