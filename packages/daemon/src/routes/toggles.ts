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
 *
 * **s6 Scenario 7, the resume path.** The circuit breaker is the second hold
 * an operator can be sitting under, and `wemessage resume --circuit` clears
 * it through an OPTIONAL `circuit` field on this same body rather than a new
 * route. Two reasons, and the second is the real one:
 *
 *  - §1.6 lists no route for this scenario, and the transport-surface ratchet
 *    pins S6's growth numerically to Scenarios 3 and 11. A route here would
 *    be a silent third increment.
 *  - The two holds are INDEPENDENT and one request should be able to say so.
 *    `{on: false}` lifts the switch and leaves an open breaker open, because
 *    they were tripped by different things and one operator action should not
 *    quietly undo a decision the machine made about a broken send path.
 *    `{on: true, circuit: true}` is equally legal and equally meaningful:
 *    "keep everything held, but stop counting the breaker against me."
 *    Neither field implies the other, in either direction.
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
import { closeCircuit } from '../circuit.js';

export interface ToggleRouteDeps {
  store: Store;
  clock: Clock;
  sink: Pick<AuditSink, 'append' | 'broadcast'>;
}

/**
 * `circuit` is optional and absent means "leave it alone", NOT false: a
 * client that has never heard of the breaker must not silently clear it, and
 * `{on: false}` from an old CLI has to keep meaning exactly what it meant.
 */
const toggleBody = z.strictObject({
  on: z.boolean(),
  circuit: z.boolean().optional(),
});

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
    const { on, circuit } = parsed.data;
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

    // Independent of the switch, and after it: an operator clearing both in
    // one request gets the switch flip audited first, which is the order they
    // typed it in. Reported rather than assumed, because "there was nothing
    // to clear" and "I cleared it" are different answers to `resume
    // --circuit` and only one of them means the breaker had tripped.
    const circuitCleared =
      circuit === true ? closeCircuit({ store, clock, sink }, actor) : false;

    return reply.send({
      key: SETTING_KILL_SWITCH,
      on,
      version: store.getSettingVersion(SETTING_KILL_SWITCH),
      cancelled: cancelled.map((d) => d.id),
      circuitCleared,
    });
  });
}
