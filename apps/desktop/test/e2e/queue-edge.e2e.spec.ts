/**
 * s8 Sc7 — the queue's edge states, against a real daemon.
 *
 * Scenario 6 built the queue for the happy path: twenty pending drafts, one
 * listbox, a cursor that moves. This file is about every other shape the
 * same screen has to hold, because those are the shapes where a mistake
 * hides. A queue that is empty, a queue longer than its own window, a link
 * that dropped, a draft that died under the cursor, an approval the daemon
 * refused — each of them is a moment where an operator could be told
 * something untrue, and the untrue thing is always the same: that the app
 * knows what it is looking at.
 *
 * Four claims are load-bearing, and every row below serves one of them.
 *
 *  - **The cursor is an id, never an index.** Sc6 chose that so a draft
 *    leaving the list ABOVE the cursor cannot silently re-point the approve
 *    key at a different card. This is the scenario where that earns its
 *    keep, so the payoff is asserted directly: a row is removed above the
 *    cursor and the cursor is still on the same DRAFT, not on the same slot.
 *  - **A queue the app cannot vouch for says so.** Not connected means an
 *    overlay, a disabled listbox and dimmed cards; knowingly stale means a
 *    banner. An operator must never approve a card the app already knows it
 *    may be wrong about without being told.
 *  - **A key the app knows will fail makes no request.** The refusal is
 *    local, visible and free, and the request log is what proves it. This
 *    also means an edge-state recovery path cannot become a second
 *    dispatch: there is exactly one approve POST per approval, and none at
 *    all for a card that is already terminal or a link that is down
 *    (INV-2).
 *  - **No timer, anywhere.** Expiry is the daemon's clock, driven by hand;
 *    relative time is arithmetic over a `now` the composition root passes
 *    down. Nothing here sleeps, and the arch row that bans the two spellings
 *    scans this file as raw text, comments included.
 *
 * Everything on screen came from the daemon: real rows, real lifecycle
 * frames, a real TCP outage between the app and the port. The one exception
 * is documented where it happens — a draft inserted straight into the store
 * so that it arrives by FETCH and never by frame, which is the only way to
 * reproduce F-108's honesty gap from this side of the bridge.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  bootFixtureDaemon,
  launchApp,
  waitForConnected,
  type FixtureDaemon,
  type LaunchedApp,
} from './harness.js';
import { runtimeGreenOffenders } from './no-green-runtime.js';

/** Synthetic, and the only kind a PUBLIC repo may carry (arch row 13). */
const HANDLE = '+15550001111';
const CHAT = `iMessage;-;${HANDLE}`;

/** Long enough that nothing expires unless a row asks it to. */
const LONG_TTL = 6_000;

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

/**
 * A daemon whose clock starts at the wall clock.
 *
 * Same reason as Sc6: cards render a RELATIVE time against the renderer's
 * own `now`, and a daemon seeded months in the past would render every card
 * as half a year old. Time still moves only when a row moves it (C-11).
 */
async function boot(
  seed?: (fixture: FixtureDaemon) => Promise<void>,
): Promise<FixtureDaemon> {
  const fixture = await bootFixtureDaemon({
    clockAt: new Date().toISOString(),
    seed: (f) => {
      const handle = f.addHandle(HANDLE);
      f.addChat({ identifier: HANDLE, handleIds: [handle] });
    },
  });
  running.push(fixture.stop);
  if (seed !== undefined) await seed(fixture);
  return fixture;
}

async function launch(fixture: FixtureDaemon): Promise<LaunchedApp> {
  const app = await launchApp({
    configDir: fixture.configDir,
    port: fixture.port,
  });
  running.push(app.close);
  // Pinned, because the host Mac's automatic appearance switch made a Sc4
  // row pass at 02:00 and fail at 09:00. The no-green sweep asks for the
  // other scheme explicitly.
  await app.page.emulateMedia({ colorScheme: 'dark' });
  return app;
}

const urls = (fixture: FixtureDaemon): string[] =>
  fixture.requests.requests().map((r) => `${r.method} ${r.url}`);

/** Approve writes, and only those: the count INV-2 cares about. */
const approvePosts = (fixture: FixtureDaemon): string[] =>
  urls(fixture).filter((u) => /^POST \/v1\/drafts\/[^/]+\/approve$/.test(u));

/** The store's own row count, the readiness idiom this suite waits on. */
async function waitForRows(app: LaunchedApp, n: number): Promise<void> {
  await app.page.waitForSelector(`html[data-store-rows="${String(n)}"]`, {
    timeout: 30_000,
  });
}

/** hh:mm, 24-hour, in the host's zone — the renderer's own formatting. */
function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** Focus the listbox the way a person does, then press a key. */
async function press(app: LaunchedApp, key: string): Promise<void> {
  await app.page.focus('#queue-list');
  await app.page.keyboard.press(key, { delay: 60 });
}

/* ── DOM readers: one evaluate each, never fifteen ────────────────────── */

interface EdgeCard {
  readonly draftId: string;
  readonly state: string;
  readonly glyph: string;
  readonly word: string;
  readonly body: string;
  readonly bodyLines: number;
  readonly bodyClamped: string;
  readonly bodyDecoration: string;
  readonly more: string | null;
  readonly badges: string[];
  readonly badgeTitles: string[];
  readonly active: string;
}

interface EdgeView {
  readonly listboxes: number;
  readonly options: number;
  readonly optionOpacity: number;
  readonly disabled: string | null;
  readonly activedescendant: string | null;
  readonly activeIsRendered: boolean;
  readonly tabbables: number;
  readonly interactiveInOptions: number;
  readonly nonOptionChildren: number;
  readonly focus: string;
  readonly count: number;
  readonly link: string;
  readonly stale: string;
  readonly empty: string;
  readonly spacerTop: number;
  readonly spacerBottom: number;
  readonly cards: EdgeCard[];
  /** The empty state, or nulls when the queue has work in it. */
  readonly emptyHead: string | null;
  readonly emptyArming: string | null;
  readonly emptyRules: string[];
  /** The disconnected overlay, or nulls when the link is up. */
  readonly overlayHead: string | null;
  readonly overlayDetail: string | null;
  readonly overlayRefused: string | null;
  readonly overlaySync: string | null;
  readonly overlayActions: string[];
  /** The stale banner, or null when the map is trusted. */
  readonly staleBanner: string | null;
}

function readEdge(app: LaunchedApp): Promise<EdgeView> {
  return app.page.evaluate(() => {
    const text = (el: Element | null | undefined): string =>
      (el?.textContent ?? '').trim();
    const maybe = (sel: string): string | null => {
      const el = document.querySelector(sel);
      return el === null ? null : (el.textContent ?? '').trim();
    };
    const rows = (id: string): number => {
      const el = document.getElementById(id);
      return el === null ? -1 : Number(el.getAttribute('data-rows') ?? '-1');
    };
    const list = document.getElementById('queue-list');
    const options = [...document.querySelectorAll('[role="option"]')];
    const active = list?.getAttribute('aria-activedescendant') ?? null;
    const queue = document.getElementById('queue');
    const firstOption = options[0];
    return {
      listboxes: document.querySelectorAll('[role="listbox"]').length,
      options: options.length,
      optionOpacity:
        firstOption === undefined
          ? 1
          : Number(window.getComputedStyle(firstOption).opacity),
      disabled: list?.getAttribute('aria-disabled') ?? null,
      activedescendant: active,
      activeIsRendered:
        active !== null && document.getElementById(active) !== null,
      tabbables: document.querySelectorAll(
        'a[href], button, input, select, textarea,' +
          ' [tabindex]:not([tabindex="-1"])',
      ).length,
      interactiveInOptions: document.querySelectorAll(
        '[role="option"] a, [role="option"] button, [role="option"] input,' +
          ' [role="option"] [tabindex]',
      ).length,
      nonOptionChildren:
        list === null
          ? -1
          : [...list.children].filter(
              (c) => c.getAttribute('role') !== 'option',
            ).length,
      focus: document.activeElement?.id ?? '',
      count: Number(queue?.getAttribute('data-count') ?? '-1'),
      link: queue?.getAttribute('data-link') ?? '',
      stale: queue?.getAttribute('data-stale') ?? '',
      empty: queue?.getAttribute('data-empty') ?? '',
      spacerTop: rows('queue-spacer-top'),
      spacerBottom: rows('queue-spacer-bottom'),
      cards: options.map((el) => {
        const body = el.querySelector('.card-body');
        const badges = [...el.querySelectorAll('.card-badge')];
        const raw = body === null ? '' : (body.textContent ?? '');
        return {
          draftId: el.getAttribute('data-draft') ?? '',
          state: el.getAttribute('data-state') ?? '',
          glyph: text(el.querySelector('.card-glyph')),
          word: text(el.querySelector('.card-word')),
          body: raw.trim(),
          bodyLines: raw.split('\n').length,
          bodyClamped: body?.getAttribute('data-clamped') ?? '',
          bodyDecoration:
            body === null
              ? ''
              : window.getComputedStyle(body).textDecorationLine,
          more: (() => {
            const m = el.querySelector('.card-more');
            return m === null ? null : (m.textContent ?? '').trim();
          })(),
          badges: badges.map((b) => text(b)),
          badgeTitles: badges.map((b) => b.getAttribute('title') ?? ''),
          active: el.getAttribute('data-active') ?? '',
        };
      }),
      emptyHead: maybe('#queue-empty-head'),
      emptyArming: maybe('#queue-empty-arming'),
      emptyRules: [...document.querySelectorAll('.watched-rule')].map((r) =>
        (r.textContent ?? '').trim(),
      ),
      overlayHead: maybe('#queue-overlay-head'),
      overlayDetail: maybe('#queue-overlay-detail'),
      overlayRefused: maybe('#queue-overlay-refused'),
      overlaySync: maybe('#queue-overlay-sync'),
      overlayActions: [
        ...document.querySelectorAll('.queue-overlay-action'),
      ].map((a) => (a.textContent ?? '').trim()),
      staleBanner: maybe('#queue-stale'),
    };
  });
}

/** Both schemes, every state: the no-green rule is not a dark-mode rule. */
async function sweepGreen(app: LaunchedApp): Promise<void> {
  await app.page.emulateMedia({ colorScheme: 'dark' });
  expect(await runtimeGreenOffenders(app.page)).toEqual([]);
  await app.page.emulateMedia({ colorScheme: 'light' });
  expect(await runtimeGreenOffenders(app.page)).toEqual([]);
  await app.page.emulateMedia({ colorScheme: 'dark' });
}

/* ── row 1: the empty queue is a screen, not a blank ──────────────────── */

describe('s8 Sc7 row 1: nothing waiting is still something to say', () => {
  it('says so, glances at the schedule, lists what is being watched, and keeps the tab stop', async () => {
    const fixture = await boot(async (f) => {
      await f.directClient.createRule({
        name: 'weeknight replies',
        matcher: { kind: 'contact', handles: [HANDLE] },
        adapterId: 'agent-one',
      });
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await waitForRows(app, 0);

    const view = await readEdge(app);
    expect(view.empty).toBe('yes');
    expect(view.emptyHead).toBe('NO DRAFTS WAITING');
    // The glance is built from the daemon's own arming record, so it is
    // either a horizon or the honest absence of one. Never invented.
    expect(view.emptyArming).toMatch(
      /^(ARMED|ARMED UNTIL \d{2}:\d{2}|DISARMED · QUEUE-ONLY)$/,
    );
    // What the operator is owed when the screen is empty: the reason it is
    // reasonable for it to be empty. A queue with no rules watching is a
    // queue that will stay empty, and that is a different fact.
    expect(view.emptyRules).toEqual(['WEEKNIGHT REPLIES']);

    // The listbox is still MOUNTED, with zero options. An empty state that
    // unmounts the list takes the window's only tab stop with it, and the
    // next keystroke goes to `<body>` — the exact failure Sc6's
    // activedescendant decision exists to prevent.
    expect(view.listboxes).toBe(1);
    expect(view.options).toBe(0);
    expect(view.tabbables).toBe(1);
    expect(view.activedescendant).toBeNull();
    expect(view.nonOptionChildren).toBe(0);

    // And the keys are inert rather than broken: focus lands, `j` is
    // claimed, nothing throws, nothing moves.
    await press(app, 'j');
    await press(app, 'a');
    const still = await readEdge(app);
    expect(still.focus).toBe('queue-list');
    expect(still.options).toBe(0);
    expect(approvePosts(fixture)).toEqual([]);

    // One draft arrives and the empty state gives the screen back.
    await fixture.directClient.createDraft({
      chatGuid: CHAT,
      body: 'the first thing to decide',
      ttlMinutes: LONG_TTL,
    });
    await waitForRows(app, 1);
    const one = await readEdge(app);
    expect(one.empty).toBe('no');
    expect(one.emptyHead).toBeNull();
    expect(one.options).toBe(1);
    expect(one.count).toBe(1);
    expect(one.tabbables).toBe(1);
    // A one-item queue has a cursor, and it is on the one item.
    expect(one.activeIsRendered).toBe(true);
    expect(one.cards[0]?.active).toBe('true');
  }, 180_000);
});

/* ── row 1b: a queue longer than its own window ───────────────────────── */

describe('s8 Sc7 row 1b: the queue is bigger than the window it renders', () => {
  it('mounts a slice, spaces the rest, and never loses the cursor at either end', async () => {
    const total = 65;
    const fixture = await boot();
    const base = Date.now();
    const made: string[] = [];
    for (let i = 0; i < total; i += 1) {
      fixture.clock.set(new Date(base - (total - i) * 60_000).toISOString());
      const draft = await fixture.directClient.createDraft({
        chatGuid: CHAT,
        body: `draft number ${String(i)}`,
        ttlMinutes: LONG_TTL,
      });
      made.push(draft.id);
    }
    fixture.clock.set(new Date(base).toISOString());
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await waitForRows(app, total);

    const top = await readEdge(app);
    expect(top.count).toBe(total);
    // Sixty mounted, five spaced. Sc6's twenty never reached this branch, so
    // this is the first row that proves the window is a window at all.
    expect(top.options).toBe(60);
    expect(top.spacerTop).toBe(-1);
    expect(top.spacerBottom).toBe(5);
    expect(top.nonOptionChildren).toBe(0);
    expect(top.tabbables).toBe(1);
    expect(top.interactiveInOptions).toBe(0);
    expect(top.activedescendant).toBe(`draft-${String(made[0])}`);
    expect(top.activeIsRendered).toBe(true);

    // The end of a list longer than the window is where roving tabindex
    // loses focus: the active node is unmounted as the window slides. With
    // one focus holder it cannot happen, and this asserts it behaviourally.
    await press(app, 'G');
    const end = await readEdge(app);
    expect(end.options).toBe(60);
    expect(end.spacerTop).toBe(5);
    expect(end.spacerBottom).toBe(-1);
    expect(end.activedescendant).toBe(`draft-${String(made[total - 1])}`);
    expect(end.activeIsRendered).toBe(true);
    expect(end.focus).toBe('queue-list');

    await press(app, 'g');
    const back = await readEdge(app);
    expect(back.activedescendant).toBe(`draft-${String(made[0])}`);
    expect(back.activeIsRendered).toBe(true);
    expect(back.focus).toBe('queue-list');
  }, 240_000);
});

/* ── row 2: the link drops, and the queue stops pretending ────────────── */

describe('s8 Sc7 row 2: a queue that cannot hear the daemon says so and refuses', () => {
  it('raises the overlay, disables the listbox, dims the cards, makes no request, and recovers', async () => {
    const fixture = await boot();
    for (const body of ['first', 'second'])
      await fixture.directClient.createDraft({
        chatGuid: CHAT,
        body,
        ttlMinutes: LONG_TTL,
      });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await waitForRows(app, 2);
    const synced = await app.page.getAttribute('html', 'data-store-synced-at');
    expect(synced).not.toBeNull();

    // A real TCP outage with the port still bound: the daemon keeps running
    // and keeps recording, so the gap is a thing the app can discover.
    fixture.requests.sever();
    await app.page.waitForSelector('#queue[data-link="reconnecting"]', {
      timeout: 30_000,
    });

    const down = await readEdge(app);
    expect(down.overlayHead).toBe('◌ DISCONNECTED');
    expect(down.overlayDetail).toMatch(/^RETRYING · ATTEMPT \d+$/);
    // The screen says what is refused, in the same words as the refusal.
    expect(down.overlayRefused).toBe('APPROVE IS REFUSED WHILE DISCONNECTED');
    expect(down.overlaySync).toBe(`LAST SYNC ${hhmm(String(synced))}`);
    // The two affordances the plan drew as buttons are STATIC text with
    // their own reason. A button inside this window would be a second tab
    // stop, and `tabbables === 1` is what Sc8's checkpoint runs on.
    expect(down.overlayActions).toEqual([
      'RETRY NOW · AUTOMATIC',
      'RUN DOCTOR · UNAVAILABLE WHILE DISCONNECTED',
    ]);
    expect(down.tabbables).toBe(1);
    expect(down.disabled).toBe('true');
    // Dimmed, and measurably so: a computed opacity, not a class name.
    expect(down.optionOpacity).toBeLessThan(1);
    expect(down.options).toBe(2);

    // The claim the teeth attack: a key pressed while the link is down
    // makes NO request, now or later. Not a queued one, not a deferred one.
    const before = urls(fixture).length;
    await press(app, 'a');
    await press(app, 'a');
    expect(urls(fixture).length).toBe(before);
    expect(approvePosts(fixture)).toEqual([]);

    fixture.requests.restore();
    await app.page.waitForSelector('#queue[data-link="connected"]', {
      timeout: 60_000,
    });
    await waitForRows(app, 2);
    const up = await readEdge(app);
    expect(up.overlayHead).toBeNull();
    expect(up.disabled).toBe('false');
    expect(up.optionOpacity).toBe(1);
    expect(up.options).toBe(2);
    // Server state, not the guess we were holding while the link was down.
    expect(up.cards.map((c) => c.state)).toEqual(['pending', 'pending']);
    // And nothing was queued behind the outage: still not one approve.
    expect(approvePosts(fixture)).toEqual([]);
  }, 240_000);
});

/* ── row 3: the cursor, and what happens when its draft dies ──────────── */

describe('s8 Sc7 row 3: a draft leaving does not move the cursor onto another one', () => {
  it('holds the cursor by id above a removal, strikes the expired card, refuses it locally, and follows the redraft', async () => {
    const fixture = await boot();
    const base = Date.now();
    const made: string[] = [];
    for (const [i, body] of ['alpha', 'bravo', 'charlie'].entries()) {
      fixture.clock.set(new Date(base - (3 - i) * 60_000).toISOString());
      const draft = await fixture.directClient.createDraft({
        chatGuid: CHAT,
        body,
        // Bravo is the only one with a short fuse, so the sweep below
        // expires exactly one card and the row is about that card.
        ttlMinutes: body === 'bravo' ? 1 : LONG_TTL,
      });
      made.push(draft.id);
    }
    fixture.clock.set(new Date(base).toISOString());
    const [alpha, bravo, charlie] = made;
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await waitForRows(app, 3);

    // Cursor onto BRAVO, the middle card.
    await press(app, 'j');
    expect((await readEdge(app)).activedescendant).toBe(
      `draft-${String(bravo)}`,
    );

    // ALPHA leaves, above the cursor. Rejected in another terminal, then
    // pruned by the resync a new draft's arrival triggers — the same two
    // steps a real second operator would produce.
    await fixture.directClient.rejectDraft(String(alpha));
    await app.page.waitForSelector(
      `[data-draft="${String(alpha)}"][data-state="rejected"]`,
      { timeout: 30_000 },
    );
    const delta = await fixture.directClient.createDraft({
      chatGuid: CHAT,
      body: 'delta',
      ttlMinutes: LONG_TTL,
    });
    await app.page.waitForSelector(`[data-draft="${delta.id}"]`, {
      timeout: 30_000,
    });
    await app.page.waitForSelector(`[data-draft="${String(alpha)}"]`, {
      state: 'detached',
      timeout: 30_000,
    });

    // THE PAYOFF. A row was removed above the cursor and another added
    // below it. An index-held cursor would now be on CHARLIE and the next
    // `a` would approve a card the operator was not looking at. An id-held
    // one is still on BRAVO.
    const shifted = await readEdge(app);
    expect(shifted.options).toBe(3);
    expect(shifted.cards.map((c) => c.draftId)).toEqual([
      String(bravo),
      String(charlie),
      delta.id,
    ]);
    expect(shifted.activedescendant).toBe(`draft-${String(bravo)}`);
    expect(shifted.cards[0]?.active).toBe('true');

    // Now BRAVO dies under the cursor. It does not vanish: an expired card
    // the operator was reading stays on screen, visibly dead, because a card
    // that disappeared mid-keystroke is how the wrong draft gets approved.
    fixture.clock.set(new Date(base + 5 * 60_000).toISOString());
    await fixture.daemon.tick();
    await app.page.waitForSelector(
      `[data-draft="${String(bravo)}"][data-state="expired"]`,
      { timeout: 30_000 },
    );
    const dead = await readEdge(app);
    const card = dead.cards.find((c) => c.draftId === String(bravo));
    expect(card?.glyph).toBe('◌');
    expect(card?.word).toBe('EXPIRED');
    expect(card?.badges).toContain('TTL');
    // Struck through, computed: the body is no longer a thing that could go
    // out under the operator's name.
    expect(card?.bodyDecoration).toContain('line-through');
    // The cursor is still on it. It has not been moved to a live card that
    // the operator's next keystroke would then approve.
    expect(dead.activedescendant).toBe(`draft-${String(bravo)}`);

    // And the approve key is refused HERE, before the wire. The daemon
    // would answer 409, and asking it would be a request we know the answer
    // to; more importantly a recovery path that retried would be a second
    // dispatch attempt for a draft that must never be sent (INV-2).
    await press(app, 'a');
    await app.page.waitForSelector(
      `[data-draft="${String(bravo)}"] .card-badge`,
      { timeout: 15_000 },
    );
    const refused = await readEdge(app);
    expect(
      refused.cards.find((c) => c.draftId === String(bravo))?.badges,
    ).toContain('ERROR: EXPIRED');
    expect(approvePosts(fixture)).toEqual([]);

    // Redrafted from another terminal: the old card leaves on
    // `draft.redrafted`, the new one arrives on `draft.created`, and the
    // cursor — whose draft has genuinely gone — resolves visibly rather than
    // pointing at nothing.
    const fresh = await fixture.directClient.redraftDraft(String(bravo));
    await app.page.waitForSelector(`[data-draft="${String(bravo)}"]`, {
      state: 'detached',
      timeout: 30_000,
    });
    await app.page.waitForSelector(`[data-draft="${fresh.draft.id}"]`, {
      timeout: 30_000,
    });
    const after = await readEdge(app);
    expect(after.activeIsRendered).toBe(true);
    expect(after.activedescendant).not.toBe(`draft-${String(bravo)}`);
    expect(after.focus).toBe('queue-list');
    expect(after.cards.some((c) => c.draftId === fresh.draft.id)).toBe(true);
    expect(approvePosts(fixture)).toEqual([]);
  }, 240_000);
});

/* ── row 4 and 5: held, and too long to read ──────────────────────────── */

describe('s8 Sc7 rows 4 and 5: a held draft, and a draft nobody can read at once', () => {
  it('renders HELD without inventing a reason it does not have, and clamps a long body', async () => {
    const lines = Array.from(
      { length: 40 },
      (_, i) => `line ${String(i + 1)} of the agent's answer`,
    );
    const fixture = await boot();
    // Inserted STRAIGHT INTO THE STORE, and this is the only injection in
    // this file. `clampedBy` and `proactiveReason` are produced on the
    // adapter submit path alone — `POST /v1/drafts` accepts neither — so a
    // proactive draft that this window never watched arrive is the honest
    // reproduction of F-108's gap: the app fetched it, so it knows the
    // draft is held and cannot know why.
    // A REAL adapter, over the wire, because `drafts.adapter_id` is a
    // foreign key and because a proactive draft is by definition an agent's.
    // Only the DRAFT is injected; everything it points at is the daemon's.
    await fixture.directClient.createAdapter({
      id: 'agent-one',
      kind: 'generic',
      displayName: 'agent one',
    });
    // The DAEMON's clock, wound back a minute, and not the wall's. The
    // queue sorts oldest first with the id as the tie-break, so an injected
    // row stamped from `new Date()` would land AFTER a row the daemon
    // stamped from its own frozen clock — and the cursor arithmetic below
    // would be reading a list whose order depends on how long the boot took.
    const at = new Date(fixture.clock.nowMs() - 60_000).toISOString();
    fixture.daemon.store.insertDraft({
      id: '01HQ0000000000000000000HLD',
      inboundGuid: null,
      chatGuid: CHAT,
      ruleId: null,
      adapterId: 'agent-one',
      idempotencyKey: 'edge-held-1',
      body: 'proposed unprompted',
      originalBody: 'proposed unprompted',
      proactiveReason: 'noticed an unanswered question',
      state: 'pending',
      stateChangedAt: at,
      expiresAt: new Date(
        fixture.clock.nowMs() + LONG_TTL * 60_000,
      ).toISOString(),
      createdAt: at,
    });
    const long = await fixture.directClient.createDraft({
      chatGuid: CHAT,
      body: lines.join('\n'),
      ttlMinutes: LONG_TTL,
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await waitForRows(app, 2);

    const view = await readEdge(app);
    const held = view.cards.find(
      (c) => c.draftId === '01HQ0000000000000000000HLD',
    );
    // The state word is still the daemon's (C-6): a held draft is PENDING,
    // and HELD is a badge on top of that, not a fourth state nobody else
    // uses.
    expect(held?.word).toBe('PENDING');
    expect(held?.glyph).toBe('○');
    expect(held?.badges).toContain('PROACTIVE');
    // F-108, asserted POSITIVELY: `HELD` alone, and never `HELD · NONE`.
    expect(held?.badges).toContain('HELD');
    expect(held?.badges.some((b) => b.startsWith('HELD ·'))).toBe(false);
    // And the honesty is spelled out rather than left as an absence.
    const titled = (held?.badges ?? []).indexOf('HELD');
    expect(held?.badgeTitles[titled]).toBe(
      'reason known only while the daemon that created this draft is running',
    );

    const big = view.cards.find((c) => c.draftId === long.id);
    expect(big?.bodyClamped).toBe('yes');
    expect(big?.bodyLines).toBe(6);
    expect(big?.more).toBe('SHOW ALL · 40 LINES · SPACE');
    // Nothing interactive was added to do it: the affordance is a legend
    // for a key the screen above interprets.
    expect(view.interactiveInOptions).toBe(0);
    expect(view.tabbables).toBe(1);

    // SPACE, the verb Sc6 already owns, opens it. Sc8 mints `E`; this
    // scenario does not get to.
    await press(app, 'j');
    expect((await readEdge(app)).activedescendant).toBe(`draft-${long.id}`);
    await press(app, ' ');
    const open = await readEdge(app);
    const opened = open.cards.find((c) => c.draftId === long.id);
    expect(opened?.bodyClamped).toBe('no');
    expect(opened?.bodyLines).toBe(40);
    expect(opened?.more).toBeNull();
    expect(open.tabbables).toBe(1);
  }, 240_000);
});

/* ── row 6: an optimistic write the daemon refuses ────────────────────── */

describe('s8 Sc7 row 6: every optimistic write ends in the truth', () => {
  it('rolls back a denial with the gate’s own word, and never sends the same approval twice', async () => {
    const fixture = await boot();
    const draft = await fixture.directClient.createDraft({
      chatGuid: CHAT,
      body: 'needs a decision',
      ttlMinutes: LONG_TTL,
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await waitForRows(app, 1);

    // The outbound kill switch: the app's map is RIGHT (the draft really is
    // pending), so the refusal can only come from the daemon. This is the
    // one optimistic failure a live GUI can still reach, and it is the one
    // that matters — the operator pressed a key and nothing will go out.
    await fixture.directClient.setKillSwitch(true);
    await app.page.waitForSelector(
      '#state-strip[data-outbound="kill-switch"]',
      {
        timeout: 30_000,
      },
    );
    await press(app, 'a');
    await app.page.waitForSelector(`[data-draft="${draft.id}"] .card-badge`, {
      timeout: 30_000,
    });
    const denied = await readEdge(app);
    const card = denied.cards.find((c) => c.draftId === draft.id);
    expect(card?.badges).toContain('DENIED: KILL-SWITCH');
    // Rolled back, not left showing a state the daemon does not have.
    expect(card?.state).toBe('pending');
    expect(card?.word).toBe('PENDING');
    expect(approvePosts(fixture)).toHaveLength(1);

    // The double-apply case. The key is pressed twice; whichever way the
    // race lands — the second press arrives while the first is in flight,
    // or after it has been answered — there is exactly ONE approve on the
    // wire for this draft. A second would be a second approval row, and an
    // approval row is the only thing that can reach the send port.
    await fixture.directClient.setKillSwitch(false);
    await app.page.waitForSelector('#state-strip[data-outbound="armed"]', {
      timeout: 30_000,
    });
    await press(app, 'a');
    await press(app, 'a');
    await app.page.waitForSelector(
      `[data-draft="${draft.id}"][data-state="approved"]`,
      { timeout: 30_000 },
    );
    await press(app, 'a');
    expect(approvePosts(fixture)).toHaveLength(2);
    const approved = await readEdge(app);
    const settled = approved.cards.find((c) => c.draftId === draft.id);
    expect(settled?.word).toBe('APPROVED');
    // The third press, on a card that is no longer pending, is refused
    // locally with the daemon's own word for where it went.
    expect(settled?.badges).toContain('ERROR: APPROVED');
  }, 240_000);
});

/* ── row 7: a queue that knows it may be wrong says so ────────────────── */

describe('s8 Sc7 row 7: stale is a thing the operator can see', () => {
  it('banners a map it cannot vouch for, and still lets the daemon adjudicate', async () => {
    const fixture = await boot();
    const draft = await fixture.directClient.createDraft({
      chatGuid: CHAT,
      body: 'decide me',
      ttlMinutes: LONG_TTL,
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await waitForRows(app, 1);
    expect((await readEdge(app)).staleBanner).toBeNull();

    // The gap detector is Sc5's and is unit-proved there: a hole in the IPC
    // frame sequence calls exactly this. What is proved HERE is the other
    // half — that the fact reaches the screen instead of staying a boolean.
    await app.page.evaluate(() => {
      (
        window as unknown as { __wmQueue: { store: { markStale(): void } } }
      ).__wmQueue.store.markStale();
    });
    await app.page.waitForSelector('#queue[data-stale="yes"]', {
      timeout: 15_000,
    });
    const stale = await readEdge(app);
    expect(stale.staleBanner).toBe('◌ STALE · QUEUE MAY BE OUT OF DATE');
    expect(await app.page.getAttribute('html', 'data-store-stale')).toBe('yes');
    // Stale is not offline. The daemon is reachable and is the authority on
    // every card, so the keys stay live and the operator is told to expect
    // an answer they did not predict — refusing here would strand a queue
    // that is probably fine.
    expect(stale.disabled).toBe('false');
    expect(stale.optionOpacity).toBe(1);

    await press(app, 'a');
    await app.page.waitForSelector(
      `[data-draft="${draft.id}"][data-state="approved"]`,
      { timeout: 30_000 },
    );
    expect(approvePosts(fixture)).toHaveLength(1);
  }, 180_000);
});

/* ── row 8: nothing is green, in any of these states ──────────────────── */

describe('s8 Sc7 row 8: the no-green rule holds in every edge state', () => {
  it('sweeps empty, populated, expired and disconnected, dark and light', async () => {
    const fixture = await boot();
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await waitForRows(app, 0);
    // Empty.
    await sweepGreen(app);

    const draft = await fixture.directClient.createDraft({
      chatGuid: CHAT,
      body: 'about to expire',
      ttlMinutes: 1,
    });
    await waitForRows(app, 1);
    // Populated.
    await sweepGreen(app);

    fixture.clock.set(new Date(Date.now() + 5 * 60_000).toISOString());
    await fixture.daemon.tick();
    await app.page.waitForSelector(
      `[data-draft="${draft.id}"][data-state="expired"]`,
      { timeout: 30_000 },
    );
    // Expired, struck through, and still not green.
    await sweepGreen(app);

    fixture.requests.sever();
    await app.page.waitForSelector('#queue[data-link="reconnecting"]', {
      timeout: 30_000,
    });
    // Disconnected, overlay up, cards dimmed.
    await sweepGreen(app);
  }, 240_000);
});
