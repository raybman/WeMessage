/**
 * v2 F3 (G-06a): `PUT /v1/threads/:guid/state` and `GET /v1/threads/state`,
 * the daemon's record of Done, Snooze and Mute.
 *
 * Until F3 those acts lived in the app's memory and died at quit, on a second
 * window and on reinstall. They are operator decisions about a conversation,
 * so they are stored where every other operator decision is: here, under the
 * operator bearer, with an audit row and a frame.
 *
 * The write follows `routes/settings.ts` in one fixed order:
 *
 *   1. **Validate the whole body.** A snooze names when it ends; nothing else
 *      does. An `actAt` (only sent by an undo restoring an earlier act) may
 *      not be in the future, or a restore could forge a later act.
 *   2. **Check `ifUpdatedAt`.** Two windows acting on one conversation is a
 *      409 that hands back the record that won, never a silent overwrite.
 *   3. **Write.** A record with no act and no attention is deleted: absence
 *      means the derived default, and the client computes that.
 *   4. **Append** `thread.state-changed {chatGuid, from, to}`.
 *   5. **Broadcast** `thread.state`, only after the row is durable (§1.8).
 *
 * **Reading is never an act** (06.A). Nothing here records that a
 * conversation was seen, and no path in this file says seen, read or mark.
 * An adapter token is not a bearer, so an agent cannot reach either route,
 * and `thread.state` is an operator-transport frame that never rides the
 * adapter socket.
 *
 * **Wake is computed, never stored.** `awake` is `snoozedUntil <= now`,
 * judged against the daemon clock on every read and every frame. There is no
 * timer, no sweep and no write when a snooze ends.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  humanApiActor,
  isSnoozeAwake,
  type Clock,
  type Store,
  type ThreadStateRecord,
} from '@wemessage/core';
import type { AuditSink } from '../audit-sink.js';

export interface ThreadStateRouteDeps {
  store: Pick<Store, 'getThreadState' | 'listThreadStates' | 'putThreadState'>;
  clock: Clock;
  sink: Pick<AuditSink, 'append' | 'broadcast'>;
}

/** A record as the wire carries it: the stored fields plus computed wake. */
export type WireThreadState = ThreadStateRecord & { awake: boolean };

// The same bound `GET /v1/threads/:guid/messages` puts on a guid: the source
// judges a guid, the route only bounds its size.
const stateParams = z.strictObject({ guid: z.string().min(1).max(512) });

const instant = z.iso.datetime({ offset: true });

const putStateBody = z
  .strictObject({
    act: z.enum(['done', 'snoozed', 'muted']).nullable(),
    // Undo restore only: the act's original instant. Must not be in the
    // future (checked against the daemon clock in the handler).
    actAt: instant.optional(),
    snoozedUntil: instant.nullable().optional(),
    // Omitted keeps the current attention; null returns it to the default.
    attention: z.enum(['queue', 'stream', 'muted']).nullable().optional(),
    // Optimistic concurrency. Omitted: no check. Null: "I expect no record".
    ifUpdatedAt: instant.nullable().optional(),
  })
  .refine((b) => (b.act === 'snoozed') === (b.snoozedUntil != null), {
    message: 'snoozedUntil is required for a snooze and refused otherwise',
    path: ['snoozedUntil'],
  });

function refuse(issues: unknown[]) {
  return { error: 'invalid-thread-state', detail: { issues } } as const;
}

export function registerThreadStateRoutes(
  app: FastifyInstance,
  deps: ThreadStateRouteDeps,
): void {
  const { store, clock, sink } = deps;
  const actor = humanApiActor();
  // The daemon clock, read as an instant. Never wall time: a snooze wakes
  // when the clock the rest of the daemon runs on says so.
  const daemonNowMs = (): number => Date.parse(clock.now());

  const toWire = (r: ThreadStateRecord | null): WireThreadState | null =>
    r === null ? null : { ...r, awake: isSnoozeAwake(r, daemonNowMs()) };

  // GET, and fastify's auto-HEAD twin (route ratchet #29).
  app.get('/v1/threads/state', () => ({
    states: store.listThreadStates().map((r) => toWire(r)),
    asOf: clock.now(),
  }));

  app.put('/v1/threads/:guid/state', async (req, reply) => {
    const params = stateParams.safeParse(req.params);
    const parsed = putStateBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      return reply
        .code(400)
        .send(
          refuse([
            ...(params.success ? [] : params.error.issues),
            ...(parsed.success ? [] : parsed.error.issues),
          ]),
        );
    }
    const chatGuid = params.data.guid;
    const body = parsed.data;

    if (body.actAt !== undefined) {
      if (body.act === null) {
        return reply
          .code(400)
          .send(
            refuse([
              { path: ['actAt'], message: 'actAt is refused when act is null' },
            ]),
          );
      }
      if (Date.parse(body.actAt) > daemonNowMs()) {
        return reply
          .code(400)
          .send(
            refuse([
              { path: ['actAt'], message: 'actAt may not be in the future' },
            ]),
          );
      }
    }

    const previous = store.getThreadState(chatGuid);
    if (body.ifUpdatedAt !== undefined) {
      const expected = body.ifUpdatedAt;
      const current = previous?.updatedAt ?? null;
      const same =
        expected === null || current === null
          ? expected === current
          : Date.parse(expected) === Date.parse(current);
      if (!same) {
        return reply
          .code(409)
          .send({ error: 'conflict', detail: { current: toWire(previous) } });
      }
    }

    const actAt =
      body.act === null
        ? null
        : body.actAt !== undefined
          ? new Date(body.actAt).toISOString()
          : clock.now();
    const next = store.putThreadState({
      chatGuid,
      act: body.act,
      actAt,
      snoozedUntil: body.act === 'snoozed' ? (body.snoozedUntil ?? null) : null,
      attention:
        body.attention !== undefined
          ? body.attention
          : (previous?.attention ?? null),
    });

    sink.append(
      { type: 'thread.state-changed', chatGuid, from: previous, to: next },
      actor,
    );
    const state = toWire(next);
    sink.broadcast({ event: 'thread.state', chatGuid, state });
    return reply.send({ state });
  });
}

/**
 * v2 S0 idiom: this module's request schemas, by name, for `contract.ts`'s
 * REQUEST_SCHEMAS and PARAM_SCHEMAS. The same objects the handlers parse
 * with, so the published shape cannot drift from the enforced one.
 */
export const threadStateSchemas = {
  stateParams,
  putStateBody,
} as const;
