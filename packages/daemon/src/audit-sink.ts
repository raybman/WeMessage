/**
 * Audit sink — the daemon's single seam for persisting audit events and
 * fanning payloads out to WS /v1/events clients (S2 Scenario 7 skeleton;
 * Scenario 9 consumes it fully when the match pipeline emits rule.matched).
 *
 * Persistence delegates to the store's hash-chained append-only writer
 * (§1.8/F-13); serialization happens HERE, once, so the stored eventJson /
 * actorJson strings are exactly what gets hashed (hash-what-is-stored).
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

export interface AuditSink {
  /** Append one audit row (hash-chained by the store). */
  append(event: AuditEvent, actor: Actor): AuditAppendResult;
  /** Register an authenticated WS /v1/events client for fan-out. */
  addClient(socket: WebSocket): void;
  /** Broadcast a §3.4 event frame to every open client (Scenario 9). */
  broadcast(payload: GatewayEventPayload): void;
}

export function createAuditSink(deps: {
  store: Store;
  clock: Clock;
}): AuditSink {
  const clients = new Set<WebSocket>();
  return {
    append(event, actor) {
      return deps.store.appendAudit({
        at: deps.clock.now(),
        eventJson: JSON.stringify(event),
        actorJson: JSON.stringify(actor),
      });
    },
    addClient(socket) {
      clients.add(socket);
      socket.on('close', () => clients.delete(socket));
    },
    broadcast(payload) {
      const frame = JSON.stringify(payload);
      for (const socket of clients) {
        if (socket.readyState === socket.OPEN) socket.send(frame);
      }
    },
  };
}
