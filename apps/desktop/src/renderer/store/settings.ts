/**
 * The settings screen's binding — the SIXTH file in this app that reaches
 * the bridge, and the only one whose channels can change what every other
 * screen is allowed to do.
 *
 * Eleven channels: four reads that describe the machine, five writes that
 * change it, one — `connect` — that asks the daemon to try again, and one
 * that reaches no daemon at all. The store partition row in
 * `test/arch.spec.ts` pins that list as data, and the Sc14 block pins the
 * other half a `Pick` cannot state: `pause`, `resume`, `adapterUpdate`,
 * `contactDelete`, `ruleDelete` and `sendTest` are absent from the whole
 * renderer, by name.
 *
 * Four decisions live here rather than in the screen, because each is about
 * the WIRE and not about layout:
 *
 *  - **The kill switch is written through its own route and read from the
 *    event stream.** `send.killSwitch` is a READ-ONLY settings key whose
 *    `use` names `POST /v1/toggles/kill-switch`; a `PATCH /v1/settings`
 *    carrying it is refused with `read-only-key`, second in the daemon's
 *    refusal order. So the toggle calls the toggle route, and the state the
 *    screen paints comes off the status push — which is what lets another
 *    terminal flip the switch and this window follow.
 *
 *  - **A minted adapter token never crosses this boundary.** `adapterRotate`
 *    answers a RECEIPT: the adapter it was minted for, where the secret was
 *    delivered, the environment variable that carries it, and a run line
 *    with no credential in it. Main holds the plaintext, writes it to the
 *    system clipboard and drops it; the renderer is the least trusted
 *    process in this app and is handed nothing to leak. `receiptOf` refuses
 *    any answer carrying anything else, so a main that regressed into
 *    passing the token back would fail to produce a receipt at all rather
 *    than quietly rendering one.
 *
 *  - **A refusal is read, not paraphrased.** `PATCH /v1/settings` answers a
 *    STRUCTURE — `{error:'below-floor', key, floor}` — and the shared cutter
 *    in `store/refusal.ts` recovers it from an error that has been wrapped
 *    twice on its way across IPC. A body that is not one of the five named
 *    refusals comes back as `null` and is held as an unattached failure,
 *    never as a complaint pinned to a field the daemon did not name.
 *
 *  - **Every read is independently fallible.** `load()` asks for four things
 *    and lands `ready` if any of them arrived, because a doctor probe that
 *    threw must leave the Permissions pane saying NOT CHECKED rather than
 *    taking the whole screen down with it. Failure is per-answer and each
 *    one has a resting value that reads as absence: `null`, `[]`, `{}`.
 *
 * INV-2: ten channels, none of which can carry a draft id, and an arch row
 * scans every identifier in this file for the vocabulary of the queue's
 * verbs. Changing the rules a decision is judged by is not making one — and
 * turning the switch back off releases nothing, which `routes/toggles.ts`
 * states in source and the e2e proves at the wire.
 *
 * Everything crosses as `unknown` and is narrowed here, exactly as the other
 * five bindings do it.
 */
import type {
  AdapterPayload,
  DisconnectReportPayload,
  DoctorReportPayload,
  SettingEntry,
  SettingPatchValue,
  SettingsPayload,
  SettingsRefusal,
  SettingType,
} from '@wemessage/client';
import type { WmBridge } from '../../preload/api.js';
import { errorText, settingsRefusalOf } from './refusal.js';

/**
 * The eleven channels this screen may reach, sorted.
 *
 * `drafts` is here for one number: the danger zone counts what a disconnect
 * abandons, and a count nobody can check is a sentence about "your data".
 *
 * `openSystemSettings` is the odd one and is deliberate. macOS TCC cannot be
 * granted programmatically — there is no API, by design — so the only honest
 * remedy a Permissions card can offer is to put the operator in front of the
 * right pane and get out of the way. It reaches no daemon, writes nothing,
 * and takes a pane NAME rather than a URL: `shell.openExternal` on a string
 * this process chose would be a code-execution primitive handed to the least
 * trusted process in the app. Main holds the allowlist
 * (`SYSTEM_SETTINGS_PANES`) and throws `unknown-pane` for anything else.
 */
export const SETTINGS_CHANNELS = [
  'adapterRotate',
  'adapters',
  'connect',
  'disconnect',
  'doctor',
  'drafts',
  'globalMode',
  'killSwitch',
  'openSystemSettings',
  'settings',
  'settingsWrite',
] as const;

/**
 * The bridge, cut to what this screen needs.
 *
 * `Pick` rather than a structural copy: a channel renamed in
 * `ipc-channels.ts` breaks this line instead of silently becoming a call to
 * a channel that no longer exists.
 */
export type SettingsBridge = Pick<
  WmBridge,
  | 'adapterRotate'
  | 'adapters'
  | 'connect'
  | 'disconnect'
  | 'doctor'
  | 'drafts'
  | 'globalMode'
  | 'killSwitch'
  | 'openSystemSettings'
  | 'settings'
  | 'settingsWrite'
>;

/**
 * What main answers a rotation with. No token, and no room for one.
 *
 * `delivered` is a fact about where the secret went, not a reassurance:
 * `'clipboard'` means the OS clipboard actually took it, and `'unavailable'`
 * means it did not, in which case the only honest thing left to say is
 * "rotate again". There is no third arm in which the value is on screen.
 */
export interface MintReceipt {
  readonly adapter: string;
  readonly delivered: 'clipboard' | 'unavailable';
  /** The environment variable the adapter reads. Never the value. */
  readonly variable: string;
  /** The line to run, with the credential elided out of it. */
  readonly run: string;
}

/** Everything the screen renders, as the daemon last answered it. */
export interface SettingsData {
  readonly status: 'idle' | 'loading' | 'ready' | 'failed';
  readonly settings: SettingsPayload;
  readonly adapters: readonly AdapterPayload[];
  /** `null` when the probe threw: a check that never ran is not a pass. */
  readonly doctor: DoctorReportPayload | null;
  /** How many drafts a disconnect would abandon. */
  readonly waiting: number;
  /** The last refusal, in the daemon's own name and datum. */
  readonly refusal: SettingsRefusal | null;
  /** A failure the daemon did not attach to a key. */
  readonly failure: string;
  readonly receipt: MintReceipt | null;
  readonly report: DisconnectReportPayload | null;
}

export interface SettingsBinding {
  data(): SettingsData;
  subscribe(listener: () => void): () => void;
  /** The four reads, in parallel, each fallible on its own. */
  load(): Promise<void>;
  /** Back to `idle`, so a re-entry cannot render the last visit's answers. */
  reset(): void;
  /** `GET /v1/doctor`, and nothing else. */
  probe(): Promise<void>;
  /** `POST /v1/connect` — ask the daemon to attach again. */
  relink(): Promise<void>;
  /** Open a System Settings pane by NAME. Grants nothing; asks nobody. */
  reveal(pane: string): Promise<void>;
  /** One `PATCH /v1/settings` carrying only what moved. */
  save(patch: Record<string, SettingPatchValue>): Promise<void>;
  /** `POST /v1/toggles/kill-switch`. Off releases nothing. */
  kill(on: boolean): Promise<void>;
  /** `POST /v1/toggles/global-mode`. */
  mode(next: string): Promise<void>;
  /** Mint a new adapter credential. Answers a receipt, never a secret. */
  mint(adapter: string): Promise<void>;
  /** Drop the receipt. There is no way back to it. */
  dismiss(): void;
  /** `POST /v1/disconnect`, with no body and therefore no destruction of
   *  the directory the audit log lives in. */
  unlink(): Promise<void>;
  settled(): Promise<void>;
}

/* ── narrowing ────────────────────────────────────────────────────────── */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  return value as Record<string, unknown>;
}

/**
 * `SettingType`, as a runtime set.
 *
 * All FOUR members, and the count is the point. An earlier draft of this
 * narrowing admitted only `int` and `bool` — the two the FORM can edit — and
 * silently dropped every row the POINTER table exists to draw: three of the
 * four read-only keys are `iso` or `enum`, so the screen still rendered four
 * pointer lines (`pointerRows` is total over the closed list by type) and
 * every one of them said UNSET with no owning route beside it. A narrowing
 * that keeps only what one consumer understands is a narrowing that lies to
 * the other consumer, quietly and in the direction of "nothing is set".
 */
const SETTING_TYPES: ReadonlySet<string> = new Set<SettingType>([
  'int',
  'bool',
  'iso',
  'enum',
]);

/**
 * The settings table, dropping any row that is not a whole entry.
 *
 * A half-read row is worse than a missing one: the form renders a control
 * per key it was given, and a row with no `type` would render a box whose
 * validation nobody can predict. `fieldRows` is total over the eleven keys
 * regardless, so a dropped row still gets a line — it gets one that says the
 * daemon did not answer for it.
 */
function tableOf(answer: unknown): SettingsPayload {
  const record = asRecord(answer);
  if (record === null) return {};
  const out: Record<string, SettingEntry> = {};
  for (const [key, raw] of Object.entries(record)) {
    const entry = asRecord(raw);
    if (entry === null) continue;
    if (typeof entry['version'] !== 'number') continue;
    if (!SETTING_TYPES.has(entry['type'] as string)) continue;
    if (typeof entry['readOnly'] !== 'boolean') continue;
    if (!('value' in entry)) continue;
    out[key] = entry as unknown as SettingEntry;
  }
  return out;
}

function adaptersOf(answer: unknown): readonly AdapterPayload[] {
  if (!Array.isArray(answer)) return [];
  const out: AdapterPayload[] = [];
  for (const raw of answer as readonly unknown[]) {
    const record = asRecord(raw);
    if (record === null) continue;
    if (typeof record['id'] !== 'string') continue;
    if (typeof record['kind'] !== 'string') continue;
    if (typeof record['health'] !== 'string') continue;
    if (typeof record['hasToken'] !== 'boolean') continue;
    out.push(record as unknown as AdapterPayload);
  }
  return out;
}

/**
 * The doctor's report, or nothing.
 *
 * `checks` is routinely INCOMPLETE — `evaluateDoctor` short-circuits after a
 * failing probe and never runs the rest — so an array shorter than four is
 * the normal case and not a reason to reject the report. What IS rejected is
 * an answer with no array at all: the pane would then have nothing to be
 * total over, and four cards derived from nothing must read NOT CHECKED.
 *
 * Exported since s8 Sc15 because the wizard needs the SAME narrowing. Two
 * screens that each decided for themselves what counts as a readable doctor
 * report would be two definitions of "not checked", and the whole of Sc15 is
 * the claim that there is one.
 */
export function reportOf(answer: unknown): DoctorReportPayload | null {
  const record = asRecord(answer);
  if (record === null) return null;
  if (typeof record['state'] !== 'string') return null;
  if (!Array.isArray(record['checks'])) return null;
  return record as unknown as DoctorReportPayload;
}

/** How many drafts are still waiting on somebody. */
function waitingOf(answer: unknown): number {
  if (!Array.isArray(answer)) return 0;
  return (answer as readonly unknown[]).filter((raw) => {
    const record = asRecord(raw);
    return record !== null && record['state'] === 'pending';
  }).length;
}

/**
 * Main's rotation receipt, and the row that makes the topology structural.
 *
 * Every field is checked, and any answer carrying a `token` key at all is
 * refused outright — not ignored, refused. Ignoring it would let a main
 * process that regressed into passing the plaintext back go on working with
 * the secret sitting in a Chromium heap; refusing it fails the mint visibly
 * and leaves nothing on screen to leak.
 */
function receiptOf(answer: unknown): MintReceipt | null {
  const record = asRecord(answer);
  if (record === null) return null;
  if ('token' in record) return null;
  const adapter = record['adapter'];
  const delivered = record['delivered'];
  const variable = record['variable'];
  const run = record['run'];
  if (typeof adapter !== 'string' || adapter === '') return null;
  if (delivered !== 'clipboard' && delivered !== 'unavailable') return null;
  if (typeof variable !== 'string' || variable === '') return null;
  if (typeof run !== 'string' || run === '') return null;
  return { adapter, delivered, variable, run };
}

function stepsOf(answer: unknown): DisconnectReportPayload | null {
  const record = asRecord(answer);
  if (record === null) return null;
  if (!Array.isArray(record['steps'])) return null;
  if (!Array.isArray(record['manualRevocation'])) return null;
  return record as unknown as DisconnectReportPayload;
}

/* ── the binding ──────────────────────────────────────────────────────── */

const EMPTY: SettingsData = {
  status: 'idle',
  settings: {},
  adapters: [],
  doctor: null,
  waiting: 0,
  refusal: null,
  failure: '',
  receipt: null,
  report: null,
};

export function bindSettings(bridge: SettingsBridge): SettingsBinding {
  let data: SettingsData = EMPTY;
  const listeners = new Set<() => void>();
  const inflight = new Set<Promise<unknown>>();

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function track<T>(work: Promise<T>): Promise<T> {
    const done: Promise<void> = work.then(
      () => undefined,
      () => undefined,
    );
    inflight.add(done);
    void done.then(() => inflight.delete(done));
    return work;
  }

  /**
   * The four reads have one call site each, and each catches its own.
   *
   * `probe()` and `load()` share this one so the doctor is reached from a
   * single line: the arch row that enumerates who may call a channel is
   * stronger when the answer is a line number and not a set.
   */
  async function readDoctor(): Promise<DoctorReportPayload | null> {
    try {
      return reportOf(await track(bridge.doctor()));
    } catch {
      return null;
    }
  }

  async function readTable(): Promise<SettingsPayload> {
    try {
      return tableOf(await track(bridge.settings()));
    } catch {
      return {};
    }
  }

  async function readAdapters(): Promise<readonly AdapterPayload[]> {
    try {
      return adaptersOf(await track(bridge.adapters()));
    } catch {
      return [];
    }
  }

  async function readWaiting(): Promise<number> {
    try {
      return waitingOf(await track(bridge.drafts({ state: 'pending' })));
    } catch {
      return 0;
    }
  }

  return {
    data: () => data,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async load() {
      data = { ...data, status: data.status === 'ready' ? 'ready' : 'loading' };
      notify();
      const [settings, adapters, doctor, waiting] = await Promise.all([
        readTable(),
        readAdapters(),
        readDoctor(),
        readWaiting(),
      ]);
      // `ready` even when a read failed. The screen is total over its own
      // key list and the Permissions pane is total over four cards, so an
      // answer that never arrived renders as the absence it is. Taking the
      // whole screen down for one of them would hide the kill switch.
      data = { ...data, status: 'ready', settings, adapters, doctor, waiting };
      notify();
    },
    reset() {
      data = EMPTY;
      notify();
    },
    async probe() {
      data = { ...data, doctor: await readDoctor() };
      notify();
    },
    async relink() {
      try {
        await track(bridge.connect());
        data = { ...data, failure: '' };
      } catch (error) {
        data = { ...data, failure: errorText(error) };
      }
      data = { ...data, doctor: await readDoctor() };
      notify();
    },
    async reveal(pane) {
      // A failure here is a failure to OPEN a window, which changes no
      // state and refuses no request. It is reported the same way every
      // other unattached failure is, and the card keeps saying exactly what
      // it said before: the permission is still not granted.
      try {
        await track(bridge.openSystemSettings(pane));
        data = { ...data, failure: '' };
      } catch (error) {
        data = { ...data, failure: errorText(error) };
      }
      notify();
    },
    async save(patch) {
      try {
        await track(bridge.settingsWrite(patch));
        data = { ...data, refusal: null, failure: '' };
      } catch (error) {
        // The daemon's own name and its own datum, or an unattached
        // failure. Never a complaint pinned to a key nobody named.
        const refusal = settingsRefusalOf(error);
        data = {
          ...data,
          refusal,
          failure: refusal === null ? errorText(error) : '',
        };
      }
      // Re-read either way: an all-or-nothing patch that was refused left
      // the daemon exactly as it was, and the form has to be able to prove
      // that rather than assume it.
      data = { ...data, settings: await readTable() };
      notify();
    },
    async kill(on) {
      try {
        await track(bridge.killSwitch(on));
        data = { ...data, failure: '' };
      } catch (error) {
        data = { ...data, failure: errorText(error) };
      }
      data = { ...data, settings: await readTable() };
      notify();
    },
    async mode(next) {
      try {
        await track(bridge.globalMode(next));
        data = { ...data, failure: '' };
      } catch (error) {
        data = { ...data, failure: errorText(error) };
      }
      data = { ...data, settings: await readTable() };
      notify();
    },
    async mint(adapter) {
      try {
        const receipt = receiptOf(await track(bridge.adapterRotate(adapter)));
        data = {
          ...data,
          receipt,
          failure: receipt === null ? 'the rotation answered no receipt' : '',
        };
      } catch (error) {
        data = { ...data, receipt: null, failure: errorText(error) };
      }
      // `hasToken` cannot have changed — it was true before and is true
      // after — but the row's health and last-seen have, and a table that
      // did not move after a rotation would look like one that failed.
      data = { ...data, adapters: await readAdapters() };
      notify();
    },
    dismiss() {
      data = { ...data, receipt: null };
      notify();
    },
    async unlink() {
      try {
        data = { ...data, report: stepsOf(await track(bridge.disconnect())) };
      } catch (error) {
        data = { ...data, report: null, failure: errorText(error) };
      }
      notify();
    },
    async settled() {
      while (inflight.size > 0) await Promise.all([...inflight]);
    },
  };
}
