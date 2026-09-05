/**
 * Audit sink — the daemon's single seam for persisting audit events and
 * fanning payloads out to the event transports (S2 Scenario 7 skeleton;
 * Scenario 9 consumes it fully when the match pipeline emits rule.matched).
 *
 * Persistence delegates to the store's hash-chained append-only writer
 * (§1.8/F-13); serialization happens HERE, once, so the stored eventJson /
 * actorJson strings are exactly what gets hashed (hash-what-is-stored).
 *
 * s7 Scenario 3 generalised the fan-out from "a set of WebSockets" to a set
 * of SUBSCRIBERS, because there are now two transports and byte-identical
 * delivery across them is a load-bearing promise (§3.4). Three properties
 * make that promise structural rather than a coincidence two code paths
 * currently share:
 *
 *  1. `broadcast` serializes ONCE and hands every subscriber both the
 *     payload and that one string. WS writes the string; SSE wraps the same
 *     string in `data:`. Neither transport can stringify differently from
 *     the other, because neither transport stringifies.
 *  2. The FILTER IS APPLIED HERE, once, in the fan-out loop — not inside a
 *     per-transport wrapper. Push it into the WS wrapper (the natural place
 *     if you start from the WS code) and the two transports immediately
 *     disagree about what a filter means; that is the named teeth mutation
 *     for this scenario, and the parity row catches it.
 *  3. `addClient` is now SUGAR over `subscribe`, not a parallel path. The WS
 *     transport is not an implementation that happens to agree with SSE — it
 *     is a two-line adapter over the same one.
 *
 * Nothing here uses `this`: the test harness builds a wrapped sink by
 * spreading (`{ ...sink, broadcast }`) to witness §1.8 ordering, and a
 * method that reached for `this` would break the moment it were spread.
 */
import type { WebSocket } from 'ws';
import type {
  Actor,
  AuditAppendResult,
  AuditEvent,
  Clock,
  Store,
} from '@wemessage/core';
import type { GatewayEventPayload } from '@wemessage/protocol';
import type { EventFilter } from './events-filter.js';

/**
 * `frame` is the EXACT bytes `broadcast` serialized, passed alongside the
 * payload so a transport never re-derives them. The payload is still handed
 * over because SSE needs `payload.event` for its `event:` field, and reading
 * it back out of the string would be a second parse of something we already
 * have.
 */
export type EventSubscriber = (
  payload: GatewayEventPayload,
  frame: string,
) => void;

export interface AuditSink {
  /** Append one audit row (hash-chained by the store). */
  append(event: AuditEvent, actor: Actor): AuditAppendResult;
  /**
   * Register a fan-out subscriber. `filter` null (or omitted) means every
   * event. Returns its own unsubscribe — the ONLY way to detach, so a
   * transport cannot leak a listener by forgetting which set it joined.
   */
  subscribe(fn: EventSubscriber, filter?: EventFilter): () => void;
  /** Register an authenticated WS /v1/events client for fan-out. */
  addClient(socket: WebSocket, filter?: EventFilter): void;
  /** Live subscriber count — leak detection, and test observability only. */
  subscriberCount(): number;
  /** Broadcast a §3.4 event frame to every subscriber (Scenario 9). */
  broadcast(payload: GatewayEventPayload): void;
}

export function createAuditSink(deps: {
  store: Store;
  clock: Clock;
}): AuditSink {
  const subscribers = new Set<{ fn: EventSubscriber; filter: EventFilter }>();

  const subscribe = (fn: EventSubscriber, filter: EventFilter = null) => {
    const entry = { fn, filter };
    subscribers.add(entry);
    return () => {
      subscribers.delete(entry);
    };
  };

  return {
    append(event, actor) {
      return deps.store.appendAudit({
        at: deps.clock.now(),
        eventJson: JSON.stringify(event),
        actorJson: JSON.stringify(actor),
      });
    },
    subscribe,
    addClient(socket, filter = null) {
      const off = subscribe((_payload, frame) => {
        if (socket.readyState === socket.OPEN) socket.send(frame);
      }, filter);
      socket.on('close', off);
    },
    subscriberCount: () => subscribers.size,
    broadcast(payload) {
      const frame = JSON.stringify(payload);
      // Iterating a copy: a subscriber that unsubscribes itself mid-fan-out
      // (an SSE stream whose socket died on the write) must not perturb the
      // delivery of the same event to everyone after it.
      for (const { fn, filter } of [...subscribers]) {
        if (filter !== null && !filter.has(payload.event)) continue;
        fn(payload, frame);
      }
    },
  };
}
