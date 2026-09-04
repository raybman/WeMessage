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
  Handle,
  IsoUtc,
  RateCaps,
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
    // s6 Scenario 6: the caps are settings, so they are read where the other
    // settings are read. Every production gate call site goes through this
    // function, which is what makes an operator's raise take effect
    // everywhere at once instead of at whichever call site remembered.
    caps: readRateCaps(store),
  };
}

/* ------------------------------------------------------------------ *
 * Rate caps and counters (s6 Scenario 6, §1.7 "Rate counters")
 * ------------------------------------------------------------------ */

/** Auto sends to one handle in a rolling 2 minutes (F-66: default 1, floor 1). */
export const SETTING_CAP_CONTACT_PER_2MIN = 'send.capContactPer2Min';
/** Auto sends to one handle in a rolling hour (default 10, floor 1). */
export const SETTING_CAP_CONTACT_PER_HOUR = 'send.capContactPerHour';
/** ALL sends this daemon originates in a rolling hour (default 30, floor 1). */
export const SETTING_CAP_GLOBAL_PER_HOUR = 'send.capGlobalPerHour';

/**
 * The two scope shapes `0001_init.sql` pins, minted here so no caller has to
 * remember the string. A third shape would silently partition the ledger and
 * uncap whatever landed in it, which is why `rate-counters.spec.ts` asserts
 * over `SELECT DISTINCT scope` rather than over these two constants.
 */
export const RATE_SCOPE_GLOBAL = 'global';
export function contactRateScope(handle: Handle): string {
  return `contact:${handle}`;
}

/** Counter buckets are minute-resolution (§1.7). */
export const RATE_BUCKET_MS = 60_000;
/** The pacing window: `send.capContactPer2Min` is measured over this. */
export const RATE_WINDOW_PACING_MS = 2 * 60_000;
/** The window both hourly caps are measured over. */
export const RATE_WINDOW_HOUR_MS = 60 * 60_000;

/**
 * Floor an instant to its minute. Two sends 59 seconds apart share a row;
 * a rolling window therefore reads at most 60 rows per scope however busy the
 * hour was, which is the reason to bucket at all (C-8: there are no indexes
 * in this repo, and a bounded scan is what makes that safe).
 */
export function rateBucketStart(at: IsoUtc): IsoUtc {
  const ms = Date.parse(at);
  return new Date(ms - (ms % RATE_BUCKET_MS)).toISOString();
}

/** The shipped caps, applied whenever a `GateContext` omits its own. */
export const DEFAULT_RATE_CAPS: RateCaps = {
  contactPer2Min: 1,
  contactPerHour: 10,
  globalPerHour: 30,
};

/** F-66: no cap can be set below this, and there is no disabling value. */
const CAP_FLOOR = 1;

/**
 * Strict integer or the default — deliberately not `parseInt`, which reads
 * '7.5' as 7 and '1e3' as 1. A settings value that is not an integer means
 * nobody set this one on purpose, and the shipped default is the honest
 * answer to that. A value that IS an integer and is zero or negative is
 * different: somebody typed it, and F-66 says the floor answers them.
 */
function readCap(
  store: Pick<Store, 'getSetting'>,
  key: string,
  fallback: number,
): number {
  const raw = store.getSetting(key);
  if (raw === null || !/^-?\d+$/.test(raw)) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return parsed < CAP_FLOOR ? CAP_FLOOR : parsed;
}

export function readRateCaps(store: Pick<Store, 'getSetting'>): RateCaps {
  return {
    contactPer2Min: readCap(
      store,
      SETTING_CAP_CONTACT_PER_2MIN,
      DEFAULT_RATE_CAPS.contactPer2Min,
    ),
    contactPerHour: readCap(
      store,
      SETTING_CAP_CONTACT_PER_HOUR,
      DEFAULT_RATE_CAPS.contactPerHour,
    ),
    globalPerHour: readCap(
      store,
      SETTING_CAP_GLOBAL_PER_HOUR,
      DEFAULT_RATE_CAPS.globalPerHour,
    ),
  };
}

/** `now` shifted back by `ms`, as the inclusive lower edge of a window. */
function windowStart(now: IsoUtc, ms: number): IsoUtc {
  return new Date(Date.parse(now) - ms).toISOString();
}

/**
 * Read the autonomy history a gate decision is measured against (§1.7).
 *
 * The windows are rolling and computed from the RAW instant, never floored:
 * flooring `now - 2min` to its minute would widen the pacing window by up to
 * 59 seconds and make "121 seconds later" arrive early. Only the stored
 * bucket is minute-aligned; the edge that sweeps over it is not.
 *
 * `consecutiveAutoInChat` and `circuitOpen` are still placeholders — Sc 8 and
 * Sc 7 own them, and this function is where they will be read from the same
 * store handle.
 */
export function readGateCounters(
  store: Pick<Store, 'sumRateCounter'>,
  input: { now: IsoUtc; handle: Handle },
): GateContext['counters'] {
  const scope = contactRateScope(input.handle);
  return {
    contactAutoLast2Min: store.sumRateCounter(
      scope,
      windowStart(input.now, RATE_WINDOW_PACING_MS),
    ),
    contactAutoLastHour: store.sumRateCounter(
      scope,
      windowStart(input.now, RATE_WINDOW_HOUR_MS),
    ),
    globalSentLastHour: store.sumRateCounter(
      RATE_SCOPE_GLOBAL,
      windowStart(input.now, RATE_WINDOW_HOUR_MS),
    ),
    consecutiveAutoInChat: 0,
    circuitOpen: false,
  };
}

/**
 * Spend budget for a send this daemon has just decided to make (F-71: at
 * APPROVAL, not at send — the cap limits how often the machine decides to
 * speak, and counting at send makes it racy across the whole grace window).
 *
 * The global scope counts every approval, human or auto. The per-contact
 * scope counts only the ones the machine decided, because pacing exists to
 * stop a machine from hammering one person and a human sending three messages
 * in a minute is a human having a conversation.
 */
export function bumpSendCounters(
  store: Pick<Store, 'bumpRateCounter'>,
  input: { now: IsoUtc; auto: boolean; handle: Handle },
): void {
  const bucket = rateBucketStart(input.now);
  store.bumpRateCounter(RATE_SCOPE_GLOBAL, bucket);
  if (input.auto) store.bumpRateCounter(contactRateScope(input.handle), bucket);
}

/**
 * The first instant at which a saturated rolling window will have room again,
 * for the `retryAfter` a human is owed when the global cap refuses them
 * (F-71: "naming the cap and its reset instant").
 *
 * The window has room the moment enough of its oldest buckets have swept past
 * its trailing edge, so the answer is always `<some bucket start> + windowMs +
 * 1ms`. Rather than add a port method to list buckets, this binary-searches
 * the candidate edges — the sum is monotonically non-increasing as the edge
 * advances, and there are at most `windowMs / RATE_BUCKET_MS + 1` of them, so
 * this is ~6 reads for an hour window and it is exact rather than rounded.
 *
 * Returns `now` itself when the window is not actually saturated: a caller
 * that asks anyway gets "right now", never a fabricated future.
 */
export function nextRateCapReset(
  store: Pick<Store, 'sumRateCounter'>,
  input: { now: IsoUtc; scope: string; cap: number; windowMs: number },
): IsoUtc {
  const nowMs = Date.parse(input.now);
  const oldestEdge = nowMs - input.windowMs;
  const hasRoom = (edgeMs: number): boolean =>
    store.sumRateCounter(input.scope, new Date(edgeMs).toISOString()) <
    input.cap;
  if (hasRoom(oldestEdge)) return input.now;

  // Candidate edges are one millisecond past each bucket start that could be
  // in the window; `k` counts minutes from the bucket the trailing edge is
  // currently inside.
  const firstBucket =
    oldestEdge -
    (((oldestEdge % RATE_BUCKET_MS) + RATE_BUCKET_MS) % RATE_BUCKET_MS);
  const edgeAt = (k: number): number => firstBucket + k * RATE_BUCKET_MS + 1;
  const maxK = Math.ceil(input.windowMs / RATE_BUCKET_MS) + 1;
  let lo = 0;
  let hi = maxK;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (hasRoom(edgeAt(mid))) hi = mid;
    else lo = mid + 1;
  }
  return new Date(edgeAt(lo) + input.windowMs).toISOString();
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
 * **F-66/F-71 (s6 Scenario 6), the second clamp.** `ctx.counters` stops being
 * decoration: three rolling sums are compared against three caps and any one
 * of them at its limit clamps to 'draft-only' with `clampedBy:
 * 'rate-limited'`. The caps ride in `ctx.settings.caps` because caps are
 * settings, and they are optional there so that a context which omits them is
 * measured against `DEFAULT_RATE_CAPS` — the strictest shipped values, which
 * makes a forgotten field withhold autonomy rather than grant it.
 *
 * Rate NEVER denies here. A cap says "not automatically", never "not at all":
 * the message still deserves a draft a human can look at, and the one place a
 * cap refuses a person outright is the global bound at the approve route,
 * which is a decision about a human's request and not about autonomy.
 *
 * **The clamps are an ELSE-IF chain, and that is load-bearing.** §1.7 lists
 * them in priority order and the first one to fire is the one recorded. Two
 * things turn on that. `mode` is identical either way (every clamp sets
 * 'draft-only'), but `clampedBy` is what the draft-moment caller branches on:
 * a rule with `outsideWindow: 'ignore'` drops the message entirely, and if a
 * rate clamp could overwrite `outside-window` that rule would start drafting
 * the moment it got busy. It is also what the send moment reports as the deny
 * reason, and an operator asked to fix "rate-limited" when the real cause was
 * a shut window has been sent to the wrong knob.
 *
 * The circuit breaker, the loop breaker and the SMS clamp are the remaining
 * conditions in this step and land in their own scenarios (S6 Sc 7/8/9);
 * until then `readGateCounters` reports them as inert.
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
  } else if (overRateCap(ctx)) {
    mode = 'draft-only';
    clampedBy = 'rate-limited';
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
/**
 * Is any of the three rolling counters at or over its cap (§1.7, F-66)?
 *
 * `>=`, not `>`: a cap of 1 means one send per window, so the second is the
 * one that clamps. Caps come from the context rather than a store read
 * because `evaluateGate` is pure; a context that omits them is measured
 * against `DEFAULT_RATE_CAPS`, which are the strictest shipped values, so
 * forgetting to plumb them can only withhold autonomy and never grant it.
 *
 * Both per-contact counters exclude human-approved sends and the global one
 * includes them (F-71). That asymmetry lives in `bumpSendCounters`, which is
 * the single writer; nothing here needs to know who decided.
 */
function overRateCap(ctx: GateContext): boolean {
  const caps = ctx.settings.caps ?? DEFAULT_RATE_CAPS;
  return (
    ctx.counters.contactAutoLast2Min >= caps.contactPer2Min ||
    ctx.counters.contactAutoLastHour >= caps.contactPerHour ||
    ctx.counters.globalSentLastHour >= caps.globalPerHour
  );
}

function scheduleClosed(ctx: GateContext): boolean {
  const rule = ctx.rule;
  if (rule === null || rule.scheduleId === null) return false;
  if (ctx.schedule === null) return true;
  return !isArmed(ctx.schedule, ctx.now);
}
