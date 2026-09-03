/**
 * Scenario 7 — Doctor probes + degradation engine (s3-execution §2.2.3;
 * Fable design consult, coordinator-confirmed). ★ CHECKPOINT.
 *
 * Pure `evaluateDoctor` is exercised directly against the 7-row matrix (row 3
 * splits into two sub-rows, 8 cases total) with fake `DoctorSnapshot`
 * objects, asserting the exact verbatim remediation/detail copy (no em
 * dashes, no source-file access needed — the strings are pinned here from
 * doctor.ts's own header comment: "asserted verbatim in doctor.spec.ts").
 *
 * `runDoctor` is exercised against fake `DoctorProbes` + a tiny in-memory
 * fake `Store` (`Pick<Store, 'getSetting' | 'setSetting'>`, matching the
 * gate.spec.ts fake-port convention) + a fake `AuditSink`
 * (`Pick<AuditSink, 'append' | 'broadcast'>`, vi.fn() spies) + a fake
 * `Clock`, proving: os-unsupported short-circuits before the other three
 * probes are ever called; the only-on-change dedup (identical derived state
 * on a second call appends/broadcasts nothing); the first-ever `null -> X`
 * transition still emits exactly once.
 *
 * One `startDaemon` integration test (real store, real ingest over a fixture
 * chat.db, fake watcher, fake clock, injected `doctorProbes` fake standing in
 * for real sendkit/ingest probes — never real osascript, test/arch.spec.ts
 * gate (b)) proves `GET /v1/status` and the WS greeting both reflect the
 * probe-driven state end to end.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent, Clock, FsWatcher, Store } from '@wemessage/core';
import {
  SETTING_AUTO_LAUNCH_MESSAGES,
  SETTING_CONNECTION_STATE,
} from '@wemessage/core';
import { createChatDb } from '@wemessage/fixtures';
import { createClient } from '@wemessage/client';
import type { GatewayEventPayload } from '@wemessage/protocol';
import {
  evaluateDoctor,
  macOsMajorFromRelease,
  readConnectionState,
  runDoctor,
  startDaemon,
  type AuditSink,
  type DoctorProbes,
  type DoctorSnapshot,
} from '@wemessage/daemon';

// Verbatim copy pinned from doctor.ts's own module-private constants (its
// header comment commits to keeping these in sync with this file).
const UNSUPPORTED_OS =
  'This macOS version is unsupported; the gateway requires macOS 13 or newer.';
const CHATDB_SCHEMA_HONESTY =
  'chat.db schema verified stable through macOS 26; newer releases may change it without notice.';
const FDA_EPERM =
  'Full Disk Access is not reaching the daemon; on macOS 26, FDA does not propagate to background items. Grant Full Disk Access to wemessaged in System Settings > Privacy & Security, then restart the agent. Running unpackaged: grants attach to your terminal/node binary, not sh.wemessage.gateway.';
const FDA_ENOENT =
  'No Messages history found at the chat.db path; this is not a permission failure. Sign in to Messages and send or receive a message to create it.';
const AUTOMATION_DENIED =
  'Automation permission denied; run tccutil reset AppleEvents sh.wemessage.gateway and approve the prompt on the next send. Running unpackaged: grants attach to your terminal/node binary, not sh.wemessage.gateway.';
const MESSAGES_WARN_3A =
  'Messages is not running; the gateway will launch it automatically on the next send.';
const MESSAGES_FAIL_3B =
  'Messages must be running to send; open Messages, or enable send.autoLaunchMessages to let the gateway launch it.';

const NO_EM_DASH = /—/;
for (const s of [
  UNSUPPORTED_OS,
  CHATDB_SCHEMA_HONESTY,
  FDA_EPERM,
  FDA_ENOENT,
  AUTOMATION_DENIED,
  MESSAGES_WARN_3A,
  MESSAGES_FAIL_3B,
]) {
  if (NO_EM_DASH.test(s)) throw new Error('fixture string contains an em dash');
}

const healthy: DoctorSnapshot = {
  osMajor: 15,
  fda: 'ok',
  automation: 'ok',
  messagesRunning: true,
  autoLaunch: true,
};

describe('evaluateDoctor — pure derivation (§2.2.3 matrix, 7 rows / 8 cases)', () => {
  it('row 1/2: macOS 13+, FDA ok, automation ok, Messages running -> fully-connected, every check ok', () => {
    expect(evaluateDoctor(healthy)).toEqual({
      state: 'fully-connected',
      checks: [
        { id: 'os', status: 'ok', detail: CHATDB_SCHEMA_HONESTY },
        { id: 'fda', status: 'ok' },
        { id: 'automation', status: 'ok' },
        { id: 'messages', status: 'ok' },
      ],
    });
  });

  it('row 3a: Messages not running + autoLaunch on -> fully-connected, with a messages warn', () => {
    expect(
      evaluateDoctor({ ...healthy, messagesRunning: false, autoLaunch: true }),
    ).toEqual({
      state: 'fully-connected',
      checks: [
        { id: 'os', status: 'ok', detail: CHATDB_SCHEMA_HONESTY },
        { id: 'fda', status: 'ok' },
        { id: 'automation', status: 'ok' },
        { id: 'messages', status: 'warn', remediation: MESSAGES_WARN_3A },
      ],
    });
  });

  it('row 3b: Messages not running + autoLaunch off -> read-only, with a messages fail', () => {
    expect(
      evaluateDoctor({
        ...healthy,
        messagesRunning: false,
        autoLaunch: false,
      }),
    ).toEqual({
      state: 'read-only',
      checks: [
        { id: 'os', status: 'ok', detail: CHATDB_SCHEMA_HONESTY },
        { id: 'fda', status: 'ok' },
        { id: 'automation', status: 'ok' },
        { id: 'messages', status: 'fail', remediation: MESSAGES_FAIL_3B },
      ],
    });
  });

  it('row 4: automation denied -> read-only, short-circuits before the messages check', () => {
    expect(evaluateDoctor({ ...healthy, automation: 'denied' })).toEqual({
      state: 'read-only',
      checks: [
        { id: 'os', status: 'ok', detail: CHATDB_SCHEMA_HONESTY },
        { id: 'fda', status: 'ok' },
        { id: 'automation', status: 'fail', remediation: AUTOMATION_DENIED },
      ],
    });
  });

  it('row 5: FDA eperm -> disconnected, short-circuits before automation/messages', () => {
    expect(evaluateDoctor({ ...healthy, fda: 'eperm' })).toEqual({
      state: 'disconnected',
      checks: [
        { id: 'os', status: 'ok', detail: CHATDB_SCHEMA_HONESTY },
        { id: 'fda', status: 'fail', remediation: FDA_EPERM },
      ],
    });
  });

  it('row 5 (variant): FDA error (non-TCC failure) also -> disconnected', () => {
    expect(evaluateDoctor({ ...healthy, fda: 'error' })).toEqual({
      state: 'disconnected',
      checks: [
        { id: 'os', status: 'ok', detail: CHATDB_SCHEMA_HONESTY },
        { id: 'fda', status: 'fail', remediation: FDA_EPERM },
      ],
    });
  });

  it('row 6: FDA enoent (no chat.db yet) -> read-only, short-circuits before automation/messages', () => {
    expect(evaluateDoctor({ ...healthy, fda: 'enoent' })).toEqual({
      state: 'read-only',
      checks: [
        { id: 'os', status: 'ok', detail: CHATDB_SCHEMA_HONESTY },
        { id: 'fda', status: 'warn', remediation: FDA_ENOENT },
      ],
    });
  });

  it('row 7: unsupported macOS (<13) -> unsupported, a single check, nothing else evaluated', () => {
    expect(
      evaluateDoctor({
        osMajor: 12,
        fda: 'eperm', // would otherwise win precedence; os wins first
        automation: 'denied',
        messagesRunning: false,
        autoLaunch: false,
      }),
    ).toEqual({
      state: 'unsupported',
      checks: [
        {
          id: 'os',
          status: 'fail',
          detail: 'detected macOS 12',
          remediation: UNSUPPORTED_OS,
        },
      ],
    });
  });
});

describe('macOsMajorFromRelease — pure Darwin -> macOS formula', () => {
  it.each([
    ['22.1.0', 13], // Ventura
    ['23.6.0', 14], // Sonoma
    ['24.5.0', 15], // Sequoia
    ['25.0.0', 26], // Tahoe
    ['26.0.0', 27], // assumed next
    ['19.6.0', 0], // Catalina and older: fail-closed
    ['not-a-release', 0],
    ['', 0],
  ])('%s -> %d', (release, expected) => {
    expect(macOsMajorFromRelease(release)).toBe(expected);
  });
});

function fakeStore(
  initial: Record<string, string> = {},
): Pick<Store, 'getSetting' | 'setSetting'> {
  const values = new Map(Object.entries(initial));
  return {
    getSetting: (key) => values.get(key) ?? null,
    setSetting: (key, value) => {
      values.set(key, value);
    },
  };
}

function fakeSink(): Pick<AuditSink, 'append' | 'broadcast'> & {
  appends: { event: AuditEvent; actor: unknown }[];
  broadcasts: GatewayEventPayload[];
} {
  const appends: { event: AuditEvent; actor: unknown }[] = [];
  const broadcasts: GatewayEventPayload[] = [];
  return {
    appends,
    broadcasts,
    append: vi.fn((event: AuditEvent, actor: unknown) => {
      appends.push({ event, actor });
      return { seq: appends.length, hash: `h${appends.length}` };
    }),
    broadcast: vi.fn((payload: GatewayEventPayload) => {
      broadcasts.push(payload);
    }),
  };
}

const fixedClock: Clock = {
  now: () => '2026-09-01T00:00:00.000Z',
  nowMs: () => 1_756_684_800_000,
};

function fakeProbes(overrides: Partial<DoctorSnapshot> = {}): DoctorProbes & {
  calls: { fda: number; automation: number; messagesRunning: number };
} {
  const snap = { ...healthy, ...overrides };
  const calls = { fda: 0, automation: 0, messagesRunning: 0 };
  return {
    calls,
    osMajor: () => snap.osMajor,
    fda: async () => {
      calls.fda++;
      return snap.fda;
    },
    automation: async () => {
      calls.automation++;
      return snap.automation;
    },
    messagesRunning: async () => {
      calls.messagesRunning++;
      return snap.messagesRunning;
    },
  };
}

describe('runDoctor — orchestration + only-on-change persistence (§2.2.3)', () => {
  it('first-ever probe (null -> X): persists, appends with from:null, broadcasts, returns a report', async () => {
    const store = fakeStore();
    const sink = fakeSink();
    const probes = fakeProbes();

    const report = await runDoctor({ probes, store, sink, clock: fixedClock });

    expect(report.state).toBe('fully-connected');
    expect(report.probedAt).toBe('2026-09-01T00:00:00.000Z');
    expect(store.getSetting(SETTING_CONNECTION_STATE)).toBe('fully-connected');
    expect(sink.appends).toEqual([
      {
        event: {
          type: 'connection.state-changed',
          from: null,
          to: 'fully-connected',
        },
        actor: { kind: 'system', reason: 'capability-probe' },
      },
    ]);
    expect(sink.broadcasts).toEqual([
      { event: 'connection.state', state: 'fully-connected' },
    ]);
  });

  it('only-on-change: an identical second probe appends/broadcasts nothing', async () => {
    const store = fakeStore();
    const sink = fakeSink();
    const probes = fakeProbes();

    await runDoctor({ probes, store, sink, clock: fixedClock });
    await runDoctor({ probes, store, sink, clock: fixedClock });

    expect(sink.appends).toHaveLength(1);
    expect(sink.broadcasts).toHaveLength(1);
  });

  it('a real transition (fully-connected -> read-only) records from/to and emits exactly once', async () => {
    const store = fakeStore();
    const sink = fakeSink();
    const good = fakeProbes();
    await runDoctor({ probes: good, store, sink, clock: fixedClock });

    const degraded = fakeProbes({ automation: 'denied' });
    const report = await runDoctor({
      probes: degraded,
      store,
      sink,
      clock: fixedClock,
    });

    expect(report.state).toBe('read-only');
    expect(sink.appends).toHaveLength(2);
    expect(sink.appends[1]).toEqual({
      event: {
        type: 'connection.state-changed',
        from: 'fully-connected',
        to: 'read-only',
      },
      actor: { kind: 'system', reason: 'capability-probe' },
    });
    expect(sink.broadcasts).toHaveLength(2);
  });

  it('row 7 short-circuit: an unsupported osMajor never calls fda/automation/messagesRunning', async () => {
    const store = fakeStore();
    const sink = fakeSink();
    const probes = fakeProbes({ osMajor: 12 });

    const report = await runDoctor({ probes, store, sink, clock: fixedClock });

    expect(report.state).toBe('unsupported');
    expect(probes.calls).toEqual({ fda: 0, automation: 0, messagesRunning: 0 });
  });

  it("autoLaunch reads the store's send.autoLaunchMessages setting ('0' means off)", async () => {
    const store = fakeStore({ [SETTING_AUTO_LAUNCH_MESSAGES]: '0' });
    const sink = fakeSink();
    const probes = fakeProbes({ messagesRunning: false });

    const report = await runDoctor({ probes, store, sink, clock: fixedClock });

    expect(report.state).toBe('read-only');
    expect(report.checks.find((c) => c.id === 'messages')).toMatchObject({
      status: 'fail',
    });
  });
});

describe('readConnectionState — fail-closed read of the persisted setting', () => {
  it("returns 'disconnected' when unset", () => {
    expect(readConnectionState(fakeStore() as Store)).toBe('disconnected');
  });

  it("returns 'disconnected' for an unrecognized stored value", () => {
    expect(
      readConnectionState(
        fakeStore({ [SETTING_CONNECTION_STATE]: 'bogus' }) as Store,
      ),
    ).toBe('disconnected');
  });

  it('returns the stored value when it is a valid ConnectionState', () => {
    expect(
      readConnectionState(
        fakeStore({ [SETTING_CONNECTION_STATE]: 'read-only' }) as Store,
      ),
    ).toBe('read-only');
  });
});

describe('startDaemon integration: probe-driven state reaches GET /v1/status + the WS greeting', () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) await fn();
  });

  it('an injected doctorProbes fake reporting automation-denied yields read-only end to end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wm-doctor-e2e-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const configDir = join(dir, 'config');
    const chatDbPath = join(dir, 'chat.db');
    const fixture = createChatDb(chatDbPath);
    cleanups.push(() => fixture.close());

    const idleWatcher: FsWatcher = { watch: () => () => undefined };
    // Never a real osascript call — test/arch.spec.ts gate (b) — this fake
    // stands in for sendkit's real probeAutomation.
    const deniedProbes: DoctorProbes = {
      osMajor: () => 15,
      fda: async () => 'ok',
      automation: async () => 'denied',
      messagesRunning: async () => true,
    };
    const daemon = await startDaemon({
      configDir,
      chatDbPath,
      clock: fixedClock,
      watcher: idleWatcher,
      doctorProbes: deniedProbes,
    });
    cleanups.push(() => daemon.stop());
    const token = daemon.server.token;
    if (token === null) throw new Error('boot: expected a token');

    const events: GatewayEventPayload[] = [];
    const client = createClient({
      baseUrl: `http://127.0.0.1:${daemon.port}`,
      token,
    });
    const sub = await client.events((e) => events.push(e));
    cleanups.push(() => sub.close());

    const deadline = Date.now() + 2000;
    while (events.length < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(events[0]).toEqual({
      event: 'connection.state',
      state: 'read-only',
    });

    const status = await client.status();
    expect(status.connectionState).toBe('read-only');
  });
});
