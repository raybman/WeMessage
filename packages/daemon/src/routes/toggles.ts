/**
 * §1.3.5 kill switch (s4-execution Scenario 9). The one control an operator
 * reaches for when something is going wrong, so it is deliberately the
 * dullest code in the daemon: one setting, one transaction, no queues.
 *
 * Two properties define it and both are load-bearing:
 *
 *  - **Synchronous.** The flip cancels every in-grace draft BEFORE the 200
 *    is written. If the cancels were deferred to the next tick, "the switch
 *    is on" and "nothing more will go out" would be two different moments,
 *    and the gap is exactly when an operator is watching the screen deciding
 *    whether it worked.
 *  - **§1.8 append-before-broadcast.** Every cancelled draft's audit row is
 *    written before its courtesy frame. A dropped socket loses the notice,
 *    never the record of what was stopped.
 *
 * Cancelling only touches drafts still INSIDE their grace window. A draft
 * already handed to the dispatcher is stopped by the gate re-read under the
 * send mutex (§1.3.5, Scenario 4), not here — two mechanisms for two
 * different moments, and the seam between them is why Scenario 9 asserts a
 * disjunction rather than a single outcome for a draft racing the flip.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  humanApiActor,
  SETTING_KILL_SWITCH,
  systemActor,
  type Clock,
  type Store,
} from '@wemessage/core';
import type { AuditSink } from '../audit-sink.js';

export interface ToggleRouteDeps {
  store: Store;
  clock: Clock;
  sink: Pick<AuditSink, 'append' | 'broadcast'>;
}

const toggleBody = z.strictObject({ on: z.boolean() });

export function registerToggleRoutes(
  app: FastifyInstance,
  deps: ToggleRouteDeps,
): void {
  const { store, clock, sink } = deps;
  const actor = humanApiActor();

  app.post('/v1/toggles/kill-switch', async (req, reply) => {
    const parsed = toggleBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid-toggle',
        detail: { issues: parsed.error.issues },
      });
    }
    const { on } = parsed.data;
    store.setSetting(SETTING_KILL_SWITCH, on ? '1' : '0');
    sink.append(
      { type: 'toggle.changed', key: SETTING_KILL_SWITCH, on },
      actor,
    );
    sink.broadcast({
      event: 'toggle.changed',
      key: SETTING_KILL_SWITCH,
      value: on,
      actor,
    });

    // Turning the switch OFF cancels nothing: drafts stopped by the switch
    // stay stopped. Resume means "new work may flow again", not "replay
    // whatever I just halted" — reviving them would send messages the
    // operator explicitly killed, at a moment they may no longer be true.
    const cancelled = on
      ? store.cancelGraceApproved(clock.now(), {
          code: 'gate-denied',
          message: 'gate denied: kill-switch',
          at: clock.now(),
        })
      : [];

    const killActor = systemActor('kill-switch');
    for (const draft of cancelled) {
      sink.append({ type: 'draft.rejected', draftId: draft.id }, killActor);
      sink.broadcast({
        event: 'draft.rejected',
        draftId: draft.id,
        actor: killActor,
      });
    }

    return reply.send({
      key: SETTING_KILL_SWITCH,
      on,
      version: store.getSettingVersion(SETTING_KILL_SWITCH),
      cancelled: cancelled.map((d) => d.id),
    });
  });
}
