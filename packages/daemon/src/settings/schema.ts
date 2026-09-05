/**
 * s7-execution Scenario 4 — the closed list of settings keys, and everything
 * that is true about each one (F-85).
 *
 * **Why a list and not a filter.** The settings table is a flat key/value
 * store, and by S6 it holds the numbers that bound this product's blast
 * radius: the three rate caps, the breaker's thresholds, the loop limits,
 * autonomy's undo window. It also holds two rows that are not knobs at all —
 * `connection.state`, which the gate reads to decide whether this daemon may
 * speak, and `send.circuitOpenedAt`, which is the machine's own record of
 * when it stopped trusting the send path. A route that wrote "whatever the
 * body said, minus a denylist" would be one forgotten row away from letting
 * an operator (or anything holding the operator's token) hand-set the
 * daemon's opinion of its own connectivity. So this file is the surface: a
 * key not named here does not exist as far as `PATCH /v1/settings` is
 * concerned, and `routes/settings.ts` cannot reach the store except through
 * an entry in this list.
 *
 * **Why every value is read through the production reader.** Each spec's
 * `read` is the SAME function the daemon consults when it makes a decision —
 * `readRateCaps` for the caps, `readCircuitConfig` for the breaker,
 * `readAutoGraceSeconds` for autonomy's grace. That is what makes a GET
 * answer "what is this daemon doing" rather than "what bytes are in the
 * table". The distinction is not academic: `readCap` refuses a non-integer
 * and falls back to the shipped default, so a row reading `seven` means the
 * cap is 1, and a settings screen that echoed `seven` back would be showing
 * the operator a number nothing in the product believes.
 *
 * **Why the floors are here as well as there.** Three of the readers already
 * clamp — `readCap` to 1, `readAutoGraceSeconds` to 5 — so a route with no
 * floors would not actually weaken the daemon; it would do something worse,
 * which is accept the write, report success, and then disagree with itself
 * about what the setting says. Refusing at the write is the only outcome
 * where the operator learns the floor exists. The floor NUMBERS are imported,
 * never retyped: `CAP_FLOOR` and `AUTO_GRACE_FLOOR_SECONDS` are the same
 * constants the gate enforces, so the two can never drift apart.
 *
 * **Why four keys are read-only rather than absent.** The kill switch, the
 * global mode, the pause deadline and the breaker's trip instant are real
 * rows in this table and an operator staring at a settings screen should see
 * their values. What they must not have is a SECOND way to be written: each
 * already has a route that does more than set a string (the kill switch
 * cancels in-grace drafts, pause re-sweeps the arming posture, the breaker's
 * instant is cleared by `closeCircuit`), and a PATCH that only moved the
 * value would produce a daemon whose posture and whose settings row disagree.
 * They refuse with a pointer to the route that owns them.
 *
 * **What is deliberately NOT here.** `connection.state` and
 * `connection.userDisconnected` are the daemon's observations, not the
 * operator's preferences, and the gate fails closed on them. `send.allowSmsAuto`
 * is a widening with no floor and no owning route in this slice. All three are
 * `unknown-key`, which is a better answer than `read-only-key` because they
 * are not settings at all.
 */
import {
  AUTO_GRACE_FLOOR_SECONDS,
  CAP_FLOOR,
  DEFAULT_CIRCUIT_CONFIG,
  DEFAULT_LOOP_LIMITS,
  DEFAULT_RATE_CAPS,
  readAutoGraceSeconds,
  readCircuitConfig,
  readGateSettings,
  readLoopLimits,
  readRateCaps,
  SETTING_AUTO_GRACE_SECONDS,
  SETTING_CAP_CONTACT_PER_2MIN,
  SETTING_CAP_CONTACT_PER_HOUR,
  SETTING_CAP_GLOBAL_PER_HOUR,
  SETTING_CIRCUIT_FAILURE_THRESHOLD,
  SETTING_CIRCUIT_FAILURE_WINDOW_MIN,
  SETTING_CIRCUIT_OPEN_MINUTES,
  SETTING_CIRCUIT_OPENED_AT,
  SETTING_GLOBAL_MODE,
  SETTING_KILL_SWITCH,
  SETTING_LOOP_CONSECUTIVE_AUTO_MAX,
  SETTING_LOOP_DUPLICATE_LOOKBACK,
  SETTING_PAUSE_UNTIL,
  SETTING_RETRY_AS_SMS,
  SETTING_UNDO_GRACE_SECONDS,
  type SettingValue,
  type Store,
} from '@wemessage/core';

/** Everything in this file reads; only `routes/settings.ts` writes. */
export type SettingReader = Pick<Store, 'getSetting' | 'getSettingVersion'>;

/**
 * `iso` and `enum` exist so the read-only rows can describe themselves to a
 * settings screen; nothing validates against them, because nothing writable
 * carries them. When a later slice makes one of those keys writable it will
 * have to add the validator at the same time, which is the point.
 */
export type SettingType = 'int' | 'bool' | 'iso' | 'enum';

interface SpecBase {
  readonly key: string;
  readonly type: SettingType;
  /** The production reader for this key, so GET reports the live value. */
  readonly read: (store: SettingReader) => SettingValue;
  /**
   * What this key would read as if the row were deleted. A function rather
   * than a constant because one key's default is another key's value:
   * `send.autoGraceSeconds` inherits `send.undoGraceSeconds` (F-78), and an
   * operator who has set the operator grace to 60 should be told that
   * clearing the auto grace lands on 60, not on the shipped 10.
   */
  readonly fallback: (store: SettingReader) => SettingValue;
}

/** F-66's shape: a bounded integer, floored and ceilinged at the write. */
export interface IntSpec extends SpecBase {
  readonly type: 'int';
  readonly readOnly: false;
  readonly floor: number;
  readonly ceiling: number;
}

export interface BoolSpec extends SpecBase {
  readonly type: 'bool';
  readonly readOnly: false;
}

/** Visible on GET, refused on PATCH, with the route that owns it named. */
export interface ReadOnlySpec extends SpecBase {
  readonly readOnly: true;
  readonly use: string;
}

export type SettingSpec = IntSpec | BoolSpec | ReadOnlySpec;

/**
 * Ceilings are not safety properties the way the floors are — nothing gets
 * more dangerous as a cap rises, it just stops being a cap — so they are set
 * where a number stops being a plausible answer and starts being a typo or a
 * paste. A per-contact cap of 60 in two minutes is already one message per
 * two seconds; an hour of open breaker is a day at 1440 minutes. The value of
 * refusing 100000 is that the operator sees their mistake now rather than
 * discovering it as an absence of protection later.
 */
const MINUTES_PER_DAY = 1440;
/** §1.3.3's window is a human reaction time, not a scheduling mechanism. */
const GRACE_CEILING_SECONDS = 300;

function boolOf(raw: string | null): boolean {
  return raw === '1';
}

/** §1.3.3 default undo window when `send.undoGraceSeconds` is unset. */
export const DEFAULT_UNDO_GRACE_SECONDS = 10;

/**
 * Unset -> the 10s default. Set-but-garbage -> also the default: a
 * corrupted settings row must not silently mean "send instantly."
 * Explicit '0' -> zero, the one value that legitimately disables the window.
 *
 * s7 Sc4 moved this out of `routes/drafts.ts` so the approve route and the
 * settings route read the key through one function. Two readers of one
 * safety-relevant number is how a floor stops being a floor.
 */
export function readUndoGraceSeconds(store: Pick<Store, 'getSetting'>): number {
  const raw = store.getSetting(SETTING_UNDO_GRACE_SECONDS);
  if (raw === null) return DEFAULT_UNDO_GRACE_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_UNDO_GRACE_SECONDS;
  }
  return parsed;
}

/**
 * The list, sorted by key. Sorted because it is serialized straight onto the
 * wire and two daemons' settings should diff as values, not as ordering.
 */
const SPECS: readonly SettingSpec[] = [
  {
    key: SETTING_PAUSE_UNTIL,
    type: 'iso',
    readOnly: true,
    use: 'POST /v1/toggles/pause',
    // Omitted-when-unset in the gate context (F-68); null on the wire, where
    // an absent key would be indistinguishable from a key we forgot to send.
    read: (store) => readGateSettings(store).pausedUntil ?? null,
    fallback: () => null,
  },
  {
    key: SETTING_AUTO_GRACE_SECONDS,
    type: 'int',
    readOnly: false,
    // F-78. The floor is imported, not retyped: this is the same 5 seconds
    // `readAutoGraceSeconds` clamps to, and there is no value that reaches 0.
    floor: AUTO_GRACE_FLOOR_SECONDS,
    ceiling: GRACE_CEILING_SECONDS,
    read: (store) => readAutoGraceSeconds(store),
    fallback: (store) =>
      readAutoGraceSeconds({
        getSetting: (key) =>
          key === SETTING_AUTO_GRACE_SECONDS ? null : store.getSetting(key),
      }),
  },
  {
    key: SETTING_CAP_CONTACT_PER_2MIN,
    type: 'int',
    readOnly: false,
    floor: CAP_FLOOR,
    ceiling: 60,
    read: (store) => readRateCaps(store).contactPer2Min,
    fallback: () => DEFAULT_RATE_CAPS.contactPer2Min,
  },
  {
    key: SETTING_CAP_CONTACT_PER_HOUR,
    type: 'int',
    readOnly: false,
    floor: CAP_FLOOR,
    ceiling: 600,
    read: (store) => readRateCaps(store).contactPerHour,
    fallback: () => DEFAULT_RATE_CAPS.contactPerHour,
  },
  {
    key: SETTING_CAP_GLOBAL_PER_HOUR,
    type: 'int',
    readOnly: false,
    floor: CAP_FLOOR,
    ceiling: 10_000,
    read: (store) => readRateCaps(store).globalPerHour,
    fallback: () => DEFAULT_RATE_CAPS.globalPerHour,
  },
  {
    key: SETTING_CIRCUIT_FAILURE_THRESHOLD,
    type: 'int',
    readOnly: false,
    floor: CAP_FLOOR,
    ceiling: 1000,
    read: (store) => readCircuitConfig(store).failureThreshold,
    fallback: () => DEFAULT_CIRCUIT_CONFIG.failureThreshold,
  },
  {
    key: SETTING_CIRCUIT_FAILURE_WINDOW_MIN,
    type: 'int',
    readOnly: false,
    floor: CAP_FLOOR,
    ceiling: MINUTES_PER_DAY,
    read: (store) => readCircuitConfig(store).failureWindowMin,
    fallback: () => DEFAULT_CIRCUIT_CONFIG.failureWindowMin,
  },
  {
    key: SETTING_CIRCUIT_OPEN_MINUTES,
    type: 'int',
    readOnly: false,
    floor: CAP_FLOOR,
    ceiling: MINUTES_PER_DAY,
    read: (store) => readCircuitConfig(store).openMinutes,
    fallback: () => DEFAULT_CIRCUIT_CONFIG.openMinutes,
  },
  {
    key: SETTING_CIRCUIT_OPENED_AT,
    type: 'iso',
    readOnly: true,
    // Derived state, not a preference: the machine wrote it when the send
    // path started failing. Clearing it is `closeCircuit`, which also has to
    // decide what the arming posture becomes.
    use: 'POST /v1/toggles/kill-switch {"circuit": true}',
    read: (store) => store.getSetting(SETTING_CIRCUIT_OPENED_AT),
    fallback: () => null,
  },
  {
    key: SETTING_GLOBAL_MODE,
    type: 'enum',
    readOnly: true,
    use: 'POST /v1/toggles/global-mode',
    read: (store) => readGateSettings(store).globalMode,
    fallback: () => 'draft-only',
  },
  {
    key: SETTING_KILL_SWITCH,
    type: 'bool',
    readOnly: true,
    // The one control whose flip must cancel in-grace drafts synchronously
    // before it answers. A PATCH that only moved the string would report a
    // stopped daemon that had not stopped anything.
    use: 'POST /v1/toggles/kill-switch',
    read: (store) => readGateSettings(store).killSwitch,
    fallback: () => false,
  },
  {
    key: SETTING_LOOP_CONSECUTIVE_AUTO_MAX,
    type: 'int',
    readOnly: false,
    floor: CAP_FLOOR,
    ceiling: 100,
    read: (store) => readLoopLimits(store).consecutiveAutoMax,
    fallback: () => DEFAULT_LOOP_LIMITS.consecutiveAutoMax,
  },
  {
    key: SETTING_LOOP_DUPLICATE_LOOKBACK,
    type: 'int',
    readOnly: false,
    floor: CAP_FLOOR,
    ceiling: 100,
    read: (store) => readLoopLimits(store).duplicateLookback,
    fallback: () => DEFAULT_LOOP_LIMITS.duplicateLookback,
  },
  {
    key: SETTING_RETRY_AS_SMS,
    type: 'bool',
    readOnly: false,
    // Minted in S4 and read by nothing yet (its consumer is the SMS retry
    // path). It is writable here because S8's Settings screen offers it and
    // because storing a preference nothing acts on is harmless; what would
    // not be harmless is a screen that pretends to save it and does not.
    read: (store) => boolOf(store.getSetting(SETTING_RETRY_AS_SMS)),
    fallback: () => false,
  },
  {
    key: SETTING_UNDO_GRACE_SECONDS,
    type: 'int',
    readOnly: false,
    // Zero is legal here and only here: a human who clicks approve is allowed
    // to mean now. It does not reach autonomy — `readAutoGraceSeconds` floors
    // whatever it inherits at five seconds (F-78).
    floor: 0,
    ceiling: GRACE_CEILING_SECONDS,
    read: (store) => readUndoGraceSeconds(store),
    fallback: () => DEFAULT_UNDO_GRACE_SECONDS,
  },
];

/** The closed list, by key. Lookup is data; there is no chain of `if`s. */
export const SETTINGS_SCHEMA: ReadonlyMap<string, SettingSpec> = new Map(
  SPECS.map((spec) => [spec.key, spec]),
);

/** Sorted, so the wire order is the review order. */
export const SETTING_KEYS: readonly string[] = SPECS.map((s) => s.key);

/**
 * What GET returns per key. `floor`, `ceiling` and `use` are OMITTED rather
 * than undefined where they do not apply (`exactOptionalPropertyTypes`), so
 * `'use' in entry` is a truthful question for a client deciding whether to
 * render an input or a pointer.
 */
export interface SettingEntry {
  value: SettingValue;
  default: SettingValue;
  /** The store's own counter; -1 means the row was never written. */
  version: number;
  type: SettingType;
  readOnly: boolean;
  floor?: number;
  ceiling?: number;
  use?: string;
}

function entryOf(store: SettingReader, spec: SettingSpec): SettingEntry {
  return {
    value: spec.read(store),
    default: spec.fallback(store),
    version: store.getSettingVersion(spec.key),
    type: spec.type,
    readOnly: spec.readOnly,
    ...(spec.readOnly ? { use: spec.use } : {}),
    ...(spec.readOnly === false && spec.type === 'int'
      ? { floor: spec.floor, ceiling: spec.ceiling }
      : {}),
  };
}

export function readSettings(
  store: SettingReader,
): Record<string, SettingEntry> {
  const out: Record<string, SettingEntry> = {};
  for (const spec of SPECS) out[spec.key] = entryOf(store, spec);
  return out;
}

/**
 * Every way a PATCH can be refused, as data. C-3: the client is told which
 * key and what bound, never a prose string it would have to parse.
 */
export type PatchRefusal =
  | { error: 'unknown-key'; key: string }
  | { error: 'read-only-key'; key: string; use: string }
  | { error: 'wrong-type'; key: string; expected: 'int' | 'bool' }
  | { error: 'below-floor'; key: string; floor: number }
  | { error: 'above-ceiling'; key: string; ceiling: number };

/** One accepted key: what it was, what it becomes, and the bytes to store. */
export interface SettingChange {
  key: string;
  from: SettingValue;
  to: SettingValue;
  raw: string;
}

export type PatchPlan =
  { ok: true; changes: SettingChange[] } | { ok: false; refusal: PatchRefusal };

/**
 * Validate the WHOLE body against the whole list before anything is written.
 *
 * All-or-nothing is not a nicety. A settings body is one operator decision —
 * "make the daemon behave like this" — and a partial application leaves the
 * product in a configuration nobody chose and nobody is looking at. Keys are
 * visited in sorted order so the same body always draws the same refusal.
 */
export function planPatch(
  store: SettingReader,
  body: Record<string, unknown>,
): PatchPlan {
  const changes: SettingChange[] = [];
  for (const key of Object.keys(body).sort()) {
    const spec = SETTINGS_SCHEMA.get(key);
    if (spec === undefined)
      return { ok: false, refusal: { error: 'unknown-key', key } };
    if (spec.readOnly) {
      return {
        ok: false,
        refusal: { error: 'read-only-key', key, use: spec.use },
      };
    }
    const value = body[key];
    if (spec.type === 'bool') {
      if (typeof value !== 'boolean') {
        return {
          ok: false,
          refusal: { error: 'wrong-type', key, expected: 'bool' },
        };
      }
      const from = spec.read(store);
      if (from === value) continue;
      changes.push({ key, from, to: value, raw: value ? '1' : '0' });
      continue;
    }
    // Strict integers only: '3' is a string an operator's form forgot to
    // parse, and 1.5 is a number the settings table cannot round-trip.
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      return {
        ok: false,
        refusal: { error: 'wrong-type', key, expected: 'int' },
      };
    }
    if (value < spec.floor) {
      return {
        ok: false,
        refusal: { error: 'below-floor', key, floor: spec.floor },
      };
    }
    if (value > spec.ceiling) {
      return {
        ok: false,
        refusal: { error: 'above-ceiling', key, ceiling: spec.ceiling },
      };
    }
    const from = spec.read(store);
    // A no-op is measured against what the daemon currently DOES, not against
    // the bytes in the row: saving a form nobody touched must not mint an
    // audit row, and "the cap is already 1" is true whether the row says '1'
    // or says nothing at all.
    if (from === value) continue;
    changes.push({ key, from, to: value, raw: String(value) });
  }
  return { ok: true, changes };
}
