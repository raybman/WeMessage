/**
 * s7-execution Scenario 5 (CLI half, pure-function rows) — the `settings`
 * renderers and refusal mapping, the `watch --events` list parser, and the
 * two source sweeps that fence this package.
 *
 * LOCATION DEVIATION, the same one every CLI slice since S2 has taken
 * (precedent: purge.spec.ts, cli-s5.spec.ts, windows-cli.spec.ts):
 * `.dependency-cruiser.cjs`'s `nobody-imports-daemon` and
 * `cli-thin-client` forbid packages/cli from importing
 * @wemessage/daemon, and `src/bin.ts` runs `program.parseAsync(process.argv)`
 * as a module side effect the instant it is imported. So the rows that are
 * pure functions of a payload live here, and the rows that need a REAL
 * daemon answering real HTTP (exit codes, the daemon's own refusal text
 * reaching stderr, a filter round-tripping through a socket) live in
 * packages/daemon/test/settings-cli-live.spec.ts.
 *
 * The load-bearing rows here are three:
 *
 *  - **`settings get` shows the whole picture, not just values.** Sc 4 put
 *    `default`, `floor`, `ceiling`, `readOnly` and `use` in the GET response
 *    for exactly one reason: so an operator can see WHY a write will be
 *    refused before they attempt it. A renderer that printed key and value
 *    would throw that away and leave the floors discoverable only by
 *    tripping over them.
 *  - **The five refusals arrive with their names intact.** The daemon
 *    distinguishes `unknown-key`, `read-only-key`, `wrong-type`,
 *    `below-floor` and `above-ceiling`. One row per reason, asserting the
 *    server's own word reaches the operator alongside the datum that makes
 *    it actionable.
 *  - **The no-green source sweep** (row 7). Not a transcript sweep this
 *    time but a sweep of `packages/cli/src` itself, because the reflex this
 *    scenario has to survive is a hand adding `\x1b[32m` at a `console.log`
 *    call site in `bin.ts` — a file no test can import. The sweep names the
 *    offending file.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SettingEntry, SettingsRefusal } from '@wemessage/client';
import {
  parseSettingLiteral,
  remediationFor,
  renderSettingsSet,
  renderSettingsTable,
  settingsRefusal,
} from '../src/settings.js';
import { parseEventsFlag } from '../src/watch.js';

/** Any ANSI escape (covers color incl. green): the no-green rule (C-9). */
const ANSI_RE = /\x1b\[/;

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));

function intEntry(over: Partial<SettingEntry> = {}): SettingEntry {
  return {
    value: 2,
    default: 2,
    version: -1,
    type: 'int',
    readOnly: false,
    floor: 1,
    ceiling: 60,
    ...over,
  };
}

function boolEntry(over: Partial<SettingEntry> = {}): SettingEntry {
  return {
    value: false,
    default: false,
    version: -1,
    type: 'bool',
    readOnly: false,
    ...over,
  };
}

function readOnlyEntry(
  use: string,
  over: Partial<SettingEntry> = {},
): SettingEntry {
  return {
    value: false,
    default: false,
    version: -1,
    type: 'bool',
    readOnly: true,
    use,
    ...over,
  };
}

const SETTINGS: Record<string, SettingEntry> = {
  'arming.pauseUntil': readOnlyEntry('POST /v1/toggles/pause', {
    type: 'iso',
    value: null,
    default: null,
  }),
  'send.capContactPer2Min': intEntry(),
  'send.circuitOpenedAt': readOnlyEntry(
    'POST /v1/toggles/kill-switch {"circuit": true}',
    { type: 'iso', value: null, default: null },
  ),
  'send.globalMode': readOnlyEntry('POST /v1/toggles/global-mode', {
    type: 'enum',
    value: 'draft-only',
    default: 'draft-only',
  }),
  'send.killSwitch': readOnlyEntry('POST /v1/toggles/kill-switch'),
  'send.retryAsSms': boolEntry(),
  'send.undoGraceSeconds': intEntry({
    value: 10,
    default: 10,
    floor: 0,
    ceiling: 300,
  }),
};

// ---------------------------------------------------------------------------
// row 4 — `settings get` renders the whole picture
// ---------------------------------------------------------------------------

describe('renderSettingsTable (row 4)', () => {
  const table = renderSettingsTable(SETTINGS);

  it('is fenced, because every table this house prints is fenced', () => {
    const lines = table.split('\n');
    expect(lines[0]).toBe('```');
    expect(lines.at(-1)).toBe('```');
  });

  it('names every key it was given, and nothing it was not', () => {
    for (const key of Object.keys(SETTINGS)) expect(table).toContain(key);
    expect(table).not.toContain('send.capGlobalPerHour');
  });

  it('shows the FLOOR and the ceiling of a bounded key, not just its value', () => {
    // The floors are the reason Sc 4 refuses at the write. An operator who
    // can only discover them by tripping over one is being taught by
    // failure.
    const row = table
      .split('\n')
      .find((l) => l.includes('send.capContactPer2Min'));
    expect(row).toBeDefined();
    expect(row).toMatch(/\b1-60\b/);
  });

  it('shows the default alongside the value, so a changed key is visible as changed', () => {
    const changed = renderSettingsTable({
      'send.capContactPer2Min': intEntry({ value: 7, version: 3 }),
    });
    const row = changed
      .split('\n')
      .find((l) => l.includes('send.capContactPer2Min'));
    expect(row).toContain('7');
    expect(row).toContain('2');
  });

  it('a read-only key renders as READ-ONLY with the verb that owns it, never as a normal row', () => {
    const rows = table.split('\n');
    const kill = rows.find((l) => l.includes('send.killSwitch'));
    expect(kill).toBeDefined();
    expect(kill).toContain('READ-ONLY');
    expect(kill).toContain('wemessage kill');
    // And the glyph carries the state, per the house pattern.
    expect(kill?.trimStart().startsWith('⊘')).toBe(true);

    const writable = rows.find((l) => l.includes('send.capContactPer2Min'));
    expect(writable).not.toContain('READ-ONLY');
    expect(writable?.trimStart().startsWith('·')).toBe(true);
  });

  it('every read-only key names an owning verb — none of the four is silent', () => {
    for (const [key, entry] of Object.entries(SETTINGS)) {
      if (!entry.readOnly) continue;
      const row = table.split('\n').find((l) => l.includes(key));
      expect(row, key).toContain('READ-ONLY');
      const remediation = remediationFor(entry.use ?? '');
      expect(row, key).toContain(remediation ?? entry.use ?? '');
    }
  });

  it('a null value is `none`, not an empty column an operator reads as a bug', () => {
    const row = table.split('\n').find((l) => l.includes('arming.pauseUntil'));
    expect(row).toContain('none');
  });

  it('renders no ANSI, in any posture', () => {
    expect(table).not.toMatch(ANSI_RE);
    expect(renderSettingsTable({})).not.toMatch(ANSI_RE);
  });
});

// ---------------------------------------------------------------------------
// row 5a — the value literal
// ---------------------------------------------------------------------------

describe('parseSettingLiteral (row 5)', () => {
  it('reads the two booleans and the integers', () => {
    expect(parseSettingLiteral('true')).toBe(true);
    expect(parseSettingLiteral('false')).toBe(false);
    expect(parseSettingLiteral('3')).toBe(3);
    expect(parseSettingLiteral('0')).toBe(0);
    expect(parseSettingLiteral('-1')).toBe(-1);
  });

  it('passes anything else through AS A STRING so the daemon owns the refusal', () => {
    // The alternative is a second, client-side copy of the type table, which
    // would drift from the daemon's the first time a key is added — and it
    // would swallow `wrong-type`, one of the five reasons this scenario
    // exists to keep alive.
    expect(parseSettingLiteral('yes')).toBe('yes');
    expect(parseSettingLiteral('1.5')).toBe('1.5');
    expect(parseSettingLiteral('')).toBe('');
    expect(parseSettingLiteral('TRUE')).toBe('TRUE');
  });
});

// ---------------------------------------------------------------------------
// row 5b — all five refusals reach the operator, in the daemon's taxonomy
// ---------------------------------------------------------------------------

describe('settingsRefusal (row 5) — one row per reason', () => {
  it('unknown-key names the key and points at the list', () => {
    const out = settingsRefusal({ error: 'unknown-key', key: 'send.nope' });
    expect(out.message).toContain('unknown-key');
    expect(out.message).toContain('send.nope');
    expect(out.message).toContain('wemessage settings get');
    expect(out.code).toBe(2);
  });

  it('read-only-key names the CLI verb that owns it AND the route', () => {
    const out = settingsRefusal({
      error: 'read-only-key',
      key: 'send.killSwitch',
      use: 'POST /v1/toggles/kill-switch',
    });
    expect(out.message).toContain('read-only-key');
    expect(out.message).toContain('send.killSwitch');
    expect(out.message).toContain('wemessage kill');
    expect(out.message).toContain('POST /v1/toggles/kill-switch');
    expect(out.code).toBe(2);
  });

  it('a read-only key with a route we have no verb for prints the ROUTE, never an invented verb', () => {
    const out = settingsRefusal({
      error: 'read-only-key',
      key: 'send.somethingLater',
      use: 'POST /v1/toggles/not-yet',
    });
    expect(out.message).toContain('POST /v1/toggles/not-yet');
    expect(out.message).not.toContain('wemessage not-yet');
  });

  it('wrong-type says which type was expected', () => {
    const out = settingsRefusal({
      error: 'wrong-type',
      key: 'send.retryAsSms',
      expected: 'bool',
    });
    expect(out.message).toContain('wrong-type');
    expect(out.message).toContain('send.retryAsSms');
    expect(out.message).toContain('bool');
    expect(out.code).toBe(2);
  });

  it('below-floor names the floor — the number the operator could not have known', () => {
    const out = settingsRefusal({
      error: 'below-floor',
      key: 'send.capContactPer2Min',
      floor: 1,
    });
    expect(out.message).toContain('below-floor');
    expect(out.message).toContain('send.capContactPer2Min');
    expect(out.message).toContain('floor 1');
    // Exit 1, not 2: the command was well formed and the DAEMON refused it.
    expect(out.code).toBe(1);
  });

  it('above-ceiling names the ceiling', () => {
    const out = settingsRefusal({
      error: 'above-ceiling',
      key: 'send.capGlobalPerHour',
      ceiling: 10000,
    });
    expect(out.message).toContain('above-ceiling');
    expect(out.message).toContain('send.capGlobalPerHour');
    expect(out.message).toContain('ceiling 10000');
    expect(out.code).toBe(1);
  });

  it('no reason collapses into another: five inputs, five distinct messages', () => {
    const refusals: SettingsRefusal[] = [
      { error: 'unknown-key', key: 'k' },
      { error: 'read-only-key', key: 'k', use: 'POST /v1/toggles/pause' },
      { error: 'wrong-type', key: 'k', expected: 'int' },
      { error: 'below-floor', key: 'k', floor: 1 },
      { error: 'above-ceiling', key: 'k', ceiling: 9 },
    ];
    const messages = refusals.map((r) => settingsRefusal(r).message);
    expect(new Set(messages).size).toBe(5);
    for (const [i, refusal] of refusals.entries()) {
      // The server's own word leads the line, so an operator grepping the
      // wire taxonomy finds the same string the daemon logged.
      expect(messages[i]?.startsWith(refusal.error)).toBe(true);
    }
    for (const message of messages) expect(message).not.toMatch(ANSI_RE);
  });
});

// ---------------------------------------------------------------------------
// row 5c — the success line
// ---------------------------------------------------------------------------

describe('renderSettingsSet (row 5)', () => {
  it('prints the new value of the key that was set', () => {
    const out = renderSettingsSet(
      { 'send.capContactPer2Min': intEntry({ value: 3 }) },
      ['send.capContactPer2Min'],
    );
    expect(out).toBe('send.capContactPer2Min: 3');
  });

  it('a no-op says so rather than claiming a change the audit log does not have', () => {
    const out = renderSettingsSet(
      { 'send.capContactPer2Min': intEntry({ value: 2 }) },
      [],
    );
    expect(out).toContain('send.capContactPer2Min: 2');
    expect(out).toContain('unchanged');
  });

  it('setting the undo window to zero states the consequence in plain words', () => {
    // The ratified alternative to a typed confirmation (see settings.ts):
    // sight, not friction. This is the only writable key whose legal range
    // reaches "off", so it is the only one that gets a sentence.
    const out = renderSettingsSet(
      { 'send.undoGraceSeconds': intEntry({ value: 0, floor: 0 }) },
      ['send.undoGraceSeconds'],
    );
    expect(out).toContain('send.undoGraceSeconds: 0');
    expect(out).toContain('no undo window');
  });

  it('a non-zero undo window gets no sentence', () => {
    const out = renderSettingsSet(
      { 'send.undoGraceSeconds': intEntry({ value: 30, floor: 0 }) },
      ['send.undoGraceSeconds'],
    );
    expect(out).not.toContain('no undo window');
  });

  it('renders no ANSI', () => {
    expect(
      renderSettingsSet(
        { 'send.undoGraceSeconds': intEntry({ value: 0, floor: 0 }) },
        ['send.undoGraceSeconds'],
      ),
    ).not.toMatch(ANSI_RE);
  });
});

// ---------------------------------------------------------------------------
// row 3a — the --events list
// ---------------------------------------------------------------------------

describe('parseEventsFlag (row 3)', () => {
  it('splits the comma list, in the order given', () => {
    expect(parseEventsFlag('draft.created,draft.sent')).toEqual([
      'draft.created',
      'draft.sent',
    ]);
    expect(parseEventsFlag('draft.sent')).toEqual(['draft.sent']);
  });

  it('validates NOTHING about the names: one vocabulary, and it is the daemon`s', () => {
    // A second copy of GATEWAY_EVENT_NAMES here would go stale the first
    // time the vocabulary grows, and would answer a typo with a different
    // sentence than the daemon does.
    expect(parseEventsFlag('draft.typo')).toEqual(['draft.typo']);
    expect(parseEventsFlag('')).toEqual(['']);
    expect(parseEventsFlag('a, b')).toEqual(['a', ' b']);
  });
});

// ---------------------------------------------------------------------------
// rows 7 and 8 — the source sweeps
// ---------------------------------------------------------------------------

function srcFiles(): string[] {
  return readdirSync(SRC_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(SRC_DIR, f));
}

/** Comments carry the WORD "green" by design (they explain the rule). */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('row 7 — the no-green sweep over packages/cli/src', () => {
  /**
   * THE TEETH ROW (TN-green-ok). Every other no-green guard in this repo
   * sweeps a rendered TRANSCRIPT, which means it can only see the branches
   * a test happened to exercise — and `bin.ts` cannot be imported at all,
   * so a `\x1b[32m` added at one of its `console.log` call sites is
   * invisible to every one of them. This row reads the source.
   */
  it('no file under packages/cli/src carries an ANSI escape or a colour literal', () => {
    const files = srcFiles();
    expect(files.length).toBeGreaterThan(5);
    const banned: [RegExp, string][] = [
      [/\x1b\[/, 'a raw ANSI escape'],
      [/\\x1b\[/, 'an \\x1b ANSI escape'],
      [/\\u001[bB]\[/, 'a \\u001b ANSI escape'],
      [/\\0?33\[/, 'an octal ANSI escape'],
      [/\\e\[/, 'an \\e ANSI escape'],
      [/#34C759/i, 'the wireframe green'],
      [/\bgreen\b/i, 'the word green'],
      [/\bchalk\b|\bpicocolors\b|\bansi-colors\b/i, 'a colour library'],
    ];
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const [re, what] of banned) {
        expect(re.test(code), `${file} contains ${what}`).toBe(false);
      }
    }
  });
});

describe('row 8 — thin clients (cli-thin-client, attributed here)', () => {
  it('packages/cli/src imports nothing from the adapter testkit', () => {
    for (const file of srcFiles()) {
      const code = readFileSync(file, 'utf8');
      expect(
        /from\s+['"]@wemessage\/adapter-testkit/.test(code),
        `${file} imports the testkit`,
      ).toBe(false);
      expect(
        /require\(\s*['"]@wemessage\/adapter-testkit/.test(code),
        `${file} requires the testkit`,
      ).toBe(false);
    }
  });

  it('the CLI declares only client and protocol as workspace dependencies', () => {
    const pkg = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../package.json', import.meta.url)),
        'utf8',
      ),
    ) as { dependencies?: Record<string, string> };
    const workspaceDeps = Object.keys(pkg.dependencies ?? {}).filter((d) =>
      d.startsWith('@wemessage/'),
    );
    expect(workspaceDeps.sort()).toEqual([
      '@wemessage/client',
      '@wemessage/protocol',
    ]);
  });
});
