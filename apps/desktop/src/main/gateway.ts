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
  DaemonAuthError,
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
  let subscription: { close(): void } | null = null;
  let stopped = false;
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

  /* ── the handler table ─────────────────────────────────────────────── */

  const handlers: Record<RequestKey, Handler> = {
    status: () => requireClient().status(),
    doctor: () => requireClient().doctor(),
    drafts: (a) => requireClient().listDrafts(maybeRecord(a, 0)),
    draft: (a) => requireClient().getDraft(str(a, 0)),
    approve: (a) => requireClient().approveDraft(str(a, 0), maybeRecord(a, 1)),
    reject: (a) => requireClient().rejectDraft(str(a, 0), maybeRecord(a, 1)),
    recall: (a) => requireClient().recallDraft(str(a, 0)),
    retry: (a) => requireClient().retryDraft(str(a, 0)),
    redraft: (a) => requireClient().redraftDraft(str(a, 0)),
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
    try {
      subscription = await live.events((event) => {
        pushToWindows(CHANNELS.event, event);
      });
    } catch (error) {
      // A rejected credential is TERMINAL. Retrying it would be a loop that
      // fills the daemon's audit log with failures the operator cannot fix
      // from inside the app, which is why the card asks them to look at the
      // token file instead.
      down(error instanceof DaemonAuthError ? 'token-rejected' : 'unreachable');
      return;
    }
    client = live;
    // §1.8 order: the connection is a fact before it is a claim. Status is
    // read only after the stream is open, so a rejected token produces
    // exactly one request on the wire and the e2e can count it.
    const status = await live.status();
    push({
      state: 'connected',
      armed: status.armed === null ? null : { reason: status.armed.reason },
    });
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
      subscription?.close();
      subscription = null;
      client = null;
      for (const key of REQUEST_KEYS) ipcMain.removeHandler(CHANNELS[key]);
      await Promise.resolve();
    },
  };
}
