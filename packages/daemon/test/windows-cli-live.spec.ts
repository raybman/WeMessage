/**
 * s6-execution Scenario 12 (CLI half, live rows) — `wemessage windows`
 * (list / add / edit / rm), the top-level `pause` / `resume` / `mode` verbs,
 * and the typed confirmation on `contacts set <handle> auto`, driven as a
 * real subprocess against a real daemon (§3.8, exit codes 1/2/3/4, C-9).
 *
 * LOCATION DEVIATION (precedent: rules-audit-cli.spec.ts S2 Sc11,
 * send-connect-cli.spec.ts S3 Sc10, drafts-cli.spec.ts S4 Sc11,
 * adapters-cli.spec.ts S5 Sc11): the slice names a packages/cli test, but
 * `nobody-imports-daemon` and `cli-thin-client` in
 * .dependency-cruiser.cjs forbid packages/cli from importing
 * @wemessage/daemon, and these rows need a REAL daemon with a REAL store to
 * count HTTP requests and audit rows. The pure-function rows (table shape,
 * the wrap marker, the armed line, the confirmation copy, the `resume`
 * composition) live where they belong, in
 * packages/cli/test/windows-cli.spec.ts.
 *
 * The two rows that matter most here are both about honesty on the wire:
 *
 *  - **One verb, one HTTP call** (row 8). Every verb below is executed with
 *    a listener on the daemon's own `http.Server`, so the assertion is over
 *    what actually reached the socket, not over what the CLI meant to send.
 *    The single sanctioned exception, `resume`, is asserted at its bound (3)
 *    and at its floor (1 read, 0 writes, 0 audit rows).
 *  - **Autonomy is never granted by accident.** `contacts set … auto` and
 *    `mode auto` both refuse on non-TTY stdin, and the refusal is proven by
 *    reading the state back: the daemon must not have been called at all.
 *
 * This file runs its own no-green sweep (C-9) over every transcript it
 * collects.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { IncomingMessage } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  SETTING_CIRCUIT_OPENED_AT,
  SETTING_GLOBAL_MODE,
  SETTING_KILL_SWITCH,
  SETTING_PAUSE_UNTIL,
  type Clock,
  type FsWatcher,
} from '@wemessage/core';
import { createChatDb, type ChatDbFixture } from '@wemessage/fixtures';
import {
  startDaemon,
  type DoctorProbes,
  type RunningDaemon,
} from '@wemessage/daemon';
import { createLoopbackSendBackend } from './helpers/loopback-backend.js';

const CLI_BIN = fileURLToPath(
  new URL('../../cli/dist/bin.js', import.meta.url),
);
/** Any ANSI escape (covers color incl. green): the no-green rule, strict. */
const ANSI_RE = /\x1b\[/;
const HANDLE = '+15551234567';

const clock: Clock = {
  now: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};

function fakeWatcher(): FsWatcher {
  return {
    watch() {
      return () => {};
    },
  };
}

const probes: DoctorProbes = {
  osMajor: () => 15,
  fda: () => Promise.resolve('ok'),
  automation: () => Promise.resolve('ok'),
  messagesRunning: () => Promise.resolve(true),
};

interface Ctx {
  daemon: RunningDaemon;
  fixture: ChatDbFixture;
  token: string;
  configDir: string;
  dir: string;
}

const cleanups: (() => Promise<void> | void)[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const c of children.splice(0)) c.kill();
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const transcripts: { args: string[]; stdout: string; stderr: string }[] = [];
afterAll(() => {
  expect(transcripts.length).toBeGreaterThan(0);
  for (const t of transcripts) {
    expect(t.stdout, `stdout of ${t.args.join(' ')}`).not.toMatch(ANSI_RE);
    expect(t.stderr, `stderr of ${t.args.join(' ')}`).not.toMatch(ANSI_RE);
  }
});

async function boot(): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'wm-windows-cli-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const chatDbPath = join(dir, 'chat.db');
  const fixture = createChatDb(chatDbPath);
  cleanups.push(() => fixture.close());
  const handleId = fixture.addHandle(HANDLE);
  fixture.addChat({ identifier: HANDLE, handleIds: [handleId] });

  const configDir = join(dir, 'config');
  const daemon = await startDaemon({
    configDir,
    chatDbPath,
    clock,
    watcher: fakeWatcher(),
    doctorProbes: probes,
    backend: createLoopbackSendBackend(fixture, clock),
    backendName: 'loopback',
  });
  cleanups.push(() => daemon.stop());
  const token = daemon.server.token;
  if (token === null) throw new Error('boot: expected a token');
  return { daemon, fixture, token, configDir, dir };
}

function runCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      transcripts.push({ args, stdout, stderr });
      resolve({ code, stdout, stderr });
    });
    child.stdin.end();
  });
}

function envFor(ctx: Ctx): Record<string, string> {
  return {
    WEMESSAGE_PORT: String(ctx.daemon.port),
    WEMESSAGE_TOKEN: ctx.token,
    WEMESSAGE_DIR: ctx.configDir,
  };
}

/**
 * Every request that reaches the daemon's real socket, as `METHOD path`.
 *
 * Attached to the node `http.Server` rather than to fastify, because a
 * fastify hook cannot be added after `listen()` and — more to the point —
 * this observes the WIRE. A CLI that made two calls where the suite expects
 * one has to show up here whatever fastify thinks of them. `app.inject()`
 * (used for test preconditions below) never touches the socket, so setup
 * traffic is invisible to it by construction.
 */
function wireLog(ctx: Ctx): { calls: string[]; stop: () => void } {
  const calls: string[] = [];
  const server = ctx.daemon.server.app.server;
  const onRequest = (req: IncomingMessage): void => {
    calls.push(`${req.method ?? '?'} ${(req.url ?? '').split('?')[0] ?? ''}`);
  };
  server.on('request', onRequest);
  return { calls, stop: () => server.off('request', onRequest) };
}

function auditTypes(ctx: Ctx): string[] {
  return ctx.daemon.store
    .readAuditRows(0, 5000)
    .map((row) => (JSON.parse(row.eventJson) as { type: string }).type);
}

/** `HH:MM` in UTC, offset from now by whole minutes. */
function utcClock(offsetMinutes: number): string {
  const at = new Date(Date.now() + offsetMinutes * 60_000);
  return `${String(at.getUTCHours()).padStart(2, '0')}:${String(
    at.getUTCMinutes(),
  ).padStart(2, '0')}`;
}

async function addWindow(ctx: Ctx, args: string[] = []): Promise<string> {
  const res = await runCli(
    [
      'windows',
      'add',
      '--name',
      'Business hours',
      '--tz',
      'America/Los_Angeles',
      '--window',
      'mon,tue,wed,thu,fri 09:00-17:00',
      '--json',
      ...args,
    ],
    envFor(ctx),
  );
  expect(res.code, res.stderr).toBe(0);
  return (JSON.parse(res.stdout) as { id: string }).id;
}

// ---------------------------------------------------------------------------
// row 2 — the CRUD round trip, F-76's two spellings, and the zone refusal
// ---------------------------------------------------------------------------

describe('wemessage windows (row 2, F-76)', () => {
  it('add, list, edit, rm round-trips a schedule through /v1/schedules', async () => {
    const ctx = await boot();
    const id = await addWindow(ctx);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    const list = await runCli(['windows', 'list'], envFor(ctx));
    expect(list.code, list.stderr).toBe(0);
    expect(list.stdout).toContain('Business hours');
    expect(list.stdout).toContain('America/Los_Angeles');
    expect(list.stdout).toContain('mon,tue,wed,thu,fri 09:00-17:00');

    const edit = await runCli(
      ['windows', 'edit', id, '--name', 'Evenings', '--json'],
      envFor(ctx),
    );
    expect(edit.code, edit.stderr).toBe(0);
    expect((JSON.parse(edit.stdout) as { name: string }).name).toBe('Evenings');

    const rm = await runCli(['windows', 'rm', id], envFor(ctx));
    expect(rm.code, rm.stderr).toBe(0);
    const after = await runCli(['windows', 'list', '--json'], envFor(ctx));
    expect(JSON.parse(after.stdout)).toEqual([]);
  }, 30_000);

  it('the help text names BOTH spellings so the asymmetry is discoverable', async () => {
    const ctx = await boot();
    const help = await runCli(['windows', '--help'], envFor(ctx));
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('windows');
    expect(help.stdout).toContain('/v1/schedules');
  }, 20_000);

  it('--tz is required on add, and the refusal never reaches the wire', async () => {
    const ctx = await boot();
    const log = wireLog(ctx);
    const res = await runCli(
      ['windows', 'add', '--name', 'No zone', '--window', 'mon 09:00-17:00'],
      envFor(ctx),
    );
    log.stop();
    expect(res.code).toBe(2);
    expect(res.stderr.toLowerCase()).toContain('--tz');
    expect(log.calls).toEqual([]);
  }, 20_000);

  it('an unknown zone is refused with the zone named back', async () => {
    const ctx = await boot();
    const res = await runCli(
      [
        'windows',
        'add',
        '--name',
        'Nowhere',
        '--tz',
        'Mars/Olympus_Mons',
        '--window',
        'mon 09:00-17:00',
      ],
      envFor(ctx),
    );
    expect(res.code).toBe(1);
    // "invalid timezone" alone sends an operator hunting; the string they
    // typed is the entire actionable content of the refusal.
    expect(res.stderr).toContain('Mars/Olympus_Mons');
    expect(auditTypes(ctx)).not.toContain('schedule.created');
  }, 20_000);

  it('a malformed --window is a usage error, refused before the wire', async () => {
    const ctx = await boot();
    const log = wireLog(ctx);
    const res = await runCli(
      [
        'windows',
        'add',
        '--name',
        'Bad',
        '--tz',
        'UTC',
        '--window',
        'funday 09:00-17:00',
      ],
      envFor(ctx),
    );
    log.stop();
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('funday');
    expect(log.calls).toEqual([]);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// row 4 — pause is a top-level verb, in all four of its forms
// ---------------------------------------------------------------------------

describe('wemessage pause / resume (row 4)', () => {
  it('there is no `toggles` noun — pause sits beside kill and resume', async () => {
    const ctx = await boot();
    const help = await runCli(['--help'], envFor(ctx));
    expect(help.stdout).toMatch(/^\s*pause /m);
    expect(help.stdout).toMatch(/^\s*resume/m);
    expect(help.stdout).toMatch(/^\s*kill/m);
    expect(help.stdout).not.toContain('toggles');
  }, 20_000);

  it('pause 1h persists a deadline about an hour out', async () => {
    const ctx = await boot();
    const before = Date.now();
    const res = await runCli(['pause', '1h'], envFor(ctx));
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain('paused:');
    const until = ctx.daemon.store.getSetting(SETTING_PAUSE_UNTIL);
    expect(until).not.toBeNull();
    const deltaMin = (Date.parse(String(until)) - before) / 60_000;
    expect(deltaMin).toBeGreaterThan(58);
    expect(deltaMin).toBeLessThan(62);
    expect(auditTypes(ctx)).toContain('arming.paused');
  }, 20_000);

  it('pause <iso> takes a literal instant', async () => {
    const ctx = await boot();
    const at = new Date(Date.now() + 7_200_000).toISOString();
    const res = await runCli(['pause', at], envFor(ctx));
    expect(res.code, res.stderr).toBe(0);
    expect(ctx.daemon.store.getSetting(SETTING_PAUSE_UNTIL)).toBe(at);
  }, 20_000);

  it('pause until-tomorrow lands on a future instant, computed daemon-side', async () => {
    const ctx = await boot();
    const res = await runCli(['pause', 'until-tomorrow'], envFor(ctx));
    expect(res.code, res.stderr).toBe(0);
    const until = ctx.daemon.store.getSetting(SETTING_PAUSE_UNTIL);
    expect(Date.parse(String(until))).toBeGreaterThan(Date.now());
    // At most 32 hours out: the next 08:00 in the daemon host's own zone.
    expect(Date.parse(String(until)) - Date.now()).toBeLessThan(32 * 3_600_000);
  }, 20_000);

  it('pause rest-of-window rests out the live window', async () => {
    const ctx = await boot();
    // The window dimension is read from ENABLED RULES' schedules, so the
    // precondition is a rule pointing at a schedule that is open right now.
    // Built through the daemon's own routes (injected, so it never shows up
    // in a wireLog) rather than by writing rows behind the API's back.
    const schedule = await ctx.daemon.server.app.inject({
      method: 'POST',
      url: '/v1/schedules',
      headers: { authorization: `Bearer ${ctx.token}` },
      payload: {
        name: 'Open now',
        timezone: 'UTC',
        windows: [
          {
            days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
            start: utcClock(-60),
            end: utcClock(60),
          },
        ],
      },
    });
    expect(schedule.statusCode).toBe(201);
    const scheduleId = (schedule.json() as { schedule: { id: string } })
      .schedule.id;
    const rule = await ctx.daemon.server.app.inject({
      method: 'POST',
      url: '/v1/rules',
      headers: { authorization: `Bearer ${ctx.token}` },
      payload: {
        name: 'Office hours',
        adapterId: 'human',
        matcher: { kind: 'keyword', keywords: ['hello'], mode: 'any' },
        scheduleId,
      },
    });
    expect(rule.statusCode).toBe(201);

    const res = await runCli(['pause', 'rest-of-window'], envFor(ctx));
    expect(res.code, res.stderr).toBe(0);
    const until = Date.parse(
      String(ctx.daemon.store.getSetting(SETTING_PAUSE_UNTIL)),
    );
    const minutesOut = (until - Date.now()) / 60_000;
    expect(minutesOut).toBeGreaterThan(30);
    expect(minutesOut).toBeLessThan(90);
  }, 30_000);

  it('rest-of-window with no window refuses, and sends you to the schedule', async () => {
    const ctx = await boot();
    const res = await runCli(['pause', 'rest-of-window'], envFor(ctx));
    // A well-formed request this daemon's state cannot satisfy: exit 1, not
    // the usage code, and no pause written.
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('not-armed');
    expect(ctx.daemon.store.getSetting(SETTING_PAUSE_UNTIL)).toBeNull();
  }, 20_000);

  it('an unparseable deadline is refused with the string that was typed', async () => {
    const ctx = await boot();
    const res = await runCli(['pause', 'next-tuesday-ish'], envFor(ctx));
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('next-tuesday-ish');
    expect(ctx.daemon.store.getSetting(SETTING_PAUSE_UNTIL)).toBeNull();
  }, 20_000);

  it('resume clears the kill switch AND a live pause in one verb', async () => {
    const ctx = await boot();
    expect((await runCli(['kill'], envFor(ctx))).code).toBe(0);
    // Written directly: the kill switch outranks a pause in §1.3.6, so the
    // route-level path to "both held at once" runs through the store.
    ctx.daemon.store.setSetting(
      SETTING_PAUSE_UNTIL,
      new Date(Date.now() + 3_600_000).toISOString(),
    );
    expect(ctx.daemon.store.getSetting(SETTING_KILL_SWITCH)).toBe('1');

    const res = await runCli(['resume'], envFor(ctx));
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain('kill switch: off');
    expect(ctx.daemon.store.getSetting(SETTING_KILL_SWITCH)).toBe('0');
  }, 20_000);

  it('resume clears a pause with the switch never on, and says which hold it lifted', async () => {
    const ctx = await boot();
    expect((await runCli(['pause', '1h'], envFor(ctx))).code).toBe(0);
    const res = await runCli(['resume'], envFor(ctx));
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain('kill switch: off');
    expect(res.stdout).toContain('pause:       cleared');
    expect(ctx.daemon.store.getSetting(SETTING_PAUSE_UNTIL)).toBeNull();
    expect(auditTypes(ctx)).toContain('arming.resumed');
  }, 20_000);

  it('resume --circuit clears the breaker alongside the switch', async () => {
    const ctx = await boot();
    ctx.daemon.store.setSetting(
      SETTING_CIRCUIT_OPENED_AT,
      new Date().toISOString(),
    );
    const res = await runCli(['resume', '--circuit'], envFor(ctx));
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain('circuit:     reset');
    expect(ctx.daemon.store.getSetting(SETTING_CIRCUIT_OPENED_AT)).toBeNull();
  }, 20_000);
});

// ---------------------------------------------------------------------------
// row 4a — the global mode
// ---------------------------------------------------------------------------

describe('wemessage mode (row 4a, F-77)', () => {
  it('with no argument it prints the current mode, which ships as draft-only', async () => {
    const ctx = await boot();
    const res = await runCli(['mode'], envFor(ctx));
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain('draft-only');
    const json = await runCli(['mode', '--json'], envFor(ctx));
    expect(JSON.parse(json.stdout)).toEqual({ mode: 'draft-only' });
  }, 20_000);

  it('mode auto on non-TTY stdin refuses, and never reaches the daemon', async () => {
    const ctx = await boot();
    const log = wireLog(ctx);
    const res = await runCli(['mode', 'auto'], envFor(ctx));
    log.stop();
    expect(res.code).toBe(2);
    expect(log.calls).toEqual([]);
    expect(ctx.daemon.store.getSetting(SETTING_GLOBAL_MODE)).not.toBe('auto');
    expect(auditTypes(ctx)).not.toContain('arming.mode-changed');
  }, 20_000);

  it('mode auto --yes grants it, and `mode` then reads it back', async () => {
    const ctx = await boot();
    const set = await runCli(['mode', 'auto', '--yes'], envFor(ctx));
    expect(set.code, set.stderr).toBe(0);
    expect(set.stdout).toContain('auto');
    expect(ctx.daemon.store.getSetting(SETTING_GLOBAL_MODE)).toBe('auto');
    expect(auditTypes(ctx)).toContain('arming.mode-changed');

    const read = await runCli(['mode', '--json'], envFor(ctx));
    expect(JSON.parse(read.stdout)).toEqual({ mode: 'auto' });
  }, 20_000);

  it('withdrawing autonomy needs no ceremony — draft-only never prompts', async () => {
    const ctx = await boot();
    expect((await runCli(['mode', 'auto', '--yes'], envFor(ctx))).code).toBe(0);
    const res = await runCli(['mode', 'draft-only'], envFor(ctx));
    expect(res.code, res.stderr).toBe(0);
    expect(ctx.daemon.store.getSetting(SETTING_GLOBAL_MODE)).toBe('draft-only');
  }, 20_000);

  it('an unknown mode is a usage error, refused before the wire', async () => {
    const ctx = await boot();
    const log = wireLog(ctx);
    const res = await runCli(['mode', 'yolo'], envFor(ctx));
    log.stop();
    expect(res.code).toBe(2);
    expect(log.calls).toEqual([]);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// row 6 — contacts set <handle> auto now costs a typed confirmation
// ---------------------------------------------------------------------------

describe('wemessage contacts set … auto (row 6)', () => {
  it('auto on non-TTY stdin refuses, and the contact stays unknown', async () => {
    const ctx = await boot();
    const log = wireLog(ctx);
    const res = await runCli(['contacts', 'set', HANDLE, 'auto'], envFor(ctx));
    log.stop();
    expect(res.code).toBe(2);
    expect(res.stderr).toContain(HANDLE);
    expect(log.calls).toEqual([]);
    const list = await runCli(['contacts', 'list', '--json'], envFor(ctx));
    expect(JSON.parse(list.stdout)).toEqual([]);
  }, 20_000);

  it('auto --yes is the scripting path, and it works', async () => {
    const ctx = await boot();
    const res = await runCli(
      ['contacts', 'set', HANDLE, 'auto', '--yes'],
      envFor(ctx),
    );
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain('auto');
    const list = await runCli(['contacts', 'list', '--json'], envFor(ctx));
    expect(JSON.parse(list.stdout)).toMatchObject([
      { handle: HANDLE, mode: 'auto' },
    ]);
  }, 20_000);

  it('deny and draft-only are unchanged and prompt for nothing', async () => {
    const ctx = await boot();
    for (const mode of ['deny', 'draft-only'] as const) {
      const res = await runCli(['contacts', 'set', HANDLE, mode], envFor(ctx));
      expect(res.code, res.stderr).toBe(0);
      expect(res.stdout).toContain(mode);
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------
// rows 5 and 8 — the armed line on the wire, and one verb one call
// ---------------------------------------------------------------------------

describe('status renders the arming posture (row 5)', () => {
  it('shows the filled dot, the state and the kill switch, with no colour', async () => {
    const ctx = await boot();
    const res = await runCli(['status'], envFor(ctx));
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain('armed:');
    expect(res.stdout).toContain('kill switch: off');
    expect(res.stdout).toMatch(/armed:\s+[●○] [A-Z]/);
    expect(res.stdout).not.toMatch(ANSI_RE);
  }, 20_000);

  it('a held daemon renders the hollow dot and the winning reason', async () => {
    const ctx = await boot();
    expect((await runCli(['kill'], envFor(ctx))).code).toBe(0);
    const res = await runCli(['status'], envFor(ctx));
    expect(res.stdout).toContain('○ HELD: kill-switch');
    expect(res.stdout).toContain('kill switch: on');
    expect(res.stdout).not.toMatch(ANSI_RE);
  }, 20_000);
});

describe('the CLI is a thin wrapper: one verb, one HTTP call (row 8)', () => {
  it('every S6 verb maps to exactly one call on the wire', async () => {
    const ctx = await boot();
    const id = await addWindow(ctx);
    const env = envFor(ctx);

    const cases: { args: string[]; expected: string }[] = [
      { args: ['status'], expected: 'GET /v1/status' },
      { args: ['windows', 'list'], expected: 'GET /v1/schedules' },
      {
        args: ['windows', 'edit', id, '--name', 'X'],
        expected: 'PATCH /v1/schedules/' + id,
      },
      { args: ['pause', '1h'], expected: 'POST /v1/toggles/pause' },
      { args: ['mode'], expected: 'GET /v1/audit' },
      {
        args: ['mode', 'auto', '--yes'],
        expected: 'POST /v1/toggles/global-mode',
      },
      { args: ['kill'], expected: 'POST /v1/toggles/kill-switch' },
      {
        args: ['contacts', 'set', HANDLE, 'auto', '--yes'],
        expected: `PUT /v1/contacts/${encodeURIComponent(HANDLE)}`,
      },
      { args: ['windows', 'rm', id], expected: 'DELETE /v1/schedules/' + id },
    ];

    for (const { args, expected } of cases) {
      const log = wireLog(ctx);
      const res = await runCli(args, env);
      log.stop();
      expect(res.code, `${args.join(' ')}: ${res.stderr}`).toBe(0);
      expect(log.calls, args.join(' ')).toEqual([expected]);
    }
  }, 60_000);

  it('resume with nothing held: one read, zero writes, zero audit rows', async () => {
    const ctx = await boot();
    const before = auditTypes(ctx).length;
    const log = wireLog(ctx);
    const res = await runCli(['resume'], envFor(ctx));
    log.stop();
    expect(res.code, res.stderr).toBe(0);
    expect(log.calls).toEqual(['GET /v1/status']);
    // The daemon audits EVERY toggle POST it receives, no-op included, so a
    // resume that "cleared" holds nobody was holding would be visible here
    // as noise an operator has to explain later.
    expect(auditTypes(ctx).length).toBe(before);
  }, 20_000);

  it('resume never exceeds its named budget of three calls', async () => {
    const ctx = await boot();
    expect((await runCli(['kill'], envFor(ctx))).code).toBe(0);
    ctx.daemon.store.setSetting(
      SETTING_PAUSE_UNTIL,
      new Date(Date.now() + 3_600_000).toISOString(),
    );
    ctx.daemon.store.setSetting(
      SETTING_CIRCUIT_OPENED_AT,
      new Date().toISOString(),
    );
    const log = wireLog(ctx);
    const res = await runCli(['resume', '--circuit'], envFor(ctx));
    log.stop();
    expect(res.code, res.stderr).toBe(0);
    expect(log.calls.length).toBeLessThanOrEqual(3);
    expect(log.calls[0]).toBe('GET /v1/status');
  }, 20_000);
});
