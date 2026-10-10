/**
 * v2 F2b: `GET /v1/search`, message search over the daemon's own mirror.
 *
 * The app parses what the operator typed (one parser, in the app) and sends
 * the tokens as structured, repeatable query keys. This route compiles them
 * (core's `compileSearch`), asks the store's index, and answers one page of
 * hits plus the whole truth about what was searched: every token comes back
 * in `coverage.tokens` as applied, partial or not-applied with a reason, and
 * every channel says searched or not-searched. Nothing is dropped silently.
 *
 * A read, and only a read:
 *  - No audit row and no broadcast. Looking is not an action.
 *  - The operator's bearer only. An adapter token is refused by the server's
 *    hook like any other non-operator token, and /v1/agent hears nothing.
 *  - chat.db is reached only through the closures handed in (titles, the
 *    `in:` lookup, the deleted-in-Messages check), never a reader, so the
 *    port-importer allowlist does not grow. A closure that throws degrades
 *    the answer and the coverage says how; it never fails the search.
 *  - The wire carries a hit's own fields, built one by one: never the
 *    mirror's `meta`, which holds attachment paths.
 *
 * The daemon does not cancel a search. better-sqlite3 is synchronous, so a
 * query is bounded instead: the match cap (D-F2-4) and the perf budgets.
 * Paging re-runs the query and continues after the cursor's key; the
 * cursor carries a digest of the query, so a cursor reused under a
 * different query (or zone) is refused, never misapplied.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  compileSearch,
  InvalidCursorError,
  isAfterKey,
  isEmptySearch,
  isValidTimeZone,
  mintSearchCursor,
  readSearchCursor,
  SEARCH_CHANNELS,
  SEARCH_HIT_TEXT_MAX,
  SEARCH_PAGE_MAX,
  searchQueryHash,
  senderFacets,
  yearFacets,
  type ChannelCoverage,
  type ChatGuid,
  type Clock,
  type Handle,
  type MessageGuid,
  type MirrorMatch,
  type SearchKey,
  type SearchPageWire,
  type SearchParams,
  type SearchHitWire,
  type Store,
} from '@wemessage/core';
import { stripControlChars } from '../sanitize.js';

export interface SearchRouteDeps {
  clock: Clock;
  /** The index, its coverage, and the saved names `from:` matches. */
  store: Pick<Store, 'searchMirror' | 'searchCoverage' | 'listContactPolicies'>;
  /** Titles for the chats on one page of hits. May throw: titles go null. */
  chatTitles: (
    guids: readonly ChatGuid[],
  ) => Map<string, { title: string; isGroup: boolean }>;
  /** The chats an `in:` token names. May throw: the token is not applied. */
  chatsTitled: (needle: string) => ChatGuid[];
  /** Which hit guids Messages still holds. May throw: deletions unchecked. */
  existingGuids: (guids: readonly MessageGuid[]) => Set<string>;
}

/** Keys that may repeat. Fastify hands one value as a string, two as an array. */
const REPEATABLE = ['term', 'channel', 'has'] as const;

// strictObject: an unknown key is refused (fail closed). Every bound is a
// bound on work: 8 terms, 4 channels, 3 has, 100 a page.
const searchQuery = z
  .strictObject({
    term: z.array(z.string().trim().min(1).max(200)).max(8).default([]),
    from: z.string().trim().min(1).max(200).optional(),
    in: z.string().trim().min(1).max(200).optional(),
    channel: z.array(z.enum(SEARCH_CHANNELS)).max(4).default([]),
    has: z
      .array(z.enum(['attachment', 'link', 'voice']))
      .max(3)
      .default([]),
    before: z.iso.datetime({ offset: true }).optional(),
    after: z.iso.datetime({ offset: true }).optional(),
    tz: z.string().min(1).max(64),
    limit: z.coerce.number().int().min(1).max(SEARCH_PAGE_MAX).default(50),
    cursor: z.string().min(1).max(512).optional(),
  })
  // Not in the published JSON Schema (a refine is code, not shape); the
  // contract notes carry it in words.
  .refine((q) => isValidTimeZone(q.tz), {
    message: 'tz is not an IANA time zone',
    path: ['tz'],
  });

/** One value or many, as an array; anything else is left for zod to refuse. */
function normaliseRepeats(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const q: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const key of REPEATABLE) {
    if (typeof q[key] === 'string') q[key] = [q[key]];
  }
  return q;
}

/** Case and accents folded, as the index and the `in:` lookup fold them. */
function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** An instant, written the one way `sent_at` is written: UTC, milliseconds. */
function toUtc(iso: string): string {
  return new Date(iso).toISOString();
}

function hitText(raw: string | null): string | null {
  if (raw === null) return null;
  const text = stripControlChars(raw).slice(0, SEARCH_HIT_TEXT_MAX);
  return text.trim().length > 0 ? text : null;
}

/** One hit, field by field. `meta` is never read, so it never leaks. */
function hitToWire(
  m: MirrorMatch,
  title: { title: string; isGroup: boolean } | undefined,
): SearchHitWire {
  return {
    guid: m.guid,
    chatGuid: m.chatGuid,
    title: title === undefined ? null : stripControlChars(title.title),
    isGroup: title?.isGroup ?? m.isGroup,
    channel: 'imessage',
    from: m.isFromMe ? 'me' : 'them',
    handle: m.isFromMe ? null : stripControlChars(m.handle),
    text: hitText(m.text),
    sentAt: m.sentAt,
    hasAttachment: m.hasAttachment,
  };
}

export function registerSearchRoutes(
  app: FastifyInstance,
  deps: SearchRouteDeps,
): void {
  const { clock, store } = deps;

  // GET, and fastify's auto-HEAD twin (route ratchet #30).
  app.get('/v1/search', async (req, reply) => {
    // One value or many, as an array, before the one parse site.
    req.query = normaliseRepeats(req.query);
    const parsed = searchQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid-search',
        detail: { issues: parsed.error.issues },
      });
    }
    const a = parsed.data;
    const params: SearchParams = {
      terms: a.term,
      ...(a.from === undefined
        ? {}
        : { from: a.from === 'me' ? { me: true as const } : { name: a.from } }),
      ...(a.in === undefined ? {} : { in: a.in }),
      channels: [...new Set(a.channel)],
      has: [...new Set(a.has)],
      ...(a.before === undefined ? {} : { before: toUtc(a.before) }),
      ...(a.after === undefined ? {} : { after: toUtc(a.after) }),
    };
    if (isEmptySearch(params)) {
      return reply.code(400).send({ error: 'empty-search' });
    }

    const hash = searchQueryHash(params, a.tz);
    let after: SearchKey | null = null;
    if (a.cursor !== undefined) {
      try {
        after = readSearchCursor(a.cursor, hash);
      } catch (err) {
        if (err instanceof InvalidCursorError) {
          return reply.code(400).send({ error: 'invalid-cursor' });
        }
        throw err;
      }
    }

    // What compile needs from outside core, each read allowed to fail.
    let chatGuids: ChatGuid[] | null = [];
    if (params.in !== undefined) {
      try {
        chatGuids = deps.chatsTitled(params.in);
      } catch {
        chatGuids = null;
      }
    }
    let savedHandles: Handle[] = [];
    if (params.from !== undefined && 'name' in params.from) {
      const want = fold(params.from.name);
      savedHandles = store
        .listContactPolicies()
        .filter(
          (c) =>
            c.displayName !== undefined && fold(c.displayName).includes(want),
        )
        .map((c) => c.handle);
    }

    const { q, tokens } = compileSearch(params, { chatGuids, savedHandles });
    const result =
      q === null
        ? { matches: [], capped: false, shortTermWindowed: false }
        : store.searchMirror(q);
    const matches = result.matches;

    // One page: the next `limit` candidates after the cursor's key, less
    // any Messages no longer holds.
    const rest =
      after === null ? matches : matches.filter((m) => isAfterKey(m, after));
    const candidates = rest.slice(0, a.limit);
    let deletionsChecked = true;
    let kept = candidates;
    if (candidates.length > 0) {
      try {
        const there = deps.existingGuids(candidates.map((m) => m.guid));
        kept = candidates.filter((m) => there.has(m.guid));
      } catch {
        deletionsChecked = false;
      }
    }
    const last = candidates[candidates.length - 1];
    const nextCursor =
      rest.length > a.limit && last !== undefined
        ? mintSearchCursor({ sentAt: last.sentAt, guid: last.guid }, hash)
        : null;

    let titles = new Map<string, { title: string; isGroup: boolean }>();
    if (kept.length > 0) {
      try {
        titles = deps.chatTitles([...new Set(kept.map((m) => m.chatGuid))]);
      } catch {
        titles = new Map();
      }
    }

    const channels: ChannelCoverage[] = SEARCH_CHANNELS.map((channel) => {
      if (channel !== 'imessage') {
        return { channel, state: 'not-searched', reason: 'no-source' };
      }
      if (q === null) {
        return { channel, state: 'not-searched', reason: 'not-requested' };
      }
      const cov = store.searchCoverage();
      return {
        channel,
        state: 'searched',
        indexed: cov.indexed,
        eligible: cov.eligible,
        indexedThroughRowid: cov.throughRowid,
        mirrorAsOf: cov.mirrorAsOf,
      };
    });

    const page: SearchPageWire = {
      hits: kept.map((m) => hitToWire(m, titles.get(m.chatGuid))),
      total: matches.length,
      nextCursor,
      asOf: clock.now(),
      facets: {
        years: yearFacets(
          matches.map((m) => m.sentAt),
          a.tz,
        ),
        channels:
          matches.length > 0
            ? [{ channel: 'imessage', count: matches.length }]
            : [],
        senders: senderFacets(matches),
      },
      coverage: {
        channels,
        tokens,
        capped: result.capped,
        deletedHidden: candidates.length - kept.length,
        deletionsChecked,
      },
    };
    return page;
  });
}

/**
 * This module's request schema, for `contract.ts`'s REQUEST_SCHEMAS. The
 * same object the handler parses with, so the published shape cannot drift
 * from the enforced one.
 */
export const searchSchemas = { searchQuery } as const;
