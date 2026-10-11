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
import type { AttachmentRow, Store } from '@wemessage/core';
import {
  parseRange,
  resolveAttachment,
  type ResolveFs,
} from '../attachments/resolve.js';
import { sniff, SNIFF_BYTES } from '../attachments/sniff.js';
import {
  attachmentsEnabled,
  safeStageName,
  STAGE_MAX_BYTES,
  type Outbox,
} from '../attachments/outbox.js';

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

/**
 * v2 F6d: `POST /v1/attachments/staged`, route ratchet #33. The operator's
 * app hands the daemon one file, as the raw request body:
 *
 *  - `Content-Type` is the file's mime and `X-WeMessage-Name` its name
 *    (percent-encoded UTF-8). There is no JSON body and no zod schema: the
 *    bytes are the body, so the route is in NO_BODY_ROUTES.
 *  - Off by default: while `send.attachments` is off the route is a 409
 *    `attachments-unproven` and reads nothing (D-F6-1).
 *  - Over 100 MB is a 413 (by Content-Length up front, or mid-stream when
 *    there is none); first bytes that disagree with the declared type are a
 *    415. Both leave nothing in the outbox and no row.
 *  - Answers `{stageId, name, mime, bytes}`; the stage id is the sha256.
 *  - Operator bearer only (the server hook), so no agent can stage, and no
 *    audit row: staging is not a send. The send of a staged file is the
 *    audited action, through `POST /v1/send {chatGuid, file}`.
 *
 * Registered in its own encapsulated scope so its pass-through body parser
 * (the request stream itself, never buffered) applies to this route only.
 */
export interface StageRouteDeps {
  outbox: Outbox;
  store: Pick<Store, 'getSetting'>;
}

export const STAGE_PATH = '/v1/attachments/staged';

export async function registerStageRoute(
  app: FastifyInstance,
  deps: StageRouteDeps,
): Promise<void> {
  await app.register((scope, _opts, done) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_req, payload, done) => {
      done(null, payload);
    });
    scope.post(
      STAGE_PATH,
      { bodyLimit: STAGE_MAX_BYTES + 1 },
      async (req, reply) => {
        const body = req.body as Readable | undefined;
        const drain = (): void => {
          body?.resume();
        };
        if (!attachmentsEnabled(deps.store)) {
          drain();
          return reply.code(409).send({ error: 'attachments-unproven' });
        }
        const declared = (req.headers['content-type'] ?? '')
          .split(';')[0]
          ?.trim()
          .toLowerCase();
        const rawName = req.headers['x-wemessage-name'];
        let decoded = '';
        try {
          decoded =
            typeof rawName === 'string' ? decodeURIComponent(rawName) : '';
        } catch {
          decoded = '';
        }
        const name = safeStageName(decoded);
        if (
          name === null ||
          declared === undefined ||
          declared === '' ||
          body === undefined
        ) {
          drain();
          return reply.code(400).send({ error: 'invalid-stage' });
        }
        const length = Number(req.headers['content-length']);
        if (Number.isFinite(length) && length > deps.outbox.maxBytes) {
          void reply.header('connection', 'close');
          return reply.code(413).send({
            error: 'attachment-too-large',
            limit: deps.outbox.maxBytes,
          });
        }
        const result = await deps.outbox.stage({
          body,
          name,
          declaredMime: declared,
        });
        if (!result.ok) {
          const { ok, status, ...rest } = result;
          void ok;
          // Over the cap the rest of the body was never read: close the
          // connection after the answer rather than drain it.
          if (status === 413) void reply.header('connection', 'close');
          return reply.code(status).send(rest);
        }
        const { sha256, mime, bytes } = result.file;
        return reply.send({
          stageId: sha256,
          name: result.file.name,
          mime,
          bytes,
        });
      },
    );
    done();
  });
}
