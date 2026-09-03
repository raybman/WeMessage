/**
 * @wemessage/client — typed daemon client (auth bootstrap, REST, WS events).
 * Thin transport over the authenticated local API (§2.5 "CLI and GUI are thin
 * clients over the identical authenticated HTTP/WS API"); zero business logic.
 *
 * Auth bootstrap per §2.6: same-user callers read the token file directly
 * (filesystem-permission trust, the standard local-daemon pattern); rotation
 * rewrites that file — the daemon re-reads it per request, so old bearers get
 * 401 immediately.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { GatewayEventPayload } from '@wemessage/protocol';

export type { GatewayEventPayload } from '@wemessage/protocol';

/** Token file name inside the WeMessage config dir (§2.6). */
export const TOKEN_FILENAME = 'daemon.token';
/** wm_ prefix per the WeMessage rename map (R11). */
export const TOKEN_PREFIX = 'wm_';

/** Daemon could not be reached at all (maps to CLI exit 3, §3.8). */
export class DaemonUnreachableError extends Error {
  constructor(baseUrl: string, cause?: unknown) {
    super(`daemon unreachable at ${baseUrl}`);
    this.name = 'DaemonUnreachableError';
    this.cause = cause;
  }
}

/** Daemon rejected the bearer — 401/503 auth modes (CLI exit 4, §3.8). */
export class DaemonAuthError extends Error {
  constructor(readonly statusCode: number) {
    super(`daemon rejected authentication (HTTP ${statusCode})`);
    this.name = 'DaemonAuthError';
  }
}

/** Any other non-2xx daemon response (CLI exit 1, §3.8). */
export class DaemonRequestError extends Error {
  constructor(
    readonly statusCode: number,
    body: string,
  ) {
    super(`daemon request failed (HTTP ${statusCode}): ${body}`);
    this.name = 'DaemonRequestError';
  }
}

/**
 * §1.6 `GateDenyReason` (client-local redeclaration, same pattern as every
 * other S2/S3 DTO here — @wemessage/client has no @wemessage/core dep).
 */
export type GateDenyReason =
  | 'kill-switch'
  | 'disconnected'
  | 'read-only'
  | 'contact-denied'
  | 'group-auto-forbidden'
  | 'outside-window'
  | 'rate-limited'
  | 'circuit-open'
  | 'loop-detected'
  | 'unapproved'
  | 'adapter-disabled'
  | 'sms-auto-forbidden';

/**
 * `POST /v1/send`'s ONE HTTP-level refusal (s3-execution Scenario 10). The
 * daemon uses 403 EXCLUSIVELY for gate denial (grep of packages/daemon/src
 * confirms no other 403 producer exists) — this used to fall into
 * `DaemonAuthError` and lose `reason` entirely; extends `DaemonRequestError`
 * (not `DaemonAuthError`) so `.statusCode` survives without implying an
 * auth failure (CLI exit 5, EXIT_GATE_DENIED — 0-4 untouched).
 */
export class DaemonGateDeniedError extends DaemonRequestError {
  constructor(readonly reason: GateDenyReason) {
    super(403, JSON.stringify({ error: 'gate-denied', reason }));
    this.name = 'DaemonGateDeniedError';
  }
}

/** Read the daemon token from the config dir; null when absent (§2.6). */
export function readTokenFile(configDir: string): string | null {
  try {
    const token = readFileSync(join(configDir, TOKEN_FILENAME), 'utf8').trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Rotate the token file: write a fresh 256-bit `wm_` token at mode 0600 and
 * return it. The daemon authenticates against the file per request, so prior
 * bearers 401 from the next request on (§2.6 "greenlight auth rotate").
 */
export function rotateTokenFile(configDir: string): string {
  const token = TOKEN_PREFIX + randomBytes(32).toString('hex');
  mkdirSync(configDir, { recursive: true });
  const path = join(configDir, TOKEN_FILENAME);
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600); // mode option is umask-filtered; enforce exactly 0600
  return token;
}

/** F-5 proposed S1 `/v1/status` payload — nulls for S4/S6 concepts. */
export interface StatusPayload {
  connectionState: 'fully-connected' | 'read-only' | 'disconnected';
  cursor: { lastRowid: number; lastScanAt: string } | null;
  counts: { messagesToday: number };
  adapters: unknown[];
  killSwitch: null;
  armed: null;
}

export interface ClientOptions {
  /** e.g. `http://127.0.0.1:47100` (§2.6 default port). */
  baseUrl: string;
  token: string;
}

export interface EventSubscription {
  close(): void;
}

/**
 * S2 rule/audit DTOs (Scenario 11) — client-local, same pattern as
 * `StatusPayload`: @wemessage/client has no @wemessage/core dependency
 * (protocol untouched), so the §3.2 domain shapes are redeclared here.
 */
export type RuleMatcher =
  | {
      kind: 'keyword';
      keywords: string[];
      mode: 'any' | 'all';
      caseSensitive?: boolean;
      wholeWord?: boolean;
    }
  | { kind: 'regex'; pattern: string }
  | { kind: 'theme'; themes: string[]; minConfidence: number }
  | { kind: 'contact'; handles: string[] }
  | { kind: 'all-of'; matchers: RuleMatcher[] }
  | { kind: 'any-of'; matchers: RuleMatcher[] };

export interface RulePayload {
  id: string;
  name: string;
  enabled: boolean;
  matcher: RuleMatcher;
  adapterId: string;
  respondMode: 'draft-only' | 'auto';
  scheduleId: string | null;
  outsideWindow: 'draft-only' | 'queue' | 'ignore';
  allowGroupDrafts: boolean;
  matchAttachmentOnly: boolean;
  draftTtlMinutes: number;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

/** §1.6 routes 2/4 request body — every field but `matcher` has a §2.3 DDL default. */
export interface RuleInput {
  name: string;
  matcher: RuleMatcher;
  adapterId: string;
  respondMode?: 'draft-only' | 'auto';
  scheduleId?: string | null;
  outsideWindow?: 'draft-only' | 'queue' | 'ignore';
  allowGroupDrafts?: boolean;
  matchAttachmentOnly?: boolean;
  draftTtlMinutes?: number;
  priority?: number;
  enabled?: boolean;
}

/** §1.6 routes 2/4 response envelope (F-14 `adapterKnown` advisory). */
export interface RuleWriteResult {
  rule: RulePayload;
  adapterKnown: boolean;
}

export interface RuleTestInput {
  text: string | null;
  handle?: string;
  isGroup?: boolean;
  kind?: 'text' | 'tapback' | 'edit' | 'unsend' | 'audio' | 'attachment-only';
}

export interface RuleTestResult {
  matched: boolean;
  detail: { matchedRuleIds: string[] };
}

export interface DryRunRow {
  guid: string;
  handle: string;
  textPreview: string | null;
  matched: boolean;
}

export interface DryRunResult {
  total: number;
  matched: number;
  rows: DryRunRow[];
}

/** One §2.3 `audit_log` row, transport-shaped (route 8). */
export interface AuditRowPayload {
  seq: number;
  at: string;
  eventJson: string;
  actorJson: string;
  prevHash: string;
  hash: string;
}

export interface AuditListParams {
  /** ISO-8601, inclusive lower bound (F-19 `sinceAt`). */
  since?: string;
  /** Exact audit-event type filter. */
  event?: string;
  limit?: number;
}

/** Route 9 response — mirrors core's `VerifyChainResult` exactly (F-13). */
export type AuditVerifyResult =
  | { ok: true; length: number }
  | {
      ok: false;
      brokenAtSeq: number;
      reason: 'seq-gap' | 'link-broken' | 'hash-mismatch';
      length: number;
      expectedHash?: string;
      actualHash?: string;
    };

/**
 * s3-execution Scenario 10 DTOs — client-local, mirroring
 * packages/daemon/src/doctor.ts + routes/send.ts + connection.ts verbatim
 * (same "no @wemessage/core dep" convention as every DTO above).
 */
export type ConnectionState =
  'fully-connected' | 'read-only' | 'disconnected' | 'unsupported';

export interface DoctorCheckPayload {
  id: 'os' | 'fda' | 'automation' | 'messages';
  status: 'ok' | 'warn' | 'fail';
  detail?: string;
  remediation?: string;
}

export interface DoctorReportPayload {
  state: ConnectionState;
  checks: DoctorCheckPayload[];
  probedAt: string;
}

export interface SendInput {
  /** Bare handle, e.g. "+15551234567" — the client builds the chatGuid. */
  to: string;
  body: string;
}

export type SendResult =
  | { draftId: string; outcome: 'sent'; sentMessageGuid: string }
  | {
      draftId: string;
      outcome: 'failed';
      error: { code: string; message: string };
    };

export interface DisconnectInput {
  purge?: boolean;
}

export type DisconnectStepId =
  | 'watcher-stop'
  | 'state'
  | 'adapter-tokens'
  | 'token-rotation'
  | 'launchd'
  | 'purge';

export interface DisconnectStepPayload {
  id: DisconnectStepId;
  status: 'done' | 'skipped' | 'failed';
  detail?: string;
}

export interface DisconnectReportPayload {
  state: 'disconnected';
  steps: DisconnectStepPayload[];
  manualRevocation: readonly string[];
}

export interface WeMessageClient {
  health(): Promise<{ status: string }>;
  status(): Promise<StatusPayload>;
  /** Resolves once the WS is open; rejects on auth/unreachable. */
  events(
    onEvent: (event: GatewayEventPayload) => void,
  ): Promise<EventSubscription>;

  // §1.6 routes 1-7 (S2 Scenario 11)
  listRules(): Promise<RulePayload[]>;
  getRule(id: string): Promise<RulePayload>;
  createRule(input: RuleInput): Promise<RuleWriteResult>;
  updateRule(id: string, patch: Partial<RuleInput>): Promise<RuleWriteResult>;
  deleteRule(id: string): Promise<{ deleted: string }>;
  testRule(id: string, input: RuleTestInput): Promise<RuleTestResult>;
  dryRunRule(id: string, limit?: number): Promise<DryRunResult>;

  // §1.6 routes 8-9 (S2 Scenario 11)
  listAudit(params?: AuditListParams): Promise<AuditRowPayload[]>;
  verifyAudit(): Promise<AuditVerifyResult>;

  // s3-execution Scenario 10
  doctor(): Promise<DoctorReportPayload>;
  send(input: SendInput): Promise<SendResult>;
  connect(): Promise<DoctorReportPayload>;
  disconnect(input?: DisconnectInput): Promise<DisconnectReportPayload>;
}

export function createClient(options: ClientOptions): WeMessageClient {
  // Shared transport for every REST verb (§2.5 "zero business logic
  // duplicated"): identical auth-error mapping regardless of method, a
  // JSON body when one is given, and 204 (route 5 delete) resolving to
  // `undefined` rather than an empty-body JSON.parse crash.
  const request = async (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<unknown> => {
    let res: Response;
    try {
      res = await fetch(`${options.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${options.token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (cause) {
      throw new DaemonUnreachableError(options.baseUrl, cause);
    }
    if (res.status === 401 || res.status === 503) {
      throw new DaemonAuthError(res.status);
    }
    if (res.status === 403) {
      // Every 403 the daemon produces today is gate-denial (POST /v1/send's
      // ONE HTTP-level refusal) — but fall back to the pre-existing
      // DaemonAuthError mapping defensively if the body doesn't match that
      // exact shape, rather than assuming.
      const text = await res.text();
      let parsed: { error?: unknown; reason?: unknown } | null = null;
      try {
        parsed = JSON.parse(text) as { error?: unknown; reason?: unknown };
      } catch {
        parsed = null;
      }
      if (
        parsed?.error === 'gate-denied' &&
        typeof parsed.reason === 'string'
      ) {
        throw new DaemonGateDeniedError(parsed.reason as GateDenyReason);
      }
      throw new DaemonAuthError(res.status);
    }
    if (!res.ok) {
      throw new DaemonRequestError(res.status, await res.text());
    }
    if (res.status === 204) return undefined;
    return res.json();
  };

  const get = (path: string): Promise<unknown> => request('GET', path);
  const post = (path: string, body?: unknown): Promise<unknown> =>
    request('POST', path, body);
  const patch = (path: string, body?: unknown): Promise<unknown> =>
    request('PATCH', path, body);
  const del = (path: string): Promise<unknown> => request('DELETE', path);

  const rulePath = (id: string): string =>
    `/v1/rules/${encodeURIComponent(id)}`;

  return {
    health: () => get('/v1/health') as Promise<{ status: string }>,
    status: () => get('/v1/status') as Promise<StatusPayload>,

    listRules: () => get('/v1/rules') as Promise<RulePayload[]>,
    getRule: (id) => get(rulePath(id)) as Promise<RulePayload>,
    createRule: (input) => post('/v1/rules', input) as Promise<RuleWriteResult>,
    updateRule: (id, patchBody) =>
      patch(rulePath(id), patchBody) as Promise<RuleWriteResult>,
    deleteRule: async (id) => {
      await del(rulePath(id));
      return { deleted: id };
    },
    testRule: (id, input) =>
      post(`${rulePath(id)}/test`, input) as Promise<RuleTestResult>,
    dryRunRule: (id, limit) => {
      const qs =
        limit !== undefined
          ? `?limit=${encodeURIComponent(String(limit))}`
          : '';
      return get(`${rulePath(id)}/dry-run${qs}`) as Promise<DryRunResult>;
    },

    listAudit: (params) => {
      const qs = new URLSearchParams();
      if (params?.since !== undefined) qs.set('since', params.since);
      if (params?.event !== undefined) qs.set('event', params.event);
      if (params?.limit !== undefined) qs.set('limit', String(params.limit));
      const suffix = qs.toString();
      return get(
        `/v1/audit${suffix.length > 0 ? `?${suffix}` : ''}`,
      ) as Promise<AuditRowPayload[]>;
    },
    verifyAudit: () => get('/v1/audit/verify') as Promise<AuditVerifyResult>,

    doctor: () => get('/v1/doctor') as Promise<DoctorReportPayload>,
    send: (input) =>
      post('/v1/send', {
        chatGuid: `iMessage;-;${input.to}`,
        body: input.body,
      }) as Promise<SendResult>,
    connect: () => post('/v1/connect') as Promise<DoctorReportPayload>,
    disconnect: (input) =>
      post('/v1/disconnect', {
        purge: input?.purge ?? false,
      }) as Promise<DisconnectReportPayload>,

    events(onEvent) {
      const wsUrl = `${options.baseUrl.replace(/^http/, 'ws')}/v1/events`;
      return new Promise<EventSubscription>((resolve, reject) => {
        const ws = new WebSocket(wsUrl, {
          headers: { authorization: `Bearer ${options.token}` },
        });
        let settled = false;
        ws.on('open', () => {
          settled = true;
          resolve({ close: () => ws.close() });
        });
        ws.on('message', (data) => {
          const text = Array.isArray(data)
            ? Buffer.concat(data).toString('utf8')
            : Buffer.isBuffer(data)
              ? data.toString('utf8')
              : Buffer.from(new Uint8Array(data)).toString('utf8');
          onEvent(JSON.parse(text) as GatewayEventPayload);
        });
        ws.on('error', (err) => {
          if (!settled) {
            settled = true;
            reject(
              /401|403/.test(err.message)
                ? new DaemonAuthError(401)
                : new DaemonUnreachableError(options.baseUrl, err),
            );
          }
        });
        ws.on('close', () => {
          if (!settled) {
            settled = true;
            reject(new DaemonUnreachableError(options.baseUrl));
          }
        });
      });
    },
  };
}
