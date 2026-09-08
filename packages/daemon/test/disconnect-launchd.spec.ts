/**
 * s9 Sc4 — the launch-agent leg of POST /v1/disconnect.
 *
 * `disconnect.spec.ts` already owns the five steps that existed before a
 * supervisor did. This file owns the sixth, `launchd-unload`, and it owns it
 * separately because the sixth step is the only one that is TWO PHASES.
 *
 * The split is the whole subject. Everything that can be CHECKED -- who
 * supervises us, whether there is a label, whether that label is well formed,
 * and whether it is the label THIS config directory installed -- is decided
 * synchronously, while there is still a response to put the answer in. The
 * unload itself cannot be: a successful one ends this process, and an
 * operator who asked for a report would get a reset socket instead. So it is
 * armed as a thunk and the route fires it after the response is flushed.
 *
 * Two invariants follow, and most of the rows below exist to hold them:
 *
 *   A. THE AUDIT ROW IS APPENDED IN PHASE A. Not "before the unload" as a
 *      matter of ordering luck, but structurally: the row is committed by a
 *      synchronous append that has already returned by the time the thunk
 *      exists at all. §1.8 says the log comes before the side effect, and
 *      this is the strongest form of that available.
 *
 *   B. THE THUNK TOUCHES NO STORE. A purge closes the store, and the thunk
 *      runs after the purge. An append in there would throw into a context
 *      with no response left to carry the error.
 *
 * Nothing here spawns anything. The service runner is a fake, and no test in
 * this file names a real label outside the `sh.wemessage.` namespace or
 * touches `~/Library/LaunchAgents`.
 *
 * TEETH, run and reverted before this file was committed. Each names the row
 * it kills, because a mutation that fails "some row somewhere" proves only
 * that the suite is noisy:
 *
 *   TN-unload-before-flush M1 -- fire the unload in phase A, un-awaited,
 *     alongside the arming. Fails row 8 (phase B has not begun) and row 9
 *     (the label gets booted out twice).
 *   TN-unload-before-flush M2 -- await the thunk in the route before
 *     `reply.send`. Fails rows 12 and 13, by the report never arriving:
 *     `the disconnect report did not happen within 5000ms`. Note it takes an
 *     `async` handler to even compile, which is the shape of the mistake.
 *   TN-thunk-touches-store -- append the outcome from inside the thunk.
 *     Fails row 10 only.
 *
 * Rows 1 through 13 were written after the engine landed (s9 Sc4 steps 1-3),
 * so they were green on their first run. The three mutations above are what
 * stands in for the red, and they are the reason the rows are trustworthy.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEvent, Clock, FsWatcher, Store } from '@wemessage/core';
import { createChatDb } from '@wemessage/fixtures';
import {
  MANUAL_REVOCATION,
  disconnectDaemon,
  startDaemon,
  type AuditSink,
  type DisconnectDeps,
  type DisconnectReport,
  type DoctorProbes,
  type RunningDaemon,
} from '@wemessage/daemon';
import { createUnusedSendBackend } from './helpers/loopback-backend.js';

/*
 * THE SERVICE-RUNNER TYPES ARE DERIVED FROM `DisconnectDeps`, NOT IMPORTED.
 *
 * The obvious spelling is to pull `ServiceManagerRun` out of
 * `../src/launchd/contract.js`, the way the lifecycle spec does. It does not
 * compile here, and the reason is worth writing down because it will catch
 * the next person too. `DisconnectDeps` arrives from `@wemessage/daemon`,
 * which resolves to `dist/`, and the label type is BRANDED with a unique
 * symbol. The symbol declared in `dist/` is not the symbol declared in
 * `src/`, so the two `ServiceManagerRun`s are nominally different types and
 * a runner built against one is not assignable to the other.
 *
 * Deriving from the consumer sidesteps that and is the better statement
 * anyway: the fake is typed as EXACTLY what the disconnect engine will call,
 * with no second copy of that shape to drift.
 */
type SupervisionRun = NonNullable<DisconnectDeps['supervision']['run']>;
type RunOp = Parameters<SupervisionRun>[0];
type RunLabel = Parameters<SupervisionRun>[1];

const LABEL = 'sh.wemessage.test.sc4.gateway';
const NO_EM_DASH = /—/;

const dirs: string[] = [];
function bed(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wm-sc4-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** Write the state file `service install` would have written. */
function plantState(
  dir: string,
  state: { label: string; plistPath: string },
): void {
  writeFileSync(
    join(dir, 'service.json'),
    `${JSON.stringify({ ...state, bootstrapped: true }, null, 2)}\n`,
  );
}

/**
 * A store every method of which is a landmine.
 *
 * Used for invariant B. Nothing the disconnect does in phase A needs a
 * working store beyond the three methods `DisconnectDeps` actually declares,
 * so those three are real and everything reachable from the thunk is not.
 */
function fakeStore(): Pick<
  Store,
  'getSetting' | 'setSetting' | 'clearAdapterTokens'
> {
  const values = new Map<string, string>();
  return {
    getSetting: (key) => values.get(key) ?? null,
    setSetting: (key, value) => {
      values.set(key, value);
    },
    clearAdapterTokens: () => 0,
  };
}

interface Spy {
  readonly events: AuditEvent[];
  /** Every observable act, in the order it happened. */
  readonly markers: string[];
}

function fakeSink(spy: Spy): Pick<AuditSink, 'append' | 'broadcast'> {
  return {
    append: (event: AuditEvent) => {
      spy.events.push(event);
      spy.markers.push(`append:${event.type}`);
      return { seq: spy.events.length, hash: 'x'.repeat(64) };
    },
    broadcast: () => {
      spy.markers.push('broadcast');
    },
  };
}

interface Built {
  readonly deps: DisconnectDeps;
  readonly spy: Spy;
  readonly calls: { op: RunOp; label: RunLabel }[];
  readonly unloadErrors: unknown[];
}

function build(opts: {
  supervisor: 'launchd' | 'app' | 'none';
  label: string | null;
  serviceDir: string;
  /** `null` means "no runner available", which is its own failure mode. */
  run?: SupervisionRun | null;
}): Built {
  const spy: Spy = { events: [], markers: [] };
  const calls: { op: RunOp; label: RunLabel }[] = [];
  const unloadErrors: unknown[] = [];
  const defaultRun: SupervisionRun = async (op, label) => {
    calls.push({ op, label });
    spy.markers.push(`run:${op}`);
    return { code: 0, stdout: '', stderr: '' };
  };
  const chosen: SupervisionRun | null =
    opts.run === undefined ? defaultRun : opts.run;
  const deps: DisconnectDeps = {
    store: fakeStore(),
    sink: fakeSink(spy),
    stopWatcher: () => spy.markers.push('watcher-stop'),
    closeEventClients: () => spy.markers.push('close-clients'),
    rotateToken: () => {
      spy.markers.push('rotate');
      return `wm_${'a'.repeat(64)}`;
    },
    purge: () => spy.markers.push('purge'),
    supervision: {
      supervisor: opts.supervisor,
      label: opts.label,
      run: chosen,
      serviceDir: opts.serviceDir,
    },
    onUnloadError: (e: unknown) => {
      spy.markers.push('unload-error');
      unloadErrors.push(e);
    },
  };
  return { deps, spy, calls, unloadErrors };
}

function unloadStep(
  report: DisconnectReport,
): DisconnectReport['steps'][number] {
  const step = report.steps.find((s) => s.id === 'launchd-unload');
  if (step === undefined) throw new Error('no launchd-unload step in report');
  return step;
}

/* ── rows 1-3: the three ways there is nothing to unload ──────────────── */

describe('s9 Sc4 rows 1-3: the step reports why it did nothing', () => {
  it('row 1 — an unsupervised daemon SKIPS, arms nothing, and audits nothing', () => {
    const { deps, spy } = build({
      supervisor: 'none',
      label: null,
      serviceDir: bed(),
    });
    const { report, afterResponse } = disconnectDaemon(deps, { purge: false });

    const step = unloadStep(report);
    expect(step.status).toBe('skipped');
    expect(step.detail).toBe('not supervised by launchd (supervisor: none)');
    // Nothing armed, because there is nothing to unload. A thunk here would
    // be a `bootout` against whatever label the environment last held.
    expect(afterResponse).toBeNull();
    // And no audit row: `service.unload_requested` means a human asked for an
    // unload. Nobody did.
    expect(spy.events.map((e) => e.type)).not.toContain(
      'service.unload_requested',
    );
  });

  it('row 2 — `app` is skipped for the same reason, and says which supervisor', () => {
    // The desktop app supervises its own child. There is no job to unload,
    // and the detail must name the supervisor rather than say "not launchd",
    // because the operator reading it is trying to work out what IS running.
    const { deps } = build({
      supervisor: 'app',
      label: null,
      serviceDir: bed(),
    });
    const { report, afterResponse } = disconnectDaemon(deps, { purge: false });
    expect(unloadStep(report).status).toBe('skipped');
    expect(unloadStep(report).detail).toBe(
      'not supervised by launchd (supervisor: app)',
    );
    expect(afterResponse).toBeNull();
  });

  it('row 3 — supervised but unlabelled is a FAILURE, not a skip', () => {
    /*
     * The difference matters to the operator. `skipped` says "there was
     * nothing to do"; this case has something to do and cannot do it, so the
     * job is still installed and still comes back at the next login. Calling
     * that skipped would be a lie of exactly the kind this report exists to
     * avoid.
     */
    const { deps, spy } = build({
      supervisor: 'launchd',
      label: null,
      serviceDir: bed(),
    });
    const { report, afterResponse } = disconnectDaemon(deps, { purge: false });
    expect(unloadStep(report).status).toBe('failed');
    expect(unloadStep(report).detail).toBe(
      'supervised by launchd but no label in the environment',
    );
    expect(afterResponse).toBeNull();
    expect(spy.events.map((e) => e.type)).not.toContain(
      'service.unload_requested',
    );
  });
});

/* ── rows 4-6: the three refusals that protect somebody else's job ────── */

describe('s9 Sc4 rows 4-6: a refusal never throws and never leaves the report', () => {
  it('row 4 — a malformed label is a failed STEP, never an exception', () => {
    /*
     * `WEMESSAGE_LAUNCHD_LABEL` is deliberately unvalidated at boot, because
     * the plist that carries it also carries `KeepAlive`: a daemon that
     * exited on a bad label would not fail once, it would fail forever. The
     * cost of that choice is paid here, and it must be paid as a failed row
     * rather than a throw. A bad environment variable must not be able to
     * block a disconnect: the other five steps are what actually stop the
     * gateway sending, and they must still run.
     */
    const { deps } = build({
      supervisor: 'launchd',
      label: 'com.example.not-ours',
      serviceDir: bed(),
    });
    let thrown: unknown = null;
    let out: { report: DisconnectReport } | null = null;
    try {
      out = disconnectDaemon(deps, { purge: false });
    } catch (e) {
      thrown = e;
    }
    // Stated as its own assertion so the row FAILS on the throw rather than
    // erroring out of the suite with a stack nobody reads as a verdict.
    expect(thrown).toBeNull();
    if (out === null) throw new Error('no report');
    const settled: DisconnectReport = out.report;
    expect(unloadStep(settled).status).toBe('failed');
    // The refusal carries the refusing message, so the operator learns WHICH
    // rule the label broke rather than that some rule did.
    expect(unloadStep(settled).detail ?? '').toContain('com.example.not-ours');
    // And the disconnect still happened: all six steps are present.
    expect(settled.steps.map((s) => s.id)).toEqual([
      'watcher-stop',
      'state',
      'adapter-tokens',
      'token-rotation',
      'launchd-unload',
      'purge',
    ]);
  });

  it('row 5 — a config directory that installed nothing may not unload anything', () => {
    // The prefix guard proves the label belongs to this PROJECT. It does not
    // prove it belongs to this INSTALLATION. Only the state file does, and
    // there is no state file here.
    const { deps } = build({
      supervisor: 'launchd',
      label: LABEL,
      serviceDir: bed(),
    });
    const { report, afterResponse } = disconnectDaemon(deps, { purge: false });
    expect(unloadStep(report).status).toBe('failed');
    expect(unloadStep(report).detail).toBe(
      'no service state in this config directory',
    );
    expect(afterResponse).toBeNull();
  });

  it('row 6 — a label the environment names but this directory did not install', () => {
    /*
     * THE ATTACK THIS ROW IS ABOUT. Both labels below are well formed and
     * both are inside our own namespace, so every guard upstream of this one
     * passes. Without the state-file comparison, a single environment
     * variable would point one installation's disconnect at a SIBLING
     * installation's launch agent.
     */
    const dir = bed();
    plantState(dir, {
      label: 'sh.wemessage.test.sc4.other',
      plistPath: join(dir, 'sh.wemessage.test.sc4.other.plist'),
    });
    const { deps, calls } = build({
      supervisor: 'launchd',
      label: LABEL,
      serviceDir: dir,
    });
    const { report, afterResponse } = disconnectDaemon(deps, { purge: false });
    expect(unloadStep(report).status).toBe('failed');
    expect(unloadStep(report).detail).toBe(
      'the label in the environment is not the one this directory installed',
    );
    expect(afterResponse).toBeNull();
    expect(calls).toEqual([]);
  });
});

/* ── rows 7-9: the two phases, and the order between them ─────────────── */

describe('s9 Sc4 rows 7-9: armed in phase A, fired in phase B', () => {
  function happy(purge = false): Built & {
    report: DisconnectReport;
    afterResponse: (() => Promise<void>) | null;
    dir: string;
    plistPath: string;
  } {
    const dir = bed();
    const plistPath = join(dir, `${LABEL}.plist`);
    writeFileSync(plistPath, '<plist/>\n');
    plantState(dir, { label: LABEL, plistPath });
    const built = build({
      supervisor: 'launchd',
      label: LABEL,
      serviceDir: dir,
    });
    const out = disconnectDaemon(built.deps, { purge });
    return { ...built, ...out, dir, plistPath };
  }

  it('row 7 — the step is SCHEDULED, which is neither done nor failed', () => {
    /*
     * `done` would claim the job is unloaded; it is not, and will not be
     * until the socket closes. `failed` would claim it will not be; it will.
     * `skipped` would claim nobody asked. All three are false at the instant
     * this report is written, and `scheduled` is the only word that is true.
     */
    const { report, afterResponse } = happy();
    const step = unloadStep(report);
    expect(step.status).toBe('scheduled');
    expect(step.detail).toBe(
      'unload requested; it runs once this response is sent',
    );
    expect(step.detail ?? '').not.toMatch(NO_EM_DASH);
    expect(afterResponse).not.toBeNull();
  });

  it('row 8 — the audit row is appended BEFORE the thunk exists', async () => {
    /*
     * §1.8 in its strongest available form. This is not "the append happens
     * to come first": `disconnectDaemon` returns synchronously, and by the
     * time it has returned, the append has already happened and the unload
     * has NOT. The markers prove both halves.
     */
    const { report, afterResponse, spy, calls } = happy();
    expect(unloadStep(report).status).toBe('scheduled');

    // Phase A is over, and the record of the request exists.
    expect(spy.markers).toContain('append:service.unload_requested');
    // Phase B has not begun.
    expect(spy.markers).not.toContain('run:bootout');
    expect(calls).toEqual([]);

    const requested = spy.events.find(
      (e) => e.type === 'service.unload_requested',
    );
    expect(requested).toBeDefined();
    expect(requested).toEqual({
      type: 'service.unload_requested',
      label: LABEL,
    });

    // And the append is strictly before the unload in one ordered list, so a
    // future refactor that moved the append into the thunk fails HERE rather
    // than passing two independent assertions that no longer mean anything.
    if (afterResponse === null) throw new Error('nothing armed');
    await afterResponse();
    expect(spy.markers.indexOf('append:service.unload_requested')).toBeLessThan(
      spy.markers.indexOf('run:bootout'),
    );
  });

  it('row 9 — firing the thunk unloads exactly our own label, exactly once', async () => {
    const { afterResponse, calls } = happy();
    if (afterResponse === null) throw new Error('nothing armed');
    await afterResponse();
    expect(calls).toEqual([{ op: 'bootout', label: LABEL }]);
  });
});

/* ── rows 10-11: what phase B may not do, and what survives it ────────── */

describe('s9 Sc4 rows 10-11: the thunk is alone, and the plist may outlive it', () => {
  it('row 10 — a failing unload reaches the callback and never rejects', async () => {
    /*
     * INVARIANT B, and the reason it is a callback rather than a throw. By
     * the time this runs the response is gone and, after a purge, so is the
     * store. There is nothing left to carry an error to except the process
     * log, so the thunk must not reject and must not append.
     */
    const dir = bed();
    const plistPath = join(dir, `${LABEL}.plist`);
    plantState(dir, { label: LABEL, plistPath });
    const boom = new Error('the service manager exploded');
    const built = build({
      supervisor: 'launchd',
      label: LABEL,
      serviceDir: dir,
      run: async () => {
        throw boom;
      },
    });
    const { afterResponse } = disconnectDaemon(built.deps, { purge: true });
    if (afterResponse === null) throw new Error('nothing armed');

    const before = built.spy.events.length;
    await expect(afterResponse()).resolves.toBeUndefined();
    expect(built.unloadErrors).toEqual([boom]);
    // Not one row appended after the response went out.
    expect(built.spy.events).toHaveLength(before);
  });

  it('row 11 — a surviving plist earns a named remainder; a removed one does not', () => {
    /*
     * A plist that outlives a disconnect is not a leftover file, it is a job
     * that comes back at the next login: `RunAtLoad` and `KeepAlive` are both
     * true. So the operator is told what is still on disk and the one command
     * that removes it -- but ONLY when that is the situation, because a line
     * telling somebody to fix a thing that is not broken is how honest copy
     * becomes noise people learn to skip.
     */
    const kept = (() => {
      const dir = bed();
      const plistPath = join(dir, `${LABEL}.plist`);
      writeFileSync(plistPath, '<plist/>\n');
      plantState(dir, { label: LABEL, plistPath });
      const built = build({
        supervisor: 'launchd',
        label: LABEL,
        serviceDir: dir,
      });
      return {
        ...disconnectDaemon(built.deps, { purge: false }),
        plistPath,
      };
    })();
    expect(existsSync(kept.plistPath)).toBe(true);
    expect(unloadStep(kept.report).plistRemoved).toBeUndefined();
    expect(kept.report.manualRevocation).toHaveLength(
      MANUAL_REVOCATION.length + 1,
    );
    const line = kept.report.manualRevocation.at(-1) ?? '';
    expect(line).toContain(kept.plistPath);
    expect(line).toContain('wemessaged service uninstall');
    expect(line).not.toMatch(NO_EM_DASH);

    const purged = (() => {
      const dir = bed();
      const plistPath = join(dir, `${LABEL}.plist`);
      writeFileSync(plistPath, '<plist/>\n');
      plantState(dir, { label: LABEL, plistPath });
      const built = build({
        supervisor: 'launchd',
        label: LABEL,
        serviceDir: dir,
      });
      return {
        ...disconnectDaemon(built.deps, { purge: true }),
        plistPath,
      };
    })();
    expect(existsSync(purged.plistPath)).toBe(false);
    expect(unloadStep(purged.report).plistRemoved).toBe(true);
    // No remainder, because there is no remainder.
    expect(purged.report.manualRevocation).toEqual(MANUAL_REVOCATION);
  });

  it('row 11b — a plist whose name is not this label`s is never deleted', () => {
    /*
     * The same caution the installer takes, for the same reason: launchd
     * obeys the file, so only a file this label would have written is a file
     * this label may delete. A state file naming somebody else`s path is a
     * corrupted state file, not a licence.
     */
    const dir = bed();
    const foreign = join(dir, 'com.example.someone-else.plist');
    writeFileSync(foreign, '<plist/>\n');
    plantState(dir, { label: LABEL, plistPath: foreign });
    const built = build({
      supervisor: 'launchd',
      label: LABEL,
      serviceDir: dir,
    });
    const { report } = disconnectDaemon(built.deps, { purge: true });
    expect(existsSync(foreign)).toBe(true);
    expect(unloadStep(report).plistRemoved).toBeUndefined();
    expect(report.manualRevocation.at(-1) ?? '').toContain(foreign);
  });
});

/* ── rows 12-13: the same two phases, through the real route ──────────── */

/**
 * Everything above is a unit test of the engine, and a unit test cannot see
 * the fact these rows exist for: the engine only ARMS the unload, and
 * something else has to fire it at the right moment. That something is one
 * line in `routes/connection.ts`, and the two ways it can be written wrong
 * are invisible to every row above.
 *
 * Real sockets, not `app.inject`. The whole subject is when the response is
 * finished on the wire, so an in-process injection would be testing a mock of
 * the exact mechanism under test.
 */
describe('s9 Sc4 rows 12-13: the route fires phase B, and never waits for it', () => {
  const clock: Clock = {
    now: () => new Date().toISOString(),
    nowMs: () => Date.now(),
  };
  const probes: DoctorProbes = {
    osMajor: () => 15,
    fda: async () => 'ok',
    automation: async () => 'ok',
    messagesRunning: async () => true,
  };
  const idleWatcher: FsWatcher = {
    watch: () => () => {},
  };

  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) await fn();
  });

  interface Booted {
    daemon: RunningDaemon;
    baseUrl: string;
    token: string;
    configDir: string;
    /** Resolves once the deferred unload has actually been asked for. */
    unloadStarted: Promise<{ op: string; label: string }>;
    /** Lets the blocked unload finish. */
    release: () => void;
    unloadErrors: unknown[];
  }

  async function boot(outcome: 'block' | 'reject' = 'block'): Promise<Booted> {
    const dir = mkdtempSync(join(tmpdir(), 'wm-sc4-route-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const configDir = join(dir, 'config');
    const chatDbPath = join(dir, 'chat.db');
    const fixture = createChatDb(chatDbPath);
    cleanups.push(() => fixture.close());

    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let announce: (c: { op: string; label: string }) => void = () => {};
    const unloadStarted = new Promise<{ op: string; label: string }>((r) => {
      announce = r;
    });
    const unloadErrors: unknown[] = [];

    const daemon = await startDaemon({
      configDir,
      chatDbPath,
      clock,
      watcher: idleWatcher,
      doctorProbes: probes,
      backend: createUnusedSendBackend(),
      backendName: 'unused',
      supervision: {
        supervisor: 'launchd',
        label: LABEL,
        // The runner BLOCKS. That is the entire instrument: if any code on
        // the request path awaits this, the operator's report never lands.
        run: async (op, label) => {
          announce({ op, label });
          await gate;
          if (outcome === 'reject') throw new Error('the unload failed');
          return { code: 0, stdout: '', stderr: '' };
        },
        serviceDir: configDir,
      },
      onUnloadError: (e: unknown) => unloadErrors.push(e),
    });
    cleanups.push(() => daemon.stop());
    // Released unconditionally at teardown so a row that fails early cannot
    // leave the gate closed and the daemon holding a pending promise.
    cleanups.push(() => release());

    const token = daemon.server.token;
    if (token === null) throw new Error('boot: expected a token');

    // The state file `service install` would have left behind. Written after
    // boot because `startDaemon` owns the creation of the config directory.
    const plistPath = join(configDir, `${LABEL}.plist`);
    writeFileSync(plistPath, '<plist/>\n');
    plantState(configDir, { label: LABEL, plistPath });

    return {
      daemon,
      baseUrl: `http://127.0.0.1:${String(daemon.port)}`,
      token,
      configDir,
      unloadStarted,
      release,
      unloadErrors,
    };
  }

  async function disconnect(ctx: Booted): Promise<{
    status: number;
    body: DisconnectReport;
  }> {
    const res = await fetch(`${ctx.baseUrl}/v1/disconnect`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ctx.token}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    return { status: res.status, body: (await res.json()) as DisconnectReport };
  }

  /** Rejects rather than hanging, so a regression names itself. */
  async function within<T>(
    what: string,
    ms: number,
    p: Promise<T>,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(`${what} did not happen within ${String(ms)}ms`),
              ),
            ms,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  it('row 12 — the report lands while the unload is still blocked', async () => {
    /*
     * THE ROW THAT REFUSES THE OBVIOUS IMPLEMENTATION. Awaiting the unload
     * before replying reads as the careful thing to do: report what actually
     * happened rather than what was scheduled. It cannot work. A successful
     * `bootout` of our own label ends this process, so the await never
     * returns, the socket dies unanswered, and the operator sees a connection
     * reset at the exact moment they most need to be told what was torn down.
     *
     * The blocked runner stands in for that. If anything on the request path
     * awaits it, the fetch below never resolves and this row says so by name.
     */
    const ctx = await boot('block');
    const { status, body } = await within(
      'the disconnect report',
      5_000,
      disconnect(ctx),
    );
    expect(status).toBe(200);
    const step = body.steps.find((s) => s.id === 'launchd-unload');
    expect(step?.status).toBe('scheduled');

    // And the arming is real: phase B does run once the response is done.
    const call = await within('the deferred unload', 5_000, ctx.unloadStarted);
    expect(call).toEqual({ op: 'bootout', label: LABEL });
    ctx.release();
  });

  it('row 13 — a phase-B failure is invisible to the client and lands on the callback', async () => {
    // The other half of why it is deferred: by the time the unload fails
    // there is no response left to put the failure in, so it must go to the
    // process log and nowhere else. A 200 here is not a lie, it is the
    // honest report of a request that was fully carried out.
    const ctx = await boot('reject');
    const { status, body } = await within(
      'the disconnect report',
      5_000,
      disconnect(ctx),
    );
    expect(status).toBe(200);
    expect(body.state).toBe('disconnected');
    await within('the deferred unload', 5_000, ctx.unloadStarted);
    ctx.release();
    await within(
      'the unload failure to reach the callback',
      5_000,
      (async () => {
        const deadline = Date.now() + 4_000;
        while (ctx.unloadErrors.length === 0 && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 10));
      })(),
    );
    expect(ctx.unloadErrors).toHaveLength(1);
  });
});
