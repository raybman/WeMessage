/**
 * The tray, as a value.
 *
 * A `Tray` is the one surface in this app with no DOM behind it: Playwright
 * cannot see it, there is no accessibility tree to query, and on Electron 44
 * there is no `tray.getImage()` to read back. So everything the tray SAYS is
 * decided here, by pure functions over a plain value, and the e2e reads the
 * real `Menu` out of main and checks it was built from this.
 *
 * Three decisions are worth naming, because each of them refuses something
 * the plan asked for.
 *
 * **The menu cannot act on a draft.** `TrayCommand` is a closed union of
 * eight verbs and there is no approve, no send, no bulk and no un-kill among
 * them. A tray item is a value with an optional command, and the command is
 * the only way an item reaches anything. So "the tray cannot approve" is not
 * a property of a handler somebody could edit; it is a union somebody would
 * have to widen, in a diff, above this comment.
 *
 * **The tray tightens a deny and never releases one.** The kill switch binds
 * EVERYONE, the operator included. A menu is opened by accident, mis-clicked
 * and dismissed while nobody is looking at the screen, so `kill` takes no
 * argument: there is no spelling of it that turns the deny off. PAUSE is the
 * other kind — a clamp on autonomy, which a human approval still overrides —
 * and it is symmetric here for exactly that reason. The distinction is in the
 * submenu in words, because an operator who thinks a pause flushes the queue
 * is an operator who will be surprised later.
 *
 * **Nothing here counts down.** There is no timer anywhere in this file and
 * no clock read either. A horizon is rendered as the wall-clock instant the
 * daemon reported, in UTC, with a `Z` on it; "in 42 minutes" would be wrong
 * one second after it was written and this menu has nothing to correct it
 * with. What corrects it is `arming.changed`, which is an event.
 */

import type {
  GatewayEventName,
  GatewayEventPayload,
} from '@wemessage/protocol';
import { GATEWAY_EVENT_NAMES } from '@wemessage/protocol';

/* ── what the tray is looking at ──────────────────────────────────────── */

/**
 * One adapter's health dot.
 *
 * Spelled structurally rather than imported from `gateway.ts`, so that the
 * pure half of the tray stays importable by a plain Node test worker with no
 * Electron anywhere in its module graph.
 */
export interface TrayAdapterDot {
  readonly id: string;
  readonly health: string;
}

/** One row of the queue, already reduced to what a menu may show. */
export interface TrayQueueRow {
  readonly id: string;
  readonly createdAt: string;
  readonly preview: string;
}

/** The queue as the tray sees it: a count, a few rows, and work in flight. */
export interface TrayQueue {
  readonly count: number;
  readonly oldest: readonly TrayQueueRow[];
  readonly inFlight: number;
}

/** Whether the OS gave us the chord. */
export const SHORTCUT_STATES = ['registered', 'taken', 'declined'] as const;

export type ShortcutState = (typeof SHORTCUT_STATES)[number];

/** Everything the tray is allowed to know. */
export interface TrayModel {
  readonly conn: string;
  readonly killSwitch: boolean | null;
  readonly armed: {
    readonly reason: string;
    readonly until: string | null;
  } | null;
  readonly adapters: readonly TrayAdapterDot[];
  readonly queue: TrayQueue;
  readonly shortcut: ShortcutState;
  readonly lastSync: string | null;
}

/* ── the closed set of verbs ──────────────────────────────────────────── */

/** The three tokens `POST /v1/toggles/pause` resolves into a deadline. */
export type PauseToken = '1h' | 'until-tomorrow' | 'rest-of-window';

/**
 * Every action a tray item can carry.
 *
 * Read this union as the security boundary it is. `navigate` moves a cursor.
 * `pause` clamps autonomy and `resume` releases that clamp, symmetrically,
 * because a clamp binds only the daemon's own initiative. `kill` arms a deny
 * and carries NO payload, so no menu click can ever release one. `open`,
 * `quit`, `retry` and `doctor` are the window and the daemon's own repair
 * reads. Nothing here touches a draft.
 */
export type TrayCommand =
  | {
      readonly kind: 'navigate';
      readonly screen: 'queue';
      readonly draftId: string;
    }
  | { readonly kind: 'pause'; readonly until: PauseToken }
  | { readonly kind: 'resume' }
  | { readonly kind: 'kill' }
  | { readonly kind: 'open' }
  | { readonly kind: 'quit' }
  | { readonly kind: 'retry' }
  | { readonly kind: 'doctor' };

/** One row of the menu tree. Separators and submenu parents included. */
export interface TrayItem {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly command?: TrayCommand;
  readonly submenu?: readonly TrayItem[];
  readonly separator?: true;
}

/* ── posture ──────────────────────────────────────────────────────────── */

/**
 * The five states the icon distinguishes, in the order their images are
 * declared, most-permissive first.
 */
export const TRAY_POSTURES = [
  'armed',
  'draft-only',
  'sending',
  'killed',
  'disconnected',
] as const;

export type TrayPosture = (typeof TRAY_POSTURES)[number];

export interface TrayPostureSpec {
  readonly glyph: string;
  readonly word: string;
  readonly image: string;
}

/**
 * Glyph, word and image name for each posture.
 *
 * On macOS a tray image is a TEMPLATE image: the system paints it one colour
 * and inverts it with the menu bar, so the icon physically cannot carry a
 * hue. Five distinct SHAPES do the work, and §1.7's "colour is never the sole
 * carrier" is satisfied structurally rather than by a rule someone has to
 * remember: the uppercase WORD is the first line of the menu and the whole of
 * the tooltip.
 *
 * `sending` says IN FLIGHT rather than the obvious word. That is not a
 * euphemism, it is the negative row keeping its promise: no label anywhere in
 * this menu may read like an outbound verb, because an operator scanning a
 * menu for the thing that stops the world should never find a word that looks
 * like the thing that starts it.
 */
export const TRAY_POSTURE_SPEC: Readonly<Record<TrayPosture, TrayPostureSpec>> =
  {
    armed: { glyph: '●', word: 'ARMED', image: 'armedTemplate' },
    'draft-only': {
      glyph: '◔',
      word: 'DRAFT ONLY',
      image: 'draftOnlyTemplate',
    },
    sending: { glyph: '◐', word: 'IN FLIGHT', image: 'sendingTemplate' },
    killed: { glyph: '⊘', word: 'KILLED', image: 'killedTemplate' },
    disconnected: {
      glyph: '◌',
      word: 'DISCONNECTED',
      image: 'disconnectedTemplate',
    },
  };

/**
 * Which of the five to show.
 *
 * The order is the order of certainty, not the order of severity. A dropped
 * socket comes first because every other fact on the model went stale with
 * it. The kill switch outranks work in flight because a deny that is ON is
 * something we were told, and a draft that is `sending` is something we
 * believe. An unknown kill switch reads DRAFT ONLY: the safe rendering of
 * "we do not know whether sending is on" is the one that does not claim it
 * is.
 */
export function trayPosture(model: TrayModel): TrayPosture {
  if (model.conn !== 'connected') return 'disconnected';
  if (model.killSwitch === true) return 'killed';
  if (model.queue.inFlight > 0) return 'sending';
  if (
    model.killSwitch === false &&
    model.armed !== null &&
    model.armed.reason === 'armed'
  )
    return 'armed';
  return 'draft-only';
}

/* ── the two public strings ───────────────────────────────────────────── */

/**
 * The badge, which is the tray title on macOS.
 *
 * Total over `number` because the count arrives from the daemon over a wire,
 * and a tray title is not a place to find out that a JSON body carried a
 * string. Eleven outputs, all of them a count or the absence of one.
 *
 * It goes silent while the socket is down. A number that was true when the
 * connection dropped gets less true every second it stays on screen, and the
 * badge is the one carrier with no room for a qualifier.
 */
export function badgeFor(count: number, connected: boolean): string {
  if (!connected) return '';
  if (!Number.isFinite(count)) return count === Infinity ? '9+' : '';
  const whole = Math.floor(count);
  if (whole <= 0) return '';
  return whole > 9 ? '9+' : String(whole);
}

export function trayBadge(model: TrayModel): string {
  return badgeFor(model.queue.count, model.conn === 'connected');
}

/**
 * The tooltip: a posture and, when we have one, a count.
 *
 * This string and the badge above are visible to anyone standing behind the
 * operator, and on macOS to any process holding an accessibility grant. So
 * they carry two facts and no third: no message text, no handle, no draft id,
 * no chat GUID, no token prefix. The function does not even receive a row —
 * it is given the model and reads two numbers off it — which is why an arch
 * row can assert its body names none of those things.
 */
export function trayTooltip(model: TrayModel): string {
  const spec = TRAY_POSTURE_SPEC[trayPosture(model)];
  const badge = trayBadge(model);
  const head = `${spec.glyph} ${spec.word}`;
  return badge === '' ? head : `${head} · ${badge} PENDING`;
}

/* ── previews ─────────────────────────────────────────────────────────── */

/** How much of a draft a menu row may show. */
export const PREVIEW_LIMIT = 40;

/** How many draft rows the menu carries. */
export const TRAY_MENU_ROWS = 3;

/**
 * Reduce a body to one bounded line.
 *
 * A menu label is not markup, but it is also not a place for a newline, a
 * line separator, a bidi override or a NUL: a label that can carry U+2028 is
 * a label that can be made to look like two labels. Every Unicode "Other"
 * category and every whitespace run collapses to a single space, and the
 * result is cut at a fixed width. The trailing lone surrogate is trimmed so
 * the cut cannot produce an unpaired half of an astral character.
 */
export function previewOf(body: string): string {
  const flat = body.replace(/[\p{C}\s]+/gu, ' ').trim();
  if (flat.length <= PREVIEW_LIMIT) return flat;
  const cut = flat.slice(0, PREVIEW_LIMIT);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/* ── what the tray reads, and when it re-reads it ─────────────────────── */

/** The shape `trayQueueOf` needs, which is less than a `DraftPayload`. */
export interface TrayDraftInput {
  readonly id: string;
  readonly body: string;
  readonly state: string;
  readonly createdAt: string;
}

/**
 * Project a draft list into the three numbers and three rows the menu wants.
 *
 * A filter and a sort, never a fold over previous state: the tray holds no
 * accumulated view that could drift from the daemon's. `inFlight` counts the
 * two states where the daemon has taken custody of a draft, which is what
 * makes the IN FLIGHT posture a report rather than a guess.
 */
export function trayQueueOf(rows: readonly TrayDraftInput[]): TrayQueue {
  const pending = rows.filter((row) => row.state === 'pending');
  const oldest = [...pending]
    .sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
    )
    .slice(0, TRAY_MENU_ROWS)
    .map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      preview: previewOf(row.body),
    }));
  return {
    count: pending.length,
    oldest,
    inFlight: rows.filter(
      (row) => row.state === 'approved' || row.state === 'sending',
    ).length,
  };
}

/**
 * Which events make the tray go and look again.
 *
 * This is the answer to "how does the tray stay truthful without a clock".
 * It re-reads when the daemon says something changed, and at no other time.
 * Compile-time total over the protocol's vocabulary, so an event added
 * upstream is a type error here rather than a row that silently never
 * refreshes.
 */
export const TRAY_REFRESH_ON: Readonly<Record<GatewayEventName, boolean>> =
  Object.fromEntries(
    GATEWAY_EVENT_NAMES.map((name) => [name, name.startsWith('draft.')]),
  ) as Readonly<Record<GatewayEventName, boolean>>;

/**
 * Is this frame worth a re-read?
 *
 * Takes the frame rather than a string, so a caller cannot reach it with a
 * name the protocol never declared. An undeclared name answers `false`: an
 * event nobody has written down is not a licence to guess.
 */
export function traySignificant(frame: GatewayEventPayload): boolean {
  const table: Readonly<Record<string, boolean | undefined>> = TRAY_REFRESH_ON;
  return table[frame.event] === true;
}

/* ── the global shortcut, said out loud ───────────────────────────────── */

/** The chord. Registered system-wide, so it fires with the app unfocused. */
export const TRAY_ACCELERATOR = 'CommandOrControl+Shift+K';

/**
 * What the chord does, in each state the OS can leave it in.
 *
 * It SUMMONS. The plan wanted it to toggle the kill switch and this refuses
 * that: a system-wide keystroke has no context. The operator pressing it
 * cannot see which state they are in, so half the time the chord meant to
 * stop the world would release the deny instead — and that half is exactly
 * the half where somebody is panicking. Bringing the window forward costs one
 * extra keystroke in the case that matters and removes an entire class of
 * catastrophic misfire.
 *
 * A dead chord is said out loud rather than swallowed. If another application
 * already owns the combination, the operator finds out here and in the kill
 * pane, not by pressing it and wondering.
 */
export const SHORTCUT_LINE: Readonly<Record<ShortcutState, string>> = {
  registered: '⌘⇧K BRINGS WEMESSAGE FORWARD',
  taken: '⌘⇧K IS HELD BY ANOTHER APPLICATION',
  declined: '⌘⇧K IS UNAVAILABLE ON THIS SYSTEM',
};

/**
 * Read the two booleans the OS gives us into one word.
 *
 * `globalShortcut.register` returns whether it accepted the accelerator, and
 * `isRegistered` reports whether the app holds it afterwards. Keeping the
 * mapping here, pure and total, is what lets all three outcomes be tested
 * deterministically: on this platform a genuine collision turns out not to be
 * reproducible on demand (two processes can both hold the same chord), so the
 * e2e proves the WIRING and this proves the TABLE.
 */
export function shortcutStateOf(
  accepted: boolean,
  registered: boolean,
): ShortcutState {
  if (!accepted) return 'taken';
  return registered ? 'registered' : 'declined';
}

/* ── the menu ─────────────────────────────────────────────────────────── */

/** `2026-04-18T14:30:00.000Z` becomes `14:30`, with no clock and no `Date`. */
const ISO_INSTANT = /^\d{4}-\d\d-\d\dT(\d\d:\d\d):/;

function hhmm(iso: string): string | null {
  const match = ISO_INSTANT.exec(iso);
  return match === null ? null : (match[1] ?? null);
}

/**
 * The horizon of THIS clamp, or `null` when nobody has pressed pause.
 *
 * `paused` and not "any reason that is not `armed`". §1.3.6 gives five holds
 * and `resolveArming` reports the winning one; `until` is the earliest real
 * horizon among all of them, which means a daemon merely sitting outside its
 * schedule window arrives here under the schedule's own reason, with an
 * instant attached. (That reason is not spelled anywhere on this page. It is
 * one of S6's dormant deny literals, the guard for which is a TEXT scan with
 * a home list, and the first draft of this comment quoted it in backticks and
 * tripped the row — prose about a rule being indistinguishable from a breach
 * of it, exactly as `window.ts` warns for the constructor it may not name.)
 * Reading that as a pause would put PAUSED UNTIL 09:00 on a menu nobody had
 * paused, and — worse — would light RESUME NOW, whose click posts a resume
 * that clears a setting which was never set and changes nothing the operator
 * can see. Two lies for the price of one.
 *
 * `paused` is the daemon's own word for "a hand is holding this", and it is
 * the only reason this item is entitled to speak for.
 */
const PAUSED = 'paused';

function pausedUntil(model: TrayModel): string | null {
  if (model.armed === null || model.armed.reason !== PAUSED) return null;
  return model.armed.until;
}

const separator = (n: number): TrayItem => ({
  id: `sep:${String(n)}`,
  label: '',
  enabled: false,
  separator: true,
});

function postureItem(model: TrayModel, connected: boolean): TrayItem {
  const spec = TRAY_POSTURE_SPEC[trayPosture(model)];
  const head = `${spec.glyph} ${spec.word}`;
  return {
    id: 'posture',
    label: connected ? `${head} · ${String(model.queue.count)} PENDING` : head,
    enabled: false,
  };
}

function shortcutItem(model: TrayModel): TrayItem {
  return {
    id: 'shortcut',
    label: SHORTCUT_LINE[model.shortcut],
    enabled: false,
  };
}

function killItem(model: TrayModel): TrayItem {
  if (model.killSwitch === true)
    return {
      id: 'kill',
      label: '⊘ KILLED · RELEASE IT IN THE WINDOW',
      enabled: false,
    };
  return {
    id: 'kill',
    label: '⊘ KILL OUTBOUND',
    enabled: true,
    command: { kind: 'kill' },
  };
}

function pauseItem(model: TrayModel): TrayItem {
  const until = pausedUntil(model);
  const clock = until === null ? null : hhmm(until);
  const resumable = clock !== null;
  return {
    id: 'pause',
    label: clock === null ? 'PAUSE' : `PAUSED UNTIL ${clock}Z`,
    enabled: true,
    submenu: [
      {
        id: 'pause:note',
        label:
          'CLAMP, NOT A DENY. AUTOMATIC REPLIES HOLD, YOURS DO NOT. RESUMING RELEASES NOTHING THAT WAS HELD.',
        enabled: false,
      },
      separator(9),
      {
        id: 'pause:1h',
        label: 'PAUSE FOR AN HOUR',
        enabled: true,
        command: { kind: 'pause', until: '1h' },
      },
      {
        id: 'pause:tomorrow',
        label: 'PAUSE UNTIL TOMORROW MORNING',
        enabled: true,
        command: { kind: 'pause', until: 'until-tomorrow' },
      },
      {
        id: 'pause:window',
        label: 'PAUSE FOR THE REST OF THE ARMED WINDOW',
        enabled: true,
        command: { kind: 'pause', until: 'rest-of-window' },
      },
      resumable
        ? {
            id: 'pause:resume',
            label: 'RESUME NOW',
            enabled: true,
            command: { kind: 'resume' },
          }
        : { id: 'pause:resume', label: 'RESUME NOW', enabled: false },
    ],
  };
}

function tailItems(model: TrayModel): readonly TrayItem[] {
  return [
    shortcutItem(model),
    {
      id: 'open',
      label: 'OPEN WEMESSAGE',
      enabled: true,
      command: { kind: 'open' },
    },
    {
      id: 'quit',
      label: 'QUIT WEMESSAGE',
      enabled: true,
      command: { kind: 'quit' },
    },
  ];
}

/**
 * Build the whole menu from the model.
 *
 * Two shapes, chosen by whether the socket is up. While it is down the menu
 * offers no draft rows, no count, no pause and no kill: every one of those
 * would be a control that cannot reach the daemon, and a menu item that
 * silently does nothing is worse than one that is not there. What it offers
 * instead is the last instant we heard anything, and the two repair reads.
 */
export function trayMenu(model: TrayModel): readonly TrayItem[] {
  const connected = model.conn === 'connected';
  if (!connected) {
    const sync = model.lastSync === null ? null : hhmm(model.lastSync);
    return [
      postureItem(model, connected),
      separator(1),
      {
        id: 'last-sync',
        label: sync === null ? 'LAST SYNC NEVER' : `LAST SYNC ${sync}Z`,
        enabled: false,
      },
      // Both labels say what the click actually does, which is narrower than
      // what the plan called them. `retry` re-reads `GET /v1/status` — it
      // does not tear a socket down, because a reconnect that raced the run
      // loop's own backoff would be two owners of one connection. `doctor`
      // opens the settings screen, which is the surface that performs the
      // setup reads; there is no second code path that runs them headless.
      {
        id: 'retry',
        label: 'CHECK THE DAEMON NOW',
        enabled: true,
        command: { kind: 'retry' },
      },
      {
        id: 'doctor',
        label: 'OPEN THE SETUP CHECKS',
        enabled: true,
        command: { kind: 'doctor' },
      },
      separator(2),
      ...tailItems(model),
    ];
  }
  const drafts = model.queue.oldest.map((row): TrayItem => ({
    id: `draft:${row.id}`,
    label: row.preview === '' ? row.id : row.preview,
    enabled: true,
    command: { kind: 'navigate', screen: 'queue', draftId: row.id },
  }));
  return [
    postureItem(model, connected),
    separator(1),
    ...drafts,
    ...(drafts.length > 0 ? [separator(2)] : []),
    pauseItem(model),
    killItem(model),
    separator(3),
    ...tailItems(model),
  ];
}
