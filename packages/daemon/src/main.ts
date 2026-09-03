// Foreground dev entrypoint (F-1: no launchd packaging in S1). Boot order
// recovery -> watcher -> listen per §2.5; live FSEvents + clock-skew wake
// (F-9). The demo script (spec 4.2) runs this via WEMESSAGE_DIR/PORT.
import { homedir, release as osRelease } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Clock } from '@wemessage/core';
import {
  createClockSkewWakeSignal,
  createNodeFsWatcher,
} from '@wemessage/ingest';
import { AppleScriptSendBackend, type ExecFn } from '@wemessage/sendkit';
import { startDaemon } from './daemon.js';
import { createRealDoctorProbes } from './doctor.js';

// Real execFile-backed ExecFn (s3-execution Scenario 7): deliberately
// generic (cmd/args are caller-supplied) so this file names no specific
// AppleScript-runner binary — that literal stays confined to
// packages/sendkit/src per test/arch.spec.ts's S3 production-source gate.
// This is just the shell-out primitive sendkit's probes are injected with.
const execFileAsync = promisify(execFile);
const realExec: ExecFn = async (cmd, args) => {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args);
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: e.code ?? 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
};

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
  doctorProbes: createRealDoctorProbes({
    osRelease,
    chatDbPath,
    exec: realExec,
  }),
  // s3-execution Scenario 8: the only production SendBackend — the real
  // AppleScript runner via the injected execFile primitive above (never a
  // bespoke scripting-runner literal in this file; that stays confined to
  // packages/sendkit/src per test/arch.spec.ts's gate (a)).
  backend: new AppleScriptSendBackend({ exec: realExec }),
  backendName: 'applescript',
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
