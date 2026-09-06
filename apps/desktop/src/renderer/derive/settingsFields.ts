/**
 * s8 Scenario 14 — the settings screen's key list, and the four rows it may
 * show but may not write.
 *
 * **Why the list is re-declared here.** INV-1 leaves the renderer without a
 * `@wemessage/core` dependency, and `packages/daemon` is not a dependency of
 * anything under `apps/desktop/src/renderer` either, so the daemon's
 * `SETTINGS_SCHEMA` is not importable. This is the same situation
 * `derive/auditRows.ts` is in with §1.6's deny reasons, and it gets the same
 * answer: re-declare the names, make the screen TOTAL over them at compile
 * time, and tie the two lists back together with an arch row that resolves
 * `packages/daemon/src/settings/schema.ts`'s `SETTING_*` constants to their
 * literals and compares. A key added to the daemon and not to this file
 * fails `test/arch.spec.ts`, not a user.
 *
 * **Why no bound is written down here.** `SettingEntry` carries `type`,
 * `default`, `version`, `floor`, `ceiling` and `use` on the wire, so the
 * form renders the daemon's numbers rather than a second copy of them. A
 * ceiling that moves in `schema.ts` moves on screen with no edit here, and
 * there is no version of this file that can disagree with the validator.
 *
 * **Why the rows are total and the draft is not.** A writable key the daemon
 * did not answer still renders a ROW, because its absence is information; it
 * does not get a CONTROL, because there is no floor, ceiling or current
 * value to build one from, and a control seeded with an invented value is a
 * knob that lies about what it is currently set to. So {@link fieldRows} is
 * total over the eleven writable keys and {@link draftOf} is total over
 * nothing: what is not on the wire is not in the draft, and therefore can
 * never be in a patch.
 */
import type {
  SettingEntry,
  SettingValue,
  SettingsPayload,
} from '@wemessage/client';
import type { FieldIssue } from './form.js';
import type { SettingsRefusal } from '@wemessage/client';

/**
 * The eleven keys `PATCH /v1/settings` accepts, sorted the way the daemon
 * sorts them. Scraped from this file by `test/arch.spec.ts`, so the literal
 * stays a flat array of quoted strings.
 */
export const WRITABLE_KEYS = [
  'send.autoGraceSeconds',
  'send.capContactPer2Min',
  'send.capContactPerHour',
  'send.capGlobalPerHour',
  'send.circuitFailureThreshold',
  'send.circuitFailureWindowMin',
  'send.circuitOpenMinutes',
  'send.loopConsecutiveAutoMax',
  'send.loopDuplicateLookback',
  'send.retryAsSms',
  'send.undoGraceSeconds',
] as const;

export type WritableKey = (typeof WRITABLE_KEYS)[number];

/**
 * The four rows the daemon shows and refuses to be handed.
 *
 * Each one already has a route that does MORE than move a value (the kill
 * switch cancels in-grace drafts, pause re-sweeps the arming posture, the
 * breaker's instant is cleared by closing the circuit), so a settings screen
 * that offered a second way to write them would be offering the half of the
 * operation that does not do the dangerous part.
 */
export const READ_ONLY_KEYS = [
  'arming.pauseUntil',
  'send.circuitOpenedAt',
  'send.globalMode',
  'send.killSwitch',
] as const;

export type ReadOnlyKey = (typeof READ_ONLY_KEYS)[number];

/**
 * The order the form is read in, top to bottom.
 *
 * Grouped by what the number PROTECTS rather than by key prefix: an operator
 * lowering blast radius wants the three caps adjacent, and an operator who
 * has just watched the breaker trip wants its three numbers adjacent. Ten of
 * the eleven keys share the `send.` prefix, so prefix order would be no
 * order at all.
 */
export const GROUPS = [
  'CAPS',
  'TIMING',
  'LOOP GUARDS',
  'BREAKER',
  'DELIVERY',
] as const;

export type Group = (typeof GROUPS)[number];

export interface FieldSpec {
  readonly group: Group;
  /** §1.7: uppercase, and the label is the primary carrier, not a tooltip. */
  readonly label: string;
  /** What the number does, in one line. Never a restatement of the label. */
  readonly note: string;
}

/**
 * Total over {@link WRITABLE_KEYS} by TYPE, both directions: a key added to
 * the array without a row here does not compile, and a row here whose key is
 * not in the array does not compile either.
 */
export const FIELDS: Readonly<Record<WritableKey, FieldSpec>> = {
  'send.capContactPer2Min': {
    group: 'CAPS',
    label: 'PER CONTACT, PER 2 MINUTES',
    note: 'The burst cap. One conversation cannot be written to faster than this, however many drafts are waiting.',
  },
  'send.capContactPerHour': {
    group: 'CAPS',
    label: 'PER CONTACT, PER HOUR',
    note: 'The sustained cap for a single conversation.',
  },
  'send.capGlobalPerHour': {
    group: 'CAPS',
    label: 'ALL CONTACTS, PER HOUR',
    note: 'The whole daemon, every conversation together. The last number standing if every other guard is wrong.',
  },
  'send.undoGraceSeconds': {
    group: 'TIMING',
    label: 'UNDO WINDOW, SECONDS',
    note: 'How long an approved draft sits before it is handed to Messages. Zero is legal here: a person who clicks approve is allowed to mean now.',
  },
  'send.autoGraceSeconds': {
    group: 'TIMING',
    label: 'AUTONOMY GRACE, SECONDS',
    note: 'The same window for a draft nobody approved. Floored well above zero, because there is no person watching this one.',
  },
  'send.loopConsecutiveAutoMax': {
    group: 'LOOP GUARDS',
    label: 'CONSECUTIVE AUTO SENDS',
    note: 'How many unanswered automatic messages in a row before the daemon stops talking to itself.',
  },
  'send.loopDuplicateLookback': {
    group: 'LOOP GUARDS',
    label: 'DUPLICATE LOOKBACK',
    note: 'How far back to look for the same text before refusing to send it again.',
  },
  'send.circuitFailureThreshold': {
    group: 'BREAKER',
    label: 'FAILURES BEFORE TRIP',
    note: 'How many send failures inside the window open the breaker.',
  },
  'send.circuitFailureWindowMin': {
    group: 'BREAKER',
    label: 'FAILURE WINDOW, MINUTES',
    note: 'The window those failures are counted in.',
  },
  'send.circuitOpenMinutes': {
    group: 'BREAKER',
    label: 'STAY OPEN, MINUTES',
    note: 'How long the breaker refuses everything once it has tripped.',
  },
  'send.retryAsSms': {
    group: 'DELIVERY',
    label: 'RETRY AS SMS',
    note: 'Stored, and read by nothing in this build. Shown because a preference the screen pretends to save and does not is worse than one that is honestly inert.',
  },
};

export interface PointerSpec {
  readonly label: string;
  readonly note: string;
}

/** Total over {@link READ_ONLY_KEYS}, by the same construction as FIELDS. */
export const POINTERS: Readonly<Record<ReadOnlyKey, PointerSpec>> = {
  'arming.pauseUntil': {
    label: 'PAUSED UNTIL',
    note: 'Set by the pause toggle, which also re-sweeps the arming posture. Writing the instant alone would move the display and nothing else.',
  },
  'send.circuitOpenedAt': {
    label: 'BREAKER OPENED AT',
    note: 'The machine own record of when it stopped trusting the send path. An observation, not a preference.',
  },
  'send.globalMode': {
    label: 'GLOBAL MODE',
    note: 'Draft-only or auto, for the whole daemon. Owned by the toggle above, which asks for a typed confirm before it arms autonomy.',
  },
  'send.killSwitch': {
    label: 'KILL SWITCH',
    note: 'Owned by the switch at the top of this screen, whose flip also cancels every draft still inside its grace window.',
  },
};

/** One writable key, and whatever the daemon said about it (or did not). */
export interface FieldRow {
  readonly key: WritableKey;
  readonly group: Group;
  readonly label: string;
  readonly note: string;
  /** `null` when the daemon answered no such key. Never a stand-in value. */
  readonly entry: SettingEntry | null;
}

/** Total over the eleven, in {@link GROUPS} order. */
export function fieldRows(settings: SettingsPayload): FieldRow[] {
  const out: FieldRow[] = [];
  for (const group of GROUPS)
    for (const key of WRITABLE_KEYS) {
      const spec = FIELDS[key];
      if (spec.group !== group) continue;
      out.push({
        key,
        group,
        label: spec.label,
        note: spec.note,
        entry: settings[key] ?? null,
      });
    }
  return out;
}

/** What an unsaved settings form holds: only keys the daemon answered. */
export type SettingsDraft = Partial<Record<WritableKey, number | boolean>>;

/**
 * The editable baseline.
 *
 * Total over nothing on purpose. A key the daemon omitted, and a key whose
 * value contradicts its own declared `type` (a `bool` row reading 7 means
 * the stored bytes are garbage and the daemon is using its default), are
 * both dropped rather than coerced: the form can then never send back a
 * number it made up, and `formPatch` over a dropped key is empty.
 */
export function draftOf(settings: SettingsPayload): SettingsDraft {
  const out: SettingsDraft = {};
  for (const key of WRITABLE_KEYS) {
    const entry = settings[key];
    if (entry === undefined) continue;
    if (entry.type === 'int' && typeof entry.value === 'number')
      out[key] = entry.value;
    else if (entry.type === 'bool' && typeof entry.value === 'boolean')
      out[key] = entry.value;
  }
  return out;
}

/**
 * The pause horizon, to the minute, with no clock and no tick.
 *
 * The temptation here is a countdown, and a countdown needs `Date.now()` and
 * a timer, both of which are banned under `screens/` and `derive/` and both
 * of which would make this screen repaint forever. Sc11 refused a live clock
 * for the schedule grid on the same grounds. So this prints the daemon's own
 * instant and lets the operator do the subtraction: the string changes only
 * when the daemon says something new.
 *
 * The ISO string is SLICED, never parsed into a `Date`. A `Date` would drag
 * in the local zone and print an hour the daemon never said; slicing keeps
 * the `Z`. Anything that does not match the shape is repeated verbatim,
 * because guessing at an unrecognised instant is how a screen shows an hour
 * that exists nowhere.
 */
const ISO_MINUTE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):\d{2}(?:\.\d+)?Z$/;

export function pauseHorizon(value: SettingValue | undefined): string {
  if (value === null || value === undefined || value === '')
    return 'NOT PAUSED';
  const text = String(value);
  const match = ISO_MINUTE.exec(text);
  if (match === null) return `PAUSED UNTIL ${text}`;
  return `PAUSED UNTIL ${match[1] ?? ''} ${match[2] ?? ''}Z`;
}

/** One read-only row, its value as a word, and the route that owns it. */
export interface PointerRow {
  readonly key: ReadOnlyKey;
  readonly label: string;
  readonly note: string;
  /** Straight off the wire: the daemon names its own owning route. */
  readonly use: string;
  readonly value: string;
}

function pointerValue(
  key: ReadOnlyKey,
  entry: SettingEntry | undefined,
): string {
  const raw = entry?.value;
  // Unset is a state, not a blank cell. §1.7: never render an empty box and
  // leave the operator to guess whether it is off or unknown.
  if (raw === null || raw === undefined || raw === '') return 'UNSET';
  if (key === 'arming.pauseUntil') return pauseHorizon(raw);
  if (typeof raw === 'boolean') return raw ? 'ON' : 'OFF';
  return String(raw).toUpperCase();
}

/** Total over the four, in {@link READ_ONLY_KEYS} order. */
export function pointerRows(settings: SettingsPayload): PointerRow[] {
  return READ_ONLY_KEYS.map((key) => {
    const entry = settings[key];
    return {
      key,
      label: POINTERS[key].label,
      note: POINTERS[key].note,
      use: entry?.use ?? '',
      value: pointerValue(key, entry),
    };
  });
}

/**
 * A refusal, addressed to the field it names.
 *
 * The rules editor renders zod's own `message` sentences. `planPatch` has no
 * sentence to lend: it answers with a STRUCTURE, five error names and four
 * numbers, and C-3 says that is deliberate — a client is told which key and
 * what bound, never prose it would have to parse. So the message is the
 * daemon's own error NAME plus the daemon's own datum, and this function
 * invents no vocabulary of its own. The screen uppercases it; nothing here
 * rewords it.
 */
export function settingsIssue(refusal: SettingsRefusal): FieldIssue {
  if (refusal.error === 'read-only-key')
    return {
      path: refusal.key,
      message: `read-only-key: use ${refusal.use}`,
    };
  if (refusal.error === 'wrong-type')
    return {
      path: refusal.key,
      message: `wrong-type: expected ${refusal.expected}`,
    };
  if (refusal.error === 'below-floor')
    return {
      path: refusal.key,
      message: `below-floor: floor is ${String(refusal.floor)}`,
    };
  if (refusal.error === 'above-ceiling')
    return {
      path: refusal.key,
      message: `above-ceiling: ceiling is ${String(refusal.ceiling)}`,
    };
  return { path: refusal.key, message: refusal.error };
}
