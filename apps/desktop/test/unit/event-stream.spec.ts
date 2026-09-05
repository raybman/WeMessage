/**
 * s8 Sc5 — the event stream: reconnect, resync, and the gap between them.
 *
 * Pure node. No Electron, no window, no socket: `createEventStream` takes its
 * transport, its clock, its randomness and its waiting as dependencies, so
 * every row here is a statement about the POLICY rather than about `ws`. The
 * real socket is exercised by `test/e2e/stream.e2e.spec.ts`, which severs a
 * real TCP connection to a real daemon and reads the real refetch off the
 * wire; a fake server in this file would only prove that our fake behaves
 * like our fake (S7 §0.1).
 *
 * The plan's Sc5 sketch says "the fake is a `ws` server in the test". It is
 * not, deliberately: `ws` is not one of the ten dependencies `apps/desktop`
 * is allowed (arch row 10), and a stream whose transport is injected does not
 * need one to be tested. What a socket server WOULD have proven — that a
 * dropped TCP connection is seen, backed off and resynced end to end — is
 * proven against the daemon itself instead.
 *
 * No timer is called anywhere in this file or in the module it tests: waiting
 * is `delay(ms)`, injected, and the arch row for Sc5 fails the build if
 * either file so much as spells the call. A backoff test that really slept
 * would take 25 seconds and would be the first thing anyone deleted.
 */
import { describe, expect, it } from 'vitest';
import { DaemonAuthError, DaemonEventFilterError } from '@wemessage/client';
import type { AuditRowPayload, DraftPayload } from '@wemessage/client';
import type { GatewayEventPayload } from '@wemessage/protocol';
import {
  AUDIT_GAP_LIMIT,
  BACKOFF_MS,
  backoffFor,
  createEventStream,
  createResync,
  verdictFor,
  type StreamFrame,
  type StreamStatus,
  type StreamSubscription,
} from '../../src/main/event-stream.js';

/* ── fakes ────────────────────────────────────────────────────────────── */

interface FakeSocket extends StreamSubscription {
  /** How many times the stream asked this socket to close. */
  closes(): number;
  /** A frame from the daemon. */
  send(event: GatewayEventPayload): void;
  /** The daemon (or the network) ended the stream. */
  drop(): void;
  /** The daemon refused the subscription after the upgrade. */
  refuse(error: unknown): void;
}

function fakeSocket(onEvent: (event: GatewayEventPayload) => void): FakeSocket {
  let closes = 0;
  let settle: () => void = () => {};
  let fail: (error: unknown) => void = () => {};
  const closed = new Promise<void>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  void closed.catch(() => undefined);
  return {
    closed,
    close: () => {
      closes += 1;
      settle();
    },
    closes: () => closes,
    send: onEvent,
    drop: settle,
    refuse: fail,
  };
}

const GREETING: GatewayEventPayload = {
  event: 'connection.state',
  state: 'fully-connected',
};

function draft(
  id: string,
  state: DraftPayload['state'] = 'pending',
): DraftPayload {
  return {
    id,
    inboundGuid: null,
    chatGuid: 'iMessage;-;+15550001111',
    ruleId: null,
    adapterId: 'a1',
    idempotencyKey: `k-${id}`,
    body: 'body',
    originalBody: 'body',
    state,
    stateChangedAt: '2026-03-02T18:00:00.000Z',
    expiresAt: '2026-03-02T19:00:00.000Z',
    createdAt: '2026-03-02T18:00:00.000Z',
  };
}

interface Harness {
  frames: StreamFrame[];
  states: StreamStatus[];
  delays: number[];
  resyncs: Array<string | null>;
  sockets: FakeSocket[];
  connects(): number;
  /** Fail the NEXT `connect()` with this error, once. */
  failNextConnect(error: unknown): void;
  /** Fail the NEXT `resync()` with this error, once. */
  failNextResync(error: unknown): void;
  /** Hold the next `delay()` open until `releaseDelay()` is called. */
  holdDelay(): void;
  releaseDelay(): void;
  /** Answer the next resync with these drafts. */
  nextDrafts(drafts: readonly DraftPayload[], missed?: number): void;
  socket(index: number): FakeSocket;
  /** Everything the stream emitted, greeting frames included if forwarded. */
  events(): GatewayEventPayload[];
  stream: ReturnType<typeof createEventStream>;
}

function harness(options: { random?: () => number } = {}): Harness {
  const frames: StreamFrame[] = [];
  const states: StreamStatus[] = [];
  const delays: number[] = [];
  const resyncs: Array<string | null> = [];
  const sockets: FakeSocket[] = [];
  let connects = 0;
  let connectError: unknown = null;
  let resyncError: unknown = null;
  let drafts: readonly DraftPayload[] = [];
  let missed = 0;
  let held: (() => void) | null = null;
  let holding = false;
  let ms = Date.parse('2026-03-02T18:00:00.000Z');

  const h: Harness = {
    frames,
    states,
    delays,
    resyncs,
    sockets,
    connects: () => connects,
    failNextConnect: (error) => {
      connectError = error;
    },
    failNextResync: (error) => {
      resyncError = error;
    },
    holdDelay: () => {
      holding = true;
    },
    releaseDelay: () => {
      const release = held;
      held = null;
      release?.();
    },
    nextDrafts: (list, count = 0) => {
      drafts = list;
      missed = count;
    },
    socket: (index) => {
      const socket = sockets[index];
      if (socket === undefined) throw new Error(`no socket ${String(index)}`);
      return socket;
    },
    events: () =>
      frames.flatMap((frame) => (frame.kind === 'event' ? [frame.event] : [])),
    stream: createEventStream({
      connect: (onEvent) => {
        connects += 1;
        if (connectError !== null) {
          const error = connectError;
          connectError = null;
          return Promise.reject(error as Error);
        }
        const socket = fakeSocket(onEvent);
        sockets.push(socket);
        return Promise.resolve(socket);
      },
      resync: (since) => {
        resyncs.push(since);
        if (resyncError !== null) {
          const error = resyncError;
          resyncError = null;
          return Promise.reject(error as Error);
        }
        return Promise.resolve({ drafts, missed });
      },
      emit: (frame) => frames.push(frame),
      status: (next) => states.push(next),
      delay: (wait) => {
        delays.push(wait);
        ms += wait;
        if (!holding) return Promise.resolve();
        holding = false;
        return new Promise<void>((resolve) => {
          held = resolve;
        });
      },
      random: options.random ?? (() => 0.5),
      now: () => new Date(ms).toISOString(),
    }),
  };
  return h;
}

/** Let every already-resolved promise in the loop run to a stop. */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
}

/* ── row 1: the greeting, and one resync before anything is forwarded ── */

describe('s8 Sc5 row 1: the first connect', () => {
  it('the greeting flips the state to connected and is not forwarded', async () => {
    const h = harness();
    h.nextDrafts([draft('d1')]);
    await h.stream.start();
    h.socket(0).send(GREETING);
    await settle();

    expect(h.states).toEqual([{ state: 'connected' }]);
    expect(h.events()).toEqual([]);
    h.stream.close();
  });

  it('a resync runs once, before any event is forwarded, and replaces the map', async () => {
    const h = harness();
    h.nextDrafts([draft('d1'), draft('d2')]);
    await h.stream.start();
    h.socket(0).send(GREETING);
    await settle();
    h.socket(0).send({
      event: 'draft.expired',
      draftId: 'd1',
    });
    await settle();

    expect(h.resyncs).toEqual([null]);
    expect(h.frames.map((f) => f.kind)).toEqual(['snapshot', 'event']);
    const first = h.frames[0];
    if (first?.kind !== 'snapshot') throw new Error('expected a snapshot');
    expect(first.drafts.map((d) => d.id)).toEqual(['d1', 'd2']);
    expect(first.missed).toBe(0);
    expect(first.at).toBe('2026-03-02T18:00:00.000Z');
    h.stream.close();
  });

  it('events that arrive before the snapshot resolves are buffered, not dropped', async () => {
    const h = harness();
    await h.stream.start();
    // The greeting and an event in the same tick: the resync has been asked
    // for and has not answered yet.
    h.socket(0).send(GREETING);
    h.socket(0).send({ event: 'draft.requeued', draftId: 'd1' });
    await settle();

    expect(h.frames.map((f) => f.kind)).toEqual(['snapshot', 'event']);
    h.stream.close();
  });
});

/* ── row 2: backoff ───────────────────────────────────────────────────── */

describe('s8 Sc5 row 2: reconnect with backoff', () => {
  it('a drop reports reconnecting and waits the backoff ladder, capped', async () => {
    const h = harness();
    await h.stream.start();
    h.socket(0).send(GREETING);
    await settle();
    // Six consecutive drops: the ladder plus one past its end. Each socket
    // after the first opens and then dies WITHOUT greeting, which is what a
    // daemon that is restarting in a loop looks like from here — and is why
    // the counter is reset by a greeting rather than by an open.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      h.socket(attempt).drop();
      await settle();
    }
    expect(h.delays).toEqual([500, 1000, 2000, 4000, 8000, 8000]);
    expect(h.states.filter((s) => s.state === 'reconnecting')).toEqual([
      { state: 'reconnecting', attempt: 1 },
      { state: 'reconnecting', attempt: 2 },
      { state: 'reconnecting', attempt: 3 },
      { state: 'reconnecting', attempt: 4 },
      { state: 'reconnecting', attempt: 5 },
      { state: 'reconnecting', attempt: 6 },
    ]);
    h.stream.close();
  });

  it('a successful reconnect resets the counter', async () => {
    const h = harness();
    await h.stream.start();
    h.socket(0).send(GREETING);
    await settle();
    h.socket(0).drop();
    await settle();
    // Attempt 1 opened and died without greeting: still a failure.
    h.socket(1).drop();
    await settle();
    // Attempt 2 greets, so the ladder starts over from the bottom.
    h.socket(2).send(GREETING);
    await settle();
    h.socket(2).drop();
    await settle();

    expect(h.delays).toEqual([500, 1000, 500]);
    h.stream.close();
  });

  it('the jitter is ±20% of the ladder step and comes from the injected RNG', () => {
    expect(BACKOFF_MS).toEqual([500, 1000, 2000, 4000, 8000]);
    expect(backoffFor(1, 0.5)).toBe(500);
    expect(backoffFor(1, 0)).toBe(400);
    expect(backoffFor(1, 1)).toBe(600);
    expect(backoffFor(5, 0)).toBe(6400);
    expect(backoffFor(6, 0.5)).toBe(8000);
    expect(backoffFor(99, 1)).toBe(9600);
  });

  it('the RNG is drawn once per wait', async () => {
    const rolls: number[] = [];
    const h = harness({
      random: () => {
        rolls.push(0);
        return 0;
      },
    });
    await h.stream.start();
    h.socket(0).send(GREETING);
    await settle();
    h.socket(0).drop();
    await settle();
    expect(rolls.length).toBe(1);
    expect(h.delays).toEqual([400]);
    h.stream.close();
  });
});

/* ── row 3: the gap, and what is buffered across it ──────────────────── */

describe('s8 Sc5 row 3: resync across a drop', () => {
  it('events between reopen and snapshot are forwarded after it, in order, with monotonic seq', async () => {
    const h = harness();
    h.nextDrafts([draft('d1')]);
    await h.stream.start();
    h.socket(0).send(GREETING);
    await settle();
    h.socket(0).send({ event: 'draft.requeued', draftId: 'd1' });
    h.socket(0).send({ event: 'draft.expired', draftId: 'd1' });
    await settle();
    h.socket(0).drop();
    await settle();

    // Reconnected. The greeting AND two events land before the resync
    // answers, which is exactly the window the daemon can fill while we are
    // asking it what we missed.
    h.nextDrafts([draft('d1'), draft('d2')], 3);
    h.socket(1).send(GREETING);
    h.socket(1).send({
      event: 'draft.superseded',
      draftId: 'd1',
      byDraftId: 'd2',
    });
    h.socket(1).send({
      event: 'draft.redrafted',
      draftId: 'd1',
      newDraftId: 'd3',
    });
    await settle();

    expect(h.frames.map((f) => f.kind)).toEqual([
      'snapshot',
      'event',
      'event',
      'snapshot',
      'event',
      'event',
    ]);
    expect(h.frames.map((f) => f.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(h.events().map((e) => e.event)).toEqual([
      'draft.requeued',
      'draft.expired',
      'draft.superseded',
      'draft.redrafted',
    ]);
    const second = h.frames[3];
    if (second?.kind !== 'snapshot') throw new Error('expected a snapshot');
    expect(second.missed).toBe(3);
    h.stream.close();
  });

  it('the second resync asks for the window that opened when the socket dropped', async () => {
    const h = harness();
    await h.stream.start();
    h.socket(0).send(GREETING);
    await settle();
    h.socket(0).drop();
    await settle();
    h.socket(1).send(GREETING);
    await settle();

    // First: no lower bound at all, because nothing was ever missed. Second:
    // the instant the stream went away, NOT the instant of the last
    // snapshot — an event delivered live before the drop is not a gap.
    expect(h.resyncs).toEqual([null, '2026-03-02T18:00:00.000Z']);
    h.stream.close();
  });

  it('a resync that fails is a failed attempt: the socket is closed and the loop retries', async () => {
    const h = harness();
    await h.stream.start();
    h.failNextResync(new Error('econnreset'));
    h.socket(0).send(GREETING);
    await settle();

    expect(h.socket(0).closes()).toBe(1);
    expect(h.delays).toEqual([500]);
    expect(h.connects()).toBe(2);
    h.stream.close();
  });
});

/* ── row 4: close() cancels a pending reconnect ──────────────────────── */

describe('s8 Sc5 row 4: close during a backoff wait', () => {
  it('cancels the pending reconnect and never calls connect again', async () => {
    const h = harness();
    await h.stream.start();
    h.socket(0).send(GREETING);
    await settle();
    h.holdDelay();
    h.socket(0).drop();
    await settle();
    expect(h.connects()).toBe(1);

    h.stream.close();
    h.releaseDelay();
    await settle();

    expect(h.connects()).toBe(1);
    expect(h.states.at(-1)).toEqual({ state: 'reconnecting', attempt: 1 });
  });

  it('closes the live socket exactly once', async () => {
    const h = harness();
    await h.stream.start();
    h.socket(0).send(GREETING);
    await settle();
    h.stream.close();
    h.stream.close();
    await settle();
    expect(h.socket(0).closes()).toBe(1);
    expect(h.connects()).toBe(1);
  });
});

/* ── row 5: a rotated credential is not a transient ──────────────────── */

describe('s8 Sc5 row 5: terminal failures', () => {
  it('an auth failure on reconnect stops the loop and reports down', async () => {
    const h = harness();
    await h.stream.start();
    h.socket(0).send(GREETING);
    await settle();
    h.failNextConnect(new DaemonAuthError(401));
    h.socket(0).drop();
    await settle();
    // Nothing further, however long the loop is left alone.
    await settle();

    expect(h.states.at(-1)).toEqual({
      state: 'down',
      reason: 'token-rejected',
    });
    expect(h.connects()).toBe(2);
    expect(h.delays).toEqual([500]);
  });

  it('a refused subscription filter stops the loop too', async () => {
    const h = harness();
    await h.stream.start();
    h.socket(0).send(GREETING);
    await settle();
    h.socket(0).refuse(new DaemonEventFilterError('draft.nonesuch'));
    await settle();
    await settle();

    expect(h.states.at(-1)).toEqual({
      state: 'down',
      reason: 'stream-refused',
    });
    expect(h.connects()).toBe(1);
    expect(h.delays).toEqual([]);
  });

  it('an auth failure on the FIRST connect never reaches the reconnect ladder', async () => {
    const h = harness();
    h.failNextConnect(new DaemonAuthError(401));
    await h.stream.start();
    await settle();

    expect(h.states).toEqual([{ state: 'down', reason: 'token-rejected' }]);
    expect(h.connects()).toBe(1);
    expect(h.delays).toEqual([]);
  });

  it('the verdict is a total function over what the transport can raise', () => {
    expect(verdictFor(new DaemonAuthError(401))).toEqual({
      retry: false,
      reason: 'token-rejected',
    });
    expect(verdictFor(new DaemonEventFilterError('nope'))).toEqual({
      retry: false,
      reason: 'stream-refused',
    });
    expect(verdictFor(new Error('econnrefused'))).toEqual({ retry: true });
    expect(verdictFor(undefined)).toEqual({ retry: true });
  });
});

/* ── the gap measurement itself ──────────────────────────────────────── */

describe('s8 Sc5: createResync measures the gap over real routes', () => {
  function auditRow(seq: number): AuditRowPayload {
    return {
      seq,
      at: '2026-03-02T18:00:01.000Z',
      eventJson: '{"event":"draft.created"}',
      actorJson: '{"kind":"system"}',
      prevHash: 'p',
      hash: 'h',
    };
  }

  it('the first resync asks for drafts only: nothing can have been missed yet', async () => {
    const calls: string[] = [];
    const resync = createResync({
      listDrafts: () => {
        calls.push('drafts');
        return Promise.resolve([draft('d1')]);
      },
      listAudit: () => {
        calls.push('audit');
        return Promise.resolve([]);
      },
    });
    const result = await resync(null);
    expect(calls).toEqual(['drafts']);
    expect(result.missed).toBe(0);
    expect(result.drafts.map((d) => d.id)).toEqual(['d1']);
  });

  it('a later resync counts the window first, then takes the snapshot', async () => {
    const calls: string[] = [];
    let params: { since: string; limit: number } | null = null;
    const resync = createResync({
      listDrafts: () => {
        calls.push('drafts');
        return Promise.resolve([draft('d1'), draft('d2')]);
      },
      listAudit: (p) => {
        calls.push('audit');
        params = p;
        return Promise.resolve([auditRow(1), auditRow(2)]);
      },
    });
    const result = await resync('2026-03-02T18:00:00.000Z');

    // Order is load-bearing: the window has to be closed BEFORE the snapshot
    // is taken, or a row written between the two reads would be counted as
    // missed by a snapshot that already contains it.
    expect(calls).toEqual(['audit', 'drafts']);
    expect(params).toEqual({
      since: '2026-03-02T18:00:00.000Z',
      limit: AUDIT_GAP_LIMIT,
    });
    expect(result.missed).toBe(2);
    expect(result.drafts.map((d) => d.id)).toEqual(['d1', 'd2']);
  });
});
