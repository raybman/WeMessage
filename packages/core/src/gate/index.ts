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
import type {
  GateContext,
  GateDecision,
  GateDenyReason,
  RespondMode,
} from '../domain/types.js';
import type { Store } from '../ports/index.js';
import { isArmed } from '../schedule/index.js';

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

/**
 * s4-execution Scenario 4: seconds between an approval and the actual send —
 * the undo window a human can recall inside (§1.3.3). Read by the draft
 * approve route (Scenario 5) and the grace scheduler (Scenario 6); NOT read
 * by `evaluateGate` (grace is not a deny rule, it is a delay).
 */
export const SETTING_UNDO_GRACE_SECONDS = 'send.undoGraceSeconds';
/**
 * s4-execution Scenario 4: whether a failed iMessage send may be retried
 * over SMS. Minted here so Scenario 8's SMS-retry field has a settings key
 * to read; like the grace key it is not a gate deny rule.
 */
export const SETTING_RETRY_AS_SMS = 'send.retryAsSms';

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

/** Most-restrictive-wins: 'draft-only' beats 'auto' whenever the two disagree. */
function narrower(a: RespondMode, b: RespondMode): RespondMode {
  return a === 'draft-only' || b === 'draft-only' ? 'draft-only' : 'auto';
}

/**
 * Gate v1 (s4-execution Scenario 4, §2.4.1). Deny rules in strict priority
 * order, then a most-restrictive-wins mode resolution:
 *
 *   1. kill-switch   — an operator emergency stop outranks everything.
 *   2. disconnected  — no live Messages connection at all.
 *   3. read-only     — connected, but sending is not possible.
 *   4. contact       — §2.4.3's ladder, consulted ONLY for rule-driven
 *      traffic (`ctx.rule !== null`). An unknown contact (null) and an
 *      explicit 'deny' both deny with 'contact-denied': §1.3.5's deny-all
 *      default is what "unknown" means.
 *
 * The **human pin** (F-20, preserved verbatim from v0): when `ctx.rule` is
 * null the traffic is a human acting deliberately through the API/CLI/GUI,
 * not a rule firing at a stranger. A null contact must NOT deny there, or
 * every hand-written first message to a new number would be blocked. The
 * contact ladder is therefore gated on `rule !== null`, and the S3 F-20 test
 * keeps passing untouched.
 *
 * **F-50 (s5 Scenario 9), additive.** `ctx.agentOrigin === true` is the
 * second way traffic can be non-human: an agent's PROACTIVE proposal, which
 * has no rule to hang the ladder off (`ruleId: null` by §3.2) and yet is the
 * one path where an adapter chooses the audience. The ladder is therefore
 * consulted when `rule !== null || agentOrigin === true`, and agent-origin
 * decisions are additionally clamped to 'draft-only' — a message nobody
 * asked for is never sent without a human, whatever the global mode and the
 * contact policy say (INV-5's sibling; S6 inherits it).
 *
 * Both halves are ADDITIVE: a context that omits `agentOrigin` takes exactly
 * the v1 branch it always did, so the human pin above survives verbatim and
 * every S4 gate row passes unmodified. Teeth T9-proactive-unpoliced is the
 * check that the F-50 half is load-bearing.
 *
 * The **group clamp** (INV-5): a group chat can never resolve to 'auto',
 * whatever the global mode or contact policy says. This is a clamp on the
 * ALLOWED MODE, not a deny — a group draft is still perfectly legal, it
 * just always needs a human.
 *
 * **F-63 (s6 Scenario 4), the third scope.** `rules.respond_mode` has been
 * written by the rules route since S2 and read by nothing, so §2.4.3's "all
 * three scopes must say auto" was two scopes as built (C-4). Step 4 below
 * narrows the resolved mode by `rule.respondMode` through the same
 * `narrower()` the other two scopes already use, which is what makes
 * most-restrictive-wins a property of one function rather than a convention
 * three call sites have to keep. There is no scope that widens: the ladder
 * has no escape hatch, and the UI's "per-contact AUTO scoped to specific
 * rules" is exactly this composition rather than a new field.
 *
 * **F-64, the clamp channel.** Autonomy can be withheld for reasons that are
 * not denials — the message still deserves a draft a human can look at.
 * Those conditions clamp `mode` to 'draft-only' and record `clampedBy`,
 * reusing the deny taxonomy's own literal so the same cause is the same word
 * whether it clamped or denied. Steps 1–2 deny at both gate moments; the
 * clamps are what the two moments read differently (§2.4.1). A clamp NEVER
 * upgrades a deny, which is why every clamp is evaluated after every deny.
 *
 * The clamp this scenario owns is the schedule: a rule pointing at a
 * schedule that is not armed right now cannot act autonomously. Fail-closed
 * per §2.4.2 — a dangling `scheduleId` whose row was deleted (`schedule`
 * arrives null), a disabled schedule and a schedule with no windows are all
 * NOT armed, never "unconstrained, therefore always". A rule with
 * `scheduleId: null` is genuinely always armed and is the only always-on
 * reading in the function.
 *
 * Rate caps, the circuit breaker, the loop breaker and the SMS clamp are the
 * remaining conditions in this step and land in their own scenarios (S6
 * Sc 6/7/8/9). Until then `ctx.counters` stays unread, and
 * scope-resolution.spec.ts pins that hostile values there change nothing —
 * the honest successor to the "plumbed-but-unread" row this scenario retires
 * from gate.spec.ts, now that schedules are read.
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

  let mode: RespondMode = ctx.settings.globalMode;
  const agentOrigin = ctx.agentOrigin === true;
  if (ctx.rule !== null || agentOrigin) {
    if (ctx.contact === null || ctx.contact.mode === 'deny') {
      return { allow: false, reason: 'contact-denied' };
    }
    mode = narrower(mode, ctx.contact.mode);
  }
  // Step 4 (F-63): the third scope. Only a rule carries one, so the human
  // path (`rule === null`) is untouched and the F-20 pin above still holds.
  if (ctx.rule !== null) {
    mode = narrower(mode, ctx.rule.respondMode);
  }
  if (agentOrigin) {
    mode = 'draft-only';
  }
  if (ctx.message.isGroup) {
    mode = 'draft-only';
  }

  // Step 7: the autonomy clamps. Recorded even when `mode` is already
  // 'draft-only' — a clamp is a fact about the world, not a transition in
  // `mode`, and the draft-moment callers branch on the fact (a rule with
  // `outsideWindow: 'ignore'` drops the message entirely, whatever narrowed
  // the mode first).
  let clampedBy: GateDenyReason | undefined;
  if (scheduleClosed(ctx)) {
    mode = 'draft-only';
    clampedBy = 'outside-window';
  }

  return {
    allow: true,
    mode,
    ...(clampedBy !== undefined ? { clampedBy } : {}),
  };
}

/**
 * Is this decision's rule pointing at a schedule that is shut right now?
 *
 * `false` for a rule with no schedule (always armed, §3.2) and for the human
 * path, which has no rule to carry a `scheduleId`. Everything else is
 * fail-closed: a missing schedule row is NOT armed, which is what makes a
 * deleted schedule withdraw autonomy instead of granting it.
 */
function scheduleClosed(ctx: GateContext): boolean {
  const rule = ctx.rule;
  if (rule === null || rule.scheduleId === null) return false;
  if (ctx.schedule === null) return true;
  return !isArmed(ctx.schedule, ctx.now);
}
