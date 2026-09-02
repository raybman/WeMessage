// macOS-only typedstream harvest (spec Part 3.2 step 2; NEVER runs in CI).
//
// Opens the live chat.db READ-ONLY (mode=ro&immutable=1, §2.2.1) and extracts
// attributedBody / message_summary_info blobs for messages whose text carries
// the synthetic tag (default GL-FIX), writing them to the .gitignored staging
// dir plus a draft manifest. The binding human review step (Part 3.2 step 3:
// `strings staging/*.bin`, confirm only synthetic content, then git mv) stands
// between this script's output and anything committed.
//
// Usage:
//   pnpm tsx fixtures/harvest/harvest-typedstream.ts \
//     --tag GL-FIX --out fixtures/typedstream/staging/ [--db <path to chat.db>]
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

const tag = arg('tag', 'GL-FIX');
const outDir = arg('out', 'fixtures/typedstream/staging/');
const dbPath = arg('db', join(homedir(), 'Library', 'Messages', 'chat.db'));

mkdirSync(outDir, { recursive: true });
const db = new Database(`file:${dbPath}?mode=ro&immutable=1`, {
  readonly: true,
});

interface Row {
  guid: string;
  text: string | null;
  attributedBody: Buffer | null;
  message_summary_info: Buffer | null;
  date_edited: number;
}

const rows = db
  .prepare(
    `SELECT guid, text, attributedBody, message_summary_info, date_edited
       FROM message
      WHERE text LIKE ? || '%'
      ORDER BY ROWID`,
  )
  .all(tag) as Row[];

const manifestDraft: Record<
  string,
  { kind: string; sourceOs: string; expectedText?: string; note: string }
> = {};
let n = 0;
for (const row of rows) {
  const base = `${tag.toLowerCase()}-${String(++n).padStart(3, '0')}`;
  if (row.attributedBody) {
    const file = `${base}.bin`;
    writeFileSync(join(outDir, file), row.attributedBody);
    manifestDraft[file] = {
      kind: 'typedstream',
      sourceOs: 'FILL: sw_vers -productVersion',
      expectedText: row.text ?? undefined,
      note: `harvested attributedBody, guid ${row.guid}`,
    };
  }
  if (row.date_edited !== 0 && row.message_summary_info) {
    const file = `${base}-summary-info.bin`;
    writeFileSync(join(outDir, file), row.message_summary_info);
    manifestDraft[file] = {
      kind: 'summary-info',
      sourceOs: 'FILL: sw_vers -productVersion',
      expectedText: row.text ?? undefined,
      note: `harvested message_summary_info (edited), guid ${row.guid}`,
    };
  }
}
db.close();

writeFileSync(
  join(outDir, 'manifest.draft.json'),
  `${JSON.stringify(manifestDraft, null, 2)}\n`,
);
console.log(
  `harvested ${String(Object.keys(manifestDraft).length)} blob(s) from ${rows.length} tagged message(s) into ${outDir}`,
);
console.log(
  'NEXT (binding): review with `strings`, then git mv approved blobs.',
);
