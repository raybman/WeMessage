/**
 * Daemon API token (§2.6): 256-bit, generated on first run, stored 0600 at
 * <configDir>/daemon.token. `wm_` prefix per the WeMessage rename map (R11).
 * Missing AND ungenerable token → the server serves 503-everything (§2.4.2
 * row 1); generation failure is a state, never a crash.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const TOKEN_FILENAME = 'daemon.token';
export const TOKEN_PREFIX = 'wm_';

/** 32 random bytes (256 bits) hex-encoded behind the wm_ prefix. */
export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString('hex');
}

/**
 * Read the current token file; null when absent/empty/unreadable. This is the
 * live per-request source of truth (§2.6: `auth rotate` rewrites the file and
 * old bearers must 401 without a daemon restart).
 */
export function readToken(configDir: string): string | null {
  try {
    const token = readFileSync(join(configDir, TOKEN_FILENAME), 'utf8').trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Read the token file, or self-heal first run by generating one (serve-503-only
 * was chosen over exit-at-boot exactly so this can happen, §2.4.2).
 * Returns null when no token exists and none can be written — fail closed.
 */
export function loadOrCreateToken(configDir: string): string | null {
  const path = join(configDir, TOKEN_FILENAME);
  const existing = readToken(configDir);
  if (existing !== null) return existing;
  try {
    mkdirSync(configDir, { recursive: true });
    const token = generateToken();
    writeFileSync(path, `${token}\n`, { mode: 0o600 });
    chmodSync(path, 0o600); // mode option is umask-filtered; enforce exactly 0600
    return token;
  } catch {
    return null;
  }
}

/** Constant-time comparison (hash both sides to equal length first). */
export function tokenEquals(expected: string, presented: string): boolean {
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(presented).digest();
  return timingSafeEqual(a, b);
}
