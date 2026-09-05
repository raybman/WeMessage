/**
 * s7-execution Scenario 4 — `GET /v1/settings` and `PATCH /v1/settings`.
 *
 * The whole design lives in `../settings/schema.ts`; this file is the thin
 * part on purpose. It does four things in one fixed order and nothing else:
 *
 *   1. **Validate the entire body.** Not one key at a time as it writes them:
 *      a body that fails on its second key must leave the first key exactly
 *      as it was. An operator's save is one decision, and half of it applied
 *      is a configuration nobody chose.
 *   2. **Write every accepted key.**
 *   3. **Append every audit row.**
 *   4. **Broadcast every frame.**
 *
 * Steps 3 and 4 are separated for §1.8, and separated ACROSS the whole batch
 * rather than per key: the first frame must not leave until the last row is
 * durable, or a crash mid-batch would have told a connected client about a
 * change no log remembers. The `draft-harness` records the audit log as it
 * stood at each broadcast, which is what makes that ordering testable rather
 * than merely intended.
 *
 * **The audit row is `setting.changed`; the frame is `toggle.changed`.**
 * They are not the same fact and F-85 ratified both halves. Audit
 * `toggle.changed` carries `on: boolean` and structurally cannot say "the
 * per-contact cap went from 1 to 3", so the log needs a variant that carries
 * the before and after values. The WIRE already has a general
 * `toggle.changed {key, value, actor}` whose `value` is unconstrained, and
 * reusing it is what keeps the WS vocabulary at 17 events: this scenario adds
 * a route, not a subscription every existing client would have to learn.
 *
 * **What this route cannot do.** It holds no reference to any send path, no
 * dispatcher, no adapter transport. The only reachable effect of any key in
 * the list is a row in the settings table that some reader consults later,
 * which is why no setting can open a path around `dispatchApproved` (INV-2).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { humanApiActor, type Clock, type Store } from '@wemessage/core';
import type { AuditSink } from '../audit-sink.js';
import { planPatch, readSettings } from '../settings/schema.js';

export interface SettingsRouteDeps {
  store: Store;
  clock: Clock;
  sink: Pick<AuditSink, 'append' | 'broadcast'>;
}

/**
 * An object of keys, and nothing else. `z.record` refuses an array, a string
 * and a number, which is what separates "your body is not a settings patch"
 * from "one of your keys is wrong" — the second answer names a key, and a
 * client that received it for a body with no keys at all would be chasing a
 * key it never sent.
 */
const patchBody = z.record(z.string(), z.unknown());

export function registerSettingsRoutes(
  app: FastifyInstance,
  deps: SettingsRouteDeps,
): void {
  const { store, sink } = deps;
  const actor = humanApiActor();

  // Synchronous: every read in the closed list is a settings-table lookup,
  // so there is nothing here to await and no reason to make a client wait a
  // tick for it.
  app.get('/v1/settings', () => ({ settings: readSettings(store) }));

  app.patch('/v1/settings', async (req, reply) => {
    const parsed = patchBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid-settings',
        detail: { issues: parsed.error.issues },
      });
    }

    const plan = planPatch(store, parsed.data);
    if (!plan.ok) return reply.code(400).send(plan.refusal);

    // An empty `changes` is the ordinary case for a form nobody edited, and
    // it deliberately falls through the next three loops without writing,
    // auditing or broadcasting anything at all.
    for (const change of plan.changes) store.setSetting(change.key, change.raw);
    for (const change of plan.changes) {
      sink.append(
        {
          type: 'setting.changed',
          key: change.key,
          from: change.from,
          to: change.to,
        },
        actor,
      );
    }
    for (const change of plan.changes) {
      sink.broadcast({
        event: 'toggle.changed',
        key: change.key,
        value: change.to,
        actor,
      });
    }

    return reply.send({
      settings: readSettings(store),
      changed: plan.changes.map((c) => c.key),
    });
  });
}
