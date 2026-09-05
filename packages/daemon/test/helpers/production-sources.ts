/**
 * The production-source walk the transport-surface ratchet scans, and the
 * port-importer predicate built on it.
 *
 * Extracted from `transport-surface.ratchet.spec.ts` by s8 Sc1 for two
 * reasons, one of which is the whole point of the row:
 *
 *  - **Roots.** The walk covered `packages/<pkg>/src` and nothing else, which
 *    was complete for as long as every line of production TypeScript lived
 *    under `packages/`. S8 adds `apps/desktop/src`, an Electron main process
 *    that holds the bearer token and the one `createClient()`. A capability
 *    scan that structurally cannot see the GUI is a scan that would have
 *    reported "clean" on the day the GUI imported `SendBackend` (F-103).
 *  - **Two consumers.** `test/arch.spec.ts` has to be able to plant a
 *    `SendBackend` import under `apps/desktop/src` and show that the ratchet's
 *    allowlist row catches it. It can only do that honestly by running the
 *    ratchet's OWN scan, not a second copy that agrees with it today.
 *
 * `.tsx` joins `.ts` here: the renderer is TSX (F-100), and an extension
 * filter that omits it would be exactly the blind spot the roots widening
 * exists to close.
 */
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

/**
 * Directories whose `<child>/src` trees are production code.
 *
 * Pinned rather than derived: this list is read by an arch row that asserts
 * `apps` is in it, so a slice that drops a root has to argue with a test.
 */
export const PRODUCTION_SOURCE_ROOTS: readonly string[] = ['packages', 'apps'];

/** All .ts/.tsx production files under `<root>/<pkg>/src` (never dist, never test). */
export function productionSourceFiles(): string[] {
  const files: string[] = [];
  for (const root of PRODUCTION_SOURCE_ROOTS) {
    const rootDir = join(REPO_ROOT, root);
    let packages;
    try {
      packages = readdirSync(rootDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const pkg of packages) {
      if (!pkg.isDirectory()) continue;
      const srcDir = join(rootDir, pkg.name, 'src');
      let entries;
      try {
        entries = readdirSync(srcDir, { recursive: true, withFileTypes: true });
      } catch {
        continue; // package without src/
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx'))
          continue;
        files.push(join(entry.parentPath, entry.name));
      }
    }
  }
  return files.sort();
}

/**
 * Repo-relative paths of every production file that names a send capability.
 *
 * Substring on purpose (no `\b`): derived identifiers such as
 * `createChatDbReader` / `ChatDbReaderOptions` / `IngestChatDbReader` are
 * capability usage too, and JS word boundaries would miss them.
 */
export function portImporters(): string[] {
  const mentions: string[] = [];
  for (const file of productionSourceFiles()) {
    if (/SendBackend|ChatDbReader/.test(readFileSync(file, 'utf8')))
      mentions.push(relative(REPO_ROOT, file).split(sep).join('/'));
  }
  return mentions.sort();
}
