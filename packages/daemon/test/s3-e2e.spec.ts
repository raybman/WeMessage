/**
 * Scenario 12 (s3-execution.md, final S3 scenario) — the full S3 composition
 * in one narrative: a fresh Mac walks from red doctor checks to
 * fully-connected, sends a real message through the loopback backend,
 * survives a daemon restart (T-9.3 recovery) without re-sending, then
 * disconnects fail-closed (old bearer 401s, denied while disconnected,
 * reconnects, purges to 503-everything).
 *
 * This scenario IS the teeth for the whole slice (s3-execution.md's own
 * words): its three meta-assertions at the end are the standing structural
 * proof of the non-negotiables, not a separate named-teeth mutation step
 * like Scenarios 1-11 each had.
 *   (i)   never a real osascript execution
 *   (ii)  never a write outside the temp dir this test owns
 *   (iii) never an ANSI escape in a CLI-rendered human output
 *
 * Composition mirrors rules-e2e.spec.ts (S2's Scenario 12 precedent):
 * real store (temp dir), real fixture chat.db, fake FsWatcher, fake Clock,
 * fake DoctorProbes (mutable, so the narrative can walk the precedence
 * engine to green), a real LoopbackSendBackend (fixture-backed, so the send
 * path is genuinely exercised, not stubbed), and the compiled CLI spawned
 * as a real child process for the two ANSI-free-render captures.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { AutomationProbeResult } from '@wemessage/sendkit';
import type { FdaProbeResult } from '@wemessage/ingest';
import type { Clock, FsWatcher } from '@wemessage/core';
import { createChatDb, type ChatDbFixture } from '@wemessage/fixtures';
import {
  AUTOMATION_DENIED,
  FDA_EPERM,
  readToken,
  startDaemon,
  type DoctorProbes,
  type RunningDaemon,
} from '@wemessage/daemon';
import {
  createClient,
  DaemonGateDeniedError,
  type GatewayEventPayload,
} from '@wemessage/client';
import { createLoopbackSendBackend } from './helpers/loopback-backend.js';

// ---------------------------------------------------------------------------
// Fable design consult point 2: a runtime spy on the ONE child_process
// function production code ever shells through for the real AppleScript
// runner (createRealDoctorProbes/main.ts — never wired in this test, since
// every DoctorProbes here is the mutable fake below and the SendBackend is
// the fixture-backed loopback). Wraps only `execFile`; every other export
// (including `spawn`, which this file's own CLI-subprocess helper uses)
// passes through untouched via the `...actual` spread.
// ---------------------------------------------------------------------------
const childProcessCalls = vi.hoisted(() => [] as { command: string }[]);

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const wrappedExecFile = (
    ...args: unknown[]
  ): ReturnType<typeof actual.execFile> => {
    const command = typeof args[0] === 'string' ? args[0] : String(args[0]);
    childProcessCalls.push({ command });
    return (actual.execFile as (...a: unknown[]) => unknown)(
      ...args,
    ) as ReturnType<typeof actual.execFile>;
  };
  return { ...actual, execFile: wrappedExecFile as typeof actual.execFile };
});

const CLI_BIN = fileURLToPath(
  new URL('../../cli/dist/bin.js', import.meta.url),
);

const NO_ANSI = /\x1b\[/;

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
  return {
    watch(_paths, onChange) {
      handlers.push(onChange);
      return () => {
        handlers.length = 0;
      };
    },
    fire: () => {
      for (const h of [...handlers]) h();
    },
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function isSubsequence(haystack: string[], needle: string[]): boolean {
  let i = 0;
  for (const item of haystack) {
    if (i < needle.length && item === needle[i]) i += 1;
  }
  return i === needle.length;
}

/**
 * Doctor's four probes, mutable in place so the narrative can walk the
 * precedence engine from all-red to fully-connected via GET /v1/doctor
 * re-queries alone (routes/doctor.ts re-derives fresh on every call, no
 * caching — confirmed by reading the route: `() => runDoctor(deps)`).
 */
function mutableProbes(initial: {
  osMajor: number;
  fda: FdaProbeResult;
  automation: AutomationProbeResult;
  messagesRunning: boolean;
}): { probes: DoctorProbes; set(patch: Partial<typeof initial>): void } {
  const state = { ...initial };
  return {
    probes: {
      osMajor: () => state.osMajor,
      fda: () => Promise.resolve(state.fda),
      automation: () => Promise.resolve(state.automation),
      messagesRunning: () => Promise.resolve(state.messagesRunning),
    },
    set(patch) {
      Object.assign(state, patch);
    },
  };
}

function connectWs(
  baseUrl: string,
  token: string,
): Promise<{
  frames: GatewayEventPayload[];
  socket: WebSocket;
  closed: Promise<void>;
}> {
  const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/v1/events`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const frames: GatewayEventPayload[] = [];
  socket.on('message', (data) => {
    frames.push(JSON.parse(String(data)) as GatewayEventPayload);
  });
  const closed = new Promise<void>((resolve) => socket.on('close', resolve));
  return new Promise((resolve, reject) => {
    socket.on('open', () => resolve({ frames, socket, closed }));
    socket.on('error', reject);
  });
}

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

const dirs: string[] = [];
const children: ChildProcess[] = [];
const daemons: RunningDaemon[] = [];
const fixtureHandles: ChatDbFixture[] = [];
const sockets: WebSocket[] = [];
let homeRestore: (() => void) | null = null;

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const d of daemons.splice(0)) await d.stop();
  for (const f of fixtureHandles.splice(0)) f.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (homeRestore !== null) {
    homeRestore();
    homeRestore = null;
  }
});

describe('S3 end-to-end: fresh Mac to fully-connected to send to restart to fail-closed disconnect (Scenario 12)', () => {
  it('walks the full S3 composition in one narrative', async () => {
    // Fable design consult (fs-interception for "zero writes outside temp
    // dir" would be dishonest — better-sqlite3 writes via native code):
    // a fake HOME sentinel instead. Every CLI call below always supplies
    // WEMESSAGE_TOKEN, so the CLI's resolveToken() (`flag ?? env ??
    // readTokenFile(configDir())`) never evaluates configDir()/homedir()
    // at all — the fake HOME staying empty is a genuine positive-
    // containment proof, not a risk to existing CLI behavior.
    const fakeHome = mkdtempSync(join(tmpdir(), 'wm-s3-e2e-home-'));
    dirs.push(fakeHome);
    const originalHome = process.env['HOME'];
    process.env['HOME'] = fakeHome;
    homeRestore = () => {
      if (originalHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = originalHome;
    };

    const dir = mkdtempSync(join(tmpdir(), 'wm-s3-e2e-'));
    dirs.push(dir);
    const configDir = join(dir, 'config');
    const chatDbPath = join(dir, 'chat.db');

    const fixture = createChatDb(chatDbPath);
    fixtureHandles.push(fixture);
    const handleId = fixture.addHandle('+15550000001');
    const chatId = fixture.addChat({
      identifier: '+15550000001',
      handleIds: [handleId],
    });

    const clockCtl = fakeClock();
    const probeCtl = mutableProbes({
      osMajor: 15,
      fda: 'eperm',
      automation: 'denied',
      messagesRunning: false,
    });
    const backend = createLoopbackSendBackend(fixture, clockCtl.clock);
    const watcher1 = fakeWatcher();

    const daemon1 = await startDaemon({
      configDir,
      chatDbPath,
      clock: clockCtl.clock,
      watcher: watcher1,
      doctorProbes: probeCtl.probes,
      backend,
      backendName: 'loopback',
    });
    daemons.push(daemon1);
    const token1 = daemon1.server.token;
    if (token1 === null) throw new Error('boot: expected a token');
    const env1 = {
      WEMESSAGE_PORT: String(daemon1.port),
      WEMESSAGE_TOKEN: token1,
      WEMESSAGE_CHATDB_PATH: chatDbPath,
    };
    const client1 = createClient({
      baseUrl: `http://127.0.0.1:${daemon1.port}`,
      token: token1,
    });

    // ---- Step 1: fresh boot, all probes red -> disconnected; doctor
    // lists the (precedence-short-circuited, single) failing check with
    // its remediation ----
    const redDoctor = await client1.doctor();
    expect(redDoctor.state).toBe('disconnected');
    expect(redDoctor.checks).toEqual([
      { id: 'os', status: 'ok', detail: expect.any(String) },
      { id: 'fda', status: 'fail', remediation: FDA_EPERM },
    ]);

    const redCli = await runCli(['doctor'], env1);
    expect(redCli.code).toBe(1);
    expect(NO_ANSI.test(redCli.stdout)).toBe(false);
    expect(NO_ANSI.test(redCli.stderr)).toBe(false);

    // ---- Step 2: doctor walks the fresh Mac to green. fda -> ok,
    // re-doctor (a fresh GET /v1/doctor, never a cached value) ->
    // read-only; automation -> ok (+ messages running), re-doctor ->
    // fully-connected ----
    probeCtl.set({ fda: 'ok' });
    const readOnlyDoctor = await client1.doctor();
    expect(readOnlyDoctor.state).toBe('read-only');
    expect(readOnlyDoctor.checks).toEqual([
      { id: 'os', status: 'ok', detail: expect.any(String) },
      { id: 'fda', status: 'ok' },
      { id: 'automation', status: 'fail', remediation: AUTOMATION_DENIED },
    ]);

    probeCtl.set({ automation: 'ok', messagesRunning: true });
    const greenDoctor = await client1.doctor();
    expect(greenDoctor.state).toBe('fully-connected');
    expect(greenDoctor.checks).toEqual([
      { id: 'os', status: 'ok', detail: expect.any(String) },
      { id: 'fda', status: 'ok' },
      { id: 'automation', status: 'ok' },
      { id: 'messages', status: 'ok' },
    ]);

    const greenCli = await runCli(['doctor'], env1);
    expect(greenCli.code).toBe(0);
    expect(NO_ANSI.test(greenCli.stdout)).toBe(false);
    expect(NO_ANSI.test(greenCli.stderr)).toBe(false);

    // ---- Step 3: a client send lands through the real loopback backend;
    // the draft.created -> draft.approved -> draft.sent trio broadcasts
    // over WS as a subsequence (the greeting frame precedes it); the
    // audit chain verifies clean over the whole thing ----
    const ws1 = await connectWs(`http://127.0.0.1:${daemon1.port}`, token1);
    sockets.push(ws1.socket);
    await waitFor(() => ws1.frames.length >= 1, 'daemon1 WS greeting');
    expect(ws1.frames[0]).toEqual({
      event: 'connection.state',
      state: 'fully-connected',
    });

    const sendResult = await client1.send({
      to: '+15550000001',
      body: 'hello from wemessage e2e',
    });
    expect(sendResult.outcome).toBe('sent');
    if (sendResult.outcome !== 'sent') throw new Error('unreachable');
    const sentDraftId = sendResult.draftId;
    const sentGuid = sendResult.sentMessageGuid;
    expect(backend.callCount()).toBe(1);

    await waitFor(
      () => ws1.frames.length >= 4,
      'draft.created/approved/sent trio',
    );
    const eventsAfterSend = ws1.frames.map((f) => f.event);
    expect(
      isSubsequence(eventsAfterSend, [
        'draft.created',
        'draft.approved',
        'draft.sent',
      ]),
    ).toBe(true);

    const verify1 = await client1.verifyAudit();
    expect(verify1.ok).toBe(true);

    ws1.socket.close();

    // ---- Step 4: restart on the SAME configDir. daemon.ts always hands
    // recovery a hardcoded must-not-call fake (never the caller's real
    // backend), so the loopback backend is structurally unreachable from
    // recovery; the already-sent draft is untouched (never appears in
    // recovery.drafts, since listSendingDrafts() only returns drafts
    // still 'sending'); the pre-restart token still authenticates ----
    await daemon1.stop();
    daemons.splice(daemons.indexOf(daemon1), 1);

    const watcher2 = fakeWatcher();
    const daemon2 = await startDaemon({
      configDir,
      chatDbPath,
      clock: clockCtl.clock,
      watcher: watcher2,
      doctorProbes: probeCtl.probes,
      backend,
      backendName: 'loopback',
    });
    daemons.push(daemon2);

    expect(daemon2.bootLog).toEqual(['recovery', 'watcher', 'listen']);
    expect(daemon2.recovery.cursor).toBeDefined();
    expect(
      daemon2.recovery.drafts.find((d) => d.draftId === sentDraftId),
    ).toBeUndefined();
    expect(backend.callCount()).toBe(1); // unchanged: no re-send

    const token2 = daemon2.server.token;
    if (token2 === null) throw new Error('restart: expected a token');
    expect(token2).toBe(token1); // same configDir, no rotation on restart

    const client2 = createClient({
      baseUrl: `http://127.0.0.1:${daemon2.port}`,
      token: token2,
    });

    const draftAfterRestart = daemon2.store.getDraft(sentDraftId);
    expect(draftAfterRestart?.state).toBe('sent');
    expect(draftAfterRestart?.sentMessageGuid).toBe(sentGuid);

    const verify2 = await client2.verifyAudit();
    expect(verify2.ok).toBe(true);

    // ---- Step 5: disconnect -> old token 401s, a fixture append while
    // disconnected is never ingested, a send 403s (gate-denied), and the
    // WS's own literal final frame (before the server closes the socket)
    // is gateway.disconnected ----
    const baseUrl2 = `http://127.0.0.1:${daemon2.port}`;
    const ws2 = await connectWs(baseUrl2, token2);
    sockets.push(ws2.socket);
    await waitFor(() => ws2.frames.length >= 1, 'daemon2 WS greeting');
    expect(ws2.frames[0]).toEqual({
      event: 'connection.state',
      state: 'fully-connected',
    });

    const disconnectReport = await client2.disconnect();
    expect(disconnectReport.state).toBe('disconnected');

    await ws2.closed;
    expect(ws2.frames[ws2.frames.length - 1]).toEqual({
      event: 'gateway.disconnected',
      reason: 'user-disconnect',
    });

    const oldTokenAttempt = await fetch(`${baseUrl2}/v1/status`, {
      headers: { authorization: `Bearer ${token2}` },
    });
    expect(oldTokenAttempt.status).toBe(401);

    const rotatedToken = readToken(configDir);
    if (rotatedToken === null) throw new Error('expected a rotated token');
    expect(rotatedToken).not.toBe(token2);

    // Fable design note: a plain new inbound message (no matching rule —
    // that pipeline is S4, not built yet) produces a WS-only
    // `message.received` broadcast, never an audit row (daemon.ts's
    // `deliver()`: audit only appends for edit/unsend mutations or an
    // actual rule match). The correct "was this ever scanned at all"
    // proof is the ingest cursor (`store.getCursor()`, the scan loop's
    // own ROWID watermark) — while disconnected the watch trigger is
    // fully unsubscribed (`stopWatcher()`), so firing the now
    // handler-less watcher can trigger no scan whatsoever, and the
    // cursor cannot move.
    const cursorBeforeDisconnectedAppend =
      daemon2.store.getCursor()?.lastRowid ?? 0;
    fixture.addMessage({
      chatId,
      handleId,
      text: 'must not be ingested while disconnected',
    });
    watcher2.fire();
    await new Promise((r) => setTimeout(r, 150));
    expect(daemon2.store.getCursor()?.lastRowid ?? 0).toBe(
      cursorBeforeDisconnectedAppend,
    );

    const client2r = createClient({ baseUrl: baseUrl2, token: rotatedToken });
    await client2r.send({ to: '+15550000001', body: 'denied' }).then(
      () => {
        throw new Error('expected send to be gate-denied while disconnected');
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(DaemonGateDeniedError);
        if (err instanceof DaemonGateDeniedError) {
          expect(err.reason).toBe('disconnected');
        }
      },
    );

    // ---- Step 6: connect -> green again (a fixture append while
    // connected IS ingested — the positive counterpart to step 5's
    // denial); then disconnect({purge:true}) -> 503 everything,
    // fail-closed end state ----
    const reconnectReport = await client2r.connect();
    expect(reconnectReport.state).toBe('fully-connected');

    const cursorBeforeConnectedAppend =
      daemon2.store.getCursor()?.lastRowid ?? 0;
    fixture.addMessage({
      chatId,
      handleId,
      text: 'ingested once reconnected',
    });
    watcher2.fire();
    await waitFor(
      () =>
        (daemon2.store.getCursor()?.lastRowid ?? 0) >
        cursorBeforeConnectedAppend,
      'post-reconnect ingest',
    );

    const purgeReport = await client2r.disconnect({ purge: true });
    expect(purgeReport.state).toBe('disconnected');

    const afterPurge = await fetch(`${baseUrl2}/v1/health`);
    expect(afterPurge.status).toBe(503);

    // ---- Step 7: the three S3 non-negotiables, structurally proven ----
    // (i) zero real osascript executions: structural (every DoctorProbes
    // above is the mutable fake, the SendBackend is the fixture-backed
    // loopback — main.ts's real ExecFn composition is never reached) AND
    // an active runtime spy on the one child_process function production
    // code ever shells through for it.
    expect(childProcessCalls).toEqual([]);
    // (ii) zero writes outside the temp dir: every path this flow was
    // configured with carries the tmp-dir prefix, and the fake HOME
    // sentinel (nothing above ever resolves a fallback from it, per the
    // WEMESSAGE_TOKEN short-circuit noted at setup) stays empty.
    expect(configDir.startsWith(dir)).toBe(true);
    expect(chatDbPath.startsWith(dir)).toBe(true);
    expect(readdirSync(fakeHome)).toEqual([]);
    // (iii) no ANSI escapes leaked into either CLI-rendered doctor
    // capture (already asserted directly above, steps 1 and 2).
  }, 60_000);
});
