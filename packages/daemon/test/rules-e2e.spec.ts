/**
 * Scenario 12 — S2 end-to-end: the demo in test form (spec Part 2 #12; §4
 * "the S2 demo definition — add a keyword rule, text the trigger word, see
 * `rule.matched` in `wemessage watch` and `audit list`").
 *
 * Full composition: real store (temp dir), real ingest over a fixture
 * chat.db, fake FsWatcher, fake Clock, compiled CLI (child_process). Boots
 * via @wemessage/daemon's startDaemon (not buildServer directly) so
 * recovery -> watcher -> listen and the real §1.8 audit chokepoint are all
 * exercised, exactly as tail-pipeline.spec.ts (Scenario 11's S1 precedent)
 * does for the pre-rules pipeline.
 *
 * SPEC ADAPTATION (recorded decision): §3.2 of s2-execution.md is explicit
 * that "no new typedstream blobs are harvested" for S2 — the corpus and
 * manifest.json are untouched. The prose spec's illustrative demo text
 * ("tacos at noon?", attributedBody-only) would require a corpus blob whose
 * decoded text contains "tacos"; none exists (plain-ascii/emoji/multiline/
 * url-with-linkmeta/mention/long-4k all have fixed GL-FIX-* bodies) and
 * fixture.editMessage() always overwrites its `newText` argument with the
 * decoded `edited-summary-info` corpus text ("GL-FIX-005 edited body (v2)")
 * regardless of what string is passed in (confirmed: normalizeRow prefers
 * the decoded message_summary_info over the SQL text column whenever
 * date_edited > 0). So this test proves the same composition the spec
 * requires with corpus-derived keywords standing in for the literal word:
 *  - the attributedBody-only decode-path match (step 2) uses keyword
 *    "ascii" against the plain-ascii corpus's fixed "GL-FIX-001 plain
 *    ascii body";
 *  - the edited-row match (step 5) uses keyword "edited" against the fixed
 *    post-edit text "GL-FIX-005 edited body (v2)";
 *  - the literal word "tacos" is still exercised twice, exactly where no
 *    corpus is involved: `rules test --message "tacos"` (step 6, a pure CLI
 *    argument) and a plain text-column inbound row after the restart (step
 *    8's continued-operation check), since addMessage's `text` column takes
 *    an arbitrary string with no corpus round-trip at all.
 * All three keywords live on ONE rule (`--keyword "tacos,ascii,edited"`),
 * matching the spec's "a keyword rule" (singular).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Clock, FsWatcher } from '@wemessage/core';
import { createChatDb, type ChatDbFixture } from '@wemessage/fixtures';
import {
  startDaemon,
  type DoctorProbes,
  type RunningDaemon,
} from '@wemessage/daemon';
import type {
  AuditRowPayload,
  AuditVerifyResult,
  RulePayload,
  RuleTestResult,
  RuleWriteResult,
} from '@wemessage/client';
import type { GatewayEventPayload } from '@wemessage/protocol';
import { createUnusedSendBackend } from './helpers/loopback-backend.js';

const CLI_BIN = fileURLToPath(
  new URL('../../cli/dist/bin.js', import.meta.url),
);

// s3 Scenario 7: startDaemon requires explicit doctorProbes; never a real
// osascript call in a test (test/arch.spec.ts gate (b)).
const fullyConnectedProbes: DoctorProbes = {
  osMajor: () => 15,
  fda: async () => 'ok',
  automation: async () => 'ok',
  messagesRunning: async () => true,
};

interface ClockCtl {
  clock: Clock;
  advance(ms: number): void;
}
function fakeClock(startIso = '2026-09-01T12:00:00.000Z'): ClockCtl {
  let now = new Date(startIso).getTime();
  return {
    clock: { now: () => new Date(now).toISOString(), nowMs: () => now },
    advance(ms: number) {
      now += ms;
    },
  };
}

interface FakeWatcher extends FsWatcher {
  fire: () => void;
}
function fakeWatcher(): FakeWatcher {
  const handlers: (() => void)[] = [];
  const w: FakeWatcher = {
    watch(paths, onChange) {
      handlers.push(onChange);
      return () => {
        handlers.length = 0;
      };
    },
    fire: () => {
      for (const h of [...handlers]) h();
    },
  };
  return w;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const dirs: string[] = [];
const children: ChildProcess[] = [];
const daemons: RunningDaemon[] = [];
const fixtureHandles: ChatDbFixture[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const d of daemons.splice(0)) await d.stop();
  for (const f of fixtureHandles.splice(0)) f.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

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
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function cliJson<T>(
  args: string[],
  env: Record<string, string>,
): Promise<T> {
  const res = await runCli(args, env);
  expect(res.code, `exit of ${args.join(' ')}\nstderr: ${res.stderr}`).toBe(0);
  return JSON.parse(res.stdout) as T;
}

describe('S2 end-to-end: the demo in test form (Scenario 12)', () => {
  it('add a keyword rule, text the trigger word, see rule.matched in watch and audit list', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wm-rules-e2e-'));
    dirs.push(dir);
    const configDir = join(dir, 'config');
    const chatDbPath = join(dir, 'chat.db');

    const fixture = createChatDb(chatDbPath);
    fixtureHandles.push(fixture);
    const handleId = fixture.addHandle('+15550007777');
    const chatId = fixture.addChat({ identifier: '+15550007777' });

    const clockCtl = fakeClock();
    const watcher1 = fakeWatcher();
    const daemon1 = await startDaemon({
      configDir,
      chatDbPath,
      clock: clockCtl.clock,
      watcher: watcher1,
      doctorProbes: fullyConnectedProbes,
      backend: createUnusedSendBackend(),
      backendName: 'unused',
    });
    daemons.push(daemon1);
    const token1 = daemon1.server.token;
    if (token1 === null) throw new Error('boot: expected a token');
    const env1 = {
      WEMESSAGE_PORT: String(daemon1.port),
      WEMESSAGE_TOKEN: token1,
    };

    // ---- Step 1: add the keyword rule; list shows it ----
    const created = await cliJson<RuleWriteResult>(
      [
        'rules',
        'add',
        '--name',
        'lunch',
        '--adapter',
        'echo',
        '--keyword',
        'tacos,ascii,edited',
        '--json',
      ],
      env1,
    );
    expect(created.rule.matcher).toEqual({
      kind: 'keyword',
      keywords: ['tacos', 'ascii', 'edited'],
      mode: 'any',
    });
    const listed = await cliJson<RulePayload[]>(
      ['rules', 'list', '--json'],
      env1,
    );
    expect(listed).toEqual([created.rule]);

    // ---- attach `watch --json` before any triggering row lands ----
    const watchChild = spawn(process.execPath, [CLI_BIN, 'watch', '--json'], {
      env: { ...process.env, ...env1 },
    });
    children.push(watchChild);
    let watchOut = '';
    watchChild.stdout.on('data', (d: Buffer) => (watchOut += d.toString()));
    const watchLines = (): string[] =>
      watchOut.split('\n').filter((l) => l.trim().length > 0);
    await waitFor(() => watchLines().length >= 1, 'watch greeting line');
    const greeting = JSON.parse(watchLines()[0] ?? '{}') as { event: string };
    expect(greeting.event).toBe('connection.state');

    // ---- Step 2: attributedBody-only inbound row decodes to text
    // containing "ascii" -> message.received then rule.matched, in order ----
    const trigger = fixture.addMessage({
      chatId,
      handleId,
      attributedBodyFixture: 'plain-ascii', // decodes to "GL-FIX-001 plain ascii body"
    });
    watcher1.fire();
    await waitFor(() => watchLines().length >= 3, 'received+matched pair');
    const afterStep2 = watchLines().map(
      (l) => JSON.parse(l) as GatewayEventPayload,
    );
    expect(afterStep2[1]?.event).toBe('message.received');
    if (afterStep2[1]?.event !== 'message.received')
      throw new Error('unreachable');
    expect(afterStep2[1].message.guid).toBe(trigger.guid);
    expect(afterStep2[1].message.content.text).toBe(
      'GL-FIX-001 plain ascii body',
    );
    expect(afterStep2[2]).toEqual({
      event: 'rule.matched',
      guid: trigger.guid,
      ruleId: created.rule.id,
      adapterId: 'echo',
    });

    // ---- Step 3: a non-trigger message produces message.received only ----
    const quiet = fixture.addMessage({
      chatId,
      handleId,
      text: 'just checking in',
    });
    watcher1.fire();
    await waitFor(() => watchLines().length >= 4, 'quiet message.received');
    const afterStep3 = watchLines().map(
      (l) => JSON.parse(l) as GatewayEventPayload,
    );
    expect(afterStep3[3]?.event).toBe('message.received');
    if (afterStep3[3]?.event !== 'message.received')
      throw new Error('unreachable');
    expect(afterStep3[3].message.guid).toBe(quiet.guid);
    // no extra rule.matched snuck in for the quiet row
    expect(afterStep3).toHaveLength(4);

    // ---- Step 4: audit list --json shows rule.created and rule.matched
    // (store's audit list is reverse-chron/seq DESC, pinned by Scenario 11:
    // matched sorts before created since it happened later) ----
    const auditAfterStep2 = await cliJson<AuditRowPayload[]>(
      ['audit', 'list', '--json'],
      env1,
    );
    const typesAfterStep2 = auditAfterStep2.map(
      (r) => (JSON.parse(r.eventJson) as { type: string }).type,
    );
    expect(typesAfterStep2).toContain('rule.created');
    expect(typesAfterStep2).toContain('rule.matched');
    expect(typesAfterStep2.indexOf('rule.matched')).toBeLessThan(
      typesAfterStep2.indexOf('rule.created'),
    );

    // ---- Step 5: in-place edit of the already-mirrored NON-matching
    // "just checking in" row; the fixture's editMessage() always resolves
    // through the decoded summary-info corpus text "GL-FIX-005 edited body
    // (v2)" (see SPEC ADAPTATION above), which contains "edited" ----
    fixture.editMessage(
      quiet.guid,
      'irrelevant — overwritten by summary-info decode',
    );
    watcher1.fire();
    await waitFor(() => watchLines().length >= 6, 'edited+matched pair');
    const afterStep5 = watchLines().map(
      (l) => JSON.parse(l) as GatewayEventPayload,
    );
    expect(afterStep5[4]).toEqual({
      event: 'message.edited',
      guid: quiet.guid,
      newText: 'GL-FIX-005 edited body (v2)',
    });
    expect(afterStep5[5]).toEqual({
      event: 'rule.matched',
      guid: quiet.guid,
      ruleId: created.rule.id,
      adapterId: 'echo',
    });
    expect(afterStep5).toHaveLength(6); // nothing extra

    watchChild.kill('SIGTERM');

    // ---- Step 6: rules test is a pure verdict; it never touches audit ----
    const auditBeforeTest = await cliJson<AuditRowPayload[]>(
      ['audit', 'list', '--json'],
      env1,
    );
    const hit = await cliJson<RuleTestResult>(
      [
        'rules',
        'test',
        '--rule',
        created.rule.id,
        '--message',
        'tacos',
        '--json',
      ],
      env1,
    );
    expect(hit).toEqual({
      matched: true,
      detail: { matchedRuleIds: [created.rule.id] },
    });
    const miss = await cliJson<RuleTestResult>(
      [
        'rules',
        'test',
        '--rule',
        created.rule.id,
        '--message',
        'salad',
        '--json',
      ],
      env1,
    );
    expect(miss).toEqual({ matched: false, detail: { matchedRuleIds: [] } });
    const auditAfterTest = await cliJson<AuditRowPayload[]>(
      ['audit', 'list', '--json'],
      env1,
    );
    expect(auditAfterTest).toEqual(auditBeforeTest); // row count + content unchanged

    // ---- Step 7: verify is clean, then a raw-handle tamper breaks it ----
    const verifiedOk = await cliJson<AuditVerifyResult>(
      ['audit', 'verify', '--json'],
      env1,
    );
    expect(verifiedOk).toEqual({ ok: true, length: auditAfterTest.length });

    daemon1.store.db
      .prepare('UPDATE audit_log SET event = ? WHERE seq = 1')
      .run('{"type":"rule.created","ruleId":"DOCTORED"}');

    const tampered = await runCli(['audit', 'verify', '--json'], env1);
    expect(tampered.code).toBe(1);
    const report = JSON.parse(tampered.stdout) as AuditVerifyResult;
    expect(report).toMatchObject({
      ok: false,
      brokenAtSeq: 1,
      reason: 'hash-mismatch',
      length: auditAfterTest.length,
    });

    const auditRowCountBeforeRestart = auditAfterTest.length;

    // ---- Step 8: daemon restart mid-suite; no duplicate rule.matched for
    // already-processed guids on the ROWID path (F-15 restart caveat for
    // mutation-path duplicates is accepted, not asserted away here) ----
    await daemon1.stop();
    daemons.splice(daemons.indexOf(daemon1), 1);

    const watcher2 = fakeWatcher();
    const daemon2 = await startDaemon({
      configDir,
      chatDbPath,
      clock: clockCtl.clock,
      watcher: watcher2,
      doctorProbes: fullyConnectedProbes,
      backend: createUnusedSendBackend(),
      backendName: 'unused',
    });
    daemons.push(daemon2);
    const token2 = daemon2.server.token;
    if (token2 === null) throw new Error('restart: expected a token');
    const env2 = {
      WEMESSAGE_PORT: String(daemon2.port),
      WEMESSAGE_TOKEN: token2,
    };

    // catch-up scan on boot must NOT re-emit/re-audit already-processed rows
    const auditAfterRestart = await cliJson<AuditRowPayload[]>(
      ['audit', 'list', '--json'],
      env2,
    );
    expect(auditAfterRestart).toHaveLength(auditRowCountBeforeRestart);

    // continued operation: a fresh plain text-column row with the literal
    // trigger word ("tacos" — no corpus involved on this path) still matches
    // post-restart.
    fixture.addMessage({ chatId, handleId, text: 'tacos at noon?' });
    watcher2.fire();
    await waitFor(async () => {
      const rows = await cliJson<AuditRowPayload[]>(
        ['audit', 'list', '--json'],
        env2,
      );
      // TWO rows since s5 Scenario 6, not one: the match, and then the
      // dispatch's verdict on the rule's adapter. `echo` is a rule target
      // here, never a registered adapter row, so the second row is the
      // fail-closed `gate.denied {adapter-disabled}` — and the match is
      // audited anyway, because ingestion is never gated (§2.4.3).
      return rows.length === auditRowCountBeforeRestart + 2;
    }, 'post-restart rule.matched');
    const finalAudit = await cliJson<AuditRowPayload[]>(
      ['audit', 'list', '--json'],
      env2,
    );
    expect(finalAudit).toHaveLength(auditRowCountBeforeRestart + 2);
    const newTypes = finalAudit
      .slice(0, 2)
      .map((row) => (JSON.parse(row.eventJson) as { type: string }).type)
      .sort();
    expect(newTypes).toEqual(['gate.denied', 'rule.matched']);

    // ---- Step 9: posture check — this scenario introduces no new import
    // surface (pnpm dep:check is run as part of the scenario's own gate,
    // not asserted in-test; see s2-execution.md Scenario 12 item 9).
  }, 30_000);
});
