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
import { buildServer, type DaemonServer } from '@wemessage/daemon';
import {
  EMITTED_WS_EVENTS,
  PORT_IMPORTER_ALLOWLIST,
  ROUTE_TABLE,
  WS_EVENT_VOCABULARY,
} from './transport-surface.snapshot.js';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const dirs: string[] = [];
const servers: DaemonServer[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'wemessage-ratchet-'));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  for (const s of servers.splice(0)) await s.app.close();
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
    const server = await buildServer({ configDir: tempDir() });
    servers.push(server);
    expect([...server.routes].sort()).toEqual([...ROUTE_TABLE]);
  });

  it('WS event literals in daemon src equal the emitted snapshot', () => {
    const found = new Set<string>();
    for (const file of productionSourceFiles()) {
      if (!file.includes(`${sep}daemon${sep}src${sep}`)) continue;
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/event: ['"]([a-z.]+)['"]/g)) {
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
