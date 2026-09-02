// Foreground dev entrypoint (F-1: no launchd packaging in S1). Boot ordering
// (recovery -> watcher -> listen) lands in Scenario 11; today: auth + API only.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { buildServer, startServer } from './server.js';

const Env = z.object({
  // R7 rename map: WEMESSAGE_DIR overrides the config dir (tests/dev).
  WEMESSAGE_DIR: z.string().min(1).optional(),
  // §2.6: local API defaults to 127.0.0.1:47100.
  WEMESSAGE_PORT: z.coerce.number().int().min(1).max(65535).default(47100),
});

const env = Env.parse(process.env);
const configDir =
  env.WEMESSAGE_DIR ??
  join(homedir(), 'Library', 'Application Support', 'WeMessage');

const server = await buildServer({ configDir });
const port = await startServer(server, { port: env.WEMESSAGE_PORT });

if (server.token === null) {
  console.error(
    `wemessage daemon: NO AUTH TOKEN (could not read or create ${configDir}); serving 503 on all routes (fail closed)`,
  );
} else {
  console.log(`wemessage daemon: listening on 127.0.0.1:${port}`);
}
