import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';

/**
 * Migrations live at the package root (sibling to both `src/` and `dist/`) so the
 * same relative resolution works whether we run compiled `dist/` or transpiled
 * `src/` under vitest.
 */
const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));

interface MigrationRow {
  id: string;
}

/**
 * s9: this store was written by a build newer than the one opening it.
 *
 * A separate class rather than a bare Error because the daemon maps it to a
 * named refusal code, and because the ids are the only thing that tells an
 * operator WHICH build to go back to.
 */
export class SchemaNewerThanBuildError extends Error {
  readonly unknownMigrations: readonly string[];

  constructor(unknown: readonly string[]) {
    super(
      `store was written by a newer build: it has applied ${unknown.join(', ')}, which this build does not ship`,
    );
    this.name = 'SchemaNewerThanBuildError';
    this.unknownMigrations = [...unknown];
  }
}

/**
 * Idempotent forward-only migration runner. Applies every unapplied `*.sql` file in
 * lexical order, each inside its own transaction, and records it in `_migrations`.
 * Re-running is a no-op (Scenario 3: "re-opening is idempotent").
 */
export function applyMigrations(
  db: BetterSqlite3.Database,
  nowIso: string,
): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);',
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const appliedRows = db
    .prepare('SELECT id FROM _migrations')
    .all() as MigrationRow[];
  const applied = new Set(appliedRows.map((r) => r.id));

  // s9: forward-only cuts both ways. The loop below applies what this build
  // ships and never looks at what it does not, so a store carrying a
  // migration from a future build used to open silently: everything shipped
  // is already applied, the loop is a no-op, and this build then serves a
  // schema it does not understand. Checked BEFORE anything runs, so the
  // database on the refusing path is exactly the database we were handed.
  const shipped = new Set(files);
  const unknown = [...applied].filter((id) => !shipped.has(id)).sort();
  if (unknown.length > 0) throw new SchemaNewerThanBuildError(unknown);

  const record = db.prepare(
    'INSERT INTO _migrations (id, applied_at) VALUES (?, ?)',
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const runOne = db.transaction(() => {
      db.exec(sql);
      record.run(file, nowIso);
    });
    runOne();
  }
}
