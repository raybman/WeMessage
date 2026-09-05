/**
 * s7 Scenario 2 (F-83) — the §3.4 event vocabulary as DATA.
 *
 * `GatewayEventPayload` in `./index.ts` remains the source of truth for
 * TypeScript consumers and nothing here replaces it. What this file adds is
 * the same vocabulary in a form a RUNTIME can read: a name list, a per-event
 * key table in the established `FRAME_SPECS` idiom, and a membership guard.
 *
 * Why it has to exist at all: before S7 the only runtime list of event names
 * in this repo lived in `packages/daemon/test/transport-surface.snapshot.ts`,
 * which is a test file that no consumer — not the daemon's own SSE filter,
 * not the doc generator, and certainly not a stranger's adapter — can import.
 * A closed set that only the compiler can see is not a closed set at the
 * boundary where strangers arrive.
 *
 * The two representations are pinned to each other by compile-time assertions
 * at the bottom of this file (`EventSpecsAreExhaustive`), so adding a variant
 * to `GatewayEventPayload` without a row here does not compile, and a row
 * whose keys have drifted from its variant does not compile either. The
 * schemas in `src/schemas/events/` are the third representation, pinned by
 * `test/event-specs.spec.ts` because files on disk are invisible to tsc.
 *
 * Zero runtime dependencies, as ever: this is a frozen list, a plain object
 * and a Set — data, not deps. Splitting the vocabulary out of `index.ts` does
 * give `index.ts` one intra-package VALUE import (`EVENT_PAYLOAD_KEYS`, for
 * the derived `FRAME_SPECS.event.optional`), which the
 * `protocol-zero-runtime-deps` rule read as a §3.3 violation until this
 * scenario gave it the same self-exclusion its sibling rules already carry.
 * The guarantee that rule defends is unchanged: protocol ships nothing
 * external at runtime and reaches `@wemessage/core` type-only.
 */
import type { GatewayEventPayload } from './index.js';

/**
 * Every §3.4 event name, sorted. The order is load-bearing: the daemon's
 * `WS_EVENT_VOCABULARY` snapshot is sorted too and the ratchet asserts the
 * two `deepEqual`, so a re-ordering here would turn a one-line review into a
 * diff-ordering puzzle.
 */
export const GATEWAY_EVENT_NAMES = [
  'adapter.health',
  'arming.changed',
  'connection.state',
  'draft.approved',
  'draft.created',
  'draft.delta',
  // s8 Scenario 2 (F-107): the four owed `draft.*` lifecycle names, in sorted
  // position rather than appended, because the daemon's snapshot is sorted
  // and pinned deepEqual to this array.
  'draft.expired',
  'draft.failed',
  'draft.recalled',
  'draft.redrafted',
  'draft.rejected',
  'draft.requeued',
  'draft.sent',
  'draft.superseded',
  'gate.denied',
  'gateway.disconnected',
  'message.edited',
  'message.received',
  'message.unsent',
  'rule.matched',
  'toggle.changed',
] as const;

export type GatewayEventName = (typeof GATEWAY_EVENT_NAMES)[number];

/**
 * The keys one event variant contributes to an `event` frame's payload,
 * beside the `event` discriminant itself.
 *
 * `optional` means OMITTED, never `undefined`-valued: `exactOptionalPropertyTypes`
 * is on across this repo and JSON drops an undefined value on the wire, so a
 * NULL column round-trips as an absent key. A schema that permitted
 * `{"batchId": null}` would be describing a frame this gateway cannot emit.
 */
export interface EventSpec {
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

/* -------------------------------------------------------------------- *
 * The type-level machinery that keeps the table honest. All erased.
 * -------------------------------------------------------------------- */

/**
 * The union member(s) carrying name `N`. Written with a boxed `[N] extends [E]`
 * rather than the obvious `Extract<GatewayEventPayload, {event: N}>` because
 * three of the variants share one declaration (`draft.approved | draft.rejected
 * | draft.recalled`), and `Extract` would return `never` for all three: their
 * `event` type is a union of three literals, which is not assignable to any
 * one of them.
 */
type VariantOf<N extends GatewayEventName> = GatewayEventPayload extends infer V
  ? V extends { event: infer E }
    ? [N] extends [E]
      ? V
      : never
    : never
  : never;

/**
 * Optionality without naming `undefined`: under `exactOptionalPropertyTypes`
 * an optional property's type does NOT include `undefined`, so the usual
 * `undefined extends T[K]` test reports every key as required. Comparing the
 * one-key `Pick` against its own `Required` asks the question the modifier
 * actually answers.
 */
type RequiredKeysOf<T> = {
  [K in keyof T]-?: Pick<T, K> extends Required<Pick<T, K>> ? K : never;
}[keyof T];

type OptionalKeysOf<T> = {
  [K in keyof T]-?: Pick<T, K> extends Required<Pick<T, K>> ? never : K;
}[keyof T];

type RequiredPayloadKeys<N extends GatewayEventName> = Exclude<
  RequiredKeysOf<VariantOf<N>>,
  'event'
>;

type OptionalPayloadKeys<N extends GatewayEventName> = Exclude<
  OptionalKeysOf<VariantOf<N>>,
  'event'
>;

type EventSpecTable = {
  readonly [N in GatewayEventName]: {
    readonly required: readonly RequiredPayloadKeys<N>[];
    readonly optional: readonly OptionalPayloadKeys<N>[];
  };
};

/**
 * One row per name, keys in declaration order. `satisfies` makes the table
 * exhaustive and makes a mistyped key name a build error; the assertions
 * below make an INCOMPLETE row a build error too, which `satisfies` alone
 * cannot see.
 *
 * `event` is deliberately absent from every row: it is the discriminant, it
 * lives in `FRAME_SPECS.event.required`, and listing it twenty-one times would
 * push it into the derived `optional` union where it does not belong.
 */
export const EVENT_SPECS = {
  'adapter.health': { required: ['adapterId', 'status'], optional: [] },
  'arming.changed': { required: ['armed', 'until', 'reason'], optional: [] },
  'connection.state': { required: ['state'], optional: [] },
  'draft.approved': { required: ['draftId', 'actor'], optional: ['batchId'] },
  'draft.created': { required: ['draft'], optional: [] },
  'draft.delta': {
    required: ['correlation', 'seq', 'textDelta'],
    optional: [],
  },
  // s8 Scenario 2 (F-107). `draftId` first in every one of the four: it is
  // the subject the frame is addressed at, and the link key (where there is
  // one) is the second required member, never the first.
  'draft.expired': { required: ['draftId'], optional: [] },
  'draft.failed': { required: ['draftId', 'error'], optional: [] },
  'draft.recalled': { required: ['draftId', 'actor'], optional: ['batchId'] },
  'draft.redrafted': { required: ['draftId', 'newDraftId'], optional: [] },
  'draft.rejected': { required: ['draftId', 'actor'], optional: ['batchId'] },
  'draft.requeued': { required: ['draftId'], optional: [] },
  'draft.sent': { required: ['draftId', 'sentMessageGuid'], optional: [] },
  'draft.superseded': { required: ['draftId', 'byDraftId'], optional: [] },
  'gate.denied': {
    required: ['reason', 'chatGuid'],
    optional: ['ruleId', 'draftId'],
  },
  'gateway.disconnected': { required: ['reason'], optional: [] },
  'message.edited': { required: ['guid', 'newText'], optional: [] },
  'message.received': { required: ['message'], optional: [] },
  'message.unsent': { required: ['guid'], optional: [] },
  'rule.matched': {
    required: ['guid', 'ruleId', 'adapterId'],
    optional: [],
  },
  'toggle.changed': { required: ['key', 'value', 'actor'], optional: [] },
} as const satisfies EventSpecTable;

/**
 * Every key any variant can contribute, sorted and de-duplicated. This is
 * what `FRAME_SPECS.event.optional` is built from, so the frame-level guard
 * and the per-event schemas cannot drift: widening one widens the other in
 * the same commit or not at all.
 */
export const EVENT_PAYLOAD_KEYS: readonly string[] = [
  ...new Set(
    GATEWAY_EVENT_NAMES.flatMap((name) => [
      ...EVENT_SPECS[name].required,
      ...EVENT_SPECS[name].optional,
    ]),
  ),
].sort();

/**
 * Set membership rather than `Array.includes` or a property lookup: this
 * guard's first caller is an SSE filter reading a query string, and an
 * object-keyed lookup would answer `true` for `constructor` and `toString`.
 */
const NAMES: ReadonlySet<string> = new Set<string>(GATEWAY_EVENT_NAMES);

/** Runtime membership test for a name that arrived from outside. */
export function isGatewayEventName(value: unknown): value is GatewayEventName {
  return typeof value === 'string' && NAMES.has(value);
}

/**
 * Compile witness, erased at build time and exported only so it is not an
 * unused local. Each member is `true` exactly when one direction of the pin
 * holds; `Assert` accepts nothing else, so a divergence is a build error at
 * the point of the divergence rather than a test failure somewhere else.
 *
 *  1. the name list covers `GatewayEventPayload['event']` and adds nothing;
 *  2. every row's `required` is exactly its variant's required keys;
 *  3. every row's `optional` is exactly its variant's optional keys.
 */
type Assert<T extends true> = T;

type SameMembers<A extends readonly string[], B> = [A[number]] extends [B]
  ? [B] extends [A[number]]
    ? true
    : false
  : false;

export type EventSpecsAreExhaustive = [
  Assert<SameMembers<typeof GATEWAY_EVENT_NAMES, GatewayEventPayload['event']>>,
  Assert<
    {
      [N in GatewayEventName]: SameMembers<
        (typeof EVENT_SPECS)[N]['required'],
        RequiredPayloadKeys<N>
      >;
    }[GatewayEventName]
  >,
  Assert<
    {
      [N in GatewayEventName]: SameMembers<
        (typeof EVENT_SPECS)[N]['optional'],
        OptionalPayloadKeys<N>
      >;
    }[GatewayEventName]
  >,
];
