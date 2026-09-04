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
 *
 * **s6 Scenario 11 adds the other two controls an operator has**, and they
 * are the only two routes this slice mints (§1.6, ratchet update #20):
 *
 *  - `POST /v1/toggles/pause` — the polite hold. It withdraws AUTONOMY and
 *    nothing else: drafts keep being made, they keep collecting, and a human
 *    can still approve and send one. That is the entire reason it exists as
 *    a separate mechanism from the kill switch above, which slams the whole
 *    outbound path shut.
 *  - `POST /v1/toggles/global-mode` — F-77. `send.globalMode` has been READ
 *    by the gate since S1 and written by nobody, so the top rung of §2.4.3's
 *    three-scope ladder has never had a reachable `auto`: an operator could
 *    configure per-rule and per-contact autonomy and still find the daemon
 *    drafting, with no surface to say why. One route, one setting.
 *
 * Both audit the operator's action under the human API actor and then let
 * `sweepArming` say what became of the daemon, which is a different fact:
 * pausing an already-disconnected daemon is a real action that changes no
 * posture at all.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  humanApiActor,
  SETTING_GLOBAL_MODE,
  SETTING_KILL_SWITCH,
  systemActor,
  type Clock,
  type IsoUtc,
  type Store,
} from '@wemessage/core';
import type { AuditSink } from '../audit-sink.js';
import { closeCircuit } from '../circuit.js';
import { armedWindowClose, setPause, sweepArming } from '../arming.js';

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

/**
 * `null` is RESUME, and it is a value rather than a second route because
 * "how long" is the only variable an operator has: `{until: null}` and
 * `{until: '1h'}` are the same decision at two settings. A `DELETE` twin
 * would also have cost the ratchet an extra entry for no new capability.
 */
const pauseBody = z.strictObject({
  until: z.union([z.string(), z.null()]),
});

/**
 * The enum is the §3.2 `RespondMode` union, spelled here because zod needs
 * runtime values. Anything else is refused rather than coerced: a typo'd mode
 * that silently became 'draft-only' would look like the route worked.
 */
const globalModeBody = z.strictObject({
  mode: z.enum(['draft-only', 'auto']),
});

/**
 * The three shorthand deadlines plus a literal instant (F-68).
 *
 * `until-tomorrow` is the next 08:00 in the DAEMON HOST's zone, computed with
 * the platform's own local-time arithmetic and naming no IANA string — the
 * operator's morning is whatever their Mac says it is, and `test/arch.spec.ts`
 * (f) pins the five zone literals any file may name for exactly the reason
 * that a sixth would be a lie about somebody's clock.
 *
 * `rest-of-window` reads the schedule dimension and refuses when there is no
 * window to rest out. Everything else must parse as an instant and must be in
 * the FUTURE: a pause that has already expired is not a pause, and accepting
 * one would leave an operator looking at a daemon they believe is silent.
 */
function resolveDeadline(
  raw: string,
  deps: { store: Store; clock: Clock },
): { ok: true; until: IsoUtc } | { ok: false; code: 'not-armed' | 'invalid' } {
  const now = deps.clock.now();
  const nowMs = Date.parse(now);
  if (raw === '1h') {
    return { ok: true, until: new Date(nowMs + 3_600_000).toISOString() };
  }
  if (raw === 'until-tomorrow') {
    const at = new Date(nowMs);
    at.setHours(8, 0, 0, 0);
    if (at.getTime() <= nowMs) at.setDate(at.getDate() + 1);
    return { ok: true, until: at.toISOString() };
  }
  if (raw === 'rest-of-window') {
    const close = armedWindowClose(deps);
    return close === null
      ? { ok: false, code: 'not-armed' }
      : { ok: true, until: close };
  }
  const atMs = Date.parse(raw);
  if (!Number.isFinite(atMs) || atMs <= nowMs) {
    return { ok: false, code: 'invalid' };
  }
  return { ok: true, until: new Date(atMs).toISOString() };
}

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

  app.post('/v1/toggles/pause', async (req, reply) => {
    const parsed = pauseBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid-pause',
        detail: { issues: parsed.error.issues },
      });
    }
    const raw = parsed.data.until;

    // Resume first, and unconditionally: an operator clearing a hold should
    // never be told their input was malformed.
    if (raw === null) {
      return reply.send({
        key: 'pause',
        until: null,
        armed: setPause({ store, clock, sink }, null),
      });
    }

    const resolved = resolveDeadline(raw, { store, clock });
    if (!resolved.ok) {
      // 409, not 400: `rest-of-window` is a perfectly well-formed request
      // that this daemon's current state cannot satisfy, and telling an
      // operator their word was invalid would send them looking for a typo
      // instead of at their schedule.
      return resolved.code === 'not-armed'
        ? reply.code(409).send({ error: 'not-armed' })
        : reply
            .code(400)
            .send({ error: 'invalid-until', detail: { until: raw } });
    }

    return reply.send({
      key: 'pause',
      until: resolved.until,
      armed: setPause({ store, clock, sink }, resolved.until),
    });
  });

  app.post('/v1/toggles/global-mode', async (req, reply) => {
    const parsed = globalModeBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid-mode',
        detail: { issues: parsed.error.issues },
      });
    }
    const { mode } = parsed.data;
    store.setSetting(SETTING_GLOBAL_MODE, mode);
    sink.append({ type: 'arming.mode-changed', mode }, actor);

    // The mode is deliberately NOT a dimension of `ArmingState`: 'auto' and
    // 'draft-only' are what the daemon may say, not whether it may speak, and
    // the five §1.3.6 dimensions are all holds. It still announces, because
    // an operator who has just handed the machine autonomy is owed the same
    // acknowledgement as one who has just taken it away.
    return reply.send({
      key: SETTING_GLOBAL_MODE,
      mode,
      armed: sweepArming({ store, clock, sink }, { alwaysBroadcast: true }),
    });
  });
}
