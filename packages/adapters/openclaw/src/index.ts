/**
 * s7-execution Scenario 10 — `@wemessage/adapter-openclaw`.
 *
 * A GENERIC NDJSON-over-stdio shim. It speaks the WeMessage wire on one side
 * and a documented line protocol on the other, and the only OpenClaw-specific
 * thing in this package is a paragraph of README. That is deliberate, and
 * F-92 is the reason: OpenClaw is a sibling agent that this work was not
 * permitted to start, probe or modify. Its plugin API was read from docs only.
 * A shim built tightly against an API nobody here has called would be a shim
 * that is wrong in a way nothing can detect; a generic one is wrong at most
 * about a manifest file.
 *
 * So the child contract below is OURS. Anyone can implement it, in any
 * language, in an afternoon: read JSON objects one per line off stdin, write
 * JSON objects one per line to stdout. `examples/stdio-child.mjs` in the
 * testkit is a complete implementation in fifty lines with no imports, and
 * the conformance row in `test/shim.spec.ts` runs the real thing.
 *
 * Four properties are load-bearing, and each is a row in `test/shim.spec.ts`:
 *
 *  - **The child cannot reach the wire (INV-2).** This is the whole reason
 *    the shim exists rather than a pipe. A generic line protocol is the
 *    single easiest place in this project for a stranger to smuggle a send:
 *    write a plausible-looking frame, hope the middle forwards it. It does
 *    not. The ONLY thing that turns a child line into a gateway frame is an
 *    open `draft.request` the shim is already holding, and the only frame it
 *    can turn it into is a `draft.submit` — which is a DRAFT, which a human
 *    approves. A line that names `send` is refused, counted, and the child is
 *    told so in its own vocabulary. There is no frame for putting a message
 *    on somebody's phone, so there is nothing here to smuggle it through.
 *  - **The refusal audits as the daemon's taxonomy (C-6).** Reaching for a
 *    frame type is `adapter.no-send-frame:<type>`; being structurally broken
 *    is `adapter.protocol-violation:<reason>`. Never `gate.denied` — that
 *    label belongs to a human declining a draft, and borrowing it here would
 *    put a protocol bug in the queue where approval decisions are reviewed.
 *  - **The credential never goes down.** `childEnv` strips the adapter token
 *    and anything else `wm_`-shaped out of the child's environment, and the
 *    token is never an argument, because `ps(1)` shows every user on the box
 *    the full argv of every process.
 *  - **A dead child declines; it never hangs.** Every open request is
 *    answered with a declined `draft.submit`, health degrades, and respawns
 *    stop at `maxAttempts`. An unanswered `draft.request` is a conformance
 *    check-2 failure here and, on a real daemon, a draft that never appears.
 *
 * Dependency posture matches every other adapter: `@wemessage/protocol` and
 * node builtins, nothing else.
 */
import { spawn as spawnProcess } from 'node:child_process';
import {
  parseGatewayFrame,
  WIRE_VERSION,
  type Correlation,
  type DraftRequestFrame,
} from '@wemessage/protocol';
import { createNdjsonParser, DEFAULT_MAX_LINE_BYTES } from './ndjson.js';

export {
  createNdjsonParser,
  DEFAULT_MAX_LINE_BYTES,
  type NdjsonEvent,
  type NdjsonParser,
} from './ndjson.js';
export {
  liveVerificationOffenders,
  verificationBanner,
  LIVE_EVIDENCE_MARKER,
  OPENCLAW_ASSUMPTION_HEADING,
  OPENCLAW_CLAIMS,
  OPENCLAW_VERIFICATION,
  type AdapterVerification,
  type AssumedClaim,
  type ConformanceOnly,
  type EvidenceProbe,
  type LiveVerified,
  type OpenClawClaim,
  type VerificationTier,
  type VerifiedClaim,
} from './verification.js';

/* ── the child contract ────────────────────────────────────────────────── */

/**
 * Every message kind in the protocol, both directions.
 *
 * Closed on purpose. A vocabulary that can grow by accident is a vocabulary
 * a child can extend from the far side of a pipe, and the extension nobody
 * wants is the one that means "deliver this".
 */
export const CHILD_MESSAGE_KINDS = [
  'request',
  'submit',
  'decline',
  'ping',
  'pong',
  'error',
] as const;

export type ChildMessageKind = (typeof CHILD_MESSAGE_KINDS)[number];

/**
 * Shim → child. Written to the child's stdin, one JSON object per line.
 *
 *  - `request` — answer this. Carries the wire `draft.request.payload`
 *    VERBATIM: `correlation`, `message`, `context`, `rule`, `constraints`,
 *    plus `kind`, and nothing renamed. A child author who has read
 *    `PROTOCOL.md` needs no second document, and a shim that re-shaped the
 *    payload would be a second schema to keep in sync with the first.
 *  - `ping` — liveness probe, forwarded when the gateway pings us.
 *  - `error` — the last line you sent was refused; `reason` says why. The
 *    child is TOLD rather than silently ignored: a protocol nobody can debug
 *    is a protocol nobody implements correctly.
 */
export const SHIM_TO_CHILD_KINDS: readonly ChildMessageKind[] = [
  'request',
  'ping',
  'error',
];

/**
 * Child → shim. Read from the child's stdout, one JSON object per line.
 *
 *  - `submit` — the draft. `{correlation: {requestId}, body}`. Answers an
 *    OPEN request; an unknown `requestId` is dropped and counted.
 *  - `decline` — nothing to say. `{correlation: {requestId}, reason?}`.
 *    Preferred over an empty body: an empty draft in a human's queue is
 *    worse than no draft.
 *  - `pong` — answer to `ping`. Liveness only; it moves no draft.
 *
 * That is the complete list of things a child may say, and none of them
 * reaches a phone.
 */
export const CHILD_TO_SHIM_KINDS: readonly ChildMessageKind[] = [
  'submit',
  'decline',
  'pong',
];

/** The environment variable a child reads to learn which protocol it is on. */
export const CHILD_PROTOCOL_ENV = 'WEMESSAGE_CHILD_PROTOCOL';

/**
 * The protocol version, separate from `WIRE_VERSION` on purpose: the child
 * contract is ours and versions on our schedule, and pinning it to the wire
 * would force every child author to re-release on a wire change that cannot
 * reach them.
 */
export const CHILD_PROTOCOL_VERSION = 'ndjson/1';

/** A parsed, well-formed message from the child. Nothing else gets built. */
export type ChildMessage =
  | {
      readonly kind: 'submit';
      readonly correlation: { readonly requestId: string };
      readonly body?: string;
    }
  | {
      readonly kind: 'decline';
      readonly correlation: { readonly requestId: string };
      readonly reason?: string;
    }
  | { readonly kind: 'pong' };

/**
 * Why a line was refused. Every value is a distinct, actionable bug on the
 * child's side, which is what makes it worth having seven rather than one.
 */
export type ChildRefusalReason =
  | 'invalid-json'
  | 'not-an-object'
  | 'not-a-child-message'
  | 'wrong-direction'
  | 'malformed-payload'
  | 'truncated-line'
  | 'oversize-line';

export type ChildRead =
  | { readonly ok: true; readonly message: ChildMessage }
  | {
      readonly ok: false;
      readonly reason: ChildRefusalReason;
      /** The type or kind the line reached for, when it named one. */
      readonly name: string | null;
    };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * One line of child stdout → a message, or a named refusal.
 *
 * Pure and total: it never throws, never mutates, and never invents a field.
 * Separate from the shim so the refusal matrix can be tested as a table
 * rather than through a socket, and so a child author can be pointed at one
 * function when they ask what their line did wrong.
 */
export function readChildMessage(text: string): ChildRead {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid-json', name: null };
  }
  if (!isRecord(value))
    return { ok: false, reason: 'not-an-object', name: null };

  const kind = value['kind'];
  if (typeof kind !== 'string') {
    // No `kind`, so it is not a child message. If it is FRAME-shaped, name
    // the type it reached for: that is the line worth an audit label, and it
    // is the line a stranger writes first.
    const type = value['type'];
    const named = typeof type === 'string' && 'v' in value ? type : null;
    return { ok: false, reason: 'not-a-child-message', name: named };
  }
  // Direction before shape. A child saying `request` is not a malformed
  // request, it is a child talking out of turn, and the two need different
  // words because they are different bugs.
  if (SHIM_TO_CHILD_KINDS.some((k) => k === kind))
    return { ok: false, reason: 'wrong-direction', name: kind };
  if (!CHILD_TO_SHIM_KINDS.some((k) => k === kind))
    return { ok: false, reason: 'not-a-child-message', name: kind };

  if (kind === 'pong') return { ok: true, message: { kind: 'pong' } };

  const correlation = value['correlation'];
  const requestId = isRecord(correlation)
    ? correlation['requestId']
    : undefined;
  if (typeof requestId !== 'string' || requestId === '')
    return { ok: false, reason: 'malformed-payload', name: null };

  if (kind === 'submit') {
    const body = value['body'];
    if (body !== undefined && typeof body !== 'string')
      return { ok: false, reason: 'malformed-payload', name: null };
    return {
      ok: true,
      message:
        body === undefined
          ? { kind: 'submit', correlation: { requestId } }
          : { kind: 'submit', correlation: { requestId }, body },
    };
  }

  const reason = value['reason'];
  if (reason !== undefined && typeof reason !== 'string')
    return { ok: false, reason: 'malformed-payload', name: null };
  return {
    ok: true,
    message:
      reason === undefined
        ? { kind: 'decline', correlation: { requestId } }
        : { kind: 'decline', correlation: { requestId }, reason },
  };
}

/**
 * The audit label for a refused child line — the daemon's taxonomy (C-6),
 * and the same split `classifyRefusal` makes in the conformance kit.
 *
 * A line that NAMES something the wire has, or a direction it may not
 * originate, is `adapter.no-send-frame:<name>`: the child reached for
 * authority it does not have. A line that is merely broken is
 * `adapter.protocol-violation:<reason>`.
 *
 * `gate.denied` appears nowhere and can never be produced here. That label
 * means a human declined a draft. Reusing it for a protocol bug would put a
 * child's syntax error in the queue where approval decisions are reviewed,
 * and would make the one audit query that matters — "what did somebody try
 * to send?" — return the wrong rows in both directions.
 */
export function classifyChildRefusal(
  reason: ChildRefusalReason,
  name: string | null,
): string {
  if (
    (reason === 'not-a-child-message' || reason === 'wrong-direction') &&
    typeof name === 'string'
  )
    return `adapter.no-send-frame:${name}`;
  return `adapter.protocol-violation:${reason}`;
}

/* ── counters ──────────────────────────────────────────────────────────── */

/**
 * Everything the shim counts, and the complete list of it.
 *
 * Closed and asserted, because an operator reading `wemessage adapters show`
 * needs the vocabulary to be stable, and because a counter added quietly is
 * a behaviour added quietly.
 */
export const CHILD_COUNTERS = [
  'child.spawns',
  'child.lines.in',
  'child.lines.out',
  'child.rejected',
  'child.unknown-correlation',
  'child.invalid-json',
  'child.not-object',
  'child.malformed',
  'child.oversize',
  'child.truncated',
  'child.pong',
  'child.declined-on-death',
  'child.deadline-decline',
] as const;

export type ChildCounter = (typeof CHILD_COUNTERS)[number];

/** Which counter a refusal reason belongs to. Total over the union. */
const COUNTER_FOR: Readonly<Record<ChildRefusalReason, ChildCounter>> = {
  'invalid-json': 'child.invalid-json',
  'not-an-object': 'child.not-object',
  'not-a-child-message': 'child.rejected',
  'wrong-direction': 'child.rejected',
  'malformed-payload': 'child.malformed',
  'truncated-line': 'child.truncated',
  'oversize-line': 'child.oversize',
};

/* ── the child process seam ────────────────────────────────────────────── */

/** The bit of a child process this shim actually uses. */
export interface ShimChild {
  /** Write one message. The newline is the transport's business, not ours. */
  write(line: string): void;
  onStdout(cb: (chunk: string) => void): void;
  onExit(cb: () => void): void;
  kill(): void;
}

export type ChildSpawner = (
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
) => ShimChild;

/** Anything `wm_` shaped, wherever it is hiding. */
const TOKEN_PATTERN = /wm_[0-9a-f]{64}/;

/** Names never passed down, whatever they contain. */
const CHILD_SECRET_KEYS: readonly string[] = ['WEMESSAGE_ADAPTER_TOKEN'];

/**
 * The environment a child is allowed to have.
 *
 * Deny by shape as well as by name. The name list catches the credential we
 * know about; the `wm_` pattern catches the one somebody exported into a
 * differently-named variable, which is how a credential actually escapes. A
 * child that needs the gateway token is a child that could talk to the
 * gateway directly, and the entire point of this file is that it cannot.
 */
export function childEnv(
  extra: Readonly<Record<string, string>> = {},
  base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...base, ...extra })) {
    if (value === undefined) continue;
    if (CHILD_SECRET_KEYS.includes(key)) continue;
    if (TOKEN_PATTERN.test(value)) continue;
    out[key] = value;
  }
  out[CHILD_PROTOCOL_ENV] = CHILD_PROTOCOL_VERSION;
  return out;
}

/**
 * The production spawner: `node:child_process`, and nothing else.
 *
 * Injected everywhere else so the malformed-input rows can drive a scripted
 * child synchronously. `stderr` is inherited rather than piped or dropped,
 * because a child author's `console.error` is how they debug, and swallowing
 * it would make every "it just does nothing" report unanswerable.
 */
export function createNodeChildSpawner(): ChildSpawner {
  return (command, args, env): ShimChild => {
    const proc = spawnProcess(command, [...args], {
      env: { ...env },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    proc.stdout?.setEncoding('utf8');
    // A child that exits while we still hold its stdin gives us EPIPE. That
    // is the death path, which is already handled; an unhandled error event
    // here would take the whole adapter down instead.
    proc.stdin?.on('error', () => undefined);
    proc.on('error', () => undefined);
    let ended = false;
    let onExit: () => void = () => undefined;
    const finish = (): void => {
      if (ended) return;
      ended = true;
      onExit();
    };
    proc.on('exit', finish);
    // `error` fires INSTEAD of `exit` when the command does not exist, so a
    // typo in a manifest must land on the same path as a crash.
    proc.on('error', finish);
    return {
      write: (line: string): void => {
        try {
          proc.stdin?.write(`${line}\n`);
        } catch {
          // Gone. The exit handler owns the consequences.
        }
      },
      onStdout: (cb): void => {
        proc.stdout?.on('data', (chunk: string) => {
          cb(typeof chunk === 'string' ? chunk : String(chunk));
        });
      },
      onExit: (cb): void => {
        onExit = cb;
        if (ended) cb();
      },
      kill: (): void => {
        if (proc.exitCode !== null || proc.signalCode !== null) return;
        proc.kill('SIGTERM');
        const hard = setTimeout(() => proc.kill('SIGKILL'), 500);
        hard.unref();
        proc.on('exit', () => {
          clearTimeout(hard);
        });
      },
    };
  };
}

/* ── the shim ──────────────────────────────────────────────────────────── */

/** The bit of a socket this adapter uses. */
export interface ShimSocket {
  send(data: string): void;
  close(code?: number): void;
}

export interface ShimSocketHandlers {
  onMessage(raw: string): void;
  onClose(code: number): void;
}

export type ShimSocketFactory = (
  url: string,
  handlers: ShimSocketHandlers,
) => Promise<ShimSocket>;

export interface StdioShimOptions {
  url: string;
  token: string;
  ws: ShimSocketFactory;
  /** The child executable. Never carries a credential. */
  command: string;
  args?: readonly string[];
  adapterId?: string;
  spawn?: ChildSpawner;
  clock?: { now(): string };
  delay?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  /**
   * The request-deadline timer, injected SEPARATELY from `delay`.
   *
   * They look like the same seam and are not: the conformance kit injects a
   * zero `delay` so the reconnect ceiling is a call count rather than a race
   * against a backoff, and reusing it here would fire every request deadline
   * on the microtask queue and decline every request before a child could
   * read it. Two clocks, because there are two schedules.
   */
  schedule?: (ms: number, fn: () => void) => () => void;
  maxLineBytes?: number;
  /** Extra environment for the child. Filtered by `childEnv` regardless. */
  env?: Readonly<Record<string, string>>;
}

/** Healthy means there is a child. Degraded means there is not, and why. */
export type ShimHealth = 'healthy' | 'degraded';

export interface StdioShimAdapter {
  /** Idempotent: a second call rides the first connection. */
  start(): Promise<void>;
  /** Resolves with the process exit code: 0 on a clean stop, 1 on give-up. */
  run(): Promise<number>;
  stop(): Promise<void>;
  stats(): Record<ChildCounter, number>;
  /** Every audit label this shim produced, in order. */
  refusals(): string[];
  health(): ShimHealth;
}

/**
 * The complete set of frame types an agent may put on this wire, derived from
 * the protocol's own direction table and re-stated here because the emit
 * chokepoint below is the last thing between this adapter and the socket.
 *
 * `send` is not here. There is no such frame.
 */
export const AGENT_FRAME_TYPES: readonly string[] = [
  'hello',
  'draft.submit',
  'draft.delta',
  'proactive.propose',
  'pong',
];

const DEFAULT_MAX_ATTEMPTS = 3;
const BACKOFF_MS = 500;
const DEFAULT_DEADLINE_MS = 5_000;

/**
 * Derived, never random — the same rule every other adapter here follows. A
 * daemon restart that re-delivers the same inbound must dedup at the gateway
 * rather than put a second draft in front of a human.
 */
function idempotencyKey(correlation: Correlation): string {
  const anchor = correlation.inboundGuid ?? `req:${correlation.requestId}`;
  return `openclaw:${anchor}`;
}

interface OpenRequest {
  readonly correlation: Correlation;
  readonly maxChars: number;
  cancel(): void;
}

export function createStdioShimAdapter(
  opts: StdioShimOptions,
): StdioShimAdapter {
  const adapterId = opts.adapterId ?? 'openclaw';
  const args = opts.args ?? [];
  const spawn = opts.spawn ?? createNodeChildSpawner();
  const clock = opts.clock ?? { now: (): string => new Date().toISOString() };
  const delay =
    opts.delay ??
    ((ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const schedule =
    opts.schedule ??
    ((ms: number, fn: () => void): (() => void) => {
      const timer = setTimeout(fn, ms);
      // An adapter must not be the reason a process refuses to exit.
      timer.unref();
      return (): void => {
        clearTimeout(timer);
      };
    });

  const counters: Record<ChildCounter, number> = Object.fromEntries(
    CHILD_COUNTERS.map((name) => [name, 0]),
  ) as Record<ChildCounter, number>;
  const refusals: string[] = [];

  let counter = 0;
  let socket: ShimSocket | null = null;
  let stopped = false;
  let loop: Promise<number> | null = null;
  let child: ShimChild | null = null;
  let health: ShimHealth = 'degraded';
  /** Open `draft.request`s, keyed by `requestId`. */
  const open = new Map<string, OpenRequest>();

  let signalOpen: () => void = () => undefined;
  const firstOpen = new Promise<void>((resolve) => {
    signalOpen = resolve;
  });

  /**
   * The ONLY place a byte reaches the socket.
   *
   * One call site, asserted by a row, so that "what can this adapter put on
   * the wire" is a question with a single answer and reviewing a change to it
   * is a diff a person can read.
   */
  const toSocket = (text: string): void => {
    socket?.send(text);
  };

  /**
   * Build a frame and hand it to the chokepoint. A type outside the
   * agent→gateway vocabulary is dropped here rather than sent and refused:
   * the daemon would audit it as `adapter.no-send-frame` (C-6), and an
   * adapter that has to be told by the far side is one with a bug on this
   * side.
   */
  const emit = (type: string, payload: unknown): void => {
    if (!AGENT_FRAME_TYPES.includes(type)) return;
    counter += 1;
    toSocket(
      JSON.stringify({
        v: WIRE_VERSION,
        id: `${adapterId}-${String(counter).padStart(6, '0')}`,
        type,
        ts: clock.now(),
        payload,
      }),
    );
  };

  /** Write one message to the child, if there is one. */
  const toChild = (message: Record<string, unknown>): void => {
    if (child === null) return;
    counters['child.lines.out'] += 1;
    child.write(JSON.stringify(message));
  };

  /** Record a refusal in the daemon's taxonomy and tell the child why. */
  const refuse = (
    reason: ChildRefusalReason,
    name: string | null,
    tell: boolean,
  ): void => {
    counters[COUNTER_FOR[reason]] += 1;
    refusals.push(classifyChildRefusal(reason, name));
    if (tell) toChild({ kind: 'error', reason });
  };

  /**
   * The one `draft.submit` a request is entitled to. `undefined` declines.
   * Returns false when the request was already closed, which is how a late
   * answer becomes a dropped line rather than a second draft.
   */
  const close = (requestId: string, body: string | undefined): boolean => {
    const entry = open.get(requestId);
    if (entry === undefined) return false;
    open.delete(requestId);
    entry.cancel();
    const base = {
      correlation: entry.correlation,
      idempotencyKey: idempotencyKey(entry.correlation),
    };
    // A decline is a decline: no body key at all. An empty string would show
    // a human a draft that says nothing.
    emit(
      'draft.submit',
      body === undefined ? { ...base, declined: true } : { ...base, body },
    );
    return true;
  };

  /** Every open request, declined. The death path and the give-up path. */
  const declineAllOpen = (): void => {
    for (const requestId of [...open.keys()]) {
      counters['child.declined-on-death'] += 1;
      close(requestId, undefined);
    }
  };

  const onChildMessage = (message: ChildMessage): void => {
    if (message.kind === 'pong') {
      counters['child.pong'] += 1;
      return;
    }
    const requestId = message.correlation.requestId;
    const entry = open.get(requestId);
    if (entry === undefined) {
      // INV-2 as reachability: the ONLY thing that turns a child line into a
      // frame is a request the shim is already holding. Without one there is
      // nothing to answer and nothing to originate.
      counters['child.unknown-correlation'] += 1;
      return;
    }
    if (message.kind === 'decline') {
      close(requestId, undefined);
      return;
    }
    const body = message.body ?? '';
    close(
      requestId,
      body.trim() === '' ? undefined : body.slice(0, entry.maxChars),
    );
  };

  /** One framed line from the child. `final` means the stream ended on it. */
  const onChildLine = (text: string, final: boolean): void => {
    const read = readChildMessage(text);
    if (read.ok) {
      counters['child.lines.in'] += 1;
      onChildMessage(read.message);
      return;
    }
    // A line the child never finished writing is not a broken message, it is
    // half a message, and half a JSON object is not half an answer. It gets
    // its own reason so an operator can tell "the child crashed" apart from
    // "the child emits garbage".
    if (final) {
      refuse('truncated-line', null, false);
      return;
    }
    refuse(read.reason, read.name, true);
  };

  const spawnChild = (): void => {
    if (stopped) return;
    if (counters['child.spawns'] >= maxAttempts) {
      // The ceiling, which is check 5's semantics applied to the child. A
      // shim that respawned forever would turn a child that cannot start
      // into an infinite fork loop on an operator's laptop.
      health = 'degraded';
      return;
    }
    counters['child.spawns'] += 1;
    const parser = createNdjsonParser(maxLineBytes);
    const kid = spawn(opts.command, args, childEnv(opts.env));
    child = kid;
    health = 'healthy';
    kid.onStdout((chunk: string): void => {
      for (const event of parser.push(chunk)) {
        if (event.ok) onChildLine(event.text, event.final);
        else refuse('oversize-line', null, false);
      }
    });
    kid.onExit((): void => {
      if (child !== kid) return;
      // Flush first: plenty of correct children never terminate their last
      // line, and refusing a good answer over a missing byte is a bad trade.
      for (const event of parser.end()) {
        if (event.ok) onChildLine(event.text, event.final);
        else refuse('oversize-line', null, false);
      }
      child = null;
      if (stopped) return;
      health = 'degraded';
      // Decline BEFORE respawning: the new child has never seen these
      // requests and could not answer them if it wanted to.
      declineAllOpen();
      spawnChild();
    });
  };

  const onRequest = (frame: DraftRequestFrame): void => {
    const { correlation, constraints } = frame.payload;
    const requestId = correlation.requestId;
    open.get(requestId)?.cancel();
    const deadlineMs =
      typeof constraints.deadlineMs === 'number' && constraints.deadlineMs > 0
        ? constraints.deadlineMs
        : DEFAULT_DEADLINE_MS;
    const entry: OpenRequest = {
      correlation,
      maxChars: constraints.maxChars,
      cancel: () => undefined,
    };
    // Registered BEFORE the timer is armed. An injected `schedule` that fires
    // synchronously would otherwise look up a request that does not exist
    // yet, and the deadline would silently do nothing.
    open.set(requestId, entry);
    const cancel = schedule(deadlineMs, () => {
      if (!open.has(requestId)) return;
      counters['child.deadline-decline'] += 1;
      close(requestId, undefined);
    });
    if (open.has(requestId)) entry.cancel = cancel;
    else {
      cancel();
      return;
    }
    if (child === null) {
      // No child, so no answer is coming. Decline now: an unanswered
      // `draft.request` is a check-2 failure and, on a real daemon, a draft
      // that never appears.
      counters['child.declined-on-death'] += 1;
      close(requestId, undefined);
      return;
    }
    toChild({ kind: 'request', ...frame.payload });
  };

  const onMessage = (raw: string): void => {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      // The far side's problem. Crashing here would take a healthy adapter
      // down over one bad byte.
      return;
    }
    // Direction-aware on purpose: this is an adapter-inbound path, and
    // `parseGatewayFrame` is what refuses a frame the gateway may not send.
    const parsed = parseGatewayFrame(json);
    if (!parsed.ok) return;
    const frame = parsed.frame;
    if (frame.type === 'ping') {
      // The shim answers the gateway ITSELF. The child's liveness is the
      // shim's business, and a gateway `pong` must never wait on a process
      // that may be wedged.
      emit('pong', {});
      toChild({ kind: 'ping' });
      return;
    }
    if (frame.type !== 'draft.request') return;
    onRequest(frame);
  };

  const connectOnce = (): Promise<number> =>
    new Promise<number>((resolve) => {
      void opts
        .ws(opts.url, {
          onMessage,
          onClose: (code: number) => {
            socket = null;
            open.clear();
            resolve(code);
          },
        })
        .then((s) => {
          socket = s;
          if (stopped) {
            s.close();
            return;
          }
          emit('hello', {
            adapterId,
            token: opts.token,
            wire: WIRE_VERSION,
            // Empty and honest. A child hands back a finished draft, so there
            // is nothing to stream and nothing to propose.
            features: [],
          });
          signalOpen();
        })
        .catch(() => {
          resolve(1006);
        });
    });

  const runLoop = async (): Promise<number> => {
    // The child is started once, before the socket, and outlives a reconnect.
    // A child restarted per connection attempt would lose whatever state its
    // author kept, and would fork three times on a rejected credential.
    spawnChild();
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const code = await connectOnce();
        if (stopped) return 0;
        if (attempt < maxAttempts) await delay(BACKOFF_MS * attempt);
        else return code === 1000 ? 0 : 1;
      }
      return 1;
    } finally {
      // Giving up is a stop. Leaving the child running would strand a process
      // with nobody left to read its stdout.
      stopped = true;
      declineAllOpen();
      child?.kill();
      child = null;
      health = 'degraded';
    }
  };

  const ensureLoop = (): Promise<number> => {
    loop ??= runLoop();
    return loop;
  };

  return {
    async start(): Promise<void> {
      void ensureLoop();
      await Promise.race([firstOpen, ensureLoop().then(() => undefined)]);
    },
    run: ensureLoop,
    async stop(): Promise<void> {
      stopped = true;
      for (const entry of open.values()) entry.cancel();
      open.clear();
      child?.kill();
      child = null;
      health = 'degraded';
      socket?.close();
      if (loop !== null) await loop;
    },
    stats: (): Record<ChildCounter, number> => ({ ...counters }),
    refusals: (): string[] => [...refusals],
    health: (): ShimHealth => health,
  };
}
