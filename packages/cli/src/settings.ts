/**
 * s7 Scenario 5 — `wemessage settings get|set`, as pure functions.
 *
 * Split out of `bin.ts` for the reason every renderer in this package is
 * (see `arming.ts`, `adapters.ts`, `watch.ts`, `purge.ts`): `bin.ts` runs
 * `program.parseAsync(process.argv)` as a module side effect the instant it
 * is imported, so nothing that lives in it can be unit-tested. Everything
 * here is a function of a payload.
 *
 * Three decisions govern the file.
 *
 * **The CLI is the operator's honest window.** `GET /v1/settings` returns
 * `default`, `floor`, `ceiling`, `readOnly` and `use` for every key, and Sc 4
 * put them there for exactly one reason: so an operator can see WHY a write
 * will be refused BEFORE attempting it. A renderer that printed key and
 * value would throw all of that away and leave the floors discoverable only
 * by tripping over them. So the table shows the bounds, and a read-only key
 * renders as read-only with the verb that owns it, never as a normal row an
 * operator will reasonably try to edit.
 *
 * **Refusals survive the wrapper.** The daemon distinguishes five reasons a
 * patch can be refused and spends a distinct datum on each — the floor, the
 * ceiling, the expected type, the owning route. Collapsing them into
 * "invalid" one layer above where they were earned would be the regression
 * this scenario exists to prevent, so `settingsRefusal` maps each to its own
 * sentence, leading with the daemon's own word so an operator grepping the
 * wire taxonomy finds the same string the audit log holds.
 *
 * **No typed confirmation on `settings set`, and that is a decision, not an
 * omission.** S6 gave `mode auto` and `contacts set --auto` a typed
 * confirmation because both do ONE specific thing: move the system from "a
 * human approves every send" to "the machine sends." Not one of the eleven
 * writable keys can do that. Every one is a bound consumed by a gate that
 * only ever NARROWS what may be sent, and INV-2 is structural rather than
 * configurable — no setting reaches `dispatchApproved`, and the four keys
 * that do carry arming state are precisely the four the route refuses to
 * write. The nearest thing to dangerous is `send.undoGraceSeconds = 0`,
 * which removes the recall window; but it removes a net under a send a human
 * has ALREADY approved, not the approval, and 0 is a legal value the floor
 * deliberately admits (§1.3.3). Putting a prompt on a legal value would also
 * make the verb unusable from a script, and — the real cost — it would teach
 * the habit of typing through confirmations, which is exactly what would
 * later be typed through on `mode auto`, where it matters. The answer here
 * is SIGHT, not friction: `renderSettingsSet` states the consequence in
 * plain words on the success line, and an operator who aims at a read-only
 * key is never met with silence, because the daemon refuses it by name.
 *
 * No colour anywhere (C-9): glyphs carry state, UPPERCASE carries emphasis.
 */
import type {
  SettingEntry,
  SettingPatchValue,
  SettingsPayload,
  SettingsRefusal,
  SettingValue,
} from '@wemessage/client';

/** Exit 1 (§3.8): the command was well formed and the daemon refused it. */
const EXIT_FAILED = 1;
/** Exit 2 (§3.8): the operator asked for something that cannot be asked. */
const EXIT_USAGE = 2;

/**
 * Read-only routes to the CLI verb that owns them.
 *
 * A closed lookup, deliberately, rather than a derivation from the route
 * path. `POST /v1/toggles/kill-switch` maps to `wemessage kill` and
 * `POST /v1/toggles/kill-switch {"circuit": true}` maps to
 * `wemessage resume --circuit`: the same path, two different verbs, and no
 * rule over the string could have produced either. When a later slice makes
 * a key read-only against a route with no CLI verb, the honest answer is to
 * print the ROUTE (see `remediationFor`'s callers) rather than to invent a
 * verb that does not exist — a fabricated command is worse than a raw route,
 * because the operator will type it.
 */
const REMEDIATION: Readonly<Record<string, string>> = {
  'POST /v1/toggles/pause': 'wemessage pause <until>',
  'POST /v1/toggles/kill-switch': 'wemessage kill',
  'POST /v1/toggles/kill-switch {"circuit": true}':
    'wemessage resume --circuit',
  'POST /v1/toggles/global-mode': 'wemessage mode <value>',
};

/** The CLI verb that owns `use`, or undefined if this CLI has no verb for it. */
export function remediationFor(use: string): string | undefined {
  return REMEDIATION[use];
}

/** `null` is a real value on the read-only ISO keys; it is not an error. */
function renderValue(value: SettingValue): string {
  return value === null ? 'none' : String(value);
}

/**
 * The NOTE column: what this key will accept, or who owns it.
 *
 * The bounds are the point. `1-60` next to `send.capContactPer2Min` is the
 * difference between an operator who knows the write of 0 will be refused
 * and one who finds out by being refused.
 */
function noteFor(entry: SettingEntry): string {
  if (entry.readOnly) {
    const use = entry.use ?? '';
    return `READ-ONLY  use: ${remediationFor(use) ?? use}`;
  }
  if (entry.floor !== undefined && entry.ceiling !== undefined) {
    return `${String(entry.floor)}-${String(entry.ceiling)}`;
  }
  return entry.type === 'bool' ? 'true|false' : '';
}

/**
 * The state glyph. `⊘` is "you may look but not write"; `·` is an ordinary
 * row. Glyph, not colour (C-9), and the word READ-ONLY carries the emphasis
 * a wireframe would carry with weight.
 */
function glyphFor(entry: SettingEntry): string {
  return entry.readOnly ? '⊘' : '·';
}

const COLUMNS = ['  KEY', 'VALUE', 'DEFAULT', 'NOTE'] as const;

/**
 * `settings get`, human mode: a fixed-width table inside a fenced code
 * block. Fixed-width rather than markdown pipes for the reason
 * `renderScheduleTable` is, and fenced because a table that is not read in a
 * monospace context is not a table.
 */
export function renderSettingsTable(settings: SettingsPayload): string {
  const entries = Object.entries(settings);
  if (entries.length === 0) return ['```', 'no settings', '```'].join('\n');
  const rows = entries.map(([key, entry]) => [
    `${glyphFor(entry)} ${key}`,
    renderValue(entry.value),
    renderValue(entry.default),
    noteFor(entry),
  ]);
  const widths = COLUMNS.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, i) =>
        i === cells.length - 1 ? cell : cell.padEnd(widths[i] ?? 0),
      )
      .join('  ')
      .trimEnd();
  return ['```', line([...COLUMNS]), ...rows.map(line), '```'].join('\n');
}

/**
 * `settings set <key> <value>`: the value literal.
 *
 * Exactly two booleans and strict integers are recognised; EVERYTHING else
 * travels as a string. That is not laziness — it is what keeps `wrong-type`
 * reachable. A CLI that knew which keys were ints would be carrying a second
 * copy of the daemon's type table, and the first key added would make that
 * copy wrong, silently, in the direction of refusing a write the daemon
 * would have accepted. `yes` and `1.5` therefore reach the wire as strings
 * and come back named by the route that owns the schema.
 */
export function parseSettingLiteral(raw: string): SettingPatchValue {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  return raw;
}

/** A refusal, rendered for stderr, with the exit code it earns (§3.8). */
export interface RefusalOutput {
  message: string;
  code: number;
}

/**
 * One sentence per reason, each led by the daemon's own word.
 *
 * The exit codes split the five deliberately. `below-floor` and
 * `above-ceiling` are exit 1: the command was well formed, the operator
 * asked a coherent question and the DAEMON said no. The other three are
 * exit 2: the request could not have succeeded as typed — a key that does
 * not exist, a key this route may not write, a value of the wrong shape —
 * which is what §3.8 means by a usage error.
 */
export function settingsRefusal(refusal: SettingsRefusal): RefusalOutput {
  switch (refusal.error) {
    case 'unknown-key':
      return {
        message: `unknown-key: "${refusal.key}" is not a setting; run \`wemessage settings get\` for the keys that are`,
        code: EXIT_USAGE,
      };
    case 'read-only-key': {
      const verb = remediationFor(refusal.use);
      return {
        message:
          `read-only-key: "${refusal.key}" is owned by another route; ` +
          (verb === undefined
            ? `change it with ${refusal.use}`
            : `use \`${verb}\` (${refusal.use})`),
        code: EXIT_USAGE,
      };
    }
    case 'wrong-type':
      return {
        message: `wrong-type: "${refusal.key}" expects ${refusal.expected}`,
        code: EXIT_USAGE,
      };
    case 'below-floor':
      return {
        message: `below-floor (floor ${String(refusal.floor)}): "${refusal.key}" will not go lower`,
        code: EXIT_FAILED,
      };
    case 'above-ceiling':
      return {
        message: `above-ceiling (ceiling ${String(refusal.ceiling)}): "${refusal.key}" will not go higher`,
        code: EXIT_FAILED,
      };
  }
}

/**
 * The keys whose legal range reaches "off", and the sentence each earns.
 *
 * This is the ratified alternative to a typed confirmation (see the header):
 * the operator is TOLD what they just did, in the words a person would use,
 * rather than asked to prove they meant it. Keyed on the value as well as
 * the key, because 30 seconds of undo window is not a consequence worth a
 * sentence and 0 is.
 */
function consequenceFor(key: string, value: SettingValue): string | null {
  if (key === 'send.undoGraceSeconds' && value === 0) {
    return 'no undo window: approved drafts dispatch at once, with nothing to recall';
  }
  return null;
}

/**
 * `settings set`, human mode.
 *
 * `settings` is the entries the operator ASKED about (bin.ts narrows the
 * daemon's full payload to those), and `changed` is the daemon's own list of
 * what actually moved. A patch whose value equals the current one changes
 * nothing, writes no audit row and broadcasts no frame, and saying "set" for
 * it would be the CLI claiming a change the log does not have.
 */
export function renderSettingsSet(
  settings: SettingsPayload,
  changed: readonly string[],
): string {
  const lines: string[] = [];
  for (const [key, entry] of Object.entries(settings)) {
    const suffix = changed.includes(key) ? '' : ' (unchanged)';
    lines.push(`${key}: ${renderValue(entry.value)}${suffix}`);
    const consequence = consequenceFor(key, entry.value);
    if (consequence !== null) lines.push(consequence);
  }
  return lines.join('\n');
}
