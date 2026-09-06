/**
 * s8 Sc11 — the schedule editor, against a real daemon.
 *
 * A schedule decides WHEN the machine may answer for a person, and every
 * bug in this screen is the same bug in a different costume: the editor
 * draws one thing and the gate does another. So the rows below are ordered
 * by how far apart the two could drift.
 *
 *  - **Whose clock.** The windows are in the SCHEDULE's zone. Not the
 *    operator's, not the daemon's. `packages/core/src/schedule` never reads
 *    `process.env.TZ`, and the renderer physically cannot call it — the
 *    desktop app does not depend on `@wemessage/core` and an arch row says
 *    so. That leaves three clocks in one window, and this suite makes all
 *    three visibly distinct: the app runs under a host `TZ` of
 *    `Asia/Kolkata`, the schedule is in `America/Los_Angeles`, and the
 *    daemon's clock is frozen in 2027 while the device's is not.
 *  - **The two days a year the grid is not 7×24.** A window that does not
 *    exist on a spring-forward day, and one that happens twice on a
 *    fall-back day. The dates are lifted from `packages/core/test/dst-
 *    window.spec.ts` so the editor and the gate are proved against the same
 *    instants: an editor that renders a window the gate will never open, or
 *    hides one it will open twice, is lying.
 *  - **Denies bind everyone; clamps bind only autonomy** (§2.4.1, F-64).
 *    `outside-window` is a CLAMP. It is the first branch of §1.7's else-if
 *    chain and it lives inside `dispatchApproved`'s `isAutoApproval` block,
 *    so a shut window stops the machine and cannot veto a person. Row 10
 *    proves that at the wire, from this GUI, because it is the single most
 *    likely thing to get wrong here: an editor that greyed out APPROVE
 *    while the window was shut would have quietly rebuilt the clamp as a
 *    deny.
 *  - **Editing a schedule is not an approval** (INV-2). Row 11 rewrites the
 *    configuration underneath a draft that already exists and proves the
 *    draft did not move.
 *
 * Everything on screen came from the daemon: real schedules through real
 * routes, real arming, and a real 400 whose wording is compared against the
 * SAME daemon's answer rather than against a string typed in this file.
 *
 * Synthetic handles only (`+1555…`), as everywhere in this PUBLIC repo.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DaemonRequestError, type SchedulePayload } from '@wemessage/client';
import {
  bootFixtureDaemon,
  launchApp,
  waitForConnected,
  type FixtureDaemon,
  type LaunchedApp,
} from './harness.js';
import { runtimeGreenOffenders } from './no-green-runtime.js';

const HANDLE = '+15550001111';
const CHAT = `iMessage;-;${HANDLE}`;

/** The schedule's zone. Pinned by `test/arch.spec.ts` row (f). */
const ZONE = 'America/Los_Angeles';
/**
 * The zone the ELECTRON PROCESS runs in — deliberately not the schedule's,
 * and deliberately a fixed +05:30 offset with no DST of its own. If the
 * renderer ever projected into the host zone by accident, every block on
 * the grid would be twelve and a half hours out and no assertion below
 * would survive it.
 */
const HOST_TZ = 'Asia/Kolkata';

/**
 * What THIS build's ICU calls that zone, which is not necessarily what we
 * called it.
 *
 * The tz database carries its renames as LINKS, and `Intl` resolves every
 * link to one canonical spelling — on the runtime this suite is pinned to,
 * `Asia/Kolkata` comes back as the older name. So the MENU (which is
 * `Intl.supportedValuesOf`) and the BANNER (which reads
 * `resolvedOptions().timeZone`) both speak the canonical spelling, while the
 * schedule below is stored under the modern one.
 *
 * Derived rather than written down, for two reasons: a literal would be a
 * sixth IANA zone in a tree that pins five, and a literal would be a claim
 * about which ICU this suite runs on that would rot the next time the
 * database moved a link. The pair is the whole point of the last two
 * assertions in this row: two spellings of one zone are one zone, and the
 * editor must not raise "these windows are not in your zone" over them.
 */
const HOST_CANON = new Intl.DateTimeFormat('en-US', {
  timeZone: HOST_TZ,
}).resolvedOptions().timeZone;

/**
 * The daemon's frozen instant: Thursday 2027-03-11, 00:00 in the schedule's
 * zone. Outside a 09:00–17:00 window, which is what makes arming read as a
 * hold rather than as an accident of when the suite ran.
 */
const T_SHUT = '2027-03-11T08:00:00.000Z';
/** Wednesday 2027-03-10, 12:00 in the schedule's zone: inside the window. */
const T_OPEN = '2027-03-10T20:00:00.000Z';

/** The spring-forward Sunday in `ZONE`: 02:00 becomes 03:00. */
const SPRING = '2027-03-14';
/** The fall-back Sunday in `ZONE`: 02:00 becomes 01:00. */
const FALL = '2027-11-07';

const BUSINESS = {
  days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  start: '09:00',
  end: '17:00',
} as const;

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

async function boot(
  clockAt: string,
  before?: (f: FixtureDaemon) => Promise<void>,
): Promise<FixtureDaemon> {
  const fixture = await bootFixtureDaemon({
    clockAt,
    seed: (f) => {
      const handle = f.addHandle(HANDLE);
      f.addChat({ identifier: HANDLE, handleIds: [handle] });
    },
  });
  running.push(fixture.stop);
  // Every rule needs an adapter row; `rules.adapter_id` is a real column.
  await fixture.directClient.createAdapter({
    id: 'agent-one',
    kind: 'generic',
    displayName: 'agent one',
  });
  await before?.(fixture);
  return fixture;
}

async function launch(fixture: FixtureDaemon): Promise<LaunchedApp> {
  const app = await launchApp({
    configDir: fixture.configDir,
    port: fixture.port,
    // The host zone, handed to the Electron process. Every `Intl` read in
    // the renderer resolves against this, which is exactly why the grid may
    // not be drawn from one.
    env: { TZ: HOST_TZ },
  });
  running.push(app.close);
  await app.page.emulateMedia({ colorScheme: 'dark' });
  return app;
}

const urls = (fixture: FixtureDaemon): string[] =>
  fixture.requests.requests().map((r) => `${r.method} ${r.url}`);

/** A mark in the request log, and everything the app asked for after it. */
function since(fixture: FixtureDaemon): () => string[] {
  const mark = fixture.requests.requests().length;
  return () =>
    fixture.requests
      .requests()
      .slice(mark)
      .map((r) => `${r.method} ${r.url}`);
}

/** Every request that could change something, whoever made it. */
const writes = (list: readonly string[]): string[] =>
  list.filter((u) => !u.startsWith('GET ') && !u.startsWith('HEAD '));

async function toSchedule(app: LaunchedApp): Promise<void> {
  await app.page.keyboard.press('Meta+Digit3');
  await app.page.waitForSelector('html[data-screen="schedule"]', {
    timeout: 15_000,
  });
  await app.page.waitForSelector('#schedule[data-schedule="ready"]', {
    timeout: 30_000,
  });
}

async function selectSchedule(app: LaunchedApp, id: string): Promise<void> {
  await app.page.click(`#sched-opt-${id}`);
  await app.page.waitForSelector(`#sched-detail[data-schedule-id="${id}"]`, {
    timeout: 15_000,
  });
}

/** Put the grid on the local week containing `date` (`YYYY-MM-DD`). */
async function toWeek(app: LaunchedApp, date: string): Promise<void> {
  await app.page.fill('#sched-week', date);
  await app.page.waitForSelector(`.sched-col[data-date="${date}"]`, {
    timeout: 15_000,
  });
}

interface BlockView {
  readonly day: string;
  readonly date: string;
  readonly window: string;
  readonly from: string;
  readonly to: string;
  readonly wraps: string;
  readonly tail: string;
  readonly note: string;
  readonly title: string;
  readonly join: string;
}

interface GridView {
  readonly zone: string;
  readonly days: string[];
  readonly dates: string[];
  readonly blocks: BlockView[];
  readonly gaps: string[];
  readonly folds: string[];
  readonly now: {
    iso: string;
    zone: string;
    minutes: string;
    day: string;
    source: string;
  } | null;
}

async function readGrid(app: LaunchedApp): Promise<GridView> {
  return app.page.evaluate(() => {
    const attr = (el: Element | null, name: string): string =>
      el?.getAttribute(name) ?? '';
    const cols = Array.from(document.querySelectorAll('.sched-col'));
    const nowEl = document.querySelector('#now-line');
    return {
      zone: attr(document.querySelector('#sched-grid'), 'data-zone'),
      days: cols.map((c) => attr(c, 'data-day')),
      dates: cols.map((c) => attr(c, 'data-date')),
      blocks: Array.from(document.querySelectorAll('.sched-block')).map(
        (b) => ({
          day: attr(b.closest('.sched-col'), 'data-day'),
          date: attr(b.closest('.sched-col'), 'data-date'),
          window: attr(b, 'data-window'),
          from: attr(b, 'data-from'),
          to: attr(b, 'data-to'),
          wraps: attr(b, 'data-wraps'),
          tail: attr(b, 'data-tail'),
          note: attr(b, 'data-note'),
          title: attr(b, 'title'),
          join: (b.querySelector('.sched-join')?.textContent ?? '').trim(),
        }),
      ),
      gaps: Array.from(document.querySelectorAll('.sched-gap')).map(
        (g) =>
          `${attr(g.closest('.sched-col'), 'data-date')} ${attr(
            g,
            'data-from',
          )}-${attr(g, 'data-to')}`,
      ),
      folds: Array.from(document.querySelectorAll('.sched-fold')).map(
        (g) =>
          `${attr(g.closest('.sched-col'), 'data-date')} ${attr(
            g,
            'data-from',
          )}-${attr(g, 'data-to')}`,
      ),
      now:
        nowEl === null
          ? null
          : {
              iso: attr(nowEl, 'data-now-iso'),
              zone: attr(nowEl, 'data-now-zone'),
              minutes: attr(nowEl, 'data-now-minutes'),
              day: attr(nowEl, 'data-now-day'),
              source: attr(nowEl, 'data-now-source'),
            },
    };
  });
}

interface DetailView {
  readonly scheduleId: string;
  readonly name: string;
  readonly zone: string;
  readonly zoneOptions: number;
  readonly hasZone: boolean;
  readonly hasHostZone: boolean;
  readonly mismatch: string | null;
  readonly mismatchHost: string;
  readonly windows: string[];
  readonly dirty: string;
  readonly saveDisabled: boolean;
  readonly armed: string;
  readonly footnote: string;
  readonly inflight: string;
  readonly refuse: string;
  readonly issues: Record<string, string>;
  readonly inUse: string;
  readonly tabbables: number;
  readonly links: number;
}

async function readDetail(app: LaunchedApp): Promise<DetailView> {
  return app.page.evaluate(
    ([zone, host]) => {
      const text = (sel: string): string =>
        (document.querySelector(sel)?.textContent ?? '')
          .replace(/\s+/g, ' ')
          .trim();
      const select = document.querySelector('#sched-zone');
      const options =
        select instanceof HTMLSelectElement
          ? Array.from(select.options).map((o) => o.value)
          : [];
      const issues: Record<string, string> = {};
      for (const el of Array.from(document.querySelectorAll('[data-issue]')))
        issues[el.getAttribute('data-issue') ?? ''] = (
          el.textContent ?? ''
        ).trim();
      const save = document.querySelector('#sched-save');
      const banner = document.querySelector('#sched-zone-mismatch');
      return {
        scheduleId:
          document
            .querySelector('#sched-detail')
            ?.getAttribute('data-schedule-id') ?? '',
        name:
          document.querySelector('#sched-name') instanceof HTMLInputElement
            ? (document.querySelector('#sched-name') as HTMLInputElement).value
            : '',
        zone: select instanceof HTMLSelectElement ? select.value : '',
        zoneOptions: options.length,
        hasZone: options.includes(zone),
        hasHostZone: options.includes(host),
        mismatch: banner === null ? null : (banner.textContent ?? '').trim(),
        mismatchHost: banner?.getAttribute('data-host-zone') ?? '',
        windows: Array.from(
          document.querySelectorAll('#sched-windows > li'),
        ).map((li) => (li.textContent ?? '').replace(/\s+/g, ' ').trim()),
        dirty:
          document.querySelector('#sched-detail')?.getAttribute('data-dirty') ??
          '',
        saveDisabled: save instanceof HTMLButtonElement ? save.disabled : true,
        armed: text('#sched-armed'),
        footnote: text('#sched-footnote'),
        inflight: text('#sched-inflight'),
        refuse: text('#sched-refuse'),
        issues,
        inUse: text('#sched-inuse'),
        tabbables: document.querySelectorAll(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ).length,
        links: document.querySelectorAll('a[href]').length,
      };
    },
    [ZONE, HOST_CANON] as const,
  );
}

/**
 * A drag inside one day's column, in local minutes.
 *
 * The geometry is read from the element rather than assumed: the column's
 * height is the whole local day, so a minute is `height / 1440` and the
 * assertion is about what the SCREEN did with the pointer, not about a
 * constant this file and the stylesheet would both have to hold.
 */
async function dragIn(
  app: LaunchedApp,
  day: string,
  fromMinutes: number,
  toMinutes: number,
): Promise<void> {
  const col = app.page.locator(`.sched-col[data-day="${day}"]`);
  await col.scrollIntoViewIfNeeded();
  const box = await col.boundingBox();
  if (box === null) throw new Error(`no box for ${day}`);
  const at = (m: number): number => box.y + (m / 1440) * box.height;
  const x = box.x + box.width / 2;
  await app.page.mouse.move(x, at(fromMinutes));
  await app.page.mouse.down();
  await app.page.mouse.move(x, at(toMinutes), { steps: 10 });
  await app.page.mouse.up();
}

/** The `windows` array of the last PATCH the app sent, from the daemon. */
async function storedWindows(
  fixture: FixtureDaemon,
  id: string,
): Promise<SchedulePayload['windows']> {
  return (await fixture.directClient.getSchedule(id)).windows;
}

/* ── row 1: the grid, the selector, and whose clock this is ───────────── */

describe('s8 Sc11 row 1: the week, drawn in the schedule’s own zone', () => {
  it('renders windows in the schedule’s zone and says so when it is not yours', async () => {
    let here = '';
    let there = '';
    const fixture = await boot(T_SHUT, async (f) => {
      here = (
        await f.directClient.createSchedule({
          name: 'front desk',
          timezone: ZONE,
          windows: [{ ...BUSINESS, days: [...BUSINESS.days] }],
        })
      ).id;
      there = (
        await f.directClient.createSchedule({
          name: 'night desk',
          timezone: HOST_TZ,
          windows: [{ days: ['sat', 'sun'], start: '22:00', end: '23:00' }],
        })
      ).id;
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toSchedule(app);
    await selectSchedule(app, here);

    const grid = await readGrid(app);
    expect(grid.zone).toBe(ZONE);
    expect(grid.days).toEqual([
      'mon',
      'tue',
      'wed',
      'thu',
      'fri',
      'sat',
      'sun',
    ]);
    // Five blocks, one per named day, each nine hours long, and none on the
    // weekend. `data-from`/`data-to` are LOCAL MINUTES, so this is the
    // projection stated as a number rather than inferred from a pixel.
    expect(grid.blocks.map((b) => `${b.day} ${b.from}-${b.to}`)).toEqual([
      'mon 540-1020',
      'tue 540-1020',
      'wed 540-1020',
      'thu 540-1020',
      'fri 540-1020',
    ]);
    expect(grid.blocks.every((b) => b.wraps === 'no')).toBe(true);

    const detail = await readDetail(app);
    expect(detail.zone).toBe(ZONE);
    // The menu is `Intl.supportedValuesOf('timeZone')`, asked at paint. A
    // tz database with no maintainer is not a thing this repo ships, and an
    // arch row proves the tree names no zone at all.
    expect(detail.zoneOptions).toBeGreaterThan(200);
    expect(detail.hasZone).toBe(true);
    expect(detail.hasHostZone).toBe(true);
    // The banner: three facts, none of them a colour.
    expect(detail.mismatchHost).toBe(HOST_CANON);
    expect(detail.mismatch).toContain(ZONE);
    expect(detail.mismatch).toContain(HOST_CANON);
    // Nothing in this app is a link (arch row: no `<a href` renderer-wide).
    expect(detail.links).toBe(0);

    // …and a schedule that IS in the operator's zone says nothing at all.
    await selectSchedule(app, there);
    const same = await readDetail(app);
    expect(same.zone).toBe(HOST_TZ);
    expect(same.mismatch).toBeNull();
  }, 180_000);
});

/* ── row 2: a gesture is an edit; SAVE is the only thing that writes ──── */

describe('s8 Sc11 row 2: drag to draw, and one PATCH for the lot', () => {
  it('creates, resizes and moves a window, and refuses a drag that says nothing', async () => {
    let id = '';
    const fixture = await boot(T_SHUT, async (f) => {
      id = (
        await f.directClient.createSchedule({
          name: 'front desk',
          timezone: ZONE,
          windows: [{ ...BUSINESS, days: [...BUSINESS.days] }],
        })
      ).id;
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toSchedule(app);
    await selectSchedule(app, id);

    // ── a drag on empty grid draws a window, snapped to the quarter hour ─
    const mark = since(fixture);
    await dragIn(app, 'sat', 600, 720);
    await app.page.waitForSelector('#sched-detail[data-dirty="yes"]', {
      timeout: 15_000,
    });
    const drawn = await readGrid(app);
    expect(
      drawn.blocks
        .filter((b) => b.day === 'sat')
        .map((b) => `${b.from}-${b.to}`),
    ).toEqual(['600-720']);
    // Nothing has been asked of the daemon. A drag is an edit, exactly as a
    // keystroke in the name field is; the SAVE is the decision.
    expect(writes(mark())).toEqual([]);

    // ── an edge drag resizes it ─────────────────────────────────────────
    await dragIn(app, 'sat', 720, 810);
    const resized = await readGrid(app);
    expect(
      resized.blocks
        .filter((b) => b.day === 'sat')
        .map((b) => `${b.from}-${b.to}`),
    ).toEqual(['600-810']);

    // ── a drag that ends where it started says nothing, and is refused ──
    await dragIn(app, 'sun', 300, 300);
    const nothing = await readGrid(app);
    expect(nothing.blocks.filter((b) => b.day === 'sun')).toEqual([]);

    // ── SAVE: one PATCH, carrying the WHOLE array ───────────────────────
    const before = since(fixture);
    await app.page.click('#sched-save');
    await app.page.waitForSelector('#sched-detail[data-dirty="no"]', {
      timeout: 15_000,
    });
    expect(writes(before())).toEqual([`PATCH /v1/schedules/${id}`]);
    // The daemon owns validation, so the body is the whole `windows` array
    // and not a diff of rectangles: a partial array would DELETE the days it
    // failed to mention.
    expect(await storedWindows(fixture, id)).toEqual([
      { days: [...BUSINESS.days], start: '09:00', end: '17:00' },
      { days: ['sat'], start: '10:00', end: '13:30' },
    ]);
  }, 240_000);
});

/* ── row 3: the union the daemon will not compute ─────────────────────── */

describe('s8 Sc11 row 3: two windows that overlap are one window', () => {
  it('sends the merged array and produces exactly one audit row', async () => {
    let id = '';
    const fixture = await boot(T_SHUT, async (f) => {
      id = (
        await f.directClient.createSchedule({
          name: 'front desk',
          timezone: ZONE,
          windows: [{ days: ['mon'], start: '09:00', end: '12:00' }],
        })
      ).id;
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toSchedule(app);
    await selectSchedule(app, id);

    // Drawn UPWARD from empty grid at 17:00 into the existing 09:00–12:00
    // block: the gesture starts where there is nothing, so it is a create
    // rather than a move, and it ends inside a window that is already there.
    await dragIn(app, 'mon', 1020, 660);
    await app.page.waitForSelector('#sched-detail[data-dirty="yes"]', {
      timeout: 15_000,
    });
    // On screen it is already ONE rectangle, before anything is saved. An
    // editor that drew two bars stacked on each other would be drawing the
    // storage rather than the behaviour.
    const merged = await readGrid(app);
    expect(
      merged.blocks
        .filter((b) => b.day === 'mon')
        .map((b) => `${b.from}-${b.to}`),
    ).toEqual(['540-1020']);
    expect((await readDetail(app)).windows).toEqual(['MON 09:00–17:00']);

    const mark = since(fixture);
    await app.page.click('#sched-save');
    await app.page.waitForSelector('#sched-detail[data-dirty="no"]', {
      timeout: 15_000,
    });
    expect(writes(mark())).toEqual([`PATCH /v1/schedules/${id}`]);
    // The daemon's `canonicalWindows` dedupes and week-orders `days` and
    // merges NOTHING, so this is a promise the GUI keeps or nobody does.
    expect(await storedWindows(fixture, id)).toEqual([
      { days: ['mon'], start: '09:00', end: '17:00' },
    ]);
    // §1.8: one write, one audit row.
    const rows = await fixture.directClient.listAudit({
      event: 'schedule.updated',
      limit: 100,
    });
    expect(rows).toHaveLength(1);
  }, 240_000);
});

/* ── row 4: three clocks, and the one the marker reads ────────────────── */

describe('s8 Sc11 row 4: the NOW marker is a reading, not a countdown', () => {
  it('projects the DEVICE instant into the schedule’s zone, and no timer moves it', async () => {
    let id = '';
    const fixture = await boot(T_SHUT, async (f) => {
      id = (
        await f.directClient.createSchedule({
          name: 'front desk',
          timezone: ZONE,
          windows: [{ ...BUSINESS, days: [...BUSINESS.days] }],
        })
      ).id;
      // An enabled rule pointing at the schedule, because `scheduleHold`
      // reports a daemon with no enabled rules as ARMED and unbounded: a
      // hold nobody asked for on a fresh install would be a hold nobody
      // could find. The hold below is real, and it is this window's.
      await f.directClient.createRule({
        name: 'rent inquiry',
        matcher: { kind: 'keyword', keywords: ['rent'], mode: 'any' },
        adapterId: 'agent-one',
        scheduleId: id,
      });
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toSchedule(app);
    await selectSchedule(app, id);

    const first = await readGrid(app);
    expect(first.now).not.toBeNull();
    const now = first.now as NonNullable<GridView['now']>;
    expect(now.source).toBe('device');
    expect(now.zone).toBe(ZONE);

    // The marker publishes the instant it read, so the projection can be
    // checked EXACTLY rather than within a tolerance. This is the whole
    // reason `data-now-iso` exists.
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: ZONE,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(now.iso));
    const read = (type: string): string =>
      parts.find((p) => p.type === type)?.value ?? '';
    const expected = (Number(read('hour')) % 24) * 60 + Number(read('minute'));
    expect(Number(now.minutes)).toBe(expected);
    expect(now.day).toBe(read('weekday').toLowerCase());

    // …and it is NOT the host's projection. Kolkata is +05:30 against a zone
    // that is -08:00 or -07:00, so the two disagree by a number of minutes
    // that is never a multiple of a day.
    const host = new Intl.DateTimeFormat('en-US', {
      timeZone: HOST_TZ,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(now.iso));
    const hostMinutes =
      (Number(host.find((p) => p.type === 'hour')?.value ?? '0') % 24) * 60 +
      Number(host.find((p) => p.type === 'minute')?.value ?? '0');
    expect(Number(now.minutes)).not.toBe(hostMinutes);

    // …and it is NOT the daemon's either: the daemon is frozen in 2027 and
    // the device is not.
    expect(now.iso.slice(0, 4)).not.toBe(T_SHUT.slice(0, 4));

    // The daemon's clock moves an hour. The marker does not, because there
    // is no timer and nothing subscribes a clock to a push (F-117).
    fixture.clock.set(new Date(Date.parse(T_SHUT) + 3_600_000).toISOString());
    await fixture.daemon.tick();
    await app.page.click('#sched-name');
    const later = await readGrid(app);
    expect(later.now?.iso).toBe(now.iso);

    // An explicit affordance re-reads it. Sc10's precedent: an operator
    // asks, rather than a loop guessing how often they want to know.
    await app.page.click('#sched-now');
    await expect
      .poll(async () => (await readGrid(app)).now?.iso, { timeout: 15_000 })
      .not.toBe(now.iso);

    // The daemon's own word about arming is on the same screen and is
    // clearly the OTHER clock's: it is a hold, at an instant the device is
    // nowhere near.
    expect((await readDetail(app)).armed).toBe('DISARMED · QUEUE-ONLY');
  }, 240_000);
});

/* ── row 5: the hour that does not exist, and the hour that happens twice */

describe('s8 Sc11 row 5: the two days a year the grid is not 7×24', () => {
  it('hatches the spring gap, doubles the fall fold, and changes neither window', async () => {
    let id = '';
    const fixture = await boot(T_SHUT, async (f) => {
      id = (
        await f.directClient.createSchedule({
          name: 'front desk',
          timezone: ZONE,
          windows: [
            { days: ['sun'], start: '02:30', end: '04:00' },
            { days: ['sat'], start: '02:15', end: '02:45' },
          ],
        })
      ).id;
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toSchedule(app);
    await selectSchedule(app, id);
    await toWeek(app, SPRING);

    const spring = await readGrid(app);
    // The phantom hour is drawn as a hole in the day, on the day it happens.
    expect(spring.gaps).toEqual([`${SPRING} 120-180`]);
    expect(spring.folds).toEqual([]);
    const straddles = spring.blocks.find((b) => b.date === SPRING);
    expect(straddles?.note).toBe('gap-shortened');
    // F-57's semantics, SHOWN and not re-decided: `packages/core` arms this
    // window from the gap's end, and the editor says the same sentence.
    expect(straddles?.title).toBe(
      `02:30 DOES NOT OCCUR ON ${SPRING} · ARMS FROM 03:00`,
    );

    // A window that lives ENTIRELY inside the gap arms for zero minutes.
    // Saturday is the day before, so it is drawn plainly there — the note
    // is a property of the DAY, not of the window.
    const saturday = spring.blocks.find((b) => b.day === 'sat');
    expect(saturday?.note).toBe('none');

    // Move the Saturday window onto the Sunday and it becomes the honest,
    // alarming case: a window the gate will never open.
    await dragIn(app, 'sun', 900, 1000);
    await app.page.waitForSelector('#sched-detail[data-dirty="yes"]', {
      timeout: 15_000,
    });
    await app.page.click('#sched-revert');
    await app.page.waitForSelector('#sched-detail[data-dirty="no"]', {
      timeout: 15_000,
    });

    // The FALL week: the same window, twice.
    await toWeek(app, FALL);
    const fall = await readGrid(app);
    expect(fall.folds).toEqual([`${FALL} 60-120`]);
    expect(fall.gaps).toEqual([]);

    // Neither rendering touched the stored window. The editor PROJECTS; the
    // daemon decides, and it decides from `02:30` exactly as written.
    // Creation order, kept: `canonicalWindows` week-orders `days` INSIDE a
    // window and never reorders the array itself.
    expect(await storedWindows(fixture, id)).toEqual([
      { days: ['sun'], start: '02:30', end: '04:00' },
      { days: ['sat'], start: '02:15', end: '02:45' },
    ]);
    expect(writes(urls(fixture))).toEqual([]);
  }, 240_000);

  it('says NEVER OPENS about a window that lives entirely inside the gap', async () => {
    let id = '';
    const fixture = await boot(T_SHUT, async (f) => {
      id = (
        await f.directClient.createSchedule({
          name: 'front desk',
          timezone: ZONE,
          windows: [{ days: ['sun'], start: '02:15', end: '02:45' }],
        })
      ).id;
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toSchedule(app);
    await selectSchedule(app, id);
    await toWeek(app, SPRING);

    const grid = await readGrid(app);
    const block = grid.blocks.find((b) => b.date === SPRING);
    expect(block?.note).toBe('gap-never');
    expect(block?.title).toBe(
      `NEVER OPENS ON ${SPRING} · CLOCKS SKIP 02:00 TO 03:00`,
    );
    // The word, not only the hatching. §3.10: colour is never the sole
    // carrier of state, and a pattern is a colour with extra steps.
    const detail = await readDetail(app);
    expect(detail.windows.join(' ')).toContain('NEVER OPENS');
  }, 240_000);

  it('says RUNS TWICE about a window the gate will open twice', async () => {
    let id = '';
    const fixture = await boot(T_SHUT, async (f) => {
      id = (
        await f.directClient.createSchedule({
          name: 'front desk',
          timezone: ZONE,
          windows: [{ days: ['sun'], start: '01:00', end: '02:00' }],
        })
      ).id;
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toSchedule(app);
    await selectSchedule(app, id);
    await toWeek(app, FALL);

    const grid = await readGrid(app);
    const block = grid.blocks.find((b) => b.date === FALL);
    expect(block?.note).toBe('fold-twice');
    expect(block?.title).toBe(
      `RUNS TWICE ON ${FALL} · CLOCKS REPEAT 01:00 TO 02:00`,
    );
    expect((await readDetail(app)).windows.join(' ')).toContain('RUNS TWICE');
  }, 240_000);
});

/* ── row 6: one window, drawn across a midnight ───────────────────────── */

describe('s8 Sc11 row 6: a window that crosses midnight is still one window', () => {
  it('joins the two rectangles with a glyph and stores one entry', async () => {
    let id = '';
    const fixture = await boot(T_SHUT, async (f) => {
      id = (
        await f.directClient.createSchedule({
          name: 'night desk',
          timezone: ZONE,
          windows: [{ days: ['fri'], start: '22:00', end: '02:00' }],
        })
      ).id;
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toSchedule(app);
    await selectSchedule(app, id);

    const grid = await readGrid(app);
    // Two rectangles, ONE window: the same `data-window`, and the second
    // marked as the tail so a click on either selects the whole thing.
    expect(
      grid.blocks.map((b) => `${b.day} ${b.from}-${b.to} ${b.tail}`),
    ).toEqual(['fri 1320-1440 no', 'sat 0-120 yes']);
    expect(new Set(grid.blocks.map((b) => b.window)).size).toBe(1);
    expect(grid.blocks.map((b) => b.join)).toEqual(['∞', '∞']);
    expect(grid.blocks.every((b) => b.wraps === 'yes')).toBe(true);

    // One entry in the editor's own list, and one in the daemon's.
    expect((await readDetail(app)).windows).toEqual(['FRI 22:00–02:00']);
    expect(await storedWindows(fixture, id)).toEqual([
      { days: ['fri'], start: '22:00', end: '02:00' },
    ]);
  }, 180_000);
});

/* ── row 7: a schedule that arms nothing, and what the rules do then ──── */

describe('s8 Sc11 row 7: disarmed, and the footnote that says what it costs', () => {
  it('reads DISARMED · QUEUE-ONLY and counts what each rule does outside', async () => {
    let id = '';
    const fixture = await boot(T_SHUT, async (f) => {
      id = (
        await f.directClient.createSchedule({
          name: 'front desk',
          timezone: ZONE,
          windows: [{ ...BUSINESS, days: [...BUSINESS.days] }],
        })
      ).id;
      // Three rules on this schedule: two still draft outside the window,
      // one ignores. Every one of them ASKS FOR AUTO, which is what makes
      // arming derivable at all — the daemon holds because something wanted
      // to send and the window is shut, not because a schedule exists.
      //
      // F-69 in its real shape, proved at the wire below: `queue` is NOT a
      // third thing a stored rule can be. The published enum keeps all three
      // literals so §3.2 and the client mirror stay honest about the design,
      // and the RUNNING daemon declines the middle one with a typed 400. So
      // the footnote's arithmetic is two-valued by construction rather than
      // by a GUI decision to fold one bucket into another.
      for (const [name, outside] of [
        ['rent inquiry', 'draft-only'],
        ['late arrival', 'draft-only'],
        ['spam', 'ignore'],
      ] as const)
        await f.directClient.createRule({
          name,
          matcher: {
            kind: 'keyword',
            keywords: [name.split(' ')[0] ?? ''],
            mode: 'any',
          },
          adapterId: 'agent-one',
          scheduleId: id,
          respondMode: 'auto',
          outsideWindow: outside,
        });
    });

    // F-69 at the wire, before the GUI is even open: the mode the plan
    // expected this screen to render cannot reach the store.
    await expect(
      fixture.directClient.createRule({
        name: 'queue please',
        matcher: { kind: 'keyword', keywords: ['queue'], mode: 'any' },
        adapterId: 'agent-one',
        scheduleId: id,
        outsideWindow: 'queue',
      }),
    ).rejects.toThrow(/unsupported-outside-window/);
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toSchedule(app);
    await selectSchedule(app, id);

    const detail = await readDetail(app);
    // The DAEMON's arming, rendered by the same helper the empty queue uses.
    expect(detail.armed).toBe('DISARMED · QUEUE-ONLY');
    expect(detail.footnote).toBe('3 RULES · 2 STILL DRAFT · 1 IGNORES');
    // …and the daemon really is saying it, at this instant.
    const status = await fixture.directClient.status();
    expect(status.armed?.armed).toBe(false);
  }, 180_000);
});

/* ── row 8: the daemon owns the refusal ───────────────────────────────── */

describe('s8 Sc11 row 8: a delete the daemon refuses, in the daemon’s words', () => {
  it('asks anyway, and renders the 409 rather than pre-checking it', async () => {
    let id = '';
    const fixture = await boot(T_SHUT, async (f) => {
      id = (
        await f.directClient.createSchedule({
          name: 'front desk',
          timezone: ZONE,
          windows: [{ ...BUSINESS, days: [...BUSINESS.days] }],
        })
      ).id;
      for (const name of ['rent inquiry', 'late arrival'])
        await f.directClient.createRule({
          name,
          matcher: { kind: 'keyword', keywords: ['rent'], mode: 'any' },
          adapterId: 'agent-one',
          scheduleId: id,
        });
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toSchedule(app);
    await selectSchedule(app, id);

    const mark = since(fixture);
    await app.page.click('#sched-delete');
    await app.page.waitForSelector('#typed-confirm', { timeout: 15_000 });
    await app.page.click('#typed-confirm-input');
    await app.page.keyboard.type('DELETE SCHEDULE');
    await app.page.click('#typed-confirm-go');
    await app.page.waitForSelector('#sched-inuse', { timeout: 15_000 });

    // The request WAS made. The GUI holds the rules catalogue and could have
    // guessed; guessing is how a GUI ends up refusing something the daemon
    // would have allowed.
    expect(writes(mark())).toContain(`DELETE /v1/schedules/${id}`);
    const detail = await readDetail(app);
    expect(detail.inUse).toContain('IN USE BY 2 RULES');
    // The count is the DAEMON's `detail.rules`; the names come from the
    // catalogue this screen already holds, because "which two" is the
    // question an operator actually has.
    expect(detail.inUse).toContain('RENT INQUIRY');
    expect(detail.inUse).toContain('LATE ARRIVAL');
    expect(detail.links).toBe(0);
    // …and nothing was deleted.
    expect(
      (await fixture.directClient.listSchedules()).map((s) => s.id),
    ).toEqual([id]);
  }, 180_000);

  it('shows a 400 in the validator’s own words, letter for letter', async () => {
    let id = '';
    const fixture = await boot(T_SHUT, async (f) => {
      id = (
        await f.directClient.createSchedule({
          name: 'front desk',
          timezone: ZONE,
          windows: [{ days: ['mon'], start: '09:00', end: '17:00' }],
        })
      ).id;
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toSchedule(app);
    await selectSchedule(app, id);

    // Remove the last window and save. The local problem list deliberately
    // does NOT know that a schedule needs one, so this reaches the daemon —
    // which is the point: the path from a real zod issue to a real field
    // label is exercised by a real 400 rather than by a fixture.
    await app.page.click('#sched-window-0-remove');
    await app.page.click('#sched-save');
    await app.page.waitForSelector('#sched-refuse[data-refused]', {
      timeout: 15_000,
    });

    // What the daemon says, asked directly, at the same moment.
    // `DaemonRequestError` keeps the raw body for exactly this reason.
    let body = '';
    await fixture.directClient.updateSchedule(id, { windows: [] }).then(
      () => {
        throw new Error('the daemon accepted a schedule with no windows');
      },
      (error: unknown) => {
        if (!(error instanceof DaemonRequestError)) throw error;
        expect(error.statusCode).toBe(400);
        body = error.body;
      },
    );
    const parsed = JSON.parse(body) as {
      error: string;
      detail?: { issues?: { path: unknown[]; message: string }[] };
    };
    expect(parsed.error).toBe('invalid-schedule');
    const issues = (parsed.detail?.issues ?? []).map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    }));
    expect(issues.map((i) => i.path)).toEqual(['windows']);

    const detail = await readDetail(app);
    expect(detail.refuse).toContain('INVALID-SCHEDULE');
    // Letter for letter. A second validation vocabulary in the renderer
    // would drift from this one the first time the daemon bumped zod.
    expect(detail.issues['windows']).toBe(issues[0]?.message);
  }, 180_000);
});

/* ── row 9: nothing green, on every surface this screen has ───────────── */

describe('s8 Sc11 row 9: no green, and the hatch is the tint', () => {
  it('finds no green anywhere on the schedule screen, in either scheme', async () => {
    let id = '';
    const fixture = await boot(T_SHUT, async (f) => {
      id = (
        await f.directClient.createSchedule({
          name: 'front desk',
          timezone: ZONE,
          windows: [
            { days: ['sun'], start: '02:30', end: '04:00' },
            { days: ['fri'], start: '22:00', end: '02:00' },
          ],
        })
      ).id;
      await f.directClient.createRule({
        name: 'rent inquiry',
        matcher: { kind: 'keyword', keywords: ['rent'], mode: 'any' },
        adapterId: 'agent-one',
        scheduleId: id,
      });
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toSchedule(app);

    const sweep = async (): Promise<void> => {
      for (const scheme of ['dark', 'light'] as const) {
        await app.page.emulateMedia({ colorScheme: scheme });
        expect(await runtimeGreenOffenders(app.page)).toEqual([]);
      }
      await app.page.emulateMedia({ colorScheme: 'dark' });
    };

    await sweep();
    await selectSchedule(app, id);
    await sweep();
    await toWeek(app, SPRING);
    await sweep();
    await app.page.click('#sched-delete');
    await app.page.waitForSelector('#typed-confirm', { timeout: 15_000 });
    await sweep();

    // The hatch is `--tint` at low alpha, which is the one blue this app
    // has. Read from the computed style so a token renamed to something
    // green would be caught by the sweep above rather than by a snapshot.
    //
    // The leading zero is OPTIONAL in the pattern and the alpha is then
    // checked as a NUMBER. A custom property's value survives to the browser
    // as authored text, and the production bundler rewrites `0.14` to `.14`
    // on the way through: a regex that insisted on the zero would be a test
    // of which minifier ran, and it would pass in dev and fail in the build
    // that ships. What this row actually claims — one blue, at a fraction of
    // full opacity — is stated as arithmetic instead.
    const hatch = await app.page.evaluate(() =>
      window
        .getComputedStyle(document.documentElement)
        .getPropertyValue('--tint-soft')
        .trim(),
    );
    const alpha = /^rgba\(10, ?132, ?255, ?(0?\.\d+)\)$/.exec(hatch);
    expect(alpha, hatch).not.toBeNull();
    expect(Number(alpha?.[1])).toBeGreaterThan(0);
    expect(Number(alpha?.[1])).toBeLessThan(0.5);
  }, 300_000);
});

/* ── row 10: a shut window stops the machine and not the person ───────── */

describe('s8 Sc11 row 10: outside-window clamps autonomy, never a human', () => {
  it('lets an operator approve and send while the schedule is shut', async () => {
    let id = '';
    const fixture = await boot(T_SHUT, async (f) => {
      id = (
        await f.directClient.createSchedule({
          name: 'front desk',
          timezone: ZONE,
          windows: [{ ...BUSINESS, days: [...BUSINESS.days] }],
        })
      ).id;
      // An enabled rule pointing at the schedule is what makes the daemon
      // report the hold at all: arming is derived from what the rules ask
      // for, not from the presence of a schedule row.
      await f.directClient.createRule({
        name: 'rent inquiry',
        matcher: { kind: 'keyword', keywords: ['rent'], mode: 'any' },
        adapterId: 'agent-one',
        scheduleId: id,
        respondMode: 'auto',
      });
      await f.directClient.setContactPolicy(HANDLE, 'auto');
    });

    // The daemon's own verdict first: this is a HOLD, and it is the window.
    const status = await fixture.directClient.status();
    expect(status.armed?.armed).toBe(false);

    const draft = await fixture.directClient.createDraft({
      chatGuid: CHAT,
      body: 'the front desk will call you back',
      ttlMinutes: 480,
    });

    const app = await launch(fixture);
    await waitForConnected(app.page);
    await app.page.waitForSelector('html[data-store-rows="1"]', {
      timeout: 30_000,
    });
    await toSchedule(app);
    await selectSchedule(app, id);
    expect((await readDetail(app)).armed).toBe('DISARMED · QUEUE-ONLY');

    // Back to the queue, and approve. The window is shut; the person is not.
    await app.page.keyboard.press('Meta+Digit1');
    await app.page.waitForSelector('html[data-screen="queue"]', {
      timeout: 15_000,
    });
    await app.page.focus('#queue-list');
    await app.page.keyboard.press('a');
    await expect
      .poll(
        async () => (await fixture.directClient.getDraft(draft.id)).draft.state,
        { timeout: 30_000 },
      )
      .toBe('approved');

    // …and it really sends. The clamp lives inside `dispatchApproved`'s
    // `isAutoApproval` block, so a human approval never reaches it.
    fixture.clock.set(new Date(Date.parse(T_SHUT) + 3_600_000).toISOString());
    await fixture.daemon.tick();
    await expect
      .poll(() => fixture.loopback.callCount(), { timeout: 60_000 })
      .toBe(1);
    expect(fixture.loopback.calls()[0]?.body).toBe(
      'the front desk will call you back',
    );
    // The gate was consulted and did not deny: had `outside-window` been a
    // deny rather than a clamp, this draft would be `failed`.
    expect((await fixture.directClient.getDraft(draft.id)).draft.state).toBe(
      'sent',
    );
  }, 240_000);

  it('and inside the window the same approval is the same approval', async () => {
    let id = '';
    const fixture = await boot(T_OPEN, async (f) => {
      id = (
        await f.directClient.createSchedule({
          name: 'front desk',
          timezone: ZONE,
          windows: [{ ...BUSINESS, days: [...BUSINESS.days] }],
        })
      ).id;
      await f.directClient.createRule({
        name: 'rent inquiry',
        matcher: { kind: 'keyword', keywords: ['rent'], mode: 'any' },
        adapterId: 'agent-one',
        scheduleId: id,
      });
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toSchedule(app);
    await selectSchedule(app, id);
    // The SAME screen, the same schedule, a daemon clock four hours earlier:
    // the only thing that changed is the instant, and the word changed with
    // it. That is what makes the row above an observation rather than a
    // screen that always says the same thing.
    expect((await readDetail(app)).armed).toMatch(/^ARMED/);
  }, 180_000);
});

/* ── row 11: a schedule edit is not a send path (INV-2) ───────────────── */

describe('s8 Sc11 row 11: rewriting the schedule under a draft moves nothing', () => {
  it('opens the window and leaves the queued draft exactly where it was', async () => {
    let id = '';
    const fixture = await boot(T_SHUT, async (f) => {
      id = (
        await f.directClient.createSchedule({
          name: 'front desk',
          timezone: ZONE,
          windows: [{ ...BUSINESS, days: [...BUSINESS.days] }],
        })
      ).id;
      await f.directClient.createRule({
        name: 'rent inquiry',
        matcher: { kind: 'keyword', keywords: ['rent'], mode: 'any' },
        adapterId: 'agent-one',
        scheduleId: id,
        respondMode: 'auto',
      });
    });
    // A draft minted under the OLD configuration, stamped from the daemon's
    // own clock so `byAge` orders it where the queue expects.
    const at = new Date(fixture.clock.nowMs() - 60_000).toISOString();
    fixture.daemon.store.insertDraft({
      id: '01HQ0000000000000000000SCH',
      inboundGuid: null,
      chatGuid: CHAT,
      ruleId: null,
      adapterId: 'agent-one',
      idempotencyKey: 'sc11-inflight-1',
      body: 'queued while the window was shut',
      originalBody: 'queued while the window was shut',
      state: 'pending',
      stateChangedAt: at as never,
      expiresAt: new Date(
        fixture.clock.nowMs() + 3_600_000,
      ).toISOString() as never,
      createdAt: at as never,
    } as never);

    const app = await launch(fixture);
    await waitForConnected(app.page);
    await app.page.waitForSelector('html[data-store-rows="1"]', {
      timeout: 30_000,
    });
    await toSchedule(app);
    await selectSchedule(app, id);

    // The screen SAYS it before anything is changed. An editor that let an
    // operator believe a save re-decides work already queued is an editor
    // that will eventually be right about that.
    expect((await readDetail(app)).inflight).toMatch(
      /SAVING (CHANGES )?NOTHING ALREADY|NOT RE-?DECIDED/i,
    );

    const mark = since(fixture);
    // Open the window wide: every day, all day.
    // The whole of Thursday. Five minutes in from either end of the column,
    // because both edges snap to the same quarter hour and a pointer on the
    // literal boundary is a pointer on whatever is drawn next to it.
    await dragIn(app, 'thu', 5, 1435);
    await app.page.waitForSelector('#sched-detail[data-dirty="yes"]', {
      timeout: 15_000,
    });
    await app.page.click('#sched-save');
    await app.page.waitForSelector('#sched-detail[data-dirty="no"]', {
      timeout: 15_000,
    });

    // One PATCH. No approval, no dispatch, no send. Opening a window changes
    // what AUTONOMY may do NEXT; it says nothing about work a human has
    // already been asked to decide.
    const asked = mark();
    expect(writes(asked)).toEqual([`PATCH /v1/schedules/${id}`]);
    expect(asked.join('\n')).not.toMatch(/approve|dispatch/i);
    expect(fixture.loopback.calls()).toEqual([]);
    const draft = await fixture.directClient.getDraft(
      '01HQ0000000000000000000SCH',
    );
    expect(draft.draft.state).toBe('pending');
    expect(urls(fixture).filter((u) => /approve/.test(u))).toEqual([]);

    // …and still nothing after a tick, which is the moment a dispatcher
    // that had been handed an approval would act.
    await fixture.daemon.tick();
    expect(fixture.loopback.callCount()).toBe(0);
    expect(
      (await fixture.directClient.getDraft('01HQ0000000000000000000SCH')).draft
        .state,
    ).toBe('pending');
  }, 240_000);
});
