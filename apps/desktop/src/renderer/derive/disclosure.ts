/**
 * s10 Slice 6: what the Welcome step promises, as data.
 *
 * Two claims, both checked against the code rather than the marketing:
 *
 *  - Approval. Every send goes through `dispatchApproved`, which refuses a
 *    draft with no Approval row, and an approval binds the body it was
 *    given (s10 Slice 4). Rules that auto-approve are rules the operator
 *    wrote, so the sentence stays true with automation switched on.
 *  - What leaves the Mac. Neither the app nor the daemon opens a socket to
 *    anything but loopback. Two things do leave, and the list says so: an
 *    approved message, through Messages, and the text of an inbound
 *    message a rule routes to an agent the operator connected. What that
 *    agent does with it is the agent's traffic, and the list says that too,
 *    because "no message content leaves your Mac" is false the moment the
 *    agent is a cloud model.
 */

/** One line, quoted by the Welcome step and asserted by its e2e row. */
export const APPROVAL_LINE = 'You approve every message.';

export interface LeavesRow {
  /** What crosses the boundary. */
  readonly what: string;
  /** Where it goes, and through whom. */
  readonly where: string;
}

/** Total: an item not here does not leave this Mac. */
export const LEAVES_THIS_MAC: readonly LeavesRow[] = [
  {
    what: 'A message you approved',
    where:
      'Handed to Messages, which sends it through Apple exactly as if you had typed it.',
  },
  {
    what: 'An incoming message a rule sends to an agent',
    where:
      'Goes to the agent you connected, and only that one. If that agent uses a cloud model, it sends the text there; that is the agent’s traffic, not this app’s.',
  },
  {
    what: 'Nothing else',
    where:
      'No account, no analytics, no crash reports, no update check. The app and the daemon talk to each other over loopback and to nothing else.',
  },
];
