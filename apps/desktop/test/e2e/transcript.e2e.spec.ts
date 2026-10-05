/**
 * v2 A2: one conversation, opened and read, against a real daemon over a
 * synthetic chat.db.
 *
 * Board 01's third column. Return on a row of the conversations list opens
 * that conversation beside it, newest at the bottom, ours on the right, one
 * heading per local day. The focus never leaves the list: its keydown reads
 * the pane the way a pager does, so the window keeps its one tab stop even
 * when a long conversation overflows.
 *
 * What the rows below claim, against the real wire:
 *
 *  - **Nothing invented, nothing missing.** A tapback is not a turn (D-53),
 *    so its row is absent from the DOM. An edit draws its new words and
 *    says it was edited; an unsend, an audio message and an attachment-only
 *    turn each draw a placeholder that says what it is.
 *  - **Ours on the right.** Measured off the laid-out boxes, not off a class.
 *  - **It pages by guid.** PageUp at the top asks for the page before the
 *    oldest turn held with the cursor the daemon handed out, verbatim, and
 *    the turn that was at the top stays where it was on screen.
 *  - **A date is a jump, not a scroll.** ⌘J, eight digits, Return asks with
 *    `until=` and nothing else; the pane says it is not at the head, and End
 *    goes back. A date that is not one is refused in words.
 *  - **A new message refreshes only its own conversation.** One transcript
 *    request for an inbound message in the open conversation, none for an
 *    inbound message anywhere else.
 *  - **It is read-only.** No request in this file writes.
 *
 * No timer, here or in the product. Waiting is `waitForSelector` and
 * `expect.poll`, which are the runner's business.
 *
 * Synthetic handles only (`+1555…`), as everywhere in this PUBLIC repo.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { axTree } from './a11y.js';
import {
  bootFixtureDaemon,
  launchApp,
  waitForConnected,
  type FixtureDaemon,
  type LaunchedApp,
} from './harness.js';

/** Friday 2026-09-04, 16:42 in Los Angeles, 23:42 in UTC. */
const NOW = '2026-09-04T23:42:00.000Z';
const HOST_TZ = 'America/Los_Angeles';
/** The route's default page: the only page size there is. */
const PAGE = 50;
/** Plain text turns, oldest first, one an hour, alternating sides. */
const LINES = 120;

/** A long conversation, and the size the first-page budget is claimed at. */
const BIG = 61_000;
/** The slice's claim, in milliseconds, from Return to the first turn drawn. */
const BUDGET_MS = 150;

const HANDLE_A = '+15550000201';
const HANDLE_B = '+15550000202';
const CHAT_A = `iMessage;-;${HANDLE_A}`;
const CHAT_B = `iMessage;-;${HANDLE_B}`;

/**
 * What an edited turn draws. macOS keeps an edit's new words in
 * `message_summary_info`, not in `text`, and the fixture's `editMessage`
 * writes the committed corpus blob there, whose latest revision is this.
 * The same constant the ingest and daemon suites name (`CORPUS_EDIT_TEXT`).
 */
const CORPUS_EDIT_TEXT = 'GL-FIX-005 edited body (v2)';

const HOUR = 3_600_000;
const at = (msBeforeNow: number): string =>
  new Date(Date.parse(NOW) - msBeforeNow).toISOString();
/** Line `i`'s instant: the oldest 130 hours back, the newest 11. */
const lineAt = (i: number): string => at((130 - i) * HOUR);

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

interface Seeded {
  readonly chatA: number;
  readonly handleA: number;
  readonly chatB: number;
  readonly handleB: number;
}

/**
 * Conversation A: 120 lines, then one of each thing that is not plain text,
 * then a tapback on the edited one, then the newest line. Conversation B:
 * one line, ten days old, so A is the first row of the list.
 */
async function boot(): Promise<{ fixture: FixtureDaemon; ids: Seeded }> {
  let ids: Seeded | null = null;
  const fixture = await bootFixtureDaemon({
    clockAt: NOW,
    seed: (f) => {
      f.db.transaction(() => {
        const handleA = f.addHandle(HANDLE_A);
        const chatA = f.addChat({ identifier: HANDLE_A, handleIds: [handleA] });
        const handleB = f.addHandle(HANDLE_B);
        const chatB = f.addChat({ identifier: HANDLE_B, handleIds: [handleB] });
        for (let i = 0; i < LINES; i += 1) {
          const mine = i % 2 === 0;
          f.addMessage({
            chatId: chatA,
            ...(mine ? {} : { handleId: handleA }),
            guid: `A-${String(i)}`,
            text: `line ${String(i)}`,
            at: lineAt(i),
            isFromMe: mine,
          });
        }
        f.addMessage({
          chatId: chatA,
          handleId: handleA,
          guid: 'A-edited',
          text: 'before the edit',
          at: at(9 * HOUR),
        });
        f.editMessage('A-edited', CORPUS_EDIT_TEXT, { at: at(8.5 * HOUR) });
        f.addMessage({
          chatId: chatA,
          handleId: handleA,
          guid: 'A-unsent',
          text: 'taken back',
          at: at(8 * HOUR),
        });
        f.unsendMessage('A-unsent', { at: at(7.5 * HOUR) });
        f.addAudioMessage({
          chatId: chatA,
          handleId: handleA,
          guid: 'A-audio',
          at: at(7 * HOUR),
        });
        f.addAttachmentOnly({
          chatId: chatA,
          handleId: handleA,
          guid: 'A-attachment',
          at: at(6 * HOUR),
          filename: 'photo.jpg',
          mimeType: 'image/jpeg',
        });
        f.addTapback('A-edited', 2000, {
          chatId: chatA,
          handleId: handleA,
          at: at(5 * HOUR),
        });
        f.addMessage({
          chatId: chatA,
          handleId: handleA,
          guid: 'A-newest',
          text: 'the newest line',
          at: at(60_000),
        });
        f.addMessage({
          chatId: chatB,
          handleId: handleB,
          guid: 'B-0',
          text: 'another conversation',
          at: at(240 * HOUR),
        });
        ids = { chatA, handleA, chatB, handleB };
      })();
    },
  });
  running.push(fixture.stop);
  if (ids === null) throw new Error('the seed did not run');
  return { fixture, ids };
}

async function launch(fixture: FixtureDaemon): Promise<LaunchedApp> {
  const app = await launchApp({
    configDir: fixture.configDir,
    port: fixture.port,
    env: { TZ: HOST_TZ },
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

const writes = (list: readonly string[]): string[] =>
  list.filter((u) => !u.startsWith('GET ') && !u.startsWith('HEAD '));

/** The transcript requests for one conversation, as sent. */
const transcriptAsks = (list: readonly string[], chat: string): string[] =>
  list.filter((u) =>
    u.startsWith(`GET /v1/threads/${encodeURIComponent(chat)}/messages`),
  );

/** One query parameter of a logged request line, decoded. */
function paramOf(line: string, name: string): string | null {
  const url = new URL(line.replace(/^GET /, ''), 'http://x');
  return url.searchParams.get(name);
}

/** ⇧⌘R, the list ready, then Return on the first row: conversation A. */
async function openA(app: LaunchedApp): Promise<void> {
  await app.page.keyboard.press('Meta+Shift+KeyR');
  await app.page.waitForSelector('html[data-threads="ready"]', {
    timeout: 15_000,
  });
  await app.page.keyboard.press('Enter');
  await app.page.waitForSelector('html[data-transcript="ready"]', {
    timeout: 15_000,
  });
}

interface TurnView {
  readonly guid: string;
  readonly from: string;
  readonly placeholder: string;
  readonly who: string;
  readonly body: string;
  readonly marks: string[];
}

interface PaneView {
  readonly status: string | null;
  readonly turnsAttr: string | null;
  readonly head: string | null;
  readonly label: string;
  readonly title: string;
  readonly days: string[];
  readonly turns: TurnView[];
  readonly start: boolean;
  readonly prompt: string;
  readonly note: string;
  readonly says: string;
  readonly statusRegions: number;
  readonly logs: number;
  readonly focus: string;
  readonly overflows: boolean;
}

/** One `page.evaluate`, so every field describes the same paint. */
function readPane(app: LaunchedApp): Promise<PaneView> {
  return app.page.evaluate(() => {
    const html = document.documentElement;
    const text = (el: Element | null): string =>
      (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const pane = document.getElementById('transcript');
    return {
      status: html.getAttribute('data-transcript'),
      turnsAttr: html.getAttribute('data-transcript-turns'),
      head: html.getAttribute('data-transcript-head'),
      label: pane?.getAttribute('aria-label') ?? '',
      title: text(document.getElementById('transcript-title')),
      days: [...document.querySelectorAll('.transcript-day')].map(
        (d) => d.getAttribute('data-date') ?? '',
      ),
      turns: [...document.querySelectorAll('.transcript-turn')].map((li) => ({
        guid: li.getAttribute('data-guid') ?? '',
        from: li.getAttribute('data-from') ?? '',
        placeholder: li.getAttribute('data-placeholder') ?? '',
        who: text(li.querySelector('.transcript-who')),
        body: text(li.querySelector('.transcript-body')),
        marks: [...li.querySelectorAll('.transcript-mark')].map(text),
      })),
      start: document.getElementById('transcript-start') !== null,
      prompt: text(document.getElementById('transcript-prompt')),
      note: text(document.getElementById('transcript-note')),
      says: text(document.getElementById('messenger-status')),
      statusRegions: document.querySelectorAll('[role="status"]').length,
      logs: document.querySelectorAll('[role="log"]').length,
      focus: document.activeElement?.id ?? '',
      overflows: pane !== null && pane.scrollHeight > pane.clientHeight + 1,
    };
  });
}

/**
 * Wait until the status line says `words`. The "loaded" sentence is set
 * when the page's promise settles, a microtask after the store's own paint,
 * so the turn count can be in the document a beat before the words are.
 */
async function saysNow(app: LaunchedApp, words: string): Promise<void> {
  await app.page.waitForFunction(
    (w) =>
      (document.getElementById('messenger-status')?.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim() === w,
    words,
    { timeout: 15_000 },
  );
}

/** The guids of the held turns, oldest first, as `A-<i>` line numbers. */
const lineGuids = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, k) => `A-${String(from + k)}`);

/**
 * A daemon over one conversation of `BIG` turns, a minute apart, ending a
 * minute before NOW, both sides. Seeded before boot, in one transaction.
 */
async function bootBig(): Promise<FixtureDaemon> {
  const fixture = await bootFixtureDaemon({
    clockAt: NOW,
    seed: (f) => {
      f.db.transaction(() => {
        const handleId = f.addHandle(HANDLE_A);
        const chatId = f.addChat({
          identifier: HANDLE_A,
          handleIds: [handleId],
        });
        for (let i = 0; i < BIG; i += 1) {
          const mine = i % 3 === 0;
          f.addMessage({
            chatId,
            ...(mine ? {} : { handleId }),
            guid: `BIG-${String(i)}`,
            text: `long line ${String(i)}`,
            at: at((BIG - i) * 60_000),
            isFromMe: mine,
          });
        }
      })();
    },
  });
  running.push(fixture.stop);
  return fixture;
}

interface Stopwatch {
  readonly down: number;
  readonly ready: number;
}

/**
 * The stopwatch, planted before the press, the same instrument as A1's.
 *
 * A CAPTURE listener on `window` starts it the moment Return arrives, before
 * the app's own listener runs. An observer stops it on the first mutation
 * after which the pane is ready AND holds a turn, which is the moment an
 * operator could read one. Both ends are reads of the renderer's monotonic
 * clock, so the span covers the bridge, main, the client, the socket, the
 * daemon, the SQL, the derive and the paint.
 */
async function plantStopwatch(app: LaunchedApp): Promise<void> {
  await app.page.evaluate(() => {
    const watch = { down: -1, ready: -1 };
    (window as unknown as { __a2: typeof watch }).__a2 = watch;
    window.addEventListener(
      'keydown',
      (event) => {
        if (watch.down < 0 && event.key === 'Enter')
          watch.down = performance.now();
      },
      { capture: true },
    );
    const observer = new MutationObserver(() => {
      if (watch.down < 0 || watch.ready >= 0) return;
      if (
        document.documentElement.getAttribute('data-transcript') === 'ready' &&
        document.querySelector('#transcript .transcript-turn') !== null
      ) {
        watch.ready = performance.now();
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

describe('v2 A2: one conversation', () => {
  it('opens beside the list: ours on the right, placeholders spelled out, no tapback, one tab stop', async () => {
    const { fixture } = await boot();
    const app = await launch(fixture);
    await waitForConnected(app.page);
    const asked = since(fixture);

    await openA(app);
    const view = await readPane(app);

    expect(view.label).toBe(`Conversation with ${HANDLE_A}`);
    expect(view.title).toBe(HANDLE_A);
    expect(view.turnsAttr).toBe(String(PAGE));
    expect(view.head).toBe('yes');
    expect(view.turns).toHaveLength(PAGE);
    // The head page, oldest first, newest last: 45 lines, the four turns
    // that are not plain text, and the newest line. Not the tapback.
    expect(view.turns.map((t) => t.guid)).toEqual([
      ...lineGuids(LINES - 45, LINES - 1),
      'A-edited',
      'A-unsent',
      'A-audio',
      'A-attachment',
      'A-newest',
    ]);
    expect(view.turns.some((t) => !t.guid.startsWith('A-'))).toBe(false);
    // Days ascend and are local to the host's zone.
    expect(view.days).toEqual([...view.days].sort());
    expect(view.days.at(-1)).toBe('2026-09-04');

    const byGuid = new Map(view.turns.map((t) => [t.guid, t]));
    expect(byGuid.get('A-edited')).toMatchObject({
      body: CORPUS_EDIT_TEXT,
      placeholder: 'no',
    });
    expect(byGuid.get('A-edited')?.marks).toContain('Edited');
    expect(byGuid.get('A-unsent')).toMatchObject({
      body: 'This message was unsent.',
      placeholder: 'yes',
    });
    expect(byGuid.get('A-audio')).toMatchObject({
      body: 'Audio message',
      placeholder: 'yes',
    });
    expect(byGuid.get('A-attachment')).toMatchObject({
      body: '1 attachment',
      placeholder: 'yes',
    });
    // Who said it is always in the text: "You" on ours.
    const mineGuid = `A-${String(LINES - 2)}`;
    expect(byGuid.get(mineGuid)).toMatchObject({ from: 'me', who: 'You' });
    expect(byGuid.get('A-newest')).toMatchObject({
      from: 'them',
      who: HANDLE_A,
    });

    // Ours on the right, theirs on the left, off the laid-out boxes.
    const sides = await app.page.evaluate(
      ({ mine, theirs }) => {
        const box = (guid: string): DOMRect | null =>
          document
            .querySelector(`[data-guid="${guid}"]`)
            ?.getBoundingClientRect() ?? null;
        const list = document
          .querySelector(`[data-guid="${mine}"]`)
          ?.closest('ol')
          ?.getBoundingClientRect();
        const m = box(mine);
        const t = box(theirs);
        return list === undefined || m === null || t === null
          ? null
          : {
              mineRightGap: list.right - m.right,
              mineLeftGap: m.left - list.left,
              theirsLeftGap: t.left - list.left,
              theirsRightGap: list.right - t.right,
            };
      },
      { mine: mineGuid, theirs: `A-${String(LINES - 1)}` },
    );
    expect(sides).not.toBeNull();
    expect(Math.abs(sides?.mineRightGap ?? 99)).toBeLessThan(2);
    expect(sides?.mineLeftGap ?? 0).toBeGreaterThan(8);
    expect(Math.abs(sides?.theirsLeftGap ?? 99)).toBeLessThan(2);
    expect(sides?.theirsRightGap ?? 0).toBeGreaterThan(8);

    // One polite region and one log while the conversation is open; the
    // pane is long enough to scroll and is still not a tab stop.
    expect(view.statusRegions).toBe(1);
    expect(view.logs).toBe(1);
    expect(view.says).toBe(`Opened ${HANDLE_A}.`);
    expect(view.overflows).toBe(true);
    expect(view.focus).toBe('threads-list');
    const tree = await axTree(app.app, app.page);
    expect(
      tree
        .filter((n) => !n.ignored && n.properties.focusable === 'true')
        .map((n) => n.role)
        .sort(),
      'an open conversation should add no tab stop',
    ).toEqual(['RootWebArea', 'listbox']);
    await app.page.keyboard.press('Tab');
    expect(
      await app.page.evaluate(
        () => document.activeElement?.closest('#transcript') ?? null,
      ),
    ).toBeNull();
    // And it is the list's: Tab in a window with one tab stop comes back
    // to that stop, never to <body> and never to the pane.
    expect(await app.page.evaluate(() => document.activeElement?.id)).toBe(
      'threads-list',
    );
    // A click on the pane, to scroll it with a pointer, does not take the
    // keyboard away from the list either.
    await app.page.click('#transcript-title');
    expect(await app.page.evaluate(() => document.activeElement?.id)).toBe(
      'threads-list',
    );

    // The bridge carries no page size: an object naming one is refused
    // before anything reaches the daemon.
    const refusals = await app.page.evaluate(async (chat) => {
      const wm = (
        window as unknown as {
          wm: { transcript: (...a: unknown[]) => Promise<unknown> };
        }
      ).wm;
      const out: string[] = [];
      for (const extra of [
        { limit: 5 },
        { before: 'x', limit: 5 },
        { before: 'x', until: 'y' },
      ])
        out.push(
          await wm.transcript(chat, extra).then(
            () => 'resolved',
            (e: unknown) => String(e),
          ),
        );
      return out;
    }, CHAT_A);
    for (const r of refusals) expect(r).toContain('bad-argument:1');

    const asks = transcriptAsks(asked(), CHAT_A);
    expect(asks).toHaveLength(1);
    expect(paramOf(asks[0] ?? '', 'before')).toBeNull();
    expect(paramOf(asks[0] ?? '', 'until')).toBeNull();
    expect(paramOf(asks[0] ?? '', 'limit')).toBeNull();
    expect(writes(asked())).toEqual([]);
  }, 180_000);

  it('pages back by the daemon’s cursor, jumps to a date with until=, and End returns', async () => {
    const { fixture } = await boot();
    const app = await launch(fixture);
    await waitForConnected(app.page);
    const asked = since(fixture);
    // The cursor the daemon hands out for the head page, read directly so
    // the row can say the app forwarded it verbatim.
    const head = await fixture.directClient.readThread(CHAT_A);
    expect(head.nextBefore).not.toBeNull();

    await openA(app);
    await app.page.keyboard.press('Home');
    const oldest = `A-${String(LINES - 45)}`;
    const offsetOf = (guid: string): Promise<number> =>
      app.page.evaluate((g) => {
        const pane = document.getElementById('transcript');
        const el = document.querySelector(`[data-guid="${g}"]`);
        return pane === null || el === null
          ? Number.NaN
          : el.getBoundingClientRect().top - pane.getBoundingClientRect().top;
      }, guid);
    const before = await offsetOf(oldest);

    await app.page.keyboard.press('PageUp');
    await app.page.waitForSelector(
      `html[data-transcript-turns="${String(PAGE * 2)}"]`,
      { timeout: 15_000 },
    );
    await saysNow(app, 'Older messages loaded.');
    let view = await readPane(app);
    expect(view.turns[0]?.guid).toBe(`A-${String(LINES - 95)}`);
    // The turn that was at the top is still where it was.
    expect(Math.abs((await offsetOf(oldest)) - before)).toBeLessThan(2);
    let asks = transcriptAsks(asked(), CHAT_A);
    expect(asks).toHaveLength(2);
    expect(paramOf(asks[1] ?? '', 'before')).toBe(head.nextBefore);
    expect(paramOf(asks[1] ?? '', 'until')).toBeNull();

    // A second PageUp while the third page is in flight is refused in
    // words, from the same stroke handler, in the same task.
    const pair = await app.page.evaluate(() => {
      const list = document.getElementById('threads-list');
      const pane = document.getElementById('transcript');
      if (list === null || pane === null) return null;
      pane.scrollTop = 0;
      const stroke = (): void => {
        list.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'PageUp',
            code: 'PageUp',
            bubbles: true,
          }),
        );
      };
      stroke();
      const first = document.getElementById('messenger-status')?.textContent;
      stroke();
      const second = document.getElementById('messenger-status')?.textContent;
      return { first, second };
    });
    expect(pair).toEqual({
      first: 'Reading older messages.',
      second: 'Still reading older messages.',
    });
    const all = LINES + 5;
    await app.page.waitForSelector(
      `html[data-transcript-turns="${String(all)}"]`,
      { timeout: 15_000 },
    );
    await saysNow(app, 'Older messages loaded. Beginning of conversation.');
    view = await readPane(app);
    expect(view.start).toBe(true);
    expect(view.turns[0]?.guid).toBe('A-0');
    expect(transcriptAsks(asked(), CHAT_A)).toHaveLength(3);

    // Nothing older: refused in words, and nothing is asked.
    await app.page.keyboard.press('Home');
    await app.page.keyboard.press('PageUp');
    await saysNow(app, 'Beginning of conversation.');
    expect(transcriptAsks(asked(), CHAT_A)).toHaveLength(3);

    // A date that is not one, and one that is too short, each say why.
    await app.page.keyboard.press('Meta+KeyJ');
    await app.page.waitForSelector('#transcript-prompt');
    expect((await readPane(app)).says).toBe(
      'Jump to a date. Type the year, month and day.',
    );
    await app.page.keyboard.type('2026');
    await app.page.keyboard.press('Enter');
    expect((await readPane(app)).says).toBe(
      'Type eight digits, year month day.',
    );
    await app.page.keyboard.type('1340');
    await app.page.keyboard.press('Enter');
    view = await readPane(app);
    expect(view.says).toMatch(/ is not a date\.$/);
    expect(view.prompt).not.toBe('');
    await app.page.keyboard.press('Escape');
    view = await readPane(app);
    expect(view.says).toBe('Jump cancelled.');
    expect(view.prompt).toBe('');
    // Escape out of the prompt did not close the conversation.
    expect(view.status).toBe('ready');
    expect(transcriptAsks(asked(), CHAT_A)).toHaveLength(3);

    // ⌘J 2026-09-01: the newest page at or before the end of that day in
    // Los Angeles, asked with until= and nothing else.
    const until = '2026-09-02T06:59:59.999Z';
    await app.page.keyboard.press('Meta+KeyJ');
    await app.page.keyboard.type('20260901');
    await app.page.keyboard.press('Enter');
    await app.page.waitForSelector('html[data-transcript-head="no"]', {
      timeout: 15_000,
    });
    await app.page.waitForSelector('html[data-transcript="ready"]');
    view = await readPane(app);
    asks = transcriptAsks(asked(), CHAT_A);
    expect(asks).toHaveLength(4);
    expect(paramOf(asks[3] ?? '', 'until')).toBe(until);
    expect(paramOf(asks[3] ?? '', 'before')).toBeNull();
    const lastOnOrBefore = Array.from({ length: LINES }, (_, i) => i)
      .filter((i) => lineAt(i) <= until)
      .at(-1);
    expect(view.turns.at(-1)?.guid).toBe(`A-${String(lastOnOrBefore)}`);
    expect(view.days.at(-1)).toBe('2026-09-01');
    expect(view.says).toBe('Jumping to September 1, 2026.');

    // End is the way back to the head.
    await app.page.keyboard.press('End');
    await app.page.waitForSelector('html[data-transcript-head="yes"]', {
      timeout: 15_000,
    });
    await app.page.waitForSelector('html[data-transcript="ready"]');
    view = await readPane(app);
    expect(view.turns.at(-1)?.guid).toBe('A-newest');
    expect(view.says).toBe('Latest messages.');
    asks = transcriptAsks(asked(), CHAT_A);
    expect(asks).toHaveLength(5);
    expect(paramOf(asks[4] ?? '', 'until')).toBeNull();
    expect(paramOf(asks[4] ?? '', 'before')).toBeNull();

    // Escape closes, and the focus is still the list's.
    await app.page.keyboard.press('Escape');
    await app.page.waitForSelector('html:not([data-transcript])');
    view = await readPane(app);
    expect(view.says).toBe(`Closed ${HANDLE_A}.`);
    expect(view.focus).toBe('threads-list');
    expect(writes(asked())).toEqual([]);
  }, 180_000);

  it('a new message refreshes the open conversation and no other', async () => {
    const { fixture, ids } = await boot();
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await openA(app);
    const asked = since(fixture);
    const received = (): number =>
      fixture.broadcasts.filter((b) => b.event === 'message.received').length;

    // Another conversation first. Its frame is broadcast, and reaches the
    // renderer before A's frame below does, because the stream is ordered;
    // the ingest poll is seconds apart, so the two land in separate paints.
    const quiet = received();
    fixture.fixture.addMessage({
      chatId: ids.chatB,
      handleId: ids.handleB,
      guid: 'B-1',
      text: 'somewhere else',
      at: NOW,
    });
    await expect.poll(received, { timeout: 30_000 }).toBeGreaterThan(quiet);

    const heard = received();
    fixture.fixture.addMessage({
      chatId: ids.chatA,
      handleId: ids.handleA,
      guid: 'A-arrived',
      text: 'arrived while open',
      at: NOW,
    });
    await expect.poll(received, { timeout: 30_000 }).toBeGreaterThan(heard);
    await app.page.waitForSelector('[data-guid="A-arrived"]', {
      timeout: 15_000,
    });
    await app.page.waitForSelector('html[data-transcript="ready"]');

    const view = await readPane(app);
    expect(view.turns.at(-1)?.guid).toBe('A-arrived');
    expect(view.turnsAttr).toBe(String(PAGE + 1));
    expect(view.says).toBe('New message.');
    // One refresh of the head, for A's message, and nothing for B's.
    const asks = transcriptAsks(asked(), CHAT_A);
    expect(asks).toHaveLength(1);
    expect(paramOf(asks[0] ?? '', 'before')).toBeNull();
    expect(paramOf(asks[0] ?? '', 'until')).toBeNull();
    expect(transcriptAsks(asked(), CHAT_B)).toEqual([]);
    expect(writes(asked())).toEqual([]);
  }, 180_000);
  it('draws the first page of a 61,000-message conversation within 150 ms of Return', async () => {
    const fixture = await bootBig();
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await app.page.keyboard.press('Meta+Shift+KeyR');
    await app.page.waitForSelector('html[data-threads="ready"]', {
      timeout: 15_000,
    });
    await plantStopwatch(app);
    const asked = since(fixture);

    await app.page.keyboard.press('Enter');
    await app.page.waitForSelector(
      'html[data-transcript="ready"] #transcript .transcript-turn',
      { timeout: 15_000 },
    );
    const watch = await app.page.evaluate(
      () => (window as unknown as { __a2: Stopwatch }).__a2,
    );
    expect(watch.down, 'Return never reached the page').toBeGreaterThanOrEqual(
      0,
    );
    expect(watch.ready).toBeGreaterThan(watch.down);
    const elapsed = watch.ready - watch.down;
    console.log(
      `[v2 A2] first page of ${BIG.toLocaleString('en-US')} turns drawn in ${elapsed.toFixed(1)} ms (budget ${String(BUDGET_MS)} ms)`,
    );
    expect(elapsed).toBeLessThanOrEqual(BUDGET_MS);

    // One page, the newest, and only that: a long history is never read
    // whole to draw its end.
    const view = await readPane(app);
    expect(view.turnsAttr).toBe(String(PAGE));
    expect(view.turns.at(-1)?.guid).toBe(`BIG-${String(BIG - 1)}`);
    expect(view.turns[0]?.guid).toBe(`BIG-${String(BIG - PAGE)}`);
    expect(transcriptAsks(asked(), CHAT_A)).toHaveLength(1);
    expect(writes(asked())).toEqual([]);
  }, 180_000);
});
