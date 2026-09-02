/**
 * Worker-thread appender for the s2 Scenario 6 concurrency-shape row:
 * two of these hammer `appendAudit` on the same DB file in parallel; the
 * parent then proves the chain has gapless seq and verifies green
 * (transaction proof — read-last + insert are one immediate transaction).
 *
 * Imports the built dist directly (same resolution the specs use via the
 * package export; workers resolve from this file's location).
 */
import { parentPort, workerData } from 'node:worker_threads';
import { openStore } from '../../dist/index.js';

const { dir, count, label } = workerData;
const clock = {
  now: () => '2026-09-01T12:00:00.000Z',
  nowMs: () => 0,
};

const store = openStore({ dir, clock });
try {
  for (let i = 0; i < count; i += 1) {
    store.appendAudit({
      at: '2026-09-01T12:00:00.000Z',
      eventJson: JSON.stringify({
        type: 'rule.created',
        ruleId: `${label}-${i}`,
      }),
      actorJson: '{"kind":"human","via":"api"}',
    });
  }
  parentPort.postMessage({ ok: true });
} catch (err) {
  parentPort.postMessage({ ok: false, error: String(err) });
} finally {
  store.close();
}
