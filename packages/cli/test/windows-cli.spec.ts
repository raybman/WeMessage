/**
 * s6-execution Scenario 12 (CLI half, pure-function rows) — the `windows`
 * renderers, the armed line on `wemessage status`, the two typed
 * confirmations that guard autonomy, and the ONE composed verb in the CLI
 * (`resume`).
 *
 * Split for the same reason every CLI slice since S2 has split (precedent:
 * purge.spec.ts / cli-s5.spec.ts): `.dependency-cruiser.cjs`'s
 * `nobody-imports-daemon` and `cli-desktop-thin-clients` rules forbid
 * packages/cli from importing @wemessage/daemon, and `src/bin.ts` runs
 * `program.parseAsync(process.argv)` as a module side effect the instant it
 * is imported. So the rows that are pure functions of a payload live here,
 * in the package that owns them, and the rows that need a REAL daemon
 * answering real HTTP (round-trips, exit codes, call counts on the wire,
 * audit-row counts) live in packages/daemon/test/windows-cli-live.spec.ts.
 *
 * The load-bearing rows here are two:
 *
 *  - **`status transcript contains no ANSI escape`** (row 5). The wireframe
 *    renders armed as a green filled dot; C-9 says the CLI has no colour at
 *    all, so the terminal translation of "filled dot + bold" is glyph +
 *    UPPERCASE, and this row is what stops a future hand from reaching for
 *    `\x1b[32m` to get the wireframe's green back. It is the scenario's
 *    named teeth.
 *  - **`resume` is the one composed verb, and it composes out of what it
 *    can SEE** (row 8). Every other CLI verb is one HTTP call. `resume`
 *    clears the holds `/v1/status` actually reports and never guesses at
 *    one it cannot see, because the daemon writes an audit row for every
 *    toggle POST it receives — including a no-op one — so "clear it just in
 *    case" is indistinguishable, in the log, from an operator who really
 *    did hold something.
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  AuditRowPayload,
  SchedulePayload,
  StatusPayload,
} from '@wemessage/client';
import {
  confirmTyped,
  contactAutoPhrase,
  contactAutoPrompt,
  formatCountdown,
  GLOBAL_AUTO_PHRASE,
  GLOBAL_AUTO_PROMPT,
  parseWindowSpec,
  renderArmed,
  renderResume,
  renderScheduleTable,
  renderStatus,
  resolveGlobalMode,
  resumeHolds,
  type ResumeClient,
} from '../src/arming.js';

/** Any ANSI escape (covers color incl. green): the no-green rule (C-9). */
const ANSI_RE = /\x1b\[/;

const NOW = Date.parse('2026-09-03T12:00:00.000Z');

function schedule(over: Partial<SchedulePayload> = {}): SchedulePayload {
  return {
    id: '01JBUSINESSHOURS0000000000',
    name: 'Business hours',
    timezone: 'America/Los_Angeles',
    windows: [
      {
        days: ['mon', 'tue', 'wed', 'thu', 'fri'],
        start: '09:00',
        end: '17:00',
      },
    ],
    enabled: true,
    ...over,
  };
}

function status(over: Partial<StatusPayload> = {}): StatusPayload {
  return {
    connectionState: 'fully-connected',
    cursor: null,
    counts: { messagesToday: 0 },
    adapters: [],
    killSwitch: false,
    armed: { armed: true, until: null, reason: 'armed' },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// row 7 — fixed-width columns, never markdown pipes
// ---------------------------------------------------------------------------

describe('windows list rendering (row 7)', () => {
  it('renders fixed-width columns with aligned headers and no pipes', () => {
    const out = renderScheduleTable([
      schedule(),
      schedule({
        id: '01JQUIETHOURS00000000000000',
        name: 'Quiet',
        timezone: 'Pacific/Chatham',
        enabled: false,
      }),
    ]);
    const lines = out.split('\n');
    expect(lines).toHaveLength(3);
    const header = lines[0] ?? '';
    expect(header.startsWith('ID')).toBe(true);
    expect(header).toContain('NAME');
    expect(header).toContain('TZ');
    expect(header).toContain('ENABLED');
    expect(header).toContain('WINDOWS');
    // Markdown pipes are what this row exists to forbid.
    expect(out).not.toContain('|');
    // Fixed-width means the VALUES start where their headers start, on every
    // row, which is the only property a reader actually depends on.
    for (const [column, value] of [
      ['NAME', 'Business hours'],
      ['TZ', 'America/Los_Angeles'],
      ['ENABLED', 'yes'],
    ] as const) {
      expect(lines[1]?.indexOf(value)).toBe(header.indexOf(column));
    }
    expect(lines[2]?.indexOf('no')).toBe(header.indexOf('ENABLED'));
  });

  it('an empty list says so instead of printing a bare header', () => {
    expect(renderScheduleTable([])).toBe('no windows');
  });

  it('the table is monochrome', () => {
    expect(renderScheduleTable([schedule()])).not.toMatch(ANSI_RE);
  });
});

// ---------------------------------------------------------------------------
// row 3 — a midnight-wrapping window is ONE row with an explicit join marker
// ---------------------------------------------------------------------------

describe('midnight-wrapping windows (row 3)', () => {
  const overnight = schedule({
    id: '01JOVERNIGHT0000000000000',
    name: 'Overnight',
    windows: [{ days: ['fri'], start: '22:00', end: '02:00' }],
  });

  it('renders one row carrying an explicit +1d join marker, never two', () => {
    const lines = renderScheduleTable([overnight]).split('\n');
    // Header + exactly one data row. A renderer that split the wrap into a
    // 22:00-24:00 leg and a 00:00-02:00 leg would produce two.
    expect(lines).toHaveLength(2);
    const row = lines[1] ?? '';
    expect(row).toContain('fri 22:00-02:00 (+1d)');
    // The split it must not have performed, spelled out: no synthesised
    // midnight boundary in either of the two shapes a splitter would pick.
    expect(row).not.toContain('00:00');
    expect(row).not.toContain('23:59');
    expect(row).not.toContain('24:00');
    expect(row.match(/22:00/g)).toHaveLength(1);
    expect(row.match(/02:00/g)).toHaveLength(1);
  });

  it('a same-day window carries no join marker at all', () => {
    const row = renderScheduleTable([schedule()]).split('\n')[1] ?? '';
    expect(row).toContain('mon,tue,wed,thu,fri 09:00-17:00');
    expect(row).not.toContain('+1d');
  });

  it('several windows stay on the one schedule row, semicolon-separated', () => {
    const both = schedule({
      windows: [
        { days: ['mon'], start: '09:00', end: '17:00' },
        { days: ['fri'], start: '22:00', end: '02:00' },
      ],
    });
    const lines = renderScheduleTable([both]).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('mon 09:00-17:00; fri 22:00-02:00 (+1d)');
  });
});

// ---------------------------------------------------------------------------
// row 2 (client-side half) — `--window` parsing and its usage errors
// ---------------------------------------------------------------------------

describe('--window parsing (row 2)', () => {
  it('parses "days start-end" into the route DTO', () => {
    expect(parseWindowSpec('mon,wed,fri 09:00-17:00')).toEqual({
      ok: true,
      window: { days: ['mon', 'wed', 'fri'], start: '09:00', end: '17:00' },
    });
  });

  it('accepts a wrapping window without complaint — end < start is legal', () => {
    expect(parseWindowSpec('fri 22:00-02:00')).toEqual({
      ok: true,
      window: { days: ['fri'], start: '22:00', end: '02:00' },
    });
  });

  it('names the offending spec rather than saying "invalid"', () => {
    const bad = parseWindowSpec('funday 09:00-17:00');
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.message).toContain('funday');
    const shapeless = parseWindowSpec('mon 9-5');
    expect(shapeless.ok).toBe(false);
    expect(shapeless.ok === false && shapeless.message).toContain('mon 9-5');
  });
});

// ---------------------------------------------------------------------------
// row 5 — the armed state: filled dot + bold text + a countdown, no colour
// ---------------------------------------------------------------------------

describe('the armed line on status (row 5)', () => {
  it('renders a filled dot and uppercase text when armed', () => {
    const line = renderArmed(
      { armed: true, until: '2026-09-03T17:00:00.000Z', reason: 'armed' },
      NOW,
    );
    expect(line).toBe('● ARMED until 2026-09-03T17:00:00.000Z (5h 0m)');
  });

  it('renders a hollow dot, the reason, and the countdown when held', () => {
    expect(
      renderArmed(
        { armed: false, until: '2026-09-03T12:30:00.000Z', reason: 'paused' },
        NOW,
      ),
    ).toBe('○ HELD: paused until 2026-09-03T12:30:00.000Z (30m)');
  });

  it('a hold with no deadline prints no countdown rather than a fake one', () => {
    expect(
      renderArmed({ armed: false, until: null, reason: 'kill-switch' }, NOW),
    ).toBe('○ HELD: kill-switch');
  });

  it('a daemon with nothing to derive from says so instead of showing a hold', () => {
    // `armed: null` is the store-less server (Sc 11). Rendering it as
    // "HELD" would name a hold that does not exist.
    expect(renderArmed(null, NOW)).toBe('(not reported)');
  });

  it('counts down in days, hours or minutes, and says `now` once it has lapsed', () => {
    expect(formatCountdown(2 * 86_400_000 + 3 * 3_600_000)).toBe('2d 3h');
    expect(formatCountdown(3_600_000 + 23 * 60_000)).toBe('1h 23m');
    expect(formatCountdown(45 * 60_000)).toBe('45m');
    expect(formatCountdown(30_000)).toBe('<1m');
    expect(formatCountdown(0)).toBe('now');
    expect(formatCountdown(-5_000)).toBe('now');
  });

  it('status puts armed and the kill switch beside the S1 fields', () => {
    const out = renderStatus(
      status({
        killSwitch: false,
        armed: {
          armed: true,
          until: '2026-09-03T17:00:00.000Z',
          reason: 'armed',
        },
      }),
      NOW,
    );
    expect(out.split('\n')).toEqual([
      'connection:  fully-connected',
      'armed:       ● ARMED until 2026-09-03T17:00:00.000Z (5h 0m)',
      'kill switch: off',
      'cursor:      none',
      'today:       0 message(s)',
      'adapters:    0',
    ]);
  });

  it('a null killSwitch is not `off` — it is unreported', () => {
    const out = renderStatus(status({ killSwitch: null, armed: null }), NOW);
    expect(out).toContain('kill switch: (not reported)');
    expect(out).toContain('armed:       (not reported)');
  });

  /**
   * THE TEETH ROW (TN-green-armed). The wireframe's armed badge is green;
   * C-9 says the CLI transcript has none, so the dot carries the meaning and
   * uppercase carries the emphasis. Every posture the renderer can reach is
   * swept, because a colour reintroduced on one branch is still a colour.
   */
  it('status transcript contains no ANSI escape', () => {
    const postures: StatusPayload['armed'][] = [
      { armed: true, until: '2026-09-03T17:00:00.000Z', reason: 'armed' },
      { armed: true, until: null, reason: 'armed' },
      { armed: false, until: '2026-09-03T12:30:00.000Z', reason: 'paused' },
      { armed: false, until: null, reason: 'kill-switch' },
      { armed: false, until: null, reason: 'disconnected' },
      { armed: false, until: null, reason: 'read-only' },
      { armed: false, until: null, reason: 'unsupported' },
      { armed: false, until: null, reason: 'outside-window' },
      {
        armed: false,
        until: '2026-09-03T12:05:00.000Z',
        reason: 'circuit-open',
      },
      null,
    ];
    for (const armed of postures) {
      for (const killSwitch of [true, false, null]) {
        const transcript = renderStatus(status({ armed, killSwitch }), NOW);
        expect(transcript, JSON.stringify({ armed, killSwitch })).not.toMatch(
          ANSI_RE,
        );
        expect(renderArmed(armed, NOW)).not.toMatch(ANSI_RE);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// rows 6 and 4a — the two typed confirmations
// ---------------------------------------------------------------------------

describe('typed confirmations for granting autonomy (rows 6, 4a)', () => {
  it('the contact prompt names the handle, twice: in the warning and in the phrase', () => {
    expect(contactAutoPrompt('+15551234567')).toBe(
      'auto lets an agent answer +15551234567 without you. ' +
        'Type "+15551234567" to confirm: ',
    );
    expect(contactAutoPhrase('+15551234567')).toBe('+15551234567');
  });

  it('the global prompt names the blast radius, which is everything', () => {
    expect(GLOBAL_AUTO_PROMPT).toBe(
      'auto lets an agent answer every auto contact and rule without you. ' +
        'Type "enable auto" to confirm: ',
    );
    expect(GLOBAL_AUTO_PHRASE).toBe('enable auto');
  });

  it('confirmation accepts the exact phrase, trimmed, and nothing else', async () => {
    const ask = (answer: string) => ({
      isTTY: true,
      ask: () => Promise.resolve(answer),
    });
    expect(await confirmTyped(ask('enable auto'), GLOBAL_AUTO_PHRASE)).toBe(
      true,
    );
    expect(await confirmTyped(ask('  enable auto\n'), GLOBAL_AUTO_PHRASE)).toBe(
      true,
    );
    expect(await confirmTyped(ask('yes'), GLOBAL_AUTO_PHRASE)).toBe(false);
    expect(await confirmTyped(ask('y'), GLOBAL_AUTO_PHRASE)).toBe(false);
    expect(await confirmTyped(ask('ENABLE AUTO'), GLOBAL_AUTO_PHRASE)).toBe(
      false,
    );
  });

  it('non-TTY stdin refuses without asking — a pipe is not a human', async () => {
    const ask = vi.fn(() => Promise.resolve('enable auto'));
    expect(await confirmTyped({ isTTY: false, ask }, GLOBAL_AUTO_PHRASE)).toBe(
      false,
    );
    // `echo "enable auto" | wemessage mode auto` must not defeat the point.
    expect(ask).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// row 4a (read half) — the current global mode, derived from the audit log
// ---------------------------------------------------------------------------

describe('reading the current global mode (row 4a)', () => {
  function row(mode: string, seq: number): AuditRowPayload {
    return {
      seq,
      at: '2026-09-03T11:00:00.000Z',
      eventJson: JSON.stringify({ type: 'arming.mode-changed', mode }),
      actorJson: JSON.stringify({ kind: 'human', via: 'api' }),
      prevHash: '',
      hash: '',
    };
  }

  it('an empty log means draft-only — the S1 default, never written', () => {
    // F-77: `send.globalMode` had NO writer before Sc 11, so "no row" is not
    // "unknown", it is provably the shipped default.
    expect(resolveGlobalMode([])).toBe('draft-only');
  });

  it('the newest row wins (the route returns seq DESC)', () => {
    expect(resolveGlobalMode([row('auto', 9), row('draft-only', 4)])).toBe(
      'auto',
    );
  });

  it('a row it cannot read falls back to the default rather than guessing', () => {
    const junk: AuditRowPayload = { ...row('auto', 9), eventJson: '{{{' };
    expect(resolveGlobalMode([junk])).toBe('draft-only');
    const wrongShape: AuditRowPayload = {
      ...row('auto', 9),
      eventJson: JSON.stringify({ type: 'arming.mode-changed', mode: 'yolo' }),
    };
    expect(resolveGlobalMode([wrongShape])).toBe('draft-only');
  });
});

// ---------------------------------------------------------------------------
// row 8 — `resume` is the ONE composed verb, and it composes out of what it
// can see
// ---------------------------------------------------------------------------

describe('resume clears the holds that are set, and only those (row 8)', () => {
  interface Spy {
    calls: string[];
    client: ResumeClient;
  }

  function spy(over: Partial<StatusPayload> = {}): Spy {
    const calls: string[] = [];
    return {
      calls,
      client: {
        status: () => {
          calls.push('GET /v1/status');
          return Promise.resolve(status(over));
        },
        setKillSwitch: (on, opts) => {
          calls.push(
            `POST /v1/toggles/kill-switch ${JSON.stringify({ on, ...opts })}`,
          );
          return Promise.resolve({
            key: 'send.killSwitch',
            on,
            version: 2,
            cancelled: [],
            circuitCleared: opts?.circuit === true,
          });
        },
        resume: () => {
          calls.push('POST /v1/toggles/pause {"until":null}');
          return Promise.resolve({
            key: 'pause' as const,
            until: null,
            armed: {
              armed: true,
              until: null,
              reason: 'armed' as const,
            },
          });
        },
      },
    };
  }

  it('with nothing held: one read, zero writes, nothing to report', async () => {
    const s = spy({ killSwitch: false });
    const report = await resumeHolds(s.client, { circuit: false });
    expect(s.calls).toEqual(['GET /v1/status']);
    expect(report).toEqual({
      on: false,
      killSwitchCleared: false,
      pauseCleared: false,
      circuitCleared: null,
      cancelled: [],
    });
    // Zero state-changing calls means zero audit rows, by construction: the
    // daemon writes one for every toggle POST it receives, no-op included.
    expect(s.calls.filter((c) => c.startsWith('POST'))).toEqual([]);
  });

  it('with the kill switch on: two calls, the second lifting it', async () => {
    const s = spy({ killSwitch: true });
    const report = await resumeHolds(s.client, { circuit: false });
    expect(s.calls).toEqual([
      'GET /v1/status',
      'POST /v1/toggles/kill-switch {"on":false}',
    ]);
    expect(report.killSwitchCleared).toBe(true);
    expect(report.pauseCleared).toBe(false);
  });

  it('with a live pause: two calls, and the switch is left alone', async () => {
    const s = spy({
      killSwitch: false,
      armed: {
        armed: false,
        until: '2026-09-03T13:00:00.000Z',
        reason: 'paused',
      },
    });
    const report = await resumeHolds(s.client, { circuit: false });
    expect(s.calls).toEqual([
      'GET /v1/status',
      'POST /v1/toggles/pause {"until":null}',
    ]);
    expect(report.pauseCleared).toBe(true);
    expect(report.killSwitchCleared).toBe(false);
  });

  it('never exceeds three calls, even with everything it can see held', async () => {
    const s = spy({
      killSwitch: true,
      armed: {
        armed: false,
        until: '2026-09-03T13:00:00.000Z',
        reason: 'paused',
      },
    });
    await resumeHolds(s.client, { circuit: true });
    expect(s.calls).toEqual([
      'GET /v1/status',
      'POST /v1/toggles/kill-switch {"on":false,"circuit":true}',
      'POST /v1/toggles/pause {"until":null}',
    ]);
    expect(s.calls).toHaveLength(3);
  });

  it('--circuit always asks, because the breaker is not visible in status', async () => {
    // §1.3.6 precedence collapses to ONE winning reason, so a tripped
    // breaker under any other hold is invisible to `/v1/status`. The flag is
    // an explicit operator request; guessing from a reason we may never see
    // would silently do nothing on exactly the day it mattered.
    const s = spy({ killSwitch: false });
    const report = await resumeHolds(s.client, { circuit: true });
    expect(s.calls).toEqual([
      'GET /v1/status',
      'POST /v1/toggles/kill-switch {"on":false,"circuit":true}',
    ]);
    expect(report.circuitCleared).toBe(true);
  });

  it('renders only the holds it was asked about', () => {
    expect(
      renderResume({
        on: false,
        killSwitchCleared: true,
        pauseCleared: true,
        circuitCleared: false,
        cancelled: [],
      }),
    ).toBe(
      [
        'kill switch: off',
        'pause:       cleared',
        'circuit:     was not open',
      ].join('\n'),
    );
    // No --circuit means the breaker is neither touched nor mentioned.
    expect(
      renderResume({
        on: false,
        killSwitchCleared: true,
        pauseCleared: false,
        circuitCleared: null,
        cancelled: [],
      }),
    ).toBe('kill switch: off');
  });

  it('the resume transcript is monochrome too', () => {
    expect(
      renderResume({
        on: false,
        killSwitchCleared: true,
        pauseCleared: true,
        circuitCleared: true,
        cancelled: [],
      }),
    ).not.toMatch(ANSI_RE);
  });
});
