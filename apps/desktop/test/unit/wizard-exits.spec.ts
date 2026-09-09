import { describe, expect, it } from 'vitest';

import type { DoctorReportPayload } from '@wemessage/client';
import {
  CARD_GLYPH,
  CARD_STATES,
  CHECK_IDS,
  NOT_CHECKED,
} from '../../src/renderer/derive/permissionCards.js';
import { WIZARD_STEPS } from '../../src/renderer/router.js';
import {
  NOT_CHECKED_EXIT,
  STEP_CHECKS,
  STEP_TITLE,
  VERDICT_RANK,
  WIZARD_EXITS,
  WIZARD_EXIT_SPEC,
  exitFor,
  exitView,
  progressLine,
  readyToFinish,
  stepVerdict,
  worstOf,
} from '../../src/renderer/derive/wizardExits.js';

/**
 * Scenario 15 — the exit-state vocabulary.
 *
 * The wizard's whole claim is that it cannot render a reassuring screen for a
 * state nobody checked. That claim rests on this module being TOTAL over two
 * unions it does not own: the link's `DownReason` (minted in `main/policy.ts`)
 * and the daemon's `ConnectionState` (minted in `@wemessage/client` and
 * enforced by the daemon itself). Totality is a compile-time property here —
 * `Readonly<Record<WizardExit, ExitSpec>>` over a template-literal union
 * rejects both a missing key and an extra one — and these rows check the
 * runtime shadow of it, plus the trichotomy that the rest of the slice keeps
 * proving matters: VERIFIED GOOD vs NOT YET CHECKED vs CHECKED AND FAILED.
 */
describe('wizard exit states (Scenario 15)', () => {
  const report = (state: string): DoctorReportPayload =>
    ({
      state,
      checks: [],
      probedAt: '2026-03-02T18:00:00.000Z',
    }) as unknown as DoctorReportPayload;

  const UP = { state: 'connected', reason: null } as const;

  it('enumerates exactly the eight exits its two upstream unions imply', () => {
    // Not a hand-written list: `WIZARD_EXITS` is `Object.keys` of the spec,
    // and the spec's key type is `link:${DownReason} | daemon:${ConnectionState}`.
    // A fifth `DownReason` upstream is a COMPILE error here, not a silent gap.
    expect([...WIZARD_EXITS].sort()).toEqual([
      'daemon:disconnected',
      'daemon:fully-connected',
      'daemon:read-only',
      'daemon:unsupported',
      'link:no-token',
      'link:stream-refused',
      'link:token-rejected',
      'link:unreachable',
    ]);
    expect(WIZARD_EXITS.length).toBe(Object.keys(WIZARD_EXIT_SPEC).length);
  });

  it('never spells a state the shared permission vocabulary does not have', () => {
    // Sc14 minted OK / WARN / FAIL / NOT CHECKED. The wizard REUSES them; it
    // does not get a second vocabulary. And no exit may claim NOT CHECKED:
    // an exit is by construction a check that answered.
    for (const exit of WIZARD_EXITS) {
      const spec = WIZARD_EXIT_SPEC[exit];
      expect(CARD_STATES, exit).toContain(spec.state);
      expect(spec.state, exit).not.toBe(NOT_CHECKED);
      expect(spec.word, exit).toBe(spec.word.toUpperCase());
      expect(spec.word.length, exit).toBeGreaterThan(0);
      expect(spec.title.length, exit).toBeGreaterThan(0);
      expect(spec.detail.length, exit).toBeGreaterThan(0);
    }
  });

  it('lets exactly one exit claim the product is ready, and it is the daemon’s', () => {
    const ready = WIZARD_EXITS.filter((e) => WIZARD_EXIT_SPEC[e].ready);
    expect(ready).toEqual(['daemon:fully-connected']);
    // `connected` is not a member of the vocabulary; `fully-connected` is.
    expect(WIZARD_EXITS).not.toContain('daemon:connected');
    expect(readyToFinish(null)).toBe(false);
    for (const exit of WIZARD_EXITS) {
      expect(readyToFinish(exit), exit).toBe(exit === 'daemon:fully-connected');
    }
  });

  it('reads every glyph out of the closed permission-card set', () => {
    const closed = new Set(Object.values(CARD_GLYPH));
    for (const exit of WIZARD_EXITS) {
      expect(closed, exit).toContain(exitView(exit).glyph);
    }
    expect(exitView(null).glyph).toBe(CARD_GLYPH[NOT_CHECKED]);
  });

  it('maps a down link to its reason and never past the union', () => {
    for (const exit of WIZARD_EXITS.filter((e) => e.startsWith('link:'))) {
      const reason = exit.slice('link:'.length);
      expect(exitFor({ state: 'down', reason }, null)).toBe(exit);
      // A report cannot outrank a dead link: there is no daemon to ask.
      expect(
        exitFor({ state: 'down', reason }, report('fully-connected')),
      ).toBe(exit);
    }
    // `auth` is the reason the S8 plan names. It does not exist.
    expect(exitFor({ state: 'down', reason: 'auth' }, null)).toBeNull();
    expect(exitFor({ state: 'down', reason: null }, null)).toBeNull();
  });

  it('maps the daemon’s own verdict, and an unknown verdict to NOT CHECKED', () => {
    for (const exit of WIZARD_EXITS.filter((e) => e.startsWith('daemon:'))) {
      const state = exit.slice('daemon:'.length);
      expect(exitFor(UP, report(state))).toBe(exit);
    }
    // The wire is narrowed by `typeof === 'string'` upstream, so a daemon
    // that grows a fifth state reaches this function as an unknown word.
    // NOT CHECKED, never a fabricated key and never a reassuring default.
    expect(exitFor(UP, report('connected'))).toBeNull();
    expect(exitFor(UP, report('ok'))).toBeNull();
    expect(exitFor(UP, report(''))).toBeNull();
    // No report at all is the same answer: nobody has checked yet.
    expect(exitFor(UP, null)).toBeNull();
    expect(exitFor({ state: 'reconnecting', reason: null }, null)).toBeNull();
  });

  it('renders NOT CHECKED as its own datum rather than as an absent one', () => {
    const view = exitView(null);
    expect(view.exit).toBe(NOT_CHECKED_EXIT);
    expect(NOT_CHECKED_EXIT).toBe('not-checked');
    expect(view.state).toBe(NOT_CHECKED);
    expect(view.word).toBe(NOT_CHECKED);
    expect(view.ready).toBe(false);
    expect(view.detail.length).toBeGreaterThan(0);
    // The accumulator the e2e reads is never empty, so a step that rendered
    // nothing cannot be mistaken for a step that passed.
    for (const exit of WIZARD_EXITS) {
      expect(exitView(exit).exit, exit).toBe(exit);
    }
  });

  it('surfaces every doctor check on exactly one step', () => {
    // Totality the other way: the wizard cannot quietly drop a check the
    // daemon reports. `CHECK_IDS` is Sc14's projection of the daemon's own
    // `DoctorCheckPayload['id']` union.
    const seen = WIZARD_STEPS.flatMap((step) => [...STEP_CHECKS[step]]);
    expect([...seen].sort()).toEqual([...CHECK_IDS].sort());
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('ranks an unchecked step below a warned one and above nothing', () => {
    expect(VERDICT_RANK['FAIL']).toBeGreaterThan(VERDICT_RANK[NOT_CHECKED]);
    expect(VERDICT_RANK[NOT_CHECKED]).toBeGreaterThan(VERDICT_RANK['WARN']);
    expect(VERDICT_RANK['WARN']).toBeGreaterThan(VERDICT_RANK['OK']);
    expect(worstOf([])).toBe('OK');
    expect(worstOf(['OK', 'WARN'])).toBe('WARN');
    expect(worstOf(['OK', NOT_CHECKED, 'WARN'])).toBe(NOT_CHECKED);
    expect(worstOf(['FAIL', NOT_CHECKED])).toBe('FAIL');
  });

  it('refuses to call a step good until its own checks have answered', () => {
    // This is the teeth. With no report in hand every step that owns a check
    // reads NOT CHECKED, which is what keeps CONTINUE inert on first paint.
    expect(stepVerdict('welcome', null)).toBe(NOT_CHECKED);
    expect(stepVerdict('full-disk', null)).toBe(NOT_CHECKED);
    expect(stepVerdict('automation', null)).toBe(NOT_CHECKED);

    const short = {
      state: 'disconnected',
      checks: [
        { id: 'os', status: 'ok' },
        { id: 'fda', status: 'fail' },
      ],
      probedAt: '2026-03-02T18:00:00.000Z',
    } as unknown as DoctorReportPayload;
    // `evaluateDoctor` short-circuits on an fda failure: `automation` and
    // `messages` are never probed, so they are NOT CHECKED and must not be
    // rendered as anything friendlier.
    expect(stepVerdict('full-disk', short)).toBe('FAIL');
    expect(stepVerdict('automation', short)).toBe(NOT_CHECKED);
    expect(stepVerdict('welcome', short)).toBe(NOT_CHECKED);

    const all = {
      state: 'fully-connected',
      checks: CHECK_IDS.map((id) => ({ id, status: 'ok' })),
      probedAt: '2026-03-02T18:00:00.000Z',
    } as unknown as DoctorReportPayload;
    for (const step of WIZARD_STEPS) {
      expect(stepVerdict(step, all), step).toBe('OK');
    }
    // Steps with no checks of their own are not "unknown"; there is nothing
    // to know. They are gated by the exit, not by a check.
    expect(stepVerdict('optional', null)).toBe('OK');
    expect(stepVerdict('send-test', null)).toBe('OK');
  });

  it('numbers the steps off the router’s list rather than a literal', () => {
    // Six since the s9 Sc7 amendment added `keep-running`. The literal is the
    // whole point of the row: everything below counts off `WIZARD_STEPS`, so
    // without this one line a step could be added or dropped and every other
    // assertion in this file would still agree with itself, loudly.
    expect(WIZARD_STEPS.length).toBe(6);
    WIZARD_STEPS.forEach((step, i) => {
      const line = progressLine(step);
      expect(line, step).toBe(
        `STEP ${String(i + 1)} OF ${String(WIZARD_STEPS.length)} · ${STEP_TITLE[step]}`,
      );
      expect(line, step).toBe(line.toUpperCase());
    });
    for (const step of WIZARD_STEPS) {
      expect(STEP_TITLE[step], step).toBe(STEP_TITLE[step].toUpperCase());
    }
  });
});
