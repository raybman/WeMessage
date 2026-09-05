/**
 * s8 Sc5 — the stream, against a real daemon, through a real outage.
 *
 * The unit rows prove the POLICY: the ladder, the classifier, the reducer's
 * four ways for a hypothesis to end. They prove it against injected
 * transports, which is what makes them fast and total, and is also exactly
 * why they cannot prove the thing this file is for — that a socket which
 * really died is really noticed, that the refetch which follows really
 * reaches the routes it claims to, and that the gap it measures was a gap
 * something really fell into.
 *
 * So the outage here is a real one. The TCP tee in front of the daemon cuts
 * every live connection and refuses new ones while the DAEMON KEEPS RUNNING,
 * because an outage that stops the daemon has nothing on the other side to
 * discover. Meanwhile a second client, aimed straight at the daemon and
 * invisible to the tee, does what the other terminal would do: it creates a
 * draft the app cannot possibly have seen. What the app does about that when
 * the wire comes back is the whole scenario.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  bootFixtureDaemon,
  launchApp,
  waitForConn,
  waitForConnected,
  type FixtureDaemon,
  type LaunchedApp,
} from './harness.js';

/** Synthetic, and the only kind this repo may carry: it is PUBLIC. */
const HANDLE = '+15550001111';
const CHAT = `iMessage;-;${HANDLE}`;

const running: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const stop of running.splice(0).reverse()) {
    try {
      await stop();
    } catch {
      /* teardown is best-effort by design */
    }
  }
});

/**
 * A daemon whose clock starts at the wall clock.
 *
 * The fixture's default instant is in the past, and the app's own `now()` is
 * the real one: an audit window measured from a wall-clock drop would then
 * begin after every row the daemon ever wrote, and the gap count would be a
 * confident zero. Starting the daemon's clock at the wall clock and moving
 * it FORWARD during the outage puts the rows written while we were away
 * where they actually belong — after the moment the socket died.
 */
async function boot(): Promise<FixtureDaemon> {
  const fixture = await bootFixtureDaemon({
    clockAt: new Date().toISOString(),
    seed: (f) => {
      const handleId = f.addHandle(HANDLE);
      f.addChat({ identifier: HANDLE, handleIds: [handleId] });
    },
  });
  running.push(fixture.stop);
  return fixture;
}

async function launch(fixture: FixtureDaemon): Promise<LaunchedApp> {
  const app = await launchApp({
    configDir: fixture.configDir,
    port: fixture.port,
  });
  running.push(app.close);
  return app;
}

/** The queue handle the renderer mounts, read from inside the window. */
interface QueueProbe {
  rows: string[];
  state: string | null;
  chip: unknown;
  missed: number;
  stale: boolean;
  syncedAt: string | undefined;
}

function probe(app: LaunchedApp, id: string): Promise<QueueProbe> {
  return app.page.evaluate((draftId: string) => {
    const q = (
      window as unknown as {
        __wmQueue: {
          store: {
            rows(): Array<{ server: { id: string } }>;
            stateOf(id: string): string | undefined;
            chip(id: string): unknown;
            missed(): number;
            needsSnapshot(): boolean;
            syncedAt(): string | undefined;
          };
        };
      }
    ).__wmQueue;
    return {
      rows: q.store.rows().map((r) => r.server.id),
      state: q.store.stateOf(draftId) ?? null,
      chip: q.store.chip(draftId) ?? null,
      missed: q.store.missed(),
      stale: q.store.needsSnapshot(),
      syncedAt: q.store.syncedAt(),
    };
  }, id);
}

function approve(app: LaunchedApp, id: string): Promise<void> {
  return app.page.evaluate((draftId: string) => {
    const q = (
      window as unknown as { __wmQueue: { approve(id: string): Promise<void> } }
    ).__wmQueue;
    return q.approve(draftId);
  }, id);
}

const urls = (fixture: FixtureDaemon): string[] =>
  fixture.requests.requests().map((r) => `${r.method} ${r.url}`);

/* ── row 1: the first connect takes a snapshot and counts no gap ─────── */

describe('s8 Sc5 row 1: connecting is subscribing AND fetching', () => {
  it('opens the stream, then reads the queue, and asks for no audit window', async () => {
    const fixture = await boot();
    const draft = await fixture.directClient.createDraft({
      chatGuid: CHAT,
      body: 'first',
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await app.page.waitForSelector('html[data-store-rows="1"]', {
      timeout: 15_000,
    });

    const seen = urls(fixture);
    // §1.8 order, on the wire: the subscription is open before anything is
    // claimed about the queue, so nothing can be missed between the read
    // and the socket that was supposed to be watching it.
    expect(seen[0]).toBe('GET /v1/events');
    expect(seen.some((u) => u.startsWith('GET /v1/drafts'))).toBe(true);
    // Nothing can have been missed before the first socket existed, and an
    // audit query with no window to measure would be a request that exists
    // to produce a zero.
    expect(seen.filter((u) => u.includes('/v1/audit'))).toEqual([]);

    const state = await probe(app, draft.id);
    expect(state.rows).toEqual([draft.id]);
    expect(state.missed).toBe(0);
    expect(state.stale).toBe(false);
    expect(state.syncedAt).toBeDefined();
  }, 120_000);
});

/* ── row 2: the outage, the gap, and the refetch that closes it ──────── */

describe('s8 Sc5 row 2: a severed socket is noticed, counted and repaired', () => {
  it('reconnects, measures the window it missed, and refetches through real routes', async () => {
    const fixture = await boot();
    const first = await fixture.directClient.createDraft({
      chatGuid: CHAT,
      body: 'before the outage',
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await app.page.waitForSelector('html[data-store-rows="1"]', {
      timeout: 15_000,
    });
    const beforeOutage = urls(fixture).length;

    // The wire goes away; the daemon does not.
    fixture.requests.sever();
    // Observable, and observable as the RIGHT thing: the app has been
    // connected once, so this is an interruption to recover from rather
    // than a setup problem to explain.
    await waitForConn(app.page, 'reconnecting');

    // Now the other terminal does something. The daemon records it; the app
    // cannot possibly know. The clock moves first so the rows it writes land
    // AFTER the instant the app's socket died, which is what makes them
    // rows the app missed rather than rows it had already seen.
    fixture.clock.set(new Date(Date.now() + 300_000).toISOString());
    const during = await fixture.directClient.createDraft({
      chatGuid: CHAT,
      body: 'while the app was blind',
    });

    fixture.requests.restore();
    await waitForConnected(app.page);
    await app.page.waitForSelector('html[data-store-rows="2"]', {
      timeout: 30_000,
    });

    const after = urls(fixture).slice(beforeOutage);
    const audit = after.findIndex((u) => u.includes('/v1/audit?'));
    const drafts = after.findIndex((u) => u.startsWith('GET /v1/drafts'));
    expect(audit).toBeGreaterThanOrEqual(0);
    expect(after[audit]).toContain('since=');
    // Window first, snapshot second. The other order would let a row
    // written between the two reads be counted as missed by a snapshot that
    // already contains it.
    expect(drafts).toBeGreaterThan(audit);

    const state = await probe(app, during.id);
    // The gap was REAL: the daemon wrote rows in the window the app was
    // away for, and the app went and counted them rather than assuming the
    // reconnect was clean.
    expect(state.missed).toBeGreaterThan(0);
    expect(state.stale).toBe(false);
    expect(state.rows).toContain(during.id);
    expect(state.rows).toContain(first.id);
    // Recovery is a refetch, never a reconstruction: the row the app is now
    // holding is the daemon's own payload for a draft it never saw created.
    expect(state.state).toBe('pending');
  }, 120_000);
});

/* ── row 3: an optimistic approve cannot produce a send ──────────────── */

describe('s8 Sc5 row 3: the display is a display', () => {
  it('shows approved, is refused by the gate, rolls back, and sends nothing', async () => {
    const fixture = await boot();
    const draft = await fixture.directClient.createDraft({
      chatGuid: CHAT,
      body: 'never leaves',
    });
    // The gate will refuse this approval. The renderer does not know that
    // and must not need to: it is allowed to be optimistic precisely
    // because being wrong is recoverable and cannot, by itself, do anything.
    await fixture.directClient.setKillSwitch(true);
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await app.page.waitForSelector('html[data-store-rows="1"]', {
      timeout: 15_000,
    });

    await approve(app, draft.id);

    const state = await probe(app, draft.id);
    expect(state.chip).toEqual({ kind: 'denied', reason: 'kill-switch' });
    // Rolled back to what the daemon actually has.
    expect(state.state).toBe('pending');
    // And the daemon agrees, which is the half a renderer cannot fake: the
    // card said `approved` for as long as the request was in flight, and
    // the queue it was describing never moved.
    const server = await fixture.directClient.getDraft(draft.id);
    expect(server.draft.state).toBe('pending');

    // INV-2 on the wire: nothing this app asked for in the whole session
    // was a send. The only send path in the system is `dispatchApproved`
    // inside the daemon, and it consumes an `Approval` row that this
    // refusal means was never written.
    expect(urls(fixture).filter((u) => /send/i.test(u))).toEqual([]);
  }, 120_000);

  it('an approve the gate allows is one request, and still not a send', async () => {
    const fixture = await boot();
    const draft = await fixture.directClient.createDraft({
      chatGuid: CHAT,
      body: 'goes through',
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await app.page.waitForSelector('html[data-store-rows="1"]', {
      timeout: 15_000,
    });
    const before = urls(fixture).length;

    await approve(app, draft.id);

    const asked = urls(fixture).slice(before);
    expect(asked).toEqual([`POST /v1/drafts/${draft.id}/approve`]);
    expect(urls(fixture).filter((u) => /send/i.test(u))).toEqual([]);
    const state = await probe(app, draft.id);
    expect(state.state).toBe('approved');
    expect(state.chip).toBeNull();
  }, 120_000);
});
