/**
 * s7-execution Scenario 9 — the Luna Gen-2 `ChannelAdapter` contract, as this
 * repo understands it.
 *
 * **THIS IS A TRANSCRIPTION, NOT AN IMPORT. NOT LIVE-VERIFIED.**
 * Transcribed 2026-09-05 from `docs/plans/research-digest.md` §4 (Luna) and
 * `docs/plans/plan.md` §3.6.3. There is no Luna source in this tree, no Luna
 * package on this machine, and nothing in this repo has ever imported a
 * symbol from Luna or exchanged a byte with one. Every declaration below was
 * typed by hand from prose notes about a codebase that lives somewhere else.
 *
 * That distinction is the whole reason this file is separate from
 * `index.ts`. An imported contract is a fact: it breaks the build the day
 * upstream changes it. A transcribed contract is a BELIEF, and a belief that
 * looks like a fact is the failure mode worth spending a file on. So:
 *
 *  - `LUNA_CONTRACT_CLAIMS` below classifies every member as `transcribed`
 *    (it appears in a source this repo holds, cited) or `assumed` (we made it
 *    up because the adapter needed something there). The assumptions are
 *    republished in `README.md`, derived from this array, so a reader of the
 *    public docs is told which half is a guess before they rely on it.
 *  - Nothing here is exported to the daemon. The gateway's core is
 *    adapter-blind (INV-1); these types travel no further than this package.
 *  - There is no `send`. Luna's output is a completion, and a completion is a
 *    DRAFT (INV-2). The contract cannot express "deliver this to a human's
 *    phone" because the protocol on the other side has no frame for it.
 *
 * When a Luna install becomes reachable, the honest fix is to delete the
 * transcription and import the real thing, and let the compiler tell us how
 * much of the below was wrong.
 */

/**
 * Luna's transport discriminator.
 *
 * ASSUMED. The digest records that a `TransportKind` enum exists and that
 * channels are registered with one; it does not record the enum's members.
 * `'websocket'` is the member this adapter would need, spelled the way the
 * rest of the enum is *probably* spelled. If upstream calls it `WebSocket`,
 * `ws`, or `TransportKind.WebSocket`, this is a one-word fix and the wire
 * behaviour is unaffected — nothing in the frame path reads it.
 */
export type LunaTransportKind = 'websocket';

/**
 * What Luna hands the adapter when a human's message arrives.
 *
 * The field names are ours. The direction is not: the digest is explicit that
 * a channel receives inbound and answers through `deliver()`, which is the
 * only structural claim this interface makes.
 */
export interface LunaInboundMessage {
  readonly chatGuid: string;
  readonly handle: string;
  readonly text: string;
  /** Apple's message identity, carried through so replies can correlate. */
  readonly inboundGuid: string | undefined;
  /** Lowercase, always: the normalised vocabulary, not Apple's casing. */
  readonly service: string;
  /**
   * The channel itself, so Luna can answer the message it was handed rather
   * than looking one up. This is the seam that makes `deliver()` reachable
   * from inside a host that knows nothing about the gateway.
   */
  readonly channel: Pick<LunaChannelAdapterContract, 'deliver'>;
}

/**
 * What Luna hands back. `chatGuid` and `text` are the two fields this adapter
 * reads; anything else Luna carries is accepted and ignored, because there is
 * no frame to put it in.
 *
 * The open index signature is deliberate and is itself an INV-2 statement: a
 * Luna that decorates its output with `action: 'send'`, a recipient, or a
 * priority flag does not thereby acquire a send path. Those keys land here,
 * are never read, and never reach the wire.
 */
export interface LunaOutboundMessage {
  readonly chatGuid: string;
  readonly text: string;
  readonly [extra: string]: unknown;
}

/**
 * The host side of the seam: whatever object inside Luna the adapter calls
 * when a message arrives.
 *
 * ASSUMED, including the name. The digest names the direction from Luna into
 * the channel (`deliver`) and nothing at all about the direction from the
 * channel into Luna. `receive` is our word for it, injected rather than
 * imported precisely so the wrong guess costs one adapter file and not the
 * gateway.
 */
export interface LunaChannelHost {
  receive(inbound: LunaInboundMessage): Promise<void>;
}

/**
 * The Gen-2 `ChannelAdapter` contract, transcribed.
 *
 * `start()` and `deliver()` are from the digest. `stop()` is ASSUMED — a
 * lifecycle with a start and no stop would be unusual, but "unusual" is not
 * "documented", and the adapter needs somewhere to close its socket.
 */
export interface LunaChannelAdapterContract {
  readonly transport: LunaTransportKind;
  /**
   * Bring the channel up. Resolves when the channel is live OR when it is
   * disabled; it does NOT reject on a missing credential, which is the one
   * behaviour the digest states outright (see `LUNA_CONTRACT_CLAIMS`).
   */
  start(): Promise<void>;
  /** Answer the open inbound for `msg.chatGuid` with a draft. */
  deliver(msg: LunaOutboundMessage): Promise<void>;
  /** Take the channel down. Idempotent. */
  stop(): Promise<void>;
}

/** What a channel says about itself when asked. */
export type LunaChannelState =
  'idle' | 'disabled' | 'starting' | 'connected' | 'stopped';

/* ── the provenance ledger ─────────────────────────────────────────────── */

/** A claim we transcribed from a source this repo holds, with the citation. */
export interface TranscribedClaim {
  readonly claim: string;
  readonly basis: 'transcribed';
  readonly source: string;
}

/** A claim we invented. `settledBy` says what would turn it into a fact. */
export interface AssumedClaim {
  readonly claim: string;
  readonly basis: 'assumed';
  readonly source: null;
  readonly settledBy: string;
}

export type LunaContractClaim = TranscribedClaim | AssumedClaim;

/**
 * Every load-bearing statement this package makes about Luna, and where it
 * came from.
 *
 * The `assumed` half is republished in the README under
 * `LUNA_ASSUMPTION_HEADING`, and a test derives that section from this array,
 * so an assumption cannot be quietly promoted to a fact by editing prose. The
 * `transcribed` half cites `research-digest §4` or `plan §3.6.3` — the only
 * two sources this repo actually holds. Both of those are themselves
 * second-hand notes about a repo nobody here has opened, which is why even a
 * cited claim buys `conformance-only` and not `live-verified`.
 */
export const LUNA_CONTRACT_CLAIMS: readonly LunaContractClaim[] = [
  {
    claim: '`start()` brings a channel up and `deliver()` answers an inbound',
    basis: 'transcribed',
    source: 'research-digest §4',
  },
  {
    claim: 'a missing token disables that channel only and never bricks boot',
    basis: 'transcribed',
    source: 'research-digest §4',
  },
  {
    claim: 'an enum named `TransportKind` discriminates a channel transport',
    basis: 'transcribed',
    source: 'research-digest §4',
  },
  {
    claim:
      'the secret resolver chain is routedOp, filePath, keychain, lunaVault, env',
    basis: 'transcribed',
    source: 'research-digest §4',
  },
  {
    claim: 'channels are registered in the `apps/ui-web` chat server',
    basis: 'transcribed',
    source: 'research-digest §4',
  },
  {
    claim: 'the output is completion-shaped, so streaming is deferred',
    basis: 'transcribed',
    source: 'plan §3.6.3',
  },
  {
    claim: 'one completion becomes exactly one `draft.submit`',
    basis: 'transcribed',
    source: 'plan §3.6.3',
  },
  {
    claim: '`stop()` exists on the channel lifecycle',
    basis: 'assumed',
    source: null,
    settledBy: "reading Luna's `packages/channels` on a vanguard install",
  },
  {
    claim: '`websocket` is a member of that transport enum',
    basis: 'assumed',
    source: null,
    settledBy: 'reading the enum members',
  },
  {
    claim: 'the object handed back carries a chat identifier and a text body',
    basis: 'assumed',
    source: null,
    settledBy: "reading one real channel's call site",
  },
  {
    claim: 'the lifecycle methods are promise-returning rather than callbacks',
    basis: 'assumed',
    source: null,
    settledBy: 'reading the interface',
  },
  {
    claim: 'a channel with no credential reports the state word `disabled`',
    basis: 'assumed',
    source: null,
    settledBy: 'reading the state vocabulary, if one is even exposed',
  },
  {
    claim:
      'Luna is entered through a single inbound method, called `receive` here',
    basis: 'assumed',
    source: null,
    settledBy: 'reading the host side of any existing channel',
  },
];

/**
 * The README heading under which the assumptions above are republished.
 *
 * Exported so the test can find the section without a regex over prose, and
 * so renaming the section is a compile-adjacent edit rather than a silent
 * one.
 */
export const LUNA_ASSUMPTION_HEADING =
  '## What is transcribed, and what is a guess';
