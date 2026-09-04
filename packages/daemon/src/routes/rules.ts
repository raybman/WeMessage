/**
 * §1.6 routes 1-7: rule CRUD + POST /v1/rules/:id/test (S2 Scenario 7)
 * + GET /v1/rules/:id/dry-run (S2 Scenario 10).
 *
 * Validation contract (§1.6 "zod-validated bodies; errors as
 * { error, detail? }"):
 *  - theme anywhere in the matcher tree → 400 {error:'theme-unavailable-v1'}
 *    (§1.4.1 #6; UI §3 S3 "THEME rules refuse to arm");
 *  - unsafe regex → 400 {error:'unsafe-regex', detail:{reason}} with the
 *    F-11 typed reason exactly as landed in Scenario 2 (safe-regex.ts);
 *  - everything else → 400 {error:'invalid-rule', detail:{code, ...}}.
 *  - F-14: ANY non-empty adapterId is accepted; create/patch responses carry
 *    the advisory `adapterKnown: false` (adapters land S5; registration-time
 *    reconciliation is S5's job).
 *  - scheduleId naming no schedule → 400 {code:'schedule-not-found'}.
 *    C-7 (retired in s6 Scenario 3): this guard used to refuse EVERY non-null
 *    scheduleId, because schedules had no route surface and rules.schedule_id
 *    is a FOREIGN KEY (§2.3) that would have surfaced as an opaque 500. Now
 *    that `/v1/schedules` exists the guard narrows to ids that name nothing —
 *    still a 400 with the same code, still ahead of the FK, but a real
 *    schedule is now attachable.
 *  - outsideWindow:'queue' → 400 {error:'unsupported-outside-window',
 *    detail:{mode:'queue'}} (F-69). The z.enum keeps all three literals so
 *    §3.2 and the client mirror do not narrow: the running system declines
 *    the mode, the type stays honest about the design.
 *
 * Defaults for omitted create fields are the §2.3 rules-DDL defaults —
 * cited, not invented (enabled 1, respond_mode 'draft-only',
 * outside_window 'draft-only', allow_group_drafts 0, match-attachment
 * behavior off, draft_ttl_minutes 240, priority 100).
 *
 * Audit (§1.8): create/update/delete/enable/disable append exactly ONE row
 * with actor {kind:'human', via:'api'}; PATCH audits rule.enabled /
 * rule.disabled when ONLY `enabled` changed, else rule.updated. The test
 * and dry-run routes are read-only: zero audit rows, zero WS events.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { ulid } from 'ulid';
import { z } from 'zod';
import {
  dryRun,
  evaluateRules,
  humanApiActor,
  validateSafeRegex,
  type AuditEvent,
  type Clock,
  type Message,
  type Rule,
  type RuleMatcher,
  type Store,
} from '@wemessage/core';
import type { AuditSink } from '../audit-sink.js';

export interface RuleRouteDeps {
  store: Store;
  clock: Clock;
  sink: AuditSink;
}

// ---------------------------------------------------------------------------
// matcher-tree validation (recursive walk; first failure wins, depth-first)
// ---------------------------------------------------------------------------

type MatcherRejection =
  | { error: 'theme-unavailable-v1' }
  | { error: 'unsafe-regex'; detail: { reason: string } }
  | { error: 'invalid-rule'; detail: Record<string, unknown> };

const keywordLeaf = z.strictObject({
  kind: z.literal('keyword'),
  keywords: z.array(z.string().min(1)).min(1),
  mode: z.enum(['any', 'all']),
  caseSensitive: z.boolean().optional(),
  wholeWord: z.boolean().optional(),
});

const regexLeaf = z.strictObject({
  kind: z.literal('regex'),
  pattern: z.string(),
});

const contactLeaf = z.strictObject({
  kind: z.literal('contact'),
  handles: z.array(z.string().min(1)),
});

const combinatorShape = z.strictObject({
  kind: z.enum(['all-of', 'any-of']),
  matchers: z.array(z.unknown()),
});

function invalid(detail: Record<string, unknown>): MatcherRejection {
  return { error: 'invalid-rule', detail };
}

function validateMatcherTree(node: unknown): MatcherRejection | null {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    return invalid({ code: 'matcher-not-object' });
  }
  const kind = (node as Record<string, unknown>)['kind'];
  switch (kind) {
    case 'theme':
      // §1.4.1 #6: the theme seam is stubbed in v1 — refuse to arm.
      return { error: 'theme-unavailable-v1' };
    case 'keyword': {
      const parsed = keywordLeaf.safeParse(node);
      return parsed.success
        ? null
        : invalid({ code: 'invalid-matcher-shape', kind });
    }
    case 'regex': {
      const parsed = regexLeaf.safeParse(node);
      if (!parsed.success) {
        return invalid({ code: 'invalid-matcher-shape', kind });
      }
      const verdict = validateSafeRegex(parsed.data.pattern);
      return verdict.ok
        ? null
        : { error: 'unsafe-regex', detail: { reason: verdict.reason } };
    }
    case 'contact': {
      const parsed = contactLeaf.safeParse(node);
      return parsed.success
        ? null
        : invalid({ code: 'invalid-matcher-shape', kind });
    }
    case 'all-of':
    case 'any-of': {
      const parsed = combinatorShape.safeParse(node);
      if (!parsed.success) {
        return invalid({ code: 'invalid-matcher-shape', kind });
      }
      if (parsed.data.matchers.length === 0) {
        return invalid({ code: 'empty-combinator', kind });
      }
      for (const child of parsed.data.matchers) {
        const rejection = validateMatcherTree(child);
        if (rejection !== null) return rejection;
      }
      return null;
    }
    default:
      return invalid({ code: 'unknown-matcher-kind', kind });
  }
}

// ---------------------------------------------------------------------------
// body schemas
// ---------------------------------------------------------------------------

const ruleFields = {
  name: z.string().min(1),
  // validated by validateMatcherTree (typed 400s zod cannot express)
  matcher: z.unknown(),
  adapterId: z.string().min(1),
  respondMode: z.enum(['draft-only', 'auto']),
  scheduleId: z.string().min(1).nullable(),
  outsideWindow: z.enum(['draft-only', 'queue', 'ignore']),
  allowGroupDrafts: z.boolean(),
  matchAttachmentOnly: z.boolean(),
  draftTtlMinutes: z.number().int().positive(),
  priority: z.number().int(),
  enabled: z.boolean(),
};

/**
 * F-69: `queue` is defined in §1.4.1 #7 and unsupported in v1. Narrowing the
 * z.enum would be a breaking change to a published type for a feature that is
 * coming, so the refusal lives here instead. The marker rides in `params` so
 * the route can answer with the typed 400 rather than the generic shape
 * error — the issue list is not a contract, this key is.
 */
const UNSUPPORTED_OUTSIDE_WINDOW = 'unsupported-outside-window';

function refuseQueue(
  // `| undefined` explicitly: exactOptionalPropertyTypes makes an optional
  // key and a present-but-undefined key different types, and `.partial()`
  // produces the latter.
  value: { outsideWindow?: Rule['outsideWindow'] | undefined },
  ctx: z.RefinementCtx,
): void {
  if (value.outsideWindow !== 'queue') return;
  ctx.addIssue({
    code: 'custom',
    path: ['outsideWindow'],
    message: "outsideWindow 'queue' is not supported in v1",
    params: { [UNSUPPORTED_OUTSIDE_WINDOW]: value.outsideWindow },
  });
}

/** The rejected mode when refuseQueue fired, else null. */
function unsupportedMode(error: z.ZodError): string | null {
  for (const issue of error.issues) {
    const params = (issue as { params?: Record<string, unknown> }).params;
    const mode = params?.[UNSUPPORTED_OUTSIDE_WINDOW];
    if (typeof mode === 'string') return mode;
  }
  return null;
}

// §2.3 DDL defaults (cited in the header)
const createBody = z
  .strictObject({
    name: ruleFields.name,
    matcher: ruleFields.matcher,
    adapterId: ruleFields.adapterId,
    respondMode: ruleFields.respondMode.default('draft-only'),
    scheduleId: ruleFields.scheduleId.default(null),
    outsideWindow: ruleFields.outsideWindow.default('draft-only'),
    allowGroupDrafts: ruleFields.allowGroupDrafts.default(false),
    matchAttachmentOnly: ruleFields.matchAttachmentOnly.default(false),
    draftTtlMinutes: ruleFields.draftTtlMinutes.default(240),
    priority: ruleFields.priority.default(100),
    enabled: ruleFields.enabled.default(true),
  })
  .superRefine(refuseQueue);

const patchBody = z.strictObject(ruleFields).partial().superRefine(refuseQueue);

const testBody = z.strictObject({
  text: z.union([z.string(), z.null()]),
  handle: z.string().min(1).optional(),
  isGroup: z.boolean().optional(),
  kind: z
    .enum(['text', 'tapback', 'edit', 'unsend', 'audio', 'attachment-only'])
    .optional(),
});

// §1.6 route 7: window default 50, max 500 — 400 above, never silently
// clamped. strictObject: unknown query params are surface too (fail closed).
const dryRunQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sendMatcherRejection(
  reply: FastifyReply,
  rejection: MatcherRejection,
): FastifyReply {
  return reply.code(400).send(rejection);
}

/** F-14: S2 accepts any non-empty adapterId; the registry lands in S5. */
const ADAPTER_KNOWN = false;

function ruleResponse(rule: Rule): { rule: Rule; adapterKnown: boolean } {
  return { rule, adapterKnown: ADAPTER_KNOWN };
}

export function registerRuleRoutes(
  app: FastifyInstance,
  deps: RuleRouteDeps,
): void {
  const { store, clock, sink } = deps;
  const audit = (event: AuditEvent): void => {
    sink.append(event, humanApiActor());
  };

  // §1.6 route 1: list, priority ASC (id ASC tiebreak — store ORDER BY)
  app.get('/v1/rules', () => store.listRules());

  // §1.6 route 2: create — daemon mints id (ulid) + timestamps (Clock)
  app.post('/v1/rules', (req, reply) => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      const mode = unsupportedMode(parsed.error);
      if (mode !== null) {
        return reply
          .code(400)
          .send({ error: 'unsupported-outside-window', detail: { mode } });
      }
      return reply.code(400).send({
        error: 'invalid-rule',
        detail: { code: 'invalid-shape', issues: parsed.error.issues },
      });
    }
    const rejection = validateMatcherTree(parsed.data.matcher);
    if (rejection !== null) return sendMatcherRejection(reply, rejection);
    // C-7 retired (s6 Scenario 3): a real schedule is attachable now; only
    // an id that names nothing is refused, still ahead of the FK.
    if (
      parsed.data.scheduleId !== null &&
      store.getSchedule(parsed.data.scheduleId) === null
    ) {
      return reply.code(400).send({
        error: 'invalid-rule',
        detail: { code: 'schedule-not-found' },
      });
    }
    const now = clock.now();
    const rule: Rule = {
      ...parsed.data,
      matcher: parsed.data.matcher as RuleMatcher,
      id: ulid(),
      createdAt: now,
      updatedAt: now,
    };
    store.insertRule(rule);
    audit({ type: 'rule.created', ruleId: rule.id, rule });
    return reply.code(201).send(ruleResponse(rule));
  });

  // §1.6 route 3: show
  app.get<{ Params: { id: string } }>('/v1/rules/:id', (req, reply) => {
    const rule = store.getRule(req.params.id);
    if (rule === null) return reply.code(404).send({ error: 'not-found' });
    return rule;
  });

  // §1.6 route 4: partial update; bumps updatedAt; audits rule.updated or
  // rule.enabled/rule.disabled when ONLY `enabled` changed (§1.8)
  app.patch<{ Params: { id: string } }>('/v1/rules/:id', (req, reply) => {
    const existing = store.getRule(req.params.id);
    if (existing === null) return reply.code(404).send({ error: 'not-found' });
    const parsed = patchBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      const mode = unsupportedMode(parsed.error);
      if (mode !== null) {
        return reply
          .code(400)
          .send({ error: 'unsupported-outside-window', detail: { mode } });
      }
      return reply.code(400).send({
        error: 'invalid-rule',
        detail: { code: 'invalid-shape', issues: parsed.error.issues },
      });
    }
    // exactOptionalPropertyTypes discipline: drop absent/undefined keys so
    // the spread below cannot clobber concrete Rule fields with undefined.
    const patch = Object.fromEntries(
      Object.entries(parsed.data).filter(([, v]) => v !== undefined),
    ) as Partial<Rule> & { matcher?: unknown };
    if ('matcher' in patch) {
      const rejection = validateMatcherTree(patch.matcher);
      if (rejection !== null) return sendMatcherRejection(reply, rejection);
    }
    // C-7 retired: attach and detach both work; an id naming no schedule
    // does not (same code, narrower guard).
    if (
      patch.scheduleId !== undefined &&
      patch.scheduleId !== null &&
      store.getSchedule(patch.scheduleId) === null
    ) {
      return reply.code(400).send({
        error: 'invalid-rule',
        detail: { code: 'schedule-not-found' },
      });
    }
    const updated: Rule = {
      ...existing,
      ...(patch as Partial<Rule>),
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: clock.now(),
    };
    store.updateRule(updated);
    const changed = (Object.keys(patch) as Array<keyof Rule>).filter(
      (key) => JSON.stringify(existing[key]) !== JSON.stringify(updated[key]),
    );
    if (changed.length === 1 && changed[0] === 'enabled') {
      audit({
        type: updated.enabled ? 'rule.enabled' : 'rule.disabled',
        ruleId: updated.id,
      });
    } else {
      audit({ type: 'rule.updated', ruleId: updated.id, rule: updated });
    }
    return reply.send(ruleResponse(updated));
  });

  // §1.6 route 5: delete
  app.delete<{ Params: { id: string } }>('/v1/rules/:id', (req, reply) => {
    const existing = store.getRule(req.params.id);
    if (existing === null) return reply.code(404).send({ error: 'not-found' });
    store.deleteRule(existing.id);
    audit({ type: 'rule.deleted', ruleId: existing.id });
    return reply.code(204).send();
  });

  // §1.6 route 6: rules test — synthetic Message → verdict. READ-ONLY:
  // zero audit rows, zero WS events (asserted by teeth in the spec).
  app.post<{ Params: { id: string } }>('/v1/rules/:id/test', (req, reply) => {
    const rule = store.getRule(req.params.id);
    if (rule === null) return reply.code(404).send({ error: 'not-found' });
    const parsed = testBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid-test-body',
        detail: { issues: parsed.error.issues },
      });
    }
    const now = clock.now();
    const message: Message = {
      guid: 'rules-test-synthetic',
      sourceRowid: 0,
      chatGuid: 'rules-test;-;synthetic',
      handle: parsed.data.handle ?? 'rules-test@synthetic.local',
      isFromMe: false,
      isGroup: parsed.data.isGroup ?? false,
      service: 'imessage',
      kind: parsed.data.kind ?? 'text',
      text: parsed.data.text,
      attachments: [],
      sentAt: now,
      receivedAt: now,
    };
    // Part 4.3 #2 deferral: drafts do not exist until S4, so the injected
    // edit-re-match predicate is the documented stub.
    const matches = evaluateRules([rule], message, {
      hasDraftForMessage: () => false,
    });
    return {
      matched: matches.length > 0,
      detail: { matchedRuleIds: matches.map((m) => m.id) },
    };
  });

  // §1.6 route 7: dry-run replay (§1.3.2 "Dry run" affordance) — replays
  // the rule over the last N mirrored messages (default 50, max 500), most
  // recent first (store.listRecentInboundMessages, received_at DESC).
  // READ-ONLY like route 6: zero audit rows, zero WS events, mirror/rules/
  // settings untouched (teeth in the spec). Disabled rules are still
  // dry-runnable (editor affordance, UI §3 S3): core dryRun overrides only
  // rule-level `enabled`; message eligibility and matcher semantics stay
  // live-identical (verdict fidelity).
  app.get<{ Params: { id: string } }>('/v1/rules/:id/dry-run', (req, reply) => {
    const rule = store.getRule(req.params.id);
    if (rule === null) return reply.code(404).send({ error: 'not-found' });
    const parsed = dryRunQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid-query',
        detail: { issues: parsed.error.issues },
      });
    }
    return dryRun(rule, store.listRecentInboundMessages(parsed.data.limit));
  });
}
