/**
 * The gateway: the app's ONE connection to the daemon, and the only place
 * an IPC channel becomes an HTTP call.
 *
 * §2.5 — the GUI is a thin client. It holds no domain logic, no retry policy
 * of its own and no second transport: every verb below is one call into
 * `@wemessage/client`, and `test/arch.spec.ts` row 3 enforces the absence of
 * anything else by banning the raw HTTP entry point, the socket constructor,
 * a scheme-plus-loopback literal and an auth header anywhere under
 * `apps/desktop/src`. That row is a text scan, so the banned spellings do
 * not appear in this comment either.
 *
 * INV-2 lives here too, by NOT living here. The only path to the send port
 * in this system is `dispatchApproved` inside the daemon, reached by
 * approving a draft. This process approves drafts; it does not send. The one
 * exception is the wizard's self-message test (§1.7, Sc 15), which is a
 * single channel, refused unless the wizard armed it, and the reason this
 * file is the only file in the app allowed to name the client's send verb —
 * `arch.spec.ts` row 7 asserts exactly that, repo-wide.
 *
 * The handler table is a TOTAL `Record<RequestKey, …>`. A channel added to
 * `ipc-channels.ts` without an implementation is a compile error here, and
 * an implementation without a channel cannot be registered, which is the
 * compile-time half of the closure the e2e asserts at run time.
 */
import { ipcMain, shell } from 'electron';
import {
  createClient,
  DaemonConflictError,
  DaemonGateDeniedError,
  type BulkSelector,
  type ContactMode,
  type DisconnectInput,
  type RespondMode,
  type RuleInput,
  type RuleTestInput,
  type ScheduleInput,
  type SettingPatchValue,
  type WeMessageClient,
} from '@wemessage/client';
import type { Bootstrap } from './auth.js';
import {
  createEventStream,
  createResync,
  type EventStream,
  type StreamStatus,
} from './event-stream.js';
import { CHANNELS, REQUEST_KEYS, type RequestKey } from './ipc-channels.js';
import {
  isDemoMode,
  isSystemSettingsPane,
  SYSTEM_SETTINGS_PANES,
  type DownReason,
} from './policy.js';
import { pushToWindows } from './window.js';

/**
 * What the renderer knows about the connection, and nothing more.
 *
 * A discriminated union rather than an options bag: `exactOptionalProperty
 * Types` makes "connected, with no arming information" and "connected, with
 * arming information that happens to be absent" different types, and the
 * state strip must never have to guess which one it received.
 */
type Link =
  | { readonly state: 'connected' }
  | { readonly state: 'reconnecting'; readonly attempt: number }
  | {
      readonly state: 'down';
      readonly reason: DownReason;
      readonly tokenPath: string;
    };

/**
 * One adapter's identity and liveness, for the strip's dots.
 *
 * `health` is a string rather than the client's `AdapterHealth` because this
 * value is narrowed out of `StatusPayload.adapters`, which the DTO types as
 * `unknown[]`. Widening it back to the union here would be a cast asserting
 * something the type system has not been shown, and the renderer maps an
 * unrecognised word to the "we do not know" glyph anyway.
 */
export interface AdapterDot {
  readonly id: string;
  readonly health: string;
}

/**
 * The three facts that are true of the app regardless of the link.
 *
 * `armed` moved out of the `connected` arm in s8 Sc6 and it was a mistake to
 * have it there: the OUTBOUND axis ("may this daemon speak") and the LINK
 * axis ("can we hear it") are independent, and the strip has to say both.
 * A `read-only` daemon on a perfectly healthy socket is the case that proves
 * it — the old shape could only render that as `connected`, which is true
 * about the link and a lie about the product.
 *
 * `until` rides with the reason because §1.3.6's horizon belongs to the
 * ArmingState as a whole, not to the winning hold: a renderer handed a
 * reason and no horizon would have to invent one to say "until when".
 */
interface StreamCommon {
  readonly demo: boolean;
  readonly armed: {
    readonly reason: string;
    readonly until: string | null;
  } | null;
  readonly adapters: readonly AdapterDot[];
}

export type StreamPayload =
  | ({ readonly state: 'connected' } & StreamCommon)
  | ({
      readonly state: 'reconnecting';
      readonly attempt: number;
    } & StreamCommon)
  | ({
      readonly state: 'down';
      readonly reason: DownReason;
      readonly tokenPath: string;
    } & StreamCommon);

export interface Gateway {
  /** Connect, register the handlers, and push the first stream state. */
  start(): Promise<void>;
  /** The last state pushed, replayed when a window finishes loading. */
  lastStream(): StreamPayload;
  /**
   * Nominate the handle the wizard's send test may reach, or `null` to take
   * the permission away again. Sc 15's step 5 is the only caller there will
   * ever be, and the e2e proves the un-armed state refuses.
   */
  armSendTest(handle: string | null): void;
  stop(): Promise<void>;
}

type Handler = (args: readonly unknown[]) => Promise<unknown>;

/* ── argument readers ─────────────────────────────────────────────────── */

/**
 * IPC is a trust boundary even when both sides are ours: the renderer runs
 * remote-ish content and a compromised one can invoke any channel with any
 * argument. These readers refuse the shape; the daemon still validates the
 * meaning, and neither is a substitute for the other.
 */
function str(args: readonly unknown[], i: number): string {
  const value = args[i];
  if (typeof value !== 'string') throw new Error(`bad-argument:${String(i)}`);
  return value;
}

function bool(args: readonly unknown[], i: number): boolean {
  const value = args[i];
  if (typeof value !== 'boolean') throw new Error(`bad-argument:${String(i)}`);
  return value;
}

function record(args: readonly unknown[], i: number): Record<string, unknown> {
  const value = args[i];
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`bad-argument:${String(i)}`);
  return value as Record<string, unknown>;
}

/** An optional object argument: absent, or a record. */
function maybeRecord(
  args: readonly unknown[],
  i: number,
): Record<string, unknown> | undefined {
  return args[i] === undefined ? undefined : record(args, i);
}

export interface GatewayOptions {
  bootstrap: Bootstrap;
}

export function createGateway(options: GatewayOptions): Gateway {
  const { bootstrap } = options;
  let client: WeMessageClient | null = null;
  let events: EventStream | null = null;
  let stopped = false;
  /**
   * Whether this process has ever had a working subscription.
   *
   * Before the first one, a failed attempt is a SETUP problem and the
   * operator is owed the card that says what is wrong. After it, the same
   * failure is an interruption and the operator is owed the strip that says
   * we are getting it back. Same event, different sentence, and the
   * difference is entirely about what the operator can usefully do next.
   */
  let everConnected = false;
  /**
   * The two axes, kept apart.
   *
   * `link` is what the event stream reports; `armed` and `adapters` are what
   * the daemon reports about ITSELF. They move independently and on different
   * events, so they are stored independently and composed at push time. A
   * single mutable payload would make "reconnecting" quietly erase the arming
   * word, and the operator would watch the reason for the silence disappear
   * at the exact moment they most wanted it.
   */
  let link: Link = {
    state: 'down',
    reason: 'no-token',
    tokenPath: bootstrap.tokenPath,
  };
  let armed: StreamPayload['armed'] = null;
  let adapters: readonly AdapterDot[] = [];
  /**
   * Read once, at construction, from the process that owns the environment.
   * The renderer never sees `process`, and a demo badge that could be turned
   * on from inside a Chromium process would be a badge that could be turned
   * OFF from inside one.
   */
  const demo = isDemoMode(process.env);
  let stream: StreamPayload = { ...link, demo, armed, adapters };

  /**
   * The wizard's send-test target, armed by the wizard and by nothing else.
   *
   * `null` at boot and `null` for the whole of this scenario: Sc 15 owns the
   * wizard's step 5 and is what will call `armSendTest`. Until then the
   * channel exists, is registered, and refuses — which is the state the e2e
   * asserts, because a channel that is only safe while it is unimplemented
   * is a channel nobody has actually guarded.
   */
  let sendTestTarget: string | null = null;

  const down = (reason: DownReason): void => {
    push({ state: 'down', reason, tokenPath: bootstrap.tokenPath });
  };

  function push(next: Link): void {
    link = next;
    stream = { ...next, demo, armed, adapters };
    pushToWindows(CHANNELS.stream, stream);
  }

  /**
   * One adapter row, narrowed out of `StatusPayload.adapters['unknown']`.
   *
   * A row that is not an object, or has no string `id`, contributes nothing:
   * a dot with no identity is a dot the operator cannot act on, and inventing
   * an index for it would put a fake adapter on the strip.
   */
  function asDot(value: unknown): AdapterDot | null {
    if (typeof value !== 'object' || value === null) return null;
    const row = value as Record<string, unknown>;
    if (typeof row['id'] !== 'string') return null;
    return {
      id: row['id'],
      health: typeof row['health'] === 'string' ? row['health'] : 'unknown',
    };
  }

  /**
   * Re-read the daemon's own posture and re-push the CURRENT link state.
   *
   * A FETCH rather than a fold of the event that prompted it. `arming.changed`
   * carries `from` and `to`, and `toggle.changed` carries one key's value:
   * either could be folded into a local copy of the arming state, and both
   * folds would be reconstructing a §1.3.6 precedence order that lives in the
   * daemon. The daemon is one loopback request away and is the only thing
   * entitled to answer "what is the posture now".
   *
   * Event-driven, and deliberately not polled: the app owns exactly one
   * timer (the reconnect ladder's backoff) and a strip that refreshed on an
   * interval would be the second, for a fact that already has an event.
   */
  async function refreshStatus(live: WeMessageClient): Promise<void> {
    try {
      const status = await live.status();
      armed =
        status.armed === null
          ? null
          : { reason: status.armed.reason, until: status.armed.until };
      adapters = status.adapters
        .map((row) => asDot(row))
        .filter((dot): dot is AdapterDot => dot !== null);
    } catch {
      // Leave the last known posture in place. A status route that is not
      // answering is not evidence that the hold has lifted, and clearing the
      // arming word on a failed fetch would say it had.
      return;
    }
    push(link);
  }

  function requireClient(): WeMessageClient {
    if (client === null) throw new Error('daemon-unavailable');
    return client;
  }

  /**
   * A draft action's two EXPECTED refusals, as data rather than as a throw.
   *
   * 409 ("somebody else moved it") and 403 ("the gate said no") are not
   * faults, they are answers, and they are the two things an optimistic
   * renderer has to be able to tell apart in order to put a card back where
   * it belongs. An `Error` crossing IPC arrives as a string with a mangled
   * message, so a renderer forced to parse it would be reconstructing the
   * daemon's vocabulary from prose. Anything else still throws: a rejected
   * promise on the bridge is what "we do not know" should look like.
   */
  async function withRefusals(work: Promise<unknown>): Promise<unknown> {
    try {
      return await work;
    } catch (error) {
      if (error instanceof DaemonConflictError)
        return {
          refused: 'conflict',
          ...(error.detail.from === undefined
            ? {}
            : { from: error.detail.from }),
          ...(error.detail.requested === undefined
            ? {}
            : { requested: error.detail.requested }),
        };
      if (error instanceof DaemonGateDeniedError)
        return { refused: 'denied', reason: error.reason };
      throw error;
    }
  }

  /* ── the handler table ─────────────────────────────────────────────── */

  const handlers: Record<RequestKey, Handler> = {
    status: () => requireClient().status(),
    doctor: () => requireClient().doctor(),
    drafts: (a) => requireClient().listDrafts(maybeRecord(a, 0)),
    draft: (a) => requireClient().getDraft(str(a, 0)),
    approve: (a) =>
      withRefusals(requireClient().approveDraft(str(a, 0), maybeRecord(a, 1))),
    reject: (a) =>
      withRefusals(requireClient().rejectDraft(str(a, 0), maybeRecord(a, 1))),
    recall: (a) => withRefusals(requireClient().recallDraft(str(a, 0))),
    retry: (a) => withRefusals(requireClient().retryDraft(str(a, 0))),
    redraft: (a) => withRefusals(requireClient().redraftDraft(str(a, 0))),
    bulk: (a) =>
      requireClient().bulkDrafts(
        str(a, 0) as 'approve' | 'recall' | 'reject',
        record(a, 1) as unknown as BulkSelector,
      ),
    batch: (a) => requireClient().batchReport(str(a, 0)),
    rules: () => requireClient().listRules(),
    ruleWrite: (a) => {
      const id = a[0];
      const input = record(a, 1) as unknown as RuleInput;
      return id === undefined || id === null
        ? requireClient().createRule(input)
        : requireClient().updateRule(str(a, 0), input);
    },
    ruleDelete: (a) => requireClient().deleteRule(str(a, 0)),
    ruleTest: (a) =>
      requireClient().testRule(
        str(a, 0),
        record(a, 1) as unknown as RuleTestInput,
      ),
    ruleDryRun: (a) => {
      const limit = a[1];
      return typeof limit === 'number'
        ? requireClient().dryRunRule(str(a, 0), limit)
        : requireClient().dryRunRule(str(a, 0));
    },
    schedules: () => requireClient().listSchedules(),
    scheduleWrite: (a) => {
      const id = a[0];
      return id === undefined || id === null
        ? requireClient().createSchedule(
            record(a, 1) as unknown as ScheduleInput,
          )
        : requireClient().updateSchedule(str(a, 0), record(a, 1));
    },
    scheduleDelete: (a) => requireClient().deleteSchedule(str(a, 0)),
    contacts: () => requireClient().listContacts(),
    contactSet: (a) =>
      requireClient().setContactPolicy(
        str(a, 0),
        str(a, 1) as ContactMode,
        maybeRecord(a, 2),
      ),
    contactDelete: (a) => requireClient().deleteContactPolicy(str(a, 0)),
    audit: (a) => requireClient().listAudit(maybeRecord(a, 0)),
    auditVerify: () => requireClient().verifyAudit(),
    /**
     * Sc 12 turns this into a written file with a chosen destination. It is
     * the audit list today because Sc 4 row 6 requires every registered
     * channel to be in the registry AND every registry channel to be
     * registered, and a channel that is declared but unhandled would fail
     * that row in the direction that matters least and hide the drift.
     */
    exportReport: (a) => requireClient().listAudit(maybeRecord(a, 0)),
    settings: () => requireClient().settings(),
    settingsWrite: (a) =>
      requireClient().setSettings(
        record(a, 0) as Record<string, SettingPatchValue>,
      ),
    killSwitch: (a) =>
      requireClient().setKillSwitch(bool(a, 0), maybeRecord(a, 1)),
    pause: (a) => requireClient().pause(str(a, 0)),
    resume: () => requireClient().resume(),
    globalMode: (a) => requireClient().setGlobalMode(str(a, 0) as RespondMode),
    adapters: () => requireClient().listAdapters(),
    adapterRotate: (a) => requireClient().rotateAdapterToken(str(a, 0)),
    adapterUpdate: (a) =>
      requireClient().updateAdapter(str(a, 0), record(a, 1)),
    connect: () => requireClient().connect(),
    disconnect: (a) => {
      const input = maybeRecord(a, 0) as DisconnectInput | undefined;
      return input === undefined
        ? requireClient().disconnect()
        : requireClient().disconnect(input);
    },
    /**
     * The wizard's self-message test, and the only channel in the app whose
     * name matches /send/i.
     *
     * Two independent refusals, because one of them is a policy this file
     * owns and the other is a fact the wizard owns: the target must have
     * been armed, and the request must be for that exact target. A renderer
     * that has been fully compromised can invoke this channel; it cannot
     * make it deliver a message to anybody the operator did not nominate as
     * themselves, and it cannot reach any other send path, because there is
     * not one.
     */
    sendTest: async (a) => {
      const to = str(a, 0);
      const body = str(a, 1);
      if (sendTestTarget === null || to !== sendTestTarget)
        throw new Error('wizard-only');
      return requireClient().send({ to, body });
    },
    /**
     * The renderer names a PANE, never a URL. `shell.openExternal` on an
     * operator-supplied string is a code-execution primitive on macOS.
     */
    openSystemSettings: async (a) => {
      const pane = str(a, 0);
      if (!isSystemSettingsPane(pane)) throw new Error('unknown-pane');
      await shell.openExternal(SYSTEM_SETTINGS_PANES[pane]);
      return { opened: pane };
    },
  };

  function registerHandlers(): void {
    for (const key of REQUEST_KEYS)
      ipcMain.handle(CHANNELS[key], (_event, ...args: unknown[]) =>
        handlers[key](args),
      );
  }

  /**
   * Turn the stream's verdict into the sentence the operator reads.
   *
   * The stream reports about the CONNECTION; this decides what that means
   * for a person looking at a window. The one piece of judgement is the
   * first-attempt case: a transient failure before we have ever been
   * connected is almost always "the daemon is not running", which is a
   * setup card and not a spinner, and a spinner would be the app declining
   * to say the one useful thing it knows.
   */
  async function onStatus(
    next: StreamStatus,
    live: WeMessageClient,
  ): Promise<void> {
    if (next.state === 'down') {
      down(next.reason);
      return;
    }
    if (next.state === 'reconnecting') {
      if (everConnected) push({ state: 'reconnecting', attempt: next.attempt });
      else down('unreachable');
      return;
    }
    everConnected = true;
    // The arming badge is a FETCH, never an assumption: §1.7 arming can
    // expire on a timer nobody pressed, so a reconnect that carried the old
    // badge forward would be showing a permission that has since lapsed.
    // `refreshStatus` pushes when it succeeds; the push below is what happens
    // when it does not — say connected, because the stream is the better
    // witness to the connection, and leave the posture as the last thing the
    // daemon actually said about itself.
    link = { state: 'connected' };
    await refreshStatus(live);
    if (link.state === 'connected' && stream.state !== 'connected')
      push({ state: 'connected' });
  }

  async function connect(): Promise<void> {
    if (stopped) return;
    // No credential means no request. An app that probes anyway teaches its
    // operator that 401s in the daemon's log are normal, which is the exact
    // habit that makes a real one invisible. Row 7 asserts zero requests.
    if (bootstrap.token === null) {
      down('no-token');
      return;
    }
    const live = createClient({
      baseUrl: bootstrap.baseUrl,
      token: bootstrap.token,
    });
    // The client is usable the moment it exists: constructing it performs no
    // request, and a renderer whose refetch is refused with
    // `daemon-unavailable` while a socket is reconnecting would be told the
    // wrong thing about a daemon that is merely a second away.
    client = live;
    events = createEventStream({
      connect: (onEvent) => live.events(onEvent),
      resync: createResync(live),
      // §1.8: the frame is appended to the renderer's own record before
      // anything is claimed about it. `emit` is the sink; `status` is the
      // claim; the stream calls them in that order and never the reverse.
      emit: (frame) => {
        pushToWindows(CHANNELS.event, frame);
        // §1.8 order, at this boundary too: the frame reaches the renderer's
        // own record BEFORE anything is claimed on the back of it. Three
        // events change the daemon's posture and nothing else does — the
        // kill switch and the circuit arrive as `toggle.changed`, every hold
        // and release as `arming.changed`, and a dot's liveness as
        // `adapter.health`. `connection.state` is deliberately NOT here: it
        // is answered by the arming sweep that follows it, and refreshing on
        // both would put a second status request on the wire for one fact.
        if (frame.kind !== 'event') return;
        const name = frame.event.event;
        if (
          name === 'toggle.changed' ||
          name === 'arming.changed' ||
          name === 'adapter.health'
        )
          void refreshStatus(live);
      },
      status: (next) => {
        void onStatus(next, live);
      },
      // The one real timer in the reconnect path, and the reason the policy
      // itself is injectable: the ladder is unit-tested with a fake clock,
      // so nothing in the suite has to wait eight seconds to find out that
      // eight seconds is what it would have waited.
      delay: (ms) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }),
      random: Math.random,
      now: () => new Date().toISOString(),
    });
    await events.start();
  }

  return {
    async start(): Promise<void> {
      registerHandlers();
      await connect();
    },
    lastStream: () => stream,
    armSendTest: (handle: string | null): void => {
      sendTestTarget = handle;
    },
    async stop(): Promise<void> {
      stopped = true;
      events?.close();
      events = null;
      client = null;
      for (const key of REQUEST_KEYS) ipcMain.removeHandler(CHANNELS[key]);
      await Promise.resolve();
    },
  };
}
