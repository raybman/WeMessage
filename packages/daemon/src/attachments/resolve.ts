/**
 * v2 F6b: from a chat.db attachment row to an open file descriptor, or a
 * reason it cannot be served. Pure over the injected `fs`, `home` and
 * `root`, so every failure is a unit row.
 *
 * The order is the defence:
 *  1. Expand a leading `~/` against the injected home. A relative path
 *     reaches nothing.
 *  2. realpath the file and the root; the file's must start with the
 *     root's plus a separator, so `Attachments-evil` is not inside
 *     `Attachments`, and a symlink that escapes is caught after it is
 *     followed.
 *  3. stat the real path: it must be a regular file.
 *  4. open it O_RDONLY|O_NOFOLLOW and fstat the descriptor: dev and ino
 *     must equal step 3's. A file swapped (or re-pointed by a symlink)
 *     between the check and the open is `changed`, never served.
 *
 * No reason, and nothing returned, carries a path.
 */
import { constants, type Stats } from 'node:fs';
import { isAbsolute, join, sep, basename } from 'node:path';
import type { AttachmentRow } from '@wemessage/core';

export type ResolveFail =
  | 'unknown-attachment'
  | 'no-local-path'
  | 'not-on-this-mac'
  | 'outside-root'
  | 'changed';

export interface ResolveFs {
  realpathSync(p: string): string;
  statSync(p: string): Stats;
  openSync(p: string, flags: number): number;
  fstatSync(fd: number): Stats;
  closeSync(fd: number): void;
}

export interface ResolveDeps {
  home: string;
  root: string;
  fs: ResolveFs;
}

export type Resolved =
  | { ok: true; fd: number; size: number; mtimeMs: number; name: string }
  | { ok: false; reason: ResolveFail };

const GONE = new Set(['ENOENT', 'ENOTDIR']);

function codeOf(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e
    ? String(e.code)
    : undefined;
}

export function resolveAttachment(
  row: AttachmentRow | null,
  d: ResolveDeps,
): Resolved {
  if (row === null) return { ok: false, reason: 'unknown-attachment' };
  const stored = row.filename;
  if (stored === null || stored === '') {
    return { ok: false, reason: 'no-local-path' };
  }
  let candidate: string;
  if (stored.startsWith('~/')) candidate = join(d.home, stored.slice(2));
  else if (isAbsolute(stored)) candidate = stored;
  else return { ok: false, reason: 'outside-root' };

  let real: string;
  try {
    real = d.fs.realpathSync(candidate);
  } catch (e) {
    if (GONE.has(codeOf(e) ?? '')) {
      return { ok: false, reason: 'not-on-this-mac' };
    }
    throw e;
  }
  let realRoot: string;
  try {
    realRoot = d.fs.realpathSync(d.root);
  } catch (e) {
    // No Attachments folder at all: nothing here is on this Mac.
    if (GONE.has(codeOf(e) ?? '')) {
      return { ok: false, reason: 'not-on-this-mac' };
    }
    throw e;
  }
  if (!real.startsWith(realRoot + sep)) {
    return { ok: false, reason: 'outside-root' };
  }

  let checked: Stats;
  try {
    checked = d.fs.statSync(real);
  } catch (e) {
    if (GONE.has(codeOf(e) ?? '')) return { ok: false, reason: 'changed' };
    throw e;
  }
  if (!checked.isFile()) return { ok: false, reason: 'not-on-this-mac' };

  let fd: number;
  try {
    fd = d.fs.openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    const code = codeOf(e) ?? '';
    if (code === 'ELOOP' || GONE.has(code)) {
      return { ok: false, reason: 'changed' };
    }
    throw e;
  }
  let opened: Stats;
  try {
    opened = d.fs.fstatSync(fd);
  } catch (e) {
    d.fs.closeSync(fd);
    throw e;
  }
  if (
    !opened.isFile() ||
    opened.dev !== checked.dev ||
    opened.ino !== checked.ino
  ) {
    d.fs.closeSync(fd);
    return { ok: false, reason: 'changed' };
  }
  const name = basename(row.transferName ?? '') || basename(real);
  return { ok: true, fd, size: opened.size, mtimeMs: opened.mtimeMs, name };
}

/**
 * One `Range: bytes=` spec. Malformed and multi-range headers are answered
 * in full (RFC 9110 lets a server ignore Range); a range that starts past
 * the end, or a zero suffix, is unsatisfiable.
 */
export function parseRange(
  h: string | undefined,
  size: number,
): { start: number; end: number } | 'full' | 'unsatisfiable' {
  if (h === undefined) return 'full';
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (m === null) return 'full';
  const [, a = '', b = ''] = m;
  if (a === '' && b === '') return 'full';
  if (a === '') {
    const n = Number(b);
    if (!Number.isSafeInteger(n)) return 'full';
    if (n === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  if (!Number.isSafeInteger(start)) return 'full';
  if (start >= size) return 'unsatisfiable';
  let end = size - 1;
  if (b !== '') {
    const want = Number(b);
    if (!Number.isSafeInteger(want)) return 'full';
    if (want < start) return 'full';
    end = Math.min(want, size - 1);
  }
  return { start, end };
}
