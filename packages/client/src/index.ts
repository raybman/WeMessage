/**
 * @wemessage/client — typed daemon client (auth bootstrap, REST, WS events).
 * Thin transport over the authenticated local API (§2.5 "CLI and GUI are thin
 * clients over the identical authenticated HTTP/WS API"); zero business logic.
 *
 * Auth bootstrap per §2.6: same-user callers read the token file directly
 * (filesystem-permission trust, the standard local-daemon pattern); rotation
 * rewrites that file — the daemon re-reads it per request, so old bearers get
 * 401 immediately.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { GatewayEventPayload } from '@wemessage/protocol';

export type { GatewayEventPayload } from '@wemessage/protocol';

/** Token file name inside the WeMessage config dir (§2.6). */
export const TOKEN_FILENAME = 'daemon.token';
/** wm_ prefix per the WeMessage rename map (R11). */
export const TOKEN_PREFIX = 'wm_';

/** Daemon could not be reached at all (maps to CLI exit 3, §3.8). */
export class DaemonUnreachableError extends Error {
  constructor(baseUrl: string, cause?: unknown) {
    super(`daemon unreachable at ${baseUrl}`);
    this.name = 'DaemonUnreachableError';
    this.cause = cause;
  }
}

/** Daemon rejected the bearer — 401/503 auth modes (CLI exit 4, §3.8). */
export class DaemonAuthError extends Error {
  constructor(readonly statusCode: number) {
    super(`daemon rejected authentication (HTTP ${statusCode})`);
    this.name = 'DaemonAuthError';
  }
}

/** Any other non-2xx daemon response (CLI exit 1, §3.8). */
export class DaemonRequestError extends Error {
  constructor(
    readonly statusCode: number,
    body: string,
  ) {
    super(`daemon request failed (HTTP ${statusCode}): ${body}`);
    this.name = 'DaemonRequestError';
  }
}

/** Read the daemon token from the config dir; null when absent (§2.6). */
export function readTokenFile(configDir: string): string | null {
  try {
    const token = readFileSync(join(configDir, TOKEN_FILENAME), 'utf8').trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Rotate the token file: write a fresh 256-bit `wm_` token at mode 0600 and
 * return it. The daemon authenticates against the file per request, so prior
 * bearers 401 from the next request on (§2.6 "greenlight auth rotate").
 */
export function rotateTokenFile(configDir: string): string {
  const token = TOKEN_PREFIX + randomBytes(32).toString('hex');
  mkdirSync(configDir, { recursive: true });
  const path = join(configDir, TOKEN_FILENAME);
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600); // mode option is umask-filtered; enforce exactly 0600
  return token;
}

/** F-5 proposed S1 `/v1/status` payload — nulls for S4/S6 concepts. */
export interface StatusPayload {
  connectionState: 'fully-connected' | 'read-only' | 'disconnected';
  cursor: { lastRowid: number; lastScanAt: string } | null;
  counts: { messagesToday: number };
  adapters: unknown[];
  killSwitch: null;
  armed: null;
}

export interface ClientOptions {
  /** e.g. `http://127.0.0.1:47100` (§2.6 default port). */
  baseUrl: string;
  token: string;
}

export interface EventSubscription {
  close(): void;
}

export interface WeMessageClient {
  health(): Promise<{ status: string }>;
  status(): Promise<StatusPayload>;
  /** Resolves once the WS is open; rejects on auth/unreachable. */
  events(
    onEvent: (event: GatewayEventPayload) => void,
  ): Promise<EventSubscription>;
}

export function createClient(options: ClientOptions): WeMessageClient {
  const get = async (path: string): Promise<unknown> => {
    let res: Response;
    try {
      res = await fetch(`${options.baseUrl}${path}`, {
        headers: { authorization: `Bearer ${options.token}` },
      });
    } catch (cause) {
      throw new DaemonUnreachableError(options.baseUrl, cause);
    }
    if (res.status === 401 || res.status === 403 || res.status === 503) {
      throw new DaemonAuthError(res.status);
    }
    if (!res.ok) {
      throw new DaemonRequestError(res.status, await res.text());
    }
    return res.json();
  };

  return {
    health: () => get('/v1/health') as Promise<{ status: string }>,
    status: () => get('/v1/status') as Promise<StatusPayload>,
    events(onEvent) {
      const wsUrl = `${options.baseUrl.replace(/^http/, 'ws')}/v1/events`;
      return new Promise<EventSubscription>((resolve, reject) => {
        const ws = new WebSocket(wsUrl, {
          headers: { authorization: `Bearer ${options.token}` },
        });
        let settled = false;
        ws.on('open', () => {
          settled = true;
          resolve({ close: () => ws.close() });
        });
        ws.on('message', (data) => {
          const text = Array.isArray(data)
            ? Buffer.concat(data).toString('utf8')
            : Buffer.isBuffer(data)
              ? data.toString('utf8')
              : Buffer.from(new Uint8Array(data)).toString('utf8');
          onEvent(JSON.parse(text) as GatewayEventPayload);
        });
        ws.on('error', (err) => {
          if (!settled) {
            settled = true;
            reject(
              /401|403/.test(err.message)
                ? new DaemonAuthError(401)
                : new DaemonUnreachableError(options.baseUrl, err),
            );
          }
        });
        ws.on('close', () => {
          if (!settled) {
            settled = true;
            reject(new DaemonUnreachableError(options.baseUrl));
          }
        });
      });
    },
  };
}
