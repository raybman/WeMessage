#!/usr/bin/env node
/**
 * wemessage CLI (§3.8, S1 subset): status / watch / auth print-token /
 * auth rotate. Thin wrapper over the daemon API via @wemessage/client
 * (§2.5 "zero business logic duplicated").
 *
 * Exit codes (§3.8): 0 success, 1 operation failed, 2 usage error,
 * 3 daemon unreachable, 4 auth failure.
 *
 * Auth bootstrap (§2.6): --token/-T flag, else WEMESSAGE_TOKEN env
 * (remote/CI), else the token file in WEMESSAGE_DIR read directly
 * (same-user filesystem trust).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Command, CommanderError } from 'commander';
import {
  createClient,
  readTokenFile,
  rotateTokenFile,
  DaemonAuthError,
  DaemonUnreachableError,
  type StatusPayload,
} from '@wemessage/client';

const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_UNREACHABLE = 3;
const EXIT_AUTH = 4;

function configDir(): string {
  return (
    process.env['WEMESSAGE_DIR'] ??
    join(homedir(), 'Library', 'Application Support', 'WeMessage')
  );
}

function baseUrl(): string {
  const port = process.env['WEMESSAGE_PORT'] ?? '47100';
  return `http://127.0.0.1:${port}`;
}

function resolveToken(flag?: string): string | null {
  return flag ?? process.env['WEMESSAGE_TOKEN'] ?? readTokenFile(configDir());
}

function fail(message: string, code: number): never {
  console.error(`wemessage: ${message}`);
  process.exit(code);
}

function exitFor(error: unknown): never {
  if (error instanceof DaemonUnreachableError) {
    fail(error.message, EXIT_UNREACHABLE);
  }
  if (error instanceof DaemonAuthError) {
    fail(error.message, EXIT_AUTH);
  }
  fail(error instanceof Error ? error.message : String(error), EXIT_FAILED);
}

function clientOrExit(tokenFlag?: string): ReturnType<typeof createClient> {
  const token = resolveToken(tokenFlag);
  if (token === null) {
    fail(
      `no token: pass --token, set WEMESSAGE_TOKEN, or run the daemon once to create ${join(configDir(), 'daemon.token')}`,
      EXIT_AUTH,
    );
  }
  return createClient({ baseUrl: baseUrl(), token });
}

function renderStatus(status: StatusPayload): string {
  const cursor = status.cursor
    ? `rowid ${String(status.cursor.lastRowid)} @ ${status.cursor.lastScanAt}`
    : 'none';
  return [
    `connection: ${status.connectionState}`,
    `cursor:     ${cursor}`,
    `today:      ${String(status.counts.messagesToday)} message(s)`,
    `adapters:   ${String(status.adapters.length)}`,
  ].join('\n');
}

const program = new Command();
program
  .name('wemessage')
  .description('WeMessage gateway CLI — thin client over the local daemon API')
  .exitOverride();

program
  .command('status')
  .description('connection state, cursor, counts (§3.8)')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(async (opts: { json?: boolean; token?: string }) => {
    try {
      const status = await clientOrExit(opts.token).status();
      console.log(
        opts.json === true ? JSON.stringify(status) : renderStatus(status),
      );
    } catch (error) {
      exitFor(error);
    }
  });

program
  .command('watch')
  .description('live event stream (WS under the hood, §3.8)')
  .option('--json', 'NDJSON: one JSON object per event')
  .option('-T, --token <token>', 'bearer token override')
  .action(async (opts: { json?: boolean; token?: string }) => {
    try {
      await clientOrExit(opts.token).events((event) => {
        // S1 emits NDJSON in both modes; --json is the stable contract
        // (§3.8 "--json … NDJSON for streams"). Pretty rendering is S3+.
        console.log(JSON.stringify(event));
      });
      // stream stays open until Ctrl-C / kill
    } catch (error) {
      exitFor(error);
    }
  });

const auth = program
  .command('auth')
  .description('daemon token management (§2.6)');

auth
  .command('print-token')
  .description('print the daemon token from the config dir')
  .action(() => {
    const token = readTokenFile(configDir());
    if (token === null) {
      fail(
        `no token file at ${join(configDir(), 'daemon.token')}`,
        EXIT_FAILED,
      );
    }
    console.log(token);
  });

auth
  .command('rotate')
  .description('rotate the daemon token; old bearers get 401 immediately')
  .action(() => {
    try {
      console.log(rotateTokenFile(configDir()));
    } catch (error) {
      exitFor(error);
    }
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError) {
    // help/version exit 0; anything else commander-side is a usage error (§3.8)
    process.exit(error.exitCode === 0 ? 0 : EXIT_USAGE);
  }
  exitFor(error);
}
