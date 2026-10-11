/**
 * v2 B0: which message channels this daemon serves, carried on
 * `GET /v1/status` as `channels: [{ channel, state, reason? }]`.
 *
 * Status is the carrier, not `GET /v1/adapters`: that route lists AGENT
 * adapters (echo, sol, hermes), and a channel is not an agent.
 *
 * The output union is the whole point of this module. `state` is
 * `'connected' | 'not_connected'` and nothing else: a third state the GUI
 * knows about, the one that renders a channel's board over fixture data, is
 * served by the Swift fake daemon from fixture JSON and has no spelling
 * anywhere in this package (`test/channels-status.spec.ts` proves it). The
 * released app talks to this daemon only, so that board state cannot reach a
 * user.
 *
 * `connected` says this version reads the channel at all. Whether it can read
 * it right now is `connectionState`, a separate field with its own probe.
 * iMessage is the one channel this version reads; the other three are named
 * so the GUI can say why their boards are empty instead of guessing.
 */
import { z } from 'zod';

/** The channels a thread can arrive on, in rail order. */
export const CHANNEL_NAMES = [
  'imessage',
  'whatsapp',
  'linkedin',
  'email',
] as const;

/** Why a channel is not connected. One reason exists in this version. */
export const NOT_CONNECTED_REASONS = ['not_in_this_version'] as const;

/**
 * v2 F7: the iMessage channel's live facts. They ride on the connected
 * iMessage entry only; a not_connected channel never carries them (an
 * absent count is not a zero).
 *
 *  - `lastSyncAt`: the daemon-clock end of the last chat.db read (the
 *    cursor's lastScanAt), null before the first. It means "last read", not
 *    "last new row".
 *  - `today`: messages sent since local midnight in the daemon's zone.
 *  - `handle`: the operator's own iMessage address as chat.db stores it on
 *    their newest sent row, held in memory only. Null when unknown.
 */
export interface ImessageLive {
  lastSyncAt: string | null;
  today: number;
  handle: string | null;
}

/** One channel's entry, exactly as the wire carries it. */
export const channelStatusSchema = z.strictObject({
  channel: z.enum(CHANNEL_NAMES),
  state: z.enum(['connected', 'not_connected']),
  reason: z.enum(NOT_CONNECTED_REASONS).optional(),
  lastSyncAt: z.iso.datetime().nullable().optional(),
  today: z.number().int().nonnegative().optional(),
  handle: z.string().min(1).max(320).nullable().optional(),
});

/** The status payload's `channels` list: one entry per channel, rail order. */
export const channelsSchema = z.array(channelStatusSchema);

export type ChannelStatusEntry = z.infer<typeof channelStatusSchema>;

/**
 * The daemon's answer. Parsed through the schema on the way out, so an entry
 * the union does not admit throws here instead of reaching a client. `live`
 * is the iMessage facts (F7); a branch with nothing to derive them from
 * passes none and the entry carries none.
 */
export function channelStatuses(live?: ImessageLive): ChannelStatusEntry[] {
  return channelsSchema.parse(
    CHANNEL_NAMES.map((channel) =>
      channel === 'imessage'
        ? {
            channel,
            state: 'connected',
            ...(live === undefined
              ? {}
              : {
                  lastSyncAt: live.lastSyncAt,
                  today: live.today,
                  handle: live.handle,
                }),
          }
        : { channel, state: 'not_connected', reason: 'not_in_this_version' },
    ),
  );
}
