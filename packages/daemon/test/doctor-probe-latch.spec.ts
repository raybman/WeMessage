/**
 * s9 Sc3 stage 2: THE ROW THAT LICENSES THE LAUNCHD LIFECYCLE ROWS.
 *
 * `launchd-lifecycle.spec.ts` starts the real `dist/main.js` under the real
 * macOS service manager, on the operator's own machine. That daemon composes
 * `createRealDoctorProbes`, whose automation probe shells out to the real
 * scripting runner — and a launchd job cannot be given a stubbed PATH the
 * way `main-lock.spec.ts` stubs one for a child it spawns itself, because a
 * launchd job's environment is the plist's `EnvironmentVariables` dict and
 * nothing else. Reaching the operator's real Messages.app from a test is
 * exactly what `test/arch.spec.ts` gate (b) exists to prevent; doing it by
 * way of launchd would be going around that gate rather than through it.
 *
 * So the lifecycle rows pre-seed `connection.userDisconnected` in their own
 * temp store, which is a state the product itself writes (POST
 * /v1/disconnect) and which `startDaemon` reads to skip the boot probe.
 *
 * THIS FILE IS WHY THAT IS ALLOWED TO BE BELIEVED. "No scripting runner is
 * spawned" must not rest on a code path somebody read once. It is decomposed
 * here into something mechanical: the real probe factory is built over a
 * SPY exec seam, the real `startDaemon` runs against it, and the spy is
 * asserted never to have been called. The row is genuinely red with the
 * latch unset — the last row in this file proves that by unsetting it.
 *
 * Note what is NOT claimed. This proves the daemon does not reach the exec
 * seam. It does not prove the operating system spawned nothing, and no test
 * can prove that. The lifecycle spec adds the other half by asserting the
 * latch is actually present in its temp store at the moment it installs.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Clock } from '@wemessage/core';
import { SETTING_USER_DISCONNECTED } from '@wemessage/core';
import { SqliteStore } from '@wemessage/store';
import { createChatDb } from '@wemessage/fixtures';
import type { ExecFn } from '@wemessage/sendkit';
import { startDaemon, type RunningDaemon } from '../src/daemon.js';
import { createRealDoctorProbes } from '../src/doctor.js';
import { createUnusedSendBackend } from './helpers/loopback-backend.js';

const clock: Clock = {
  now: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

interface Spy {
  readonly calls: { cmd: string; args: readonly string[] }[];
  readonly exec: ExecFn;
}

/**
 * The exec seam, recorded.
 *
 * It answers rather than throws, so that a run which DOES reach it gets far
 * enough to be a meaningful failure instead of an exception three frames
 * away from the thing being tested.
 */
function execSpy(): Spy {
  const calls: { cmd: string; args: readonly string[] }[] = [];
  return {
    calls,
    exec: async (cmd, args) => {
      calls.push({ cmd, args: [...args] });
      return { code: 0, stdout: '', stderr: '' };
    },
  };
}

function bed(latched: boolean): { configDir: string; chatDbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wm-latch-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const configDir = join(dir, 'config');
  const chatDbPath = join(dir, 'chat.db');
  const fixture = createChatDb(chatDbPath);
  fixture.close();

  // Exactly what the lifecycle spec does, and exactly what POST
  // /v1/disconnect writes: one setting, in this run's own temp store.
  const store = new SqliteStore({ dir: configDir, clock });
  try {
    store.setSetting(SETTING_USER_DISCONNECTED, latched ? '1' : '0');
  } finally {
    store.close();
  }
  return { configDir, chatDbPath };
}

async function boot(
  b: { configDir: string; chatDbPath: string },
  spy: Spy,
): Promise<RunningDaemon> {
  const daemon = await startDaemon({
    configDir: b.configDir,
    chatDbPath: b.chatDbPath,
    clock,
    watcher: { watch: () => () => undefined },
    // The REAL factory, over a recorded seam. Using a hand-written fake
    // probe set here would test nothing: the question is precisely whether
    // the production wiring reaches the production shell-out.
    doctorProbes: createRealDoctorProbes({
      osRelease: () => '25.5.0',
      chatDbPath: b.chatDbPath,
      exec: spy.exec,
    }),
    backend: createUnusedSendBackend(),
    backendName: 'unused',
  });
  cleanups.push(() => daemon.stop());
  return daemon;
}

describe('s9 Sc3 stage 2: the capability-probe latch, proven rather than assumed', () => {
  it('with the latch set, booting the daemon never reaches the exec seam', async () => {
    const spy = execSpy();
    await boot(bed(true), spy);
    expect(spy.calls).toEqual([]);
  });

  it('with the latch set, GET /v1/health never reaches the exec seam either', async () => {
    const spy = execSpy();
    const daemon = await boot(bed(true), spy);
    const token = daemon.server.token;
    if (token === null) throw new Error('boot: expected a token');
    const res = await daemon.server.app.inject({
      method: 'GET',
      url: '/v1/health',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(spy.calls).toEqual([]);
  });

  it('NON-VACUITY: with the latch UNSET the very same boot DOES reach it', async () => {
    /*
     * The row above is only worth having if it can fail. Same bed, same
     * probes, same seam — one setting different — and the automation probe
     * arrives at the exec seam. This is also the row that documents what
     * the lifecycle spec would otherwise be doing to the operator's
     * machine: two shell-outs per boot, and again on every /v1/doctor.
     */
    const spy = execSpy();
    await boot(bed(false), spy);
    expect(spy.calls.length).toBeGreaterThan(0);
    // Named as a shape, not as a literal: the runner's own name is
    // confined to packages/sendkit/src by arch gate (a), and this file is
    // not sendkit. What matters here is that SOMETHING was executed.
    for (const c of spy.calls) expect(typeof c.cmd).toBe('string');
  });

  it('NON-VACUITY: /v1/doctor reaches the exec seam even WITH the latch set', async () => {
    /*
     * The latch governs the BOOT probe, not the route — `runDoctor` is the
     * route's whole body. This is the fact that decides row 8's shape: the
     * lifecycle row asserts liveness on /v1/health and takes its evidence
     * of supervision from launchd's own view of the job, because calling
     * /v1/doctor under launchd would shell out no matter what the store
     * says. Stated as a row so a later reader cannot "restore" row 8 to
     * the plan's /v1/doctor form without this failing first.
     */
    const spy = execSpy();
    const daemon = await boot(bed(true), spy);
    expect(spy.calls).toEqual([]);
    const token = daemon.server.token;
    if (token === null) throw new Error('boot: expected a token');
    const res = await daemon.server.app.inject({
      method: 'GET',
      url: '/v1/doctor',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(spy.calls.length).toBeGreaterThan(0);
  });
});
