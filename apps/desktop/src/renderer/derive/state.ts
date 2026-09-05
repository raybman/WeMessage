/**
 * §3.10's vocabulary: every state this app can be in, spelled as a GLYPH and
 * as a WORD before anything is tinted.
 *
 * The rule is not "add a glyph as well as a colour". It is that colour is the
 * THIRD carrier and may not be the first: a reader who cannot separate the
 * tint from the neutral, or who is looking at a greyscale screenshot in a
 * support thread, still reads ○ against ● and PENDING against APPROVED. The
 * runtime sweep in Sc17 checks the hues; nothing checks that a hue MEANT
 * something except a table like this one and the e2e row that reads both
 * halves off every card on screen.
 *
 * The glyph set is closed and shared with the state strip:
 *
 *     ●  armed / decided / connected
 *     ○  held, waiting on a person
 *     ◐  partial — draft-only, reconnecting, read-only
 *     ⊘  refused or killed
 *     ◌  absent — disconnected, expired, superseded
 *     ◔  in flight
 *
 * Six glyphs for nine draft states, deliberately. `expired` and `superseded`
 * are the same fact to an operator (this card is no longer yours to act on)
 * and the WORD is what tells them apart; minting a seventh shape for a
 * distinction the word already carries would make the vocabulary harder to
 * learn for no gain.
 */
import type { DraftState } from '@wemessage/client';

export const STATE_GLYPH: Readonly<Record<DraftState, string>> = {
  pending: '○',
  approved: '●',
  sending: '◔',
  sent: '●',
  rejected: '⊘',
  recalled: '⊘',
  expired: '◌',
  superseded: '◌',
  failed: '⊘',
};

/**
 * The word, which is the carrier assistive technology actually gets.
 *
 * Identical to the state's own spelling, uppercased, and that is a decision
 * rather than laziness: the CLI prints these words, the audit trail stores
 * them and a support thread will quote one. A GUI that renamed `superseded`
 * to something friendlier would put a second vocabulary in front of the
 * operator and make the two impossible to search together (C-6).
 */
export const STATE_WORD: Readonly<Record<DraftState, string>> = {
  pending: 'PENDING',
  approved: 'APPROVED',
  sending: 'SENDING',
  sent: 'SENT',
  rejected: 'REJECTED',
  recalled: 'RECALLED',
  expired: 'EXPIRED',
  superseded: 'SUPERSEDED',
  failed: 'FAILED',
};

/** An adapter's liveness, as a dot. Unrecognised health reads as absent. */
export const HEALTH_GLYPH: Readonly<Record<string, string>> = {
  connected: '●',
  unknown: '◌',
  disconnected: '◌',
  unhealthy: '⊘',
};
