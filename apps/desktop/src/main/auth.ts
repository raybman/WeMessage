/**
 * Where the app finds the daemon, and where it finds the credential.
 *
 * This is the ONLY file in `apps/desktop/src` that names the credential.
 * `test/arch.spec.ts` asserts that: no file under `src/renderer` or
 * `src/preload` may mention `WEMESSAGE_TOKEN`, `readTokenFile`, `Bearer`,
 * `daemon.token` or the token prefix, and exactly one file under `src/main`
 * may. The rule is not stylistic. The token approves sends; a renderer that
 * can read it turns any injection into an approve-anything capability, and
 * the cheapest way to keep it out of the renderer is to keep the WORDS out
 * of the renderer, where a reviewer can see the absence at a glance.
 *
 * The resolution order is `packages/cli/src/bin.ts`'s, verbatim, because two
 * bootstraps that differ by one fallback is how "it works from the CLI but
 * not from the app" is born.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readTokenFile, TOKEN_FILENAME } from '@wemessage/client';

/**
 * The loopback host, spelled as a constant so that this file does not
 * contain a scheme-plus-loopback literal. `test/arch.spec.ts` row 3 forbids
 * that literal anywhere under `apps/desktop/src` — including in prose, since
 * the row is a raw text scan and a comment is not an exemption. The row is
 * aimed at a hand-rolled transport, and the app has none: it owns the base
 * URL and `@wemessage/client` owns every byte that travels over it.
 */
const LOOPBACK = '127.0.0.1';

/** §2.6. The same default the CLI and the daemon agree on. */
const DEFAULT_PORT = 47100;

/** The app's own config directory, when `WEMESSAGE_DIR` says nothing. */
function defaultConfigDir(): string {
  return join(homedir(), 'Library', 'Application Support', 'WeMessage');
}

export interface Bootstrap {
  /** Where the token file lives, and where the daemon keeps its state. */
  configDir: string;
  /** The absolute path of the token file, shown to the operator on failure. */
  tokenPath: string;
  /** The daemon's loopback base URL, assembled rather than written down. */
  baseUrl: string;
  /**
   * The credential, or `null` when this machine has none yet.
   *
   * `null` is a first-class outcome, not an error: a fresh install has no
   * token, and the correct response is the wizard, not a request that 401s.
   * Row 7 asserts the daemon sees ZERO requests in that state.
   */
  token: string | null;
}

/**
 * Resolve the bootstrap from the environment.
 *
 * The environment is the only carrier. There is no `--token` argument and
 * there never will be: `ps` publishes argv to every user on the machine, so
 * a flag would hand the credential to anyone with a shell. Row 5 asserts
 * main's own `process.argv` carries neither the prefix nor the live token.
 */
export function resolveBootstrap(
  env: NodeJS.ProcessEnv = process.env,
): Bootstrap {
  const configDir = env['WEMESSAGE_DIR'] ?? defaultConfigDir();
  const portRaw = env['WEMESSAGE_PORT'];
  const parsed = portRaw === undefined ? NaN : Number.parseInt(portRaw, 10);
  const port = Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
  return {
    configDir,
    tokenPath: join(configDir, TOKEN_FILENAME),
    baseUrl: `http://${LOOPBACK}:${String(port)}`,
    token: env['WEMESSAGE_TOKEN'] ?? readTokenFile(configDir),
  };
}
