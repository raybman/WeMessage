/**
 * s8 Sc16 — the tray, the PAUSE submenu, deep links and the global shortcut,
 * against a real daemon and a real Electron.
 *
 * This is the slice's largest attack surface and three of its four
 * sub-surfaces take input from outside the app, so the file is organised by
 * what each one can do wrong rather than by what it looks like.
 *
 *  - **A deep link is untrusted input from any website.** `wemessage://…`
 *    can be triggered by a page the operator merely VISITS. So a deep link
 *    may navigate and select, and it may never act. That is enforced in
 *    three places: the grammar has no production for a verb (unit rows), the
 *    handler calls exactly two functions (arch row), and rows 6–9 here prove
 *    it AT THE WIRE — malformed, unknown host, nonexistent draft, absurdly
 *    long, arriving on the wizard, arriving mid-approval, arriving while the
 *    kill switch is on. For each: zero writes, no request matching
 *    `/approve|dispatch/i`, an empty send port, every draft in the state it
 *    started in.
 *
 *  - **The global shortcut fires when the app is not focused.** It SUMMONS.
 *    It does not toggle the kill switch, because a system-wide chord carries
 *    no context: the operator pressing it cannot see which state they are
 *    in, so half the time the chord meant to STOP the world would RELEASE
 *    the deny. Row 10 proves it shows the window and selects the pane whose
 *    first control is the kill switch, and that it writes nothing.
 *
 *  - **The tray menu acts while the window is invisible.** It may TIGHTEN a
 *    deny and never release one (row 4), and it may set AND release a clamp
 *    (row 5), because a clamp binds only autonomy and a control that can
 *    only be set from the tray is a trap. Row 5 also proves the daemon's own
 *    claim about resume: coming back flushes nothing.
 *
 *  - **The tray title is a place to leak.** It is visible to anyone looking
 *    at the screen. Row 3 seeds a distinctive synthetic body and handle and
 *    proves neither, nor a `wm_` prefix, reaches the title or the tooltip.
 *
 * OBSERVATION. A `Tray` is invisible to Playwright's page API: no DOM, no
 * accessibility tree, and on this Electron version no `tray.getImage()`. The
 * plan's answer was a `data-tray-menu` JSON mirror on `<html>`; this file
 * refuses it, because asserting on a mirror proves the mirror was written.
 * Instead main retains the REAL `Tray`, the REAL `Menu` and the REAL
 * `NativeImage`s under the test flag, and every row here reaches them with
 * `electronApp.evaluate`, which runs in MAIN. Menu items are invoked by
 * calling `MenuItem.click()` on the real item, so a row that says "this menu
 * entry does not approve" is a statement about the handler that is actually
 * wired to it.
 *
 * Synthetic everything, as everywhere in this PUBLIC repo.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import {
  bootFixtureDaemon,
  launchApp,
  waitForConnected,
  type FixtureDaemon,
  type LaunchedApp,
} from './harness.js';
import {
  SHORTCUT_LINE,
  SHORTCUT_STATES,
  TRAY_ACCELERATOR,
  type ShortcutState,
} from '../../src/main/tray-model.js';

const ALICE = '+15550000001';
const ALICE_CHAT = `iMessage;-;${ALICE}`;
const AGENT = 'agent-one';
/** Sc16's draft ids. Real ULIDs, so the grammar's happy path is exercised. */
const D1 = '01HQ00000000000000000SC16A';
const D2 = '01HQ00000000000000000SC16B';
const D3 = '01HQ00000000000000000SC16C';
const D4 = '01HQ00000000000000000SC16D';
/** A ULID that parses and names nothing. */
const GHOST = '01HQ0000000000000000GHOST1';

/** Built the way Sc4's spec builds `wm_`, so this file never spells it. */
const TOKEN_PREFIX = `wm${'_'}`;

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
  ids: { alice: number; aliceChat: number };
}

async function boot(): Promise<Seeded> {
  const ids = { alice: 0, aliceChat: 0 };
  const fixture = await bootFixtureDaemon({
    clockAt: new Date().toISOString(),
    seed: (f) => {
      ids.alice = f.addHandle(ALICE);
      ids.aliceChat = f.addChat({ identifier: ALICE, handleIds: [ids.alice] });
    },
  });
  running.push(fixture.stop);
  return { ...fixture, ids };
}

async function launch(fixture: Seeded): Promise<LaunchedApp> {
  const app = await launchApp({
    configDir: fixture.configDir,
    port: fixture.port,
  });
  running.push(app.close);
  await app.page.emulateMedia({ colorScheme: 'dark' });
  return app;
}

const urls = (fixture: Seeded): string[] =>
  fixture.requests.requests().map((r) => `${r.method} ${r.url}`);

function since(fixture: Seeded): () => string[] {
  const mark = fixture.requests.requests().length;
  return () =>
    fixture.requests
      .requests()
      .slice(mark)
      .map((r) => `${r.method} ${r.url}`);
}

const writes = (list: readonly string[]): string[] =>
  list.filter((u) => !u.startsWith('GET ') && !u.startsWith('HEAD '));

async function seedAdapter(fixture: Seeded): Promise<void> {
  await fixture.directClient.createAdapter({
    id: AGENT,
    kind: 'generic',
    displayName: AGENT,
  });
}

/** A pending draft. `at` orders the tray's "three oldest" rows. */
function seedDraft(
  fixture: Seeded,
  id: string,
  key: string,
  body: string,
  ageMs = 0,
): void {
  const at = new Date(fixture.clock.nowMs() - ageMs).toISOString();
  fixture.daemon.store.insertDraft({
    id,
    inboundGuid: null,
    chatGuid: ALICE_CHAT,
    ruleId: null,
    adapterId: AGENT,
    idempotencyKey: key,
    body,
    originalBody: body,
    state: 'pending',
    stateChangedAt: at as never,
    expiresAt: new Date(fixture.clock.nowMs() + 3_600_000).toISOString(),
    createdAt: at as never,
  } as never);
}

/**
 * A draft created the way the daemon creates them, so the app is TOLD.
 *
 * `seedDraft` writes straight into the store, which is right for rows that
 * are seeded BEFORE the app launches: the tray fetches once on the edge into
 * `connected` and picks them up. It is wrong for anything seeded afterwards,
 * and this row's first draft got that wrong. `scheduler.tick()` is
 * `sweepCircuit` + `sweepArming` + `sweepExpired` + `sweepGrace`; it emits no
 * `draft.created`, so a store row inserted behind the daemon's back is a row
 * no event ever announces and an event-driven tray can never learn about.
 * Waiting for the badge to move would have hung for thirty seconds and then
 * blamed the tray.
 *
 * The honest repair is to make the daemon do the thing: `POST /v1/drafts`
 * appends, broadcasts `draft.created`, and the tray refetches on it. That is
 * the path a real adapter takes, which is the path worth testing.
 */
async function createDraft(fixture: Seeded, body: string): Promise<string> {
  const draft = await fixture.directClient.createDraft({
    chatGuid: ALICE_CHAT,
    body,
  });
  return draft.id;
}

/* ── reading the real tray out of main ────────────────────────────────── */

interface TrayItemView {
  id: string;
  label: string;
  enabled: boolean;
  type: string;
  submenu: TrayItemView[];
}

interface TrayView {
  exists: boolean;
  destroyed: boolean;
  /** What main last passed to `setTitle`. Darwin-only API; see `titleRead`. */
  title: string;
  /** `tray.getTitle()` where the platform has one, else `null`. */
  titleRead: string | null;
  tooltip: string;
  image: string;
  menu: TrayItemView[];
}

/**
 * The tray, as main actually holds it.
 *
 * `setTitle`/`getTitle` are darwin-only on this Electron version, so the
 * readback is feature-detected and the row that uses it asserts the RECORD
 * everywhere and the READBACK where it exists. That keeps the Linux lane —
 * the one CI runs the whole suite on — honest about what it can see rather
 * than silently skipping the assertion that matters.
 */
const trayView = (app: LaunchedApp): Promise<TrayView> =>
  app.app.evaluate(() => {
    interface Item {
      id: string;
      label: string;
      enabled: boolean;
      type: string;
      /**
       * `null` on an item that has none, NOT `undefined`.
       *
       * Probed rather than assumed, and the first spelling of this helper
       * assumed. Electron's `MenuItem` initialises the field, so every plain
       * item and every separator carries an explicit `null` and an
       * `=== undefined` guard walks straight into it. That crashed every row
       * that read the menu and blamed the tray for thirty seconds first.
       */
      submenu?: { items: Item[] } | null;
    }
    const g = globalThis as unknown as {
      __wmTrayState?: {
        tray: {
          isDestroyed(): boolean;
          getTitle?: () => string;
        } | null;
        menu: { items: Item[] } | null;
        title: string;
        tooltip: string;
        image: string;
      };
    };
    const state = g.__wmTrayState;
    const walk = (items: Item[]): TrayItemView[] =>
      items.map((i) => ({
        id: i.id ?? '',
        label: i.label ?? '',
        enabled: i.enabled,
        type: i.type,
        submenu:
          i.submenu === undefined || i.submenu === null
            ? []
            : walk(i.submenu.items),
      }));
    if (state === undefined || state.tray === null) {
      return {
        exists: false,
        destroyed: true,
        title: '',
        titleRead: null,
        tooltip: '',
        image: '',
        menu: [],
      };
    }
    return {
      exists: true,
      destroyed: state.tray.isDestroyed(),
      title: state.title,
      titleRead:
        typeof state.tray.getTitle === 'function'
          ? state.tray.getTitle()
          : null,
      tooltip: state.tooltip,
      image: state.image,
      menu: state.menu === null ? [] : walk(state.menu.items),
    };
  }) as Promise<TrayView>;

const flat = (items: readonly TrayItemView[]): TrayItemView[] => {
  const out: TrayItemView[] = [];
  for (const item of items) {
    out.push(item);
    out.push(...flat(item.submenu));
  }
  return out;
};

const itemById = (view: TrayView, id: string): TrayItemView | undefined =>
  flat(view.menu).find((i) => i.id === id);

/** Invoke the REAL `MenuItem` by id, the way the operating system would. */
const clickTray = (app: LaunchedApp, id: string): Promise<boolean> =>
  app.app.evaluate(({}, wanted: string) => {
    interface Item {
      id: string;
      enabled: boolean;
      click(): void;
      /** `null` on an item with none. See the note in `trayView`. */
      submenu?: { items: Item[] } | null;
    }
    const g = globalThis as unknown as {
      __wmTrayState?: { menu: { items: Item[] } | null };
    };
    const menu = g.__wmTrayState?.menu ?? null;
    if (menu === null) return false;
    const find = (items: Item[]): Item | null => {
      for (const item of items) {
        if (item.id === wanted) return item;
        const inner =
          item.submenu === undefined || item.submenu === null
            ? null
            : find(item.submenu.items);
        if (inner !== null) return inner;
      }
      return null;
    };
    const found = find(menu.items);
    if (found === null || !found.enabled) return false;
    found.click();
    return true;
  }, id) as Promise<boolean>;

/**
 * Every draft id the DOM currently marks as chosen, under one attribute.
 *
 * The queue has TWO of them and they mean different things. `data-active` is
 * the cursor, one card at a time, and it is what navigation moves.
 * `aria-selected` is Sc9's bulk selection, the set the batch verbs read. A
 * tray item or a deep link may move the first; moving the second would be
 * loading the gun for `⇧A`, so the rows here assert on both.
 */
const chosen = (page: Page, attr: string): Promise<string[]> =>
  page.evaluate(
    (name: string) =>
      [...document.querySelectorAll(`[data-draft][${name}="true"]`)].map(
        (el) => el.getAttribute('data-draft') ?? '',
      ),
    attr,
  );

/** The cursor landed on this card, and no card joined the bulk set. */
async function activeIs(page: Page, id: string, ms = 30_000): Promise<void> {
  await page.waitForSelector(`[data-draft="${id}"][data-active="true"]`, {
    timeout: ms,
  });
  expect(await chosen(page, 'aria-selected')).toEqual([]);
}

/** Poll main until the tray satisfies a predicate. No sleeping, no timers. */
async function trayUntil(
  app: LaunchedApp,
  predicate: (view: TrayView) => boolean,
): Promise<TrayView> {
  await expect
    .poll(async () => predicate(await trayView(app)), { timeout: 30_000 })
    .toBe(true);
  return trayView(app);
}

/* ── the five glyphs, as real NativeImages ────────────────────────────── */

interface ImageView {
  name: string;
  template: boolean;
  width: number;
  height: number;
  /** Every pixel has r === g === b. A macOS template image is a mask. */
  monochrome: boolean;
  /** A cheap fingerprint, to prove the five are five and not one. */
  ink: number;
}

const imageViews = (app: LaunchedApp): Promise<ImageView[]> =>
  app.app.evaluate(() => {
    interface Img {
      isTemplateImage(): boolean;
      getSize(): { width: number; height: number };
      toBitmap(): Buffer;
      isEmpty(): boolean;
    }
    const g = globalThis as unknown as {
      __wmTrayState?: { images: Record<string, Img> };
    };
    const images = g.__wmTrayState?.images ?? {};
    return Object.entries(images).map(([name, img]) => {
      const size = img.getSize();
      const bitmap = img.toBitmap();
      let monochrome = true;
      let ink = 0;
      for (let i = 0; i + 3 < bitmap.length; i += 4) {
        const b = bitmap[i] ?? 0;
        const gr = bitmap[i + 1] ?? 0;
        const r = bitmap[i + 2] ?? 0;
        const a = bitmap[i + 3] ?? 0;
        if (b !== gr || gr !== r) monochrome = false;
        if (a !== 0) ink += 1;
      }
      return {
        name,
        template: img.isTemplateImage(),
        width: size.width,
        height: size.height,
        monochrome,
        ink,
      };
    });
  }) as Promise<ImageView[]>;

/* ── driving the two doors a deep link arrives through ────────────────── */

/** The cold-start door: macOS delivers `open-url`, possibly before ready. */
const openUrl = (app: LaunchedApp, url: string): Promise<void> =>
  app.app.evaluate(({ app: electronApp }, raw: string) => {
    electronApp.emit(
      'open-url',
      { preventDefault: () => undefined } as never,
      raw,
    );
  }, url) as Promise<void>;

/** The warm door: a second launch hands the URL to the running instance. */
const secondInstance = (app: LaunchedApp, url: string): Promise<void> =>
  app.app.evaluate(({ app: electronApp }, raw: string) => {
    electronApp.emit(
      'second-instance',
      {} as never,
      ['/path/to/electron', '/path/to/main.js', raw],
      '/',
      {},
    );
  }, url) as Promise<void>;

const shortcutView = (
  app: LaunchedApp,
): Promise<{ accelerator: string; state: string; isRegistered: boolean }> =>
  app.app.evaluate(({ globalShortcut }) => {
    const g = globalThis as unknown as {
      __wmTrayState?: { shortcut: { accelerator: string; state: string } };
    };
    const s = g.__wmTrayState?.shortcut ?? {
      accelerator: '',
      state: 'unknown',
    };
    return {
      accelerator: s.accelerator,
      state: s.state,
      isRegistered:
        s.accelerator === ''
          ? false
          : globalShortcut.isRegistered(s.accelerator),
    };
  }) as Promise<{ accelerator: string; state: string; isRegistered: boolean }>;

/** Press the chord the way the window server would: main invokes it. */
const fireShortcut = (app: LaunchedApp): Promise<boolean> =>
  app.app.evaluate(() => {
    const g = globalThis as unknown as {
      __wmTrayState?: { fire: (() => void) | null };
    };
    const fire = g.__wmTrayState?.fire ?? null;
    if (fire === null) return false;
    fire();
    return true;
  }) as Promise<boolean>;

const windowCount = (app: LaunchedApp): Promise<number> =>
  app.app.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
  ) as Promise<number>;

const closeAllWindows = (app: LaunchedApp): Promise<void> =>
  app.app.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) win.close();
  }) as Promise<void>;

/* ── shared readiness ─────────────────────────────────────────────────── */

async function ready(app: LaunchedApp, rows: number): Promise<void> {
  await waitForConnected(app.page);
  await app.page.waitForSelector(`html[data-store-rows="${rows}"]`, {
    timeout: 30_000,
  });
}

const screenOf = (page: Page): Promise<string> =>
  page.evaluate(
    () => document.documentElement.getAttribute('data-screen') ?? '',
  );

/* ════════════════════════════════════════════════════════════════════════
 * row 1 — the five glyphs are real, monochrome, template images
 * ════════════════════════════════════════════════════════════════════════ */

describe('s8 Sc16 row 1: the icon carries state as a SHAPE', () => {
  it('mints five distinct monochrome template images', async () => {
    const fixture = await boot();
    const app = await launch(fixture);
    await waitForConnected(app.page);

    const images = await imageViews(app);
    expect(images.map((i) => i.name).sort()).toEqual(
      [
        'armedTemplate',
        'disconnectedTemplate',
        'draftOnlyTemplate',
        'killedTemplate',
        'sendingTemplate',
      ].sort(),
    );
    const inks = new Set<number>();
    for (const image of images) {
      // §1.7 asks for a `Template` suffix and a template image. The plan
      // asks for SVGs; `nativeImage` on this Electron decodes PNG and JPEG
      // and nothing else, and Sc1 row 4 bans every raster under
      // `apps/desktop/src` and `apps/desktop/assets` with an EMPTY
      // allowlist. So the glyphs are generated procedurally into a bitmap,
      // which also makes "monochrome" checkable at the byte level instead of
      // by a text sweep over a colour literal.
      expect([image.name, image.template]).toEqual([image.name, true]);
      expect([image.name, image.monochrome]).toEqual([image.name, true]);
      expect(image.width).toBeGreaterThan(8);
      expect(image.height).toBe(image.width);
      expect(image.ink).toBeGreaterThan(0);
      inks.add(image.ink);
    }
    expect(inks.size).toBe(images.length);
  }, 300_000);

  it('wears the posture it is in, and changes when the daemon says so', async () => {
    const fixture = await boot();
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await trayUntil(app, (t) => t.image === 'armedTemplate');

    await fixture.directClient.setKillSwitch(true);
    const killed = await trayUntil(app, (t) => t.image === 'killedTemplate');
    // The strip and the tray agree, because they are the same fact.
    await app.page.waitForSelector(
      '#state-strip[data-outbound="kill-switch"]',
      {
        timeout: 30_000,
      },
    );
    expect(killed.tooltip).toContain('KILLED');

    await fixture.directClient.setKillSwitch(false);
    await trayUntil(app, (t) => t.image === 'armedTemplate');
  }, 300_000);
});

/* ════════════════════════════════════════════════════════════════════════
 * row 2 — the badge counts, caps and goes silent
 * ════════════════════════════════════════════════════════════════════════ */

describe('s8 Sc16 row 2: the badge is a count or it is nothing', () => {
  it('shows nothing at zero, the number below ten, 9+ above, and nothing while down', async () => {
    const fixture = await boot();
    await seedAdapter(fixture);
    const app = await launch(fixture);
    await ready(app, 0);
    expect((await trayView(app)).title).toBe('');

    // Created through the route, not inserted behind the daemon's back: the
    // tray learns about new work from `draft.created`, and a store write no
    // event announces is invisible to it by design.
    await createDraft(fixture, 'the front desk will call you back');
    await createDraft(fixture, 'your table is held until eight');
    await createDraft(fixture, 'checkout is at eleven');
    const three = await trayUntil(app, (t) => t.title === '3');
    if (three.titleRead !== null) expect(three.titleRead).toBe('3');

    for (let n = 4; n <= 12; n += 1) {
      await createDraft(fixture, `body ${String(n)}`);
    }
    const many = await trayUntil(app, (t) => t.title === '9+');
    if (many.titleRead !== null) expect(many.titleRead).toBe('9+');

    // The socket drops and the number stops being defensible, so it stops
    // being shown. A count that was true a minute ago is a lie now.
    await fixture.daemon.stop();
    await app.page.waitForSelector(
      'html[data-conn="down"], html[data-conn="reconnecting"]',
      {
        timeout: 30_000,
      },
    );
    const down = await trayUntil(app, (t) => t.title === '');
    expect(down.tooltip).toContain('DISCONNECTED');
    expect(down.image).toBe('disconnectedTemplate');
  }, 300_000);
});

/* ════════════════════════════════════════════════════════════════════════
 * row 3 — the two public strings leak nothing
 * ════════════════════════════════════════════════════════════════════════ */

describe('s8 Sc16 row 3: the title and tooltip carry no content', () => {
  it('never names a handle, a body or a token prefix', async () => {
    const fixture = await boot();
    await seedAdapter(fixture);
    const secret = 'zqxjkv distinctive body marker';
    seedDraft(fixture, D1, 'sc16-leak', secret);
    const app = await launch(fixture);
    await ready(app, 1);
    const tray = await trayUntil(app, (t) => t.title === '1');

    for (const surface of [tray.title, tray.tooltip]) {
      for (const leak of [
        'zqxjkv',
        'distinctive',
        ALICE,
        ALICE.slice(1),
        ALICE_CHAT,
        D1,
        TOKEN_PREFIX,
        fixture.token,
      ]) {
        expect(surface).not.toContain(leak);
      }
    }
    // And the title is not merely free of secrets, it is one of eleven
    // strings. There is no input that widens it.
    expect(tray.title).toMatch(/^(|[1-9]|9\+)$/);
    if (tray.titleRead !== null) expect(tray.titleRead).toBe(tray.title);
  }, 300_000);
});

/* ════════════════════════════════════════════════════════════════════════
 * row 4 — the menu mirrors the strip and navigates, and cannot approve
 * ════════════════════════════════════════════════════════════════════════ */

describe('s8 Sc16 row 4: the menu shows the queue and only selects it', () => {
  it('lists the three oldest and opens the one that was clicked', async () => {
    const fixture = await boot();
    await seedAdapter(fixture);
    seedDraft(
      fixture,
      D1,
      'sc16-a',
      'oldest: the front desk will call you back',
      4_000,
    );
    seedDraft(
      fixture,
      D2,
      'sc16-b',
      'second: your table is held until eight',
      3_000,
    );
    seedDraft(fixture, D3, 'sc16-c', 'third: checkout is at eleven', 2_000);
    seedDraft(fixture, D4, 'sc16-d', 'fourth: the pool closes at nine', 1_000);
    const app = await launch(fixture);
    await ready(app, 4);

    const tray = await trayUntil(app, (t) =>
      flat(t.menu).some((i) => i.id === `draft:${D1}`),
    );
    const header = tray.menu[0];
    expect(header?.enabled).toBe(false);
    expect(header?.label).toContain('4 PENDING');
    expect(header?.label).toContain('ARMED');

    const rows = flat(tray.menu).filter((i) => i.id.startsWith('draft:'));
    expect(rows.map((i) => i.id)).toEqual([
      `draft:${D1}`,
      `draft:${D2}`,
      `draft:${D3}`,
    ]);
    for (const row of rows) expect(row.label.length).toBeLessThanOrEqual(50);

    // Navigate to another screen first, so "the click did it" is provable.
    await app.page.keyboard.press('Meta+Digit5');
    await app.page.waitForSelector('html[data-screen="audit"]', {
      timeout: 15_000,
    });

    const mark = since(fixture);
    expect(await clickTray(app, `draft:${D2}`)).toBe(true);
    await app.page.waitForSelector('html[data-screen="queue"]', {
      timeout: 30_000,
    });
    // `data-active`, and NOT `aria-selected`. The first spelling of this row
    // asked for the wrong attribute: Sc9 gave the listbox two independent
    // notions of chosen-ness, and `aria-selected` is the BULK SELECTION —
    // the set that `⇧A` approves in one stroke. `data-active` is the cursor.
    // A tray item that put a card into the bulk set would be a tray item
    // that armed a batch, so asserting both ways round is the stronger row:
    // the cursor moved, and the set the batch verbs read did not.
    await activeIs(app.page, D2);
    expect(writes(mark())).toEqual([]);
    expect(fixture.loopback.calls()).toEqual([]);
  }, 300_000);
});

/* ════════════════════════════════════════════════════════════════════════
 * row 5 — a deny may be tightened here, never released
 * ════════════════════════════════════════════════════════════════════════ */

describe('s8 Sc16 row 5: the tray arms the kill switch and cannot disarm it', () => {
  it('writes exactly one toggle, then offers no way back except the window', async () => {
    const fixture = await boot();
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await trayUntil(app, (t) => itemById(t, 'kill')?.enabled === true);

    const mark = since(fixture);
    expect(await clickTray(app, 'kill')).toBe(true);
    await app.page.waitForSelector(
      '#state-strip[data-outbound="kill-switch"]',
      {
        timeout: 30_000,
      },
    );
    expect(writes(mark())).toEqual(['POST /v1/toggles/kill-switch']);

    const killed = await trayUntil(
      app,
      (t) => itemById(t, 'kill')?.enabled === false,
    );
    const kill = itemById(killed, 'kill');
    expect(kill?.label).toContain('KILLED');
    expect(kill?.label.toUpperCase()).toContain('WINDOW');
    // Nothing anywhere in the tree can release it.
    expect(await clickTray(app, 'kill')).toBe(false);
    for (const item of flat(killed.menu)) {
      if (!item.enabled) continue;
      expect(item.label).not.toMatch(/resume outbound|un-?kill|turn.*off/i);
    }
    // The window still can, which is the point: releasing a deny needs the
    // banner, the horizon and the note that only the settings pane carries.
    await app.page.keyboard.press('Meta+Digit6');
    await app.page.waitForSelector('#kill-state[data-kill="killed"]', {
      timeout: 60_000,
    });
    await app.page.click('#kill-toggle');
    await app.page.waitForSelector('#kill-state[data-kill="armed"]', {
      timeout: 30_000,
    });
    await trayUntil(app, (t) => itemById(t, 'kill')?.enabled === true);
  }, 300_000);
});

/* ════════════════════════════════════════════════════════════════════════
 * row 6 — PAUSE is a clamp: symmetric, and it flushes nothing
 * ════════════════════════════════════════════════════════════════════════ */

describe('s8 Sc16 row 6: PAUSE is a clamp, and resuming releases nothing', () => {
  it('pauses and resumes from the tray, and holds nothing back on return', async () => {
    const fixture = await boot();
    await seedAdapter(fixture);
    seedDraft(fixture, D1, 'sc16-pause', 'the front desk will call you back');
    const app = await launch(fixture);
    await ready(app, 1);
    await trayUntil(app, (t) => itemById(t, 'pause:1h')?.enabled === true);

    const note = itemById(await trayView(app), 'pause:note');
    expect(note?.enabled).toBe(false);
    expect(note?.label).toContain('CLAMP');
    expect(note?.label).toContain('NOT A DENY');

    const mark = since(fixture);
    expect(await clickTray(app, 'pause:1h')).toBe(true);
    await trayUntil(app, (t) =>
      (itemById(t, 'pause')?.label ?? '').startsWith('PAUSED UNTIL '),
    );
    expect(writes(mark())).toEqual(['POST /v1/toggles/pause']);
    // A horizon, not a countdown. The tray has no timer to correct one with.
    const paused = itemById(await trayView(app), 'pause');
    expect(paused?.label).toMatch(/^PAUSED UNTIL \d\d:\d\d/);
    expect(paused?.label).not.toMatch(/\b(IN|LEFT|REMAINING)\b/);
    expect(await trayView(app).then((t) => t.image)).toBe('draftOnlyTemplate');

    // The clamp is symmetric: what the tray set, the tray releases. That is
    // the difference from the kill switch above, and it is not a preference
    // — `evaluateGate` answers a pause with `allow: true` and
    // `clampedBy = 'outside-window'`, so it binds AUTONOMY and not the
    // operator, and a control that can only be set from a menu is a trap.
    const mark2 = since(fixture);
    expect(await clickTray(app, 'pause:resume')).toBe(true);
    await trayUntil(app, (t) => itemById(t, 'pause')?.label === 'PAUSE');
    expect(writes(mark2())).toEqual(['POST /v1/toggles/pause']);

    // And coming back flushes NOTHING. `arming.setPause(null)` deletes the
    // setting, appends `arming.resumed` and sweeps; the only requeue site in
    // the tree is the scheduler. Sc14 proved the equivalent for the kill
    // switch; this is the clamp half of the same claim.
    await fixture.daemon.tick();
    expect(fixture.loopback.callCount()).toBe(0);
    expect((await fixture.directClient.getDraft(D1)).draft.state).toBe(
      'pending',
    );
  }, 300_000);

  it('sends the daemon the TOKEN for the third item, not a computed instant', async () => {
    const fixture = await boot();
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await trayUntil(app, (t) => itemById(t, 'pause:window')?.enabled === true);

    // The plan says this item passes `armed.until` and is disabled with "no
    // window is armed" when that is null. Both are wrong: the daemon takes
    // `rest-of-window`, resolves it through `armedWindowClose`, and answers
    // 409 `not-armed` when no SCHEDULE window is open — which is not what
    // `armed.until` reports. The GUI offers it and lets the daemon rule.
    const mark = since(fixture);
    expect(await clickTray(app, 'pause:window')).toBe(true);
    await expect
      .poll(() => writes(mark()), { timeout: 30_000 })
      .toEqual(['POST /v1/toggles/pause']);
    expect(fixture.loopback.calls()).toEqual([]);
  }, 300_000);
});

/* ════════════════════════════════════════════════════════════════════════
 * row 7 — the negative row: invoke everything, approve nothing
 * ════════════════════════════════════════════════════════════════════════ */

describe('s8 Sc16 row 7: no path through this menu reaches an approval', () => {
  it('invokes every enabled item once and issues no approving request', async () => {
    const fixture = await boot();
    await seedAdapter(fixture);
    seedDraft(
      fixture,
      D1,
      'sc16-neg-1',
      'the front desk will call you back',
      2_000,
    );
    seedDraft(
      fixture,
      D2,
      'sc16-neg-2',
      'your table is held until eight',
      1_000,
    );
    const app = await launch(fixture);
    await ready(app, 2);
    await trayUntil(app, (t) =>
      flat(t.menu).some((i) => i.id.startsWith('draft:')),
    );

    const before = await trayView(app);
    for (const item of flat(before.menu)) {
      expect(item.label).not.toMatch(
        /approve|reject|recall|send now|dispatch/i,
      );
    }

    const mark = since(fixture);
    // Everything except QUIT, which would end the process and prove nothing.
    const ids = flat(before.menu)
      .filter((i) => i.enabled && i.id !== 'quit')
      .map((i) => i.id);
    expect(ids.length).toBeGreaterThan(4);
    const landed: Record<string, boolean> = {};
    for (const id of ids) {
      landed[id] = await clickTray(app, id);
    }
    // The clicks are fire-and-forget BY DESIGN: a tray callback that awaited
    // a daemon round trip would freeze the menu under the operator's cursor.
    // So the log is read only once main has SEEN the last of them land, and
    // the wait is on an observable consequence rather than on a duration. The
    // first spelling of this row read the log the instant the loop finished
    // and was intermittently short one entry, because the kill POST was still
    // on the wire — a flake that would have looked like proof of the property
    // it was meant to test.
    //
    // KILL is the last item this loop presses that writes anything, so a menu
    // that has been told about the kill has been told about every write
    // before it, and one wait covers the lot.
    const settled = await trayUntil(
      app,
      (t) => itemById(t, 'kill')?.enabled === false,
    );
    // And while we are looking at it: §1.3.6's precedence is visible in the
    // menu. This row pauses three times and THEN kills, so the daemon is
    // holding two things at once and `resolveArming` reports the stronger —
    // `kill-switch` outranks `paused`. The pause item drops its horizon and
    // RESUME NOW goes dark, which is the only honest thing it can say: a
    // resume posted while the switch is down would clear a clamp and release
    // nothing, and an enabled item promising otherwise is the same lie the
    // `outside-window` guard above exists to prevent.
    //
    // The second spelling of this row waited for `pause:resume` to become
    // ENABLED here and hung for thirty seconds. That was the row being wrong
    // about the product, not the product being wrong — so it is now pinned
    // the other way up, as an assertion rather than a wait.
    expect(itemById(settled, 'pause:resume')?.enabled).toBe(false);
    expect(itemById(settled, 'pause')?.label).toBe('PAUSE');

    const after = mark();
    // Enumerated, non-empty, and every member is a legitimate read or one of
    // the two toggles this menu is allowed to reach. `writes` is asserted as
    // a de-duplicated SET, because the same toggle may be pressed twice by a
    // sweep that walks the whole tree.
    expect(after.length).toBeGreaterThan(0);
    expect(after.filter((u) => /approve|dispatch/i.test(u))).toEqual([]);
    expect([...new Set(writes(after))].sort()).toEqual([
      'POST /v1/toggles/kill-switch',
      'POST /v1/toggles/pause',
    ]);
    expect(fixture.loopback.calls()).toEqual([]);
    for (const id of [D1, D2]) {
      expect((await fixture.directClient.getDraft(id)).draft.state).toBe(
        'pending',
      );
    }
  }, 300_000);
});

/* ════════════════════════════════════════════════════════════════════════
 * row 8 — deep links: both doors, one validated path
 * ════════════════════════════════════════════════════════════════════════ */

describe('s8 Sc16 row 8: a deep link navigates and selects', () => {
  it('arrives through open-url and through second-instance identically', async () => {
    const fixture = await boot();
    await seedAdapter(fixture);
    seedDraft(fixture, D1, 'sc16-dl-1', 'the front desk will call you back');
    const app = await launch(fixture);
    await ready(app, 1);

    await openUrl(app, 'wemessage://audit');
    await app.page.waitForSelector('html[data-screen="audit"]', {
      timeout: 30_000,
    });

    await secondInstance(app, 'wemessage://people');
    await app.page.waitForSelector('html[data-screen="people"]', {
      timeout: 30_000,
    });

    const mark = since(fixture);
    await openUrl(app, `wemessage://queue/draft/${D1}`);
    await activeIs(app.page, D1);
    expect(writes(mark())).toEqual([]);
  }, 300_000);

  it('re-creates a window that was closed, with the linked card active', async () => {
    const fixture = await boot();
    await seedAdapter(fixture);
    seedDraft(fixture, D1, 'sc16-dl-cold', 'the front desk will call you back');
    const app = await launch(fixture);
    await ready(app, 1);

    // Closing the last window does NOT quit: the tray is the app now.
    await closeAllWindows(app);
    await expect.poll(() => windowCount(app), { timeout: 30_000 }).toBe(0);
    const trayAlive = await trayView(app);
    expect(trayAlive.exists).toBe(true);
    expect(trayAlive.destroyed).toBe(false);

    const reopened = app.app.waitForEvent('window');
    await openUrl(app, `wemessage://queue/draft/${D1}`);
    const page = await reopened;
    await activeIs(page, D1, 60_000);
    expect(await screenOf(page)).toBe('queue');
  }, 300_000);

  it('re-creates a window from the tray OPEN item too', async () => {
    const fixture = await boot();
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await closeAllWindows(app);
    await expect.poll(() => windowCount(app), { timeout: 30_000 }).toBe(0);

    const reopened = app.app.waitForEvent('window');
    expect(await clickTray(app, 'open')).toBe(true);
    const page = await reopened;
    await page.waitForSelector('html[data-conn]', { timeout: 60_000 });
    expect(await windowCount(app)).toBe(1);
  }, 300_000);
});

/* ════════════════════════════════════════════════════════════════════════
 * row 9 — deep links: every rejection, and the no-act property at the wire
 * ════════════════════════════════════════════════════════════════════════ */

describe('s8 Sc16 row 9: a deep link is hostile input and cannot act', () => {
  it('refuses every malformed shape and writes nothing at all', async () => {
    const fixture = await boot();
    await seedAdapter(fixture);
    seedDraft(
      fixture,
      D1,
      'sc16-hostile-1',
      'the front desk will call you back',
      2_000,
    );
    seedDraft(
      fixture,
      D2,
      'sc16-hostile-2',
      'your table is held until eight',
      1_000,
    );
    const app = await launch(fixture);
    await ready(app, 2);

    // Park somewhere that is not the queue, so "fell back to the queue" is
    // distinguishable from "did nothing".
    await app.page.keyboard.press('Meta+Digit5');
    await app.page.waitForSelector('html[data-screen="audit"]', {
      timeout: 15_000,
    });

    const mark = since(fixture);
    const hostile = [
      '',
      'not a url at all',
      'wemessage://',
      'wemessage://evil/../x',
      'wemessage://queue.evil.example.com/draft/' + D1,
      'https://evil.example.com/queue/draft/' + D1,
      'file:///etc/passwd',
      `javascript:fetch('/v1/drafts/${D1}/approve',{method:'POST'})`,
      `wemessage://queue/draft/${'0'.repeat(4096)}`,
      'wemessage://settings/../../queue/draft/' + D1,
      'wemessage://QUEUE',
      `wemessage://queue/draft/${D1}/approve`,
      `wemessage://approve/${D1}`,
    ];
    for (const url of hostile) {
      await openUrl(app, url);
      await secondInstance(app, url);
    }
    // Everything above lands on the queue with nothing selected, or is
    // refused outright. Either way the SCREEN may change and the DAEMON may
    // not: a URL is allowed to move the cursor and nothing else.
    await app.page.waitForSelector('html[data-screen="queue"]', {
      timeout: 30_000,
    });
    const seen = mark();
    expect(writes(seen)).toEqual([]);
    expect(seen.filter((u) => /approve|dispatch/i.test(u))).toEqual([]);
    expect(fixture.loopback.calls()).toEqual([]);
    for (const id of [D1, D2]) {
      expect((await fixture.directClient.getDraft(id)).draft.state).toBe(
        'pending',
      );
    }
    // The app is still alive and still answering: none of that threw.
    expect(await screenOf(app.page)).toBe('queue');
  }, 300_000);

  it('shows a not-found chip for an id nobody has, and selects nothing', async () => {
    const fixture = await boot();
    await seedAdapter(fixture);
    seedDraft(fixture, D1, 'sc16-ghost', 'the front desk will call you back');
    const app = await launch(fixture);
    await ready(app, 1);

    const mark = since(fixture);
    // A well-formed URL naming a draft that does not exist. It is NOT a
    // reason to fetch: `GET /v1/drafts/<id>` on an id an attacker chose is a
    // probe the app would be performing on their behalf, and a 404 is an
    // oracle. The queue answers from what it already holds.
    await openUrl(app, `wemessage://queue/draft/${GHOST}`);
    await app.page.waitForSelector(`html[data-not-found="${GHOST}"]`, {
      timeout: 30_000,
    });
    expect(mark().filter((u) => u.includes(GHOST))).toEqual([]);
    // Nothing is under the cursor that was not under it before, and nothing
    // has joined the bulk set either. Both halves, because an id nobody has
    // must not be able to reach either notion of chosen-ness.
    expect(await chosen(app.page, 'data-active')).not.toContain(GHOST);
    expect(await chosen(app.page, 'aria-selected')).toEqual([]);

    // A non-ULID is the same answer with the operator's own text echoed,
    // bounded and escaped by being set as an attribute rather than markup.
    await openUrl(app, 'wemessage://queue/draft/not-a-ulid');
    await app.page.waitForSelector('html[data-not-found="not-a-ulid"]', {
      timeout: 30_000,
    });
    expect(writes(mark())).toEqual([]);
  }, 300_000);

  it('does not tear the operator out of the wizard, and still writes nothing', async () => {
    const fixture = await boot();
    await seedAdapter(fixture);
    seedDraft(fixture, D1, 'sc16-wizard', 'the front desk will call you back');
    const app = await launch(fixture);
    await ready(app, 1);

    // The wizard is asked for by name from the Permissions pane (Sc15).
    await app.page.keyboard.press('Meta+Digit6');
    await app.page.waitForSelector('#set-perms', { timeout: 30_000 });
    await app.page.click('#set-perms-wizard');
    await app.page.waitForSelector('#wizard', { timeout: 30_000 });

    const mark = since(fixture);
    await openUrl(app, `wemessage://queue/draft/${D1}`);
    await secondInstance(app, 'wemessage://settings');
    // The wizard is a MODE, and Sc15 made it kill the ⌘-digit keymap for
    // exactly this reason. A deep link is that same navigation by another
    // door, so it is not allowed to yank a half-finished onboarding off the
    // screen — it selects UNDERNEATH and the operator lands there on exit.
    expect(await screenOf(app.page)).toBe('wizard');
    expect(writes(mark())).toEqual([]);
    expect(fixture.loopback.calls()).toEqual([]);
  }, 300_000);

  it('cannot slip past an in-flight approval or a live kill switch', async () => {
    const fixture = await boot();
    await seedAdapter(fixture);
    seedDraft(fixture, D1, 'sc16-race', 'the front desk will call you back');
    const app = await launch(fixture);
    await ready(app, 1);

    // One real approval, and a URL arriving in the middle of it.
    const mark = since(fixture);
    await app.page.focus('#queue-list');
    await app.page.keyboard.press('a', { delay: 20 });
    await openUrl(app, `wemessage://queue/draft/${D1}`);
    await openUrl(app, 'wemessage://audit');
    await expect
      .poll(
        () =>
          mark().filter((u) => u.includes(`/v1/drafts/${D1}/approve`)).length,
        { timeout: 30_000 },
      )
      .toBe(1);
    // Exactly one, from the keystroke. The URLs added none.
    expect(mark().filter((u) => u.includes('/approve'))).toHaveLength(1);

    // And with the kill switch on, a URL is still only a cursor move.
    await fixture.directClient.setKillSwitch(true);
    await app.page.waitForSelector(
      '#state-strip[data-outbound="kill-switch"]',
      {
        timeout: 30_000,
      },
    );
    const mark2 = since(fixture);
    for (const url of [
      `wemessage://queue/draft/${D1}`,
      'wemessage://settings',
      'wemessage://queue',
    ]) {
      await openUrl(app, url);
    }
    expect(writes(mark2())).toEqual([]);
    expect(mark2().filter((u) => /approve|dispatch|toggles/i.test(u))).toEqual(
      [],
    );
  }, 300_000);
});

/* ════════════════════════════════════════════════════════════════════════
 * row 10 — the global shortcut summons and says so
 * ════════════════════════════════════════════════════════════════════════ */

describe('s8 Sc16 row 10: ⌘⇧K brings the window forward and nothing else', () => {
  it('registers, summons, and writes nothing', async () => {
    const fixture = await boot();
    const app = await launch(fixture);
    await waitForConnected(app.page);

    const shortcut = await shortcutView(app);
    expect(shortcut.accelerator).toBe('CommandOrControl+Shift+K');
    expect(shortcut.state).toBe('registered');
    expect(shortcut.isRegistered).toBe(true);

    await closeAllWindows(app);
    await expect.poll(() => windowCount(app), { timeout: 30_000 }).toBe(0);

    const mark = since(fixture);
    const reopened = app.app.waitForEvent('window');
    expect(await fireShortcut(app)).toBe(true);
    const page = await reopened;
    // It lands on the pane whose FIRST control is the kill switch, so the
    // panic gesture is one keystroke from the deny and zero keystrokes from
    // an accidental one. A chord that toggled would, half the time, RELEASE
    // the deny the operator was reaching for.
    await page.waitForSelector('#kill-toggle', { timeout: 60_000 });
    expect(await screenOf(page)).toBe('settings');
    expect(writes(mark())).toEqual([]);
    expect(fixture.loopback.calls()).toEqual([]);
  }, 300_000);

  /**
   * THIS ROW WAS WRONG, and the record of why is the point of the comment.
   *
   * Its first draft manufactured a "REAL collision": two apps, one
   * accelerator, and the second `globalShortcut.register` returns false
   * because the first still holds the chord. That premise is false on this
   * platform. Verified empirically on Electron 44.2.0 / darwin 25.5.0 with
   * two concurrent processes both registering `CommandOrControl+Shift+K`:
   * BOTH got `register() === true` and BOTH got `isRegistered() === true`.
   * macOS does not arbitrate the way the row assumed, so the row was
   * asserting a fact about the operating system rather than about this app,
   * and it would have failed for a reason that has nothing to do with the
   * code under test.
   *
   * Deleting the row, or relaxing it to "any state is fine", would have been
   * the wrong repair — the copy this scenario added exists precisely so that
   * a dead chord is not swallowed. So the row was rewritten to assert the
   * thing that IS this app's responsibility and that a collision would have
   * been merely one way of reaching:
   *
   *  1. Whatever the OS answered, the recorded word is in the closed
   *     vocabulary. Never a bare boolean, never a fourth state.
   *  2. The recorded word agrees with what the window server says RIGHT NOW.
   *     `registered` and `isRegistered` are the same fact or the app is
   *     lying about a key it does not hold.
   *  3. The same sentence reaches BOTH surfaces — the menu bar and the
   *     settings pane — and both equal `SHORTCUT_LINE[state]` exactly. One
   *     table, two readers, no third spelling drifting quietly out of step.
   *  4. The tray's line is inert. It is a report, not a control.
   *
   * Run over two concurrently-running apps, so the multi-instance situation
   * the original row was reaching for is still exercised: whatever states the
   * two of them end up in, each says its own truthfully.
   */
  it('reports whatever the OS answered, in one vocabulary and three agreeing places', async () => {
    const first = await boot();
    const second = await boot();
    const appA = await launch(first);
    await waitForConnected(appA.page);
    const appB = await launch(second);
    await waitForConnected(appB.page);

    for (const app of [appA, appB]) {
      const view = await shortcutView(app);
      expect(view.accelerator).toBe(TRAY_ACCELERATOR);
      // (1) A closed vocabulary.
      expect(SHORTCUT_STATES).toContain(view.state);
      const state = SHORTCUT_STATES.find(
        (name): name is ShortcutState => name === view.state,
      );
      expect(state).toBeDefined();
      // (2) The word main recorded and the fact the window server reports
      // are the same fact. `taken` and `declined` both mean "this process
      // does not hold it"; `registered` means it does.
      expect([view.state, view.state === 'registered']).toEqual([
        view.state,
        view.isRegistered,
      ]);

      // (3) One table, two readers.
      const words = SHORTCUT_LINE[state as ShortcutState];
      await app.page.keyboard.press('Meta+Digit6');
      await app.page.waitForSelector('#settings[data-settings="ready"]', {
        timeout: 60_000,
      });
      const line = await app.page.evaluate(
        () => document.getElementById('kill-shortcut')?.textContent ?? '',
      );
      expect(line).toBe(words);
      expect(line).toContain('⌘⇧K');
      const trayLine = itemById(await trayView(app), 'shortcut');
      expect(trayLine?.label).toBe(words);
      // (4) A report, not a control.
      expect(trayLine?.enabled).toBe(false);
      expect(await clickTray(app, 'shortcut')).toBe(false);
    }
  }, 300_000);
});

/* ════════════════════════════════════════════════════════════════════════
 * row 11 — the tray outlives the window, and the app outlives the window
 * ════════════════════════════════════════════════════════════════════════ */

describe('s8 Sc16 row 11: closing the window does not close the app', () => {
  it('keeps the tray, the connection and the badge alive with no window', async () => {
    const fixture = await boot();
    await seedAdapter(fixture);
    seedDraft(fixture, D1, 'sc16-life', 'the front desk will call you back');
    const app = await launch(fixture);
    await ready(app, 1);
    await trayUntil(app, (t) => t.title === '1');

    await closeAllWindows(app);
    await expect.poll(() => windowCount(app), { timeout: 30_000 }).toBe(0);

    // The gateway is still listening, so the badge still moves. This is the
    // whole reason a tray earns its place: it is the surface that works when
    // the window is not there.
    await createDraft(fixture, 'your table is held until eight');
    const grown = await trayUntil(app, (t) => t.title === '2');
    expect(grown.exists).toBe(true);
    expect(grown.destroyed).toBe(false);
    expect(urls(fixture).some((u) => u.startsWith('GET /v1/drafts'))).toBe(
      true,
    );
  }, 300_000);
});
