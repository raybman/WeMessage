/**
 * FDA (Full Disk Access) probe for the doctor engine (s3-execution Scenario
 * 7, Fable design consult point 8). Deliberately `fs.open(path, O_RDONLY)`,
 * not `fs.access` (can lie under TCC — a stat-only check can report a path
 * as accessible when a subsequent read would still throw) and not
 * better-sqlite3 (that is the SQL-level reader open in chatdb/index.ts; this
 * is the raw fs syscall the spec's "open O_RDONLY" wording calls for).
 *
 * EACCES maps to 'eperm' alongside EPERM: macOS TCC denial surfaces as EPERM
 * from open(2), but chmod-based test fixtures (no real TCC in CI) surface as
 * EACCES — both mean "no FDA" for this probe's purposes.
 */
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';

export type FdaProbeResult = 'ok' | 'eperm' | 'enoent' | 'error';

export async function probeChatDbReadable(
  path: string,
): Promise<FdaProbeResult> {
  try {
    const fh = await open(path, constants.O_RDONLY);
    await fh.close();
    return 'ok';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') return 'eperm';
    if (code === 'ENOENT') return 'enoent';
    return 'error';
  }
}
