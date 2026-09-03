/**
 * Local FDA probe for `wemessage doctor`'s macOS-26 divergence check
 * (s3-execution Scenario 10, §1.3.1 "GUI-vs-daemon context check, CLI
 * edition"). Deliberately duplicated from @wemessage/ingest's
 * `probeChatDbReadable` rather than imported: `cli-desktop-thin-clients`
 * (.dependency-cruiser.cjs, §3.1/§2.5) restricts `packages/cli/src` to
 * importing only @wemessage/client + @wemessage/protocol, and the point of
 * this probe is running in the CLI's OWN process context — comparing "can
 * THIS process (the operator's shell) read chat.db" against what the
 * daemon reported for ITS process is the whole mechanism; the two contexts
 * must stay genuinely separate implementations, not share one transitively.
 *
 * `open(path, O_RDONLY)`, not `fs.access` (can lie under TCC: a stat-only
 * check can report a path accessible when a subsequent read would still
 * throw). EACCES joins EPERM under 'eperm': macOS TCC denial surfaces as
 * EPERM from open(2); chmod-based test fixtures (never real TCC — no test
 * may exercise a real permission grant, test/arch.spec.ts gates (a)/(b))
 * surface as EACCES. Both mean "no FDA" here.
 */
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type ChatDbProbeResult = 'ok' | 'eperm' | 'enoent' | 'error';

/**
 * Production default lives at the real Messages path; `WEMESSAGE_CHATDB_PATH`
 * is the test seam (never pointed at a real chat.db in any test).
 */
export function defaultChatDbPath(): string {
  return (
    process.env['WEMESSAGE_CHATDB_PATH'] ??
    join(homedir(), 'Library', 'Messages', 'chat.db')
  );
}

export async function probeChatDbReadable(
  path: string = defaultChatDbPath(),
): Promise<ChatDbProbeResult> {
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
