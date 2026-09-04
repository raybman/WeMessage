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
    /**
     * s6 Sc12: the raw body, KEPT rather than only interpolated into the
     * message. Several of the daemon's 400s are typed and actionable —
     * `{error:'invalid-timezone'}` is the one that drove this — and a CLI
     * that has to regex its own error string to say "that zone does not
     * exist" is one refactor away from saying nothing useful at all.
     */
    readonly body: string,
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
  /**
   * s6 Scenario 11: both were F-5 placeholders that only ever carried `null`,
   * and both now carry the truth wherever the daemon has a store to derive it
   * from. `| null` stays because a server built without one still has nothing
   * to report, and reporting `armed: false` there would name a hold that does
   * not exist.
   *
   * The reason union is spelled out rather than imported: @wemessage/client
   * has no @wemessage/core dependency, so every §3.2 shape in this file is a
   * redeclaration (the `RulePayload` precedent below). Rendering it is Sc 12's
   * work; carrying it honestly is this slice's.
   */
  killSwitch: boolean | null;
  armed: ArmingStatePayload | null;
}

/**
 * §1.3.6 `ArmingReason` — the five holds, plus the two connection states
 * that are holds by another name, plus `armed` itself. Exactly one wins;
 * the precedence order lives in the daemon (arming.ts) and is not
 * reconstructed here.
 */
export type ArmingReason =
  | 'disconnected'
  | 'read-only'
  | 'unsupported'
  | 'kill-switch'
  | 'paused'
  | 'outside-window'
  | 'circuit-open'
  | 'armed';

/**
 * §1.3.6 `ArmingState`. `until` is the earliest REAL horizon among the pause
 * deadline, the window close and the breaker expiry — it is not the winning
 * reason's own clock, so a renderer must not describe it as one.
 */
export interface ArmingStatePayload {
  armed: boolean;
  until: string | null;
  reason: ArmingReason;
}

/**
 * s6 Sc12 schedule DTOs — client-local, same "no @wemessage/core dep"
 * convention as every DTO in this file; mirrors `Schedule` /
 * `ScheduleWindow` in packages/core/src/domain/types.ts.
 *
 * `end < start` is a MIDNIGHT-WRAPPING window, not an error: it is one
 * window that crosses a day boundary, and the daemon stores it exactly as
 * given. Anything that renders it as two is inventing a boundary.
 */
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface ScheduleWindowPayload {
  days: Weekday[];
  /** `HH:MM`, 24-hour, in the schedule's own zone. */
  start: string;
  end: string;
}

export interface SchedulePayload {
  id: string;
  name: string;
  /** IANA zone name; the daemon is the only thing that can validate it. */
  timezone: string;
  windows: ScheduleWindowPayload[];
  enabled: boolean;
}

export interface ScheduleInput {
  name: string;
  timezone: string;
  windows: ScheduleWindowPayload[];
  /** Omitted means the route's own §2.3 DDL default (enabled). */
  enabled?: boolean;
}

export type SchedulePatch = Partial<ScheduleInput>;

/** §2.4.3's top scope: what the daemon MAY say, not whether it may speak. */
export type RespondMode = 'draft-only' | 'auto';

/**
 * `POST /v1/toggles/pause`. `until: null` on the way in is RESUME and on the
 * way out is "there is no deadline any more" — the daemon spells clearing a
 * hold as a value rather than a second route (toggles.ts), and this shape
 * keeps that honest rather than hiding it behind two result types.
 */
export interface PauseResult {
  key: string;
  until: string | null;
  armed: ArmingStatePayload;
}

/** `POST /v1/toggles/global-mode` (F-77). */
export interface GlobalModeResult {
  key: string;
  mode: RespondMode;
  armed: ArmingStatePayload;
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

/**
 * s4 DTOs (Scenario 11) — client-local, same "no @wemessage/core dep"
 * convention as every DTO above.
 */
export type DraftState =
  | 'pending'
  | 'approved'
  | 'sending'
  | 'sent'
  | 'rejected'
  | 'expired'
  | 'superseded'
  | 'recalled'
  | 'failed';

export type ContactMode = 'deny' | 'draft-only' | 'auto';

export interface DraftPayload {
  id: string;
  inboundGuid: string | null;
  chatGuid: string;
  ruleId: string | null;
  adapterId: string;
  idempotencyKey: string;
  body: string;
  originalBody: string;
  state: DraftState;
  stateChangedAt: string;
  sendNotBefore?: string;
  expiresAt: string;
  createdAt: string;
  error?: { code: string; message: string; at: string };
}

export interface DraftFilter {
  state?: DraftState;
  ruleId?: string;
  contact?: string;
  batchId?: string;
}

export interface DraftCreateInput {
  chatGuid: string;
  body: string;
  ttlMinutes?: number;
}

export interface ApprovalPayload {
  id: string;
  draftId: string;
  action: 'approve' | 'reject' | 'recall';
  editedBody?: string;
  batchId?: string;
  at: string;
}

export interface DraftDetail {
  draft: DraftPayload;
  approvals: ApprovalPayload[];
}

export interface DraftActionResult {
  draft: DraftPayload;
  approvalId: string;
}

export interface RedraftResult {
  fromDraftId: string;
  draft: DraftPayload;
}

/** Exactly one of `ids` or `filter`, mirroring the route's own refusal. */
export type BulkSelector =
  | { ids: string[] }
  | { filter: { all?: true; rule?: string; contact?: string } };

export interface BulkResult {
  batchId: string;
  matched: number;
  applied: number;
  appliedIds: string[];
  refused: Array<{ id: string; error: string }>;
}

export interface BatchReport {
  batchId: string;
  approved: number;
  sending: number;
  sent: number;
  failed: number;
  recalled: number;
}

export interface KillSwitchResult {
  key: string;
  on: boolean;
  version: number;
  cancelled: string[];
  /**
   * s6 Scenario 7: whether this request actually cleared an OPEN circuit
   * breaker. False when `circuit` was not asked for and false when it was
   * asked for but nothing was tripped, so `resume --circuit` can tell "I
   * released a hold" from "there was no hold" without a second round trip.
   */
  circuitCleared: boolean;
}

export interface ContactPolicyPayload {
  handle: string;
  displayName?: string;
  mode: ContactMode;
  updatedAt: string;
}

/**
 * A 409 from the draft surface. The daemon uses 409 for exactly one class of
 * thing — "the draft is not in a state where you may do that" — and the body
 * carries which state it actually was. Collapsing that into a generic
 * DaemonRequestError would leave a CLI unable to say anything more useful
 * than "request failed", for the most common mistake a user can make.
 */
export class DaemonConflictError extends DaemonRequestError {
  constructor(
    readonly detail: {
      error: string;
      from?: DraftState;
      requested?: string;
      attempts?: number;
      /** s5 Sc11: `adapter-referenced` names the rules still pointing at it. */
      ruleIds?: string[];
      /** s5 Sc11: `adapter-exists` echoes the id that was already taken. */
      id?: string;
    },
  ) {
    super(409, JSON.stringify(detail));
    this.name = 'DaemonConflictError';
  }
}

/**
 * s5 adapter-registry DTOs (Scenario 11) — client-local, same "no
 * @wemessage/core dep" convention as every DTO above; mirrors
 * `AdapterRecord` in packages/core/src/domain/types.ts.
 */
export type AdapterKind =
  'sol' | 'hermes' | 'luna' | 'openclaw' | 'echo' | 'generic';

export type AdapterHealth =
  'unknown' | 'connected' | 'disconnected' | 'unhealthy';

export interface AdapterPayload {
  id: string;
  kind: AdapterKind;
  displayName: string;
  enabled: boolean;
  /**
   * A boolean, deliberately. The daemon mints an adapter token once and
   * never reads it back (routes/adapters.ts): there is no route that returns
   * stored token material, so there is no field here that could carry it.
   */
  hasToken: boolean;
  health: AdapterHealth;
  lastSeenAt?: string;
  config: Record<string, unknown>;
}

export interface AdapterInput {
  id: string;
  kind: AdapterKind;
  displayName: string;
  config?: Record<string, unknown>;
}

export interface AdapterPatch {
  enabled?: boolean;
  displayName?: string;
  config?: Record<string, unknown>;
}

/**
 * The response of the two verbs that mint: create and token-rotate. This is
 * the ONLY shape in this package that carries plaintext token material, and
 * it exists for exactly one round trip — it is shown to the operator once
 * and is not recoverable afterwards, by design. There is deliberately no
 * `getAdapterToken`: losing it means rotating, not reading.
 */
export interface AdapterCredential {
  adapter: AdapterPayload;
  token: string;
  connectCmd: string;
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

  // s4-execution Scenario 11: the draft/contact/kill surface.
  listDrafts(filter?: DraftFilter): Promise<DraftPayload[]>;
  getDraft(id: string): Promise<DraftDetail>;
  createDraft(input: DraftCreateInput): Promise<DraftPayload>;
  approveDraft(
    id: string,
    opts?: { editedBody?: string },
  ): Promise<DraftActionResult>;
  rejectDraft(
    id: string,
    opts?: { reason?: string },
  ): Promise<DraftActionResult>;
  recallDraft(id: string): Promise<DraftActionResult>;
  retryDraft(id: string): Promise<DraftActionResult>;
  redraftDraft(id: string): Promise<RedraftResult>;
  bulkDrafts(
    action: 'approve' | 'recall',
    selector: BulkSelector,
  ): Promise<BulkResult>;
  batchReport(batchId: string): Promise<BatchReport>;
  /**
   * The kill switch, and optionally the circuit breaker with it. The two are
   * independent holds on the same endpoint: omitting `circuit` leaves the
   * breaker exactly as it was, in both directions.
   */
  setKillSwitch(
    on: boolean,
    opts?: { circuit?: boolean },
  ): Promise<KillSwitchResult>;

  /**
   * s6 Sc12 — the S6 operator surface (§1.6 ratchets #19 and #20).
   *
   * Every one of these is EXACTLY ONE HTTP call. That is not an accident of
   * implementation, it is the contract: the CLI and the GUI are thin clients
   * (§2.5) and reach the daemon only through this file, so a composite
   * method here would hand them a verb the HTTP surface does not have and
   * cannot audit. The one composition S6 allows (`wemessage resume`, which
   * clears whichever holds are set) is built in the CLI out of these calls,
   * where its cost is visible.
   */
  listSchedules(): Promise<SchedulePayload[]>;
  getSchedule(id: string): Promise<SchedulePayload>;
  createSchedule(input: ScheduleInput): Promise<SchedulePayload>;
  updateSchedule(id: string, patch: SchedulePatch): Promise<SchedulePayload>;
  deleteSchedule(id: string): Promise<{ deleted: string }>;

  /**
   * The shorthand (`1h`, `until-tomorrow`, `rest-of-window`) travels
   * VERBATIM. Resolving it here would mean guessing at the daemon host's
   * clock and reading its schedule from the wrong side of the wire; the
   * route owns both (toggles.ts `resolveDeadline`).
   */
  pause(until: string): Promise<PauseResult>;
  /** The same route with a null deadline, and a word a human would use. */
  resume(): Promise<PauseResult>;
  setGlobalMode(mode: RespondMode): Promise<GlobalModeResult>;
  listContacts(): Promise<ContactPolicyPayload[]>;
  setContactPolicy(
    handle: string,
    mode: ContactMode,
    opts?: { displayName?: string },
  ): Promise<ContactPolicyPayload>;
  deleteContactPolicy(handle: string): Promise<{ deleted: string }>;

  // s5-execution Scenario 11: the adapter registry (§1.6 adapter routes).
  listAdapters(): Promise<AdapterPayload[]>;
  getAdapter(id: string): Promise<AdapterPayload>;
  createAdapter(input: AdapterInput): Promise<AdapterCredential>;
  updateAdapter(id: string, patch: AdapterPatch): Promise<AdapterPayload>;
  deleteAdapter(id: string): Promise<{ deleted: string }>;
  rotateAdapterToken(id: string): Promise<AdapterCredential>;
}

export function createClient(options: ClientOptions): WeMessageClient {
  // Shared transport for every REST verb (§2.5 "zero business logic
  // duplicated"): identical auth-error mapping regardless of method, a
  // JSON body when one is given, and 204 (route 5 delete) resolving to
  // `undefined` rather than an empty-body JSON.parse crash.
  const request = async (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
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
    if (res.status === 409) {
      // Preserve the shape rather than the string: {from, requested} is what
      // lets a caller say "that draft was already sent" instead of "409".
      const text = await res.text();
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (typeof parsed?.error === 'string') {
          throw new DaemonConflictError(
            parsed as ConstructorParameters<typeof DaemonConflictError>[0],
          );
        }
      } catch (err) {
        if (err instanceof DaemonConflictError) throw err;
      }
      throw new DaemonRequestError(409, text);
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
  const put = (path: string, body?: unknown): Promise<unknown> =>
    request('PUT', path, body);
  const del = (path: string): Promise<unknown> => request('DELETE', path);

  const rulePath = (id: string): string =>
    `/v1/rules/${encodeURIComponent(id)}`;
  const draftPath = (id: string): string =>
    `/v1/drafts/${encodeURIComponent(id)}`;
  const contactPath = (handle: string): string =>
    `/v1/contacts/${encodeURIComponent(handle)}`;
  const adapterPath = (id: string): string =>
    `/v1/adapters/${encodeURIComponent(id)}`;
  // F-76: the CLI noun is `windows`, the resource is `/v1/schedules`. The
  // client speaks the resource, never the noun — the rename lives in exactly
  // one place (the CLI's command name) rather than in two.
  const schedulePath = (id: string): string =>
    `/v1/schedules/${encodeURIComponent(id)}`;

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

    listDrafts: async (filter) => {
      const qs = new URLSearchParams();
      if (filter?.state !== undefined) qs.set('state', filter.state);
      if (filter?.ruleId !== undefined) qs.set('ruleId', filter.ruleId);
      if (filter?.contact !== undefined) qs.set('contact', filter.contact);
      if (filter?.batchId !== undefined) qs.set('batchId', filter.batchId);
      const suffix = qs.toString();
      const res = (await get(
        `/v1/drafts${suffix.length > 0 ? `?${suffix}` : ''}`,
      )) as { drafts: DraftPayload[] };
      return res.drafts;
    },
    getDraft: (id) => get(draftPath(id)) as Promise<DraftDetail>,
    createDraft: async (input) =>
      ((await post('/v1/drafts', input)) as { draft: DraftPayload }).draft,
    approveDraft: (id, opts) =>
      post(`${draftPath(id)}/approve`, {
        ...(opts?.editedBody !== undefined
          ? { editedBody: opts.editedBody }
          : {}),
      }) as Promise<DraftActionResult>,
    rejectDraft: (id, opts) =>
      post(`${draftPath(id)}/reject`, {
        ...(opts?.reason !== undefined ? { reason: opts.reason } : {}),
      }) as Promise<DraftActionResult>,
    recallDraft: (id) =>
      post(`${draftPath(id)}/recall`) as Promise<DraftActionResult>,
    retryDraft: (id) =>
      post(`${draftPath(id)}/retry`) as Promise<DraftActionResult>,
    redraftDraft: (id) =>
      post(`${draftPath(id)}/redraft`) as Promise<RedraftResult>,
    bulkDrafts: (action, selector) =>
      post('/v1/drafts/bulk', { action, ...selector }) as Promise<BulkResult>,
    batchReport: (batchId) =>
      get(`/v1/batches/${encodeURIComponent(batchId)}`) as Promise<BatchReport>,
    listSchedules: () => get('/v1/schedules') as Promise<SchedulePayload[]>,
    getSchedule: (id) => get(schedulePath(id)) as Promise<SchedulePayload>,
    createSchedule: async (input) =>
      (
        (await post('/v1/schedules', {
          name: input.name,
          timezone: input.timezone,
          windows: input.windows,
          // Omitted rather than sent as `undefined`: the route body is a zod
          // strictObject with its own default, and an explicit `undefined`
          // is a different request from an absent key.
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        })) as { schedule: SchedulePayload }
      ).schedule,
    updateSchedule: async (id, patchBody) =>
      (
        (await patch(schedulePath(id), patchBody)) as {
          schedule: SchedulePayload;
        }
      ).schedule,
    deleteSchedule: async (id) => {
      await del(schedulePath(id));
      return { deleted: id };
    },

    pause: (until) =>
      post('/v1/toggles/pause', { until }) as Promise<PauseResult>,
    resume: () =>
      post('/v1/toggles/pause', { until: null }) as Promise<PauseResult>,
    setGlobalMode: (mode) =>
      post('/v1/toggles/global-mode', { mode }) as Promise<GlobalModeResult>,

    setKillSwitch: (on, opts) =>
      post('/v1/toggles/kill-switch', {
        on,
        // Omitted rather than sent as `undefined`: the body is a
        // `strictObject` on the far side and an absent key is the only way to
        // say "do not touch the breaker".
        ...(opts?.circuit !== undefined ? { circuit: opts.circuit } : {}),
      }) as Promise<KillSwitchResult>,
    listContacts: async () =>
      ((await get('/v1/contacts')) as { contacts: ContactPolicyPayload[] })
        .contacts,
    setContactPolicy: async (handle, mode, opts) =>
      (
        (await put(contactPath(handle), {
          mode,
          ...(opts?.displayName !== undefined
            ? { displayName: opts.displayName }
            : {}),
        })) as { contact: ContactPolicyPayload }
      ).contact,
    deleteContactPolicy: (handle) =>
      del(contactPath(handle)) as Promise<{ deleted: string }>,

    listAdapters: async () =>
      ((await get('/v1/adapters')) as { adapters: AdapterPayload[] }).adapters,
    getAdapter: async (id) =>
      ((await get(adapterPath(id))) as { adapter: AdapterPayload }).adapter,
    createAdapter: (input) =>
      post('/v1/adapters', {
        id: input.id,
        kind: input.kind,
        displayName: input.displayName,
        // Omitted, not `undefined`: the route body is a zod strictObject and
        // an explicit `config: undefined` is a different request from none.
        ...(input.config !== undefined ? { config: input.config } : {}),
      }) as Promise<AdapterCredential>,
    updateAdapter: async (id, patchBody) =>
      (
        (await patch(adapterPath(id), patchBody)) as {
          adapter: AdapterPayload;
        }
      ).adapter,
    deleteAdapter: async (id) => {
      await del(adapterPath(id));
      return { deleted: id };
    },
    rotateAdapterToken: (id) =>
      post(`${adapterPath(id)}/token`) as Promise<AdapterCredential>,

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
