/**
 * v2 A1: `GET /v1/threads`, the conversations list the v2 messenger opens on.
 * v2 A2: `GET /v1/threads/:guid/messages`, one page of one conversation,
 * under every rule below; the list's cursor becomes the page's `before`.
 *
 * A read, and only a read. The route asks the channel source it was handed
 * for one page, copies that source's channel tag onto every row, strips
 * control characters at the wire (a source hands back raw text, exactly as
 * it was stored), and dates the answer with the daemon's own clock, so the
 * GUI can write "as of 16:42" without reading a clock of its own.
 *
 * What it never does:
 *  - read a database. Rows arrive through `source.listChats` and nowhere
 *    else (TN-imessage-is-just-a-source): iMessage is the first source, not
 *    the shape every source has.
 *  - interpret the cursor. It belongs to the source, is opaque here, and is
 *    forwarded verbatim; whether a cursor is valid is the source's call,
 *    made with core's `InvalidCursorError`.
 *  - write. No audit row and no broadcast follow from looking at a list.
 *  - answer anyone but the operator. That is the server's bearer hook,
 *    which exempts exactly two paths, and this is neither of them.
 *  - leak a failure. A source that is down is a 503 with a fixed body. The
 *    text of a failed open names files and permissions, and a list endpoint
 *    is no place to publish either.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  InvalidCursorError,
  UnknownChatError,
  type ChannelName,
  type ChannelSource,
  type ChatSummary,
  type ChatsPage,
  type ChatsQuery,
  type Clock,
  type TranscriptTurn,
  type TurnKind,
  type TurnsPage,
  type TurnsQuery,
} from '@wemessage/core';
import { stripControlChars } from '../sanitize.js';

export interface ThreadRouteDeps {
  source: ChannelSource;
  clock: Clock;
}

// strictObject: an unknown query param is surface too (fail closed, the
// audit route's idiom). 200 is the most a page may hold, and a source caps
// on its own as well, so neither side trusts the other to.
const listQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().min(1).optional(),
});

/** One row as the wire carries it: these keys, and nothing a source added. */
interface WireThread {
  chatGuid: string;
  channel: ChannelName;
  title: string;
  isGroup: boolean;
  lastLine: string | null;
  lastFromMe: boolean;
  lastAt: string;
}

/**
 * Built field by field, never spread: a source is free to carry its own
 * bookkeeping on a row, and none of it is the wire's business. A last line
 * that was nothing BUT control characters is no line at all once they are
 * gone, so it goes out as null rather than as an empty string.
 */
function toWire(channel: ChannelName, chat: ChatSummary): WireThread {
  const line = chat.lastLine === null ? null : stripControlChars(chat.lastLine);
  return {
    chatGuid: chat.chatGuid,
    channel,
    title: stripControlChars(chat.title),
    isGroup: chat.isGroup,
    lastLine: line !== null && line.trim().length > 0 ? line : null,
    lastFromMe: chat.lastFromMe,
    lastAt: chat.lastAt,
  };
}

// v2 A2. A cursor walks back, `until` jumps to a date; one page cannot do
// both, so asking for both is refused before the source is asked anything.
// `until` must be a full instant: a bare date has no zone, and which day it
// means is the GUI's call, made before it asks.
const pageQuery = z
  .strictObject({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    before: z.string().min(1).optional(),
    until: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((q) => q.before === undefined || q.until === undefined, {
    message: 'before and until are mutually exclusive',
  });

// A chat guid is the source's to judge; the route only bounds its size.
const pageParams = z.strictObject({ guid: z.string().min(1).max(512) });

/** One transcript turn as the wire carries it. */
interface WireTurn {
  guid: string;
  from: 'me' | 'them';
  kind: TurnKind;
  text: string | null;
  at: string;
  handle?: string;
  editedAt?: string;
  unsentAt?: string;
  attachments: number;
}

/** Field by field, as for a list row; a text of only controls is none. */
function turnToWire(turn: TranscriptTurn): WireTurn {
  const text = turn.text === null ? null : stripControlChars(turn.text);
  return {
    guid: turn.guid,
    from: turn.from,
    kind: turn.kind,
    text: text !== null && text.trim().length > 0 ? text : null,
    at: turn.at,
    ...(turn.handle !== undefined
      ? { handle: stripControlChars(turn.handle) }
      : {}),
    ...(turn.editedAt !== undefined ? { editedAt: turn.editedAt } : {}),
    ...(turn.unsentAt !== undefined ? { unsentAt: turn.unsentAt } : {}),
    attachments: turn.attachments,
  };
}

export function registerThreadRoutes(
  app: FastifyInstance,
  deps: ThreadRouteDeps,
): void {
  const { source, clock } = deps;

  // GET, and fastify's auto-HEAD twin (route ratchet #26).
  app.get('/v1/threads', async (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid-query',
        detail: { issues: parsed.error.issues },
      });
    }
    const { limit, cursor } = parsed.data;
    const query: ChatsQuery =
      cursor === undefined ? { limit } : { limit, cursor };

    let page: ChatsPage;
    try {
      // Through `then`, so a source that throws before it has a promise to
      // hand back is the same failure as one that rejects.
      page = await Promise.resolve().then(() => source.listChats(query));
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        return reply.code(400).send({ error: 'invalid-cursor' });
      }
      return reply.code(503).send({ error: 'source-unavailable' });
    }

    return {
      threads: page.chats.map((chat) => toWire(source.channel, chat)),
      nextCursor: page.nextCursor,
      total: page.total,
      asOf: clock.now(),
    };
  });
  // GET, and fastify's auto-HEAD twin (route ratchet #27).
  app.get('/v1/threads/:guid/messages', async (req, reply) => {
    const params = pageParams.safeParse(req.params);
    const parsed = pageQuery.safeParse(req.query);
    if (!params.success || !parsed.success) {
      return reply.code(400).send({
        error: 'invalid-query',
        detail: {
          issues: [
            ...(params.success ? [] : params.error.issues),
            ...(parsed.success ? [] : parsed.error.issues),
          ],
        },
      });
    }
    const { guid } = params.data;
    const { limit, before, until } = parsed.data;
    const query: TurnsQuery = {
      chatGuid: guid,
      limit,
      ...(before !== undefined ? { before } : {}),
      ...(until !== undefined ? { until } : {}),
    };

    let page: TurnsPage;
    try {
      page = await Promise.resolve().then(() => source.readChatPage(query));
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        return reply.code(400).send({ error: 'invalid-cursor' });
      }
      if (err instanceof UnknownChatError) {
        return reply.code(404).send({ error: 'unknown-chat' });
      }
      return reply.code(503).send({ error: 'source-unavailable' });
    }

    return {
      chatGuid: guid,
      channel: source.channel,
      turns: page.turns.map(turnToWire),
      nextBefore: page.nextBefore,
      asOf: clock.now(),
    };
  });
}

/**
 * v2 S0: this module's request schemas, by name, for `contract.ts`'s
 * REQUEST_SCHEMAS and the contract ratchet. The same objects the handlers
 * above parse with: nothing is copied, so the published shape cannot drift
 * from the enforced one.
 */
export const threadSchemas = {
  listQuery,
  pageQuery,
  pageParams,
} as const;
