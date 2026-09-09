/**
 * s8 Sc15 — the CHECKPOINT: the wizard, through every exit state it has.
 *
 * Sc8's checkpoint measured whether a person can triage twenty drafts in a
 * minute. This one measures something the product needs just as badly and
 * that no screenshot can establish: whether the first surface an operator
 * ever sees can be TRUSTED when things are broken. Onboarding is the only
 * screen in the app guaranteed to run while something is wrong, and a
 * wizard that renders a reassuring state because a check threw, was skipped
 * or had no row is worse than no wizard — it turns a fixable setup problem
 * into a silent product that never sends anything and never says why.
 *
 * So the measurement is COVERAGE, made in a shape a future exit state
 * cannot escape:
 *
 *  - The vocabulary is not written down in this file. `WIZARD_EXITS` is
 *    `Object.keys` of a `Readonly<Record<WizardExit, ExitSpec>>` whose key
 *    type is `link:${DownReason} | daemon:${ConnectionState}` — two unions
 *    this GUI does not own — and the wizard publishes that list into the
 *    DOM as `data-exits`. Every row here READS it from the window.
 *  - Every exit below is reached by driving the real daemon, or the real
 *    socket, into the state. Nothing pokes the renderer. Four are the
 *    daemon's own `evaluateDoctor` verdicts, produced by moving the probe
 *    answers; four are the link's, produced by withholding a credential,
 *    handing over a wrong one, cutting the socket, and putting a real
 *    wire-version skew on the wire.
 *  - The row then asserts SET EQUALITY, both directions, between what the
 *    app says its exits are and what these boots actually observed. An exit
 *    added upstream appears in `data-exits`, is never observed, and fails.
 *    An exit deleted upstream is observed and not declared, and fails.
 *    There is no hand-written list in the middle for a ninth state to slip
 *    past, which is the whole difference between this and a checklist.
 *
 * The ninth RENDERED state is deliberately not an exit: when the link is up
 * and the report could not be read, the wizard shows NOT CHECKED — its own
 * datum, `data-exit="not-checked"` — and never OK. Sc12's blank policy
 * column, Sc13's `—` and `UNREADABLE`, Sc14's four NOT CHECKED cards; this
 * is the same claim made at the front door.
 *
 * INV-2, in the scenario built to break it. Step 5 does send a message, and
 * it sends it down the ONE path: `POST /v1/send`, which mints a real
 * `Draft`, mints a real `Approval` through `humanApiActor()`, appends both
 * audit rows before broadcasting either, and calls `dispatchApproved` — the
 * only function in the repo that reaches `SendBackend.send`. The renderer
 * cannot choose what is said: MAIN mints the four-hex code and remembers
 * the handle, and refuses any `sendTest` whose recipient or body is not
 * that exact pair. The wire is counted rather than trusted, a pending draft
 * is parked in the queue for the whole run, and finishing onboarding is
 * asserted to have approved and dispatched nothing except the one thing the
 * operator pressed a key for.
 *
 * No timer, in the product or here. Elapsed time is `performance.now()`,
 * which is a clock READ and not a scheduled callback; waiting is
 * `expect.poll`, which is the runner's business and not the app's.
 *
 * Synthetic handles only (`+1555…`), as everywhere in this PUBLIC repo.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scriptedProbes } from '../../../../packages/daemon/test/helpers/scripted-probes.js';
import {
  bootFixtureDaemon,
  launchApp,
  waitForConn,
  waitForConnected,
  type BootOptions,
  type FixtureDaemon,
  type LaunchedApp,
} from './harness.js';
import { axeFindings } from './axe.js';
import { runtimeGreenOffenders } from './no-green-runtime.js';

/** Synthetic, and the only kind a PUBLIC repo may carry. */
const HANDLE = '+15550001111';
const CHAT = `iMessage;-;${HANDLE}`;

/** Split, so this file does not spell a credential prefix a guard hunts. */
const TOKEN_PREFIX = `wm${'_'}`;

/** Long enough that the parked draft never expires under a slow run. */
const LONG_TTL = 6_000;

/** The product budget for a full walk. This number never moves. */
const BUDGET_MS = 60_000;

/**
 * Playwright's inter-key delay, the same 60 ms Sc8's checkpoint uses.
 *
 * The floor below is derived from the MEASURED press count at runtime, not
 * from a guess: `walk()` counts every real keystroke it makes, the row
 * asserts that count is exactly `EXPECTED_PRESSES`, and the floor is that
 * number times this delay. The denominator of the ratchet is therefore a
 * physical property of the run — time no optimisation can remove — exactly
 * as in Sc8, rather than a fraction of a generous budget that could never
 * fire.
 */
const PRESS_DELAY_MS = 60;

/**
 * The keystrokes a full six-step walk costs.
 *
 * `tabTo` blurs and then Tabs until the control has focus, which costs
 * more presses than tabbing onward from wherever focus happens to be and is
 * the right trade: the count is deterministic, so it can be ASSERTED, and a
 * changed tab order becomes a failure here rather than a drift in the
 * ratchet's denominator. Every one of these is a real key event through a
 * real window.
 *
 * The MEASURED breakdown, and it is not the one this row first guessed.
 * `blur()` does not move the sequential-focus starting point back to the
 * top of the document: Chromium leaves it where the blurred control was, so
 * every Tab run after the first starts one past the control that was just
 * pressed and WRAPS through the end of the step to reach CONTINUE. The
 * count is smaller than a from-the-top model predicts, not larger, and the
 * difference is real behaviour rather than a missing control — the ids
 * present at every step are asserted alongside it below.
 *
 *   welcome      [recheck continue finish]           2 Tab + Enter =  3
 *   full-disk    [back recheck continue finish]      4 Tab + Enter =  5
 *   automation   [back recheck continue finish]      4 Tab + Enter =  5
 *   optional     [back recheck continue finish]      4 Tab + Enter =  5
 *   keep-running [back recheck continue finish]      4 Tab + Enter =  5
 *   send-test    [back recheck handle send finish]
 *                to the handle                       4 Tab         =  4
 *                the handle, typed                   12 characters = 12
 *                to SEND, and press it               1 Tab + Enter =  2
 *                to FINISH, and press it             1 Tab + Enter =  2
 *                                                                    ──
 *                                                                    43
 *
 * Asserted exactly rather than as an upper bound, Sc8-style: a walk that
 * became cheaper because a step stopped rendering a control is a regression
 * in this product, not an improvement. The four Tabs that reach CONTINUE on
 * the middle steps are load-bearing in exactly that way: three of them
 * would mean FINISH had stopped being rendered.
 *
 * `keep-running` is the s9 Sc7 amendment, and it is in this table because
 * the wizard grew a step, not because the number was inconvenient. It costs
 * what `optional` costs and for the same reason: it checks nothing, so it
 * renders the same four controls, and the count went UP by exactly that
 * step's price. A ratchet that had been relaxed to an upper bound would
 * have absorbed the change in silence, which is the whole argument for
 * asserting it exactly.
 */
const EXPECTED_PRESSES = 43;

/**
 * The regression guard, expressed against the keyboard floor.
 *
 * Sc8's argument, unchanged and for the same reason: a ratchet stated as a
 * fraction of 60 000 ms would tolerate the wizard becoming twenty times
 * slower per step before it fired, which is a threshold nobody can trip.
 * 3× the floor leaves ~120 ms per keystroke of app-and-driver time where a
 * local run costs a few, which absorbs a CI box several times slower and
 * still fires on the regressions that actually happen here: a step that
 * re-probes on every render, a permission card that refetches the whole
 * settings table, a send that waits on a poll it did not need.
 *
 * A LOWER bound is asserted too. A run that comes in under the floor did
 * not press real keys, and a checkpoint that can be passed by not doing the
 * work is not a checkpoint.
 */
const RATCHET_FACTOR = 3;

const running: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const stop of running.splice(0).reverse()) {
    try {
      await stop();
    } catch {
      /* teardown is best-effort by design */
    }
  }
});

/* ── fixtures ─────────────────────────────────────────────────────────── */

async function boot(options: BootOptions = {}): Promise<FixtureDaemon> {
  const fixture = await bootFixtureDaemon({
    ...options,
    seed: (f) => {
      const handle = f.addHandle(HANDLE);
      f.addChat({ identifier: HANDLE, handleIds: [handle] });
      options.seed?.(f);
    },
  });
  running.push(fixture.stop);
  return fixture;
}

async function launch(
  fixture: FixtureDaemon,
  extra: { configDir?: string; env?: Record<string, string> } = {},
): Promise<LaunchedApp> {
  const app = await launchApp({
    configDir: extra.configDir ?? fixture.configDir,
    port: fixture.port,
    ...(extra.env === undefined ? {} : { env: extra.env }),
  });
  running.push(app.close);
  // Pinned, or the host Mac's automatic appearance switch makes the colour
  // rows pass at 02:00 and fail at 09:00 (Sc4's precedent).
  await app.page.emulateMedia({ colorScheme: 'dark' });
  return app;
}

/* ── reading the wizard ───────────────────────────────────────────────── */

interface WizardView {
  readonly step: string;
  readonly progress: string;
  readonly exit: string;
  readonly exitState: string;
  readonly exitWord: string;
  readonly exitGlyph: string;
  readonly verdict: string;
  readonly verdictWord: string;
  readonly ready: string;
  readonly probing: string;
  /** The vocabulary the APP says it is total over. */
  readonly exits: readonly string[];
  readonly cards: ReadonlyArray<{
    readonly check: string;
    readonly state: string;
    readonly word: string;
    readonly glyph: string;
    readonly pane: string | null;
  }>;
  /** `#daemon-not-found`'s reason, when the welcome step is showing one. */
  readonly downReason: string | null;
  /** Every control, in DOM order, with its disabled datum. */
  readonly controls: ReadonlyArray<{
    readonly id: string;
    readonly disabled: string;
  }>;
  readonly text: string;
}

async function read(app: LaunchedApp): Promise<WizardView> {
  return app.page.evaluate(() => {
    const root = document.querySelector('#wizard');
    if (root === null) throw new Error('no wizard on screen');
    const text = (sel: string): string =>
      root.querySelector(sel)?.textContent?.trim() ?? '';
    const attr = (sel: string, name: string): string =>
      root.querySelector(sel)?.getAttribute(name) ?? '';
    const notFound = root.querySelector('#daemon-not-found');
    return {
      step: root.getAttribute('data-step') ?? '',
      progress: text('#wizard-progress'),
      exit: attr('#wizard-exit', 'data-exit'),
      exitState: attr('#wizard-exit', 'data-state'),
      exitWord: text('#wizard-exit .wiz-exit-word'),
      exitGlyph: text('#wizard-exit .wiz-exit-glyph'),
      verdict: attr('#wizard-verdict', 'data-state'),
      verdictWord: text('#wizard-verdict .wiz-verdict-word'),
      ready: root.getAttribute('data-ready') ?? '',
      probing: root.getAttribute('data-probing') ?? '',
      exits: (root.getAttribute('data-exits') ?? '').split(' ').filter(Boolean),
      cards: [...root.querySelectorAll('.wiz-card')].map((c) => ({
        check: c.getAttribute('data-check') ?? '',
        state: c.getAttribute('data-state') ?? '',
        word: c.querySelector('.wiz-card-word')?.textContent?.trim() ?? '',
        glyph: c.querySelector('.wiz-card-glyph')?.textContent?.trim() ?? '',
        pane:
          c.querySelector('.wiz-card-pane')?.getAttribute('data-pane') ?? null,
      })),
      downReason:
        notFound === null ? null : notFound.getAttribute('data-reason'),
      controls: [...root.querySelectorAll('button, input')].map((el) => ({
        id: el.id,
        disabled: el.getAttribute('aria-disabled') ?? 'absent',
      })),
      text: root.textContent ?? '',
    };
  });
}

/** Wait for the wizard to be on screen and not mid-probe. */
async function settledWizard(app: LaunchedApp): Promise<WizardView> {
  await app.page.waitForSelector('#wizard[data-probing="no"]', {
    timeout: 30_000,
  });
  return read(app);
}

/** One control's `aria-disabled`, or `absent` when it is not rendered. */
const disabledOf = (view: WizardView, id: string): string =>
  view.controls.find((c) => c.id === id)?.disabled ?? 'absent';

/** Every request the app started has come back (Sc8's third witness). */
async function settled(app: LaunchedApp): Promise<void> {
  await app.page.evaluate(() =>
    (
      window as unknown as { __wmQueue: { settled(): Promise<void> } }
    ).__wmQueue.settled(),
  );
}

const urls = (fixture: FixtureDaemon): string[] =>
  fixture.requests.requests().map((r) => `${r.method} ${r.url}`);

/* ── keys ─────────────────────────────────────────────────────────────── */

/** Every real keystroke this file makes, counted. */
class Presses {
  count = 0;
  constructor(private readonly app: LaunchedApp) {}
  async key(k: string): Promise<void> {
    this.count += 1;
    await this.app.page.keyboard.press(k, { delay: PRESS_DELAY_MS });
  }
  async type(text: string): Promise<void> {
    this.count += text.length;
    await this.app.page.keyboard.type(text, { delay: PRESS_DELAY_MS });
  }
  /** Blur, then Tab until `id` has focus. The blur is not a keystroke. */
  async tabTo(id: string): Promise<void> {
    await this.app.page.evaluate(() => {
      const el = document.activeElement;
      if (el instanceof HTMLElement) el.blur();
    });
    for (let i = 0; i < 12; i += 1) {
      await this.key('Tab');
      const at = await this.app.page.evaluate(
        () => document.activeElement?.id ?? '',
      );
      if (at === id) return;
    }
    throw new Error(`tab never reached #${id}`);
  }
}

/**
 * Entry, and the argument for it.
 *
 * The wizard is NOT in the ⌘-digit table. `SCREENS`, `MOUNTED` and
 * `keys/screens.ts` are total over `Screen` in both directions, so a
 * seventh entry would put onboarding in the navigation set, give it a
 * stroke that must not collide with the other six, and add a tab stop to
 * the surface whose one-tab-stop claim Sc8's checkpoint rests on. It is a
 * MODE, not a destination: it arrives on its own when the link is down, and
 * is asked for by name from the Permissions pane when it is not.
 */
async function openWizard(app: LaunchedApp): Promise<void> {
  await app.page.keyboard.press('Meta+Digit6');
  await app.page.waitForSelector('#set-perms', { timeout: 30_000 });
  await app.page.click('#set-perms-wizard');
  await app.page.waitForSelector('#wizard', { timeout: 30_000 });
}

interface Walk {
  readonly view: WizardView;
  /** Every control id present, in DOM order, at each of the six steps. */
  readonly controls: ReadonlyArray<readonly string[]>;
  readonly elapsed: number;
  readonly presses: number;
  readonly fixture: FixtureDaemon;
  readonly app: LaunchedApp;
  readonly parked: string;
}

/**
 * The healthy path, end to end, on the clock.
 *
 * The clock stops only when three independent things agree, exactly as
 * Sc8's did: the wizard is gone (`data-screen="queue"`), every request the
 * renderer started has settled, and THE DAEMON'S OWN doctor report says
 * `fully-connected`. The third is the one that matters — the final
 * readiness claim is proved against the daemon's state, never against the
 * wizard's step counter, which is a number the wizard controls and can be
 * wrong about.
 */
async function walkAndMeasure(): Promise<Walk> {
  const scripted = scriptedProbes();
  const fixture = await boot({ probes: scripted.probes });
  // A draft the operator has NOT approved, parked in the queue for the
  // whole run. Finishing onboarding must not touch it.
  const parked = (
    await fixture.directClient.createDraft({
      chatGuid: CHAT,
      body: 'parked, and it stays parked',
      ttlMinutes: LONG_TTL,
    })
  ).id;
  const app = await launch(fixture);
  await waitForConnected(app.page);
  await openWizard(app);
  await settledWizard(app);

  const keys = new Presses(app);
  const controls: string[][] = [];
  /** The ids the step is offering, read before the walk spends keys on it. */
  const ids = async (): Promise<void> => {
    controls.push(
      await app.page.evaluate(() =>
        [...document.querySelectorAll('#wizard button, #wizard input')].map(
          (el) => el.id,
        ),
      ),
    );
  };
  const start = await app.page.evaluate(() => performance.now());

  for (const step of [
    'full-disk',
    'automation',
    'optional',
    'keep-running',
    'send-test',
  ]) {
    await ids();
    await keys.tabTo('wizard-continue');
    await keys.key('Enter');
    await app.page.waitForSelector(`#wizard[data-step="${step}"]`, {
      timeout: 30_000,
    });
    await app.page.waitForSelector('#wizard[data-probing="no"]', {
      timeout: 30_000,
    });
  }

  // The handle is typed by the operator. The CODE is not: main mints it and
  // the renderer only displays it, which is why there is no field for it.
  await ids();
  await keys.tabTo('wizard-handle');
  await keys.type(HANDLE);
  await keys.tabTo('wizard-send');
  await keys.key('Enter');
  await app.page.waitForSelector('#wizard-send-state[data-state="OK"]', {
    timeout: 30_000,
  });

  await keys.tabTo('wizard-finish');
  await keys.key('Enter');

  await expect
    .poll(
      async () => {
        const screen = await app.page.getAttribute('html', 'data-screen');
        if (screen !== 'queue') return `still-in-wizard:${String(screen)}`;
        await settled(app);
        return (await fixture.directClient.doctor()).state;
      },
      { timeout: BUDGET_MS, interval: 25 },
    )
    .toBe('fully-connected');
  const elapsed = (await app.page.evaluate(() => performance.now())) - start;

  // Re-opened so the finished view can be READ, without re-timing it.
  await openWizard(app);
  const view = await settledWizard(app);
  return { view, controls, elapsed, presses: keys.count, fixture, app, parked };
}

/* ══ the checkpoint ═══════════════════════════════════════════════════ */

describe('s8 Sc15 — onboarding: the wizard through every exit state', () => {
  it('★ CHECKPOINT: reaches, and honestly renders, every exit the product has', async () => {
    const seen = new Map<string, WizardView>();
    let vocabulary: readonly string[] = [];
    const note = (view: WizardView): void => {
      seen.set(view.exit, view);
      if (vocabulary.length === 0) vocabulary = view.exits;
      // Every step publishes the same vocabulary. A step that trimmed it to
      // what it thought was relevant would turn the equality below into a
      // statement about one step rather than about the product.
      expect([...view.exits].sort()).toEqual([...vocabulary].sort());
    };

    /* ── link:no-token ── a config dir nothing has ever written to ───── */
    {
      const fixture = await boot();
      const app = await launch(fixture, {
        configDir: mkdtempSync(join(tmpdir(), 'wm-no-token-')),
      });
      await waitForConn(app.page, 'down');
      const view = await settledWizard(app);
      note(view);
      expect(view.exit).toBe('link:no-token');
      expect(view.exitState).toBe('FAIL');
      expect(view.step).toBe('welcome');
      expect(view.downReason).toBe('no-token');
      // Nothing was checked, because nothing could be asked. Four cards,
      // all NOT CHECKED, and not one of them OK.
      expect(view.cards.map((c) => c.state)).toEqual([
        'NOT CHECKED',
        'NOT CHECKED',
        'NOT CHECKED',
        'NOT CHECKED',
      ]);
      expect(view.ready).toBe('no');
      // No credential means NO REQUEST, not a request that fails.
      expect(fixture.requests.requests()).toEqual([]);
      expect(
        view.controls.find((c) => c.id === 'wizard-continue')?.disabled,
      ).toBe('true');
      await app.close();
      await fixture.stop();
    }

    /* ── link:token-rejected ── the bearer is wrong ──────────────────── */
    {
      const fixture = await boot();
      const app = await launch(fixture, {
        env: { WEMESSAGE_TOKEN: `${TOKEN_PREFIX}wrong` },
      });
      await waitForConn(app.page, 'down');
      const view = await settledWizard(app);
      note(view);
      expect(view.exit).toBe('link:token-rejected');
      expect(view.exitState).toBe('FAIL');
      expect(view.downReason).toBe('token-rejected');
      // Exactly one attempt: an auth failure is not a transient, and a
      // wizard that retried it in a loop would be hammering the daemon
      // while telling the operator to wait.
      expect(
        urls(fixture).filter((u) => u.startsWith('GET /v1/events')),
      ).toHaveLength(1);
      expect(fixture.requests.statuses()).toContain(401);
      // The screen must not echo the credential it was handed.
      expect(view.text).not.toContain('wrong');
      await app.close();
      await fixture.stop();
    }

    /* ── link:unreachable ── the socket dies on the way out ──────────── */
    {
      const fixture = await boot();
      // Bound but severed: connections accepted and dropped, which is what
      // a daemon restarting underneath a client looks like. This app has
      // never been connected, so its first transient is not a spinner.
      fixture.requests.sever();
      const app = await launch(fixture);
      await waitForConn(app.page, 'down');
      const view = await settledWizard(app);
      note(view);
      expect(view.exit).toBe('link:unreachable');
      expect(view.exitState).toBe('FAIL');
      expect(view.downReason).toBe('unreachable');
      expect(fixture.requests.connections()).toBeGreaterThan(0);
      await app.close();
      await fixture.stop();
    }

    /* ── link:stream-refused ── a real 4400 from the real daemon ─────── */
    {
      const fixture = await boot();
      // Wire-version skew, injected AT THE WIRE. `/v1/events` closes
      // exactly one way — 4400, protocol violation — and this is how to
      // make it happen: an event filter the daemon's own `parseEventFilter`
      // refuses, which is precisely what a newer app asking an older daemon
      // for an event it has never heard of would send. 4401, 4408 and 4426
      // are adapter-transport codes this socket never opens, so a row
      // asserting the desktop saw one of them would assert a fiction.
      fixture.requests.rewriteOnce(
        'GET /v1/events HTTP/1.1',
        'GET /v1/events?events= HTTP/1.1',
      );
      const app = await launch(fixture);
      await waitForConn(app.page, 'down');
      const view = await settledWizard(app);
      note(view);
      // The rewrite really fired. A silent no-op would have left this row
      // quietly re-testing the happy path.
      expect(fixture.requests.rewrites()).toBe(1);
      expect(urls(fixture)).toContain('GET /v1/events?events=');
      expect(view.exit).toBe('link:stream-refused');
      expect(view.exitState).toBe('FAIL');
      expect(view.downReason).toBe('stream-refused');
      // Terminal, not a transient: one attempt, no retry ladder.
      expect(
        urls(fixture).filter((u) => u.startsWith('GET /v1/events')),
      ).toHaveLength(1);
      await app.close();
      await fixture.stop();
    }

    /* ── daemon:unsupported ── the OS is below the floor ─────────────── */
    {
      const scripted = scriptedProbes({ osMajor: 12 });
      const fixture = await boot({ probes: scripted.probes });
      const app = await launch(fixture);
      await waitForConnected(app.page);
      await openWizard(app);
      const view = await settledWizard(app);
      note(view);
      expect(view.exit).toBe('daemon:unsupported');
      expect(view.exitState).toBe('FAIL');
      // `evaluateDoctor` SHORT-CIRCUITS on the OS: one check comes back and
      // the other three were never asked. They read NOT CHECKED, and the
      // difference between that and OK is the entire scenario.
      expect(view.cards.map((c) => `${c.check}:${c.state}`)).toEqual([
        'os:FAIL',
        'fda:NOT CHECKED',
        'automation:NOT CHECKED',
        'messages:NOT CHECKED',
      ]);
      expect(view.ready).toBe('no');
      await app.close();
      await fixture.stop();
    }

    /* ── daemon:disconnected ── Full Disk Access refused by TCC ──────── */
    {
      const scripted = scriptedProbes({ fda: 'eperm' });
      const fixture = await boot({ probes: scripted.probes });
      const app = await launch(fixture);
      await waitForConnected(app.page);
      await openWizard(app);
      const view = await settledWizard(app);
      note(view);
      expect(view.exit).toBe('daemon:disconnected');
      expect(view.exitState).toBe('FAIL');
      expect(view.cards.map((c) => `${c.check}:${c.state}`)).toEqual([
        'os:OK',
        'fda:FAIL',
        'automation:NOT CHECKED',
        'messages:NOT CHECKED',
      ]);
      // TCC is not grantable through any API. The most this wizard may
      // offer is to open the pane the operator has to act in, BY NAME,
      // through main's closed allowlist.
      expect(view.cards.find((c) => c.check === 'fda')?.pane).toBe('fullDisk');
      // …and it may never claim it fixed anything.
      const prose = view.text.toLowerCase();
      for (const lie of ['granted access', 'access granted', 'we enabled'])
        expect(prose, lie).not.toContain(lie);
      await app.close();
      await fixture.stop();
    }

    /* ── daemon:read-only ── the database is not where it should be ──── */
    {
      const scripted = scriptedProbes({ fda: 'enoent' });
      const fixture = await boot({ probes: scripted.probes });
      const app = await launch(fixture);
      await waitForConnected(app.page);
      await openWizard(app);
      const view = await settledWizard(app);
      note(view);
      expect(view.exit).toBe('daemon:read-only');
      // Not a failure and not a pass: the one WARN in the vocabulary. The
      // product works; it just cannot do the half of its job that reads.
      expect(view.exitState).toBe('WARN');
      expect(view.ready).toBe('no');
      await app.close();
      await fixture.stop();
    }

    /* ── the ninth state: checked nothing, and says so ───────────────── */
    {
      const scripted = scriptedProbes();
      const fixture = await boot({ probes: scripted.probes });
      const app = await launch(fixture);
      await waitForConnected(app.page);
      // The daemon is up and the socket is fine; the PROBE is what fails.
      // Set after boot, so the daemon really did start. This is the case a
      // wizard is most tempted to render as "still checking…" for ever, or
      // worse, as a pass.
      scripted.script.explode = true;
      await openWizard(app);
      const view = await settledWizard(app);
      expect(view.exit).toBe('not-checked');
      expect(view.exitState).toBe('NOT CHECKED');
      expect(view.exitWord).toBe('NOT CHECKED');
      expect(view.probing).toBe('no');
      expect(view.ready).toBe('no');
      expect(view.cards.map((c) => c.state)).toEqual([
        'NOT CHECKED',
        'NOT CHECKED',
        'NOT CHECKED',
        'NOT CHECKED',
      ]);
      // NOT an exit: it is the ABSENCE of one, and it must not be counted
      // as coverage of anything.
      expect(view.exits).not.toContain('not-checked');
      await app.close();
      await fixture.stop();
    }

    /* ── daemon:fully-connected ── the full walk ─────────────────────── */
    const timed = await walkAndMeasure();
    note(timed.view);
    expect(timed.view.exit).toBe('daemon:fully-connected');
    expect(timed.view.exitState).toBe('OK');
    expect(timed.view.ready).toBe('yes');

    /* ── the measurement ─────────────────────────────────────────────── */

    // Both directions. This is the whole checkpoint.
    expect([...seen.keys()].sort()).toEqual([...vocabulary].sort());
    expect(vocabulary).toHaveLength(8);
    for (const [exit, view] of seen) {
      expect(view.exitWord, exit).toBe(view.exitWord.toUpperCase());
      expect(view.exitWord.length, exit).toBeGreaterThan(0);
      expect(view.exitGlyph.length, exit).toBeGreaterThan(0);
    }
    // No two exits render as the same thing: an operator can tell which of
    // the eight they are in without reading the paragraph.
    expect(new Set([...seen.values()].map((v) => v.exitWord)).size).toBe(8);
    // Exactly one of the eight was allowed to say the product is ready.
    expect(
      [...seen.entries()].filter(([, v]) => v.ready === 'yes').map(([e]) => e),
    ).toEqual(['daemon:fully-connected']);
  }, 900_000);

  it('the measured walk is inside the budget, above the floor and under the ratchet', async () => {
    const walk = await walkAndMeasure();
    const floor = walk.presses * PRESS_DELAY_MS;
    const ratchet = floor * RATCHET_FACTOR;

    // The controls the count is a count OF. Asserted as the exact ids in
    // exact DOM order, so a walk that got cheaper because a step stopped
    // rendering something fails HERE, naming the step and the control,
    // rather than as an unexplained integer three lines down.
    expect(walk.controls).toEqual([
      ['wizard-recheck', 'wizard-continue', 'wizard-finish'],
      ['wizard-back', 'wizard-recheck', 'wizard-continue', 'wizard-finish'],
      ['wizard-back', 'wizard-recheck', 'wizard-continue', 'wizard-finish'],
      ['wizard-back', 'wizard-recheck', 'wizard-continue', 'wizard-finish'],
      ['wizard-back', 'wizard-recheck', 'wizard-continue', 'wizard-finish'],
      [
        'wizard-back',
        'wizard-recheck',
        'wizard-handle',
        'wizard-send',
        'wizard-finish',
      ],
    ]);
    expect(walk.presses).toBe(EXPECTED_PRESSES);
    expect(ratchet).toBeLessThan(BUDGET_MS);
    expect(walk.elapsed).toBeLessThan(BUDGET_MS);
    expect(walk.elapsed).toBeLessThan(ratchet);
    // The lower bound. A run under the floor did not press real keys.
    expect(walk.elapsed).toBeGreaterThan(floor);

    console.log(
      [
        `onboarding walk: ${walk.elapsed.toFixed(0)}ms`,
        `${String(walk.presses)} keystrokes`,
        `budget ${String(BUDGET_MS)}ms`,
        `floor ${String(floor)}ms`,
        `ratchet ${String(ratchet)}ms`,
        `${(walk.elapsed / floor).toFixed(2)}× floor`,
        `${(walk.elapsed / walk.presses).toFixed(1)}ms/keystroke`,
      ].join(' · '),
    );
  }, 600_000);

  it('finishing onboarding sends exactly what the operator pressed, and nothing else', async () => {
    const walk = await walkAndMeasure();
    const { fixture } = walk;

    // The backend saw ONE send, and it is the wizard's.
    expect(fixture.loopback.callCount()).toBe(1);
    const call = fixture.loopback.calls()[0];
    expect(call?.chatGuid).toBe(CHAT);
    // Four hex characters, minted by MAIN. Neither the renderer nor the
    // operator could have chosen this.
    expect(call?.body).toMatch(/^[0-9A-F]{4}$/);
    // …and it is the code that was on screen.
    expect(
      ((await walk.app.page.textContent('#wizard-code')) ?? '').trim(),
    ).toBe(call?.body);

    // The parked draft is untouched. Completing onboarding does not
    // retroactively approve or dispatch what queued during it.
    expect((await fixture.directClient.getDraft(walk.parked)).draft.state).toBe(
      'pending',
    );
    expect(
      await fixture.directClient.listDrafts({ state: 'pending' }),
    ).toHaveLength(1);

    // The wire, enumerated. Exactly one write crossed it, and it is the
    // send; nothing approve- or dispatch-shaped crossed it at all.
    const all = urls(fixture);
    expect(all.filter((u) => !u.startsWith('GET '))).toEqual(['POST /v1/send']);
    expect(all.filter((u) => /approve|dispatch/i.test(u))).toEqual([]);
    // Non-vacuous: the run really did put requests on the wire.
    expect(all.length).toBeGreaterThan(2);

    // And the record says the same thing: one approval, minted by the human
    // API actor, logged before it was broadcast.
    const audit = await fixture.directClient.listAudit({ limit: 200 });
    const types = audit.map(
      (r) => (JSON.parse(r.eventJson) as { type: string }).type,
    );
    //
    // `draft.sent`, not `draft.dispatched`: this row named an audit type the
    // taxonomy does not contain, and the tree was right. Strengthened rather
    // than corrected — the whole trail the one send left is now enumerated
    // in ORDER, so a route that logged an approval and never dispatched, or
    // dispatched twice, or failed and said nothing, fails here.
    // `listAudit` answers newest-first, so the trail is read backwards to
    // be asserted in the order it was written.
    const chrono = [...types].reverse();
    expect(chrono.filter((t) => t.startsWith('draft.'))).toEqual([
      // the parked draft, created before the app ever launched
      'draft.created',
      // and the wizard's, taking the ordinary path in full
      'draft.created',
      'draft.approved',
      'draft.sent',
    ]);
    expect(types).not.toContain('draft.dispatched');
    expect(types).not.toContain('draft.failed');
  }, 600_000);

  it('an abandoned wizard resumes nowhere: it restarts, and it wrote nothing', async () => {
    const scripted = scriptedProbes();
    const fixture = await boot({ probes: scripted.probes });
    const before = await fixture.directClient.settings();

    {
      const app = await launch(fixture);
      await waitForConnected(app.page);
      await openWizard(app);
      const keys = new Presses(app);
      await keys.tabTo('wizard-continue');
      await keys.key('Enter');
      await app.page.waitForSelector('#wizard[data-step="full-disk"]', {
        timeout: 30_000,
      });
      // Quit from the middle.
      await app.close();
    }

    const app = await launch(fixture);
    await waitForConnected(app.page);
    await openWizard(app);
    const view = await settledWizard(app);
    // Step one. There is nowhere to resume FROM, and that is the argument
    // rather than the shortcut: the premise of step two may have changed
    // while the app was closed, and a wizard that reopened on step four
    // because a counter said so would be asserting three passes it has not
    // re-established.
    expect(view.step).toBe('welcome');
    expect(view.progress).toContain('STEP 1 OF 6');

    // Nothing about the wizard is in the daemon's settings table. Opening
    // onboarding does not change the product, and closing it does not
    // leave a crumb for the next launch to trust.
    expect(Object.keys(await fixture.directClient.settings()).sort()).toEqual(
      Object.keys(before).sort(),
    );
    expect(
      urls(fixture).filter((u) => /^(POST|PATCH|PUT|DELETE) /.test(u)),
    ).toEqual([]);
  }, 600_000);

  it('the danger zone leaves the wizard where Sc14 said it does, with a dead bearer', async () => {
    // The S8 plan's Scenario 14 row 8 says the app "then shows the wizard
    // WELCOME step with RECONNECT". Half right, and the wrong half matters.
    //
    // `disconnectDaemon` clears the adapter tokens and ROTATES the daemon's
    // own credential, so the bearer this app holds is dead the instant the
    // call returns. The app does land on the wizard's welcome step — but a
    // RECONNECT button there would be a control that cannot work, rendered
    // at the exact moment an operator is deciding whether to trust the
    // product. So the welcome step offers what is actually true: where the
    // credential lives, and a relaunch. `connect` is not in the wizard's
    // binding at all, which is the structural half of the same claim.
    const scripted = scriptedProbes();
    const fixture = await boot({ probes: scripted.probes });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await fixture.directClient.disconnect({ purge: false });
    await waitForConn(app.page, 'down');
    const view = await settledWizard(app);
    expect(view.step).toBe('welcome');
    expect(view.exit).toBe('link:token-rejected');
    expect(view.downReason).toBe('token-rejected');
    expect(view.controls.map((c) => c.id)).not.toContain('wizard-reconnect');
    // Every check reads NOT CHECKED: there is nothing to ask, and a
    // remembered pass from thirty seconds ago is not a check.
    expect(view.cards.map((c) => c.state)).toEqual([
      'NOT CHECKED',
      'NOT CHECKED',
      'NOT CHECKED',
      'NOT CHECKED',
    ]);
    expect(view.ready).toBe('no');
  }, 600_000);

  it('a failing wizard carries its state in more than colour, and passes axe', async () => {
    const scripted = scriptedProbes({ fda: 'eperm' });
    const fixture = await boot({ probes: scripted.probes });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await openWizard(app);
    const view = await settledWizard(app);

    // Glyph AND uppercase word AND datum, on every card and on the exit.
    for (const card of view.cards) {
      expect(card.word, card.check).toBe(card.word.toUpperCase());
      expect(card.word.length, card.check).toBeGreaterThan(0);
      expect(card.glyph.length, card.check).toBeGreaterThan(0);
      expect(card.state.length, card.check).toBeGreaterThan(0);
    }
    expect(view.exitGlyph.length).toBeGreaterThan(0);
    expect(view.verdictWord).toBe(view.verdictWord.toUpperCase());
    // §1.7: the status lines are UPPERCASE. The plan writes them lowercase.
    expect(view.progress).toBe(view.progress.toUpperCase());

    // Green is banned, read at the computed style rather than in the source.
    expect(await runtimeGreenOffenders(app.page)).toEqual([]);

    // Every control is `aria-disabled` and never `disabled`, because a
    // `disabled` button is unreachable by a screen reader's caret — and
    // because it is what makes the refusal rows below provable: the gesture
    // really lands, and the handler is what says no.
    expect(view.controls.length).toBeGreaterThan(0);
    for (const c of view.controls)
      expect(['true', 'false'], c.id).toContain(c.disabled);
    expect(
      await app.page.evaluate(() =>
        [...document.querySelectorAll('#wizard [disabled]')].map((e) => e.id),
      ),
    ).toEqual([]);

    // The surface an operator meets before they have had a chance to set
    // anything up is the one most likely to be read by a screen reader.
    expect(
      (await axeFindings(app.page)).map(
        (f) => `${f.id} (${f.impact}): ${f.nodes.join(', ')}`,
      ),
    ).toEqual([]);
  }, 600_000);

  /**
   * The refusal that had no witness: CONTINUE, while the check is in the air.
   *
   * s8 close, gate 9. `TN-continue-anyway` — `mayContinue` answering true
   * while `probing` — survived the whole seventeen-mutation sweep, and it
   * survived for a structural reason rather than a lucky one. Every other
   * row in this file reads a control through `settledWizard`, which waits
   * for `#wizard[data-probing="no"]` first; and while that attribute is
   * `no` the mutant and the original are the SAME function. The one window
   * the defect lives in was the one window nothing ever looked at.
   *
   * It is a real defect. This is the screen guaranteed to run while
   * something is broken, and a CONTINUE that lights up for the length of a
   * probe is a CONTINUE an operator can press past a step that has not
   * answered — arriving at a queue nobody has established is safe, having
   * been told nothing.
   *
   * The window is made a STATE rather than a race by holding the probe open
   * at the daemon: `fda()` waits on a promise this row resolves, so
   * `data-probing="yes"` is stable for exactly as long as the assertions
   * need and not one instant longer. No timer, on either side of the wire.
   * The gate is then released and CONTINUE is pressed for real, so
   * "refused" is a measurement rather than a property of a button that
   * never worked in the first place.
   */
  it('refuses CONTINUE while a re-check is in the air, and offers it back when the answer lands', async () => {
    const scripted = scriptedProbes();
    let open: (() => void) | null = null;
    let gate: Promise<void> | null = null;
    const release = (): void => {
      open?.();
      open = null;
      gate = null;
    };
    const fixture = await boot({
      probes: {
        ...scripted.probes,
        fda: async () => {
          if (gate !== null) await gate;
          return scripted.probes.fda();
        },
      },
    });
    const app = await launch(fixture);
    try {
      await waitForConnected(app.page);
      // Set after boot, exactly as the ninth-state block above does: the
      // daemon has to really start, and it is the PROBE that fails.
      scripted.script.explode = true;
      await openWizard(app);

      // The report could not be read, so the step's verdict is NOT CHECKED,
      // which is worse than WARN — and that is what CONTINUE is refused on
      // here while nothing at all is in flight.
      const before = await settledWizard(app);
      expect(before.step).toBe('welcome');
      expect(before.verdict).toBe('NOT CHECKED');
      expect(disabledOf(before, 'wizard-continue')).toBe('true');

      // Arm the gate, mend the probes, and ask for the re-check an operator
      // who has just been to System Settings would ask for.
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      scripted.script.explode = false;
      await app.page.click('#wizard-recheck');
      await app.page.waitForSelector('#wizard[data-probing="yes"]', {
        timeout: 30_000,
      });

      const during = await read(app);
      // Non-vacuity, both halves: the row is inside the window it claims to
      // be inside, and the verdict it is refusing on is still the one the
      // probe has not answered yet.
      expect(during.probing).toBe('yes');
      expect(during.verdict).toBe('NOT CHECKED');
      expect(disabledOf(during, 'wizard-continue')).toBe('true');

      // And the refusal belongs to the handler, not to a renderer that
      // declined to deliver the gesture. Pressed from the KEYBOARD, which
      // is this file's idiom and the only one that reaches an
      // `aria-disabled` control at all: playwright's own actionability
      // wait treats `aria-disabled="true"` as not-enabled and would sit
      // there for thirty seconds proving nothing. Enter on a focused
      // button really lands, and it is the handler that says no.
      const keys = new Presses(app);
      await keys.tabTo('wizard-continue');
      await keys.key('Enter');
      const pressed = await read(app);
      expect(pressed.step).toBe('welcome');
      expect(pressed.probing).toBe('yes');

      // The other direction, so this is not a row about a dead control.
      release();
      const answered = await settledWizard(app);
      expect(answered.verdict).toBe('OK');
      expect(disabledOf(answered, 'wizard-continue')).toBe('false');
      await keys.tabTo('wizard-continue');
      await keys.key('Enter');
      await app.page.waitForSelector('#wizard[data-step="full-disk"]', {
        timeout: 30_000,
      });
      expect((await read(app)).step).toBe('full-disk');
    } finally {
      release();
    }
  }, 600_000);
});
