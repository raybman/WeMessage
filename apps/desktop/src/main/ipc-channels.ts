/**
 * The closed IPC channel list — INV-2 at the GUI boundary.
 *
 * This is the most load-bearing constant in S8. `@wemessage/client` is
 * Node-only (it imports `ws` and `node:fs`, and it authenticates the socket
 * with a header a sandboxed renderer cannot set), so the client lives in the
 * Electron MAIN process and the renderer reaches it only through the
 * channels named here (F-101). That accident of module resolution is also
 * the correct design: the bearer token that can approve a send never enters
 * a Chromium process.
 *
 * The property below that does not exist is the important one. **There is no
 * `wm:send`.** The renderer cannot ask main to send a message; it can ask
 * main to APPROVE a draft, and approval is what `dispatchApproved` consumes
 * after it has validated an `Approval` row. `test/arch.spec.ts` row 7
 * asserts that no value here matches `/send/i` except `wm:wizard.send-test`,
 * and that no KEY is `send` — because `send: 'wm:dispatch'` would pass a
 * value-only check while being exactly the thing this file exists to refuse.
 *
 * `sendTest` is the single deliberate exception, and it is not a general
 * send: the wizard's step 5 is a human messaging themselves to prove the
 * pipe works. Its handler (Sc 4, tightened in Sc 15) refuses any `to` that
 * differs from the handle the wizard captured in the same session, and any
 * body that is not the four-hex code currently on screen.
 *
 * The arch row that reads this file also counts send call sites across the
 * app, so this comment describes that verb rather than spelling it: the
 * enforcer is not exempt from the thing it enforces.
 *
 * Every value is namespaced `wm:` so that a channel name cannot collide with
 * Electron's own, and every key is the name the preload bridge exposes.
 * Adding a row here is adding public surface: it is a reviewed diff, and the
 * bridge inventory in Sc 4 row 2 asserts the two stay equal.
 */
export const CHANNELS = {
  // ---- request/response (ipcMain.handle) --------------------------------
  status: 'wm:status',
  doctor: 'wm:doctor',
  drafts: 'wm:drafts',
  draft: 'wm:draft',
  approve: 'wm:approve',
  reject: 'wm:reject',
  recall: 'wm:recall',
  retry: 'wm:retry',
  redraft: 'wm:redraft',
  bulk: 'wm:bulk',
  batch: 'wm:batch',
  rules: 'wm:rules',
  ruleWrite: 'wm:rule.write',
  ruleDelete: 'wm:rule.delete',
  ruleTest: 'wm:rule.test',
  ruleDryRun: 'wm:rule.dryrun',
  schedules: 'wm:schedules',
  scheduleWrite: 'wm:schedule.write',
  scheduleDelete: 'wm:schedule.delete',
  contacts: 'wm:contacts',
  contactSet: 'wm:contact.set',
  contactDelete: 'wm:contact.delete',
  audit: 'wm:audit',
  auditVerify: 'wm:audit.verify',
  exportReport: 'wm:audit.export',
  settings: 'wm:settings',
  settingsWrite: 'wm:settings.write',
  killSwitch: 'wm:kill',
  pause: 'wm:pause',
  resume: 'wm:resume',
  globalMode: 'wm:mode',
  adapters: 'wm:adapters',
  adapterRotate: 'wm:adapter.rotate',
  adapterUpdate: 'wm:adapter.update',
  connect: 'wm:connect',
  disconnect: 'wm:disconnect',
  /** The only channel whose handler may reach the client's send verb — wizard
   * step 5, self-message only, guarded on both `to` and body (Sc 15 row 6). */
  sendTest: 'wm:wizard.send-test',
  /** `shell.openExternal` on an allowlisted `x-apple.systempreferences:` URL. */
  openSystemSettings: 'wm:open-system-settings',

  // ---- main -> renderer (webContents.send) ------------------------------
  /** One `GatewayEventPayload` plus its stream sequence number. */
  event: 'wm:event',
  /** `{state: 'connected'|'reconnecting'|'down', lastSyncAt, attempt}`. */
  stream: 'wm:stream',
  /** `{dark, reducedTransparency, reducedMotion}`. */
  theme: 'wm:theme',
  /** Deep link or tray click: `{screen, draftId?}`. */
  navigate: 'wm:navigate',
} as const;

/** A channel name, for the preload bridge and the typed handler table. */
export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS];

/**
 * The four push channels: main to renderer, `webContents.send`.
 *
 * Spelled as its own list rather than derived by a name pattern, because
 * "which direction does this channel go" is the difference between a
 * handler the renderer can call and a message the renderer can only
 * receive. A pattern would make that distinction depend on spelling.
 */
export const PUSH_KEYS = ['event', 'stream', 'theme', 'navigate'] as const;

export type PushKey = (typeof PUSH_KEYS)[number];

/** Every other key: request/response, `ipcMain.handle`. */
export type RequestKey = Exclude<keyof typeof CHANNELS, PushKey>;

const PUSH_KEY_SET: ReadonlySet<string> = new Set<string>(PUSH_KEYS);

/**
 * The request keys, derived from `CHANNELS` by subtracting the push set.
 *
 * Derivation is the point. The preload builds `window.wm` from this list and
 * `gateway.ts` builds the handler table from it, so a channel that is added
 * to `CHANNELS` and to neither side cannot exist: Sc 4 row 2 asserts the
 * renderer's key set and `ipcMain`'s handler map against it in both
 * directions, and the handler table is typed as a total `Record<RequestKey>`
 * so a missing implementation is a compile error rather than a runtime one.
 */
export const REQUEST_KEYS: readonly RequestKey[] = Object.keys(CHANNELS).filter(
  (key): key is RequestKey => !PUSH_KEY_SET.has(key),
);

/** The channel VALUES the renderer may invoke. */
export const REQUEST_CHANNELS: readonly string[] = REQUEST_KEYS.map(
  (key) => CHANNELS[key],
);

/** The channel VALUES main may push. */
export const PUSH_CHANNELS: readonly string[] = PUSH_KEYS.map(
  (key) => CHANNELS[key],
);

/**
 * Whether `value` names a push channel.
 *
 * The preload's `on(key, listener)` calls this and throws `unknown-channel`
 * when it is false, which is what makes the bridge CLOSED rather than merely
 * conventional: a renderer cannot subscribe to a channel nobody wrote down,
 * and cannot subscribe to a REQUEST channel at all.
 */
export function isPushKey(value: string): value is PushKey {
  return PUSH_KEY_SET.has(value);
}
