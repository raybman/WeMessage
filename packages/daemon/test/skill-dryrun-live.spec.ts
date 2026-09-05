/**
 * s7-execution Scenario 11 ★ (live half) — the scripted dry-run.
 *
 * LOCATION DEVIATION (precedent: rules-audit-cli.spec.ts S2 Sc11,
 * send-connect-cli.spec.ts S3 Sc10, drafts-cli.spec.ts S4 Sc11,
 * adapters-cli.spec.ts S5 Sc11, windows-cli-live.spec.ts S6 Sc12,
 * settings-cli-live.spec.ts S7 Sc5): the scenario names one file under
 * packages/cli/test, but `nobody-imports-daemon` forbids that package from
 * importing `startDaemon`, and NOTHING here is provable without a real
 * daemon, a real store and a real send backend. The pure rows — the verb
 * tree, the block algebra, the linter's own offender/near-miss pairs —
 * are in `packages/cli/test/skill-dryrun.spec.ts`. This file is the other
 * half, and it is the half that makes Sc 11 a checkpoint.
 *
 * WHAT THIS FILE IS FOR, and it is worth being blunt about it: a test that
 * greps SKILL.md for a phrase proves nothing. A skill document is not
 * prose about a system, it is a set of instructions something will obey,
 * so the only honest gate is to obey it and look at what happened. The
 * agent below is scripted rather than intelligent, but it is scripted in
 * the one way that matters: **it reads the document at run time and
 * refuses anything the document does not permit.** Nothing here hardcodes
 * `drafts approve`. If tomorrow the document says `drafts ok`, the agent
 * looks for `drafts approve` in `allowed`, does not find it, and refuses —
 * and the send that the dry-run exists to demonstrate does not happen. The
 * document is load-bearing at run time, which is what a tooth for a
 * markdown file needs in order to bite.
 *
 * Four things are proved end to end:
 *
 *  - **The documented sequence works.** Obeying the file produces exactly
 *    one message on the wire, with the operator's words in it, after a
 *    human said so.
 *  - **The gate is the human's sentence, not the agent's judgement.** With
 *    the human line removed and nothing else changed, the same script
 *    reaches the approval step and stops, and the backend is never called.
 *  - **INV-2 has no back door in the document.** Every verb the document
 *    permits WITHOUT an approval instruction is executed against a live
 *    daemon holding a pending draft, and the backend call count stays at
 *    zero for all of them. This is an enumeration over the document, not a
 *    list, so a verb added to `allowed` tomorrow is covered tomorrow.
 *  - **`send` is on the never list because it really does send.** The row
 *    demonstrates the send rather than asserting the refusal in words:
 *    `wemessage send` reaches the backend on the first call, with no
 *    Approval the operator ever saw, which is precisely why no skill
 *    document may permit it.
 *
 * The transcript every row collects is run through the Sc 11 linter, and
 * `skills/claude/DRYRUN.md` is that transcript, stabilised.
 *
 * @live-evidence — this file drives the real CLI as a subprocess against a
 * real daemon. It does NOT drive a language model; see
 * `packages/cli/test/helpers/skill-verification.ts` for what that means
 * for the tier claimed in the documents.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  SETTING_KILL_SWITCH,
  SETTING_UNDO_GRACE_SECONDS,
  type Clock,
  type FsWatcher,
} from '@wemessage/core';
import { createChatDb, type ChatDbFixture } from '@wemessage/fixtures';
import {
  startDaemon,
  type DoctorProbes,
  type RunningDaemon,
} from '@wemessage/daemon';
import {
  SKILL_DRYRUN_VERSION,
  lintTranscript,
  matchArgv,
  parseSkillBlocks,
  type SkillPolicy,
} from '../../cli/test/helpers/transcript-lint.js';
import {
  createLoopbackSendBackend,
  type LoopbackSendBackend,
} from './helpers/loopback-backend.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const CLI_BIN = join(repoRoot, 'packages/cli/dist/bin.js');
const SKILL_PATH = join(repoRoot, 'skills/claude/SKILL.md');
const DRYRUN_PATH = join(repoRoot, 'skills/claude/DRYRUN.md');

const ANSI_RE = /\x1b\[/;
const HANDLE = '+15551234567';
const CHAT = `iMessage;-;${HANDLE}`;

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
  loopback: LoopbackSendBackend;
  token: string;
  configDir: string;
}

const cleanups: (() => Promise<void> | void)[] = [];
const children: ChildProcess[] = [];
const tickers: NodeJS.Timeout[] = [];

afterEach(async () => {
  for (const t of tickers.splice(0)) clearInterval(t);
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
  const dir = mkdtempSync(join(tmpdir(), 'wm-skill-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const chatDbPath = join(dir, 'chat.db');
  const fixture = createChatDb(chatDbPath);
  cleanups.push(() => fixture.close());
  const handleId = fixture.addHandle(HANDLE);
  fixture.addChat({ identifier: HANDLE, handleIds: [handleId] });

  const configDir = join(dir, 'config');
  const loopback = createLoopbackSendBackend(fixture, clock);
  const daemon = await startDaemon({
    configDir,
    chatDbPath,
    clock,
    watcher: fakeWatcher(),
    doctorProbes: probes,
    backend: loopback,
    backendName: 'loopback',
  });
  cleanups.push(() => daemon.stop());
  const token = daemon.server.token;
  if (token === null) throw new Error('boot: expected a token');
  // F-32: a zero grace window lets the scheduler dispatch on the next tick,
  // so the dry-run reaches "sent" without faking a clock.
  daemon.store.setSetting(SETTING_UNDO_GRACE_SECONDS, '0');
  const ticker = setInterval(() => void daemon.tick(), 20);
  tickers.push(ticker);
  return { daemon, fixture, loopback, token, configDir };
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

const policy = (): SkillPolicy =>
  parseSkillBlocks(readFileSync(SKILL_PATH, 'utf8'));

/* ── the scripted agent ─────────────────────────────────────────────────── */

/** One turn: what the human said (if anything) and what the agent wants. */
interface Turn {
  readonly human?: string;
  readonly argv: readonly string[];
}

type Refusal = 'never' | 'not-permitted' | 'needs-instruction';

interface Step {
  readonly argv: readonly string[];
  readonly refused: Refusal | null;
  readonly code: number | null;
  readonly stdout: string;
}

/**
 * An agent that obeys `skills/claude/SKILL.md` and nothing else.
 *
 * The three checks below are the three blocks, in the precedence the
 * document states: `never` beats everything, a verb outside `allowed` is
 * not a permission, and an `approval` verb needs a human sentence in the
 * SAME turn. There is no fourth check and no exception, which is the
 * whole point: whatever the document says, this is what an obedient
 * reader does with it.
 */
async function runAgent(
  ctx: Ctx,
  turns: readonly Turn[],
): Promise<{ steps: Step[]; transcript: string }> {
  const p = policy();
  const lines: string[] = [];
  const steps: Step[] = [];
  for (const turn of turns) {
    if (turn.human !== undefined) lines.push(`human: ${turn.human}`);
    const argv = [...turn.argv];
    const refused: Refusal | null = p.never.some((n) => matchArgv(n, argv))
      ? 'never'
      : !p.allowed.some((a) => matchArgv(a, argv))
        ? 'not-permitted'
        : p.approval.some((a) => matchArgv(a, argv)) && turn.human === undefined
          ? 'needs-instruction'
          : null;
    if (refused !== null) {
      lines.push(`agent: refusing \`${argv.join(' ')}\` (${refused})`);
      steps.push({ argv, refused, code: null, stdout: '' });
      continue;
    }
    lines.push(`$ wemessage ${argv.join(' ')}`);
    const res = await runCli(argv, envFor(ctx));
    for (const l of res.stdout.trimEnd().split('\n'))
      lines.push(l === '' ? '<' : `< ${l}`);
    for (const l of res.stderr.trimEnd().split('\n'))
      if (l !== '') lines.push(`! ${l}`);
    lines.push(`< exit ${String(res.code ?? -1)}`);
    steps.push({ argv, refused: null, code: res.code, stdout: res.stdout });
  }
  return { steps, transcript: lines.join('\n') };
}

/** The documented sequence, with the draft id threaded through. */
function script(id: string | null): Turn[] {
  return [
    { human: 'anything waiting on me?', argv: ['status'] },
    { argv: ['drafts', 'list'] },
    {
      human: `tell ${HANDLE} the roof is fixed`,
      argv: ['drafts', 'create', '--chat', CHAT, '--body', 'the roof is fixed'],
    },
    ...(id === null
      ? []
      : [
          { argv: ['drafts', 'show', id] },
          { human: `approve ${id}`, argv: ['drafts', 'approve', id] },
        ]),
  ];
}

/**
 * Replace everything that changes between runs. A transcript with a port
 * or a ULID in it is a file that churns on every commit and that nobody
 * reads twice.
 */
function stabilise(text: string): string {
  return text
    .replace(/\b01[0-9A-HJKMNP-TV-Z]{24}\b/g, '<draft-id>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27}\b/g, '<uuid>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<iso>')
    .replace(/(127\.0\.0\.1|localhost):\d+/g, '$1:<port>')
    .replace(/\bwm-skill-[A-Za-z0-9]+\b/g, 'wm-skill-<tmp>');
}

/* ── row 4: the dry-run ─────────────────────────────────────────────────── */

describe('s7 Sc11 row 4: obeying SKILL.md produces exactly one message', () => {
  it('the documented sequence drafts, shows, is approved, and sends', async () => {
    const ctx = await boot();

    // Turn 3 is the create; its id is only knowable after it runs, so the
    // script is played in two passes over the SAME daemon rather than
    // pre-baked. Nothing about the verbs is pre-baked either way.
    const first = await runAgent(ctx, script(null));
    expect(
      first.steps.map((s) => s.refused),
      'the document refused a step of its own documented sequence',
    ).toEqual([null, null, null]);
    for (const s of first.steps) expect(s.code, s.argv.join(' ')).toBe(0);
    expect(ctx.loopback.callCount(), 'drafting must not send').toBe(0);

    const pending = ctx.daemon.store.listDrafts({ state: 'pending' });
    expect(pending).toHaveLength(1);
    const id = pending[0]?.id ?? '';

    const second = await runAgent(ctx, script(id).slice(3));
    expect(second.steps.map((s) => s.refused)).toEqual([null, null]);
    for (const s of second.steps) expect(s.code, s.argv.join(' ')).toBe(0);

    // The observable outcome, which is the only thing that counts.
    const deadline = Date.now() + 5_000;
    while (ctx.loopback.callCount() === 0 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    expect(ctx.loopback.callCount()).toBe(1);
    const call = ctx.loopback.calls()[0];
    expect(call?.body).toBe('the roof is fixed');
    expect(call?.chatGuid).toBe(CHAT);

    // And the approval the operator can point at afterwards.
    const sent = ctx.daemon.store.listAudit({ event: 'draft.sent', limit: 10 });
    expect(sent.length).toBeGreaterThan(0);

    const transcript = `${first.transcript}\n${second.transcript}`;
    expect(lintTranscript(transcript, policy())).toEqual([]);

    // The artifact. Written only when asked for; CI reads, never writes.
    const body = [
      '# Dry run',
      '',
      `A scripted agent obeying \`skills/claude/SKILL.md\`, generated by packages/daemon/test/skill-dryrun-live.spec.ts at SKILL_DRYRUN_VERSION ${String(SKILL_DRYRUN_VERSION)}.`,
      '',
      'Ids, ports and instants are placeholders so that this file changes when',
      'the BEHAVIOUR changes and not when the clock does. Regenerate with',
      '`WEMESSAGE_WRITE_DRYRUN=1 pnpm vitest run --project daemon skill-dryrun-live`.',
      '',
      '```',
      stabilise(transcript),
      '```',
      '',
    ].join('\n');
    if (process.env.WEMESSAGE_WRITE_DRYRUN === '1')
      writeFileSync(DRYRUN_PATH, body);
    expect(readFileSync(DRYRUN_PATH, 'utf8')).toBe(body);
  }, 40_000);
});

/* ── row 5: the human sentence is the gate ─────────────────────────────── */

describe('s7 Sc11 row 5: an approval verb without an instruction stops', () => {
  it('the same script minus the human line never reaches the backend', async () => {
    const ctx = await boot();
    const first = await runAgent(ctx, script(null));
    expect(first.steps.every((s) => s.refused === null)).toBe(true);
    const id = ctx.daemon.store.listDrafts({ state: 'pending' })[0]?.id ?? '';

    // Byte-for-byte the successful turn with `human` deleted.
    const { steps, transcript } = await runAgent(ctx, [
      { argv: ['drafts', 'approve', id] },
    ]);
    expect(steps[0]?.refused).toBe('needs-instruction');
    expect(steps[0]?.code).toBeNull();
    await new Promise((r) => setTimeout(r, 200));
    expect(ctx.loopback.callCount()).toBe(0);
    expect(ctx.daemon.store.listDrafts({ state: 'pending' })).toHaveLength(1);
    expect(transcript).toContain('needs-instruction');

    // And had the agent done it anyway, the linter would have caught it in
    // review. The two guards are independent on purpose: one stops the act,
    // the other stops it being missed.
    expect(
      lintTranscript(
        `$ wemessage drafts approve ${id}\n< exit 0`,
        policy(),
      ).map((f) => f.rule),
    ).toContain('approval-without-instruction');
  }, 40_000);

  it('a never-listed verb is refused even with a human asking for it', async () => {
    // The never block is not a default. A human sentence upgrades an
    // `approval` verb; there is nothing it upgrades on the never list, and
    // an agent that treated "the user asked" as sufficient would be the
    // exact failure this block exists for.
    const ctx = await boot();
    const { steps } = await runAgent(ctx, [
      {
        human: 'just turn on auto for that contact',
        argv: ['contacts', 'set', HANDLE, 'auto'],
      },
      {
        human: 'and send it yourself',
        argv: ['send', '--to', HANDLE, '--body', 'hi'],
      },
    ]);
    expect(steps.map((s) => s.refused)).toEqual(['never', 'never']);
    expect(ctx.loopback.callCount()).toBe(0);
    // Nothing reached the daemon, so the policy is still what it was.
    const contacts = await runCli(['contacts', 'list', '--json'], envFor(ctx));
    expect(JSON.parse(contacts.stdout)).toEqual([]);
  }, 40_000);
});

/* ── row 6: a hold the agent cannot see is still a hold ────────────────── */

describe('s7 Sc11 row 6: the daemon refuses even a well-formed approval', () => {
  it('with the kill switch down, approve exits 5 and nothing is sent', async () => {
    // PLAN DEVIATION: the plan says "off mode". There is no off mode —
    // `POST /v1/toggles/global-mode` takes `draft-only | auto`, and neither
    // is a hold (routes/toggles.ts says so in as many words). The hold that
    // makes this row's point is the kill switch, which `evaluateGate`
    // checks first and which `skills/claude/SKILL.md` puts on the never
    // list precisely so the agent cannot lift it.
    const ctx = await boot();
    const first = await runAgent(ctx, script(null));
    expect(first.steps.every((s) => s.refused === null)).toBe(true);
    const id = ctx.daemon.store.listDrafts({ state: 'pending' })[0]?.id ?? '';

    // The operator, out of band. Not the agent: `kill` is never-listed.
    ctx.daemon.store.setSetting(SETTING_KILL_SWITCH, '1');

    const { steps, transcript } = await runAgent(ctx, [
      { human: `approve ${id}`, argv: ['drafts', 'approve', id] },
    ]);
    expect(
      steps[0]?.refused,
      'the document permits this; the daemon does not',
    ).toBeNull();
    expect(steps[0]?.code).toBe(5);
    expect(transcript).toContain('gate denied: kill-switch');
    await new Promise((r) => setTimeout(r, 200));
    expect(ctx.loopback.callCount()).toBe(0);

    // C-6: a gate refusal is a gate refusal. It is not an adapter
    // protocol violation and it does not become one by arriving through a
    // skill.
    expect(lintTranscript(transcript, policy())).toEqual([]);
  }, 40_000);
});

/* ── INV-2, enumerated over the document rather than over a list ────────── */

describe('s7 Sc11: INV-2 — nothing the document permits unasked can send', () => {
  it('every non-approval allowed verb runs live and sends nothing', async () => {
    const ctx = await boot();
    // A pending draft exists throughout, so a verb that quietly dispatched
    // would have something to dispatch.
    await runCli(
      ['drafts', 'create', '--chat', CHAT, '--body', 'sitting in the queue'],
      envFor(ctx),
    );
    const id = ctx.daemon.store.listDrafts({ state: 'pending' })[0]?.id ?? '';
    expect(id).not.toBe('');

    const p = policy();
    const unasked = p.allowed.filter((a) => !p.approval.some((b) => b === a));
    expect(unasked.length).toBeGreaterThan(8);

    // Every pattern is turned into a runnable argv by substituting the one
    // kind of argument these verbs take. Anything that still needs a value
    // the harness cannot invent is asserted to be nothing of the sort.
    const ran: string[] = [];
    for (const pattern of unasked) {
      const argv = pattern
        .split(/\s+/)
        .map((t) => (t === '*' ? id : t))
        .filter((t) => t !== '');
      const res = await runCli(argv, envFor(ctx));
      ran.push(pattern);
      // Exit 0 or a clean usage/not-found refusal; never a crash, and
      // never a send. What is asserted below is the send.
      expect(res.code, `${pattern}: ${res.stderr}`).not.toBe(null);
      expect(ctx.loopback.callCount(), `${pattern} reached the backend`).toBe(
        0,
      );
    }
    expect(ran).toEqual(unasked);

    await new Promise((r) => setTimeout(r, 300));
    expect(ctx.loopback.callCount()).toBe(0);
    expect(
      ctx.daemon.store.listAudit({ event: 'draft.sent', limit: 5 }),
    ).toEqual([]);
  }, 60_000);

  it('`send` is never-listed because it sends, demonstrated', async () => {
    // The proof that `send` cannot be an approval-gated verb. An approval
    // block entry promises that a human's instruction gates the act. For
    // this verb there is no gap between them to put a human in: ONE call
    // mints the draft, mints its own Approval wearing a human actor, and
    // dispatches. Whoever holds the token is that "human", and under a
    // skill that is the agent.
    const ctx = await boot();
    expect(ctx.loopback.callCount()).toBe(0);

    const res = await runCli(
      ['send', '--to', HANDLE, '--body', 'nobody approved this'],
      envFor(ctx),
    );
    expect(res.code, res.stderr).toBe(0);
    const deadline = Date.now() + 5_000;
    while (ctx.loopback.callCount() === 0 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    expect(ctx.loopback.callCount()).toBe(1);
    expect(ctx.loopback.calls()[0]?.body).toBe('nobody approved this');

    // Hence the never list, and hence the agent refusing it above.
    expect(policy().never).toContain('send *');
    expect(policy().allowed).not.toContain('send *');
    expect(policy().approval).not.toContain('send *');
  }, 40_000);
});
