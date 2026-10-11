/**
 * v2 F6d: the outbox, where an operator's file waits between staging and
 * its send (D-F6-7: the daemon's own Application Support folder, never
 * ~/Library/Messages).
 *
 *  - A staged file lives at `<outbox>/<sha256>/<safe-name>`: the folder is
 *    named by the hash of the bytes, so the same bytes staged twice are one
 *    stage, and the name is what Messages will show as the transfer name.
 *    Folders are 0700, files 0600.
 *  - Bytes stream to a temp file in the outbox while they are hashed and
 *    counted; nothing is buffered whole. Over the cap (D-F6-9, 100 MB) the
 *    write stops and the temp file is removed. The first bytes are sniffed
 *    against the declared Content-Type over the same closed set the bytes
 *    route serves with; a disagreement is refused, never "corrected".
 *  - At send time the dispatcher calls `rehash`, which re-reads the bytes
 *    on disk: a database row is not evidence of what is in the folder.
 *  - `sweep` deletes unbound stages after 24 h and bound ones 24 h after
 *    their draft ends. The rows stay, marked removed, so a sent draft still
 *    names the file it sent.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { Clock, StagedFile, Store } from '@wemessage/core';
import { sniff, SNIFF_BYTES, type SniffedMime } from './sniff.js';

import { SETTING_SEND_ATTACHMENTS } from '@wemessage/core';

/** D-F6-1: off until one real file send has been verified by hand (core key). */
export { SETTING_SEND_ATTACHMENTS };

/** D-F6-9: the dated iMessage wall. */
export const STAGE_MAX_BYTES = 100 * 1024 * 1024;

/** Both housekeeping windows (unbound, and after a draft ends). */
export const STAGE_KEEP_MS = 24 * 60 * 60 * 1000;

/** A stage id, and the only shape `POST /v1/send {file}` accepts. */
export const STAGE_ID = /^[0-9a-f]{64}$/;

export function attachmentsEnabled(store: Pick<Store, 'getSetting'>): boolean {
  return store.getSetting(SETTING_SEND_ATTACHMENTS) === '1';
}

/**
 * The name Messages will show, made safe for a single path part: the last
 * path segment only, no control characters, no colon, no leading dot or
 * space, at most 200 UTF-16 units with the extension kept. Empty is null:
 * the caller refuses it rather than inventing one.
 */
export function safeStageName(raw: string): string | null {
  const last = raw.split(/[/\\]/).pop() ?? '';
  const cleaned = last
    .replace(/[\u0000-\u001f\u007f:]/g, '')
    .replace(/^[.\s]+/, '')
    .trim();
  if (cleaned.length === 0) return null;
  if (cleaned.length <= 200) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const ext = dot > 0 && cleaned.length - dot <= 16 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, 200 - ext.length) + ext;
}

export type StageResult =
  | { ok: true; file: StagedFile }
  | { ok: false; status: 413; error: 'attachment-too-large'; limit: number }
  | {
      ok: false;
      status: 415;
      error: 'attachment-type-mismatch';
      declared: string;
      sniffed: SniffedMime | null;
    };

export interface Outbox {
  readonly dir: string;
  /** The cap this outbox enforces (STAGE_MAX_BYTES unless a test lowered it). */
  readonly maxBytes: number;
  /** Stream, hash, cap and sniff one body into the outbox, then record it. */
  stage(input: {
    body: Readable;
    name: string;
    declaredMime: string;
  }): Promise<StageResult>;
  /** The bytes on disk now, or null when they are gone. */
  rehash(file: StagedFile): Promise<{ path: string; sha256: string } | null>;
  /** Delete what housekeeping says is done with; returns the hashes removed. */
  sweep(): Promise<string[]>;
}

export interface OutboxDeps {
  dir: string;
  store: Pick<Store, 'insertStagedFile' | 'sweepStaged'>;
  clock: Clock;
  /** Tests lower the cap to prove the refusal without 100 MB of fixture. */
  maxBytes?: number;
}

export function pathOf(
  dir: string,
  file: Pick<StagedFile, 'sha256' | 'name'>,
): string {
  return join(dir, file.sha256, file.name);
}

export function createOutbox(deps: OutboxDeps): Outbox {
  const { dir, store, clock } = deps;
  const maxBytes = deps.maxBytes ?? STAGE_MAX_BYTES;

  return {
    dir,
    maxBytes,

    async stage({ body, name, declaredMime }) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = join(dir, `.stage-${randomBytes(8).toString('hex')}`);
      const handle = await open(tmp, 'wx', 0o600);
      const hash = createHash('sha256');
      const head: Buffer[] = [];
      let headBytes = 0;
      let total = 0;
      let over = false;
      try {
        // destroyOnReturn off: leaving early must not tear the request
        // down under the route, which still owes the client its 413.
        for await (const chunk of body.iterator({
          destroyOnReturn: false,
        }) as AsyncIterable<Buffer>) {
          total += chunk.length;
          if (total > maxBytes) {
            over = true;
            break;
          }
          if (headBytes < SNIFF_BYTES) {
            head.push(chunk.subarray(0, SNIFF_BYTES - headBytes));
            headBytes += Math.min(chunk.length, SNIFF_BYTES - headBytes);
          }
          hash.update(chunk);
          await handle.write(chunk);
        }
      } catch (err) {
        await handle.close().catch(() => undefined);
        await rm(tmp, { force: true });
        throw err;
      } finally {
        await handle.close().catch(() => undefined);
      }
      if (over) {
        // The rest of the body is never read; the route answers 413 and
        // closes the connection.
        await rm(tmp, { force: true });
        return {
          ok: false,
          status: 413,
          error: 'attachment-too-large',
          limit: maxBytes,
        };
      }
      const sniffed = sniff(Buffer.concat(head));
      if (sniffed === null || sniffed !== declaredMime) {
        await rm(tmp, { force: true });
        return {
          ok: false,
          status: 415,
          error: 'attachment-type-mismatch',
          declared: declaredMime,
          sniffed,
        };
      }
      const sha256 = hash.digest('hex');
      const folder = join(dir, sha256);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await rename(tmp, join(folder, name));
      const file = store.insertStagedFile({
        sha256,
        name,
        mime: sniffed,
        bytes: total,
        stagedAt: clock.now(),
        removedAt: null,
      });
      return { ok: true, file };
    },

    async rehash(file) {
      const path = pathOf(dir, file);
      try {
        const st = await stat(path);
        if (!st.isFile()) return null;
      } catch {
        return null;
      }
      const hash = createHash('sha256');
      try {
        for await (const chunk of createReadStream(
          path,
        ) as AsyncIterable<Buffer>) {
          hash.update(chunk);
        }
      } catch {
        return null;
      }
      return { path, sha256: hash.digest('hex') };
    },

    async sweep() {
      const removed = store.sweepStaged(
        clock.now(),
        STAGE_KEEP_MS,
        STAGE_KEEP_MS,
      );
      for (const sha of removed) {
        if (STAGE_ID.test(sha))
          await rm(join(dir, sha), { recursive: true, force: true });
      }
      return removed;
    },
  };
}
