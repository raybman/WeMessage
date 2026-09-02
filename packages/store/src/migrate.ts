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
