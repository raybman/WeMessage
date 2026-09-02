/**
 * Scenario 11 — client SDK + CLI rules/audit command groups (s2-execution
 * Part 2 Scenario 11). Compiled bin via child_process against an in-test
 * daemon on an ephemeral port with WEMESSAGE_TOKEN — the S1 Scenario 11 CLI
 * harness (tail-pipeline.spec.ts runCli), reused.
 *
 * LOCATION DEVIATION (flagged in the Scenario 11 report): the spec names
 * `packages/cli/test/rules-audit-cli.spec.ts`, but an in-test daemon there is
 * structurally impossible under the repo's own binding constraints:
 *  - `nobody-imports-daemon` (.dependency-cruiser.cjs, INV-1/§3.1) covers
 *    packages/cli/test — only the thin-client rule is /src-scoped;
 *  - Gate 4 (s2 §4.1) forbids new entries in ANY package.json dependency
 *    list, so cli cannot gain @wemessage/daemon or @wemessage/fixtures
 *    devDeps;
 *  - `main.js` hard-crashes without a real chat.db (SQLITE_CANTOPEN), so a
 *    no-import spawn harness would need subprocess string-import shims.
 * The S1 CLI harness this scenario says to reuse lives in
 * packages/daemon/test by that same design, so this spec lives beside it.
 *
 * CLI surface under test (§3.8 verbs + the two S2-scoped additions):
 *  - `wemessage rules list|show|add|edit|rm|enable|disable` — add takes
 *    `--name --adapter` and exactly one matcher source: `--keyword <csv>
 *    [--mode any|all] [--case-sensitive] [--whole-word]` | `--regex <p>` |
 *    `--contact <csv>` | `--matcher-json` (combinator escape hatch); plus
 *    `--priority`, `--ttl`; edit mirrors via PATCH (§1.6 route 4);
 *  - `wemessage rules test --rule <id> --message "text" [--handle h]`
 *    (§1.3.2 verbatim surface);
 *  - `wemessage rules dryrun <id> [--limit N]` (F-18, thin wrapper over
 *    §1.6 route 7);
 *  - `wemessage audit list [--since t] [--event e] [--json]` and
 *    `wemessage audit verify [--json]` (§3.8; routes 8-9, F-19).
 *
 * Contracts pinned here:
 *  - `--json` stable output on EVERY verb; unary JSON documents, not NDJSON
 *    (spec: "these are unary"); human renders exist but are not
 *    golden-locked (S1 precedent) — asserted only loosely.
 *  - exit codes (§3.8): 0 success; `audit verify` exits 1 on a broken chain
 *    WITH the break report on stdout; 2 usage (bad flag combos, e.g.
 *    --keyword with --regex); 3 daemon unreachable; 4 bad bearer.
 *  - no green in any CLI output: asserted as NO ANSI escape sequences at
 *    all, on every stdout/stderr this suite collects (afterAll sweep —
 *    stricter than "no green", recorded as a decision).
 *
 * Recorded decisions (report + hold):
 *  - `rules test` exits 0 on a no-match verdict: the operation succeeded,
 *    the verdict is the output (§3.8 exit 1 means the operation failed).
 *  - `rules rm --json` prints {"deleted":"<id>"} (DELETE is a 204; every
 *    verb still needs a stable --json document).
 *  - add/edit/enable/disable --json print the §1.6 write envelope
 *    {rule, adapterKnown} verbatim (adapterKnown:false advisory, F-14).
 *  - edit exposes exactly add's flags (spec: "edit mirrors via PATCH");
 *    `enabled` flips stay on the dedicated enable/disable verbs.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { Clock, Message } from '@wemessage/core';
import { openStore, type SqliteStore } from '@wemessage/store';
import { buildServer, startServer, type DaemonServer } from '@wemessage/daemon';
import type {
  AuditRowPayload,
  AuditVerifyResult,
  DryRunResult,
  RulePayload,
  RuleTestResult,
  RuleWriteResult,
} from '@wemessage/client';

const CLI_BIN = fileURLToPath(
  new URL('../../cli/dist/bin.js', import.meta.url),
);
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const T0 = '2026-09-01T12:00:00.000Z';
/** Any ANSI escape (covers color incl. green): the no-green rule, strict. */
const ANSI_RE = /\u001b\[/;

const dirs: string[] = [];
const servers: DaemonServer[] = [];
const stores: SqliteStore[] = [];
const children: ChildProcess[] = [];
/** Every CLI transcript, swept by the afterAll no-ANSI assertion. */
const transcripts: { args: string[]; stdout: string; stderr: string }[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const s of servers.splice(0)) await s.app.close();
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) {
    chmodSync(d, 0o700);
    rmSync(d, { recursive: true, force: true });
  }
});

afterAll(() => {
  // No green in any CLI output — the rule covers ANSI, so pin the strict
  // superset: zero ANSI escape sequences anywhere the CLI ever wrote.
  expect(transcripts.length).toBeGreaterThan(0);
  for (const t of transcripts) {
    expect(t.stdout, `ANSI in stdout of ${t.args.join(' ')}`).not.toMatch(
      ANSI_RE,
    );
    expect(t.stderr, `ANSI in stderr of ${t.args.join(' ')}`).not.toMatch(
      ANSI_RE,
    );
  }
});

interface ClockCtl {
  clock: Clock;
  advance(ms: number): void;
}

function fakeClock(startIso = T0): ClockCtl {
  let now = new Date(startIso).getTime();
  return {
    clock: {
      now: () => new Date(now).toISOString(),
      nowMs: () => now,
    },
    advance(ms: number) {
      now += ms;
    },
  };
}

interface Ctx {
  server: DaemonServer;
  store: SqliteStore;
  clockCtl: ClockCtl;
  env: Record<string, string>;
}

async function boot(): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'wm-rules-cli-'));
  dirs.push(dir);
  const clockCtl = fakeClock();
  const store = openStore({ dir, clock: clockCtl.clock });
  stores.push(store);
  // buildServer with rules (no injected sink) wires the REAL store-backed
  // audit sink (server.ts) — CLI rule ops append real §2.4.4 audit rows.
  const server = await buildServer({
    configDir: dir,
    rules: { store, clock: clockCtl.clock },
  });
  servers.push(server);
  const port = await startServer(server);
  if (server.token === null) throw new Error('harness: no token');
  return {
    server,
    store,
    clockCtl,
    env: { WEMESSAGE_PORT: String(port), WEMESSAGE_TOKEN: server.token },
  };
}

/** Spawn the real compiled CLI bin (§3.8) and collect stdout/exit. */
function runCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      env: { ...process.env, ...env },
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
  });
}

/** run + assert exit 0 + parse stdout as ONE JSON document (unary --json). */
async function cliJson<T>(
  args: string[],
  env: Record<string, string>,
): Promise<T> {
  const res = await runCli(args, env);
  expect(res.code, `exit of ${args.join(' ')}\nstderr: ${res.stderr}`).toBe(0);
  return JSON.parse(res.stdout) as T;
}

function seedInbound(
  store: SqliteStore,
  clockCtl: ClockCtl,
  rows: { guid: string; text: string | null }[],
): void {
  rows.forEach((row, idx) => {
    clockCtl.advance(1_000);
    const at = clockCtl.clock.now();
    const message: Message = {
      guid: row.guid,
      sourceRowid: idx + 1,
      chatGuid: 'iMessage;-;+15550009999',
      handle: '+15550009999',
      isFromMe: false,
      isGroup: false,
      service: 'imessage',
      kind: row.text === null ? 'attachment-only' : 'text',
      text: row.text,
      attachments: row.text === null ? ['IMG_0001.heic'] : [],
      sentAt: at,
      receivedAt: at,
    };
    store.insertInboundMessage(message);
  });
}

// ---------------------------------------------------------------------------
// rules group (§3.8 verbs; routes 1-7)
// ---------------------------------------------------------------------------

describe('wemessage rules — CRUD verbs (§3.8, §1.6 routes 1-5)', () => {
  it('add --keyword creates with §2.3 defaults; list/show --json round-trip', async () => {
    const ctx = await boot();
    const created = await cliJson<RuleWriteResult>(
      [
        'rules',
        'add',
        '--name',
        'lunch',
        '--adapter',
        'echo',
        '--keyword',
        'tacos,burrito',
        '--mode',
        'any',
        '--json',
      ],
      ctx.env,
    );
    expect(created.adapterKnown).toBe(false); // F-14 advisory
    expect(created.rule.id).toMatch(ULID_RE);
    expect(created.rule).toEqual({
      id: created.rule.id,
      name: 'lunch',
      matcher: { kind: 'keyword', keywords: ['tacos', 'burrito'], mode: 'any' },
      adapterId: 'echo',
      // §2.3 rules-DDL defaults — cited, not invented
      respondMode: 'draft-only',
      scheduleId: null,
      outsideWindow: 'draft-only',
      allowGroupDrafts: false,
      matchAttachmentOnly: false,
      draftTtlMinutes: 240,
      priority: 100,
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
    });

    const listed = await cliJson<RulePayload[]>(
      ['rules', 'list', '--json'],
      ctx.env,
    );
    expect(listed).toEqual([created.rule]);

    const shown = await cliJson<RulePayload>(
      ['rules', 'show', created.rule.id, '--json'],
      ctx.env,
    );
    expect(shown).toEqual(created.rule);

    // human render exists (not golden-locked): id visible, exit 0
    const human = await runCli(['rules', 'show', created.rule.id], ctx.env);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain(created.rule.id);
  }, 20_000);

  it('add --regex / --contact / --matcher-json + --priority/--ttl/--case-sensitive/--whole-word', async () => {
    const ctx = await boot();
    const rx = await cliJson<RuleWriteResult>(
      [
        'rules',
        'add',
        '--name',
        'urgent',
        '--adapter',
        'echo',
        '--regex',
        'sos\\d+',
        '--priority',
        '5',
        '--ttl',
        '60',
        '--json',
      ],
      ctx.env,
    );
    expect(rx.rule.matcher).toEqual({ kind: 'regex', pattern: 'sos\\d+' });
    expect(rx.rule.priority).toBe(5);
    expect(rx.rule.draftTtlMinutes).toBe(60);

    const contact = await cliJson<RuleWriteResult>(
      [
        'rules',
        'add',
        '--name',
        'vips',
        '--adapter',
        'echo',
        '--contact',
        '+15550001111,+15550002222',
        '--json',
      ],
      ctx.env,
    );
    expect(contact.rule.matcher).toEqual({
      kind: 'contact',
      handles: ['+15550001111', '+15550002222'],
    });

    const kw = await cliJson<RuleWriteResult>(
      [
        'rules',
        'add',
        '--name',
        'exact',
        '--adapter',
        'echo',
        '--keyword',
        'Pool',
        '--case-sensitive',
        '--whole-word',
        '--json',
      ],
      ctx.env,
    );
    expect(kw.rule.matcher).toEqual({
      kind: 'keyword',
      keywords: ['Pool'],
      mode: 'any',
      caseSensitive: true,
      wholeWord: true,
    });

    // --matcher-json escape hatch: combinators (§1.4.1 tree)
    const combo = await cliJson<RuleWriteResult>(
      [
        'rules',
        'add',
        '--name',
        'combo',
        '--adapter',
        'echo',
        '--matcher-json',
        JSON.stringify({
          kind: 'all-of',
          matchers: [
            { kind: 'keyword', keywords: ['pool'], mode: 'any' },
            { kind: 'contact', handles: ['+15550001111'] },
          ],
        }),
        '--json',
      ],
      ctx.env,
    );
    expect(combo.rule.matcher).toEqual({
      kind: 'all-of',
      matchers: [
        { kind: 'keyword', keywords: ['pool'], mode: 'any' },
        { kind: 'contact', handles: ['+15550001111'] },
      ],
    });
  }, 20_000);

  it('usage errors exit 2 from the verb itself (spec: e.g. --keyword with --regex)', async () => {
    const ctx = await boot();
    const cases: string[][] = [
      // exactly-one matcher source (spec's own example)
      [
        'rules',
        'add',
        '--name',
        'a',
        '--adapter',
        'e',
        '--keyword',
        'x',
        '--regex',
        'y',
      ],
      // no matcher source at all on add
      ['rules', 'add', '--name', 'a', '--adapter', 'e'],
      // keyword sub-flags without --keyword
      [
        'rules',
        'add',
        '--name',
        'a',
        '--adapter',
        'e',
        '--regex',
        'y',
        '--mode',
        'all',
      ],
      // bad --mode value
      [
        'rules',
        'add',
        '--name',
        'a',
        '--adapter',
        'e',
        '--keyword',
        'x',
        '--mode',
        'sometimes',
      ],
      // unparseable --matcher-json
      [
        'rules',
        'add',
        '--name',
        'a',
        '--adapter',
        'e',
        '--matcher-json',
        '{nope',
      ],
      // non-integer --priority
      [
        'rules',
        'add',
        '--name',
        'a',
        '--adapter',
        'e',
        '--keyword',
        'x',
        '--priority',
        'high',
      ],
      // missing required --name (commander-side usage error)
      ['rules', 'add', '--adapter', 'e', '--keyword', 'x'],
      // edit with nothing to change
      ['rules', 'edit', 'some-id'],
    ];
    for (const args of cases) {
      const res = await runCli([...args, '--json'], ctx.env);
      expect(res.code, args.join(' ')).toBe(2);
      expect(res.stdout, args.join(' ')).toBe('');
      // the usage error must come from the verb's own validation, not
      // from the command group being absent
      expect(res.stderr, args.join(' ')).not.toMatch(/unknown command/i);
    }
    // usage failures change nothing server-side
    const listed = await cliJson<RulePayload[]>(
      ['rules', 'list', '--json'],
      ctx.env,
    );
    expect(listed).toEqual([]);
  }, 20_000);

  it('edit mirrors via PATCH: matcher swap + priority, updatedAt bumps, rest preserved', async () => {
    const ctx = await boot();
    const created = await cliJson<RuleWriteResult>(
      [
        'rules',
        'add',
        '--name',
        'lunch',
        '--adapter',
        'echo',
        '--keyword',
        'tacos',
        '--json',
      ],
      ctx.env,
    );
    ctx.clockCtl.advance(60_000);
    const edited = await cliJson<RuleWriteResult>(
      [
        'rules',
        'edit',
        created.rule.id,
        '--keyword',
        'sushi',
        '--priority',
        '7',
        '--json',
      ],
      ctx.env,
    );
    expect(edited.rule).toEqual({
      ...created.rule,
      matcher: { kind: 'keyword', keywords: ['sushi'], mode: 'any' },
      priority: 7,
      updatedAt: '2026-09-01T12:01:00.000Z', // clock-advanced PATCH bump
    });
    const shown = await cliJson<RulePayload>(
      ['rules', 'show', created.rule.id, '--json'],
      ctx.env,
    );
    expect(shown).toEqual(edited.rule);
  }, 20_000);

  it('enable/disable flip exactly the enabled flag', async () => {
    const ctx = await boot();
    const created = await cliJson<RuleWriteResult>(
      [
        'rules',
        'add',
        '--name',
        'lunch',
        '--adapter',
        'echo',
        '--keyword',
        'tacos',
        '--json',
      ],
      ctx.env,
    );
    ctx.clockCtl.advance(1_000);
    const off = await cliJson<RuleWriteResult>(
      ['rules', 'disable', created.rule.id, '--json'],
      ctx.env,
    );
    expect(off.rule.enabled).toBe(false);
    ctx.clockCtl.advance(1_000);
    const on = await cliJson<RuleWriteResult>(
      ['rules', 'enable', created.rule.id, '--json'],
      ctx.env,
    );
    expect(on.rule).toEqual({
      ...created.rule,
      enabled: true,
      updatedAt: '2026-09-01T12:00:02.000Z',
    });
  }, 20_000);

  it('rm deletes; show afterwards exits 1 (not-found is an operation failure)', async () => {
    const ctx = await boot();
    const created = await cliJson<RuleWriteResult>(
      [
        'rules',
        'add',
        '--name',
        'lunch',
        '--adapter',
        'echo',
        '--keyword',
        'tacos',
        '--json',
      ],
      ctx.env,
    );
    const removed = await cliJson<{ deleted: string }>(
      ['rules', 'rm', created.rule.id, '--json'],
      ctx.env,
    );
    expect(removed).toEqual({ deleted: created.rule.id });
    const listed = await cliJson<RulePayload[]>(
      ['rules', 'list', '--json'],
      ctx.env,
    );
    expect(listed).toEqual([]);
    const shown = await runCli(
      ['rules', 'show', created.rule.id, '--json'],
      ctx.env,
    );
    expect(shown.code).toBe(1); // DaemonRequestError(404) → EXIT_FAILED
    expect(shown.stdout).toBe('');
    expect(shown.stderr).toMatch(/404/);
  }, 20_000);
});

describe('wemessage rules test / dryrun (§1.3.2, F-18; routes 6-7)', () => {
  it('test --rule --message returns the verdict; no-match still exits 0', async () => {
    const ctx = await boot();
    const created = await cliJson<RuleWriteResult>(
      [
        'rules',
        'add',
        '--name',
        'lunch',
        '--adapter',
        'echo',
        '--keyword',
        'tacos',
        '--json',
      ],
      ctx.env,
    );
    const hit = await cliJson<RuleTestResult>(
      [
        'rules',
        'test',
        '--rule',
        created.rule.id,
        '--message',
        'tacos tonight?',
        '--json',
      ],
      ctx.env,
    );
    expect(hit).toEqual({
      matched: true,
      detail: { matchedRuleIds: [created.rule.id] },
    });
    const miss = await runCli(
      [
        'rules',
        'test',
        '--rule',
        created.rule.id,
        '--message',
        'salad',
        '--json',
      ],
      ctx.env,
    );
    expect(miss.code).toBe(0); // verdict, not failure (recorded decision)
    expect(JSON.parse(miss.stdout)).toEqual({
      matched: false,
      detail: { matchedRuleIds: [] },
    });
    // --handle drives contact matchers (§1.3.2 surface)
    const vip = await cliJson<RuleWriteResult>(
      [
        'rules',
        'add',
        '--name',
        'vip',
        '--adapter',
        'echo',
        '--contact',
        '+15550001111',
        '--json',
      ],
      ctx.env,
    );
    const byHandle = await cliJson<RuleTestResult>(
      [
        'rules',
        'test',
        '--rule',
        vip.rule.id,
        '--message',
        'hi',
        '--handle',
        '+15550001111',
        '--json',
      ],
      ctx.env,
    );
    expect(byHandle.matched).toBe(true);
  }, 20_000);

  it('dryrun replays the mirrored window newest-first (F-18 over route 7)', async () => {
    const ctx = await boot();
    seedInbound(ctx.store, ctx.clockCtl, [
      { guid: 'cli-dry-1', text: 'no fish here' },
      { guid: 'cli-dry-2', text: 'tacos at noon' },
      { guid: 'cli-dry-3', text: null },
      { guid: 'cli-dry-4', text: 'TACOS AGAIN' },
    ]);
    const created = await cliJson<RuleWriteResult>(
      [
        'rules',
        'add',
        '--name',
        'lunch',
        '--adapter',
        'echo',
        '--keyword',
        'tacos',
        '--json',
      ],
      ctx.env,
    );
    const full = await cliJson<DryRunResult>(
      ['rules', 'dryrun', created.rule.id, '--json'],
      ctx.env,
    );
    expect(full).toEqual({
      total: 4,
      matched: 2,
      rows: [
        {
          guid: 'cli-dry-4',
          handle: '+15550009999',
          textPreview: 'TACOS AGAIN',
          matched: true,
        },
        {
          guid: 'cli-dry-3',
          handle: '+15550009999',
          textPreview: null,
          matched: false,
        },
        {
          guid: 'cli-dry-2',
          handle: '+15550009999',
          textPreview: 'tacos at noon',
          matched: true,
        },
        {
          guid: 'cli-dry-1',
          handle: '+15550009999',
          textPreview: 'no fish here',
          matched: false,
        },
      ],
    });
    const limited = await cliJson<DryRunResult>(
      ['rules', 'dryrun', created.rule.id, '--limit', '2', '--json'],
      ctx.env,
    );
    expect(limited.total).toBe(2);
    expect(limited.matched).toBe(1);
    expect(limited.rows.map((r) => r.guid)).toEqual(['cli-dry-4', 'cli-dry-3']);
    // human render exists, exit 0, not golden-locked
    const human = await runCli(['rules', 'dryrun', created.rule.id], ctx.env);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('2/4');
  }, 20_000);
});

describe('CLI exit codes on the new verbs (§3.8)', () => {
  it('bad bearer exits 4; dead daemon exits 3', async () => {
    const ctx = await boot();
    const auth = await runCli(['rules', 'list', '--json'], {
      ...ctx.env,
      WEMESSAGE_TOKEN: 'wm_wrong',
    });
    expect(auth.code).toBe(4);
    expect(auth.stdout).toBe('');

    const dead = await runCli(['rules', 'list', '--json'], {
      WEMESSAGE_PORT: '9', // discard port — nothing listens
      WEMESSAGE_TOKEN: 'wm_whatever',
    });
    expect(dead.code).toBe(3);
    expect(dead.stdout).toBe('');
  }, 20_000);
});

// ---------------------------------------------------------------------------
// audit group (§2.4.4, §1.6 routes 8-9)
// ---------------------------------------------------------------------------

describe('wemessage audit — list/verify (§2.4.4, §1.6 routes 8-9)', () => {
  it('list is reverse-chron; --since/--event compose; verify reports a clean chain', async () => {
    const ctx = await boot();
    const created = await cliJson<RuleWriteResult>(
      [
        'rules',
        'add',
        '--name',
        'lunch',
        '--adapter',
        'echo',
        '--keyword',
        'tacos',
        '--json',
      ],
      ctx.env,
    );
    ctx.clockCtl.advance(1_000);
    const disabled = await cliJson<RuleWriteResult>(
      ['rules', 'disable', created.rule.id, '--json'],
      ctx.env,
    );
    ctx.clockCtl.advance(1_000);
    await cliJson<{ deleted: string }>(
      ['rules', 'rm', created.rule.id, '--json'],
      ctx.env,
    );

    // reverse-chronological: seq DESC (delete, disable, create)
    const all = await cliJson<AuditRowPayload[]>(
      ['audit', 'list', '--json'],
      ctx.env,
    );
    expect(all.map((r) => r.seq)).toEqual([3, 2, 1]);
    expect(JSON.parse(all[0]!.eventJson)).toMatchObject({
      type: 'rule.deleted',
    });
    expect(JSON.parse(all[1]!.eventJson)).toMatchObject({
      type: 'rule.disabled',
    });
    expect(JSON.parse(all[2]!.eventJson)).toMatchObject({
      type: 'rule.created',
    });

    const filtered = await cliJson<AuditRowPayload[]>(
      ['audit', 'list', '--event', 'rule.disabled', '--json'],
      ctx.env,
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.seq).toBe(2);

    // §1.6 route 8 `since` is an inclusive lower bound (F-19 sinceAt):
    // the disable row's own timestamp plus everything after it.
    const sinceDisabled = await cliJson<AuditRowPayload[]>(
      ['audit', 'list', '--since', disabled.rule.updatedAt, '--json'],
      ctx.env,
    );
    expect(sinceDisabled.map((r) => r.seq)).toEqual([3, 2]);

    const verified = await cliJson<AuditVerifyResult>(
      ['audit', 'verify', '--json'],
      ctx.env,
    );
    expect(verified).toEqual({ ok: true, length: 3 });

    // human render exists, exit 0, not golden-locked
    const human = await runCli(['audit', 'verify'], ctx.env);
    expect(human.code).toBe(0);
    expect(human.stdout.length).toBeGreaterThan(0);
  }, 20_000);

  it('verify exits 1 WITH the break report on stdout when the chain is tampered', async () => {
    const ctx = await boot();
    const created = await cliJson<RuleWriteResult>(
      [
        'rules',
        'add',
        '--name',
        'lunch',
        '--adapter',
        'echo',
        '--keyword',
        'tacos',
        '--json',
      ],
      ctx.env,
    );
    ctx.clockCtl.advance(1_000);
    await cliJson<RuleWriteResult>(
      ['rules', 'disable', created.rule.id, '--json'],
      ctx.env,
    );
    ctx.clockCtl.advance(1_000);
    await cliJson<{ deleted: string }>(
      ['rules', 'rm', created.rule.id, '--json'],
      ctx.env,
    );

    // Sanctioned raw-.db tamper pattern (packages/store/test/audit-chain.spec.ts):
    // test/-directory files are exempt from the append-only audit_log arch
    // invariant (test/arch.spec.ts). Doctoring seq 1's event breaks its
    // stored hash without touching contiguity or linkage.
    ctx.store.db
      .prepare('UPDATE audit_log SET event = ? WHERE seq = 1')
      .run('{"type":"rule.created","ruleId":"DOCTORED"}');

    const res = await runCli(['audit', 'verify', '--json'], ctx.env);
    expect(res.code).toBe(1);
    const report = JSON.parse(res.stdout) as AuditVerifyResult;
    expect(report).toMatchObject({
      ok: false,
      brokenAtSeq: 1,
      reason: 'hash-mismatch',
      length: 3,
    });
  }, 20_000);
});
