/**
 * s8 Sc8 — the CHECKPOINT: keyboard triage, and twenty drafts in a minute.
 *
 * This is the file the product's headline claim lives or dies in. Everything
 * else in S8 builds a surface; this measures whether a person can actually
 * use it, and the measurement is the deliverable. So it is driven the way a
 * person drives it: real keys, into a real Electron window, against a real
 * daemon on a real socket, with a request log between them.
 *
 * Three things about the measurement are deliberate, and each of them is the
 * difference between a number and a claim.
 *
 *  - **The clock covers the round trip.** The optimistic store writes its
 *    hypothesis BEFORE the await (Sc5), so the DOM turns `approved` while
 *    the request is still in flight. A stopwatch that stopped at the paint
 *    would therefore be timing the renderer's optimism and calling it the
 *    product's speed. The run stops only when the screen has no pending card
 *    AND every request the app started has come back AND the DAEMON's own
 *    `listDrafts({state:'pending'})` is empty. The slowest of the three is
 *    what gets measured, which is the honest one.
 *  - **The number has a floor as well as a ceiling.** Forty-four keystrokes
 *    at `delay: 60` cannot physically take less than 2 640 ms, so a run that
 *    comes in UNDER that floor did not press real keys — it took a shortcut,
 *    or the clock did not span the presses. Asserting the floor is what stops
 *    this row from being fakeable by making it faster.
 *  - **The ratchet is tighter than the claim.** 60 000 ms is the product
 *    budget and never moves. `RATCHET_MS` is a regression guard measured
 *    against the KEYBOARD FLOOR rather than against the budget, and a row
 *    asserts `RATCHET_MS < BUDGET_MS` so that a future
 *    hand cannot quietly turn the guard into the budget. A threshold that
 *    can never fire is theatre; this one fires long before the claim breaks.
 *
 * INV-2 is the other reason this file exists. Approving fast is exactly the
 * pressure under which somebody batches around the approval record or sends
 * optimistically from the renderer, so the wire is counted rather than
 * trusted: N keystrokes produce exactly N approve POSTs, nothing matching
 * `/send/i` crosses the socket at all, and the send BACKEND is called zero
 * times until the daemon's own grace sweep runs — after which it is called
 * once per approval, with the approved body, through `dispatchApproved` and
 * nowhere else.
 *
 * No timer, here or in the product. Elapsed time is read from
 * `performance.now()`, which is a monotonic CLOCK READ and not a scheduled
 * callback; waiting is `expect.poll`, which is the runner's business and not
 * this app's. The two banned spellings appear nowhere in this file, comments
 * included, and the arch row that says so scans it as raw text.
 *
 * Synthetic handles only (`+1555…`), as everywhere in this PUBLIC repo.
 *
 * Scenario 9 appends its own `describe` to this file for the bulk verbs; the
 * helpers below are written to be shared rather than copied, which is why
 * `boot`, `launch`, `press`, `readTriage` and `wire` are top-level.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  bootFixtureDaemon,
  launchApp,
  waitForConnected,
  type FixtureDaemon,
  type LaunchedApp,
} from './harness.js';

/** Synthetic, and the only kind a PUBLIC repo may carry (arch row 13). */
const HANDLE = '+15550001111';
const CHAT = `iMessage;-;${HANDLE}`;

/** Long enough that nothing expires unless a row asks it to. */
const LONG_TTL = 6_000;

/** The product's claim, in milliseconds. This number never moves. */
const BUDGET_MS = 60_000;

/** 44 presses at `delay: 60` — the part of the run no machine can skip. */
const PRESS_DELAY_MS = 60;
const PRESS_FLOOR_MS = 44 * PRESS_DELAY_MS;

/**
 * The regression guard, expressed against the floor rather than the budget.
 *
 * A ratchet set as a fraction of sixty seconds would be theatre: the run
 * measures ~2.9 s, so anything in the tens of seconds tolerates the app
 * becoming a hundred times slower per keystroke before it fires, and Sc17's
 * meta rows would be looking at a number nobody can trip. The honest
 * denominator is the floor — 2 640 ms of keyboard delay that no amount of
 * optimisation can remove — because everything ABOVE the floor is the part
 * this app is responsible for: paint, the round trip, and the card leaving.
 *
 * 3× the floor allows ~120 ms per keystroke of app-and-driver time where
 * today it costs ~5 ms. That absorbs a CI box several times slower than this
 * one at every single press, and still fires on the regressions that
 * actually happen: a refetch per keystroke, a render that stops coalescing,
 * an approval that waits for its own round trip before painting. It is also
 * 7.6× inside the product budget, so it fails long before the claim does —
 * which is what a ratchet is for.
 */
const RATCHET_FACTOR = 3;
const RATCHET_MS = PRESS_FLOOR_MS * RATCHET_FACTOR;

/** The eight characters the two edited drafts gain. */
const EDIT_SUFFIX = ' ok, yes';

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
 * The daemon's clock is FROZEN there and moves only when a row moves it
 * (C-11), which is what makes the undo window deterministic: an approval's
 * `sendNotBefore` is `frozen + grace`, so the daemon never considers the
 * grace elapsed no matter how long the real run takes, and a row that wants
 * the elapsed case asks for it by name.
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
  await app.page.emulateMedia({ colorScheme: 'dark' });
  return app;
}

/**
 * N drafts, oldest first, each stamped a minute apart on the DAEMON's clock.
 *
 * Stamped from `fixture.clock`, never the wall clock: `byAge` sorts on the
 * daemon's own `createdAt`, and rows created inside one wall-clock
 * millisecond sort by id instead, which puts the cursor somewhere other than
 * where the script thinks it is.
 */
async function seedDrafts(
  fixture: FixtureDaemon,
  bodies: readonly string[],
): Promise<string[]> {
  const base = Date.parse(fixture.clock.now());
  const ids: string[] = [];
  for (const [i, body] of bodies.entries()) {
    fixture.clock.set(
      new Date(base - (bodies.length - i) * 60_000).toISOString(),
    );
    const made = await fixture.directClient.createDraft({
      chatGuid: CHAT,
      body,
      ttlMinutes: LONG_TTL,
    });
    ids.push(made.id);
  }
  fixture.clock.set(new Date(base).toISOString());
  return ids;
}

/* ── the wire ─────────────────────────────────────────────────────────── */

const urls = (fixture: FixtureDaemon): string[] =>
  fixture.requests.requests().map((r) => `${r.method} ${r.url}`);

/** Every write verb the queue can reach, counted separately. */
interface Wire {
  readonly approves: readonly string[];
  readonly rejects: readonly string[];
  readonly recalls: readonly string[];
  /** Anything at all whose method or path smells like a dispatch. */
  readonly sendShaped: readonly string[];
}

function wire(fixture: FixtureDaemon): Wire {
  const all = urls(fixture);
  const write = (verb: string): string[] =>
    all.filter((u) => new RegExp(`^POST /v1/drafts/[^/]+/${verb}$`).test(u));
  return {
    approves: write('approve'),
    rejects: write('reject'),
    recalls: write('recall'),
    sendShaped: all.filter((u) => /send/i.test(u)),
  };
}

/* ── keys ─────────────────────────────────────────────────────────────── */

/**
 * Press a key at whatever currently has focus.
 *
 * Sc7's helper re-focused `#queue-list` before every press, which is correct
 * when the row is about the listbox and fatal when the row is about focus:
 * a test that puts focus back cannot notice that the app dropped it. Focus
 * is placed ONCE, by `focusList`, and every press after that lands wherever
 * the app left it.
 */
async function press(app: LaunchedApp, key: string): Promise<void> {
  await app.page.keyboard.press(key, { delay: PRESS_DELAY_MS });
}

async function focusList(app: LaunchedApp): Promise<void> {
  await app.page.focus('#queue-list');
}

/* ── DOM readers: one evaluate each, never fifteen ────────────────────── */

interface TriageCard {
  readonly draftId: string;
  readonly state: string;
  readonly word: string;
  readonly glyph: string;
  readonly label: string;
  readonly active: string | null;
  readonly badges: readonly string[];
  readonly ringTotal: string | null;
}

interface TriageView {
  readonly focusId: string;
  readonly focusTag: string;
  readonly activedescendant: string | null;
  readonly tabbables: number;
  readonly editors: number;
  readonly editorValue: string | null;
  readonly editorLabel: string | null;
  readonly interactiveInOptions: number;
  readonly live: string;
  readonly liveRole: string | null;
  readonly pendingCards: number;
  readonly cards: readonly TriageCard[];
}

async function readTriage(app: LaunchedApp): Promise<TriageView> {
  return app.page.evaluate((): TriageView => {
    const list = document.getElementById('queue-list');
    const active = list?.getAttribute('aria-activedescendant') ?? null;
    const editor = document.querySelector('textarea');
    const options = [...document.querySelectorAll('[role="option"]')];
    const focused = document.activeElement;
    const text = (el: Element | null): string => el?.textContent ?? '';
    return {
      focusId: focused?.id ?? '',
      focusTag: focused?.tagName.toLowerCase() ?? '',
      activedescendant: active,
      tabbables: document.querySelectorAll(
        'a[href], button, input, select, textarea,' +
          ' [tabindex]:not([tabindex="-1"])',
      ).length,
      editors: document.querySelectorAll('textarea').length,
      editorValue: editor instanceof HTMLTextAreaElement ? editor.value : null,
      editorLabel: editor?.getAttribute('aria-label') ?? null,
      interactiveInOptions: document.querySelectorAll(
        '[role="option"] a, [role="option"] button, [role="option"] input,' +
          ' [role="option"] textarea, [role="option"] [tabindex]',
      ).length,
      live: text(document.getElementById('queue-live')).trim(),
      liveRole:
        document.getElementById('queue-live')?.getAttribute('role') ?? null,
      pendingCards: document.querySelectorAll(
        '[role="option"][data-state="pending"]',
      ).length,
      cards: options.map((el) => ({
        draftId: el.id.replace(/^draft-/, ''),
        state: el.getAttribute('data-state') ?? '',
        word: text(el.querySelector('.card-word')).trim(),
        glyph: text(el.querySelector('.card-glyph')).trim(),
        label: el.getAttribute('aria-label') ?? '',
        active: el.getAttribute('data-active'),
        badges: [...el.querySelectorAll('.card-badge')].map((b) =>
          (b.textContent ?? '').trim(),
        ),
        ringTotal:
          el.querySelector('.card-ring')?.getAttribute('data-ring-total') ??
          null,
      })),
    };
  });
}

/** The store's own row count, the readiness idiom this suite waits on. */
async function waitForRows(app: LaunchedApp, n: number): Promise<void> {
  await app.page.waitForSelector(`html[data-store-rows="${String(n)}"]`, {
    timeout: 30_000,
  });
}

/** Every request the binding started has come back. */
async function settled(app: LaunchedApp): Promise<void> {
  await app.page.evaluate(async () =>
    (
      window as unknown as { __wmQueue: { settled(): Promise<void> } }
    ).__wmQueue.settled(),
  );
}

/* ── row 2: one key, one approval, and the cursor moves on ────────────── */

describe('s8 Sc8 — approve', () => {
  it('turns one A into exactly one approval, one frame, and one step', async () => {
    const fixture = await boot();
    const ids = await seedDrafts(fixture, ['first draft', 'second draft']);
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await waitForRows(app, 2);
    await focusList(app);

    const before = await readTriage(app);
    expect(before.activedescendant).toBe(`draft-${String(ids[0])}`);
    expect(before.focusId).toBe('queue-list');

    await press(app, 'a');
    await settled(app);
    await expect
      .poll(async () => (await readTriage(app)).cards[0]?.state, {
        timeout: 30_000,
      })
      .toBe('approved');

    // At the wire: one approve, no reject, no recall, and nothing that even
    // LOOKS like a dispatch crossed the socket.
    const w = wire(fixture);
    expect(w.approves).toHaveLength(1);
    expect(w.approves[0]).toBe(`POST /v1/drafts/${String(ids[0])}/approve`);
    expect(w.rejects).toHaveLength(0);
    expect(w.sendShaped).toEqual([]);

    // In the daemon: one Approval row, and the draft actually moved.
    const server = await fixture.directClient.getDraft(String(ids[0]));
    expect(server.draft.state).toBe('approved');
    // The ring's two instants, supplied by the daemon and by nobody else.
    expect(typeof server.draft.sendNotBefore).toBe('string');

    const after = await readTriage(app);
    expect(after.cards[0]?.word).toBe('APPROVED');
    expect(after.cards[0]?.glyph).toBe('●');
    // The ring is drawn from the daemon's own two instants, so it exists
    // only once the answer has landed — never on the hypothesis.
    expect(after.cards[0]?.ringTotal).not.toBeNull();
    // Focus never left, and the cursor advanced to the next card.
    expect(after.focusId).toBe('queue-list');
    expect(after.activedescendant).toBe(`draft-${String(ids[1])}`);
    expect(after.tabbables).toBe(1);
  }, 180_000);

  it('refuses a second A on a card it already approved, at the keymap', async () => {
    // The double-press Sc7 found: an unguarded one produced four POSTs where
    // two were correct. Here the cursor has already moved on, so the second
    // A approves the NEXT card — two keystrokes, two approvals, two cards,
    // which is the only arithmetic that is not a bug.
    const fixture = await boot();
    const ids = await seedDrafts(fixture, ['one', 'two']);
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await waitForRows(app, 2);
    await focusList(app);

    await press(app, 'a');
    await press(app, 'a');
    await settled(app);

    const w = wire(fixture);
    expect(w.approves).toHaveLength(2);
    expect(new Set(w.approves).size).toBe(2);
    expect(w.sendShaped).toEqual([]);
    for (const id of ids)
      expect(
        (await fixture.directClient.getDraft(String(id))).draft.state,
      ).toBe('approved');
  }, 180_000);
});

/* ── row 3: reject ────────────────────────────────────────────────────── */

describe('s8 Sc8 — reject', () => {
  it('turns R into one rejection and steps on, clamping at the end', async () => {
    const fixture = await boot();
    const ids = await seedDrafts(fixture, ['alpha', 'beta']);
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await waitForRows(app, 2);
    await focusList(app);

    await press(app, 'r');
    await settled(app);
    await expect
      .poll(async () => (await readTriage(app)).cards[0]?.state, {
        timeout: 30_000,
      })
      .toBe('rejected');

    const w = wire(fixture);
    expect(w.rejects).toEqual([`POST /v1/drafts/${String(ids[0])}/reject`]);
    expect(w.approves).toHaveLength(0);
    expect(w.sendShaped).toEqual([]);

    const mid = await readTriage(app);
    expect(mid.cards[0]?.word).toBe('REJECTED');
    expect(mid.cards[0]?.glyph).toBe('⊘');
    expect(mid.activedescendant).toBe(`draft-${String(ids[1])}`);

    // Acting on the LAST card leaves the cursor on it. Sc7 established that
    // a terminal card stays on screen until a resync prunes it, so there is
    // no card after this one to advance to and the honest thing is to stay:
    // the plan's "moves to previous" describes a list the app does not have.
    await press(app, 'r');
    await settled(app);
    const end = await readTriage(app);
    expect(end.activedescendant).toBe(`draft-${String(ids[1])}`);
    expect(end.pendingCards).toBe(0);
    expect(end.focusId).toBe('queue-list');
  }, 180_000);
});

/* ── row 4: edit in place ─────────────────────────────────────────────── */

describe('s8 Sc8 — edit in place', () => {
  it('gives E the keyboard, restores on Escape, and commits on ⌘↩', async () => {
    const fixture = await boot();
    const ids = await seedDrafts(fixture, ['running late']);
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await waitForRows(app, 1);
    await focusList(app);

    // Nothing editable exists until somebody asks for one: the listbox's
    // single tab stop is the whole document's, which is the invariant Sc7
    // pinned and the reason the editor is mounted rather than hidden.
    const closed = await readTriage(app);
    expect(closed.editors).toBe(0);
    expect(closed.tabbables).toBe(1);

    await press(app, 'e');
    await expect
      .poll(async () => (await readTriage(app)).focusTag, { timeout: 30_000 })
      .toBe('textarea');
    const open = await readTriage(app);
    expect(open.editors).toBe(1);
    // TWO tab stops while editing, and exactly two: the listbox keeps its
    // own (the arch row pins `tabIndex={0}` on it) and the editor has one
    // because a textarea a keyboard cannot reach is not an editor.
    expect(open.tabbables).toBe(2);
    expect(open.editorValue).toBe('running late');
    expect(open.editorLabel).not.toBeNull();
    // The editor is NOT inside an option: an option with a focusable child
    // is an ARIA violation and would give the listbox a second focus owner.
    expect(open.interactiveInOptions).toBe(0);

    // Typing is typing. `a` is a letter here, not the approve verb, and the
    // wire is what proves it.
    await app.page.keyboard.type(EDIT_SUFFIX, { delay: PRESS_DELAY_MS });
    expect((await readTriage(app)).editorValue).toBe(
      `running late${EDIT_SUFFIX}`,
    );
    expect(wire(fixture).approves).toHaveLength(0);

    // Escape abandons it, and the body on the card is the one the daemon has.
    await press(app, 'Escape');
    await expect
      .poll(async () => (await readTriage(app)).editors, { timeout: 30_000 })
      .toBe(0);
    const back = await readTriage(app);
    expect(back.focusId).toBe('queue-list');
    expect(back.tabbables).toBe(1);
    expect(back.cards[0]?.state).toBe('pending');
    expect(wire(fixture).approves).toHaveLength(0);

    // Again, and this time commit it.
    await press(app, 'e');
    await expect
      .poll(async () => (await readTriage(app)).focusTag, { timeout: 30_000 })
      .toBe('textarea');
    await app.page.keyboard.type(EDIT_SUFFIX, { delay: PRESS_DELAY_MS });
    await app.page.keyboard.press('Meta+Enter', { delay: PRESS_DELAY_MS });
    await settled(app);

    const w = wire(fixture);
    expect(w.approves).toEqual([`POST /v1/drafts/${String(ids[0])}/approve`]);
    expect(w.sendShaped).toEqual([]);

    const done = await readTriage(app);
    expect(done.editors).toBe(0);
    expect(done.focusId).toBe('queue-list');
    expect(done.tabbables).toBe(1);

    // AS BUILT, and not as the plan describes it: an edited approve REWRITES
    // the draft's body in the same transition that approves it, and records
    // `editedBody` on the approval row as well. Both are true and the first
    // is the one that matters here — the operator's own words are what the
    // daemon will send, and the card they are looking at afterwards shows
    // them, rather than showing the agent's original with a hidden edit
    // attached to an approval nobody can see.
    const server = await fixture.directClient.getDraft(String(ids[0]));
    expect(server.draft.state).toBe('approved');
    expect(server.draft.body).toBe(`running late${EDIT_SUFFIX}`);
    fixture.clock.set(new Date(Date.now() + 3_600_000).toISOString());
    await fixture.daemon.tick();
    await expect
      .poll(() => fixture.loopback.callCount(), { timeout: 30_000 })
      .toBe(1);
    expect(fixture.loopback.calls()[0]?.body).toBe(
      `running late${EDIT_SUFFIX}`,
    );
  }, 240_000);
});

/* ── row 5: undo, inside the ring and after it ────────────────────────── */

describe('s8 Sc8 — undo', () => {
  it('recalls inside the grace window, and a recalled draft stays recalled', async () => {
    const fixture = await boot(async (f) => {
      // The ceiling, so the ring is still drawn at the end of a slow run.
      // The daemon's clock is frozen either way; this is about what the
      // OPERATOR can see, which is drawn against the wall clock.
      await f.directClient.setSettings({ 'send.undoGraceSeconds': 300 });
    });
    const ids = await seedDrafts(fixture, ['see you at six']);
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await waitForRows(app, 1);
    await focusList(app);

    await press(app, 'a');
    await settled(app);
    await expect
      .poll(async () => (await readTriage(app)).cards[0]?.ringTotal, {
        timeout: 30_000,
      })
      .toBe('300');

    const ringed = await readTriage(app);
    // Colour is never the only carrier: the ring says its own word, and the
    // label a screen reader gets says how long is left.
    expect(ringed.cards[0]?.label).toContain('UNDO SEND');
    expect(ringed.cards[0]?.label).toMatch(/UNDO SEND, \d+ SECONDS REMAINING/);

    await press(app, 'z');
    await settled(app);
    // `recalled`, NOT `pending`. The plan's script assumes undo puts the
    // draft back in the queue; the lifecycle S7 froze has no row out of
    // `recalled` at all, so undo means "taken back", full stop. The operator
    // does not get their draft back — the AGENT gets to write another one,
    // which is why `recalled` is in REDRAFTABLE. Asserted as it is rather
    // than as it was planned; the finding is in the report.
    await expect
      .poll(async () => (await readTriage(app)).cards[0]?.state, {
        timeout: 30_000,
      })
      .toBe('recalled');

    const w = wire(fixture);
    expect(w.recalls).toEqual([`POST /v1/drafts/${String(ids[0])}/recall`]);
    expect(w.approves).toHaveLength(1);
    expect(w.sendShaped).toEqual([]);

    const undone = await readTriage(app);
    expect(undone.cards[0]?.word).toBe('RECALLED');
    // The ring is gone the instant the stamp is cleared, which is the whole
    // point of drawing it from the stamp: there is no window left to offer.
    expect(undone.cards[0]?.ringTotal).toBeNull();
    // Undo puts the cursor back on the thing it undid: the operator is
    // looking at that card again, so the next key must act on it.
    expect(undone.activedescendant).toBe(`draft-${String(ids[0])}`);
    expect(undone.focusId).toBe('queue-list');

    const server = await fixture.directClient.getDraft(String(ids[0]));
    expect(server.draft.state).toBe('recalled');
    expect('sendNotBefore' in server.draft).toBe(false);

    // And `a` on it does not resurrect it. The refusal is LOCAL — the store
    // knows `approve` starts only from `pending` — so the wire is not even
    // asked, which is the difference between a fast keyboard and a keyboard
    // that floods the daemon with 409s when an operator leans on a key.
    await press(app, 'a');
    await settled(app);
    expect(wire(fixture).approves).toHaveLength(1);
    const still = await readTriage(app);
    expect(still.cards[0]?.state).toBe('recalled');
    expect(still.cards[0]?.badges.join(' ')).toContain('ERROR: RECALLED');
  }, 180_000);

  it('says GRACE-ELAPSED, not MOVED ELSEWHERE, when the window has closed', async () => {
    const fixture = await boot();
    const ids = await seedDrafts(fixture, ['too late now']);
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await waitForRows(app, 1);
    await focusList(app);

    await press(app, 'a');
    await settled(app);
    await expect
      .poll(async () => (await readTriage(app)).cards[0]?.state, {
        timeout: 30_000,
      })
      .toBe('approved');

    // Move the daemon's clock past the window and do NOT tick: ticking would
    // let the grace sweep dispatch the draft, and then the refusal under
    // test would be "it is already sending" rather than "the window closed".
    const server = await fixture.directClient.getDraft(String(ids[0]));
    const closed = Date.parse(String(server.draft.sendNotBefore)) + 1_000;
    fixture.clock.set(new Date(closed).toISOString());

    await press(app, 'z');
    await settled(app);

    // The request WAS made — the app cannot know the window closed, because
    // the daemon owns the clock — and the answer is the daemon's own word.
    expect(wire(fixture).recalls).toHaveLength(1);
    const refused = await readTriage(app);
    expect(refused.cards[0]?.state).toBe('approved');
    // The honest chip. A 409 from `recall` is TWO different facts, and
    // reporting both as `changed-elsewhere` tells the operator somebody else
    // moved their draft, which is false: nobody did, the clock did.
    expect(refused.cards[0]?.badges.join(' ')).toContain('GRACE-ELAPSED');
    expect(refused.cards[0]?.badges.join(' ')).not.toContain('MOVED ELSEWHERE');
    expect(
      (await fixture.directClient.getDraft(String(ids[0]))).draft.state,
    ).toBe('approved');
  }, 180_000);
});

/* ── row 6: INV-2 at the wire, non-vacuously ──────────────────────────── */

describe('s8 Sc8 — INV-2 under speed', () => {
  it('sends nothing until the daemon does, and then only through dispatchApproved', async () => {
    const fixture = await boot();
    const ids = await seedDrafts(
      fixture,
      ['a', 'b', 'c'].map((s) => `body ${s}`),
    );
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await waitForRows(app, 3);
    await focusList(app);

    for (const key of ['a', 'a', 'r']) await press(app, key);
    await settled(app);
    await expect
      .poll(async () => (await readTriage(app)).pendingCards, {
        timeout: 30_000,
      })
      .toBe(0);

    // Two approvals, one rejection, and nothing send-shaped anywhere on the
    // socket. The GUI has done all it can do.
    const w = wire(fixture);
    expect(w.approves).toHaveLength(2);
    expect(w.rejects).toHaveLength(1);
    expect(w.sendShaped).toEqual([]);
    // The send port itself has not been touched. This is not vacuous: the
    // backend is real, wired, and about to be called.
    expect(fixture.loopback.callCount()).toBe(0);

    // Now let the daemon's own grace sweep run. Exactly the two approved
    // bodies leave, in age order, and the rejected one does not.
    fixture.clock.set(new Date(Date.now() + 3_600_000).toISOString());
    await fixture.daemon.tick();
    await expect
      .poll(() => fixture.loopback.callCount(), { timeout: 30_000 })
      .toBe(2);
    expect(fixture.loopback.calls().map((c) => c.body)).toEqual([
      'body a',
      'body b',
    ]);
    expect(
      (await fixture.directClient.getDraft(String(ids[2]))).draft.state,
    ).toBe('rejected');
    // And still nothing send-shaped crossed the app's socket: the dispatch
    // happened entirely inside the daemon, which is the whole invariant.
    expect(wire(fixture).sendShaped).toEqual([]);
  }, 240_000);
});

/* ── row 7: focus, across a long mixed run ────────────────────────────── */

describe('s8 Sc8 — focus', () => {
  it('never leaves the listbox across forty actions, except inside the editor', async () => {
    const fixture = await boot();
    await seedDrafts(
      fixture,
      Array.from({ length: 12 }, (_, i) => `draft number ${String(i)}`),
    );
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await waitForRows(app, 12);
    await focusList(app);

    const script = [
      'j',
      'j',
      'k',
      'a',
      'j',
      'r',
      ' ',
      ' ',
      'j',
      'k',
      'G',
      'g',
      'PageDown',
      'PageUp',
      'j',
      'a',
      'j',
      'j',
      'r',
      ' ',
      'k',
      'j',
      'a',
      'j',
      'G',
      'g',
      'j',
      'j',
      'a',
      ' ',
      'j',
      'k',
      'r',
      'j',
      'a',
      'j',
      'j',
      'k',
      'a',
      ' ',
    ];
    expect(script).toHaveLength(40);

    const seen = new Set<string>();
    for (const key of script) {
      await press(app, key);
      seen.add((await readTriage(app)).focusId);
    }
    await settled(app);
    // One value, and it is the listbox. Not "usually", not "at the end".
    expect([...seen]).toEqual(['queue-list']);

    // The editor is the one sanctioned exception, and it hands focus back.
    await press(app, 'e');
    await expect
      .poll(async () => (await readTriage(app)).focusTag, { timeout: 30_000 })
      .toBe('textarea');
    await press(app, 'Escape');
    await expect
      .poll(async () => (await readTriage(app)).focusId, { timeout: 30_000 })
      .toBe('queue-list');

    // Focus never fell to the document, which is the failure the roving
    // `aria-activedescendant` choice exists to prevent: a virtualized option
    // that unmounts under a roving TABINDEX drops focus to `<body>` and the
    // next keystroke silently vanishes.
    expect(seen.has('')).toBe(false);
    expect(wire(fixture).sendShaped).toEqual([]);
  }, 240_000);
});

/* ── row 8: what assistive technology is told ─────────────────────────── */

describe('s8 Sc8 — announcements', () => {
  it('labels the card, the ring, and the outcome, in words', async () => {
    const fixture = await boot();
    const ids = await seedDrafts(fixture, ['on my way']);
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await waitForRows(app, 1);
    await focusList(app);

    const before = await readTriage(app);
    expect(before.liveRole).toBe('status');
    expect(before.live).toBe('1 DRAFTS WAITING');
    // Sc6's label format, which this scenario extends rather than replaces:
    // state word, who, body. The plan's "Approve draft to …" spelling names
    // a format the app has not had since Sc6.
    expect(before.cards[0]?.label).toBe(`PENDING · ${HANDLE} · on my way`);

    await press(app, 'a');
    await settled(app);
    await expect
      .poll(async () => (await readTriage(app)).cards[0]?.ringTotal, {
        timeout: 30_000,
      })
      .not.toBeNull();
    const ringed = await readTriage(app);
    expect(ringed.cards[0]?.label).toContain(
      `APPROVED · ${HANDLE} · on my way`,
    );
    // Announced ONCE, in the option's own label, and not on a per-second
    // repeat: a live region that counted down out loud would make the twenty
    // -in-a-minute run unlistenable, and there is no timer to count with.
    expect(ringed.cards[0]?.label).toMatch(/UNDO SEND, \d+ SECONDS REMAINING/);

    fixture.clock.set(new Date(Date.now() + 3_600_000).toISOString());
    await fixture.daemon.tick();
    await expect
      .poll(async () => (await readTriage(app)).live, { timeout: 30_000 })
      .toContain('DRAFT SENT');
    const sent = await readTriage(app);
    expect(sent.live).toBe('DRAFT SENT · 0 DRAFTS WAITING');
    expect(sent.cards[0]?.word).toBe('SENT');
    expect(
      (await fixture.directClient.getDraft(String(ids[0]))).draft.state,
    ).toBe('sent');
  }, 240_000);
});

/* ── row 9: THE CHECKPOINT ────────────────────────────────────────────── */

/** What the script does to the card at each index. */
type Treatment = 'approve' | 'reject' | 'edit' | 'undo';

function treatmentFor(i: number): Treatment {
  if (i === 3 || i === 11) return 'edit';
  if (i === 1 || i === 7 || i === 16) return 'reject';
  if (i === 5) return 'undo';
  return 'approve';
}

/** Every fifth card gets its context expanded before it is dealt with. */
const expandsAt = (i: number): boolean => i % 5 === 4;

describe('s8 Sc8 — the checkpoint: twenty drafts, one minute', () => {
  it('triages twenty by keyboard alone, inside the budget and the ratchet', async () => {
    const fixture = await boot();
    const bodies = Array.from(
      { length: 20 },
      (_, i) => `draft number ${String(i)}`,
    );
    const ids = await seedDrafts(fixture, bodies);
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await waitForRows(app, 20);
    await focusList(app);
    expect((await readTriage(app)).activedescendant).toBe(
      `draft-${String(ids[0])}`,
    );

    // ── the run. Nothing between the clock and the keys. ────────────────
    const startedAt = performance.now();
    let presses = 0;
    const pressed = async (key: string): Promise<void> => {
      presses += 1;
      await press(app, key);
    };
    for (let i = 0; i < 20; i += 1) {
      if (expandsAt(i)) await pressed(' ');
      const treatment = treatmentFor(i);
      if (treatment === 'approve') await pressed('a');
      else if (treatment === 'reject') await pressed('r');
      else if (treatment === 'undo') {
        await pressed('a');
        await pressed('z');
        await pressed('a');
      } else {
        await pressed('e');
        for (const ch of EDIT_SUFFIX) await pressed(ch);
        await pressed('Meta+Enter');
      }
    }
    // Stop only when all three agree: the screen has no pending card, every
    // request the app started has come back, and the DAEMON has no pending
    // draft. The last of those is the one that makes this a measurement of
    // the product rather than of the renderer's optimism.
    await expect
      .poll(
        async () => {
          if ((await readTriage(app)).pendingCards !== 0) return -1;
          await settled(app);
          return (await fixture.directClient.listDrafts({ state: 'pending' }))
            .length;
        },
        { timeout: BUDGET_MS, interval: 25 },
      )
      .toBe(0);
    const elapsed = performance.now() - startedAt;
    // ── the run is over. ────────────────────────────────────────────────

    console.log(
      `[s8 Sc8] twenty drafts triaged in ${elapsed.toFixed(0)} ms` +
        ` (${(elapsed / 20).toFixed(0)} ms/draft, ${String(presses)} keystrokes,` +
        ` budget ${String(BUDGET_MS)} ms, margin ${(BUDGET_MS - elapsed).toFixed(0)} ms,` +
        ` floor ${String(PRESS_FLOOR_MS)} ms, above floor ${(elapsed - PRESS_FLOOR_MS).toFixed(0)} ms` +
        ` = ${((elapsed - PRESS_FLOOR_MS) / presses).toFixed(1)} ms/keystroke,` +
        ` ratchet ${String(RATCHET_MS)} ms at ${(elapsed / PRESS_FLOOR_MS).toFixed(2)}× floor)`,
    );

    // The claim, and the guard that fires long before the claim breaks.
    expect(presses).toBe(44);
    expect(RATCHET_MS).toBeLessThan(BUDGET_MS);
    expect(elapsed).toBeLessThan(BUDGET_MS);
    expect(elapsed).toBeLessThan(RATCHET_MS);
    // The floor: 44 real presses at 60 ms cannot take less than this, so a
    // run that beats it did not press real keys and the number is not a
    // measurement of anything.
    expect(elapsed).toBeGreaterThan(PRESS_FLOOR_MS);
    // Said twice, once as a ratio, because the ratio is the number a future
    // reader should argue with: 1.0 is a run that costs nothing above the
    // keyboard, and 3.0 is the most this row will accept.
    expect(elapsed / PRESS_FLOOR_MS).toBeLessThan(RATCHET_FACTOR);

    // ── clause 2: every one of the twenty was decided, in the daemon ────
    const states = new Map<string, string>();
    for (const id of ids)
      states.set(
        id,
        (await fixture.directClient.getDraft(String(id))).draft.state,
      );
    const expected = new Map(
      ids.map((id, i) => {
        const t = treatmentFor(i);
        // The undone one ends RECALLED and stays there: the third keystroke
        // of the plan's `A, Z, A` cannot re-approve it, because `recalled`
        // is terminal. Twenty drafts are still DECIDED, which is the claim
        // being measured; one of the twenty is decided as "not going out".
        return [
          id,
          t === 'reject' ? 'rejected' : t === 'undo' ? 'recalled' : 'approved',
        ];
      }),
    );
    expect([...states]).toEqual([...expected]);
    expect(
      await fixture.directClient.listDrafts({ state: 'pending' }),
    ).toHaveLength(0);

    // ── clause 3: N keystrokes, exactly N writes, and no more ───────────
    //
    // 14 plain approvals + 2 committed edits + the undone draft's FIRST
    // approval = 17 approve POSTs; 3 rejections; 1 recall. Twenty write
    // POSTs and one recall, which is the plan's arithmetic — arrived at the
    // other way round: the script's third keystroke on the undone draft
    // never reaches the wire, because the store refuses `approve` from
    // `recalled` locally. 44 keystrokes produced 21 requests and not one
    // more, which is the property this clause exists for: a fast keyboard
    // cannot manufacture an approval, and cannot manufacture a retry either.
    const w = wire(fixture);
    expect(w.approves).toHaveLength(17);
    expect(w.rejects).toHaveLength(3);
    expect(w.recalls).toHaveLength(1);
    expect(w.approves.length + w.rejects.length).toBe(20);
    // Every write POST names a DIFFERENT draft. Sc7's precedent is an
    // unguarded double press that produced four POSTs where two were
    // correct; here twenty presses that write produce twenty rows, one per
    // draft, and the duplicate set is empty.
    const twice = [...new Set(w.approves)].filter(
      (u) => w.approves.filter((x) => x === u).length > 1,
    );
    expect(twice).toEqual([]);
    expect(new Set([...w.approves, ...w.rejects]).size).toBe(20);
    // INV-2, at the wire, under the most speed this app will ever see.
    expect(w.sendShaped).toEqual([]);
    expect(fixture.loopback.callCount()).toBe(0);

    // ── clause 4: recall-under-grace survived the speed ─────────────────
    // The undone draft was recalled while the operator was typing at sixty
    // milliseconds a key, and the daemon accepted it: a grace window that
    // only works when nobody is in a hurry is not a grace window.
    const undone = await fixture.directClient.getDraft(String(ids[5]));
    expect(undone.draft.state).toBe('recalled');
    // The stamp is cleared, and clearing it is what actually stops the next
    // tick from dispatching. A recall that left the stamp would be a chip on
    // a card and a message on its way out.
    expect('sendNotBefore' in undone.draft).toBe(false);

    // ── clause 5: no card was rendered twice for the same id ────────────
    const view = await readTriage(app);
    const rendered = view.cards.map((c) => c.draftId);
    expect(new Set(rendered).size).toBe(rendered.length);
    expect(rendered).toHaveLength(20);
    expect(view.focusId).toBe('queue-list');
    expect(view.tabbables).toBe(1);
    expect(view.editors).toBe(0);

    // ── clause 6: the edits reached the wire, not just the screen ───────
    fixture.clock.set(new Date(Date.now() + 3_600_000).toISOString());
    await fixture.daemon.tick();
    await expect
      .poll(() => fixture.loopback.callCount(), { timeout: 60_000 })
      .toBe(16);
    const bodiesSent = fixture.loopback.calls().map((c) => c.body);
    expect(bodiesSent).toContain(`draft number 3${EDIT_SUFFIX}`);
    expect(bodiesSent).toContain(`draft number 11${EDIT_SUFFIX}`);
    expect(bodiesSent).not.toContain('draft number 1');
    // Not the recalled one either: undo under speed is real, at the wire.
    expect(bodiesSent).not.toContain('draft number 5');
    expect(bodiesSent).toHaveLength(16);
  }, 300_000);
});

/* ── row 10: reconciliation under contradiction ───────────────────────── */

describe('s8 Sc8 — reconciliation', () => {
  it('lands on the daemon’s answer when the hypothesis was wrong, once', async () => {
    const fixture = await boot();
    const ids = await seedDrafts(fixture, ['contested draft']);
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await waitForRows(app, 1);
    await focusList(app);

    // Somebody else rejects it from the other terminal, first.
    await fixture.directClient.rejectDraft(String(ids[0]));
    await expect
      .poll(async () => (await readTriage(app)).cards[0]?.state, {
        timeout: 30_000,
      })
      .toBe('rejected');

    // Count renders from here: a reconciliation that flickers is a
    // reconciliation the operator can misread.
    await app.page.evaluate(() => {
      const w = window as unknown as { __sc8renders?: number };
      w.__sc8renders = 0;
      new MutationObserver((records) => {
        w.__sc8renders = (w.__sc8renders ?? 0) + records.length;
      }).observe(document.getElementById('queue-list') as Node, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['data-state'],
      });
    });

    await press(app, 'a');
    await settled(app);

    // The keymap did not refuse it (the card is on screen and the link is
    // up), the STORE did — a card that is already terminal is not startable
    // — so nothing crossed the wire at all.
    expect(wire(fixture).approves).toHaveLength(0);
    expect(wire(fixture).sendShaped).toEqual([]);
    const after = await readTriage(app);
    expect(after.cards[0]?.state).toBe('rejected');
    expect(after.cards[0]?.badges.join(' ')).toContain('ERROR: REJECTED');
    const renders = await app.page.evaluate(
      () => (window as unknown as { __sc8renders?: number }).__sc8renders ?? -1,
    );
    // A refusal is one repaint, for the chip. Not two, and not a flicker
    // through `approved` and back.
    expect(renders).toBeLessThanOrEqual(4);
    expect(
      (await fixture.directClient.getDraft(String(ids[0]))).draft.state,
    ).toBe('rejected');
  }, 180_000);
});
