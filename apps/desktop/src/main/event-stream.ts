/**
 * The event stream: one socket, a backoff ladder, and a refetch across the
 * gap.
 *
 * §2.5 keeps the GUI a thin client, and this file is the one place that
 * argument gets awkward: a stream that reconnects has a policy, and a policy
 * is logic. The line drawn here is that the policy is about the CONNECTION
 * and nothing else. It decides when to try again and when to stop; it never
 * decides what a draft means, never derives a state, and never acts. The
 * recovery it performs is a refetch through the same routes the client
 * already exposes — a snapshot of the queue and a count of what the daemon
 * recorded while we were away — because a client that guesses what it missed
 * is a client that renders a queue nobody can trust.
 *
 * Everything that would make this file untestable is injected: the transport,
 * the waiting, the randomness and the clock. Nothing here calls a timer, and
 * the Sc5 arch row fails the build if it ever does — a backoff test that
 * really waited would take half a minute and would be the first thing anyone
 * deleted, and a deleted test is how a reconnect loop becomes a spin.
 *
 * WHAT STOPS THE LOOP, and why it is not the list the plan expected. The
 * protocol's `CLOSE_CODES` table has four entries, and three of them
 * (`auth`, `timeout`, `version`) belong to the ADAPTER transport, which this
 * process never opens. The operator event route has exactly one way to
 * refuse after the upgrade — the bad-filter close, which the client already
 * maps to `DaemonEventFilterError` — and exactly one way to refuse before it,
 * the 401 at the upgrade itself, which the client maps to `DaemonAuthError`.
 * Those two are terminal here. Everything else is a transient and is retried.
 * The Sc5 arch row pins that claim to the daemon: if the operator route ever
 * closes with a second code, the row fails and `verdictFor` has to learn it.
 */
import { DaemonAuthError, DaemonEventFilterError } from '@wemessage/client';
import type { DraftPayload } from '@wemessage/client';
import type { GatewayEventPayload } from '@wemessage/protocol';

/**
 * Why the stream gave up. Both words are `DownReason`s the wizard already
 * knows how to render; C-6 keeps one cause spelled one way, so a rejected
 * credential is `token-rejected` here exactly as it is everywhere else.
 */
export type TerminalReason = 'token-rejected' | 'stream-refused';

export type Verdict =
  { retry: true } | { retry: false; reason: TerminalReason };

/** What the stream needs from a subscription, and nothing more. */
export interface StreamSubscription {
  close(): void;
  /** Settles when the stream ends; rejects when the daemon refused it. */
  closed: Promise<void>;
}

export interface ResyncResult {
  readonly drafts: readonly DraftPayload[];
  /**
   * Audit rows the daemon recorded inside the window we were disconnected
   * for. An UPPER bound in one direction only: the lower bound is inclusive
   * and the count is capped at {@link AUDIT_GAP_LIMIT}, so this can read one
   * high on a millisecond boundary and can read low only when more than a
   * thousand rows were written while we were away. It can never read zero
   * when something happened, which is the direction that matters — zero is
   * the value the renderer treats as "nothing was missed".
   */
  readonly missed: number;
}

/**
 * One frame on the event channel, sequenced.
 *
 * A discriminated union on ONE channel rather than a second push channel for
 * snapshots. The ordering between "here is the queue" and "here is what
 * happened next" is the whole point of the buffer below, and two channels
 * would put that ordering at the mercy of whichever `webContents.send` the
 * renderer's event loop reached first.
 */
export type StreamFrame =
  | { kind: 'event'; seq: number; event: GatewayEventPayload }
  | {
      kind: 'snapshot';
      seq: number;
      /** When the refetch was ASKED for, not when it answered. */
      at: string;
      missed: number;
      drafts: readonly DraftPayload[];
    };

export type StreamStatus =
  | { state: 'connected' }
  | { state: 'reconnecting'; attempt: number }
  | { state: 'down'; reason: TerminalReason };

export interface EventStreamDeps {
  connect(
    onEvent: (event: GatewayEventPayload) => void,
  ): Promise<StreamSubscription>;
  /** `null` on the first connect: nothing can have been missed yet. */
  resync(since: string | null): Promise<ResyncResult>;
  emit(frame: StreamFrame): void;
  status(next: StreamStatus): void;
  delay(ms: number): Promise<void>;
  random(): number;
  now(): string;
}

export interface EventStream {
  /** Resolves once the first attempt has produced an observable state. */
  start(): Promise<void>;
  close(): void;
}

/** The ladder, in milliseconds. The last step is also the ceiling. */
export const BACKOFF_MS = [500, 1000, 2000, 4000, 8000] as const;

/** ±20%, so a daemon restart does not summon every client at once. */
export const JITTER = 0.2;

/** The audit page size the gap count is measured with (the route's cap). */
export const AUDIT_GAP_LIMIT = 1000;

export function backoffFor(attempt: number, roll: number): number {
  const step = Math.min(Math.max(attempt, 1), BACKOFF_MS.length) - 1;
  const base = BACKOFF_MS[step] ?? BACKOFF_MS[0];
  return Math.round(base * (1 + JITTER * (2 * roll - 1)));
}

export function verdictFor(error: unknown): Verdict {
  if (error instanceof DaemonAuthError)
    return { retry: false, reason: 'token-rejected' };
  if (error instanceof DaemonEventFilterError)
    return { retry: false, reason: 'stream-refused' };
  return { retry: true };
}

/* ── the refetch ──────────────────────────────────────────────────────── */

/** The two reads a resync performs, structurally satisfied by the client. */
export interface ResyncClient {
  listDrafts(): Promise<readonly DraftPayload[]>;
  listAudit(params: {
    since: string;
    limit: number;
  }): Promise<readonly unknown[]>;
}

/**
 * The recovery, as two ordinary reads.
 *
 * The order is load-bearing. The window is CLOSED first (how many rows did
 * the daemon write while we were gone), and only then is the snapshot taken,
 * so a row written between the two reads is counted as missed by a snapshot
 * that already reflects it. The other order would let a change slip through
 * both reads and leave the queue quietly stale — which is precisely the
 * failure this scenario exists to make impossible.
 */
export function createResync(
  client: ResyncClient,
): (since: string | null) => Promise<ResyncResult> {
  return async (since) => {
    const missed =
      since === null
        ? 0
        : (await client.listAudit({ since, limit: AUDIT_GAP_LIMIT })).length;
    const drafts = await client.listDrafts();
    return { drafts, missed };
  };
}

/* ── the stream ───────────────────────────────────────────────────────── */

export function createEventStream(deps: EventStreamDeps): EventStream {
  let stopped = false;
  let live: StreamSubscription | null = null;
  let seq = 0;
  let attempt = 0;
  /**
   * The instant the last socket died, and the lower bound of the next gap.
   *
   * The DROP instant rather than the last snapshot's: an event delivered
   * live before the socket died was not missed, and counting it would report
   * a gap on every ordinary reconnect.
   */
  let since: string | null = null;
  let announce: () => void = () => {};

  function forward(event: GatewayEventPayload): void {
    seq += 1;
    deps.emit({ kind: 'event', seq, event });
  }

  /**
   * Turn a failure into a decision. Terminal failures report and stop;
   * everything else costs one rung on the ladder.
   */
  function classify(error: unknown): 'retry' | 'stop' {
    const verdict = verdictFor(error);
    if (!verdict.retry) {
      deps.status({ state: 'down', reason: verdict.reason });
      announce();
      return 'stop';
    }
    attempt += 1;
    return 'retry';
  }

  async function attemptOnce(): Promise<'retry' | 'stop'> {
    let greeted = false;
    let ready = false;
    const buffer: GatewayEventPayload[] = [];
    let onGreeting: () => void = () => {};
    const greeting = new Promise<void>((resolve) => {
      onGreeting = resolve;
    });

    const onEvent = (event: GatewayEventPayload): void => {
      if (!greeted) {
        greeted = true;
        // The greeting is the daemon's proof that this socket is alive
        // (§3.4 `connection.state`). It is consumed, not forwarded: it
        // describes OUR subscription, and a queue that rendered it would
        // show a connection fact as a queue event. A later
        // `connection.state` — the daemon's own link to Messages changing —
        // is a different fact and is forwarded like anything else.
        if (event.event !== 'connection.state') buffer.push(event);
        onGreeting();
        return;
      }
      if (ready) forward(event);
      else buffer.push(event);
    };

    let socket: StreamSubscription;
    try {
      socket = await deps.connect(onEvent);
    } catch (error) {
      return classify(error);
    }
    live = socket;
    announce();

    let ending: unknown = undefined;
    const ended = socket.closed.then(
      () => 'ended' as const,
      (error: unknown) => {
        ending = error;
        return 'ended' as const;
      },
    );
    const first = await Promise.race([
      greeting.then(() => 'greeted' as const),
      ended,
    ]);
    if (first === 'ended') {
      live = null;
      return stopped ? 'stop' : classify(ending);
    }
    if (stopped) return 'stop';

    deps.status({ state: 'connected' });
    const at = deps.now();
    let result: ResyncResult;
    try {
      result = await deps.resync(since);
    } catch (error) {
      // A refetch that failed is an attempt that failed. Carrying on with a
      // live socket and no snapshot would leave the renderer holding a map
      // from before the gap while events from after it arrived on top.
      socket.close();
      live = null;
      await ended;
      return stopped ? 'stop' : classify(error);
    }
    if (stopped) return 'stop';

    seq += 1;
    deps.emit({
      kind: 'snapshot',
      seq,
      at,
      missed: result.missed,
      drafts: result.drafts,
    });
    attempt = 0;
    ready = true;
    for (const event of buffer.splice(0)) forward(event);

    await ended;
    live = null;
    since = deps.now();
    return stopped ? 'stop' : classify(ending);
  }

  async function run(): Promise<void> {
    for (;;) {
      if (stopped) return;
      if (attempt > 0) {
        deps.status({ state: 'reconnecting', attempt });
        announce();
        await deps.delay(backoffFor(attempt, deps.random()));
        if (stopped) return;
      }
      let verdict: 'retry' | 'stop';
      try {
        verdict = await attemptOnce();
      } catch (error) {
        // Nothing above is expected to throw; if something does, it is
        // treated as a transient rather than as a reason to stop watching
        // the queue. A stream that gave up on an unexpected exception would
        // leave the operator looking at a screen that stopped updating
        // without saying so.
        verdict = classify(error);
      }
      if (verdict === 'stop') return;
    }
  }

  return {
    start(): Promise<void> {
      return new Promise<void>((resolve) => {
        announce = () => {
          resolve();
          announce = () => {};
        };
        void run().then(announce, announce);
      });
    },
    close(): void {
      stopped = true;
      const socket = live;
      live = null;
      socket?.close();
    },
  };
}
