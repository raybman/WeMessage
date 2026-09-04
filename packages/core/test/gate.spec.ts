/**
 * s3-execution.md Part 2 Scenario 6 — Gate v0 + `dispatchApproved`: INV-2
 * becomes code. This file covers `evaluateGate` + `readGateSettings`
 * (`packages/core/src/gate/index.ts`) in isolation; `dispatcher.spec.ts`
 * covers `dispatchApproved` end to end.
 *
 * Pure core, no I/O: `evaluateGate` is a plain function over `GateContext`;
 * `readGateSettings` is exercised against a tiny fake `Store` (object
 * literal, only `getSetting` implemented — matches domain-types.spec.ts's
 * fake-port convention).
 */
import { describe, expect, it } from 'vitest';
import type { ContactPolicy, GateContext, Store } from '@wemessage/core';
import {
  DEFAULT_RATE_CAPS,
  evaluateGate,
  readGateSettings,
  SETTING_ALLOW_SMS_AUTO,
  SETTING_CAP_CONTACT_PER_2MIN,
  SETTING_CAP_CONTACT_PER_HOUR,
  SETTING_CAP_GLOBAL_PER_HOUR,
  SETTING_CONNECTION_STATE,
  SETTING_GLOBAL_MODE,
  SETTING_KILL_SWITCH,
} from '@wemessage/core';

const NOW = '2026-09-01T12:00:00.000Z';

function baseCtx(overrides: Partial<GateContext['settings']>): GateContext {
  return {
    now: NOW,
    settings: {
      killSwitch: false,
      globalMode: 'draft-only',
      connectionState: 'fully-connected',
      allowSmsAuto: false,
      ...overrides,
    },
    rule: null,
    schedule: null,
    contact: null,
    message: {
      isGroup: false,
      service: 'imessage',
      handle: '+15551234567',
      chatGuid: 'iMessage;-;+15551234567',
    },
    counters: {
      contactAutoLast2Min: 0,
      contactAutoLastHour: 0,
      globalSentLastHour: 0,
      consecutiveAutoInChat: 0,
      circuitOpen: false,
    },
  };
}

function fakeSettingsStore(
  values: Record<string, string>,
): Pick<Store, 'getSetting'> {
  return { getSetting: (key: string) => values[key] ?? null };
}

describe('evaluateGate (s3 Scenario 6, gate v0)', () => {
  it.each([
    ['killSwitch true' as const, { killSwitch: true }, 'kill-switch' as const],
    [
      'connectionState disconnected' as const,
      { connectionState: 'disconnected' as const },
      'disconnected' as const,
    ],
    [
      'connectionState read-only' as const,
      { connectionState: 'read-only' as const },
      'read-only' as const,
    ],
  ])('%s -> deny (%s)', (_label, overrides, reason) => {
    const decision = evaluateGate(baseCtx(overrides));
    expect(decision).toEqual({ allow: false, reason });
  });

  it('baseline: no deny conditions -> allow at globalMode', () => {
    const decision = evaluateGate(baseCtx({ globalMode: 'auto' }));
    expect(decision).toEqual({ allow: true, mode: 'auto' });
  });

  it('kill-switch outranks a simultaneous disconnected state', () => {
    const decision = evaluateGate(
      baseCtx({ killSwitch: true, connectionState: 'disconnected' }),
    );
    expect(decision).toEqual({ allow: false, reason: 'kill-switch' });
  });

  it('v0 pin: human actor + null contact, otherwise-passing settings -> allow (v0 does not check contact policy)', () => {
    const ctx = baseCtx({});
    expect(ctx.contact).toBeNull();
    const decision = evaluateGate(ctx);
    expect(decision).toEqual({ allow: true, mode: 'draft-only' });
  });
});

describe('readGateSettings (s3 Scenario 6)', () => {
  // s6 Scenario 6 widened this function from four keys to seven: the three
  // rate caps are settings and are read where the other settings are read,
  // so an operator's raise takes effect at every gate call site at once
  // rather than at whichever one remembered to look.
  it('every key it reads, set: reflected verbatim', () => {
    const store = fakeSettingsStore({
      [SETTING_KILL_SWITCH]: '1',
      [SETTING_GLOBAL_MODE]: 'auto',
      [SETTING_CONNECTION_STATE]: 'fully-connected',
      [SETTING_ALLOW_SMS_AUTO]: '1',
      [SETTING_CAP_CONTACT_PER_2MIN]: '5',
      [SETTING_CAP_CONTACT_PER_HOUR]: '20',
      [SETTING_CAP_GLOBAL_PER_HOUR]: '60',
    });
    expect(readGateSettings(store)).toEqual({
      killSwitch: true,
      globalMode: 'auto',
      connectionState: 'fully-connected',
      allowSmsAuto: true,
      caps: { contactPer2Min: 5, contactPerHour: 20, globalPerHour: 60 },
    });
  });

  it('every key unset: fail-safe defaults (killSwitch false, draft-only, disconnected, allowSmsAuto false, caps at their shipped values)', () => {
    const store = fakeSettingsStore({});
    expect(readGateSettings(store)).toEqual({
      killSwitch: false,
      globalMode: 'draft-only',
      connectionState: 'disconnected',
      allowSmsAuto: false,
      // Note the direction: unset caps are NOT "unlimited". Fail-safe for a
      // cap means the shipped bound applies (F-66).
      caps: DEFAULT_RATE_CAPS,
    });
  });

  it('unrecognized globalMode/connectionState values fall back to the fail-safe default, not throw', () => {
    const store = fakeSettingsStore({
      [SETTING_GLOBAL_MODE]: 'bogus',
      [SETTING_CONNECTION_STATE]: 'bogus',
    });
    expect(readGateSettings(store)).toEqual({
      killSwitch: false,
      globalMode: 'draft-only',
      connectionState: 'disconnected',
      allowSmsAuto: false,
      caps: DEFAULT_RATE_CAPS,
    });
  });

  it('killSwitch/allowSmsAuto "0" parses as false explicitly (not just via fallback)', () => {
    const store = fakeSettingsStore({
      [SETTING_KILL_SWITCH]: '0',
      [SETTING_ALLOW_SMS_AUTO]: '0',
    });
    const settings = readGateSettings(store);
    expect(settings.killSwitch).toBe(false);
    expect(settings.allowSmsAuto).toBe(false);
  });
});

/**
 * s4-execution.md Part 2 Scenario 4 — gate v1. Adds the §2.4.3 contact
 * ladder and the INV-5 group clamp on top of v0's three settings deny rules.
 * Everything above stays exactly as v0 wrote it: these are additions, and
 * the v0 blocks are the regression proof that nothing shrank.
 *
 * Teeth: skip the contact check when mode is 'deny' -> the deny row fails;
 * drop the group clamp -> the INV-5 row fails.
 */
function v1Ctx(overrides: Partial<GateContext>): GateContext {
  return { ...baseCtx({}), ...overrides };
}

const RULE = {
  id: 'r1',
  name: 'r1',
  enabled: true,
  matcher: { kind: 'keyword' as const, keywords: ['x'], mode: 'any' as const },
  adapterId: 'echo',
  respondMode: 'auto' as const,
  scheduleId: null,
  outsideWindow: 'queue' as const,
  allowGroupDrafts: true,
  matchAttachmentOnly: false,
  draftTtlMinutes: 240,
  priority: 100,
  createdAt: NOW,
  updatedAt: NOW,
};

function policy(mode: 'deny' | 'draft-only' | 'auto'): ContactPolicy {
  return { handle: '+15551234567', mode, updatedAt: NOW };
}

describe('evaluateGate (s4 Scenario 4, gate v1)', () => {
  describe('deny order: kill > disconnected > read-only > contact', () => {
    it('kill-switch DOMINATES an otherwise fully-auto contact', () => {
      expect(
        evaluateGate(
          v1Ctx({
            settings: {
              killSwitch: true,
              globalMode: 'auto',
              connectionState: 'fully-connected',
              allowSmsAuto: true,
            },
            rule: RULE,
            contact: policy('auto'),
          }),
        ),
      ).toEqual({ allow: false, reason: 'kill-switch' });
    });

    it('disconnected outranks a denied contact', () => {
      expect(
        evaluateGate(
          v1Ctx({
            settings: {
              killSwitch: false,
              globalMode: 'auto',
              connectionState: 'disconnected',
              allowSmsAuto: false,
            },
            rule: RULE,
            contact: policy('deny'),
          }),
        ),
      ).toEqual({ allow: false, reason: 'disconnected' });
    });

    it('read-only outranks a denied contact', () => {
      expect(
        evaluateGate(
          v1Ctx({
            settings: {
              killSwitch: false,
              globalMode: 'auto',
              connectionState: 'read-only',
              allowSmsAuto: false,
            },
            rule: RULE,
            contact: policy('deny'),
          }),
        ),
      ).toEqual({ allow: false, reason: 'read-only' });
    });
  });

  describe('contact ladder (rule-driven traffic only)', () => {
    it('rule + UNKNOWN contact -> contact-denied (§1.3.5 deny-all default)', () => {
      expect(evaluateGate(v1Ctx({ rule: RULE, contact: null }))).toEqual({
        allow: false,
        reason: 'contact-denied',
      });
    });

    it("rule + mode 'deny' -> contact-denied", () => {
      expect(
        evaluateGate(v1Ctx({ rule: RULE, contact: policy('deny') })),
      ).toEqual({ allow: false, reason: 'contact-denied' });
    });

    it("rule + 'draft-only' contact CLAMPS an auto global (most restrictive)", () => {
      expect(
        evaluateGate(
          v1Ctx({
            settings: {
              killSwitch: false,
              globalMode: 'auto',
              connectionState: 'fully-connected',
              allowSmsAuto: false,
            },
            rule: RULE,
            contact: policy('draft-only'),
          }),
        ),
      ).toEqual({ allow: true, mode: 'draft-only' });
    });

    it("rule + 'auto' contact + auto global -> auto (both must agree)", () => {
      expect(
        evaluateGate(
          v1Ctx({
            settings: {
              killSwitch: false,
              globalMode: 'auto',
              connectionState: 'fully-connected',
              allowSmsAuto: false,
            },
            rule: RULE,
            contact: policy('auto'),
          }),
        ),
      ).toEqual({ allow: true, mode: 'auto' });
    });

    it("rule + 'auto' contact + draft-only global -> draft-only (global clamps too)", () => {
      expect(
        evaluateGate(v1Ctx({ rule: RULE, contact: policy('auto') })),
      ).toEqual({ allow: true, mode: 'draft-only' });
    });
  });

  describe('human pin (F-20, v0 behavior preserved verbatim)', () => {
    it('rule null + contact null -> ALLOW, not contact-denied', () => {
      expect(evaluateGate(v1Ctx({ rule: null, contact: null }))).toEqual({
        allow: true,
        mode: 'draft-only',
      });
    });

    it('a human at an auto global still gets auto with no contact policy at all', () => {
      // The ladder is gated on rule !== null: a hand-written first message to
      // a brand-new number must not be blocked by the deny-all default.
      expect(
        evaluateGate(
          v1Ctx({
            settings: {
              killSwitch: false,
              globalMode: 'auto',
              connectionState: 'fully-connected',
              allowSmsAuto: false,
            },
            rule: null,
            contact: null,
          }),
        ),
      ).toEqual({ allow: true, mode: 'auto' });
    });

    it('rule null IGNORES even an explicit deny policy (ladder not consulted)', () => {
      expect(
        evaluateGate(v1Ctx({ rule: null, contact: policy('deny') })),
      ).toEqual({ allow: true, mode: 'draft-only' });
    });
  });

  describe('group clamp (INV-5)', () => {
    it('everything-auto in a GROUP still resolves to draft-only, never auto', () => {
      expect(
        evaluateGate(
          v1Ctx({
            settings: {
              killSwitch: false,
              globalMode: 'auto',
              connectionState: 'fully-connected',
              allowSmsAuto: true,
            },
            rule: RULE,
            contact: policy('auto'),
            message: {
              isGroup: true,
              service: 'imessage',
              handle: '',
              chatGuid: 'iMessage;+;chat123456789',
            },
          }),
        ),
      ).toEqual({ allow: true, mode: 'draft-only' });
    });

    it('the clamp is a MODE clamp, not a deny: the group draft is still allowed', () => {
      const decision = evaluateGate(
        v1Ctx({
          message: {
            isGroup: true,
            service: 'imessage',
            handle: '',
            chatGuid: 'iMessage;+;chat123456789',
          },
        }),
      );
      expect(decision.allow).toBe(true);
    });

    it('a group with a DENIED contact still denies (deny outranks the clamp)', () => {
      expect(
        evaluateGate(
          v1Ctx({
            rule: RULE,
            contact: policy('deny'),
            message: {
              isGroup: true,
              service: 'imessage',
              handle: '',
              chatGuid: 'iMessage;+;chat123456789',
            },
          }),
        ),
      ).toEqual({ allow: false, reason: 'contact-denied' });
    });
  });

  /*
   * RETIRED — s6-execution Scenario 4, row 7 (named revision).
   *
   * This block used to hold `schedules and counters remain UNCONSULTED
   * (hostile values change nothing)`. Half of its claim became false in
   * Scenario 4: `evaluateGate` now reads the schedule of a rule that names
   * one and clamps autonomy when that window is shut (F-63/F-64), so a row
   * asserting that schedules are never consulted is asserting the absence of
   * a feature this slice exists to add. It passed on the day it was deleted
   * only because its fixture rule carries `scheduleId: null` — i.e. for a
   * reason unrelated to what it claimed — which is precisely the kind of
   * false comfort a retired test should not keep providing.
   *
   * The surviving half of the claim is not lost. `counters` and the circuit
   * ARE still unread, and `scope-resolution.spec.ts ›
   * what this scenario deliberately still does NOT read` now pins that with
   * the same hostile values, alongside the positive rows for the schedule
   * behaviour that replaced it. Sc 6/7/8 retire those lines one at a time as
   * each field is claimed.
   *
   * Recorded here rather than deleted silently: retiring a passing test is
   * the kind of thing that gets done quietly, and the spec named it in
   * advance so that it could not be.
   */
});
