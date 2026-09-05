/**
 * s8 Sc6 — the queue's structure, against a real daemon.
 *
 * Scenario 8 is a checkpoint that has to triage twenty drafts in under a
 * minute by keyboard alone, and every structural decision asserted here
 * either enables that or sabotages it. Three of them are load-bearing:
 *
 *  - **One focusable element.** The listbox holds the tab stop and
 *    `aria-activedescendant` names the active card. Roving `tabindex` across
 *    twenty options would move DOM focus on every keystroke, and the list is
 *    VIRTUALIZED — the option that had focus is unmounted the moment it
 *    scrolls out of the window, which drops focus to the body and ends the
 *    run. With one focus holder, scrolling is a paint and nothing can lose
 *    focus. That is why `tabbables` is asserted to be exactly one.
 *  - **No timer.** The whole desktop app owns exactly one timer call and it
 *    is at the composition root. A queue that animated, debounced, or
 *    buffered a typeahead would need a second one, so the scroll offset is
 *    arithmetic and a burst of frames coalesces on a microtask.
 *  - **Colour is never the carrier.** Every state is spelled by a glyph AND
 *    an uppercase word before anything is tinted (§3.10).
 *
 * Everything on screen here came from the daemon. The drafts are real rows,
 * the context turns are real `message.received` frames the daemon broadcast
 * after really ingesting rows this file appended to a real chat.db, and the
 * refusal on the group card is the dispatcher's own. Nothing is injected
 * into the renderer.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  bootFixtureDaemon,
  launchApp,
  waitForConnected,
  type BootOptions,
  type FixtureDaemon,
  type LaunchedApp,
} from './harness.js';
import { runtimeGreenOffenders } from './no-green-runtime.js';

/** Synthetic, and the only kind a PUBLIC repo may carry (arch row 13). */
const HANDLE = '+15550001111';
const CHAT = `iMessage;-;${HANDLE}`;
const NAMED = '+15550002222';
const NAMED_CHAT = `iMessage;-;${NAMED}`;
/** A room. `parseChatGuid` reads the absent `;-;` as a group. */
const GROUP_CHAT = 'iMessage;+;chat5550003333';

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

interface Seeded extends FixtureDaemon {
  ids: { chat: number; handle: number; namedChat: number; namedHandle: number };
}

/**
 * A daemon whose clock starts where the wall clock is.
 *
 * The card renders a RELATIVE time against the renderer's own `now`, and the
 * harness's default instant is months in the past: a draft created on that
 * clock would render as half a year old, which is true and useless. Starting
 * the daemon at the wall clock makes "just now" the honest answer. Time is
 * still driven by hand from here on (C-11).
 */
async function boot(
  extra: { probes?: BootOptions['probes'] } = {},
): Promise<Seeded> {
  const ids = { chat: 0, handle: 0, namedChat: 0, namedHandle: 0 };
  const fixture = await bootFixtureDaemon({
    clockAt: new Date().toISOString(),
    seed: (f) => {
      ids.handle = f.addHandle(HANDLE);
      ids.chat = f.addChat({ identifier: HANDLE, handleIds: [ids.handle] });
      ids.namedHandle = f.addHandle(NAMED);
      ids.namedChat = f.addChat({
        identifier: NAMED,
        handleIds: [ids.namedHandle],
      });
    },
    ...(extra.probes === undefined ? {} : { probes: extra.probes }),
  });
  running.push(fixture.stop);
  return { ...fixture, ids };
}

async function launch(
  fixture: Seeded,
  env?: Record<string, string>,
): Promise<LaunchedApp> {
  const app = await launchApp({
    configDir: fixture.configDir,
    port: fixture.port,
    ...(env === undefined ? {} : { env }),
  });
  running.push(app.close);
  // The host Mac's automatic appearance switch made a Sc4 row pass at 02:00
  // and fail at 09:00, so the scheme is pinned; row 8 asks for the other one
  // explicitly.
  await app.page.emulateMedia({ colorScheme: 'dark' });
  return app;
}

const urls = (fixture: Seeded): string[] =>
  fixture.requests.requests().map((r) => `${r.method} ${r.url}`);

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

/* ── DOM readers ──────────────────────────────────────────────────────── */

interface CardView {
  readonly id: string;
  readonly draftId: string;
  readonly state: string;
  readonly glyph: string;
  readonly word: string;
  readonly who: string;
  readonly rule: string;
  readonly adapter: string;
  readonly time: string;
  readonly created: string;
  readonly body: string;
  readonly bodyFont: string;
  readonly badges: string[];
  readonly why: string | null;
  readonly hint: string | null;
  readonly keys: string | null;
  readonly turns: string[];
  readonly expanded: string;
  readonly active: string;
  readonly selected: string;
  readonly label: string;
  readonly glyphColour: string;
}

interface ListView {
  readonly role: string | null;
  readonly listboxes: number;
  readonly options: number;
  readonly activedescendant: string | null;
  readonly activeIsRendered: boolean;
  readonly multiselectable: string | null;
  readonly hasLabel: boolean;
  readonly tabbables: number;
  readonly interactiveInOptions: number;
  readonly nonOptionChildren: number;
  readonly cards: CardView[];
  readonly count: number;
  readonly liveRole: string | null;
  readonly focus: string;
}

/**
 * One `page.evaluate`, not fifteen.
 *
 * Every field below is read in the same paint. A row that asked six separate
 * questions could get six different answers about six different renders,
 * which is the class of flake `retry: 0` exists to refuse.
 */
function readList(app: LaunchedApp): Promise<ListView> {
  return app.page.evaluate(() => {
    const text = (el: Element | null): string => (el?.textContent ?? '').trim();
    const maybe = (root: Element, sel: string): string | null => {
      const el = root.querySelector(sel);
      return el === null ? null : (el.textContent ?? '').trim();
    };
    const list = document.getElementById('queue-list');
    const options = [...document.querySelectorAll('[role="option"]')];
    const active = list?.getAttribute('aria-activedescendant') ?? null;
    const cards = options.map((el) => {
      const glyph = el.querySelector('.card-glyph');
      const body = el.querySelector('.card-body');
      const time = el.querySelector('.card-time');
      return {
        id: el.id,
        draftId: el.getAttribute('data-draft') ?? '',
        state: el.getAttribute('data-state') ?? '',
        glyph: text(glyph),
        word: text(el.querySelector('.card-word')),
        who: text(el.querySelector('.card-who')),
        rule: text(el.querySelector('.card-rule')),
        adapter: text(el.querySelector('.card-adapter')),
        time: text(time),
        created: time?.getAttribute('data-created') ?? '',
        body: text(body),
        bodyFont:
          body === null
            ? ''
            : window.getComputedStyle(body).fontFamily.toLowerCase(),
        badges: [...el.querySelectorAll('.card-badge')].map((b) => text(b)),
        why: maybe(el, '.card-why'),
        hint: maybe(el, '.card-hint'),
        keys: maybe(el, '.card-keys'),
        turns: [...el.querySelectorAll('.turn')].map((t) => text(t)),
        expanded: el.getAttribute('aria-expanded') ?? '',
        active: el.getAttribute('data-active') ?? '',
        selected: el.getAttribute('aria-selected') ?? '',
        label: el.getAttribute('aria-label') ?? '',
        glyphColour: glyph === null ? '' : window.getComputedStyle(glyph).color,
      };
    });
    return {
      role: list?.getAttribute('role') ?? null,
      listboxes: document.querySelectorAll('[role="listbox"]').length,
      options: options.length,
      activedescendant: active,
      activeIsRendered:
        active !== null && document.getElementById(active) !== null,
      multiselectable: list?.getAttribute('aria-multiselectable') ?? null,
      hasLabel: (list?.getAttribute('aria-label') ?? '').length > 0,
      // Natively focusable OR explicitly in the tab order. The claim is that
      // the WHOLE window has one tab stop while the queue is up.
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
      cards,
      count: Number(
        document.getElementById('queue')?.getAttribute('data-count') ?? '-1',
      ),
      liveRole:
        document.getElementById('queue-live')?.getAttribute('role') ?? null,
      focus: document.activeElement?.id ?? '',
    };
  });
}

interface PaneView {
  readonly draftId: string;
  readonly rendered: number;
  readonly total: number;
  readonly pinned: string;
  readonly pinnedAlign: string;
  readonly firstTurnAlign: string;
}

function readPane(app: LaunchedApp): Promise<PaneView> {
  return app.page.evaluate(() => {
    const pane = document.getElementById('queue-pane');
    const rows = [...document.querySelectorAll('#pane-window .turn')];
    const pinned = document.getElementById('pane-pinned');
    const align = (el: Element | null | undefined): string =>
      el === null || el === undefined
        ? ''
        : window.getComputedStyle(el).textAlign;
    return {
      draftId: pane?.getAttribute('data-draft') ?? '',
      rendered: rows.length,
      total: Number(pane?.getAttribute('data-turns') ?? '-1'),
      pinned: (pinned?.textContent ?? '').trim(),
      pinnedAlign: align(pinned),
      firstTurnAlign: align(rows[0]),
    };
  });
}

interface StripView {
  readonly text: string;
  readonly state: string;
  readonly outbound: string;
  readonly label: string;
  readonly arming: string;
  readonly detail: string;
  readonly adapters: number;
}

function readStrip(app: LaunchedApp): Promise<StripView> {
  return app.page.evaluate(() => {
    const strip = document.getElementById('state-strip');
    const text = (id: string): string =>
      (document.getElementById(id)?.textContent ?? '').trim();
    return {
      text: (strip?.textContent ?? '').trim(),
      state: strip?.getAttribute('data-state') ?? '',
      outbound: strip?.getAttribute('data-outbound') ?? '',
      label: text('state-strip-label'),
      arming: text('state-strip-arming'),
      detail: text('state-strip-detail'),
      adapters: document.querySelectorAll('#state-strip .adapter-dot').length,
    };
  });
}

/** Focus the listbox the way a person does, then press a key. */
async function press(app: LaunchedApp, key: string): Promise<void> {
  await app.page.focus('#queue-list');
  await app.page.keyboard.press(key, { delay: 60 });
}

/* ── row 1: the listbox, the twenty cards, and what each one says ─────── */

describe('s8 Sc6 row 1: twenty drafts are one listbox of twenty options', () => {
  it('renders the ARIA contract, the card fields, and oldest first', async () => {
    const fixture = await boot();
    await fixture.directClient.createRule({
      name: 'weeknight replies',
      matcher: { kind: 'contact', handles: [HANDLE] },
      adapterId: 'agent-one',
    });
    const made: string[] = [];
    const base = Date.now();
    for (let i = 0; i < 20; i += 1) {
      // The daemon's clock moves between drafts, so "oldest first" is a real
      // ordering rather than an insertion-order accident.
      fixture.clock.set(new Date(base - (20 - i) * 60_000).toISOString());
      const draft = await fixture.directClient.createDraft({
        chatGuid: CHAT,
        body: `draft number ${String(i)}`,
      });
      made.push(draft.id);
    }
    fixture.clock.set(new Date(base).toISOString());
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await waitForRows(app, 20);

    const view = await readList(app);
    expect(view.listboxes).toBe(1);
    expect(view.role).toBe('listbox');
    expect(view.options).toBe(20);
    expect(view.count).toBe(20);
    expect(view.hasLabel).toBe(true);
    // Sc9 selects with `X`, so the container declares multi-selection now
    // rather than growing the attribute later on a listbox assistive tech
    // has already described one way.
    expect(view.multiselectable).toBe('true');
    // ONE tab stop in the window. Twenty roving stops is the design that
    // cannot survive virtualization.
    expect(view.tabbables).toBe(1);
    expect(view.focus).toBe('');
    // A container whose children are not all options is not a listbox,
    // whatever its role says — so the virtualization spacers live outside it.
    expect(view.nonOptionChildren).toBe(0);
    // No interactive descendant inside an option: every action lives on the
    // keyboard or in the right pane, which is what keeps an option a single
    // announceable thing and keeps the approval row un-bypassable.
    expect(view.interactiveInOptions).toBe(0);
    // The active descendant is named AND really in the document: a reference
    // to an unmounted row is a dangling `aria-activedescendant`.
    expect(view.activedescendant).toBe(`draft-${String(made[0])}`);
    expect(view.activeIsRendered).toBe(true);
    expect(view.liveRole).toBe('status');

    const first = view.cards[0];
    expect(first?.draftId).toBe(made[0]);
    expect(first?.active).toBe('true');
    expect(first?.selected).toBe('false');
    expect(first?.state).toBe('pending');
    // The raw handle: there is no contact policy row for this one (row 4).
    expect(first?.who).toBe(HANDLE);
    // A manual draft carries `ruleId: null`, and the chip says so rather
    // than inventing a rule name for a draft no rule produced.
    expect(first?.rule).toBe('MANUAL');
    expect(first?.adapter).toBe('HUMAN');
    expect(first?.body).toBe('draft number 0');
    expect(first?.bodyFont).toContain('ui-monospace');
    expect(first?.time.length).toBeGreaterThan(0);
    // The relative label is derived; the instant it was derived from rides
    // an attribute, so this row is pinned to the daemon's own record.
    const server = await fixture.directClient.getDraft(String(made[0]));
    expect(first?.created).toBe(server.draft.createdAt);
    // The legend belongs to the card the keys would act on, and only there.
    expect(first?.keys).toContain('A approve');
    expect(view.cards.filter((c) => c.keys !== null)).toHaveLength(1);

    // Oldest first, in the order the daemon's own timestamps give.
    expect(view.cards.map((c) => c.draftId)).toEqual(made);

    // The catalogue really was fetched, over the wire, by the app.
    expect(urls(fixture).some((u) => u.startsWith('GET /v1/rules'))).toBe(true);
    expect(urls(fixture).some((u) => u.startsWith('GET /v1/contacts'))).toBe(
      true,
    );
    expect(urls(fixture).filter((u) => /send/i.test(u))).toEqual([]);
  }, 180_000);
});

/* ── row 2: a proactive draft says why it exists ──────────────────────── */

describe('s8 Sc6 row 2: PROACTIVE is a badge and a reason, or neither', () => {
  it('shows the daemon’s own reason, and omits both when there is none', async () => {
    const fixture = await boot();
    const proactive = await fixture.directClient.createDraft({
      chatGuid: CHAT,
      body: 'their flight lands late, shall I say we are delayed?',
    });
    const plain = await fixture.directClient.createDraft({
      chatGuid: NAMED_CHAT,
      body: 'an ordinary reply',
    });
    // `POST /v1/drafts` has no proactive field — the only producer is an
    // adapter's `proactive.propose` over the agent socket, which this suite
    // has no business standing up. So the fact is written into the daemon's
    // OWN store and the app reads it back over the OWN route, and the
    // assertion below is against what that route answered, never against
    // the string written here.
    fixture.daemon.store.db
      .prepare('UPDATE drafts SET proactive_reason = ? WHERE id = ?')
      .run('their flight status changed', proactive.id);

    const app = await launch(fixture);
    await waitForConnected(app.page);
    await waitForRows(app, 2);

    const view = await readList(app);
    const byId = new Map(view.cards.map((c) => [c.draftId, c]));
    const served = await fixture.directClient.getDraft(proactive.id);
    expect(served.draft.proactiveReason).toBeDefined();
    expect(byId.get(proactive.id)?.badges).toContain('PROACTIVE');
    expect(byId.get(proactive.id)?.why).toBe(served.draft.proactiveReason);
    // And the ordinary one says nothing at all, rather than saying nothing
    // in a box that is still there.
    expect(byId.get(plain.id)?.badges).not.toContain('PROACTIVE');
    expect(byId.get(plain.id)?.why).toBeNull();
  }, 120_000);
});

/* ── row 3: a group card, and the daemon’s own refusal ────────────────── */

describe('s8 Sc6 row 3: GROUP is a chip, and the refusal is the daemon’s', () => {
  it('legends the group card, approves it, and lands on the dispatcher’s word', async () => {
    const fixture = await boot();
    const group = await fixture.directClient.createDraft({
      chatGuid: GROUP_CHAT,
      body: 'to the room',
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await waitForRows(app, 1);

    const before = await readList(app);
    expect(before.cards[0]?.badges).toContain('GROUP');
    // v1 cannot send to a room, and the legend says so on the card the key
    // would act on rather than in a tooltip nobody opens.
    expect(before.cards[0]?.keys).toContain('A approve (drafts only in v1)');

    const asked = urls(fixture).length;
    await press(app, 'a');
    await app.page.waitForSelector(
      `[data-draft="${group.id}"][data-state="approved"]`,
      { timeout: 15_000 },
    );
    // One request, and it is an approval. The GUI does not know this draft
    // is doomed, and must not need to: pre-validating in the renderer is how
    // a second policy vocabulary gets in front of the operator.
    expect(urls(fixture).slice(asked)).toEqual([
      `POST /v1/drafts/${group.id}/approve`,
    ]);

    // Now the daemon answers. The undo grace elapses, the dispatcher refuses
    // the room in its own words, and the card carries that word.
    fixture.clock.set(new Date(Date.now() + 600_000).toISOString());
    await fixture.daemon.tick();
    await app.page.waitForSelector(
      `[data-draft="${group.id}"][data-state="failed"]`,
      { timeout: 15_000 },
    );

    const after = await readList(app);
    expect(after.cards[0]?.word).toBe('FAILED');
    const served = await fixture.directClient.getDraft(group.id);
    expect(served.draft.error?.code).toBe('group-send-disabled');
    expect(after.cards[0]?.badges).toContain(
      String(served.draft.error?.code).toUpperCase(),
    );
    // INV-2 at the wire: an approval is not a send, and a refused one is
    // certainly not.
    expect(urls(fixture).filter((u) => /send/i.test(u))).toEqual([]);
  }, 180_000);
});

/* ── row 4: a handle with a policy row, and one without ───────────────── */

describe('s8 Sc6 row 4: the name is the policy row’s, or there isn’t one', () => {
  it('names the known handle and signposts PEOPLE for the unknown one', async () => {
    const fixture = await boot();
    await fixture.directClient.setContactPolicy(NAMED, 'draft-only', {
      displayName: 'Sam Rivers',
    });
    const known = await fixture.directClient.createDraft({
      chatGuid: NAMED_CHAT,
      body: 'to the known one',
    });
    const unknown = await fixture.directClient.createDraft({
      chatGuid: CHAT,
      body: 'to the unknown one',
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await waitForRows(app, 2);

    const view = await readList(app);
    const byId = new Map(view.cards.map((c) => [c.draftId, c]));
    expect(byId.get(known.id)?.who).toBe('Sam Rivers');
    expect(byId.get(known.id)?.hint).toBeNull();
    // No policy row means the raw handle and a signpost, never a guess.
    expect(byId.get(unknown.id)?.who).toBe(HANDLE);
    expect(byId.get(unknown.id)?.hint).toContain('NO POLICY ROW');
    expect(byId.get(unknown.id)?.hint).toContain('PEOPLE');
  }, 120_000);
});

/* ── row 5: SPACE expands the observed context, and collapses it ──────── */

describe('s8 Sc6 row 5: SPACE opens three turns of context', () => {
  it('expands, aligns inbound against our draft, and collapses again', async () => {
    const fixture = await boot();
    const draft = await fixture.directClient.createDraft({
      chatGuid: CHAT,
      body: 'our answer',
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await waitForRows(app, 1);

    // The turns are OBSERVED, not fetched. `GET /v1/drafts/:id` answers with
    // the draft and its approvals and carries no conversation, and S8 adds
    // no route (F-107). What the app has is what the daemon broadcast while
    // it was watching — so this appends real rows to the real chat.db and
    // lets the ingest poll really find them.
    for (const line of ['turn one', 'turn two', 'turn three', 'turn four'])
      fixture.fixture.addMessage({
        chatId: fixture.ids.chat,
        handleId: fixture.ids.handle,
        text: line,
      });
    await app.page.waitForSelector('#queue[data-turns="4"]', {
      timeout: 60_000,
    });

    expect((await readList(app)).cards[0]?.turns).toEqual([]);
    await press(app, 'Space');
    await app.page.waitForSelector(
      `[data-draft="${draft.id}"][aria-expanded="true"]`,
      { timeout: 15_000 },
    );
    const open = await readList(app);
    // Three, and the three most recent: context is what came just before the
    // thing you are being asked to approve.
    expect(open.cards[0]?.turns).toEqual([
      'turn two',
      'turn three',
      'turn four',
    ]);
    await press(app, 'Space');
    await app.page.waitForSelector(
      `[data-draft="${draft.id}"][aria-expanded="false"]`,
      { timeout: 15_000 },
    );
    expect((await readList(app)).cards[0]?.turns).toEqual([]);
  }, 180_000);
});

/* ── row 6: the right pane, virtualized, and J moves it ───────────────── */

describe('s8 Sc6 row 6: five hundred turns are not five hundred rows', () => {
  it('virtualizes the conversation, pins our draft, and follows J', async () => {
    const fixture = await boot();
    const first = await fixture.directClient.createDraft({
      chatGuid: CHAT,
      body: 'first draft',
    });
    const second = await fixture.directClient.createDraft({
      chatGuid: NAMED_CHAT,
      body: 'second draft',
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await waitForRows(app, 2);

    fixture.fixture.addMessageBurst(500, {
      chatId: fixture.ids.chat,
      handleId: fixture.ids.handle,
      text: 'turn',
    });
    await app.page.waitForSelector('#queue[data-turns="500"]', {
      timeout: 120_000,
    });

    const pane = await readPane(app);
    expect(pane.draftId).toBe(first.id);
    expect(pane.total).toBe(500);
    // The window is a window. A pane that mounted every turn would make one
    // `J` cost five hundred nodes, which is the twenty-in-a-minute story
    // failing quietly instead of loudly.
    expect(pane.rendered).toBeGreaterThan(0);
    expect(pane.rendered).toBeLessThan(80);
    // Our draft is the last thing in the conversation and the one thing in
    // it that is not a turn.
    expect(pane.pinned).toContain('first draft');
    expect(pane.pinnedAlign).toBe('right');
    expect(pane.firstTurnAlign).toBe('left');

    await press(app, 'j');
    await app.page.waitForSelector(`#queue-pane[data-draft="${second.id}"]`, {
      timeout: 15_000,
    });
    const moved = await readPane(app);
    expect(moved.pinned).toContain('second draft');
    // A different conversation: nothing was ever appended to this one.
    expect(moved.total).toBe(0);
    const list = await readList(app);
    expect(list.activedescendant).toBe(`draft-${second.id}`);
    // Focus never moved. It is the container's, and stays the container's.
    expect(list.focus).toBe('queue-list');
  }, 240_000);
});

/* ── row 7: the state strip’s four canonical states ───────────────────── */

describe('s8 Sc6 row 7: the strip says what the daemon says', () => {
  it('CONNECTED, the arming word, a horizon, a pending count and adapter dots', async () => {
    const fixture = await boot();
    await fixture.directClient.createAdapter({
      id: 'agent-one',
      kind: 'generic',
      displayName: 'Agent One',
    });
    await fixture.directClient.createDraft({ chatGuid: CHAT, body: 'one' });
    await fixture.directClient.createDraft({ chatGuid: CHAT, body: 'two' });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await waitForRows(app, 2);

    const status = await fixture.directClient.status();
    const strip = await readStrip(app);
    expect(strip.state).toBe('connected');
    expect(strip.label).toBe('● CONNECTED');
    expect(strip.outbound).toBe(status.armed?.reason ?? 'unknown');
    // The daemon's own word, uppercased, never a friendlier synonym.
    expect(strip.arming).toContain(
      (status.armed?.reason ?? 'no schedule').toUpperCase(),
    );
    expect(strip.detail).toContain('2 PENDING');
    expect(strip.adapters).toBe(status.adapters.length);
    expect(strip.adapters).toBe(1);

    // A real horizon, from a real hold. `until` is the earliest REAL horizon
    // the daemon knows about, so the only way to assert the `until hh:mm`
    // half of this strip is to give the daemon one.
    await fixture.directClient.pause('1h');
    await app.page.waitForSelector('#state-strip[data-outbound="paused"]', {
      timeout: 15_000,
    });
    const held = await fixture.directClient.status();
    expect(held.armed?.until).not.toBeNull();
    expect((await readStrip(app)).arming).toBe(
      `PAUSED UNTIL ${hhmm(String(held.armed?.until))}`,
    );
  }, 180_000);

  it('SEND DISABLED when the automation probe says denied', async () => {
    const fixture = await boot({
      probes: { automation: () => Promise.resolve('denied') },
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);

    const status = await fixture.directClient.status();
    expect(status.connectionState).toBe('read-only');
    const strip = await readStrip(app);
    expect(strip.state).toBe('connected');
    expect(strip.outbound).toBe('read-only');
    expect(strip.label).toBe('◐ SEND DISABLED');
    expect(strip.arming).toBe('READ-ONLY');
  }, 120_000);

  it('OUTBOUND: KILLED, and the drafts still collect', async () => {
    const fixture = await boot();
    await fixture.directClient.createDraft({ chatGuid: CHAT, body: 'held' });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await waitForRows(app, 1);

    await fixture.directClient.setKillSwitch(true);
    await app.page.waitForSelector(
      '#state-strip[data-outbound="kill-switch"]',
      { timeout: 15_000 },
    );
    const strip = await readStrip(app);
    expect(strip.label).toBe('⊘ OUTBOUND: KILLED');
    expect(strip.detail).toContain('NOTHING SENDS');
    expect(strip.detail).toContain('DRAFTS STILL COLLECT');
    // The second half of that sentence is a product claim, not a label, so
    // it is asserted as one.
    expect((await readList(app)).options).toBe(1);
  }, 120_000);

  it('DAEMON UNREACHABLE, with the attempt and the last sync', async () => {
    const fixture = await boot();
    await fixture.directClient.createDraft({ chatGuid: CHAT, body: 'one' });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await waitForRows(app, 1);
    const synced = await app.page.getAttribute('html', 'data-store-synced-at');
    expect(synced).not.toBeNull();

    fixture.requests.sever();
    await app.page.waitForSelector('html[data-conn="reconnecting"]', {
      timeout: 30_000,
    });
    const strip = await readStrip(app);
    expect(strip.label).toBe('◌ DAEMON UNREACHABLE');
    expect(strip.arming).toMatch(/^RETRYING · ATTEMPT \d+$/);
    // A time the app actually observed, never a plausible one.
    expect(strip.detail).toContain(`LAST SYNC ${hhmm(String(synced))}`);
  }, 120_000);
});

/* ── row 8: the glyph carries the state, and nothing is green ─────────── */

describe('s8 Sc6 row 8: colour is the third carrier, never the first', () => {
  it('every card spells its state as a glyph AND a word, in token colours', async () => {
    const fixture = await boot();
    const pending = await fixture.directClient.createDraft({
      chatGuid: CHAT,
      body: 'still pending',
    });
    const approved = await fixture.directClient.createDraft({
      chatGuid: CHAT,
      body: 'already approved',
    });
    await fixture.directClient.approveDraft(approved.id);
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await waitForRows(app, 2);

    const view = await readList(app);
    const byId = new Map(view.cards.map((c) => [c.draftId, c]));
    expect(byId.get(pending.id)?.glyph).toBe('○');
    expect(byId.get(pending.id)?.word).toBe('PENDING');
    expect(byId.get(approved.id)?.glyph).toBe('●');
    expect(byId.get(approved.id)?.word).toBe('APPROVED');
    // Two states, two glyphs. A reader who cannot tell the tint from the
    // neutral still reads the difference — which is the whole rule, and the
    // one a designer's instinct breaks by reaching for two colours.
    expect(byId.get(pending.id)?.glyph).not.toBe(byId.get(approved.id)?.glyph);
    // And what assistive tech is handed says it in words, not in a glyph it
    // would have to pronounce.
    expect(byId.get(pending.id)?.label).toContain('PENDING');
    expect(byId.get(approved.id)?.label).toContain('APPROVED');

    // Every glyph's computed colour is a declared token's resolved value, so
    // nothing on this screen invented a hue.
    const tokens = await app.page.evaluate(() => {
      const probe = document.createElement('span');
      document.body.append(probe);
      const out: Record<string, string> = {};
      for (const name of [
        '--tint',
        '--ink',
        '--ink-dim',
        '--warn',
        '--danger',
      ]) {
        probe.style.color = `var(${name})`;
        out[name] = window.getComputedStyle(probe).color;
      }
      probe.remove();
      return out;
    });
    const allowed = new Set(Object.values(tokens));
    for (const card of view.cards)
      expect(allowed.has(card.glyphColour), card.glyphColour).toBe(true);

    // The runtime sweep, over a populated queue, in both schemes.
    const nodes = await app.page.evaluate(
      () => document.querySelectorAll('*').length,
    );
    expect(nodes).toBeGreaterThan(40);
    expect(await runtimeGreenOffenders(app.page)).toEqual([]);
    await app.page.emulateMedia({ colorScheme: 'light' });
    expect(await runtimeGreenOffenders(app.page)).toEqual([]);
  }, 180_000);
});

/* ── row 9: the demo badge, and only when it was asked for ────────────── */

describe('s8 Sc6 row 9: DEMO DATA is a badge, and never a default', () => {
  it('shows it under the flag and not without it', async () => {
    const fixture = await boot();
    await fixture.directClient.createDraft({ chatGuid: CHAT, body: 'one' });
    const plain = await launch(fixture);
    await waitForConnected(plain.page);
    await waitForRows(plain, 1);
    expect(await plain.page.$('#demo-badge')).toBeNull();
    await plain.close();

    const demo = await launch(fixture, { WEMESSAGE_DEMO: '1' });
    await waitForConnected(demo.page);
    await waitForRows(demo, 1);
    expect((await demo.page.textContent('#demo-badge'))?.trim()).toBe(
      'DEMO DATA',
    );
  }, 180_000);
});
