/**
 * v2 A0p: the park (ruling 2026-10-05). A daemon composed WITHOUT an
 * `autonomy` value, which is how `main.ts` composes it in this build, refuses
 * every request that would create or enable auto-send or a schedule, with
 * one fixed 409 body, and writes nothing (no row, no audit) when it does.
 * De-escalation stays open. Handles are synthetic (public repo).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SETTING_GLOBAL_MODE } from '@wemessage/core';
import {
  PARKED_BODY,
  isParked,
  rulePatchArms,
  schedulePatchArms,
} from '../src/park.js';
import {
  auditTypes,
  boot,
  cleanupHarness,
  post,
  type Harness,
} from './helpers/draft-harness.js';

afterEach(cleanupHarness);

const parkedBoot = (): Promise<Harness> =>
  boot({ autonomy: null, rules: true });

const schedule = {
  name: 'front desk hours',
  timezone: 'America/Los_Angeles',
  windows: [{ days: ['mon', 'tue'], start: '09:00', end: '17:00' }],
};

function rule(over: Record<string, unknown> = {}) {
  return {
    name: 'pool keyword',
    matcher: { kind: 'keyword', keywords: ['pool'], mode: 'any' },
    adapterId: 'concierge',
    ...over,
  };
}

async function withAdapter(h: Harness): Promise<void> {
  const res = await post(h, '/v1/adapters', {
    id: 'concierge',
    kind: 'echo',
    displayName: 'concierge',
  });
  expect(res.statusCode).toBe(201);
}

describe('isParked', () => {
  it('only an explicit live lifts the park', () => {
    expect(isParked(undefined)).toBe(true);
    expect(isParked('parked')).toBe(true);
    expect(isParked('live')).toBe(false);
  });
});

describe('a parked daemon refuses escalation over the wire', () => {
  it('POST /v1/schedules is 409 parked and writes nothing', async () => {
    const h = await parkedBoot();
    const before = auditTypes(h.store);
    const res = await post(h, '/v1/schedules', schedule);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual(PARKED_BODY);
    expect(auditTypes(h.store)).toEqual(before);
  });

  it('an auto rule is 409; a draft-only rule is still 201', async () => {
    const h = await parkedBoot();
    await withAdapter(h);
    const before = auditTypes(h.store);
    const auto = await post(h, '/v1/rules', rule({ respondMode: 'auto' }));
    expect(auto.statusCode).toBe(409);
    expect(auto.json()).toEqual(PARKED_BODY);
    expect(auditTypes(h.store)).toEqual(before);
    expect(h.store.listRules()).toEqual([]);

    const draftOnly = await post(
      h,
      '/v1/rules',
      rule({ respondMode: 'draft-only' }),
    );
    expect(draftOnly.statusCode).toBe(201);
  });

  it('global mode auto is 409; draft-only is still allowed', async () => {
    const h = await parkedBoot();
    const before = h.store.getSetting(SETTING_GLOBAL_MODE);
    const auto = await post(h, '/v1/toggles/global-mode', { mode: 'auto' });
    expect(auto.statusCode).toBe(409);
    expect(auto.json()).toEqual(PARKED_BODY);
    expect(h.store.getSetting(SETTING_GLOBAL_MODE)).toBe(before);

    const off = await post(h, '/v1/toggles/global-mode', {
      mode: 'draft-only',
    });
    expect(off.statusCode).toBe(200);
  });

  it('pause rest-of-window has no window to rest out', async () => {
    const h = await parkedBoot();
    const res = await post(h, '/v1/toggles/pause', {
      until: 'rest-of-window',
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('the patch classifiers', () => {
  const off = {
    respondMode: 'draft-only',
    scheduleId: null,
    enabled: false,
  } as const;
  it('rulePatchArms: escalation arms, de-escalation does not', () => {
    expect(rulePatchArms(off, { ...off, respondMode: 'auto' })).toBe(true);
    expect(rulePatchArms(off, { ...off, scheduleId: 'S1' })).toBe(true);
    const storedAuto = {
      respondMode: 'auto',
      scheduleId: null,
      enabled: false,
    } as const;
    expect(rulePatchArms(storedAuto, { ...storedAuto, enabled: true })).toBe(
      true,
    );
    const liveAuto = { ...storedAuto, enabled: true } as const;
    expect(rulePatchArms(liveAuto, { ...liveAuto, enabled: false })).toBe(
      false,
    );
    expect(
      rulePatchArms(liveAuto, { ...liveAuto, respondMode: 'draft-only' }),
    ).toBe(false);
    expect(rulePatchArms(off, { ...off, enabled: true })).toBe(false);
  });

  it('schedulePatchArms: only rename and disable pass', () => {
    expect(schedulePatchArms({ name: 'x' })).toBe(false);
    expect(schedulePatchArms({ enabled: false })).toBe(false);
    expect(schedulePatchArms({ enabled: true })).toBe(true);
    expect(schedulePatchArms({ windows: [] })).toBe(true);
    expect(schedulePatchArms({ timezone: 'UTC' })).toBe(true);
  });
});
