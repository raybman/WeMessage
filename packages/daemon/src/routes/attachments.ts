/**
 * v2 F6b: `GET /v1/attachments/:id` (and its HEAD twin), the bytes of one
 * chat.db attachment, by chat.db's own `attachment.guid` (G-15b).
 *
 *  - Operator bearer only: the server's hook refuses an adapter token like
 *    any other non-operator token. Agents never reach a file's bytes.
 *  - The id is the only input. It is shape-checked and bound as an SQL
 *    parameter by the reader; a client path is accepted nowhere.
 *  - The file is resolved under the Attachments root by `resolveAttachment`
 *    (realpath, prefix, O_NOFOLLOW, dev/ino), and every failure is a 404
 *    with a reason and never a path. A reader that cannot read chat.db
 *    (Full Disk Access lost) is a 503 `source-unavailable`.
 *  - Content-Type comes from the first bytes over a closed set; the mime
 *    chat.db stores is the sender's claim and is never trusted. Anything
 *    unknown is `application/octet-stream`, and every answer carries
 *    `nosniff` and `Content-Disposition: attachment`.
 *  - A single byte range is honoured (206); a multi-range is answered in
 *    full; an unsatisfiable one is 416. Bodies stream from the descriptor,
 *    never buffered.
 *  - No audit row and no broadcast, like search: looking is not an action.
 *
 * chat.db is reached only through the `attachmentFile` closure handed in,
 * so the port-importer allowlist does not grow.
 */
import { createReadStream, readSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { AttachmentRow } from '@wemessage/core';
import {
  parseRange,
  resolveAttachment,
  type ResolveFs,
} from '../attachments/resolve.js';
import { sniff, SNIFF_BYTES } from '../attachments/sniff.js';

export interface AttachmentRouteDeps {
  /** chat.db's row for a joined attachment guid, or null. May throw: 503. */
  attachmentFile: (id: string) => AttachmentRow | null;
  /** The home a stored `~/` path expands against. */
  home: string;
  /** The only folder bytes are served from (D-F6-5). */
  root: string;
  /** Tests inject a filesystem to swap a file between check and open. */
  fs?: ResolveFs;
}

export const ATTACHMENT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** RFC 5987 `filename*` value: UTF-8, percent-encoded, nothing raw. */
function encodeFilename(name: string): string {
  return encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

export function registerAttachmentRoutes(
  app: FastifyInstance,
  deps: AttachmentRouteDeps,
): void {
  const fs: ResolveFs = deps.fs ?? nodeFs;

  app.get('/v1/attachments/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!ATTACHMENT_ID.test(id)) {
      return reply
        .code(404)
        .send({ error: 'attachment-not-local', reason: 'unknown-attachment' });
    }
    let resolved;
    try {
      resolved = resolveAttachment(deps.attachmentFile(id), {
        home: deps.home,
        root: deps.root,
        fs,
      });
    } catch {
      return reply.code(503).send({ error: 'source-unavailable' });
    }
    if (!resolved.ok) {
      return reply
        .code(404)
        .send({ error: 'attachment-not-local', reason: resolved.reason });
    }
    const { fd, size, mtimeMs, name } = resolved;
    let owned = true;
    try {
      const head = Buffer.alloc(Math.min(SNIFF_BYTES, size));
      if (head.length > 0) readSync(fd, head, 0, head.length, 0);
      const mime = sniff(head);
      const etag = `"${id}-${size}-${Math.trunc(mtimeMs)}"`;
      reply
        .header('Content-Type', mime ?? 'application/octet-stream')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'private, no-store')
        .header('Accept-Ranges', 'bytes')
        .header('ETag', etag)
        .header(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodeFilename(name)}`,
        );

      if (req.headers['if-none-match'] === etag) {
        return reply.code(304).send();
      }

      const range = parseRange(
        typeof req.headers.range === 'string' ? req.headers.range : undefined,
        size,
      );
      if (range === 'unsatisfiable') {
        reply.header('Content-Range', `bytes */${size}`);
        reply.removeHeader('Content-Disposition');
        reply.header('Content-Type', 'application/json; charset=utf-8');
        return reply.code(416).send({ error: 'range-not-satisfiable' });
      }
      const start = range === 'full' ? 0 : range.start;
      const end = range === 'full' ? size - 1 : range.end;
      if (range !== 'full') {
        reply
          .code(206)
          .header('Content-Range', `bytes ${start}-${end}/${size}`);
      }
      reply.header('Content-Length', String(end - start + 1));
      if (req.method === 'HEAD' || size === 0) {
        // Headers only: an empty stream keeps the Content-Length set above.
        return reply.send(Readable.from([]));
      }
      owned = false;
      return reply.send(
        createReadStream('', {
          fd,
          start,
          end,
          autoClose: true,
          highWaterMark: 1 << 20,
        }),
      );
    } finally {
      if (owned) fs.closeSync(fd);
    }
  });
}
