/**
 * s4-execution Scenario 11 (CLI half) — `drafts` / `contacts` / `kill` /
 * `resume` (§3.8, exit codes 1/2/5, C-8, F-32, F-37).
 *
 * LOCATION DEVIATION (precedent: rules-audit-cli.spec.ts S2 Sc11,
 * send-connect-cli.spec.ts S3 Sc10): the slice names a packages/cli test, but
 * `nobody-imports-daemon` and `cli-desktop-thin-clients` in
 * .dependency-cruiser.cjs forbid packages/cli from importing @wemessage/daemon,
 * and these rows need a REAL daemon to answer real HTTP. So the spec lives
 * beside its two predecessors.
 *
 * This file runs its own no-green sweep (C-8) over every transcript it
 * collects, so the new S4 verbs are covered by the same rule as the S1-S3 ones.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { Clock, FsWatcher } from '@wemessage/core';
import {
  SETTING_CIRCUIT_OPENED_AT,
  SETTING_UNDO_GRACE_SECONDS,
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

const CHAT = 'iMessage;-;+15551234567';
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

/** All-green probes: this file is about drafts, not preflight (§1.3.7). */
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
  const dir = mkdtempSync(join(tmpdir(), 'wm-drafts-cli-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const chatDbPath = join(dir, 'chat.db');
  const fixture = createChatDb(chatDbPath);
  cleanups.push(() => fixture.close());
  // A real 1:1 chat, without which every dispatch parks on `no-conversation`.
  const handleId = fixture.addHandle(HANDLE);
  fixture.addChat({ identifier: HANDLE, handleIds: [handleId] });

  const daemon = await startDaemon({
    configDir: join(dir, 'config'),
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
  return { daemon, fixture, token };
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
  };
}

async function newDraft(ctx: Ctx, body: string): Promise<string> {
  const res = await runCli(
    ['drafts', 'create', '--chat', CHAT, '--body', body, '--json'],
    envFor(ctx),
  );
  expect(res.code, res.stderr).toBe(0);
  return (JSON.parse(res.stdout) as { id: string }).id;
}

describe('wemessage drafts (§3.8)', () => {
  it('create (dev) then list: fenced monochrome table carries the draft', async () => {
    const ctx = await boot();
    const id = await newDraft(ctx, 'hello from the cli');

    const help = await runCli(['drafts', 'create', '--help'], envFor(ctx));
    expect(help.stdout).toContain('(dev)');

    const list = await runCli(['drafts', 'list'], envFor(ctx));
    expect(list.code).toBe(0);
    expect(list.stdout).toContain('ID');
    expect(list.stdout).toContain(id);
    expect(list.stdout).toContain('pending');
    expect(list.stdout).toContain('hello from the cli');
  });

  it('list --state filters, and --json is machine-readable', async () => {
    const ctx = await boot();
    const keep = await newDraft(ctx, 'keep me');
    const gone = await newDraft(ctx, 'reject me');
    expect((await runCli(['drafts', 'reject', gone], envFor(ctx))).code).toBe(
      0,
    );

    const res = await runCli(
      ['drafts', 'list', '--state', 'rejected', '--json'],
      envFor(ctx),
    );
    expect(res.code).toBe(0);
    const rows = JSON.parse(res.stdout) as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual([gone]);
    expect(rows.map((r) => r.id)).not.toContain(keep);
  });

  it('show prints the draft plus its approval count', async () => {
    const ctx = await boot();
    const id = await newDraft(ctx, 'show me');
    const res = await runCli(['drafts', 'show', id], envFor(ctx));
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(id);
    expect(res.stdout).toContain('show me');
    expect(res.stdout).toContain('approvals: 0');
  });

  it('approve --edit replaces the body; recall pulls it back in-grace', async () => {
    const ctx = await boot();
    const id = await newDraft(ctx, 'original text');

    const approve = await runCli(
      ['drafts', 'approve', id, '--edit', 'edited text', '--json'],
      envFor(ctx),
    );
    expect(approve.code).toBe(0);
    const approved = JSON.parse(approve.stdout) as {
      draft: { state: string; body: string; originalBody: string };
    };
    expect(approved.draft.state).toBe('approved');
    expect(approved.draft.body).toBe('edited text');
    expect(approved.draft.originalBody).toBe('original text');

    const recall = await runCli(
      ['drafts', 'recall', id, '--json'],
      envFor(ctx),
    );
    expect(recall.code).toBe(0);
    expect(
      (JSON.parse(recall.stdout) as { draft: { state: string } }).draft.state,
    ).toBe('recalled');
  });

  it('redraft mints a fresh pending draft from a rejected one', async () => {
    const ctx = await boot();
    const id = await newDraft(ctx, 'try again later');
    await runCli(['drafts', 'reject', id, '--reason', 'not now'], envFor(ctx));

    const res = await runCli(['drafts', 'redraft', id, '--json'], envFor(ctx));
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout) as {
      fromDraftId: string;
      draft: { id: string; state: string; body: string };
    };
    expect(out.fromDraftId).toBe(id);
    expect(out.draft.id).not.toBe(id);
    expect(out.draft.state).toBe('pending');
    expect(out.draft.body).toBe('try again later');
  });

  it('approve --all without --wait prints the batch id and exits 0', async () => {
    const ctx = await boot();
    await newDraft(ctx, 'batch one');
    await newDraft(ctx, 'batch two');
    const res = await runCli(['drafts', 'approve', '--all'], envFor(ctx));
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('batch:');
    expect(res.stdout).toContain('approved:  2 of 2');
  });

  it('approve --all --wait polls batchReport until it settles (F-37)', async () => {
    const ctx = await boot();
    // F-32: a zero grace window means the scheduler may dispatch on the very
    // next tick, so --wait terminates without the test faking time.
    ctx.daemon.store.setSetting(SETTING_UNDO_GRACE_SECONDS, '0', clock.now());
    await newDraft(ctx, 'wait one');
    await newDraft(ctx, 'wait two');

    // The CLI cannot tick the daemon; this test drives the scheduler while the
    // subprocess polls.
    const ticker = setInterval(() => void ctx.daemon.tick(), 20);
    try {
      const res = await runCli(
        ['drafts', 'approve', '--all', '--wait'],
        envFor(ctx),
      );
      expect(res.code, res.stderr).toBe(0);
      expect(res.stdout).toContain('sent:      2');
      expect(res.stdout).toContain('failed:    0');
      expect(res.stdout).toContain('recalled:  0');
    } finally {
      clearInterval(ticker);
    }
  }, 20_000);
});

describe('wemessage contacts (§2.4.3)', () => {
  it('set, list, then rm round-trips a contact policy', async () => {
    const ctx = await boot();
    const set = await runCli(
      ['contacts', 'set', HANDLE, 'draft-only'],
      envFor(ctx),
    );
    expect(set.code).toBe(0);
    expect(set.stdout).toContain('draft-only');

    const list = await runCli(['contacts', 'list'], envFor(ctx));
    expect(list.stdout).toContain(HANDLE);

    expect((await runCli(['contacts', 'rm', HANDLE], envFor(ctx))).code).toBe(
      0,
    );
    const after = await runCli(['contacts', 'list', '--json'], envFor(ctx));
    expect(JSON.parse(after.stdout)).toEqual([]);
  });

  it('an unknown mode is a usage error (exit 2), not a server round-trip', async () => {
    const ctx = await boot();
    const res = await runCli(['contacts', 'set', HANDLE, 'yolo'], envFor(ctx));
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('deny, draft-only or auto');
  });
});

describe('wemessage kill / resume', () => {
  it('kill cancels in-grace drafts; resume lifts it without reviving them', async () => {
    const ctx = await boot();
    const id = await newDraft(ctx, 'caught by the kill switch');
    await runCli(['drafts', 'approve', id], envFor(ctx));

    const kill = await runCli(['kill'], envFor(ctx));
    expect(kill.code).toBe(0);
    expect(kill.stdout).toContain('kill switch: on');
    expect(kill.stdout).toContain('cancelled:   1 draft(s)');

    const resume = await runCli(['resume'], envFor(ctx));
    expect(resume.code).toBe(0);
    expect(resume.stdout).toContain('kill switch: off');
    const show = await runCli(['drafts', 'show', id, '--json'], envFor(ctx));
    expect(
      (JSON.parse(show.stdout) as { draft: { state: string } }).draft.state,
    ).toBe('rejected');
  });

  // s6 Scenario 7 row 7. This row used to assert the honest refusal
  // (`--circuit is not available yet`); the breaker has landed, so it now
  // asserts the verb it was holding the place for.
  it('resume --circuit resets an open breaker, and says so when there was none', async () => {
    const ctx = await boot();
    // The breaker's entire state is one settings row holding one instant
    // (F-61), so an open breaker is exactly this and a test does not need to
    // manufacture five real send failures to have one.
    ctx.daemon.store.setSetting(
      SETTING_CIRCUIT_OPENED_AT,
      new Date().toISOString(),
    );

    const reset = await runCli(['resume', '--circuit'], envFor(ctx));
    expect(reset.code).toBe(0);
    expect(reset.stdout).toContain('kill switch: off');
    expect(reset.stdout).toContain('circuit:     reset');
    expect(ctx.daemon.store.getSetting(SETTING_CIRCUIT_OPENED_AT)).toBeNull();
    // And it is on the record, not just gone from `settings`: a hold being
    // released is a posture change, whoever released it.
    expect(
      ctx.daemon.store
        .readAuditRows(0, 2000)
        .map((row) => JSON.parse(row.eventJson) as { type: string }),
    ).toContainEqual({
      type: 'toggle.changed',
      key: 'send.circuitOpen',
      on: false,
    });

    // Idempotent, and honest about it: resetting a hold that is not held is a
    // silent no-op on the server and a different word here, so an operator
    // never reads "reset" as evidence the breaker had tripped.
    const again = await runCli(['resume', '--circuit', '--json'], envFor(ctx));
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({
      on: false,
      circuitCleared: false,
    });
  });

  it('plain resume lifts the switch and leaves an open breaker open', async () => {
    const ctx = await boot();
    const openedAt = new Date().toISOString();
    ctx.daemon.store.setSetting(SETTING_CIRCUIT_OPENED_AT, openedAt);

    const res = await runCli(['resume'], envFor(ctx));
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('kill switch: off');
    // Two independent holds: the operator asked about one of them, so the
    // other is neither touched nor mentioned.
    expect(res.stdout).not.toContain('circuit');
    expect(ctx.daemon.store.getSetting(SETTING_CIRCUIT_OPENED_AT)).toBe(
      openedAt,
    );
  });
});

describe('exit codes (§3.8)', () => {
  it('an illegal transition exits 1 and names the state it actually was', async () => {
    const ctx = await boot();
    const id = await newDraft(ctx, 'cannot retry a pending draft');
    const res = await runCli(['drafts', 'retry', id], envFor(ctx));
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('pending');
  });

  it('approving during a kill switch is gate-denied: exit 5', async () => {
    const ctx = await boot();
    const id = await newDraft(ctx, 'denied by the kill switch');
    expect((await runCli(['kill'], envFor(ctx))).code).toBe(0);
    const res = await runCli(['drafts', 'approve', id], envFor(ctx));
    expect(res.code).toBe(5);
  });

  it('both <id> and --all is a usage error (exit 2)', async () => {
    const ctx = await boot();
    const id = await newDraft(ctx, 'ambiguous');
    const res = await runCli(['drafts', 'approve', id, '--all'], envFor(ctx));
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('exactly one of');
  });
});
