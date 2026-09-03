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
 *  3. port importers       — scan of packages/[any]/src for SendBackend /
 *     ChatDbReader mentions, compared exactly to PORT_IMPORTER_ALLOWLIST
 *     (INV-2: send capability cannot leak into new call sites silently).
 *
 * Deliberate-update workflow: a surface change lands ONLY together with a
 * reviewed diff to transport-surface.snapshot.ts (see its header).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  EMITTED_WS_EVENTS,
  PORT_IMPORTER_ALLOWLIST,
  ROUTE_TABLE,
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

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

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

/** All .ts production files under packages/<pkg>/src (never dist, never test). */
function productionSourceFiles(): string[] {
  const files: string[] = [];
  const packagesDir = join(REPO_ROOT, 'packages');
  for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const srcDir = join(packagesDir, pkg.name, 'src');
    let entries;
    try {
      entries = readdirSync(srcDir, { recursive: true, withFileTypes: true });
    } catch {
      continue; // package without src/
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      files.push(join(entry.parentPath, entry.name));
    }
  }
  return files.sort();
}

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

  it('SendBackend/ChatDbReader importer set equals the allowlist', () => {
    const mentions: string[] = [];
    for (const file of productionSourceFiles()) {
      const text = readFileSync(file, 'utf8');
      // Substring on purpose (no \b): derived identifiers such as
      // createChatDbReader / ChatDbReaderOptions / IngestChatDbReader are
      // capability usage too, and JS word boundaries would miss them.
      if (/SendBackend|ChatDbReader/.test(text)) {
        mentions.push(relative(REPO_ROOT, file).split(sep).join('/'));
      }
    }
    expect(mentions.sort()).toEqual([...PORT_IMPORTER_ALLOWLIST]);
  });
});
