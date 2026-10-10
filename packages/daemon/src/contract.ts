/**
 * v2 S0: the request half of the public contract.
 *
 * Every zod schema a route parses a body, query or params with, keyed by the
 * route it guards ('METHOD /v1/path', the transport-surface spelling), and
 * rendered as JSON Schema for clients that are not TypeScript. The Swift
 * client (v2 S1) is written against `fixtures/contract/requests/*.json`, which
 * the daemon's contract ratchet regenerates from exactly this module.
 *
 * Nothing here is a copy. Each value is the route module's own schema object,
 * taken from that module's `<noun>Schemas` export, so the published shape and
 * the enforced shape are the same object and cannot drift apart.
 *
 * What JSON Schema cannot carry: `.refine` and `.superRefine` are dropped by
 * `z.toJSONSchema` without a word. The load-bearing ones are recorded as
 * prose in `fixtures/contract/manifest.json` notes instead:
 *  - POST /v1/drafts/bulk takes exactly one of `ids` or `filter`;
 *  - GET /v1/threads/:guid/messages takes at most one of `before` or `until`;
 *  - GET /v1/threads/by-handle/:handle refuses a handle containing `;`;
 *  - rules refuse `outsideWindow: 'queue'` with a typed 400.
 */
import { z } from 'zod';
import { adapterSchemas } from './routes/adapters.js';
import { auditSchemas } from './routes/audit.js';
import { connectionSchemas } from './routes/connection.js';
import { contactSchemas } from './routes/contacts.js';
import { draftSchemas } from './routes/drafts.js';
import { ruleSchemas } from './routes/rules.js';
import { scheduleSchemas } from './routes/schedules.js';
import { sendSchemas } from './routes/send.js';
import { settingsSchemas } from './routes/settings.js';
import { threadSchemas } from './routes/threads.js';
import { toggleSchemas } from './routes/toggles.js';

/** A route key as transport-surface spells it, for a route that takes input. */
export type RequestSchemaKey =
  `${'GET' | 'POST' | 'PATCH' | 'PUT'} /v1/${string}`;

/** Body and query schemas, one per route that parses one. */
export const REQUEST_SCHEMAS = {
  'POST /v1/adapters': adapterSchemas.createBody,
  'PATCH /v1/adapters/:id': adapterSchemas.patchBody,
  'GET /v1/audit': auditSchemas.listQuery,
  'POST /v1/disconnect': connectionSchemas.disconnectBody,
  'PUT /v1/contacts/:handle': contactSchemas.putBody,
  'POST /v1/drafts': draftSchemas.createBody,
  'POST /v1/drafts/:id/approve': draftSchemas.approveBody,
  'POST /v1/drafts/bulk': draftSchemas.bulkBody,
  'POST /v1/drafts/:id/reject': draftSchemas.rejectBody,
  'GET /v1/drafts': draftSchemas.listQuery,
  'POST /v1/rules': ruleSchemas.createBody,
  'PATCH /v1/rules/:id': ruleSchemas.patchBody,
  'POST /v1/rules/:id/test': ruleSchemas.testBody,
  'GET /v1/rules/:id/dry-run': ruleSchemas.dryRunQuery,
  'POST /v1/schedules': scheduleSchemas.createBody,
  'PATCH /v1/schedules/:id': scheduleSchemas.patchBody,
  'POST /v1/send': sendSchemas.sendBody,
  'PATCH /v1/settings': settingsSchemas.patchBody,
  'GET /v1/threads': threadSchemas.listQuery,
  'GET /v1/threads/:guid/messages': threadSchemas.pageQuery,
  'POST /v1/toggles/kill-switch': toggleSchemas.toggleBody,
  'POST /v1/toggles/pause': toggleSchemas.pauseBody,
  'POST /v1/toggles/global-mode': toggleSchemas.globalModeBody,
} as const satisfies Readonly<Record<RequestSchemaKey, z.ZodType>>;

/**
 * Path-parameter schemas. Only two routes validate their params with zod;
 * the rest take a bare string id and answer 404 for one they do not know.
 */
export const PARAM_SCHEMAS = {
  'GET /v1/threads/:guid/messages': threadSchemas.pageParams,
  'GET /v1/threads/by-handle/:handle': threadSchemas.handleParams,
} as const satisfies Readonly<Record<RequestSchemaKey, z.ZodType>>;

const JSON_SCHEMA_OPTS = {
  target: 'draft-2020-12',
  // A transform, a bigint or a custom type throws instead of publishing a
  // schema that says less than the route enforces.
  unrepresentable: 'throw',
  // The client sends the INPUT shape: a `.default()` is an optional key with
  // a `default`, not a required output.
  io: 'input',
} as const;

function render<K extends string>(
  schemas: Readonly<Record<K, z.ZodType>>,
): Readonly<Record<K, unknown>> {
  const out = {} as Record<K, unknown>;
  for (const key of Object.keys(schemas) as K[]) {
    out[key] = z.toJSONSchema(schemas[key], JSON_SCHEMA_OPTS);
  }
  return out;
}

/** REQUEST_SCHEMAS as JSON Schema (draft 2020-12, input shape). */
export function requestJsonSchemas(): Readonly<
  Record<keyof typeof REQUEST_SCHEMAS, unknown>
> {
  return render(REQUEST_SCHEMAS);
}

/** PARAM_SCHEMAS as JSON Schema (draft 2020-12, input shape). */
export function paramJsonSchemas(): Readonly<
  Record<keyof typeof PARAM_SCHEMAS, unknown>
> {
  return render(PARAM_SCHEMAS);
}

/**
 * The one name a route key gets on disk: 'POST /v1/drafts/:id/approve'
 * becomes 'post.v1.drafts.id.approve'. Used by the recorder that writes the
 * files and by the ratchet that reads them, so the two cannot disagree.
 */
export function contractSlug(key: string): string {
  const space = key.indexOf(' ');
  const method = key.slice(0, space).toLowerCase();
  const segments = key
    .slice(space + 1)
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => s.replace(/^:/, ''));
  return [method, ...segments].join('.');
}
