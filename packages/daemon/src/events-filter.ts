/**
 * s7 Scenario 3 — the `?events=` subscription filter, parsed ONCE for BOTH
 * event transports.
 *
 * This module exists because the filter is a protocol decision, not a
 * transport one. WS and SSE must agree on what `?events=draft.created` means
 * down to the refusal, and the only way two code paths agree forever is for
 * there to be one code path. `server.ts` calls this at WS upgrade;
 * `routes/events-sse.ts` calls it in the GET handler; neither owns a copy.
 *
 * The legal values are `GATEWAY_EVENT_NAMES` from `@wemessage/protocol` —
 * the Scenario 2 vocabulary, which is the same list the reference doc, the
 * JSON schemas and the exhaustiveness witnesses are generated from. A filter
 * that accepted names the vocabulary does not know would be a second, softer
 * definition of "an event", which is exactly what Scenario 2 removed.
 *
 * **An unknown name is an ERROR, never a no-op (C-3).** Silently dropping a
 * token the caller misspelled produces a subscription that looks healthy and
 * delivers nothing — a monitor watching `draft.sent` that typo'd its way into
 * watching nothing will not tell you it stopped watching, and neither will
 * we. So does an EMPTY value: `?events=` is a caller who meant to send a list
 * and sent none, and reading it as "everything" is the loudest possible
 * misinterpretation of the quietest possible bug. Omitting the parameter
 * entirely is the way to say "everything", and it is unambiguous.
 *
 * Nothing is trimmed. `?events=draft.created, draft.sent` refuses at
 * `' draft.sent'` for the same reason: a filter that forgives one kind of
 * whitespace teaches callers it forgives whitespace, and the next surface
 * that does not forgive it becomes the bug report.
 */
import { isGatewayEventName, type GatewayEventName } from '@wemessage/protocol';

/** `null` means "no filter": every event, which is what omitting it says. */
export type EventFilter = ReadonlySet<GatewayEventName> | null;

export type EventFilterResult =
  { ok: true; filter: EventFilter } | { ok: false; name: string };

/**
 * @param raw the `events` query value as fastify hands it over: `undefined`
 *   when absent, a string normally, an array when repeated (`?events=a&events=b`).
 */
export function parseEventFilter(raw: unknown): EventFilterResult {
  if (raw === undefined) return { ok: true, filter: null };
  const values = Array.isArray(raw) ? raw : [raw];
  const names: string[] = [];
  for (const value of values) {
    // A non-string here means someone sent `?events[]=x`, which fastify
    // parses as an object. It is not a list of event names, so it is refused
    // like any other unrecognised value rather than coerced into one.
    if (typeof value !== 'string') return { ok: false, name: String(value) };
    names.push(...value.split(','));
  }
  const filter = new Set<GatewayEventName>();
  for (const name of names) {
    if (!isGatewayEventName(name)) return { ok: false, name };
    filter.add(name);
  }
  return { ok: true, filter };
}

/** WS close reasons are capped at 123 bytes; never echo an unbounded name. */
export function closeReasonFor(name: string): string {
  return `unknown-event: ${name.slice(0, 64)}`;
}
