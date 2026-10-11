/**
 * v2 S0: the contract recorder (docs/plans/v2-swift-S0S1.md section 2.3).
 *
 * Boots fixture daemons, asks them every question the contract pins, and
 * returns the answers as one bundle. The ratchet (contract.ratchet.spec.ts)
 * is its only caller and the only thing that writes fixtures/contract; this
 * module never touches the disk outside its own temp dirs.
 *
 * Five servers, each for one reason:
 *  - the main harness: live, rules + send + a stub thread source, every
 *    success response and most error envelopes;
 *  - a parked harness: the one place 409 parked can be asked for;
 *  - an SSE harness: a fresh sink, so the frame ids run 1 (greeting) to 22;
 *  - a connection server: connect/disconnect are not in the harness;
 *  - a no-token server: the 503 fail-closed answer.
 *
 * What is random by construction is stabilised (`stabilise` below) so that
 * re-recording an unchanged daemon is byte-identical. The SSE event frames
 * are NOT stabilised: their data must equal fixtures/events verbatim.
 */
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INDEX_BATCH,
  InvalidCursorError,
  SETTING_CONNECTION_STATE,
  UnknownChatError,
  type ChannelSource,
  type ChatsQuery,
  type DraftState,
  type TranscriptTurn,
  type TurnsQuery,
} from '@wemessage/core';
import {
  GATEWAY_EVENT_NAMES,
  WIRE_VERSION,
  type GatewayEventName,
  type GatewayEventPayload,
} from '@wemessage/protocol';
import { openStore } from '@wemessage/store';
import {
  buildServer,
  SSE_KEEPALIVE_MS,
  SSE_PATH,
  startServer,
  TOKEN_FILENAME,
  type SseTimer,
} from '@wemessage/daemon';
import {
  boot,
  CHAT,
  createDraft,
  fakeClock,
  HANDLE,
  T0,
  type Harness,
} from './draft-harness.js';
import { openSse } from './sse-client.js';

/* ------------------------------------------------------------------------ */
/* Public surface                                                            */
/* ------------------------------------------------------------------------ */

export interface Recorded {
  route: string;
  status: number;
  body: unknown;
}

export interface ContractWire {
  wireVersion: number;
  eventNames: readonly string[];
  draftStates: readonly string[];
  backoff: { steps: number[]; jitter: number; auditGapLimit: number };
  sse: { path: string; keepaliveMs: number };
  defaults: { port: number; tokenFile: string };
}

export interface ContractBundle {
  /** Keyed by file path under fixtures/contract ('requests/<slug>...'). */
  requests: Record<string, unknown>;
  responses: Record<string, Recorded>;
  errors: Record<string, Recorded>;
  sse: {
    headers: Record<string, string>;
    greeting: string;
    frames: Record<GatewayEventName, string>;
    keepalive: string;
  };
  wire: ContractWire;
  /** Status mismatches seen while recording; empty when the daemon behaved. */
  surprises: string[];
}

/** The all-zero digest every 64-hex run is rewritten to. */
export const NULL_DIGEST = '0'.repeat(64);

/** The one serialisation every JSON fixture is written in. */
export function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export const REGENERATE: readonly string[] = [
  'WEMESSAGE_WRITE_CONTRACT=1 npx vitest run --project daemon contract.ratchet',
  'git diff --stat fixtures/contract   # review every hunk before committing',
];

/**
 * What JSON Schema cannot say. `z.toJSONSchema` drops `.refine` and
 * `.superRefine` silently, so a client reading only the schemas would accept
 * bodies the daemon refuses. A client must enforce these by hand.
 */
export const CONTRACT_NOTES: readonly string[] = [
  'Refinements are dropped by toJSONSchema; the following are enforced by the daemon but absent from the request schemas.',
  'POST /v1/drafts/bulk: exactly one of ids or filter (both, or neither, is 400).',
  'GET /v1/threads/:guid/messages: before and until are mutually exclusive (both is 400).',
  'GET /v1/search: tz must be an IANA time zone (400 invalid-search); term, channel and has repeat as keys; a query with no term, from, in, has, before or after is 400 empty-search.',
  "GET /v1/threads/by-handle/:handle: a handle containing ';' is refused with 400 invalid-handle.",
  'GET /v1/threads/:guid/years: tz is required and must be an IANA time zone (400 invalid-query).',
  "POST /v1/rules and PATCH /v1/rules/:id: outsideWindow 'queue' is refused with 400 unsupported-outside-window.",
  "PUT /v1/threads/:guid/state: snoozedUntil is required when act is 'snoozed' and refused otherwise; actAt is refused when act is null or when it is later than the daemon clock (all 400 invalid-thread-state).",
  'PATCH /v1/settings is an open object by design: the closed key list is enforced by a typed refusal (unknown-key, read-only-key, wrong-type, below-floor, above-ceiling).',
  'Stabilised values: every 64-hex run is the null digest, minted ulids and message guids are id-NNNN in first-seen order (chosen ids such as test-adapter are kept), and the config dir is <configDir>.',
];

export const RESPONSE_NAMES = [
  'status',
  'health',
  'doctor',
  'drafts.list.empty',
  'drafts.list.pending',
  'drafts.create',
  'drafts.get',
  'drafts.approve',
  'drafts.approve.edited',
  'drafts.reject',
  'drafts.recall',
  'drafts.retry',
  'drafts.redraft',
  'drafts.bulk.approve',
  'batches.get',
  'rules.list',
  'rules.create',
  'rules.patch',
  'rules.delete',
  'rules.test',
  'rules.dryrun',
  'schedules.list',
  'schedules.create',
  'schedules.patch',
  'schedules.delete',
  'contacts.list',
  'contacts.put',
  'contacts.delete',
  'audit.list',
  'audit.verify',
  'settings.list',
  'settings.patch',
  'toggles.killswitch',
  'toggles.killswitch.off',
  'toggles.pause',
  'toggles.resume',
  'toggles.globalmode',
  'adapters.list',
  'adapters.get',
  'adapters.create',
  'adapters.patch',
  'adapters.delete',
  'adapters.token',
  'connect',
  'disconnect',
  'send',
  'threads.list',
  'threads.messages',
  'threads.messages.rich',
  'threads.by-handle.found',
  'threads.by-handle.none',
  'threads.years',
  'threads.state.put.snoozed',
  'threads.state.put.cleared',
  'threads.state.list',
  'search',
  'search.partial',
] as const;

export const ERROR_NAMES = [
  '401.unauthorized',
  '401.missing',
  '503.no-auth-token',
  '409.parked',
  '409.not-armed',
  '409.illegal-transition',
  '409.grace-elapsed',
  '403.gate-denied',
  '404.not-found',
  '404.unknown-chat',
  '503.source-unavailable',
  '400.invalid-cursor',
  '400.invalid-handle',
  '400.invalid-body',
  '400.settings-refusal',
  '400.invalid-thread-state',
  '400.invalid-search',
  '400.empty-search',
  '409.thread-state-conflict',
  '400.unknown-event',
] as const;

/**
 * DraftState is a type only (core domain/types.ts is prettier-locked), so
 * the wire list is spelled here. `satisfies` refuses a name that is not a
 * state; the Record below refuses a state that is missing.
 */
const DRAFT_STATES = [
  'pending',
  'approved',
  'sending',
  'sent',
  'rejected',
  'expired',
  'superseded',
  'recalled',
  'failed',
] as const satisfies readonly DraftState[];
const DRAFT_STATES_EXHAUSTIVE: Record<DraftState, true> = {
  pending: true,
  approved: true,
  sending: true,
  sent: true,
  rejected: true,
  expired: true,
  superseded: true,
  recalled: true,
  failed: true,
};

/* ------------------------------------------------------------------------ */
/* Stabiliser                                                                */
/* ------------------------------------------------------------------------ */

const HEX64 = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/g;
// Whole runs only: without the lookarounds a ULID matches 26 characters of
// the null digest itself (digits are in the Crockford alphabet).
const ULID = /(?<![0-9A-Za-z])[0-9A-HJKMNP-TV-Z]{26}(?![0-9A-Za-z])/g;
/** Message guids the loopback backend mints (crypto.randomUUID, upper). */
const UUID =
  /(?<![0-9A-Za-z-])[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}(?![0-9A-Za-z-])/gi;
const ID_KEYS = new Set([
  'id',
  'draftId',
  'batchId',
  'ruleId',
  'scheduleId',
  'adapterId',
]);
const KEPT_IDS = new Set(['echo', 'human']);

interface StabiliseCtx {
  /** Config dirs to hide, longest first (the realpath before the link). */
  dirs: string[];
  ids: Map<string, string>;
}

function idFor(ctx: StabiliseCtx, raw: string): string {
  let mapped = ctx.ids.get(raw);
  if (mapped === undefined) {
    mapped = `id-${String(ctx.ids.size + 1).padStart(4, '0')}`;
    ctx.ids.set(raw, mapped);
  }
  return mapped;
}

function stabiliseString(s: string, ctx: StabiliseCtx): string {
  let out = s.replace(HEX64, NULL_DIGEST);
  for (const dir of ctx.dirs) out = out.split(dir).join('<configDir>');
  return out
    .replace(UUID, (m) => idFor(ctx, m))
    .replace(ULID, (m) => idFor(ctx, m));
}

function collectIds(value: unknown, ctx: StabiliseCtx): void {
  if (Array.isArray(value)) {
    for (const v of value) collectIds(v, ctx);
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      // Only minted ids are random. A name the recorder chose itself
      // ('test-adapter') or a semantic one (a disconnect step id) is already
      // deterministic, and rewriting it would make the fixture lie.
      if (
        ID_KEYS.has(k) &&
        typeof v === 'string' &&
        !KEPT_IDS.has(v) &&
        /^[0-9A-HJKMNP-TV-Z]{26}$/.test(v)
      )
        idFor(ctx, v);
      collectIds(v, ctx);
    }
  }
}

function rewrite(value: unknown, ctx: StabiliseCtx): unknown {
  if (typeof value === 'string') return stabiliseString(value, ctx);
  if (Array.isArray(value)) return value.map((v) => rewrite(v, ctx));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = rewrite(v, ctx);
    return out;
  }
  return value;
}

/** Depth-first: ids are numbered in first-seen order, then every string rewritten. */
export function stabilise(value: unknown, ctx: StabiliseCtx): unknown {
  collectIds(value, ctx);
  return rewrite(value, ctx);
}

/* ------------------------------------------------------------------------ */
/* Wire constants, read as text                                              */
/* ------------------------------------------------------------------------ */

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

function sourceText(rel: string): string {
  return readFileSync(join(repoRoot, ...rel.split('/')), 'utf8');
}

function match1(text: string, re: RegExp, what: string): string {
  const m = re.exec(text)?.[1];
  if (m === undefined) throw new Error(`contract-recorder: ${what} not found`);
  return m;
}

function readWire(): ContractWire {
  // The reconnect ladder is a CLIENT policy, so it is read from the client
  // that implements it. Until v2 S6c that was the Electron main process; S6c
  // deleted it (D-06 (b)), and the Swift app's `Backoff` is the only home
  // left. It is read as text, because a daemon test cannot import Swift, and
  // that is what makes this bite on Linux: the Swift tests pin `Backoff` to
  // wire.json, but they run on macOS only, and this ratchet runs everywhere.
  const ladder = sourceText(
    'apps/mac/Sources/WeMessageKit/Events/Backoff.swift',
  );
  const steps = match1(
    ladder,
    /static let steps:\s*\[Int\]\s*=\s*\[([^\]]*)\]/,
    'Backoff.steps',
  )
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s.replace(/_/g, '')));
  const jitter = Number(
    match1(
      ladder,
      /static let jitter:\s*Double\s*=\s*([\d._]+)/,
      'Backoff.jitter',
    ),
  );
  const auditGapLimit = Number(
    match1(
      ladder,
      /static let auditGapLimit\s*=\s*([\d_]+)/,
      'Backoff.auditGapLimit',
    ).replace(/_/g, ''),
  );
  // The port is the daemon's own default, from the env schema it boots with:
  // the server decides where it listens, and every client follows.
  const port = Number(
    match1(
      sourceText('packages/daemon/src/main.ts'),
      /WEMESSAGE_PORT:[^\n]*\.default\((\d+)\)/,
      'WEMESSAGE_PORT default',
    ),
  );
  if (Object.keys(DRAFT_STATES_EXHAUSTIVE).length !== DRAFT_STATES.length)
    throw new Error('contract-recorder: DRAFT_STATES is not exhaustive');
  return {
    wireVersion: WIRE_VERSION,
    eventNames: [...GATEWAY_EVENT_NAMES],
    draftStates: [...DRAFT_STATES],
    backoff: { steps, jitter, auditGapLimit },
    sse: { path: SSE_PATH, keepaliveMs: SSE_KEEPALIVE_MS },
    defaults: { port, tokenFile: TOKEN_FILENAME },
  };
}

/* ------------------------------------------------------------------------ */
/* Stub thread source                                                        */
/* ------------------------------------------------------------------------ */

const OTHER_CHAT = 'iMessage;-;+15557654321';

/**
 * v2 F4: what a chat.db source says about every turn of the plain chat:
 * the service, and no reactions or files.
 */
const PLAIN_RICH = {
  service: 'imessage' as const,
  reactions: [],
  files: [],
};

/**
 * v2 F4: a second chat whose page carries every rich fact the wire knows,
 * after board 08's specimens: every delivery rung chat.db proves (08.G),
 * reactions from them and from me (08.C), files, and SMS, RCS and an
 * unknown service (08.I).
 */
const RICH_CHAT = 'iMessage;-;+15550100001';
const RICH_HANDLE = '+15550100001';

function richTurns(): TranscriptTurn[] {
  const them = { from: 'them' as const, handle: RICH_HANDLE };
  const none = { reactions: [], files: [] };
  return [
    {
      ...them,
      ...none,
      guid: 'msg-0101',
      kind: 'text',
      text: 'can you send the photo?',
      at: '2026-09-01T11:50:00.000Z',
      attachments: 0,
      service: 'imessage',
      reactions: [{ kind: 'like', from: 'me' }],
    },
    {
      guid: 'msg-0102',
      from: 'me',
      kind: 'attachment-only',
      text: null,
      at: '2026-09-01T11:55:00.000Z',
      attachments: 1,
      service: 'imessage',
      delivery: { state: 'read', at: '2026-09-01T11:57:00.000Z' },
      reactions: [{ kind: 'love', from: 'them', handle: RICH_HANDLE }],
      files: [
        {
          id: 'AT-0102-1',
          name: 'IMG_0412.heic',
          mime: 'image/heic',
          uti: 'public.heic',
          bytes: 2_400_000,
          sticker: false,
          hidden: false,
        },
      ],
    },
    {
      ...none,
      guid: 'msg-0103',
      from: 'me',
      kind: 'text',
      text: 'on my way',
      at: '2026-09-01T11:58:00.000Z',
      attachments: 0,
      service: 'imessage',
      delivery: { state: 'delivered', at: '2026-09-01T11:58:30.000Z' },
    },
    {
      ...none,
      guid: 'msg-0104',
      from: 'me',
      kind: 'text',
      text: 'running five late',
      at: '2026-09-01T11:59:00.000Z',
      attachments: 0,
      service: 'imessage',
      delivery: { state: 'sent', at: null },
    },
    {
      ...none,
      guid: 'msg-0105',
      from: 'me',
      kind: 'text',
      text: 'are you there?',
      at: '2026-09-01T12:00:00.000Z',
      attachments: 0,
      service: 'imessage',
      delivery: { state: 'failed', at: null, errorCode: 22 },
    },
    {
      ...them,
      guid: 'msg-0106',
      kind: 'attachment-only',
      text: null,
      at: '2026-09-01T12:00:10.000Z',
      attachments: 2,
      service: 'imessage',
      reactions: [
        { kind: 'emphasize', from: 'them', handle: RICH_HANDLE },
        { kind: 'other', from: 'me' },
      ],
      files: [
        {
          id: 'AT-0106-1',
          name: 'itinerary.pdf',
          mime: 'application/pdf',
          uti: 'com.adobe.pdf',
          bytes: 88_000,
          sticker: false,
          hidden: false,
        },
        {
          id: 'AT-0106-2',
          name: null,
          mime: null,
          uti: null,
          bytes: null,
          sticker: false,
          hidden: true,
        },
      ],
    },
    {
      ...none,
      guid: 'msg-0107',
      from: 'me',
      kind: 'text',
      text: 'sent as text message',
      at: '2026-09-01T12:00:20.000Z',
      attachments: 0,
      service: 'sms',
      delivery: { state: 'delivered', at: null },
    },
    {
      ...them,
      ...none,
      guid: 'msg-0108',
      kind: 'text',
      text: 'got it over RCS',
      at: '2026-09-01T12:00:30.000Z',
      attachments: 0,
      service: 'rcs',
    },
    {
      ...none,
      guid: 'msg-0109',
      from: 'me',
      kind: 'text',
      text: 'see you soon',
      at: '2026-09-01T12:00:40.000Z',
      attachments: 0,
      service: 'unknown',
      delivery: null,
    },
  ];
}

function stubSource(): ChannelSource & { down: boolean } {
  const state = { down: false };
  return {
    channel: 'imessage',
    get down() {
      return state.down;
    },
    set down(v: boolean) {
      state.down = v;
    },
    listChats(q: ChatsQuery) {
      if (state.down) return Promise.reject(new Error('source is down'));
      if (q.cursor !== undefined)
        return Promise.reject(new InvalidCursorError());
      return Promise.resolve({
        chats: [
          {
            chatGuid: CHAT,
            title: 'Test User',
            isGroup: false,
            lastLine: 'see you at nine',
            lastFromMe: false,
            lastAt: '2026-09-01T11:58:00.000Z',
          },
          {
            chatGuid: OTHER_CHAT,
            title: '+15557654321',
            isGroup: false,
            lastLine: 'thanks',
            lastFromMe: true,
            lastAt: '2026-09-01T09:30:00.000Z',
          },
        ],
        nextCursor: null,
        total: 2,
      });
    },
    readChatPage(q: TurnsQuery) {
      if (state.down) return Promise.reject(new Error('source is down'));
      if (q.chatGuid === RICH_CHAT) {
        return Promise.resolve({ turns: richTurns(), nextBefore: null });
      }
      if (q.chatGuid !== CHAT) return Promise.reject(new UnknownChatError());
      return Promise.resolve({
        turns: [
          {
            guid: 'msg-0001',
            from: 'them' as const,
            kind: 'text' as const,
            text: 'are we still on for nine?',
            at: '2026-09-01T11:50:00.000Z',
            handle: HANDLE,
            attachments: 0,
            ...PLAIN_RICH,
          },
          {
            guid: 'msg-0002',
            from: 'me' as const,
            kind: 'text' as const,
            text: 'yes, see you there',
            at: '2026-09-01T11:55:00.000Z',
            attachments: 0,
            ...PLAIN_RICH,
            delivery: {
              state: 'delivered' as const,
              at: '2026-09-01T11:56:00.000Z',
            },
          },
          {
            guid: 'msg-0003',
            from: 'them' as const,
            kind: 'text' as const,
            text: 'see you at nine',
            at: '2026-09-01T11:58:00.000Z',
            handle: HANDLE,
            attachments: 0,
            ...PLAIN_RICH,
          },
        ],
        nextBefore: null,
      });
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Recording                                                                 */
/* ------------------------------------------------------------------------ */

type Inject = {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  route: string;
  payload?: unknown;
  headers?: Record<string, string>;
};

interface Server {
  app: {
    inject(o: {
      method: Inject['method'];
      url: string;
      payload?: unknown;
      headers?: Record<string, string>;
    }): Promise<{ statusCode: number; body: string }>;
  };
}

async function ask(
  server: Server,
  headers: Record<string, string>,
  req: Inject,
): Promise<Recorded> {
  const res = await server.app.inject({
    method: req.method,
    url: req.url,
    headers: req.headers ?? headers,
    ...(req.payload !== undefined ? { payload: req.payload as object } : {}),
  });
  return {
    route: req.route,
    status: res.statusCode,
    body: res.body.length > 0 ? (JSON.parse(res.body) as unknown) : null,
  };
}

/**
 * Status mismatches seen during one recording. Collected, not thrown: a
 * thrown mismatch would abort the whole recording in `beforeAll` and skip
 * every ratchet row, where a collected one lets the recording finish so the
 * row naming the drifted fixture goes red on its own (plus the surprises row).
 */
let surprises: string[] = [];

function expectStatus(name: string, r: Recorded, status: number): Recorded {
  if (r.status !== status) {
    surprises.push(
      `${name} answered ${String(r.status)}, wanted ${String(status)}: ${JSON.stringify(r.body)}`,
    );
  }
  return r;
}

/** Read a minted id off a body, or a placeholder when the call went wrong. */
function idAt(body: unknown, ...path: string[]): string {
  let at: unknown = body;
  for (const key of path) {
    if (typeof at !== 'object' || at === null) return 'missing-id';
    at = (at as Record<string, unknown>)[key];
  }
  return typeof at === 'string' ? at : 'missing-id';
}

const SSE_HEADER_KEYS = [
  'content-type',
  'cache-control',
  'connection',
  'x-accel-buffering',
] as const;

/** A keepalive timer the recorder fires by hand (the manualTimers idiom). */
function manualTimer(): { timer: SseTimer; fire(): void } {
  const ticks: Array<{ onTick: () => void; live: boolean }> = [];
  return {
    timer: (onTick) => {
      const entry = { onTick, live: true };
      ticks.push(entry);
      return () => {
        entry.live = false;
      };
    },
    fire() {
      for (const t of ticks) if (t.live) t.onTick();
    },
  };
}

async function recordSse(): Promise<{
  sse: ContractBundle['sse'];
  unknownEvent: Recorded;
}> {
  const timers = manualTimer();
  const h = await boot({ greeting: true, sse: { timer: timers.timer } });
  const port = await startServer(h.server);
  const stream = await openSse(`http://127.0.0.1:${String(port)}`, SSE_PATH, {
    headers: h.headers,
  });
  try {
    await stream.waitForEvents(1, 'greeting');
    const eventsDir = join(repoRoot, 'fixtures', 'events');
    for (const name of GATEWAY_EVENT_NAMES) {
      const frame = JSON.parse(
        readFileSync(join(eventsDir, `${name}.json`), 'utf8'),
      ) as GatewayEventPayload;
      h.sink.broadcast(frame);
    }
    await stream.waitForEvents(1 + GATEWAY_EVENT_NAMES.length, 'all events');
    const framesRaw = stream.raw;
    timers.fire();
    await stream.waitForComments(1, 'keepalive');
    const keepalive = stream.raw.slice(framesRaw.length);

    const chunks = framesRaw
      .split('\n\n')
      .filter((c) => c.length > 0)
      .map((c) => `${c}\n\n`);
    if (chunks.length !== 1 + GATEWAY_EVENT_NAMES.length)
      throw new Error(
        `contract-recorder: ${String(chunks.length)} sse frames, wanted ${String(1 + GATEWAY_EVENT_NAMES.length)}`,
      );
    const frames = {} as Record<GatewayEventName, string>;
    GATEWAY_EVENT_NAMES.forEach((name, i) => {
      frames[name] = chunks[i + 1] ?? '';
    });

    const headers: Record<string, string> = {};
    for (const key of SSE_HEADER_KEYS) {
      const v = stream.headers[key];
      if (typeof v === 'string') headers[key] = v;
    }

    const unknownEvent = await ask(h.server, h.headers, {
      method: 'GET',
      url: `${SSE_PATH}?events=nope`,
      route: `GET ${SSE_PATH}`,
    });
    return {
      sse: { headers, greeting: chunks[0] ?? '', frames, keepalive },
      unknownEvent,
    };
  } finally {
    await stream.close();
  }
}

/** The main harness: every success response and most error envelopes. */
async function recordMain(
  responses: Record<string, Recorded>,
  errors: Record<string, Recorded>,
): Promise<Harness> {
  const source = stubSource();
  const h = await boot({
    greeting: true,
    rules: true,
    send: true,
    threads: source,
    search: true,
    // v2 F7c: the status golden is the composed daemon's shape, facts and
    // all, with a synthetic handle so the field is not only ever null.
    status: { ownHandle: () => '+15550100000' },
  });
  const H = h.headers;
  const ok = async (
    name: (typeof RESPONSE_NAMES)[number],
    status: number,
    req: Inject,
  ): Promise<Recorded> => {
    const r = expectStatus(name, await ask(h.server, H, req), status);
    responses[name] = r;
    return r;
  };
  const err = async (
    name: (typeof ERROR_NAMES)[number],
    status: number,
    req: Inject,
  ): Promise<Recorded> => {
    const r = expectStatus(name, await ask(h.server, H, req), status);
    errors[name] = r;
    return r;
  };
  const draftId = (r: Recorded): string => idAt(r.body, 'draft', 'id');

  // --- liveness and diagnosis -------------------------------------------
  await ok('status', 200, {
    method: 'GET',
    url: '/v1/status',
    route: 'GET /v1/status',
  });
  await ok('health', 200, {
    method: 'GET',
    url: '/v1/health',
    route: 'GET /v1/health',
    headers: {},
  });
  await ok('doctor', 200, {
    method: 'GET',
    url: '/v1/doctor',
    route: 'GET /v1/doctor',
  });

  // --- the draft lifecycle ----------------------------------------------
  await ok('drafts.list.empty', 200, {
    method: 'GET',
    url: '/v1/drafts',
    route: 'GET /v1/drafts',
  });
  const created = await ok('drafts.create', 201, {
    method: 'POST',
    url: '/v1/drafts',
    route: 'POST /v1/drafts',
    payload: { chatGuid: CHAT, body: 'hello' },
  });
  const d1 = draftId(created);
  const d2 = (await createDraft(h, 'hello again')).id;
  await ok('drafts.list.pending', 200, {
    method: 'GET',
    url: '/v1/drafts?state=pending',
    route: 'GET /v1/drafts',
  });
  await ok('drafts.get', 200, {
    method: 'GET',
    url: `/v1/drafts/${d1}`,
    route: 'GET /v1/drafts/:id',
  });
  await err('409.illegal-transition', 409, {
    method: 'POST',
    url: `/v1/drafts/${d1}/recall`,
    route: 'POST /v1/drafts/:id/recall',
  });
  await ok('drafts.approve', 200, {
    method: 'POST',
    url: `/v1/drafts/${d1}/approve`,
    route: 'POST /v1/drafts/:id/approve',
    payload: {},
  });
  await ok('drafts.recall', 200, {
    method: 'POST',
    url: `/v1/drafts/${d1}/recall`,
    route: 'POST /v1/drafts/:id/recall',
  });
  await ok('drafts.approve.edited', 200, {
    method: 'POST',
    url: `/v1/drafts/${d2}/approve`,
    route: 'POST /v1/drafts/:id/approve',
    payload: { editedBody: 'hello there' },
  });
  h.clockCtl.advance(11_000);
  await err('409.grace-elapsed', 409, {
    method: 'POST',
    url: `/v1/drafts/${d2}/recall`,
    route: 'POST /v1/drafts/:id/recall',
  });
  await h.scheduler.tick();

  const d3 = (await createDraft(h, 'not this one')).id;
  await ok('drafts.reject', 200, {
    method: 'POST',
    url: `/v1/drafts/${d3}/reject`,
    route: 'POST /v1/drafts/:id/reject',
    payload: { reason: 'no' },
  });
  await ok('drafts.redraft', 200, {
    method: 'POST',
    url: `/v1/drafts/${d3}/redraft`,
    route: 'POST /v1/drafts/:id/redraft',
  });

  const retryBody = 'try this again';
  const d4 = (await createDraft(h, retryBody)).id;
  h.backend.sabotageBody(retryBody);
  expectStatus(
    'retry setup approve',
    await ask(h.server, H, {
      method: 'POST',
      url: `/v1/drafts/${d4}/approve`,
      route: 'POST /v1/drafts/:id/approve',
      payload: {},
    }),
    200,
  );
  h.clockCtl.advance(11_000);
  await h.scheduler.tick();
  h.backend.unsabotageBody(retryBody);
  await ok('drafts.retry', 200, {
    method: 'POST',
    url: `/v1/drafts/${d4}/retry`,
    route: 'POST /v1/drafts/:id/retry',
  });

  await createDraft(h, 'one of a batch');
  const bulk = await ok('drafts.bulk.approve', 200, {
    method: 'POST',
    url: '/v1/drafts/bulk',
    route: 'POST /v1/drafts/bulk',
    payload: { action: 'approve', filter: { all: true } },
  });
  const batchId = idAt(bulk.body, 'batchId');
  await ok('batches.get', 200, {
    method: 'GET',
    url: `/v1/batches/${batchId}`,
    route: 'GET /v1/batches/:id',
  });
  h.clockCtl.advance(11_000);
  await h.scheduler.tick();

  // --- rules --------------------------------------------------------------
  const rule = await ok('rules.create', 201, {
    method: 'POST',
    url: '/v1/rules',
    route: 'POST /v1/rules',
    payload: {
      name: 'Greeting',
      matcher: { kind: 'keyword', keywords: ['hello'], mode: 'any' },
      adapterId: 'echo',
      respondMode: 'draft-only',
    },
  });
  const ruleId = idAt(rule.body, 'rule', 'id');
  await ok('rules.list', 200, {
    method: 'GET',
    url: '/v1/rules',
    route: 'GET /v1/rules',
  });
  await ok('rules.patch', 200, {
    method: 'PATCH',
    url: `/v1/rules/${ruleId}`,
    route: 'PATCH /v1/rules/:id',
    payload: { priority: 50 },
  });
  await ok('rules.test', 200, {
    method: 'POST',
    url: `/v1/rules/${ruleId}/test`,
    route: 'POST /v1/rules/:id/test',
    payload: { text: 'hi' },
  });
  await ok('rules.dryrun', 200, {
    method: 'GET',
    url: `/v1/rules/${ruleId}/dry-run?limit=5`,
    route: 'GET /v1/rules/:id/dry-run',
  });
  await ok('rules.delete', 204, {
    method: 'DELETE',
    url: `/v1/rules/${ruleId}`,
    route: 'DELETE /v1/rules/:id',
  });

  // --- schedules ----------------------------------------------------------
  const schedule = await ok('schedules.create', 201, {
    method: 'POST',
    url: '/v1/schedules',
    route: 'POST /v1/schedules',
    payload: {
      name: 'Office hours',
      timezone: 'America/Los_Angeles',
      windows: [{ days: ['mon'], start: '09:00', end: '17:00' }],
    },
  });
  const scheduleId = idAt(schedule.body, 'schedule', 'id');
  await ok('schedules.list', 200, {
    method: 'GET',
    url: '/v1/schedules',
    route: 'GET /v1/schedules',
  });
  await ok('schedules.patch', 200, {
    method: 'PATCH',
    url: `/v1/schedules/${scheduleId}`,
    route: 'PATCH /v1/schedules/:id',
    payload: { name: 'Weekday mornings' },
  });
  await ok('schedules.delete', 204, {
    method: 'DELETE',
    url: `/v1/schedules/${scheduleId}`,
    route: 'DELETE /v1/schedules/:id',
  });

  // --- the human send, then contacts and the gate -----------------------
  await ok('send', 200, {
    method: 'POST',
    url: '/v1/send',
    route: 'POST /v1/send',
    payload: { chatGuid: CHAT, body: 'sent by hand' },
  });
  const handleUrl = `/v1/contacts/${encodeURIComponent(HANDLE)}`;
  await ok('contacts.put', 200, {
    method: 'PUT',
    url: handleUrl,
    route: 'PUT /v1/contacts/:handle',
    payload: { mode: 'draft-only', displayName: 'Test User' },
  });
  await ok('contacts.list', 200, {
    method: 'GET',
    url: '/v1/contacts',
    route: 'GET /v1/contacts',
  });
  await ok('contacts.delete', 200, {
    method: 'DELETE',
    url: handleUrl,
    route: 'DELETE /v1/contacts/:handle',
  });

  // --- audit --------------------------------------------------------------
  await ok('audit.list', 200, {
    method: 'GET',
    url: '/v1/audit?limit=5',
    route: 'GET /v1/audit',
  });
  await ok('audit.verify', 200, {
    method: 'GET',
    url: '/v1/audit/verify',
    route: 'GET /v1/audit/verify',
  });

  // --- settings -----------------------------------------------------------
  await ok('settings.list', 200, {
    method: 'GET',
    url: '/v1/settings',
    route: 'GET /v1/settings',
  });
  await ok('settings.patch', 200, {
    method: 'PATCH',
    url: '/v1/settings',
    route: 'PATCH /v1/settings',
    payload: { 'send.autoGraceSeconds': 20 },
  });
  await err('400.settings-refusal', 400, {
    method: 'PATCH',
    url: '/v1/settings',
    route: 'PATCH /v1/settings',
    payload: { unknownKey: 1 },
  });

  // --- toggles ------------------------------------------------------------
  await ok('toggles.killswitch', 200, {
    method: 'POST',
    url: '/v1/toggles/kill-switch',
    route: 'POST /v1/toggles/kill-switch',
    payload: { on: true },
  });
  // The human path ignores contact policy (the F-20 pin: a human send to a
  // denied contact is still the operator's call). The kill switch is the
  // gate that refuses a human send, so the 403 is asked for while it is on.
  await err('403.gate-denied', 403, {
    method: 'POST',
    url: '/v1/send',
    route: 'POST /v1/send',
    payload: { chatGuid: CHAT, body: 'should not go' },
  });
  await ok('toggles.killswitch.off', 200, {
    method: 'POST',
    url: '/v1/toggles/kill-switch',
    route: 'POST /v1/toggles/kill-switch',
    payload: { on: false },
  });
  await ok('toggles.pause', 200, {
    method: 'POST',
    url: '/v1/toggles/pause',
    route: 'POST /v1/toggles/pause',
    payload: { until: '1h' },
  });
  await ok('toggles.resume', 200, {
    method: 'POST',
    url: '/v1/toggles/pause',
    route: 'POST /v1/toggles/pause',
    payload: { until: null },
  });
  await ok('toggles.globalmode', 200, {
    method: 'POST',
    url: '/v1/toggles/global-mode',
    route: 'POST /v1/toggles/global-mode',
    payload: { mode: 'draft-only' },
  });
  // With no schedule armed there is no window to pause for the rest of.
  await err('409.not-armed', 409, {
    method: 'POST',
    url: '/v1/toggles/pause',
    route: 'POST /v1/toggles/pause',
    payload: { until: 'rest-of-window' },
  });

  // --- adapters -----------------------------------------------------------
  await ok('adapters.create', 201, {
    method: 'POST',
    url: '/v1/adapters',
    route: 'POST /v1/adapters',
    payload: { id: 'test-adapter', kind: 'generic', displayName: 'Test' },
  });
  await ok('adapters.list', 200, {
    method: 'GET',
    url: '/v1/adapters',
    route: 'GET /v1/adapters',
  });
  await ok('adapters.get', 200, {
    method: 'GET',
    url: '/v1/adapters/test-adapter',
    route: 'GET /v1/adapters/:id',
  });
  await ok('adapters.patch', 200, {
    method: 'PATCH',
    url: '/v1/adapters/test-adapter',
    route: 'PATCH /v1/adapters/:id',
    payload: { displayName: 'Test Two' },
  });
  await ok('adapters.token', 200, {
    method: 'POST',
    url: '/v1/adapters/test-adapter/token',
    route: 'POST /v1/adapters/:id/token',
  });
  await ok('adapters.delete', 204, {
    method: 'DELETE',
    url: '/v1/adapters/test-adapter',
    route: 'DELETE /v1/adapters/:id',
  });

  // --- threads ------------------------------------------------------------
  await ok('threads.list', 200, {
    method: 'GET',
    url: '/v1/threads',
    route: 'GET /v1/threads',
  });
  await ok('threads.messages', 200, {
    method: 'GET',
    url: `/v1/threads/${encodeURIComponent(CHAT)}/messages`,
    route: 'GET /v1/threads/:guid/messages',
  });
  // v2 F4: every rich fact the wire knows, on one page.
  await ok('threads.messages.rich', 200, {
    method: 'GET',
    url: `/v1/threads/${encodeURIComponent(RICH_CHAT)}/messages`,
    route: 'GET /v1/threads/:guid/messages',
  });
  await err('404.unknown-chat', 404, {
    method: 'GET',
    url: `/v1/threads/${encodeURIComponent(OTHER_CHAT)}/messages`,
    route: 'GET /v1/threads/:guid/messages',
  });
  await err('400.invalid-cursor', 400, {
    method: 'GET',
    url: '/v1/threads?cursor=nope',
    route: 'GET /v1/threads',
  });
  // v2 F5: the harness's 1:1 chat for HANDLE is found; a handle with no
  // chat on this Mac is a 200 with a null conversation, not an error.
  await ok('threads.by-handle.found', 200, {
    method: 'GET',
    url: `/v1/threads/by-handle/${encodeURIComponent(HANDLE)}`,
    route: 'GET /v1/threads/by-handle/:handle',
  });
  await ok('threads.by-handle.none', 200, {
    method: 'GET',
    url: `/v1/threads/by-handle/${encodeURIComponent('+15550100099')}`,
    route: 'GET /v1/threads/by-handle/:handle',
  });
  await err('400.invalid-handle', 400, {
    method: 'GET',
    url: `/v1/threads/by-handle/${encodeURIComponent('+15550100001;x')}`,
    route: 'GET /v1/threads/by-handle/:handle',
  });
  // v2 F2c: the harness chat's turns by year in the operator's zone.
  await ok('threads.years', 200, {
    method: 'GET',
    url: `/v1/threads/${encodeURIComponent(CHAT)}/years?tz=${encodeURIComponent('America/Los_Angeles')}`,
    route: 'GET /v1/threads/:guid/years',
  });

  // --- thread state (v2 F3) -----------------------------------------------
  const stateUrl = `/v1/threads/${encodeURIComponent(CHAT)}/state`;
  const snoozed = await ok('threads.state.put.snoozed', 200, {
    method: 'PUT',
    url: stateUrl,
    route: 'PUT /v1/threads/:guid/state',
    payload: {
      act: 'snoozed',
      snoozedUntil: '2026-09-01T23:00:00.000Z',
      ifUpdatedAt: null,
    },
  });
  await ok('threads.state.list', 200, {
    method: 'GET',
    url: '/v1/threads/state',
    route: 'GET /v1/threads/state',
  });
  await err('409.thread-state-conflict', 409, {
    method: 'PUT',
    url: stateUrl,
    route: 'PUT /v1/threads/:guid/state',
    payload: { act: 'done', ifUpdatedAt: null },
  });
  await err('400.invalid-thread-state', 400, {
    method: 'PUT',
    url: stateUrl,
    route: 'PUT /v1/threads/:guid/state',
    payload: { act: 'snoozed' },
  });
  await ok('threads.state.put.cleared', 200, {
    method: 'PUT',
    url: stateUrl,
    route: 'PUT /v1/threads/:guid/state',
    payload: {
      act: null,
      attention: null,
      ifUpdatedAt: idAt(snoozed.body, 'state', 'updatedAt'),
    },
  });
  source.down = true;
  await err('503.source-unavailable', 503, {
    method: 'GET',
    url: '/v1/threads',
    route: 'GET /v1/threads',
  });
  source.down = false;

  // --- search (v2 F2b) ----------------------------------------------------
  // Two messages in the harness's 1:1 chat, mirrored and indexed the way the
  // daemon's scan and index step would.
  const chatRow = h.fixture.db
    .prepare('SELECT ROWID AS id FROM chat WHERE guid = ?')
    .get(CHAT) as { id: number };
  const handleRow = h.fixture.db
    .prepare('SELECT ROWID AS id FROM handle WHERE id = ?')
    .get(HANDLE) as { id: number };
  h.fixture.addMessage({
    chatId: chatRow.id,
    handleId: handleRow.id,
    text: 'see you at the cabin',
    at: '2026-09-01T08:00:00.000Z',
  });
  h.fixture.addMessage({
    chatId: chatRow.id,
    text: 'ok',
    at: '2026-09-01T08:05:00.000Z',
    isFromMe: true,
  });
  const mirrorFrom = h.store.getCursor()?.lastRowid ?? 0;
  for (const m of await h.reader.readSince(mirrorFrom))
    h.store.insertInboundMessage(m);
  for (let mark = -1; ;) {
    const step = h.store.indexPending(INDEX_BATCH);
    if (step.throughRowid === mark) break;
    mark = step.throughRowid;
  }
  await ok('search', 200, {
    method: 'GET',
    url: '/v1/search?term=cabin&tz=America%2FLos_Angeles',
    route: 'GET /v1/search',
  });
  await ok('search.partial', 200, {
    method: 'GET',
    url: '/v1/search?term=ok&from=me&channel=imessage&channel=whatsapp&tz=UTC',
    route: 'GET /v1/search',
  });
  await err('400.invalid-search', 400, {
    method: 'GET',
    url: '/v1/search?term=cabin&tz=Mars%2FOlympus',
    route: 'GET /v1/search',
  });
  await err('400.empty-search', 400, {
    method: 'GET',
    url: '/v1/search?tz=UTC',
    route: 'GET /v1/search',
  });

  // --- the remaining envelopes -------------------------------------------
  await err('401.unauthorized', 401, {
    method: 'GET',
    url: '/v1/status',
    route: 'GET /v1/status',
    headers: { authorization: 'Bearer wm_wrong' },
  });
  await err('401.missing', 401, {
    method: 'GET',
    url: '/v1/status',
    route: 'GET /v1/status',
    headers: {},
  });
  await err('404.not-found', 404, {
    method: 'GET',
    url: '/v1/drafts/id-does-not-exist',
    route: 'GET /v1/drafts/:id',
  });
  await err('400.invalid-body', 400, {
    method: 'POST',
    url: '/v1/drafts',
    route: 'POST /v1/drafts',
    payload: {},
  });
  return h;
}

/** v2 A0p: the park. Approve is never parked; scheduling an arming is. */
async function recordParked(): Promise<{ rec: Recorded; dir: string }> {
  const h = await boot({ autonomy: 'parked', rules: true });
  const rec = expectStatus(
    '409.parked',
    await ask(h.server, h.headers, {
      method: 'POST',
      url: '/v1/schedules',
      route: 'POST /v1/schedules',
      payload: {
        name: 'Office hours',
        timezone: 'America/Los_Angeles',
        windows: [{ days: ['mon'], start: '09:00', end: '17:00' }],
      },
    }),
    409,
  );
  return { rec, dir: h.dir };
}

/** connect/disconnect are not in the harness: a fourth server, stub deps. */
async function recordConnection(): Promise<{
  connect: Recorded;
  disconnect: Recorded;
  dir: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'wm-s0-conn-'));
  const clock = fakeClock(T0).clock;
  const store = openStore({ dir, clock });
  store.setSetting(SETTING_CONNECTION_STATE, 'fully-connected');
  const server = await buildServer({
    autonomy: 'live',
    configDir: dir,
    connection: {
      store,
      clock,
      probes: {
        osMajor: () => 15,
        fda: async () => 'ok' as const,
        automation: async () => 'ok' as const,
        messagesRunning: async () => true,
      },
      stopWatcher: () => {},
      closeEventClients: () => {},
      rotateToken: () => `wm_${'a'.repeat(64)}`,
      purge: () => {},
      rearmWatcher: async () => {},
    },
  });
  try {
    if (server.token === null) throw new Error('contract-recorder: no token');
    const headers = { authorization: `Bearer ${server.token}` };
    const connect = expectStatus(
      'connect',
      await ask(server, headers, {
        method: 'POST',
        url: '/v1/connect',
        route: 'POST /v1/connect',
      }),
      200,
    );
    const disconnect = expectStatus(
      'disconnect',
      await ask(server, headers, {
        method: 'POST',
        url: '/v1/disconnect',
        route: 'POST /v1/disconnect',
        payload: {},
      }),
      200,
    );
    return { connect, disconnect, dir };
  } finally {
    await server.app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Fail closed: a config dir the daemon cannot write a token into. */
async function recordNoToken(): Promise<Recorded> {
  const dir = mkdtempSync(join(tmpdir(), 'wm-s0-notoken-'));
  chmodSync(dir, 0o500);
  try {
    const server = await buildServer({ autonomy: 'live', configDir: dir });
    try {
      if (server.token !== null)
        throw new Error('contract-recorder: a token was minted');
      return expectStatus(
        '503.no-auth-token',
        await ask(
          server,
          {},
          {
            method: 'GET',
            url: '/v1/status',
            route: 'GET /v1/status',
          },
        ),
        503,
      );
    } finally {
      await server.app.close();
    }
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Record the whole contract. Requests are rendered by the caller's import of
 * `contract.ts` (they need no daemon); everything else is asked of one.
 */
export async function recordContract(): Promise<ContractBundle> {
  // The doctor reports a `runtime` block only when it can name a host:
  // under Electron, or (v2 S2b) under the Swift app's WEMESSAGE_HOST=swift.
  // With neither the key is absent, which is what makes the doctor fixture
  // host-independent, so a recording session refuses both.
  if (process.versions['electron'] !== undefined)
    throw new Error('contract-recorder: must run under Node, not Electron');
  if (process.env['WEMESSAGE_HOST'] === 'swift')
    throw new Error(
      'contract-recorder: must not run with WEMESSAGE_HOST=swift',
    );
  surprises = [];

  const { contractSlug, paramJsonSchemas, requestJsonSchemas } =
    await import('../../src/contract.js');
  const requests: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(requestJsonSchemas()))
    requests[`requests/${contractSlug(key)}.schema.json`] = schema;
  for (const [key, schema] of Object.entries(paramJsonSchemas()))
    requests[`requests/${contractSlug(key)}.params.schema.json`] = schema;

  const rawResponses: Record<string, Recorded> = {};
  const rawErrors: Record<string, Recorded> = {};
  const main = await recordMain(rawResponses, rawErrors);
  const parked = await recordParked();
  rawErrors['409.parked'] = parked.rec;
  const conn = await recordConnection();
  rawResponses['connect'] = conn.connect;
  rawResponses['disconnect'] = conn.disconnect;
  rawErrors['503.no-auth-token'] = await recordNoToken();
  const { sse, unknownEvent } = await recordSse();
  rawErrors['400.unknown-event'] = unknownEvent;

  const dirs = [main.dir, parked.dir, conn.dir]
    .flatMap((d) => {
      let real = d;
      try {
        real = realpathSync(d);
      } catch {
        // already removed: the plain path is all there is to hide
      }
      return [real, d];
    })
    .sort((a, b) => b.length - a.length);
  // ONE ctx for the whole bundle: an id means the same thing in every file.
  const ctx: StabiliseCtx = { dirs, ids: new Map() };
  const responses: Record<string, Recorded> = {};
  for (const name of RESPONSE_NAMES)
    responses[name] = stabilise(rawResponses[name], ctx) as Recorded;
  const errors: Record<string, Recorded> = {};
  for (const name of ERROR_NAMES)
    errors[name] = stabilise(rawErrors[name], ctx) as Recorded;

  return {
    requests,
    responses,
    errors,
    sse: {
      ...sse,
      greeting: stabiliseString(sse.greeting, ctx),
      headers: sse.headers,
    },
    wire: readWire(),
    surprises,
  };
}
