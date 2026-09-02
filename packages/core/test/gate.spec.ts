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
import type { GateContext, Store } from '@wemessage/core';
import {
  evaluateGate,
  readGateSettings,
  SETTING_ALLOW_SMS_AUTO,
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
      contactAutoLastHour: 0,
      globalAutoLastHour: 0,
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
  it('all four keys set: reflects them verbatim', () => {
    const store = fakeSettingsStore({
      [SETTING_KILL_SWITCH]: '1',
      [SETTING_GLOBAL_MODE]: 'auto',
      [SETTING_CONNECTION_STATE]: 'fully-connected',
      [SETTING_ALLOW_SMS_AUTO]: '1',
    });
    expect(readGateSettings(store)).toEqual({
      killSwitch: true,
      globalMode: 'auto',
      connectionState: 'fully-connected',
      allowSmsAuto: true,
    });
  });

  it('all four keys unset: fail-safe defaults (killSwitch false, draft-only, disconnected, allowSmsAuto false)', () => {
    const store = fakeSettingsStore({});
    expect(readGateSettings(store)).toEqual({
      killSwitch: false,
      globalMode: 'draft-only',
      connectionState: 'disconnected',
      allowSmsAuto: false,
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
