/**
 * Gate v0 (s3-execution Scenario 6, §2.4.1): a minimal `evaluateGate` over
 * three settings-driven deny rules (kill-switch, disconnected, read-only).
 * v0 deliberately does NOT consult rule/schedule/contact/counters — every
 * later slice (S4 rate limits, contact policy, schedules, loop breaker)
 * extends this function; it never shrinks the `GateContext` shape it reads.
 *
 * Settings-key convention (Fable design consult, coordinator-confirmed):
 * dot-namespaced camelCase, matching the s2 precedent
 * 'ingest.mutationWatermarkNs' — NOT a 'settings.*' prefix. Booleans
 * serialize as the strings '1'/'0' (§2.3 `settings` is a flat key/value
 * TEXT table; there is no boolean column type to lean on).
 */
import type { GateContext, GateDecision } from '../domain/types.js';
import type { Store } from '../ports/index.js';

export const SETTING_KILL_SWITCH = 'send.killSwitch';
export const SETTING_GLOBAL_MODE = 'send.globalMode';
/**
 * Minted here in Scenario 6; Scenario 7's doctor engine is specified to
 * write this exact key after each connectivity probe. Do not rename without
 * updating that consumer.
 */
export const SETTING_CONNECTION_STATE = 'connection.state';
/** S6 feature; carried-but-unused in S3 (F-20 — read but never yet set true by any S3 code path). */
export const SETTING_ALLOW_SMS_AUTO = 'send.allowSmsAuto';
/**
 * s3-execution Scenario 7 (Fable design consult): not a probe, a settings
 * key. Default true when unset (matches the pre-existing design-note comment
 * in packages/sendkit/src/applescript.ts referencing this exact key).
 * Governs whether the doctor engine treats "Messages not running" as a
 * warn (gateway will auto-launch on next send) or a fail (read-only).
 */
export const SETTING_AUTO_LAUNCH_MESSAGES = 'send.autoLaunchMessages';
/**
 * s3-execution Scenario 9 (Fable design consult): a user-initiated
 * disconnect latch, distinct from `SETTING_CONNECTION_STATE`. Not consumed
 * by `evaluateGate`/`readGateSettings` (the gate already denies on
 * `connectionState === 'disconnected'`, which the disconnect flow also
 * writes) — this key exists solely so `startDaemon`'s boot sequence can
 * tell "the daemon has never probed" apart from "a human asked to stop,
 * and an unconditional boot-time `runDoctor()` must not silently
 * reconnect them across a restart." Booleans serialize as '1'/'0' per the
 * flat settings-table convention above.
 */
export const SETTING_USER_DISCONNECTED = 'connection.userDisconnected';

function parseBool(raw: string | null, fallback: boolean): boolean {
  if (raw === '1') return true;
  if (raw === '0') return false;
  return fallback;
}

/**
 * Fail-safe defaults on unset/unrecognized values:
 *  - killSwitch unset -> false (a fresh install can send).
 *  - globalMode unset/unrecognized -> 'draft-only' (fail toward human review).
 *  - connectionState unset/unrecognized -> 'disconnected' (a daemon that has
 *    never probed connectivity must not send — fail-closed).
 *  - allowSmsAuto unset -> false.
 */
export function readGateSettings(
  store: Pick<Store, 'getSetting'>,
): GateContext['settings'] {
  const globalModeRaw = store.getSetting(SETTING_GLOBAL_MODE);
  const globalMode = globalModeRaw === 'auto' ? 'auto' : 'draft-only';
  const connectionStateRaw = store.getSetting(SETTING_CONNECTION_STATE);
  const connectionState =
    connectionStateRaw === 'fully-connected' ||
    connectionStateRaw === 'read-only'
      ? connectionStateRaw
      : 'disconnected';
  return {
    killSwitch: parseBool(store.getSetting(SETTING_KILL_SWITCH), false),
    globalMode,
    connectionState,
    allowSmsAuto: parseBool(store.getSetting(SETTING_ALLOW_SMS_AUTO), false),
  };
}

/**
 * v0: three deny rules in priority order (kill-switch first — an operator
 * emergency stop outranks connection state), else allow at `globalMode`.
 * Everything else in `GateContext` (rule/schedule/contact/counters/message)
 * is plumbed through for later slices but not consulted yet — v0 allows a
 * human actor with an unknown (null) contact, unlike the eventual §1.3.5
 * deny-all-unknown-contacts default.
 */
export function evaluateGate(ctx: GateContext): GateDecision {
  if (ctx.settings.killSwitch) {
    return { allow: false, reason: 'kill-switch' };
  }
  if (ctx.settings.connectionState === 'disconnected') {
    return { allow: false, reason: 'disconnected' };
  }
  if (ctx.settings.connectionState === 'read-only') {
    return { allow: false, reason: 'read-only' };
  }
  return { allow: true, mode: ctx.settings.globalMode };
}
