/**
 * `wemessage://` — the one surface of this app that any website can reach.
 *
 * A custom scheme is a global capability. Once it is registered, a page the
 * operator merely VISITS can navigate to it, a shell script can `open` it,
 * and another app can hand it to the OS. So the rule this file exists to
 * enforce is not "validate the input" but something stronger:
 *
 *   **A deep link may navigate and select. It may never act.**
 *
 * That is a statement about the TYPE, not about a handler's discipline. The
 * result of parsing carries a destination, an optional id to put the cursor
 * on, an optional echo of an id we could not resolve, and an optional reason
 * we refused. There is no verb in it. A future edit that wanted a URL to
 * approve a draft would have to widen this union first, in a diff, in a file
 * whose entire header says why not.
 *
 * Three further properties, all of them load-bearing:
 *
 *  - **Total.** `parseDeepLink` returns for every string. It is called from
 *    inside an `open-url` listener on the main process, with a string the
 *    attacker chose; a throw there is an unhandled failure at best.
 *  - **Pure.** This module imports nothing. It cannot fetch, cannot read the
 *    disk, cannot reach the daemon and cannot reach Electron. An arch row
 *    asserts the absence of each, so the argument survives the next edit.
 *  - **Closed.** The host is matched against an ARRAY, never against a chain
 *    of literals, and an unknown one is NAMED rather than fallen through.
 *    "You asked for the queue" and "we refused you and put you on the queue"
 *    are different facts and the caller gets to tell them apart.
 *
 * One word about the vocabulary. Everything here is spelled REFUSE, REFUSED,
 * REFUSAL, and never the queue's own verb for turning a draft down. That is
 * not style: an arch row bans every queue verb from this file as a blunt
 * substring, so that a URL grammar can never quietly acquire one, and the
 * first draft of this parser tripped that row on its own type names. The
 * repair was to rename rather than to carve an exemption into the guard — a
 * guard a legitimate caller has to be excused from is the wrong guard.
 *
 * The host list is a second projection of the renderer's screen registry,
 * spelled here rather than imported: main does not import the renderer (a
 * main-process security decision that a renderer edit could widen is not a
 * security decision), and an arch row cross-checks the two arrays so the
 * duplication cannot drift.
 */

/** The scheme this app claims from the OS. */
export const DEEP_LINK_SCHEME = 'wemessage';

/** What every accepted URL starts with, used by the argv scan below. */
export const DEEP_LINK_PREFIX = `${DEEP_LINK_SCHEME}://`;

/**
 * Every host a URL may name: the renderer's six screens and nothing else.
 *
 * `wizard` is deliberately absent. Sc15 made onboarding a MODE rather than a
 * destination — it kills the navigation keymap while it is up — and a URL
 * that could push somebody into a half-finished setup flow from a web page
 * is exactly the shape that mode exists to prevent.
 */
export const DEEP_LINK_HOSTS = [
  'queue',
  'rules',
  'schedule',
  'people',
  'audit',
  'settings',
] as const;

export type DeepLinkHost = (typeof DEEP_LINK_HOSTS)[number];

/**
 * Where a refused URL lands, and the only host with a path form.
 *
 * Read off the array rather than spelled a second time: an arch row asserts
 * each screen name appears EXACTLY ONCE in this file, because a second
 * spelling is how a seventh `if (host === …)` branch grows later.
 */
const QUEUE = DEEP_LINK_HOSTS[0];

/** Every reason a URL is refused. Closed, and reported rather than swallowed. */
export const DEEP_LINK_REFUSALS = [
  'too-long',
  'malformed',
  'foreign-scheme',
  'unknown-host',
  'unknown-path',
  'bad-draft-id',
] as const;

export type DeepLinkRefusal = (typeof DEEP_LINK_REFUSALS)[number];

/**
 * The ceiling, applied BEFORE the parser sees the string.
 *
 * `new URL` on a multi-megabyte string is work an attacker got us to do for
 * free, and every legitimate link this app can produce is under a hundred
 * characters. Measuring first is cheaper than measuring well.
 */
export const MAX_DEEP_LINK_LENGTH = 512;

/**
 * A parsed link.
 *
 * `screen` is always present, so a caller cannot forget the refusal case and
 * land nowhere. The other three are OMITTED rather than `undefined`-valued
 * (`exactOptionalPropertyTypes`), which is what lets the unit row assert the
 * union of result keys as a closed set.
 */
export interface DeepLink {
  readonly screen: DeepLinkHost;
  /** A draft id that passed the ULID shape. Never echoed, only selected. */
  readonly draftId?: string;
  /**
   * An id we could not resolve, echoed back so the operator can see what
   * they were sent. Bounded to 32 characters of `[0-9A-Za-z_-]`, which is
   * the only place in this scenario where a URL component survives at all.
   */
  readonly notFound?: string;
  readonly refused?: DeepLinkRefusal;
}

/** Crockford base32, 26 characters. Note the absent I, L, O and U. */
const ULID_SHAPE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

/**
 * What may be shown back to the operator when an id resolves to nothing.
 *
 * Deliberately narrower than "anything short": no punctuation, no space, no
 * percent, no angle bracket. The chip is set as an ATTRIBUTE rather than as
 * markup, so this is a second line of defence rather than the only one, but
 * a value that cannot contain a bracket cannot be talked into being markup
 * by a later renderer that forgets.
 */
const ECHOABLE = /^[0-9A-Za-z_-]{1,32}$/;

/** The one path form: `queue/draft/<id>`. */
const DRAFT_SEGMENT = 'draft';

const refuse = (refused: DeepLinkRefusal): DeepLink => ({
  screen: QUEUE,
  refused,
});

/**
 * Parse an untrusted URL into a destination.
 *
 * The order of the checks is the order of cost: length, then parse, then
 * scheme, then the credential/port fields that have no legitimate meaning
 * here, then query and fragment, then the host, then the path. Each refusal
 * names itself.
 */
export function parseDeepLink(raw: string): DeepLink {
  if (raw.length > MAX_DEEP_LINK_LENGTH) return refuse('too-long');

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // `''`, `'not a url at all'`, `'%'`, a port out of range: all of these
    // throw, and the throw is the answer rather than an exception to report.
    return refuse('malformed');
  }

  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return refuse('foreign-scheme');

  // `wemessage://user:pw@queue/` parses, with a host on the allowlist. There
  // is no meaning for a credential or a port in this grammar, so carrying
  // one is evidence the URL was built to be misread rather than to be used.
  if (url.username !== '' || url.password !== '' || url.port !== '')
    return refuse('unknown-host');

  // Neither is a parameter. Sc16 has no query grammar at all, and accepting
  // one silently would be the first half of growing one by accident.
  if (url.search !== '' || url.hash !== '') return refuse('unknown-path');

  // Probed rather than assumed: the WHATWG parser does NOT lowercase the
  // host of a non-special scheme, so `wemessage://QUEUE` arrives as `QUEUE`.
  // Case-folding would widen a six-member allowlist to hundreds of
  // spellings for no gain, so the match is literal and the set stays finite.
  const host = url.hostname;
  if (!(DEEP_LINK_HOSTS as readonly string[]).includes(host))
    return refuse('unknown-host');
  const screen = host as DeepLinkHost;

  const segments = url.pathname.split('/').filter((part) => part !== '');
  if (segments.length === 0) return { screen };

  // One path form, on one host. Everything else is refused rather than
  // guessed at — including a well-formed draft path under the wrong host,
  // which is how a grammar acquires five equivalent spellings.
  if (
    screen !== QUEUE ||
    segments.length !== 2 ||
    segments[0] !== DRAFT_SEGMENT
  )
    return refuse('unknown-path');

  let id: string;
  try {
    id = decodeURIComponent(segments[1] ?? '');
  } catch {
    // A lone `%` inside a segment survives the URL parser and fails here.
    return refuse('bad-draft-id');
  }

  if (ULID_SHAPE.test(id)) return { screen, draftId: id };
  // Not a ULID, but short and boring enough to show back. The caller does
  // NOT go and look it up: `GET /v1/drafts/<attacker's id>` would be a probe
  // this app performed on somebody else's behalf, and its 404 an oracle.
  if (ECHOABLE.test(id)) return { screen, notFound: id };
  return refuse('bad-draft-id');
}

/**
 * The same input arriving through the other door.
 *
 * On macOS a running app is handed a URL as `open-url`; a SECOND launch is
 * handed one in `argv` and forwarded to the first through the single-instance
 * lock. Finding the token is not the same as trusting it — the result still
 * goes through `parseDeepLink` — so this scan is deliberately dumb: the first
 * argument naming the scheme, or nothing.
 *
 * The scheme is matched case-insensitively HERE and nowhere else, because
 * RFC 3986 makes a scheme case-insensitive and the OS may hand it back in any
 * case. The host is not, and the parser above is what says so.
 */
export function deepLinkFromArgv(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (!arg.toLowerCase().startsWith(DEEP_LINK_PREFIX)) continue;
    // Measured once, here, so an oversized token never becomes a URL at all.
    return arg.length > MAX_DEEP_LINK_LENGTH ? null : arg;
  }
  return null;
}
