/**
 * v2 A1: `GET /v1/threads`, the conversations list the v2 messenger opens on.
 * v2 A2: `GET /v1/threads/:guid/messages`, one page of one conversation,
 * under every rule below; the list's cursor becomes the page's `before`.
 * v2 F5: `GET /v1/threads/by-handle/:handle`, the conversation a new draft
 * to that handle would land in, or null. The same lookup the send path
 * makes (the reader's `resolveChat`), asked before the draft rather than
 * after, so compose can refuse up front instead of failing at dispatch.
 * v2 F2c: `GET /v1/threads/:guid/years?tz=`, one conversation's turns
 * counted by year in the operator's zone, for the transcript's scrubber.
 * Through a closure (the reader's `yearCounts`), like F5's lookup.
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
  isValidTimeZone,
  normalizeHandle,
  UnknownChatError,
  type ChannelName,
  type ChannelSource,
  type ChatSummary,
  type ChatsPage,
  type ChatGuid,
  type ChatsQuery,
  type Clock,
  type Handle,
  type Service,
  type TranscriptTurn,
  type TurnDelivery,
  type TurnFile,
  type TurnKind,
  type TurnReaction,
  type TurnsPage,
  type TurnsQuery,
  type YearCount,
} from '@wemessage/core';
import { stripControlChars } from '../sanitize.js';

/** v2 F5: what the send path's lookup answers, by shape alone. */
export interface ResolvedChat {
  chatGuid: ChatGuid;
  service: Service;
  isGroup: boolean;
}

export interface ThreadRouteDeps {
  source: ChannelSource;
  clock: Clock;
  /**
   * v2 F5: the send path's own lookup, handed in as a closure so the route
   * never holds a reader (the port importer scan holds it to that). Read
   * only: it never mints a chat.
   */
  resolveChat: (handle: Handle) => Promise<ResolvedChat | null>;
  /**
   * v2 F2c: one chat's turns by year in `tz`, newest first. A closure for
   * the same reason as `resolveChat`. Throws UnknownChatError for a chat
   * the source never held.
   */
  yearCounts: (chatGuid: string, tz: string) => YearCount[];
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

// v2 F5. 320 bounds an email address with room to spare. A `;` is the chat
// guid's own separator: a handle carrying one is a guid smuggled in as a
// handle, and is refused rather than looked up.
const handleParams = z.strictObject({
  handle: z
    .string()
    .trim()
    .min(1)
    .max(320)
    .refine((h) => !h.includes(';'), { message: 'a handle has no ";"' }),
});

// v2 F2c. The zone is required: which year a turn falls in is the
// operator's zone's call, and the daemon has no zone of its own to assume.
// 64 bounds the longest IANA name with room to spare; a name Intl does not
// know is refused, not quietly read as UTC.
// Its own object, not pageParams again: the contract ratchet holds every
// exported schema to exactly one route, and a shared object would hide
// which route a later change to it moves.
const yearsParams = z.strictObject({ guid: z.string().min(1).max(512) });

const yearsQuery = z
  .strictObject({ tz: z.string().min(1).max(64) })
  .refine((q) => isValidTimeZone(q.tz), {
    message: 'tz is not an IANA time zone',
    path: ['tz'],
  });

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
  service?: Service;
  delivery?: TurnDelivery | null;
  reactions?: TurnReaction[];
  files?: WireTurnFile[];
}

/**
 * v2 F6: a file on the wire. The id joins the wire in F6c, with the Kit
 * that decodes it; until then the route copies every F4 field and no id.
 */
type WireTurnFile = Omit<TurnFile, 'id'> & { id?: string };

/** v2 F4: the longest file name the wire carries. */
const WIRE_FILE_NAME_MAX = 255;

/**
 * Every control character, \n and \t included: a file name is one line,
 * unlike a message text.
 */
const ALL_CONTROLS = /[\u0000-\u001F\u007F-\u009F]/g;

/**
 * v2 F4: a file name as the wire carries it. The last path component only
 * (a source may hand back a path; the wire never carries one), every
 * control character stripped, capped at 255. What is left empty, `.` or
 * `..` is no name.
 */
function fileNameToWire(raw: string | null): string | null {
  if (raw === null) return null;
  const last = raw.replace(ALL_CONTROLS, '').split('/').pop() ?? '';
  if (last.length === 0 || last === '.' || last === '..') return null;
  return last.slice(0, WIRE_FILE_NAME_MAX);
}

/** A free-text metadata field: controls stripped, empty is none. */
function metaToWire(raw: string | null): string | null {
  if (raw === null) return null;
  const v = raw.replace(ALL_CONTROLS, '');
  return v.length > 0 ? v : null;
}

/** v2 F4: one file's metadata, copied field by field. Never a path. */
function fileToWire(f: TurnFile): WireTurnFile {
  return {
    name: fileNameToWire(f.name),
    mime: metaToWire(f.mime),
    uti: metaToWire(f.uti),
    bytes: f.bytes,
    sticker: f.sticker,
    hidden: f.hidden,
  };
}

/** v2 F4: one reaction, copied field by field; the handle stripped. */
function reactionToWire(r: TurnReaction): TurnReaction {
  return {
    kind: r.kind,
    from: r.from,
    ...(r.from === 'them' && r.handle !== undefined
      ? { handle: stripControlChars(r.handle) }
      : {}),
  };
}

/**
 * v2 F4: a delivery, copied by state so nothing else rides along. Only an
 * outbound turn carries one: an inbound turn's is dropped, whatever the
 * source said.
 */
function deliveryToWire(d: TurnDelivery | null): TurnDelivery | null {
  if (d === null) return null;
  switch (d.state) {
    case 'sent':
      return { state: 'sent', at: null };
    case 'delivered':
      return { state: 'delivered', at: d.at };
    case 'read':
      return { state: 'read', at: d.at };
    case 'failed':
      return { state: 'failed', at: null, errorCode: d.errorCode };
  }
}

/**
 * Field by field, as for a list row; a text of only controls is none.
 * v2 F4: a key the source left out stays out (absent is "the source does
 * not say"); `[]` is "none".
 */
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
    ...(turn.service !== undefined ? { service: turn.service } : {}),
    ...(turn.from === 'me' && turn.delivery !== undefined
      ? { delivery: deliveryToWire(turn.delivery) }
      : {}),
    ...(turn.reactions !== undefined
      ? { reactions: turn.reactions.map(reactionToWire) }
      : {}),
    ...(turn.files !== undefined ? { files: turn.files.map(fileToWire) } : {}),
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
  // GET, and fastify's auto-HEAD twin (route ratchet #31). No audit row and
  // no broadcast: counting is a read, like the page beside it.
  app.get('/v1/threads/:guid/years', async (req, reply) => {
    const params = yearsParams.safeParse(req.params);
    const parsed = yearsQuery.safeParse(req.query);
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
    const { tz } = parsed.data;

    let years: YearCount[];
    try {
      years = await Promise.resolve().then(() => deps.yearCounts(guid, tz));
    } catch (err) {
      if (err instanceof UnknownChatError) {
        return reply.code(404).send({ error: 'unknown-chat' });
      }
      return reply.code(503).send({ error: 'source-unavailable' });
    }

    return {
      chatGuid: guid,
      tz,
      years: years.map((y) => ({
        year: y.year,
        count: y.count,
        first: y.first,
        last: y.last,
      })),
      asOf: clock.now(),
    };
  });
  // GET, and fastify's auto-HEAD twin (route ratchet #28). No audit row: a
  // lookup is a read, like the list. The answer's `handle` is the
  // normalized form, so "+1 (555) 010-0001" and "+15550100001" are one
  // handle on the wire as they are to the send path.
  app.get('/v1/threads/by-handle/:handle', async (req, reply) => {
    const params = handleParams.safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({
        error: 'invalid-handle',
        detail: { issues: params.error.issues },
      });
    }
    const handle = normalizeHandle(params.data.handle);

    let found: ResolvedChat | null;
    try {
      found = await Promise.resolve().then(() => deps.resolveChat(handle));
    } catch {
      return reply.code(503).send({ error: 'source-unavailable' });
    }

    return {
      handle,
      conversation:
        found === null
          ? null
          : {
              chatGuid: found.chatGuid,
              service: found.service,
              isGroup: found.isGroup,
            },
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
  handleParams,
  yearsParams,
  yearsQuery,
} as const;
