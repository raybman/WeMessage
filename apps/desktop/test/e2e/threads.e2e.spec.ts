/**
 * v2 A1: the conversations list, against a real daemon over a 4,000-chat
 * chat.db.
 *
 * Board 01 opens the v2 messenger on "All Messages": every conversation on
 * this Mac, newest first, under a chip that counts them and dates the count.
 * A1 is the first slice of that, and it is deliberately the read half only.
 * The queue is untouched, nothing is pushed, and nothing in this mode can
 * write: the rows below count the wire to prove it.
 *
 * Four claims, one row each:
 *
 *  - **It is fast at the size people actually have.** 4,000 conversations is
 *    an ordinary Messages history. The clock starts on the ⇧⌘R keydown, read
 *    in the page by a capture listener, and stops when the first option is in
 *    the document with the list marked ready, read by a MutationObserver in
 *    the same page. So the number spans the bridge, main, the client, the
 *    socket, the daemon, the SQL and the paint, and it is read off the
 *    renderer's own monotonic clock (`performance.now()`, a clock READ, not a
 *    scheduled callback). Budget: 300 ms.
 *  - **It is keyboard-only and it is a listbox.** One tab stop, roving
 *    `aria-activedescendant`, a mounted window of at most 60 options with the
 *    active one always inside it, no interactive node inside any option, and
 *    the next page fetched when the cursor reaches the end of what is held.
 *    Enter and Escape do nothing yet, on purpose: opening a conversation is a
 *    later slice, and a key that half-did it would be worse than one that
 *    does nothing.
 *  - **It is the operator's list, nobody else's.** An adapter token presented
 *    as a bearer is a 401 on the composed daemon's real socket, not only on
 *    `inject` in the route suite.
 *  - **It says so when there is nothing, in the host's zone.** Zero
 *    conversations is a real state (a fresh Mac), drawn as words beside an
 *    empty listbox that still holds the window's one tab stop, under a chip
 *    whose "as of" is in whatever zone the machine is in.
 *
 * About ⇧⌘R: Electron's default application menu binds the same chord to
 * View > Force Reload, and this app sets no menu of its own. In real use the
 * renderer's `preventDefault` on the keydown is what keeps the chord from
 * reaching that menu item; keys injected over CDP never reach the native menu
 * at all, so no row here can observe that half. Row 1 proves the page did not
 * reload under the chord (a marker planted before the press survives it), and
 * the slice report carries the menu half as a stated residual risk.
 *
 * No timer, here or in the product. Waiting is `waitForSelector`, which is
 * the runner's business, and the two banned spellings appear nowhere in this
 * file, comments included, because the arch row that says so scans it as
 * raw text.
 *
 * Synthetic handles only (`+1555…`), as everywhere in this PUBLIC repo.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  bootFixtureDaemon,
  launchApp,
  waitForConnected,
  type FixtureDaemon,
  type LaunchedApp,
} from './harness.js';

/** An ordinary Messages history, and the size the budget is claimed at. */
const CHATS = 4_000;
/** Friday 2026-09-04, 16:42 in Los Angeles, 23:42 in UTC. */
const NOW = '2026-09-04T23:42:00.000Z';
const HOST_TZ = 'America/Los_Angeles';
/** The slice's claim, in milliseconds, from keydown to the first row. */
const BUDGET_MS = 300;
/** What one page holds: the route's default limit. */
const PAGE = 100;
/** The most options the listbox mounts at once, as the queue does. */
const WINDOW = 60;

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

/** Conversation `i`'s one participant, synthetic. */
const handleOf = (i: number): string => `+1555${String(i).padStart(7, '0')}`;

/**
 * A daemon over `chats` one-to-one conversations, conversation `i` last
 * spoken in `i` minutes before NOW, so the newest-first order is 0, 1, 2…
 *
 * Seeded before boot and in one transaction: 4,000 autocommits would be
 * seconds of fsync for no claim. Every line is inbound and no rule exists,
 * so the daemon's catch-up scan drafts nothing and the queue stays empty,
 * which row 1 checks rather than assumes.
 */
async function boot(chats: number): Promise<FixtureDaemon> {
  const fixture = await bootFixtureDaemon({
    clockAt: NOW,
    seed: (f) => {
      const at0 = Date.parse(NOW);
      f.db.transaction(() => {
        for (let i = 0; i < chats; i += 1) {
          const handle = handleOf(i);
          const handleId = f.addHandle(handle);
          const chatId = f.addChat({
            identifier: handle,
            handleIds: [handleId],
          });
          f.addMessage({
            chatId,
            handleId,
            text: `synthetic line ${String(i)}`,
            at: new Date(at0 - i * 60_000).toISOString(),
          });
        }
      })();
    },
  });
  running.push(fixture.stop);
  return fixture;
}

async function launch(
  fixture: FixtureDaemon,
  zone: string,
): Promise<LaunchedApp> {
  const app = await launchApp({
    configDir: fixture.configDir,
    port: fixture.port,
    env: { TZ: zone },
  });
  running.push(app.close);
  await app.page.emulateMedia({ colorScheme: 'dark' });
  return app;
}

/** A mark in the request log, and everything the app asked for after it. */
function since(fixture: FixtureDaemon): () => string[] {
  const mark = fixture.requests.requests().length;
  return () =>
    fixture.requests
      .requests()
      .slice(mark)
      .map((r) => `${r.method} ${r.url}`);
}

/** Every request that could change something. */
const writes = (list: readonly string[]): string[] =>
  list.filter((u) => !u.startsWith('GET ') && !u.startsWith('HEAD '));

/** The pages of the list the app asked for. */
const pages = (list: readonly string[]): string[] =>
  list.filter((u) => u.startsWith('GET /v1/threads'));

/** ⇧⌘R, and the list it opens, ready. */
async function openThreads(app: LaunchedApp): Promise<void> {
  await app.page.keyboard.press('Meta+Shift+KeyR');
  await app.page.waitForSelector('html[data-threads="ready"]', {
    timeout: 15_000,
  });
}

interface RowView {
  readonly id: string;
  readonly label: string;
  readonly selected: string;
  readonly setsize: string;
  readonly posinset: string;
  readonly monogram: string;
  readonly mark: string;
  readonly title: string;
  readonly time: string;
  readonly preview: string;
}

interface ThreadsView {
  readonly mode: string | null;
  readonly screen: string | null;
  readonly rows: string | null;
  readonly total: string | null;
  readonly nowIso: string | null;
  readonly heading: string;
  readonly lens: string;
  readonly chip: string;
  readonly rail: string;
  readonly listboxes: number;
  readonly listLabel: string;
  readonly multiselectable: string | null;
  readonly options: RowView[];
  readonly active: string | null;
  readonly activeIsRendered: boolean;
  readonly selected: string[];
  readonly focus: string;
  readonly tabbables: number;
  readonly interactiveInOptions: number;
  readonly nonOptionChildren: number;
  readonly empty: string | null;
  readonly emptyInsideList: boolean;
}

/**
 * One `page.evaluate`, so every field describes the same paint.
 */
function readThreads(app: LaunchedApp): Promise<ThreadsView> {
  return app.page.evaluate(() => {
    const html = document.documentElement;
    const text = (el: Element | null): string =>
      (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const list = document.getElementById('threads-list');
    const options = [
      ...document.querySelectorAll('#threads-list [role="option"]'),
    ];
    const active = list?.getAttribute('aria-activedescendant') ?? null;
    const empty = document.getElementById('threads-empty');
    return {
      mode: html.getAttribute('data-threads'),
      screen: html.getAttribute('data-screen'),
      rows: html.getAttribute('data-threads-rows'),
      total: html.getAttribute('data-threads-total'),
      nowIso: html.getAttribute('data-now-iso'),
      heading: text(document.getElementById('threads-title')),
      lens: text(document.getElementById('threads-lens')),
      chip: text(document.getElementById('threads-chip')),
      rail: text(document.getElementById('threads-rail')),
      listboxes: document.querySelectorAll('[role="listbox"]').length,
      listLabel: list?.getAttribute('aria-label') ?? '',
      multiselectable: list?.getAttribute('aria-multiselectable') ?? null,
      options: options.map((el) => ({
        id: el.id,
        label: el.getAttribute('aria-label') ?? '',
        selected: el.getAttribute('aria-selected') ?? '',
        setsize: el.getAttribute('aria-setsize') ?? '',
        posinset: el.getAttribute('aria-posinset') ?? '',
        monogram: text(el.querySelector('.thread-monogram')),
        mark: text(el.querySelector('.thread-mark')),
        title: text(el.querySelector('.thread-title')),
        time: text(el.querySelector('.thread-time')),
        preview: text(el.querySelector('.thread-preview')),
      })),
      active,
      activeIsRendered:
        active !== null && document.getElementById(active) !== null,
      selected: options
        .filter((el) => el.getAttribute('aria-selected') === 'true')
        .map((el) => el.id),
      focus: document.activeElement?.id ?? '',
      // Natively focusable OR explicitly in the tab order, across the WHOLE
      // window: the claim is one tab stop while the list is up.
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
      empty: empty === null ? null : text(empty),
      emptyInsideList: empty !== null && list !== null && list.contains(empty),
    };
  });
}

interface Probe {
  readonly down: number;
  readonly ready: number;
  readonly alive: boolean;
}

/**
 * The stopwatch, planted in the page before the press.
 *
 * A CAPTURE listener on `window` sees the keydown before the app's own
 * listener does, so the start is the moment the stroke arrived, not the
 * moment the app got round to it. The observer stops the clock on the first
 * mutation after which the list is marked ready AND holds an option, which
 * is the moment an operator could read a row. `alive` is the reload marker:
 * a reloaded page is a new `window` and would not carry it.
 */
async function plantProbe(app: LaunchedApp): Promise<void> {
  await app.page.evaluate(() => {
    const probe = { down: -1, ready: -1, alive: true };
    (window as unknown as { __a1: typeof probe }).__a1 = probe;
    window.addEventListener(
      'keydown',
      (event) => {
        if (
          probe.down < 0 &&
          event.code === 'KeyR' &&
          event.metaKey &&
          event.shiftKey
        )
          probe.down = performance.now();
      },
      { capture: true },
    );
    const observer = new MutationObserver(() => {
      if (probe.down < 0 || probe.ready >= 0) return;
      const ready =
        document.documentElement.getAttribute('data-threads') === 'ready' &&
        document.querySelector('#threads-list [role="option"]') !== null;
      if (ready) {
        probe.ready = performance.now();
        observer.disconnect();
      }
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
    });
  });
}

function readProbe(app: LaunchedApp): Promise<Probe> {
  return app.page.evaluate(() => {
    const probe = (window as unknown as { __a1?: Probe }).__a1;
    return probe === undefined
      ? { down: -1, ready: -1, alive: false }
      : { down: probe.down, ready: probe.ready, alive: probe.alive };
  });
}

describe('v2 A1: the conversations list', () => {
  it('lists 4,000 conversations within 300 ms of ⇧⌘R, newest first, dated by the daemon', async () => {
    const fixture = await boot(CHATS);
    const app = await launch(fixture, HOST_TZ);
    await waitForConnected(app.page);
    // Not a mode the app starts in: the queue is still the front door.
    expect(
      await app.page.evaluate(() =>
        document.documentElement.getAttribute('data-threads'),
      ),
    ).toBeNull();

    await plantProbe(app);
    const asked = since(fixture);
    await app.page.keyboard.press('Meta+Shift+KeyR');
    await app.page.waitForSelector(
      'html[data-threads="ready"] #threads-list [role="option"]',
      { timeout: 15_000 },
    );

    const probe = await readProbe(app);
    expect(
      probe.down,
      'the stroke never reached the page',
    ).toBeGreaterThanOrEqual(0);
    expect(probe.ready).toBeGreaterThan(probe.down);
    const elapsed = probe.ready - probe.down;
    console.log(
      `[v2 A1] ${CHATS.toLocaleString('en-US')} conversations listed in ${elapsed.toFixed(1)} ms (budget ${String(BUDGET_MS)} ms)`,
    );
    expect(elapsed).toBeLessThanOrEqual(BUDGET_MS);
    // The chord did not reload the page.
    expect(probe.alive).toBe(true);

    const view = await readThreads(app);
    // A MODE over the queue screen, not a seventh screen.
    expect(view.screen).toBe('queue');
    expect(view.heading).toBe('All Messages');
    expect(view.lens).toBe('Recent');
    expect(view.rail).toContain('Channels');
    expect(view.rail).toContain('ALL');
    expect(view.rail).toContain('iM');
    // The count is the daemon's total, dated by the daemon's clock, drawn
    // in the host's zone.
    expect(view.chip).toBe('All · 4,000 conversations · as of 16:42');
    expect(view.total).toBe(String(CHATS));
    expect(view.rows).toBe(String(PAGE));
    expect(view.nowIso).toBe(NOW);
    // Newest first, and one row drawn the way board 01 draws it.
    expect(view.options[0]).toEqual({
      id: 'thread-0',
      label: '+15550000000 · iMessage · 16:42 · synthetic line 0',
      selected: 'true',
      setsize: String(CHATS),
      posinset: '1',
      monogram: '#',
      mark: 'iM',
      title: '+15550000000',
      time: '16:42',
      preview: 'synthetic line 0',
    });
    expect(view.options[1]?.label).toBe(
      '+15550000001 · iMessage · 16:41 · synthetic line 1',
    );
    expect(view.options.length).toBeLessThanOrEqual(WINDOW);

    // One page asked for, and nothing written.
    expect(pages(asked())).toHaveLength(1);
    expect(writes(asked())).toEqual([]);

    // ⌘1 leaves the mode and lands on the queue it was laid over, with the
    // keyboard where the queue needs it.
    await app.page.keyboard.press('Meta+Digit1');
    await app.page.waitForSelector(
      'html[data-screen="queue"]:not([data-threads])',
      { timeout: 15_000 },
    );
    const back = await app.page.evaluate(() => ({
      rows: document.documentElement.getAttribute('data-store-rows'),
      total: document.documentElement.getAttribute('data-threads-total'),
      list: document.getElementById('threads-list') !== null,
      focus: document.activeElement?.id ?? '',
    }));
    expect(back).toEqual({
      rows: '0',
      total: null,
      list: false,
      focus: 'queue-list',
    });
    // Looking at 4,000 conversations drafted nothing.
    expect(await fixture.directClient.listDrafts()).toEqual([]);

    // Coming back asks again: the list is a read of now, not a cache.
    await openThreads(app);
    expect(pages(asked())).toHaveLength(2);
    expect(writes(asked())).toEqual([]);
    expect((await readProbe(app)).alive).toBe(true);
  }, 120_000);

  it('is one tab stop, windowed, and pages with the keyboard', async () => {
    const fixture = await boot(CHATS);
    const app = await launch(fixture, HOST_TZ);
    await waitForConnected(app.page);
    await openThreads(app);

    let view = await readThreads(app);
    expect(view.focus).toBe('threads-list');
    expect(view.tabbables).toBe(1);
    expect(view.listboxes).toBe(1);
    expect(view.listLabel).toBe('Conversations');
    // One conversation at a time: this list selects, it does not mark.
    expect(view.multiselectable).toBe('false');
    expect(view.nonOptionChildren).toBe(0);
    expect(view.interactiveInOptions).toBe(0);
    expect(view.active).toBe('thread-0');
    expect(view.selected).toEqual(['thread-0']);

    const press = async (key: string): Promise<ThreadsView> => {
      await app.page.keyboard.press(key);
      return readThreads(app);
    };
    expect((await press('ArrowDown')).active).toBe('thread-1');
    expect((await press('PageDown')).active).toBe('thread-11');
    expect((await press('PageUp')).active).toBe('thread-1');
    expect((await press('Home')).active).toBe('thread-0');
    view = await press('ArrowUp');
    expect(view.active, 'ArrowUp at the top stays at the top').toBe('thread-0');
    expect(view.selected).toEqual(['thread-0']);

    // End reaches the last row HELD, and reaching it asks for the next page.
    const asked = since(fixture);
    await app.page.keyboard.press('End');
    await app.page.waitForSelector(
      `html[data-threads-rows="${String(PAGE * 2)}"]`,
      { timeout: 15_000 },
    );
    view = await readThreads(app);
    expect(view.active).toBe(`thread-${String(PAGE - 1)}`);
    expect(view.activeIsRendered).toBe(true);
    expect(view.options.length).toBeLessThanOrEqual(WINDOW);
    const active = view.options.find((o) => o.id === view.active);
    expect(active?.posinset).toBe(String(PAGE));
    expect(active?.setsize).toBe(String(CHATS));
    expect(active?.label).toBe(
      `${handleOf(PAGE - 1)} · iMessage · 15:03 · synthetic line ${String(PAGE - 1)}`,
    );
    const second = pages(asked());
    expect(second).toHaveLength(1);
    expect(second[0]).toContain('cursor=');

    await app.page.keyboard.press('End');
    await app.page.waitForSelector(
      `html[data-threads-rows="${String(PAGE * 3)}"]`,
      { timeout: 15_000 },
    );
    view = await readThreads(app);
    expect(view.active).toBe(`thread-${String(PAGE * 2 - 1)}`);
    expect(view.activeIsRendered).toBe(true);
    expect(view.options.length).toBeLessThanOrEqual(WINDOW);
    expect(view.total).toBe(String(CHATS));
    expect(pages(asked())).toHaveLength(2);
    // The window followed the cursor: nothing from the first page is still
    // mounted, so this is a slice and not a list that only grows.
    expect(view.options.some((o) => o.id === 'thread-0')).toBe(false);

    // Enter and Escape are not bound yet, and say nothing by doing nothing.
    view = await press('Enter');
    expect(view.mode).toBe('ready');
    expect(view.active).toBe(`thread-${String(PAGE * 2 - 1)}`);
    view = await press('Escape');
    expect(view.mode).toBe('ready');
    expect(view.focus).toBe('threads-list');
    expect(writes(asked())).toEqual([]);
  }, 120_000);

  it('answers an adapter token presented as a bearer with 401, on the composed daemon', async () => {
    const fixture = await boot(3);
    const base = `http://127.0.0.1:${String(fixture.daemon.port)}`;
    const adapter = await fixture.directClient.createAdapter({
      id: 'echo',
      kind: 'echo',
      displayName: 'Echo',
    });
    for (const authorization of [
      `Bearer ${adapter.token}`,
      adapter.token,
      undefined,
    ]) {
      const res = await fetch(`${base}/v1/threads`, {
        headers: authorization === undefined ? {} : { authorization },
      });
      expect(res.status, String(authorization)).toBe(401);
      expect(await res.text()).not.toContain('+1555');
    }
    // Non-vacuous: the operator's own bearer is answered, by this daemon.
    const ok = await fetch(`${base}/v1/threads`, {
      headers: { authorization: `Bearer ${fixture.token}` },
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { total: number; asOf: string };
    expect(body.total).toBe(3);
    expect(body.asOf).toBe(NOW);
  }, 60_000);

  it('says so when there are no conversations, and dates the zero in the host zone', async () => {
    const fixture = await boot(0);
    const app = await launch(fixture, 'UTC');
    await waitForConnected(app.page);
    await openThreads(app);
    await app.page.waitForSelector('#threads-empty', { timeout: 15_000 });

    const view = await readThreads(app);
    expect(view.chip).toBe('All · 0 conversations · as of 23:42');
    expect(view.total).toBe('0');
    expect(view.rows).toBe('0');
    expect(view.empty).toContain('No conversations');
    // Words BESIDE the listbox, never inside it: a listbox's children are
    // options and only options.
    expect(view.emptyInsideList).toBe(false);
    expect(view.listboxes).toBe(1);
    expect(view.options).toEqual([]);
    expect(view.nonOptionChildren).toBe(0);
    // No row, so no reference to one.
    expect(view.active).toBeNull();
    expect(view.focus).toBe('threads-list');
    expect(view.tabbables).toBe(1);
  }, 120_000);
});
