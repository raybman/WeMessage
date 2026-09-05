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
export type StreamPayload =
  | { state: 'connected'; armed: { reason: string } | null }
  | { state: 'reconnecting'; attempt: number }
  | { state: 'down'; reason: DownReason; tokenPath: string };

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
  let stream: StreamPayload = {
    state: 'down',
    reason: 'no-token',
    tokenPath: bootstrap.tokenPath,
  };

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

  function push(next: StreamPayload): void {
    stream = next;
    pushToWindows(CHANNELS.stream, next);
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
    try {
      const status = await live.status();
      push({
        state: 'connected',
        armed: status.armed === null ? null : { reason: status.armed.reason },
      });
    } catch {
      // The socket is open and the status route is not answering. Say
      // connected, claim no arming: the stream is the better witness to the
      // connection, and the badge is the thing we genuinely do not know.
      push({ state: 'connected', armed: null });
    }
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
