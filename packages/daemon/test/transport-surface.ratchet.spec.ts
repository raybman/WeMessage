/**
 * Scenario 7 (part) — INV-3 transport-surface ratchet (F-17; S1 F-7 lineage).
 * s2-execution Part 2 Scenario 7: "snapshot of the §1.6 route table + WS
 * event vocabulary + SendBackend/ChatDbReader importer allowlist; test fails
 * if the live fastify route table (or importers) drift from the snapshot."
 *
 * Three live sources, three snapshot constants:
 *  1. fastify route table  — `DaemonServer.routes` (onRoute observability),
 *     compared exactly to ROUTE_TABLE (auto-HEAD twins included: they are
 *     reachable surface);
 *  2. WS event literals    — scan of `event: '<value>'` in packages/daemon/src,
 *     compared exactly to EMITTED_WS_EVENTS and required to be a subset of
 *     WS_EVENT_VOCABULARY (the §1.6 allowed set);
 *  3. port importers       — scan of every production src/ tree for
 *     SendBackend / ChatDbReader mentions, compared exactly to
 *     PORT_IMPORTER_ALLOWLIST (INV-2: send capability cannot leak into new
 *     call sites silently). s8 Sc1 moved the walk itself into
 *     `helpers/production-sources.ts` and widened its roots to `apps/*` as
 *     well as `packages/*`, so that the Electron main process — which holds
 *     the token and the one `createClient()` — is inside the scan rather
 *     than structurally invisible to it (F-103). `test/arch.spec.ts` runs
 *     the same walk against a planted offender, which is why it is a shared
 *     module and not a local function.
 *
 * Deliberate-update workflow: a surface change lands ONLY together with a
 * reviewed diff to transport-surface.snapshot.ts (see its header).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore, type SqliteStore } from '@wemessage/store';
import {
  buildServer,
  type DaemonServer,
  type DoctorProbes,
} from '@wemessage/daemon';
import {
  createUnusedChatDbReader,
  createUnusedSendBackend,
} from './helpers/loopback-backend.js';
import {
  portImporters,
  productionSourceFiles,
} from './helpers/production-sources.js';
import { GATEWAY_EVENT_NAMES } from '@wemessage/protocol';
import {
  EMITTED_WS_EVENTS,
  PORT_IMPORTER_ALLOWLIST,
  ROUTE_TABLE,
  UNEMITTED_WS_EVENTS,
  WS_EVENT_VOCABULARY,
} from './transport-surface.snapshot.js';

/**
 * Never touched: this test only asserts `server.routes` (route
 * registration), it never calls GET /v1/doctor, POST /v1/send,
 * POST /v1/connect, or POST /v1/disconnect. Real probes would still be
 * "safe" here, but a loud fake keeps that guarantee honest if the ratchet
 * ever grows a request-level assertion by accident.
 */
const unusedProbes: DoctorProbes = {
  osMajor: () => {
    throw new Error('DoctorProbes must not be called: route-table test only');
  },
  fda: () => {
    throw new Error('DoctorProbes must not be called: route-table test only');
  },
  automation: () => {
    throw new Error('DoctorProbes must not be called: route-table test only');
  },
  messagesRunning: () => {
    throw new Error('DoctorProbes must not be called: route-table test only');
  },
};

const dirs: string[] = [];
const servers: DaemonServer[] = [];
const stores: SqliteStore[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'wemessage-ratchet-'));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  for (const s of servers.splice(0)) await s.app.close();
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('transport-surface ratchet (INV-3, F-17)', () => {
  it('live fastify route table equals the snapshot exactly', async () => {
    // Full production surface: the composed daemon (daemon.ts) always passes
    // `rules` + `send` + `connection` together, so the ratchet must wire all
    // three too — a bare `rules`-only buildServer would only ever see the S1
    // + S2 routes, silently missing S3 Scenario 8's doctor/send routes and
    // Scenario 9's connect/disconnect routes forever (gap noted 2026-09-02:
    // this sub-test previously wired `rules` alone since S2 Scenario 7 and
    // was never widened when Scenario 8 landed, so /v1/doctor and /v1/send
    // were never actually pinned here despite being real reachable surface).
    const dir = tempDir();
    const clock = {
      now: () => new Date(0).toISOString(),
      nowMs: () => 0,
    };
    const store = openStore({ dir, clock });
    stores.push(store);
    const server = await buildServer({
      configDir: dir,
      rules: { store, clock },
      // s4 Scenario 5: the drafts block must be passed here or the ratchet
      // silently under-covers the surface it exists to pin.
      drafts: { store, clock },
      // s5 Scenario 4: same obligation as drafts — the adapter registry is
      // real reachable surface, so the ratchet has to see it.
      adapters: { store, clock },
      send: {
        store,
        reader: createUnusedChatDbReader(),
        backend: createUnusedSendBackend(),
        backendName: 'unused',
        clock,
        delay: () => Promise.resolve(),
        doctorProbes: unusedProbes,
      },
      connection: {
        store,
        clock,
        probes: unusedProbes,
        stopWatcher: () => {
          throw new Error(
            'stopWatcher must not be called: route-table test only',
          );
        },
        closeEventClients: () => {
          throw new Error(
            'closeEventClients must not be called: route-table test only',
          );
        },
        rotateToken: () => {
          throw new Error(
            'rotateToken must not be called: route-table test only',
          );
        },
        purge: () => {
          throw new Error('purge must not be called: route-table test only');
        },
        rearmWatcher: () => {
          throw new Error(
            'rearmWatcher must not be called: route-table test only',
          );
        },
      },
    });
    servers.push(server);
    expect([...server.routes].sort()).toEqual([...ROUTE_TABLE]);
  });

  it('WS event literals in daemon src equal the emitted snapshot', () => {
    const found = new Set<string>();
    for (const file of productionSourceFiles()) {
      if (!file.includes(`${sep}daemon${sep}src${sep}`)) continue;
      const text = readFileSync(file, 'utf8');
      // s4 Scenario 5: require a dotted, namespaced name. Every member of
      // the GatewayEvent union is `noun.verb`, while an unrelated `event:`
      // property can legitimately hold a bare word — the audit shape for
      // `draft.illegal-transition` carries `event: 'approve'`. Matching bare
      // words made this guard report audit fields as wire events.
      for (const match of text.matchAll(
        /event: ['"]([a-z]+(?:\.[a-z]+)+)['"]/g,
      )) {
        found.add(match[1] as string);
      }
    }
    expect([...found].sort()).toEqual([...EMITTED_WS_EVENTS]);
  });

  it('emitted WS events are a subset of the §1.6 allowed vocabulary', () => {
    const allowed = new Set(WS_EVENT_VOCABULARY);
    for (const event of EMITTED_WS_EVENTS) {
      expect(allowed.has(event), `emitted '${event}' not in vocabulary`).toBe(
        true,
      );
    }
  });

  /**
   * s7 Scenario 2 (F-83). Three lists have described the same vocabulary from
   * three places, and until now only two of them were pinned to each other:
   * the snapshot's allowed set, the snapshot's emitted set, and — new here —
   * `GATEWAY_EVENT_NAMES` in `@wemessage/protocol`, which is the first copy a
   * consumer outside this repo can actually import.
   *
   * The protocol list is the machine truth (its rows are tied to the
   * `GatewayEventPayload` type by compile-time assertions in `events.ts`, so
   * a variant cannot be added without a row); the snapshot stays the
   * human-reviewed copy that a surface change has to be argued into. Pinning
   * them deepEqual means neither can move alone.
   *
   * The emitted list was pinned to the same value rather than merely being a
   * subset of it, and this comment said: "A future slice that legitimately
   * wants a name in the vocabulary BEFORE the code that emits it (as
   * `rule.matched` briefly was in S2) has to relax this half of the row
   * deliberately, in this file, with an argument."
   *
   * **s8 Scenario 2 is that slice, and this is that argument.**
   *
   * S8 mints the four `draft.*` lifecycle names that F-39 deferred in S4, S5
   * Scenario 7 re-deferred, and comment #17 below assigned to S8 by name.
   * They are declared in `@wemessage/protocol` one scenario before the daemon
   * constructs them, because a wire-format change and a behaviour change do
   * not belong in one commit — that separation is the whole reason this file
   * exists. So for exactly one scenario the vocabulary is wider than what the
   * daemon emits.
   *
   * The wrong way to absorb that is to weaken this row to a subset check.
   * `EMITTED ⊆ VOCABULARY` already holds above and always will; it can never
   * catch a name that was declared and then quietly forgotten, which is the
   * precise failure this gap creates. Nor can it be hidden by counting: a
   * length pair drifts silently the moment two mistakes cancel.
   *
   * So the gap is ENUMERATED instead. `UNEMITTED_WS_EVENTS` names the debt,
   * and the row below asserts a PARTITION: emitted and unemitted are
   * disjoint, and together they are exactly the protocol vocabulary. Both
   * halves of the invariant survive — a name cannot be emitted without being
   * declared (it would be in neither list), and a name cannot be declared and
   * silently never emitted (it would have to be written into the unemitted
   * list, by hand, in this reviewed file, under a numbered ratchet comment).
   *
   * It is also self-closing, which is what makes it a debt rather than a
   * loophole. The `event: '<name>'` scan two rows above is structural: when
   * Sc 3 wires the four emit sites, EMITTED must grow to 21 in the same diff,
   * and disjointness then forces UNEMITTED to empty in that same diff or this
   * row fails. There is no state in which Sc 3 lands and the escape hatch
   * survives.
   *
   * **s8 Scenario 3 is that landing, and deliberate update #24 is the close.**
   * All four sites are wired, EMITTED is 21, and `UNEMITTED_WS_EVENTS` is
   * `[]`. The window was one scenario wide, as argued, and it shut on
   * schedule.
   *
   * The partition row below survives the closing, restated so that it still
   * BITES at zero. That restatement is the whole of the work here, because
   * the obvious way to write a partition is the way that goes quiet when one
   * side empties: `for (const owed of UNEMITTED) expect(!emitted.has(owed))`
   * iterates nothing over an empty array and passes on a repo where every
   * other assertion has been deleted. So the row no longer iterates either
   * LIST. It iterates the VOCABULARY and classifies each of the 21 names,
   * requiring exactly one home for every one of them:
   *
   *   - a name in both lists is a contradiction (the old disjointness half);
   *   - a name in NEITHER list is a name that is declared, unemitted, and
   *     unaccounted for — which is precisely the failure the debt list was
   *     invented to catch, and which is the half that does the work now that
   *     the debt is zero. With UNEMITTED empty this clause reads "all 21
   *     declared names are emitted", and it is 21 real assertions, not none.
   *
   * The duplicate check is the third leg. Without it the sorted-union
   * equality could be satisfied by a list that repeats one name and omits
   * another, and the classification above would not notice: both names would
   * still have a home.
   */
  it('protocol vocabulary and allowed snapshot agree exactly', () => {
    expect([...GATEWAY_EVENT_NAMES]).toHaveLength(21);
    expect([...WS_EVENT_VOCABULARY]).toEqual([...GATEWAY_EVENT_NAMES]);
  });

  it('emitted and unemitted partition the vocabulary, with the gap named', () => {
    // The debt, spelled out — and #24's whole claim is that it is nil.
    expect([...UNEMITTED_WS_EVENTS]).toEqual([]);

    const emitted = new Set<string>(EMITTED_WS_EVENTS);
    const owed = new Set<string>(UNEMITTED_WS_EVENTS);

    // No list may say the same name twice: a repeat could pay for an
    // omission in the union check below and leave both halves looking sound.
    expect(emitted.size, 'EMITTED_WS_EVENTS repeats a name').toBe(
      EMITTED_WS_EVENTS.length,
    );
    expect(owed.size, 'UNEMITTED_WS_EVENTS repeats a name').toBe(
      UNEMITTED_WS_EVENTS.length,
    );

    // Exactly one home per declared name. Driven off the VOCABULARY, not off
    // either list, so the row keeps asserting 21 things when the debt is
    // empty instead of degenerating into a loop over nothing.
    const inBoth = [...GATEWAY_EVENT_NAMES].filter(
      (name) => emitted.has(name) && owed.has(name),
    );
    expect(inBoth, 'listed as owed AND emitted').toEqual([]);
    const homeless = [...GATEWAY_EVENT_NAMES].filter(
      (name) => !emitted.has(name) && !owed.has(name),
    );
    expect(
      homeless,
      'declared, not emitted, and not written down as owed',
    ).toEqual([]);

    // Exhaustive: together they are the vocabulary, name for name. This is
    // the half a subset check cannot do.
    expect([...EMITTED_WS_EVENTS, ...UNEMITTED_WS_EVENTS].sort()).toEqual([
      ...GATEWAY_EVENT_NAMES,
    ]);

    // And the arithmetic, stated so a reader of a failure sees the shape of
    // the drift rather than a 21-element diff.
    expect(EMITTED_WS_EVENTS).toHaveLength(21);
    expect(UNEMITTED_WS_EVENTS).toHaveLength(0);
  });

  it('SendBackend/ChatDbReader importer set equals the allowlist', () => {
    // The predicate lives in helpers/production-sources.ts since s8 Sc1, so
    // that the arch suite can prove this row bites by planting an offender
    // under apps/desktop/src and running THIS scan rather than a copy of it.
    expect(portImporters()).toEqual([...PORT_IMPORTER_ALLOWLIST]);
  });
});
