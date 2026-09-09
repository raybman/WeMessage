/**
 * s8 Sc10 — the rules editor, against a real daemon.
 *
 * A rule is what lets an agent draft. That makes this screen a SAFETY
 * surface rather than a CRUD form, and the rows below are ordered by how
 * much damage the corresponding bug would do:
 *
 *  - **A rule cannot widen permission.** §2.4.3's ladder is narrowing-only.
 *    A detail pane that renders `respondMode: auto` as "AUTO" while the
 *    global mode is `draft-only` is telling the operator the machine will
 *    answer for them when it will not — or, on the day the global flips,
 *    that it always would have. The screen renders the LADDER.
 *  - **Nothing drafts by default.** With no `ContactPolicy` row the gate
 *    denies outright, so a valid, enabled, matching rule drafts for nobody.
 *    S7 Sc13 found this by having four adapters produce nothing. The screen
 *    says so, with the count behind it.
 *  - **Editing a rule approves nothing.** `maybeAutoApprove` has one call
 *    site and it is the inbound submit path; a PATCH over a rule cannot
 *    reach it. Row 9 proves that on the wire: a draft minted under the old
 *    rule is still pending after the rule is changed, and the tee saw one
 *    PATCH and no approval.
 *  - **The dangerous combo asks.** AUTO with a matcher that is not a
 *    contact list is an auto-reply to everybody it matches, and §1.7 makes
 *    that a typed confirmation. Row 5 is this scenario's named teeth.
 *
 * Everything on screen came from the daemon: real rules through real
 * routes, a real replay of real chat.db rows, and a real 400 from the
 * daemon's own validator. Nothing is injected into the renderer.
 *
 * Synthetic handles only (`+1555…`), as everywhere in this PUBLIC repo.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { RuleInput } from '@wemessage/client';
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
const OTHER = '+15550002222';
const OTHER_CHAT = `iMessage;-;${OTHER}`;

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
  ids: { chat: number; handle: number; otherChat: number; otherHandle: number };
}

/**
 * A daemon whose clock starts where the wall clock is.
 *
 * `N today` is counted against the RENDERER's idea of local midnight, and
 * the harness's default instant is months in the past: every audit row the
 * daemon stamped would fall on a day that is not today, and the column
 * would read zero for reasons that have nothing to do with the arithmetic.
 * Time is still driven by hand from here on (C-11).
 */
async function boot(before?: (f: Seeded) => Promise<void>): Promise<Seeded> {
  const ids = { chat: 0, handle: 0, otherChat: 0, otherHandle: 0 };
  const fixture = await bootFixtureDaemon({
    clockAt: new Date().toISOString(),
    seed: (f) => {
      ids.handle = f.addHandle(HANDLE);
      ids.chat = f.addChat({ identifier: HANDLE, handleIds: [ids.handle] });
      ids.otherHandle = f.addHandle(OTHER);
      ids.otherChat = f.addChat({
        identifier: OTHER,
        handleIds: [ids.otherHandle],
      });
    },
  });
  running.push(fixture.stop);
  const seeded: Seeded = { ...fixture, ids };
  // Every rule needs an adapter row: `rules.adapter_id` is a real column and
  // the ADAPTER select is populated from `GET /v1/adapters`, so a fixture
  // with no adapters would test an empty menu.
  await seeded.directClient.createAdapter({
    id: 'agent-one',
    kind: 'generic',
    displayName: 'agent one',
  });
  await seeded.directClient.createAdapter({
    id: 'agent-two',
    kind: 'generic',
    displayName: 'agent two',
  });
  await before?.(seeded);
  return seeded;
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

/** A mark in the request log, and everything the app asked for after it. */
function since(fixture: Seeded): () => string[] {
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

/** `⌘2` — the rules screen. Navigation is a key; see the arch row. */
/**
 * Wait until the DAEMON has ingested at least `atLeast` inbound messages.
 *
 * The replay route reads `store.listRecentInboundMessages`, which is the
 * daemon's own mirror of chat.db, filled by the watch trigger's 3s poll
 * fallback (the fixture's watcher never fires). A test that clicked DRY RUN
 * before that poll had run would ask for a replay of an empty table, get a
 * perfectly correct `0 / 0 MATCHED`, and be waiting for a number that a
 * one-shot request can never produce.
 *
 * Asked through `directClient`, which bypasses the tee, so the readiness
 * poll cannot appear in the request log the row is about to assert on. And
 * it is the daemon's OWN count, exactly as this row's comment promised —
 * not a sleep, and not a longer timeout.
 */
async function waitForIngest(
  fixture: Seeded,
  ruleId: string,
  atLeast: number,
): Promise<void> {
  await expect
    .poll(
      async () => (await fixture.directClient.dryRunRule(ruleId, 50)).total,
      {
        timeout: 60_000,
        interval: 250,
      },
    )
    .toBeGreaterThanOrEqual(atLeast);
}

async function toRules(app: LaunchedApp): Promise<void> {
  await app.page.keyboard.press('Meta+Digit2');
  await app.page.waitForSelector('html[data-screen="rules"]', {
    timeout: 15_000,
  });
  await app.page.waitForSelector('#rules[data-rules="ready"]', {
    timeout: 30_000,
  });
}

async function waitForRuleRows(app: LaunchedApp, n: number): Promise<void> {
  await app.page.waitForSelector(`html[data-rules-rows="${String(n)}"]`, {
    timeout: 30_000,
  });
}

interface ListRow {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly enabled: string;
  readonly today: string;
  readonly dim: boolean;
}

async function readList(app: LaunchedApp): Promise<{
  rows: ListRow[];
  note: string | null;
  listboxes: number;
  options: number;
  optionControls: number;
}> {
  return app.page.evaluate(() => {
    const text = (el: Element | null): string =>
      (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const options = Array.from(
      document.querySelectorAll('#rules-list > li[role="option"]'),
    );
    return {
      rows: options.map((li) => ({
        id: li.getAttribute('data-rule-id') ?? '',
        name: text(li.querySelector('.rule-name')),
        state: text(li.querySelector('.rule-state')),
        enabled: li.getAttribute('data-enabled') ?? '',
        today: text(li.querySelector('.rule-today')),
        // Dimming is a computed opacity, not a class name: the claim is
        // that a disabled row LOOKS different, and a class could be styled
        // to nothing.
        dim: Number.parseFloat(window.getComputedStyle(li).opacity) < 1,
      })),
      note: text(document.querySelector('#rules-order-note')) || null,
      listboxes: document.querySelectorAll('[role="listbox"]').length,
      options: options.length,
      optionControls: options.filter(
        (li) =>
          li.querySelector(
            'a[href], button, input, select, textarea, [tabindex]',
          ) !== null,
      ).length,
    };
  });
}

interface DetailView {
  readonly ruleId: string;
  readonly name: string;
  readonly kind: string;
  readonly kinds: { kind: string; state: string; disabled: boolean }[];
  readonly keywords: string[];
  readonly mode: string;
  readonly caseFlag: string;
  readonly wordFlag: string;
  readonly pattern: string;
  readonly patternVerdict: string;
  readonly patternVerdictState: string;
  readonly serverTest: string;
  readonly handles: string[];
  readonly adapter: string;
  readonly adapters: string[];
  readonly respond: string;
  readonly outside: string[];
  readonly outsideNote: string;
  readonly schedule: string;
  readonly schedules: string[];
  readonly group: string;
  readonly ttl: string;
  readonly dirty: string;
  readonly saveDisabled: boolean;
  readonly issues: Record<string, string>;
  readonly rungs: { rung: string; value: string }[];
  readonly effective: string;
  readonly narrowedBy: string;
  readonly deny: string;
  readonly inflight: string;
  readonly themeNote: string;
}

async function readDetail(app: LaunchedApp): Promise<DetailView> {
  return app.page.evaluate(() => {
    const text = (sel: string): string =>
      (document.querySelector(sel)?.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim();
    const attr = (sel: string, name: string): string =>
      document.querySelector(sel)?.getAttribute(name) ?? '';
    const value = (sel: string): string => {
      const el = document.querySelector(sel);
      return el instanceof HTMLInputElement || el instanceof HTMLSelectElement
        ? el.value
        : '';
    };
    const issues: Record<string, string> = {};
    for (const el of Array.from(document.querySelectorAll('[data-issue]')))
      issues[el.getAttribute('data-issue') ?? ''] = (
        el.textContent ?? ''
      ).trim();
    const segment = (name: string): string =>
      Array.from(document.querySelectorAll(`[${name}]`))
        .filter((el) => el.getAttribute('data-state') === 'ON')
        .map((el) => el.getAttribute(name) ?? '')
        .join(',');
    const save = document.querySelector('#rule-save');
    return {
      ruleId: attr('#rule-detail', 'data-rule-id'),
      name: value('#rule-name'),
      kind: segment('data-kind'),
      kinds: Array.from(document.querySelectorAll('[data-kind]')).map((el) => ({
        kind: el.getAttribute('data-kind') ?? '',
        state: el.getAttribute('data-state') ?? '',
        disabled: el.hasAttribute('disabled'),
      })),
      keywords: Array.from(document.querySelectorAll('[data-keyword]')).map(
        (el) => el.getAttribute('data-keyword') ?? '',
      ),
      mode: segment('data-kwmode'),
      caseFlag: attr('[data-flag="case"]', 'data-state'),
      wordFlag: attr('[data-flag="word"]', 'data-state'),
      pattern: value('#rule-pattern'),
      patternVerdict: text('#rule-pattern-verdict'),
      patternVerdictState: attr('#rule-pattern-verdict', 'data-state'),
      serverTest: text('#rule-pattern-server'),
      handles: Array.from(document.querySelectorAll('[data-handle-pill]')).map(
        (el) => el.getAttribute('data-handle-pill') ?? '',
      ),
      adapter: value('#rule-adapter'),
      adapters: Array.from(
        document.querySelectorAll('#rule-adapter > option'),
      ).map((el) => (el as HTMLOptionElement).value),
      respond: segment('data-respond'),
      outside: Array.from(document.querySelectorAll('[data-outside]')).map(
        (el) => el.getAttribute('data-outside') ?? '',
      ),
      outsideNote: text('#rule-outside-note'),
      schedule: value('#rule-schedule'),
      schedules: Array.from(
        document.querySelectorAll('#rule-schedule > option'),
      ).map((el) => (el as HTMLOptionElement).value),
      group: attr('[data-flag="group"]', 'data-state'),
      ttl: value('#rule-ttl'),
      dirty: attr('#rule-detail', 'data-dirty'),
      saveDisabled: save instanceof HTMLButtonElement ? save.disabled : true,
      issues,
      rungs: Array.from(document.querySelectorAll('[data-rung]')).map((el) => ({
        rung: el.getAttribute('data-rung') ?? '',
        value: el.getAttribute('data-value') ?? '',
      })),
      effective: attr('#rule-effective', 'data-value'),
      narrowedBy: attr('#rule-effective', 'data-narrowed'),
      deny: text('#rule-deny'),
      inflight: text('#rule-inflight'),
      themeNote: text('#rule-theme-note'),
    };
  });
}

interface DryRunView {
  readonly present: boolean;
  readonly total: string;
  readonly matched: string;
  readonly count: string;
  readonly empty: string;
  readonly note: string;
  readonly rows: {
    guid: string;
    matched: string;
    verdict: string;
    shadowed: string;
    hits: string[];
    preview: string;
  }[];
}

async function readDryRun(app: LaunchedApp): Promise<DryRunView> {
  return app.page.evaluate(() => {
    const root = document.querySelector('#dryrun');
    const text = (el: Element | null): string =>
      (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    return {
      present: root !== null,
      total: root?.getAttribute('data-total') ?? '',
      matched: root?.getAttribute('data-matched') ?? '',
      count: text(document.querySelector('#dryrun-count')),
      empty: text(document.querySelector('#dryrun-empty')),
      note: text(document.querySelector('#dryrun-note')),
      rows: Array.from(document.querySelectorAll('.dryrun-row')).map((row) => ({
        guid: row.getAttribute('data-guid') ?? '',
        matched: row.getAttribute('data-matched') ?? '',
        verdict: text(row.querySelector('.dryrun-verdict')),
        shadowed: row.getAttribute('data-shadowed') ?? '',
        hits: Array.from(row.querySelectorAll('[data-hit="yes"]')).map((el) =>
          text(el),
        ),
        preview: text(row.querySelector('.dryrun-preview')),
      })),
    };
  });
}

async function readConfirm(app: LaunchedApp): Promise<{
  present: boolean;
  role: string;
  modal: string;
  phrase: string;
  title: string;
  goDisabled: boolean;
  alerts: number;
}> {
  return app.page.evaluate(() => {
    const el = document.querySelector('#typed-confirm');
    const go = document.querySelector('#typed-confirm-go');
    return {
      present: el !== null,
      role: el?.getAttribute('role') ?? '',
      modal: el?.getAttribute('aria-modal') ?? '',
      phrase: el?.getAttribute('data-phrase') ?? '',
      title: (document.querySelector('#typed-confirm-title')?.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim(),
      goDisabled: go instanceof HTMLButtonElement ? go.disabled : true,
      alerts: document.querySelectorAll('[role="alert"], [role="alertdialog"]')
        .length,
    };
  });
}

/** Retype a field the way an operator does: select all, then type. */
async function retype(
  app: LaunchedApp,
  selector: string,
  value: string,
): Promise<void> {
  await app.page.click(selector);
  // `ControlOrMeta` is the operator's select-all on whichever platform this
  // runs on. `Meta+a` is that chord on macOS only: on Linux it is a modifier
  // nothing binds, so nothing was selected and the new value was APPENDED to
  // the old one. Four rows failed on the Linux lane for a reason that had
  // nothing to do with rules.
  await app.page.keyboard.press('ControlOrMeta+a');
  await app.page.keyboard.type(value);
}

async function selectRule(app: LaunchedApp, id: string): Promise<void> {
  await app.page.click(`#rule-opt-${id}`);
  await app.page.waitForSelector(`#rule-detail[data-rule-id="${id}"]`, {
    timeout: 15_000,
  });
}

/** Three rules with room between them, in the order they will be listed. */
async function seedThree(f: Seeded): Promise<string[]> {
  const made: string[] = [];
  const rules: RuleInput[] = [
    {
      name: 'urgent',
      matcher: { kind: 'keyword', keywords: ['urgent'], mode: 'any' },
      adapterId: 'agent-one',
      priority: 10,
    },
    {
      name: 'rent inquiry',
      matcher: { kind: 'keyword', keywords: ['rent'], mode: 'any' },
      adapterId: 'agent-one',
      priority: 20,
      draftTtlMinutes: 30,
    },
    {
      name: 'after hours',
      matcher: { kind: 'keyword', keywords: ['closed'], mode: 'any' },
      adapterId: 'agent-two',
      priority: 30,
      enabled: false,
    },
  ];
  for (const input of rules)
    made.push((await f.directClient.createRule(input)).rule.id);
  made.push(
    (
      await f.directClient.createRule({
        name: 'catch all',
        matcher: { kind: 'regex', pattern: '.' },
        adapterId: 'agent-one',
        priority: 40,
      })
    ).rule.id,
  );
  return made;
}

/* ── row 1: the list is the priority order, and it is draggable ───────── */

describe('s8 Sc10 row 1: first match wins, and the operator decides which is first', () => {
  it('lists in priority order, reorders with three writes and no fourth', async () => {
    let ids: string[] = [];
    const fixture = await boot(async (f) => {
      ids = await seedThree(f);
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toRules(app);
    await waitForRuleRows(app, 4);

    const before = await readList(app);
    expect(before.rows.map((r) => r.name)).toEqual([
      'URGENT',
      'RENT INQUIRY',
      'AFTER HOURS',
      'CATCH ALL',
    ]);
    // A disabled rule is dimmed AND says OFF AND carries the attribute:
    // §3.10's "colour is never the sole carrier", applied to opacity.
    expect(before.rows[2]?.enabled).toBe('no');
    expect(before.rows[2]?.state).toContain('OFF');
    expect(before.rows[2]?.dim).toBe(true);
    expect(before.rows[0]?.dim).toBe(false);
    expect(before.note).toContain('FIRST MATCH WINS');
    // Sc6's listbox contract still holds on a second screen: one list, and
    // no option contains a control.
    expect(before.listboxes).toBe(1);
    expect(before.optionControls).toBe(0);

    // Drag the third row above the first. Three rules move; the fourth does
    // not, and the request log is what proves the difference.
    const mark = since(fixture);
    await app.page
      .locator(`#rule-opt-${ids[2] ?? ''} .rule-grip`)
      .dragTo(app.page.locator(`#rule-opt-${ids[0] ?? ''}`));
    await app.page.waitForSelector(
      `#rules-list > li:first-child[data-rule-id="${ids[2] ?? ''}"]`,
      { timeout: 15_000 },
    );

    const after = await readList(app);
    expect(after.rows.map((r) => r.name)).toEqual([
      'AFTER HOURS',
      'URGENT',
      'RENT INQUIRY',
      'CATCH ALL',
    ]);
    const asked = mark();
    expect(writes(asked).sort()).toEqual(
      [
        `PATCH /v1/rules/${ids[0] ?? ''}`,
        `PATCH /v1/rules/${ids[1] ?? ''}`,
        `PATCH /v1/rules/${ids[2] ?? ''}`,
      ].sort(),
    );
    // The rule that did not move was not written. "One request per rule
    // whose priority changed" is a claim about the ones that did NOT.
    expect(asked.join('\n')).not.toContain(`PATCH /v1/rules/${ids[3] ?? ''}`);

    // And the DAEMON agrees, which is the half a re-render cannot fake.
    const stored = await fixture.directClient.listRules();
    expect(stored.map((r) => r.name)).toEqual([
      'after hours',
      'urgent',
      'rent inquiry',
      'catch all',
    ]);
  }, 180_000);

  it('counts today`s matches from the audit log, excluding yesterday at 23:59', async () => {
    let ids: string[] = [];
    const fixture = await boot(async (f) => {
      ids = await seedThree(f);
    });
    // `rule.matched` rows, appended through the store's own hash-chained
    // writer. The dispatch path would produce these; manufacturing the
    // inbound traffic to earn six of them would test the ingest poll, not
    // the column. Only the AUDIT is seeded; the rules are the daemon's.
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const stamps: [string, string][] = [
      // Yesterday, one minute before local midnight. The row that makes
      // "today" mean today rather than "the last twenty-four hours".
      [ids[0] ?? '', new Date(midnight.getTime() - 60_000).toISOString()],
      [ids[0] ?? '', new Date(midnight.getTime() + 60_000).toISOString()],
      [ids[0] ?? '', new Date().toISOString()],
      [ids[1] ?? '', new Date().toISOString()],
    ];
    for (const [ruleId, at] of stamps)
      fixture.daemon.store.appendAudit({
        at: at as never,
        eventJson: JSON.stringify({
          type: 'rule.matched',
          guid: `guid-${at}`,
          ruleId,
          adapterId: 'agent-one',
          ruleName: 'seeded',
        }),
        actorJson: JSON.stringify({ kind: 'system', reason: 'auto-respond' }),
      });

    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toRules(app);
    await waitForRuleRows(app, 4);

    const list = await readList(app);
    expect(list.rows[0]?.today).toBe('2 TODAY');
    expect(list.rows[1]?.today).toBe('1 TODAY');
    // Zero is printed, not blank: a rule that fired for nobody today is a
    // fact about the rule, and an empty cell is a fact about the renderer.
    expect(list.rows[2]?.today).toBe('0 TODAY');
  }, 180_000);
});

/* ── row 2: the detail form round-trips every field ───────────────────── */

describe('s8 Sc10 row 2: every field the daemon stores, and one PATCH to change them', () => {
  it('round-trips the rule, saves the diff, and reverts to the stored row', async () => {
    let ids: string[] = [];
    const fixture = await boot(async (f) => {
      ids = await seedThree(f);
      await f.directClient.createSchedule({
        name: 'weeknights',
        timezone: 'America/Los_Angeles',
        windows: [{ days: ['mon'], start: '18:00', end: '22:00' }],
      });
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toRules(app);
    await waitForRuleRows(app, 4);
    await selectRule(app, ids[1] ?? '');

    const loaded = await readDetail(app);
    expect(loaded.name).toBe('rent inquiry');
    expect(loaded.kind).toBe('keyword');
    expect(loaded.keywords).toEqual(['rent']);
    expect(loaded.mode).toBe('any');
    expect(loaded.caseFlag).toBe('OFF');
    expect(loaded.wordFlag).toBe('OFF');
    expect(loaded.adapter).toBe('agent-one');
    expect(loaded.adapters).toEqual(['agent-one', 'agent-two']);
    expect(loaded.respond).toBe('DRAFT-ONLY');
    expect(loaded.schedule).toBe('');
    expect(loaded.schedules[0]).toBe('');
    expect(loaded.group).toBe('OFF');
    expect(loaded.ttl).toBe('30');
    // Opened and not touched: nothing to save, and SAVE says so.
    expect(loaded.dirty).toBe('no');
    expect(loaded.saveDisabled).toBe(true);

    // One field, then one request carrying one key.
    const mark = since(fixture);
    await retype(app, '#rule-name', 'rent and lease');
    await app.page.waitForSelector('#rule-detail[data-dirty="yes"]', {
      timeout: 15_000,
    });
    expect((await readDetail(app)).saveDisabled).toBe(false);
    await app.page.click('#rule-save');
    await app.page.waitForSelector('#rule-detail[data-dirty="no"]', {
      timeout: 15_000,
    });
    expect(writes(mark())).toEqual([`PATCH /v1/rules/${ids[1] ?? ''}`]);
    const saved = await fixture.directClient.getRule(ids[1] ?? '');
    expect(saved.name).toBe('rent and lease');
    // The fields nobody touched are untouched, which is what "the diff"
    // means and what a whole-object PUT would have quietly broken.
    expect(saved.draftTtlMinutes).toBe(30);
    expect(saved.priority).toBe(20);

    // REVERT goes back to the STORED row and asks the daemon for nothing.
    const quiet = since(fixture);
    await retype(app, '#rule-name', 'something else');
    await app.page.waitForSelector('#rule-detail[data-dirty="yes"]', {
      timeout: 15_000,
    });
    await app.page.click('#rule-revert');
    await app.page.waitForSelector('#rule-detail[data-dirty="no"]', {
      timeout: 15_000,
    });
    expect((await readDetail(app)).name).toBe('rent and lease');
    expect(quiet()).toEqual([]);
  }, 180_000);

  it('renders the daemon`s own 400 next to the field it names', async () => {
    let ids: string[] = [];
    const fixture = await boot(async (f) => {
      ids = await seedThree(f);
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toRules(app);
    await waitForRuleRows(app, 4);
    await selectRule(app, ids[1] ?? '');

    // A TTL the daemon refuses: `z.number().int().positive()`. The GUI could
    // have refused it locally — and does not, on purpose, for one field, so
    // that the path from a real `issues[].path` to a real field label is
    // exercised by a real 400 rather than by a fixture.
    await retype(app, '#rule-ttl', '0');
    await app.page.click('#rule-save');
    await app.page.waitForSelector('[data-issue="draftTtlMinutes"]', {
      timeout: 15_000,
    });
    const shown = await readDetail(app);
    // The DAEMON's sentence, verbatim. zod 4 is the validator this repo
    // runs and this is what it says; a `toMatch` over a paraphrase would
    // pass against a renderer that had invented its own wording, which is
    // the exact drift the "no parallel vocabulary" rule exists to stop.
    expect(shown.issues['draftTtlMinutes']).toBe(
      'Too small: expected number to be >0',
    );
    // The form stays dirty: a refused save is not a save.
    expect(shown.dirty).toBe('yes');
    const stored = await fixture.directClient.getRule(ids[1] ?? '');
    expect(stored.draftTtlMinutes).toBe(30);
    // A refusal is not an alert dialog. Sc7 banned those renderer-wide.
    expect((await readConfirm(app)).alerts).toBe(0);
  }, 180_000);

  it('compiles a regex the way the daemon will, and asks it on blur', async () => {
    let ids: string[] = [];
    const fixture = await boot(async (f) => {
      ids = await seedThree(f);
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toRules(app);
    await waitForRuleRows(app, 4);
    await selectRule(app, ids[3] ?? '');

    expect((await readDetail(app)).kind).toBe('regex');
    // Unbalanced: invalid, said in a word, and SAVE is refused.
    const quiet = since(fixture);
    await retype(app, '#rule-pattern', '(rent|lease(');
    await app.page.waitForSelector(
      '#rule-pattern-verdict[data-state="INVALID"]',
      {
        timeout: 15_000,
      },
    );
    const bad = await readDetail(app);
    expect(bad.patternVerdict).toContain('INVALID');
    expect(bad.saveDisabled).toBe(true);
    // Validity is computed in the renderer, per keystroke, with no timer and
    // no request: the tee saw nothing at all while that was typed.
    expect(quiet()).toEqual([]);

    // Valid, and then the daemon's own opinion, on BLUR — an event the
    // operator generates. Nothing here is scheduled.
    const mark = since(fixture);
    await retype(app, '#rule-pattern', 'r[ea]nt');
    await app.page.waitForSelector(
      '#rule-pattern-verdict[data-state="VALID"]',
      {
        timeout: 15_000,
      },
    );
    expect(mark()).toEqual([]);
    await app.page.click('#rule-name');
    await app.page.waitForSelector('#rule-pattern-server[data-state]', {
      timeout: 15_000,
    });
    expect(mark()).toEqual([`POST /v1/rules/${ids[3] ?? ''}/test`]);
  }, 180_000);

  it('offers THEME, disabled, and says why rather than 400ing on save', async () => {
    let ids: string[] = [];
    const fixture = await boot(async (f) => {
      ids = await seedThree(f);
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toRules(app);
    await waitForRuleRows(app, 4);
    await selectRule(app, ids[1] ?? '');

    const view = await readDetail(app);
    const theme = view.kinds.find((k) => k.kind === 'theme');
    expect(theme).toBeDefined();
    expect(theme?.disabled).toBe(true);
    expect(view.themeNote).toMatch(/NO ENDPOINT|REFUSE|NOT IN V1/i);
    // Pressing it changes nothing and asks for nothing.
    const quiet = since(fixture);
    await app.page.click('[data-kind="theme"]', { force: true });
    expect((await readDetail(app)).kind).toBe('keyword');
    expect(quiet()).toEqual([]);
  }, 180_000);
});

/* ── row 3: the dry run ───────────────────────────────────────────────── */

describe('s8 Sc10 row 3: a replay that drafts nothing and sends nothing', () => {
  it('replays the last fifty, counts them, and marks the keyword', async () => {
    let ids: string[] = [];
    const fixture = await boot(async (f) => {
      ids = await seedThree(f);
    });
    for (const text of [
      'is the rent due friday?',
      'lunch?',
      'RENT cheque posted',
      'nothing to see',
    ])
      fixture.fixture.addMessage({
        chatId: fixture.ids.chat,
        handleId: fixture.ids.handle,
        text,
      });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    // The replay reads INGESTED messages, so the poll has to have found
    // them: the daemon's own row count is the readiness signal.
    await waitForIngest(fixture, ids[1] ?? '', 4);
    await toRules(app);
    await waitForRuleRows(app, 4);
    await selectRule(app, ids[1] ?? '');

    const mark = since(fixture);
    await app.page.click('#rule-dryrun');
    await app.page.waitForSelector('#dryrun[data-total]', { timeout: 60_000 });
    await app.page.waitForFunction(
      () =>
        Number(
          document.querySelector('#dryrun')?.getAttribute('data-total') ?? '0',
        ) >= 4,
      undefined,
      { timeout: 120_000 },
    );

    const asked = mark();
    // ONE request, and it is a GET: the plan calls this a POST, and the
    // daemon has never had one — §1.6 route 7 is
    // `GET /v1/rules/:id/dry-run?limit=50`.
    expect(asked.filter((u) => u.includes('dry-run'))).toEqual([
      `GET /v1/rules/${ids[1] ?? ''}/dry-run?limit=50`,
    ]);
    expect(writes(asked)).toEqual([]);

    const view = await readDryRun(app);
    expect(view.present).toBe(true);
    expect(view.count).toMatch(/^\d+ \/ \d+ MATCHED$/);
    expect(view.note).toMatch(/READ-ONLY/i);
    expect(view.note).toMatch(/NOTHING DRAFTS/i);
    const hits = view.rows.filter((r) => r.matched === 'yes');
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits.flatMap((r) => r.hits).map((h) => h.toLowerCase())).toContain(
      'rent',
    );
    // The preview is the message, unaltered: highlighting is a wrapper, not
    // a rewrite.
    for (const row of view.rows) expect(row.preview.length).toBeGreaterThan(0);
    // And nothing was approved, drafted or sent by looking.
    expect(fixture.loopback.calls()).toEqual([]);
  }, 240_000);

  it('says so plainly when a rule would never have fired', async () => {
    let ids: string[] = [];
    const fixture = await boot(async (f) => {
      ids = await seedThree(f);
    });
    for (const text of ['lunch?', 'see you then', 'thanks'])
      fixture.fixture.addMessage({
        chatId: fixture.ids.chat,
        handleId: fixture.ids.handle,
        text,
      });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    // Three real messages, ingested. Without this the panel could say
    // "matched nothing" about a table that was empty, which is a true
    // sentence about the wrong question.
    await waitForIngest(fixture, ids[1] ?? '', 3);
    await toRules(app);
    await waitForRuleRows(app, 4);
    await selectRule(app, ids[1] ?? '');
    await app.page.click('#rule-dryrun');
    await app.page.waitForSelector('#dryrun[data-matched="0"]', {
      timeout: 120_000,
    });
    const view = await readDryRun(app);
    expect(view.empty).toMatch(/MATCHED NOTHING IN THE LAST/i);
    // Advisory, not a refusal: a rule that matched nothing in the last
    // fifty messages may be exactly right for the fifty-first.
    expect((await readDetail(app)).saveDisabled).toBe(true);
  }, 240_000);
});

/* ── row 4: shadowing ─────────────────────────────────────────────────── */

describe('s8 Sc10 row 4: exactly one rule drafts per message, ever', () => {
  it('names the higher-priority rule that would have won the row', async () => {
    let ids: string[] = [];
    const fixture = await boot(async (f) => {
      ids = await seedThree(f);
      // A rule ABOVE `rent inquiry` that also matches the rent message.
      await f.directClient.updateRule(ids[0] ?? '', {
        matcher: { kind: 'keyword', keywords: ['rent', 'urgent'], mode: 'any' },
      });
    });
    for (const text of ['is the rent due friday?', 'lunch?'])
      fixture.fixture.addMessage({
        chatId: fixture.ids.chat,
        handleId: fixture.ids.handle,
        text,
      });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await waitForIngest(fixture, ids[1] ?? '', 2);
    await toRules(app);
    await waitForRuleRows(app, 4);
    await selectRule(app, ids[1] ?? '');

    const mark = since(fixture);
    await app.page.click('#rule-dryrun');
    await app.page.waitForFunction(
      () =>
        Number(
          document.querySelector('#dryrun')?.getAttribute('data-total') ?? '0',
        ) >= 2,
      undefined,
      { timeout: 120_000 },
    );
    const view = await readDryRun(app);
    const shadowed = view.rows.find((r) => r.shadowed !== '');
    expect(shadowed?.shadowed).toBe('URGENT');
    expect(shadowed?.verdict).toMatch(/SHADOWED/);
    expect(shadowed?.verdict).not.toMatch(/WINS/);

    // `DryRunRow` carries no rule ids and `POST /v1/rules/:id/test` scores
    // ONE rule, so shadowing cannot come from `matchedRuleIds`. It is a
    // join over guid across the replays of the rules ABOVE this one, and
    // the request log is where that shows.
    const asked = mark().filter((u) => u.includes('dry-run'));
    expect(asked).toEqual([
      `GET /v1/rules/${ids[1] ?? ''}/dry-run?limit=50`,
      `GET /v1/rules/${ids[0] ?? ''}/dry-run?limit=50`,
    ]);
    expect(writes(mark())).toEqual([]);
  }, 240_000);
});

/* ── row 5: the dangerous combo. THE TEETH. ───────────────────────────── */

describe('s8 Sc10 row 5: auto in scope is a sentence you have to type', () => {
  it('asks before AUTO with a keyword matcher, and Return and Esc both cancel', async () => {
    let ids: string[] = [];
    const fixture = await boot(async (f) => {
      ids = await seedThree(f);
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toRules(app);
    await waitForRuleRows(app, 4);
    await selectRule(app, ids[1] ?? '');

    const mark = since(fixture);
    await app.page.click('[data-respond="AUTO"]');
    await app.page.click('#rule-save');
    await app.page.waitForSelector('#typed-confirm', { timeout: 15_000 });

    const modal = await readConfirm(app);
    expect(modal.role).toBe('dialog');
    expect(modal.modal).toBe('true');
    expect(modal.phrase).toBe('AUTO EVERYONE');
    expect(modal.title).toMatch(/AUTO/);
    expect(modal.alerts).toBe(0);
    // Nothing has been asked of the daemon yet.
    expect(writes(mark())).toEqual([]);

    // Esc cancels.
    await app.page.keyboard.press('Escape');
    await app.page.waitForSelector('#typed-confirm', {
      state: 'detached',
      timeout: 15_000,
    });
    expect(writes(mark())).toEqual([]);

    // Return cancels too, even with the phrase typed. §1.7 is explicit: the
    // key that means "yes" everywhere else must not mean it here.
    await app.page.click('#rule-save');
    await app.page.waitForSelector('#typed-confirm', { timeout: 15_000 });
    await app.page.click('#typed-confirm-input');
    await app.page.keyboard.type('AUTO EVERYONE');
    await app.page.keyboard.press('Enter');
    await app.page.waitForSelector('#typed-confirm', {
      state: 'detached',
      timeout: 15_000,
    });
    expect(writes(mark())).toEqual([]);
    expect((await fixture.directClient.getRule(ids[1] ?? '')).respondMode).toBe(
      'draft-only',
    );

    // A near-miss does not arm the button.
    await app.page.click('#rule-save');
    await app.page.waitForSelector('#typed-confirm', { timeout: 15_000 });
    await app.page.click('#typed-confirm-input');
    await app.page.keyboard.type('auto everyone');
    expect((await readConfirm(app)).goDisabled).toBe(true);
    await retype(app, '#typed-confirm-input', 'AUTO EVERYONE');
    expect((await readConfirm(app)).goDisabled).toBe(false);
    await app.page.click('#typed-confirm-go');
    await app.page.waitForSelector('#rule-detail[data-dirty="no"]', {
      timeout: 15_000,
    });
    expect(writes(mark())).toEqual([`PATCH /v1/rules/${ids[1] ?? ''}`]);
    expect((await fixture.directClient.getRule(ids[1] ?? '')).respondMode).toBe(
      'auto',
    );
  }, 180_000);

  /*
   * The same question for a REGEX matcher, and the reason this row has
   * teeth.
   *
   * A confirm that fired only for keyword rules would pass the test above
   * and still let `.` — a pattern that matches every message that ever
   * arrives — be armed for autonomy with one click. §1.7 does not ask about
   * the matcher's KIND; it asks whether the rule can answer for somebody the
   * operator did not enumerate, and every kind but `contact` can.
   */
  it('asks for a regex matcher too, because a pattern is not a list of people', async () => {
    let ids: string[] = [];
    const fixture = await boot(async (f) => {
      ids = await seedThree(f);
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toRules(app);
    await waitForRuleRows(app, 4);
    // ids[3] is `catch all`, whose matcher is the regex `.`.
    await selectRule(app, ids[3] ?? '');

    const mark = since(fixture);
    await app.page.click('[data-respond="AUTO"]');
    await app.page.click('#rule-save');
    await app.page.waitForSelector('#typed-confirm', { timeout: 15_000 });
    expect((await readConfirm(app)).phrase).toBe('AUTO EVERYONE');
    expect(writes(mark())).toEqual([]);

    await app.page.keyboard.press('Escape');
    await app.page.waitForSelector('#typed-confirm', {
      state: 'detached',
      timeout: 15_000,
    });
    expect(writes(mark())).toEqual([]);
    expect((await fixture.directClient.getRule(ids[3] ?? '')).respondMode).toBe(
      'draft-only',
    );

    // And it goes through once the sentence is typed, so the row is not
    // green merely because SAVE is broken for regex rules.
    await app.page.click('#rule-save');
    await app.page.waitForSelector('#typed-confirm', { timeout: 15_000 });
    await app.page.click('#typed-confirm-input');
    await app.page.keyboard.type('AUTO EVERYONE');
    await app.page.click('#typed-confirm-go');
    await app.page.waitForSelector('#rule-detail[data-dirty="no"]', {
      timeout: 15_000,
    });
    expect(writes(mark())).toEqual([`PATCH /v1/rules/${ids[3] ?? ''}`]);
    expect((await fixture.directClient.getRule(ids[3] ?? '')).respondMode).toBe(
      'auto',
    );
  }, 180_000);

  it('does not ask when the matcher is a contact list, because the scope is the list', async () => {
    let ids: string[] = [];
    const fixture = await boot(async (f) => {
      ids = await seedThree(f);
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toRules(app);
    await waitForRuleRows(app, 4);
    await selectRule(app, ids[1] ?? '');

    await app.page.click('[data-kind="contact"]');
    await app.page.click('#rule-handle-input');
    await app.page.keyboard.type(HANDLE);
    await app.page.keyboard.press('Enter');
    await app.page.waitForSelector(`[data-handle-pill="${HANDLE}"]`, {
      timeout: 15_000,
    });
    await app.page.click('[data-respond="AUTO"]');

    const mark = since(fixture);
    await app.page.click('#rule-save');
    await app.page.waitForSelector('#rule-detail[data-dirty="no"]', {
      timeout: 15_000,
    });
    expect((await readConfirm(app)).present).toBe(false);
    expect(writes(mark())).toEqual([`PATCH /v1/rules/${ids[1] ?? ''}`]);
    const stored = await fixture.directClient.getRule(ids[1] ?? '');
    expect(stored.respondMode).toBe('auto');
    expect(stored.matcher).toEqual({ kind: 'contact', handles: [HANDLE] });
  }, 180_000);
});

/* ── row 6: a new rule's defaults are the DAEMON's row ────────────────── */

describe('s8 Sc10 row 6: a new rule is the safe one until somebody says otherwise', () => {
  it('creates it draft-only, group-less, TTL 30, unscheduled — asserted on the server', async () => {
    const fixture = await boot(async (f) => {
      await seedThree(f);
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toRules(app);
    await waitForRuleRows(app, 4);

    await app.page.click('#rules-new');
    await app.page.waitForSelector('#rule-detail[data-rule-id=""]', {
      timeout: 15_000,
    });
    const blank = await readDetail(app);
    expect(blank.respond).toBe('DRAFT-ONLY');
    expect(blank.group).toBe('OFF');
    expect(blank.ttl).toBe('30');
    expect(blank.schedule).toBe('');
    // Unsaved and unsavable: no name, no matcher.
    expect(blank.saveDisabled).toBe(true);

    await app.page.click('#rule-name');
    await app.page.keyboard.type('new rule');
    await app.page.click('#rule-keyword-input');
    await app.page.keyboard.type('deposit');
    await app.page.keyboard.press('Enter');
    await app.page.waitForSelector('[data-keyword="deposit"]', {
      timeout: 15_000,
    });

    const mark = since(fixture);
    await app.page.click('#rule-save');
    await waitForRuleRows(app, 5);
    expect(writes(mark())).toEqual(['POST /v1/rules']);

    // The claim is about the row the DAEMON stored, not the form that was
    // on screen. §2.3's DDL default for `draftTtlMinutes` is 240, so a form
    // that showed 30 and omitted the field would have stored 240 and this
    // row is the only place that difference is visible.
    const stored = (await fixture.directClient.listRules()).find(
      (r) => r.name === 'new rule',
    );
    expect(stored).toBeDefined();
    expect(stored?.respondMode).toBe('draft-only');
    expect(stored?.allowGroupDrafts).toBe(false);
    expect(stored?.draftTtlMinutes).toBe(30);
    expect(stored?.scheduleId).toBeNull();
    expect(stored?.enabled).toBe(true);
    expect(stored?.outsideWindow).toBe('draft-only');
  }, 180_000);
});

/* ── row 7: the third outside-window mode is not on the screen ────────── */

describe('s8 Sc10 row 7: a mode the daemon refuses is not a mode the GUI offers', () => {
  it('offers two outside-window choices and explains the missing third', async () => {
    let ids: string[] = [];
    const fixture = await boot(async (f) => {
      ids = await seedThree(f);
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toRules(app);
    await waitForRuleRows(app, 4);
    await selectRule(app, ids[1] ?? '');

    const view = await readDetail(app);
    expect(view.outside).toEqual(['draft-only', 'ignore']);
    expect(view.outsideNote).toMatch(/NOT SUPPORTED|NOT IN V1/i);
    expect(view.outsideNote.toLowerCase()).toContain('queue');

    // Non-vacuous from the other side: the daemon really does refuse it, so
    // the absence is a refusal the GUI is honouring rather than a field
    // nobody got round to.
    await expect(
      fixture.directClient.updateRule(ids[1] ?? '', {
        outsideWindow: 'queue',
      }),
    ).rejects.toThrow(/400/);
  }, 180_000);
});

/* ── row 8: nothing green, on every panel this screen has ─────────────── */

describe('s8 Sc10 row 8: the editor is not the place green sneaks in', () => {
  it('sweeps the list, the detail, the dry run and the confirm, in both schemes', async () => {
    let ids: string[] = [];
    const fixture = await boot(async (f) => {
      ids = await seedThree(f);
    });
    fixture.fixture.addMessage({
      chatId: fixture.ids.chat,
      handleId: fixture.ids.handle,
      text: 'is the rent due friday?',
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toRules(app);
    await waitForRuleRows(app, 4);

    const sweep = async (): Promise<void> => {
      for (const scheme of ['dark', 'light'] as const) {
        await app.page.emulateMedia({ colorScheme: scheme });
        expect(await runtimeGreenOffenders(app.page)).toEqual([]);
      }
      await app.page.emulateMedia({ colorScheme: 'dark' });
    };

    await sweep();
    await selectRule(app, ids[1] ?? '');
    await sweep();
    await app.page.click('#rule-dryrun');
    await app.page.waitForSelector('#dryrun[data-total]', { timeout: 120_000 });
    await sweep();
    await app.page.click('[data-respond="AUTO"]');
    await app.page.click('#rule-save');
    await app.page.waitForSelector('#typed-confirm', { timeout: 15_000 });
    await sweep();
  }, 240_000);
});

/* ── row 9: editing a rule cannot approve what it already drafted ─────── */

describe('s8 Sc10 row 9: a rule change is not a send path (INV-2)', () => {
  it('leaves a draft minted under the old rule exactly where it was', async () => {
    let ids: string[] = [];
    const fixture = await boot(async (f) => {
      ids = await seedThree(f);
    });
    // A draft that already exists, attributed to the rule about to change.
    const at = new Date(fixture.clock.nowMs() - 60_000).toISOString();
    fixture.daemon.store.insertDraft({
      id: '01HQ0000000000000000000RUL',
      inboundGuid: null,
      chatGuid: CHAT,
      ruleId: ids[1] ?? '',
      adapterId: 'agent-one',
      idempotencyKey: 'sc10-inflight-1',
      body: 'the answer under the old rule',
      originalBody: 'the answer under the old rule',
      state: 'pending',
      stateChangedAt: at as never,
      expiresAt: new Date(
        fixture.clock.nowMs() + 3_600_000,
      ).toISOString() as never,
      createdAt: at as never,
    } as never);

    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toRules(app);
    await waitForRuleRows(app, 4);
    await selectRule(app, ids[1] ?? '');

    // The screen SAYS it, before anything is changed. An editor that let an
    // operator believe a save re-decides work already done is an editor
    // that will eventually be right about that.
    const before = await readDetail(app);
    expect(before.inflight).toMatch(/1 DRAFT/);
    expect(before.inflight).toMatch(
      /SAVING (CHANGES )?NOTHING|NOT RE-?DECIDED/i,
    );

    const mark = since(fixture);
    await app.page.click('[data-respond="AUTO"]');
    await app.page.click('#rule-save');
    await app.page.waitForSelector('#typed-confirm', { timeout: 15_000 });
    await app.page.click('#typed-confirm-input');
    await app.page.keyboard.type('AUTO EVERYONE');
    await app.page.click('#typed-confirm-go');
    await app.page.waitForSelector('#rule-detail[data-dirty="no"]', {
      timeout: 15_000,
    });

    // One PATCH. No approval, no dispatch, no send. `maybeAutoApprove` has
    // exactly one call site and it is the inbound submit path; a rules PATCH
    // cannot reach it, and this is the observation rather than the argument.
    const asked = mark();
    expect(writes(asked)).toEqual([`PATCH /v1/rules/${ids[1] ?? ''}`]);
    expect(asked.join('\n')).not.toMatch(/approve|dispatch/i);
    expect(fixture.loopback.calls()).toEqual([]);
    const draft = await fixture.directClient.getDraft(
      '01HQ0000000000000000000RUL',
    );
    expect(draft.draft.state).toBe('pending');
    // Nor did the whole app acquire an approval by any other route.
    expect(urls(fixture).filter((u) => /approve/.test(u))).toEqual([]);
  }, 180_000);
});

/* ── row 10: the ladder, and the deny-all default ─────────────────────── */

describe('s8 Sc10 row 10: the screen tells the truth about what a rule can do', () => {
  it('renders AUTO under a draft-only global as DRAFT-ONLY, narrowed by GLOBAL', async () => {
    let ids: string[] = [];
    const fixture = await boot(async (f) => {
      ids = await seedThree(f);
      await f.directClient.setContactPolicy(HANDLE, 'draft-only');
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toRules(app);
    await waitForRuleRows(app, 4);
    await selectRule(app, ids[1] ?? '');

    // The shipped global mode is `draft-only` (§2.4.3's own default), so a
    // rule set to AUTO is a rule that will draft.
    await app.page.click('[data-respond="AUTO"]');
    const view = await readDetail(app);
    expect(view.respond).toBe('AUTO');
    expect(view.rungs.map((r) => r.rung)).toEqual([
      'GLOBAL',
      'RULE',
      'CONTACT',
    ]);
    expect(view.rungs[0]?.value).toBe('DRAFT-ONLY');
    expect(view.rungs[1]?.value).toBe('AUTO');
    expect(view.rungs[2]?.value).toBe('PER CONTACT');
    expect(view.effective).toBe('DRAFT-ONLY');
    expect(view.narrowedBy).toBe('GLOBAL');
    expect(view.deny).toContain('1 CONTACT HAS A POLICY');
  }, 180_000);

  it('says the rule drafts for nobody while no contact has a policy', async () => {
    let ids: string[] = [];
    const fixture = await boot(async (f) => {
      ids = await seedThree(f);
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toRules(app);
    await waitForRuleRows(app, 4);
    await selectRule(app, ids[1] ?? '');

    // §2.4.3 step 3: `contact === null` denies outright, whatever the rule
    // says. This is the fact S7 Sc13 discovered by having four adapters
    // draft nothing, and the operator's own route is what fixes it.
    const empty = await readDetail(app);
    expect(empty.deny).toBe(
      'NO CONTACT HAS A POLICY · THIS RULE DRAFTS FOR NOBODY',
    );

    await fixture.directClient.setContactPolicy(OTHER, 'draft-only');
    await app.page.keyboard.press('Meta+Digit1');
    await app.page.waitForSelector('html[data-screen="queue"]', {
      timeout: 15_000,
    });
    await toRules(app);
    await selectRule(app, ids[1] ?? '');
    expect((await readDetail(app)).deny).toContain('1 CONTACT HAS A POLICY');
  }, 180_000);
});

/* ── row 11: the queue's one tab stop survives the editor's controls ──── */

describe('s8 Sc10 row 11: real controls here, and still one tab stop there', () => {
  it('gives the editor focusable fields and hands the queue back unchanged', async () => {
    let ids: string[] = [];
    const fixture = await boot(async (f) => {
      ids = await seedThree(f);
    });
    await fixture.directClient.createDraft({
      chatGuid: OTHER_CHAT,
      body: 'something to approve',
      ttlMinutes: 600,
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);

    const tabbables = async (): Promise<number> =>
      app.page.evaluate(
        () =>
          document.querySelectorAll(
            'a[href], button, input, select, textarea,' +
              ' [tabindex]:not([tabindex="-1"])',
          ).length,
      );

    // The queue: one, which is the listbox. Sc6's decision, re-proved on
    // the day the app acquired controls elsewhere.
    await app.page.waitForSelector('html[data-store-rows="1"]', {
      timeout: 30_000,
    });
    expect(await tabbables()).toBe(1);

    await toRules(app);
    await waitForRuleRows(app, 4);
    await selectRule(app, ids[1] ?? '');
    // The editor has real fields, because a typed confirmation is a text
    // field and a name is a text field. The Sc7 ban is scoped to
    // `screens/queue` and always was; the arch row states where the line is.
    expect(await tabbables()).toBeGreaterThan(1);
    const list = await readList(app);
    // …and none of them is inside an option, so the listbox contract holds.
    expect(list.optionControls).toBe(0);

    // Back to the queue, and back to one.
    await app.page.keyboard.press('Meta+Digit1');
    await app.page.waitForSelector('html[data-screen="queue"]', {
      timeout: 15_000,
    });
    expect(await tabbables()).toBe(1);
  }, 180_000);
});
