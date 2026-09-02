// Foreground dev entrypoint (F-1: no launchd packaging in S1). Boot order
// recovery -> watcher -> listen per §2.5; live FSEvents + clock-skew wake
// (F-9). The demo script (spec 4.2) runs this via WEMESSAGE_DIR/PORT.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Clock } from '@wemessage/core';
import {
  createClockSkewWakeSignal,
  createNodeFsWatcher,
} from '@wemessage/ingest';
import { startDaemon } from './daemon.js';

const Env = z.object({
  // R7 rename map: WEMESSAGE_DIR overrides the config dir (tests/dev).
  WEMESSAGE_DIR: z.string().min(1).optional(),
  // §2.6: local API defaults to 127.0.0.1:47100.
  WEMESSAGE_PORT: z.coerce.number().int().min(1).max(65535).default(47100),
  // Live tail target; overridable for demos against a fixture DB.
  WEMESSAGE_CHATDB: z.string().min(1).optional(),
});

const env = Env.parse(process.env);
const configDir =
  env.WEMESSAGE_DIR ??
  join(homedir(), 'Library', 'Application Support', 'WeMessage');
const chatDbPath =
  env.WEMESSAGE_CHATDB ?? join(homedir(), 'Library', 'Messages', 'chat.db');

const clock: Clock = {
  now: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};
const wake = createClockSkewWakeSignal(clock);
wake.start();

const daemon = await startDaemon({
  configDir,
  chatDbPath,
  clock,
  watcher: createNodeFsWatcher(),
  wake,
  port: env.WEMESSAGE_PORT,
  onError: (error) => {
    console.error('wemessage daemon: pipeline error (loop continues):', error);
  },
});

if (daemon.server.token === null) {
  console.error(
    `wemessage daemon: NO AUTH TOKEN (could not read or create ${configDir}); serving 503 on all routes (fail closed)`,
  );
} else {
  console.log(`wemessage daemon: listening on 127.0.0.1:${daemon.port}`);
  console.log(`wemessage daemon: tailing ${chatDbPath} (read-only)`);
}

const shutdown = async (): Promise<void> => {
  wake.stop();
  await daemon.stop();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
