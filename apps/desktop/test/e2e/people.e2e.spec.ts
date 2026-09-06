/**
 * s8 Sc12 — contacts and policies, against a real daemon.
 *
 * This is the screen where the product's default is the strictest thing it
 * can do, and where the ordinary way to build a table would be a lie.
 * §2.4.3 step 3 lives at `packages/core/src/gate/index.ts` inside
 * `evaluateGate`:
 *
 *     if (ctx.rule !== null || agentOrigin) {
 *       if (ctx.contact === null || ctx.contact.mode === 'deny') {
 *         return { allow: false, reason: 'contact-denied' };
 *       }
 *       mode = narrower(mode, ctx.contact.mode);
 *     }
 *
 * Three facts follow, and every row below is one of them reaching a screen:
 *
 *  - **Absence is deny.** A contacts grid with a blank policy column would
 *    be describing the strictest state this product has as the absence of a
 *    state. So the empty state and the per-row cell both SAY it, in words.
 *  - **The deny binds rules and agents, not people.** The guard is
 *    `ctx.rule !== null || agentOrigin`, and `dispatchApproved` builds its
 *    re-gate context with `rule = draft.ruleId === null ? null : …` and no
 *    `agentOrigin` at all — so a human-minted draft never consults the
 *    contact ladder. A screen that said "DENIED" full stop would be
 *    over-claiming, and an operator who believed it would stop approving.
 *  - **Contact scope narrows only.** `narrower(mode, ctx.contact.mode)` has
 *    no branch that raises. Row 10 proves that at the wire: a contact set
 *    to AUTO under a `draft-only` global drafts and does not send, and the
 *    SAME fixture with the global flipped auto-sends. The contrast is what
 *    makes it an observation rather than a screen that always agrees.
 *
 * Row 11 is this scenario's version of Sc11 row 10, over a different clamp.
 * `sms-auto-forbidden` is the LAST branch of §1.7's else-if chain and lives
 * inside `dispatchApproved`'s `isAutoApproval` block, so an SMS handle stops
 * the machine and cannot veto a person. It is also unconditional here:
 * `send.allowSmsAuto` is deliberately absent from
 * `packages/daemon/src/settings/schema.ts` and NO route writes it, so there
 * is no operator gesture anywhere that turns it off.
 *
 * Row 12 is INV-2. Rewriting a policy underneath a queued draft dispatches
 * nothing and approves nothing.
 *
 * Synthetic handles only (`+1555…`) and synthetic names, as everywhere in
 * this PUBLIC repo. No handle, name or room guid below belongs to anybody.
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
import { connectFakeAgent, type FakeAgent } from './fake-agent.js';

const ALICE = '+15550000001';
const BRUNO = '+15550000002';
const CARLA = '+15550000003';
const DIEGO = '+15550000004';
const BRUNO_CHAT = `iMessage;-;${BRUNO}`;
const DIEGO_SMS = `SMS;-;${DIEGO}`;
const ROOM = 'iMessage;+;chat555000009';

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
  ids: {
    alice: number;
    aliceChat: number;
    diego: number;
    diegoChat: number;
  };
  /** The one adapter every rule below points at, and its one-shot token. */
  credential: { id: string; token: string };
}

/**
 * A daemon whose clock starts where the wall clock is.
 *
 * The AUTO-SENDS column is counted against a window ending at the
 * RENDERER's instant, and the harness's default is months in the past:
 * every audit row the daemon stamped would fall outside the hour and the
 * column would read zero for reasons that have nothing to do with the
 * arithmetic. Time is still driven by hand from here on (C-11).
 */
async function boot(before?: (f: Seeded) => Promise<void>): Promise<Seeded> {
  const ids = { alice: 0, aliceChat: 0, diego: 0, diegoChat: 0 };
  const fixture = await bootFixtureDaemon({
    clockAt: new Date().toISOString(),
    seed: (f) => {
      ids.alice = f.addHandle(ALICE);
      ids.aliceChat = f.addChat({ identifier: ALICE, handleIds: [ids.alice] });
      ids.diego = f.addHandle(DIEGO, { service: 'SMS' });
      ids.diegoChat = f.addChat({
        identifier: DIEGO,
        service: 'SMS',
        handleIds: [ids.diego],
      });
    },
  });
  running.push(fixture.stop);
  const made = await fixture.directClient.createAdapter({
    id: 'agent-one',
    kind: 'generic',
    displayName: 'agent one',
  });
  const seeded: Seeded = {
    ...fixture,
    ids,
    credential: { id: 'agent-one', token: made.token },
  };
  await before?.(seeded);
  return seeded;
}

/**
 * A scripted adapter on the real `/v1/agent` socket.
 *
 * Rows 4, 10 and 11 are about what AUTONOMY does, and autonomy begins at
 * `adapters/submit.ts` — reachable only from an agent answering a request
 * the gateway issued. See `fake-agent.ts`.
 */
async function agent(fixture: Seeded, body: string): Promise<FakeAgent> {
  const fake = await connectFakeAgent({
    port: fixture.daemon.port,
    adapterId: fixture.credential.id,
    token: fixture.credential.token,
    body,
    now: () => fixture.clock.now(),
    connected: () =>
      fixture.daemon.store.getAdapter(fixture.credential.id)?.health ===
      'connected',
  });
  running.push(fake.close);
  return fake;
}

/** The one rule every autonomy row uses, minted fresh (matchers are mutable). */
const rent = (): RuleInput => ({
  name: 'rent inquiry',
  matcher: { kind: 'keyword', keywords: ['rent'], mode: 'any' },
  adapterId: 'agent-one',
  respondMode: 'auto',
});

const ANSWER = 'the front desk will call you back';

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

/** `⌘4` — the people screen. Navigation is a key; see the arch row. */
async function toPeople(app: LaunchedApp): Promise<void> {
  await app.page.keyboard.press('Meta+Digit4');
  await app.page.waitForSelector('html[data-screen="people"]', {
    timeout: 15_000,
  });
  await app.page.waitForSelector('#people[data-people="ready"]', {
    timeout: 30_000,
  });
}

async function waitForPeopleRows(app: LaunchedApp, n: number): Promise<void> {
  await app.page.waitForSelector(`html[data-people-rows="${String(n)}"]`, {
    timeout: 30_000,
  });
}

interface GridRow {
  readonly key: string;
  readonly handle: string;
  readonly name: string;
  readonly mode: string;
  readonly modeText: string;
  readonly service: string;
  readonly group: string;
  readonly auto: string;
  readonly autoText: string;
  readonly held: string;
  readonly dim: string;
  readonly segments: string[];
  readonly selected: string;
}

interface GridView {
  readonly present: boolean;
  readonly role: string;
  readonly rowCount: string;
  readonly drawn: number;
  readonly total: string;
  readonly rows: GridRow[];
  readonly headers: string[];
  readonly more: string;
  readonly empty: string;
  readonly banner: string;
  readonly bannerMode: string;
  readonly denyNote: string;
  readonly precedence: string;
  readonly chips: { mode: string; state: string }[];
  readonly links: number;
  readonly tabIndexes: number;
}

async function readGrid(app: LaunchedApp): Promise<GridView> {
  return app.page.evaluate(() => {
    const attr = (el: Element | null, name: string): string =>
      el?.getAttribute(name) ?? '';
    const text = (el: Element | null): string =>
      (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const grid = document.querySelector('#people-grid');
    const rows = Array.from(
      document.querySelectorAll('#people-grid [role="row"][data-key]'),
    );
    return {
      present: grid !== null,
      role: attr(grid, 'role'),
      rowCount: attr(grid, 'aria-rowcount'),
      drawn: rows.length,
      total: attr(grid, 'data-total'),
      rows: rows.map((row) => ({
        key: attr(row, 'data-key'),
        handle: text(row.querySelector('.people-handle')),
        name: text(row.querySelector('.people-name')),
        mode: attr(row, 'data-mode'),
        modeText: text(row.querySelector('.people-mode')),
        service: attr(row, 'data-service'),
        group: attr(row, 'data-group'),
        auto: attr(row.querySelector('.people-auto'), 'data-auto'),
        autoText: text(row.querySelector('.people-auto')),
        held: attr(row, 'data-held'),
        dim: attr(row, 'data-dim'),
        selected: attr(row, 'data-selected'),
        segments: Array.from(row.querySelectorAll('[data-mode-set]')).map(
          (b) => `${attr(b, 'data-mode-set')}:${attr(b, 'data-state')}`,
        ),
      })),
      headers: Array.from(
        document.querySelectorAll('#people-grid [role="columnheader"]'),
      ).map((h) => text(h)),
      more: text(document.querySelector('#people-more')),
      empty: text(document.querySelector('#people-empty')),
      banner: text(document.querySelector('#people-default')),
      bannerMode: attr(
        document.querySelector('#people-default'),
        'data-global',
      ),
      denyNote: text(document.querySelector('#people-deny-note')),
      precedence: text(document.querySelector('#people-precedence')),
      chips: Array.from(document.querySelectorAll('.people-chip')).map((c) => ({
        mode: attr(c, 'data-mode'),
        state: attr(c, 'data-state'),
      })),
      links: document.querySelectorAll('a[href]').length,
      tabIndexes: document.querySelectorAll('[tabindex]').length,
    };
  });
}

interface ScopeView {
  readonly present: boolean;
  readonly key: string;
  readonly rungs: string[];
  readonly effective: string;
  readonly narrowed: string;
  readonly sentence: string;
  readonly note: string;
}

async function readScope(app: LaunchedApp): Promise<ScopeView> {
  return app.page.evaluate(() => {
    const attr = (el: Element | null, name: string): string =>
      el?.getAttribute(name) ?? '';
    const text = (el: Element | null): string =>
      (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const scope = document.querySelector('#people-scope');
    return {
      present: scope !== null,
      key: attr(scope, 'data-key'),
      rungs: Array.from(document.querySelectorAll('.people-rung')).map(
        (r) => `${attr(r, 'data-rung')}=${attr(r, 'data-value')}`,
      ),
      effective: attr(
        document.querySelector('#people-scope-effective'),
        'data-value',
      ),
      narrowed: attr(
        document.querySelector('#people-scope-effective'),
        'data-narrowed',
      ),
      sentence: text(document.querySelector('#people-scope-sentence')),
      note: text(document.querySelector('#people-scope-note')),
    };
  });
}

async function setMode(
  app: LaunchedApp,
  key: string,
  mode: string,
): Promise<void> {
  await app.page.click(`[data-key="${key}"][data-mode-set="${mode}"]`);
}

/* ── row 1: the grid is the union, and it can be narrowed ─────────────── */

describe('s8 Sc12 row 1: every handle the daemon knows about, and no other', () => {
  it('unions stored policies with the handles live drafts name', async () => {
    const fixture = await boot(async (f) => {
      await f.directClient.setContactPolicy(ALICE, 'auto', {
        displayName: 'Test User 1',
      });
      await f.directClient.setContactPolicy(BRUNO, 'draft-only', {
        displayName: 'Test User 2',
      });
      await f.directClient.setContactPolicy(CARLA, 'deny');
      // A draft for a handle with NO policy row. This is the person an
      // operator opens this screen to find, and a grid built from
      // `GET /v1/contacts` alone would not have a row for them at all.
      await f.directClient.createDraft({
        chatGuid: DIEGO_SMS,
        body: 'the front desk will call you back',
        ttlMinutes: 480,
      });
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toPeople(app);
    await waitForPeopleRows(app, 4);

    const view = await readGrid(app);
    expect(view.present).toBe(true);
    expect(view.role).toBe('grid');
    expect(view.rows.map((r) => r.key)).toEqual([ALICE, BRUNO, CARLA, DIEGO]);
    expect(view.rowCount).toBe('4');
    // A row for a handle with no policy, and the cell says what that means
    // rather than leaving it blank.
    const diego = view.rows.find((r) => r.key === DIEGO);
    expect(diego?.mode).toBe('none');
    expect(diego?.modeText).not.toBe('');
    expect(diego?.modeText).toMatch(/NO POLICY/);
    expect(view.rows.find((r) => r.key === ALICE)?.name).toBe('TEST USER 1');
    // The screen is a keymap plus real controls; it is not a browser.
    expect(view.links).toBe(0);
    expect(view.tabIndexes).toBe(0);
  }, 180_000);

  it('filters by handle, by name and by mode, including the absence of one', async () => {
    const fixture = await boot(async (f) => {
      await f.directClient.setContactPolicy(ALICE, 'auto', {
        displayName: 'Test User 1',
      });
      await f.directClient.setContactPolicy(BRUNO, 'draft-only', {
        displayName: 'Test User 2',
      });
      await f.directClient.setContactPolicy(CARLA, 'deny');
      await f.directClient.createDraft({
        chatGuid: DIEGO_SMS,
        body: 'the front desk will call you back',
        ttlMinutes: 480,
      });
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toPeople(app);
    await waitForPeopleRows(app, 4);

    const quiet = since(fixture);
    await app.page.fill('#people-search', 'test user 2');
    await app.page.waitForFunction(
      () =>
        document.querySelectorAll('#people-grid [role="row"][data-key]')
          .length === 1,
      undefined,
      { timeout: 15_000 },
    );
    expect((await readGrid(app)).rows[0]?.key).toBe(BRUNO);

    await app.page.fill('#people-search', '');
    await app.page.click('.people-chip[data-mode="none"]');
    await app.page.waitForFunction(
      () =>
        document.querySelectorAll('#people-grid [role="row"][data-key]')
          .length === 1,
      undefined,
      { timeout: 15_000 },
    );
    const only = await readGrid(app);
    expect(only.rows[0]?.key).toBe(DIEGO);
    expect(only.chips.find((c) => c.mode === 'none')?.state).toBe('ON');
    // Searching and filtering are LOCAL. A screen that refetched per
    // keystroke would put a request storm behind a text field.
    expect(quiet()).toEqual([]);
  }, 180_000);
});

/* ── row 2: the default, stated rather than implied ───────────────────── */

describe('s8 Sc12 row 2: the banner says what happens with no row at all', () => {
  it('reads the global mode from settings and names the deny-all default', async () => {
    const fixture = await boot();
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toPeople(app);
    await waitForPeopleRows(app, 0);

    const view = await readGrid(app);
    // §2.4.3's own default, and the daemon's shipped one.
    expect(view.bannerMode).toBe('draft-only');
    expect(view.banner).toContain('DRAFT-ONLY');
    // The sentence this whole scenario exists for. Not "no contacts yet".
    expect(view.empty).toMatch(/NO CONTACT HAS A POLICY/);
    expect(view.empty).toMatch(/DENIED/);
    // …and correctly SCOPED: the deny binds rules and agents. A human can
    // still approve a draft for a handle that has no row, because
    // `dispatchApproved` passes a null rule and no agent origin for one.
    expect(view.denyNote).toMatch(/RULE|AGENT/);
    expect(view.denyNote).toMatch(/HUMAN/);
    // The plan wants a "link to Settings" here. There is no browser in this
    // process and `<a href>` is banned renderer-wide; the global mode is a
    // ⌘-digit away and the banner says which one.
    expect(view.links).toBe(0);
    expect(view.banner).toMatch(/⌘6|SETTINGS/);

    // Non-vacuous from the daemon's side: this really is what the gate
    // does, and the banner is reading a real key rather than a constant.
    await fixture.directClient.setGlobalMode('auto');
    await app.page.keyboard.press('Meta+Digit1');
    await app.page.waitForSelector('html[data-screen="queue"]', {
      timeout: 15_000,
    });
    await toPeople(app);
    await expect
      .poll(async () => (await readGrid(app)).bannerMode, { timeout: 30_000 })
      .toBe('auto');
  }, 240_000);
});

/* ── row 3: the segmented control IS the row ──────────────────────────── */

describe('s8 Sc12 row 3: one gesture, one PUT, and the scope it lands in', () => {
  it('writes once when AUTO is chosen, and shows the ladder that follows', async () => {
    const fixture = await boot(async (f) => {
      await f.directClient.setContactPolicy(ALICE, 'draft-only', {
        displayName: 'Test User 1',
      });
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toPeople(app);
    await waitForPeopleRows(app, 1);

    const before = await readGrid(app);
    expect(before.rows[0]?.segments).toEqual([
      'deny:OFF',
      'draft-only:ON',
      'auto:OFF',
    ]);

    const mark = since(fixture);
    await setMode(app, ALICE, 'auto');
    await app.page.waitForSelector(
      `#people-grid [data-key="${ALICE}"][data-mode="auto"]`,
      { timeout: 15_000 },
    );

    // EXACTLY one write, and it is the route the transport snapshot names.
    const asked = mark();
    expect(writes(asked)).toEqual([
      `PUT /v1/contacts/${encodeURIComponent(ALICE)}`,
    ]);
    expect(asked.join('\n')).not.toMatch(/approve|dispatch/i);
    expect(fixture.loopback.calls()).toEqual([]);
    // …and the daemon really stored it.
    expect(
      (await fixture.directClient.listContacts()).find(
        (c) => c.handle === ALICE,
      )?.mode,
    ).toBe('auto');

    // The row expands into the ladder, and the ladder is honest: the global
    // is still `draft-only`, so AUTO here resolves to DRAFT-ONLY and the
    // rung that took the decision is named.
    const scope = await readScope(app);
    expect(scope.present).toBe(true);
    expect(scope.key).toBe(ALICE);
    expect(scope.rungs).toEqual([
      'GLOBAL=DRAFT-ONLY',
      'RULE=PER RULE',
      'CONTACT=AUTO',
    ]);
    expect(scope.effective).toBe('draft-only');
    expect(scope.narrowed).toBe('GLOBAL');
    expect(scope.note).toBe('EACH RUNG CAN ONLY NARROW THE ONE ABOVE IT');
  }, 240_000);

  it('dims a denied row and strikes its auto column with a single hyphen', async () => {
    const fixture = await boot(async (f) => {
      await f.directClient.setContactPolicy(ALICE, 'auto', {
        displayName: 'Test User 1',
      });
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toPeople(app);
    await waitForPeopleRows(app, 1);

    const mark = since(fixture);
    await setMode(app, ALICE, 'deny');
    await app.page.waitForSelector(
      `#people-grid [data-key="${ALICE}"][data-mode="deny"]`,
      { timeout: 15_000 },
    );
    expect(writes(mark())).toEqual([
      `PUT /v1/contacts/${encodeURIComponent(ALICE)}`,
    ]);

    const row = (await readGrid(app)).rows[0];
    expect(row?.dim).toBe('yes');
    // A hyphen rather than `0`. Zero is a count; this column has no count,
    // because nothing may auto-send to a denied handle at all.
    expect(row?.auto).toBe('-');
    expect(row?.autoText).toBe('-');
    // Colour is never the only carrier: the word is there too.
    expect(row?.modeText).toContain('DENY');
  }, 240_000);
});

/* ── row 4: the counters, from real audit rows ────────────────────────── */

describe('s8 Sc12 row 4: AUTO-SENDS is derived, and the cap is the cap', () => {
  it('counts a real auto-approval against the handle its draft named', async () => {
    const fixture = await boot(async (f) => {
      await f.directClient.setGlobalMode('auto');
      await f.directClient.setContactPolicy(ALICE, 'auto', {
        displayName: 'Test User 1',
      });
      await f.directClient.createRule(rent());
    });
    // A real adapter, answering a real request, through `adapters/submit.ts`
    // — the ONLY door `maybeAutoApprove` is behind.
    const fake = await agent(fixture, ANSWER);
    fixture.fixture.addMessage({
      chatId: fixture.ids.aliceChat,
      handleId: fixture.ids.alice,
      text: 'is the rent due friday?',
    });
    // The daemon's own verdict first: an auto-approval really happened.
    await expect
      .poll(
        async () =>
          (await fixture.directClient.listAudit({ event: 'auto.approved' }))
            .length,
        { timeout: 120_000, interval: 250 },
      )
      .toBe(1);
    // …and the agent was told the RESOLVED mode, not the rule's declared
    // one (F-60). With every rung at AUTO they coincide, which is what makes
    // the contrast in row 10 legible.
    expect(fake.requests()).toHaveLength(1);
    expect(fake.requests()[0]?.respondMode).toBe('auto');

    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toPeople(app);
    await waitForPeopleRows(app, 1);

    const row = (await readGrid(app)).rows[0];
    expect(row?.key).toBe(ALICE);
    expect(row?.auto).toBe('1');
    // And it is HELD, because `DEFAULT_RATE_CAPS.contactPer2Min` is 1 and
    // `overRateCap` compares with `>=`. The word, not a colour.
    expect(row?.held).toBe('rate-limited');
    expect(row?.autoText).toMatch(/HELD/);
  }, 300_000);
});

/* ── row 5: a room is observed, never answered ────────────────────────── */

describe('s8 Sc12 row 5: a group thread has no policy to set (INV-5)', () => {
  it('shows the chat guid and observe-only, with no segmented control', async () => {
    const fixture = await boot(async (f) => {
      await f.directClient.createDraft({
        chatGuid: ROOM,
        body: 'the front desk will call you back',
        ttlMinutes: 480,
      });
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toPeople(app);
    await waitForPeopleRows(app, 1);

    const row = (await readGrid(app)).rows[0];
    expect(row?.group).toBe('yes');
    expect(row?.key).toBe(ROOM);
    // The guid is the only name a room has, so the guid is what is shown.
    expect(row?.handle).toBe(ROOM);
    expect(row?.modeText).toMatch(/OBSERVE-ONLY/);
    // No control at all. A room has no single counterparty, so there is no
    // `ContactPolicy` a segmented control could write.
    expect(row?.segments).toEqual([]);
    expect(row?.auto).toBe('-');
  }, 180_000);
});

/* ── row 6: bulk, and the sentence it makes you type ──────────────────── */

describe('s8 Sc12 row 6: setting several rows to AUTO is typed, then N writes', () => {
  it('asks once, names the count, and issues one PUT per row in order', async () => {
    const fixture = await boot(async (f) => {
      await f.directClient.setContactPolicy(ALICE, 'draft-only', {
        displayName: 'Test User 1',
      });
      await f.directClient.setContactPolicy(BRUNO, 'draft-only', {
        displayName: 'Test User 2',
      });
      await f.directClient.setContactPolicy(CARLA, 'draft-only');
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toPeople(app);
    await waitForPeopleRows(app, 3);

    await app.page.click(`.people-x[data-key="${ALICE}"]`);
    await app.page.click(`.people-x[data-key="${CARLA}"]`);
    await app.page.waitForSelector('#people-bulk[data-count="2"]', {
      timeout: 15_000,
    });

    const mark = since(fixture);
    await app.page.selectOption('#people-bulk-mode', 'auto');
    await app.page.waitForSelector('#typed-confirm', { timeout: 15_000 });

    const modal = await app.page.evaluate(() => ({
      phrase:
        document.querySelector('#typed-confirm')?.getAttribute('data-phrase') ??
        '',
      body: (
        document.querySelector('#typed-confirm')?.textContent ?? ''
      ).replace(/\s+/g, ' '),
      armed:
        document.querySelector('#typed-confirm')?.getAttribute('data-armed') ??
        '',
    }));
    expect(modal.phrase).toBe('AUTO');
    expect(modal.armed).toBe('no');
    // The modal says how many rows and how many REQUESTS, because there is
    // no bulk route for contacts and an operator is entitled to know that
    // this is N separate decisions rather than one.
    expect(modal.body).toMatch(/2 CONTACTS?/);
    expect(modal.body).toMatch(/2 REQUESTS/);
    // Nothing has been asked for yet. Opening the question is not answering
    // it, and a select that wrote on change would have already written.
    expect(writes(mark())).toEqual([]);

    await app.page.fill('#typed-confirm-input', 'AUTO');
    await app.page.click('#typed-confirm-go');
    await app.page.waitForSelector(
      `#people-grid [data-key="${CARLA}"][data-mode="auto"]`,
      { timeout: 30_000 },
    );

    // One PUT per row, in the grid's order, and nothing else.
    expect(writes(mark())).toEqual([
      `PUT /v1/contacts/${encodeURIComponent(ALICE)}`,
      `PUT /v1/contacts/${encodeURIComponent(CARLA)}`,
    ]);
    expect(
      (await fixture.directClient.listContacts())
        .filter((c) => c.mode === 'auto')
        .map((c) => c.handle)
        .sort(),
    ).toEqual([ALICE, CARLA].sort());
    // BRUNO was not selected and was not touched.
    expect(
      (await fixture.directClient.listContacts()).find(
        (c) => c.handle === BRUNO,
      )?.mode,
    ).toBe('draft-only');
  }, 300_000);

  it('asks even when the selection is one row, and cancels on Escape', async () => {
    const fixture = await boot(async (f) => {
      await f.directClient.setContactPolicy(ALICE, 'draft-only', {
        displayName: 'Test User 1',
      });
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toPeople(app);
    await waitForPeopleRows(app, 1);

    await app.page.click(`.people-x[data-key="${ALICE}"]`);
    await app.page.waitForSelector('#people-bulk[data-count="1"]', {
      timeout: 15_000,
    });
    const mark = since(fixture);
    await app.page.selectOption('#people-bulk-mode', 'auto');
    // ONE row is still a bulk gesture, and the typed confirm is what makes
    // the gesture deliberate. Skipping it "because it is only one" is the
    // teeth mutation for this scenario.
    await app.page.waitForSelector('#typed-confirm', { timeout: 15_000 });
    expect(
      await app.page.evaluate(() =>
        document.querySelector('#typed-confirm')?.getAttribute('data-phrase'),
      ),
    ).toBe('AUTO');

    await app.page.keyboard.press('Escape');
    await app.page.waitForSelector('#typed-confirm', {
      state: 'detached',
      timeout: 15_000,
    });
    expect(writes(mark())).toEqual([]);
    expect((await fixture.directClient.listContacts())[0]?.mode).toBe(
      'draft-only',
    );
  }, 240_000);
});

/* ── row 7: the precedence footer, from the gate ──────────────────────── */

describe('s8 Sc12 row 7: the footer is the order the daemon actually uses', () => {
  it('splits the denies from the clamps and puts narrowing between them', async () => {
    const fixture = await boot();
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toPeople(app);
    await waitForPeopleRows(app, 0);

    const footer = (await readGrid(app)).precedence;
    // The plan's footer reads `KILL > DENY > window > rate cap > rule mode`.
    // That is wrong in the gate: `mode` is narrowed BEFORE the clamp chain
    // runs, and the chain has five clamps rather than two.
    expect(footer).toContain(
      'KILL > LINK > CONTACT DENY > GLOBAL > RULE > CONTACT > GROUP > WINDOW > RATE CAP > CIRCUIT > LOOP > SMS',
    );
    // …and it says WHO each half binds, which is the fact an operator needs
    // and the one the ordering alone does not carry.
    expect(footer).toMatch(/DENIES BIND EVERYONE/);
    expect(footer).toMatch(/CLAMPS BIND (ONLY )?AUTONOMY/);
  }, 180_000);
});

/* ── row 8: two thousand rows, and a window on them ───────────────────── */

describe('s8 Sc12 row 8: a large book of contacts is not a large document', () => {
  it('draws under a hundred rows for two thousand policies, and says so', async () => {
    const fixture = await boot(async (f) => {
      // Seeded through the STORE port rather than two thousand HTTP PUTs:
      // this row is about what the renderer draws, and two thousand round
      // trips would be measuring the daemon. The branded `Handle`/`IsoUtc`
      // casts are the same ones `rules.e2e.spec.ts` uses to plant a draft.
      const at = f.clock.now();
      const modes = ['auto', 'draft-only', 'deny'] as const;
      for (let i = 0; i < 2000; i += 1) {
        f.daemon.store.setContactPolicy({
          handle: `+1555${String(1_000_000 + i)}`,
          mode: modes[i % 3] ?? 'deny',
          updatedAt: at,
        } as never);
      }
      await Promise.resolve();
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toPeople(app);
    await waitForPeopleRows(app, 2000);

    const view = await readGrid(app);
    expect(view.total).toBe('2000');
    expect(view.rowCount).toBe('2000');
    expect(view.drawn).toBeLessThan(100);
    expect(view.drawn).toBeGreaterThan(0);
    // …and the screen SAYS it is showing a window rather than pretending
    // the book is this short.
    expect(view.more).toMatch(/2000/);
    expect(view.more).toMatch(/SEARCH/);

    // Narrowing reaches a row the window does not draw, which is what makes
    // the window usable rather than merely small.
    await app.page.fill('#people-search', '+15551001999');
    await app.page.waitForFunction(
      () =>
        document.querySelectorAll('#people-grid [role="row"][data-key]')
          .length === 1,
      undefined,
      { timeout: 15_000 },
    );
    expect((await readGrid(app)).rows[0]?.key).toBe('+15551001999');
  }, 300_000);
});

/* ── row 9: no green, on every surface this screen has ────────────────── */

describe('s8 Sc12 row 9: the policy column is where a green dot would go', () => {
  it('sweeps the grid, the scope pane and the confirm, in both schemes', async () => {
    const fixture = await boot(async (f) => {
      await f.directClient.setContactPolicy(ALICE, 'auto', {
        displayName: 'Test User 1',
      });
      await f.directClient.setContactPolicy(BRUNO, 'draft-only', {
        displayName: 'Test User 2',
      });
      await f.directClient.setContactPolicy(CARLA, 'deny');
      await f.directClient.createDraft({
        chatGuid: ROOM,
        body: 'the front desk will call you back',
        ttlMinutes: 480,
      });
    });
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toPeople(app);
    await waitForPeopleRows(app, 4);

    const sweep = async (): Promise<void> => {
      for (const scheme of ['dark', 'light'] as const) {
        await app.page.emulateMedia({ colorScheme: scheme });
        expect(await runtimeGreenOffenders(app.page)).toEqual([]);
      }
      await app.page.emulateMedia({ colorScheme: 'dark' });
    };

    await sweep();
    await app.page.click(`#people-grid [data-key="${ALICE}"] .people-handle`);
    await app.page.waitForSelector('#people-scope', { timeout: 15_000 });
    await sweep();
    await app.page.click(`.people-x[data-key="${BRUNO}"]`);
    await app.page.selectOption('#people-bulk-mode', 'auto');
    await app.page.waitForSelector('#typed-confirm', { timeout: 15_000 });
    await sweep();

    // Every state-bearing cell carries a WORD and a `data-state`, not just
    // a hue. Read back so a future stylesheet that dropped the glyph would
    // fail here rather than in a screenshot nobody reads.
    const modes = (await readGrid(app)).rows.map((r) => r.modeText);
    for (const cell of modes) expect(cell).not.toBe('');
  }, 300_000);
});

/* ── row 10: narrowing only, proved at the send port ──────────────────── */

describe('s8 Sc12 row 10: a contact row cannot widen what is above it', () => {
  it('drafts and does not send when AUTO at contact scope sits under draft-only', async () => {
    const fixture = await boot(async (f) => {
      // The global stays `draft-only` — §2.4.3's default and the shipped one.
      await f.directClient.createRule(rent());
    });
    const fake = await agent(fixture, ANSWER);
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toPeople(app);
    await waitForPeopleRows(app, 0);

    // Before anything is granted: the deny-all default is not a screen
    // state, it is a daemon behaviour. A matching message for a handle with
    // no policy row does not even reach the agent, because
    // `adapters/dispatch.ts` refuses on `contact-denied` before it builds a
    // frame. This is what makes row 2's empty-state sentence true.
    fixture.fixture.addMessage({
      chatId: fixture.ids.aliceChat,
      handleId: fixture.ids.alice,
      text: 'is the rent due friday?',
    });
    const denials = async (): Promise<string[]> =>
      (await fixture.directClient.listAudit({ event: 'gate.denied' })).map(
        (r) => String((JSON.parse(r.eventJson) as { reason?: unknown }).reason),
      );
    await expect
      .poll(async () => (await denials()).length, {
        timeout: 120_000,
        interval: 250,
      })
      .toBe(1);
    // The daemon's own word for it, and it is not `disconnected` or
    // `adapter-disabled`: the absence of a row IS the deny.
    expect(await denials()).toEqual(['contact-denied']);
    expect(fake.requests()).toEqual([]);
    expect(await fixture.directClient.listDrafts()).toEqual([]);

    // Now the operator does the widest thing this screen offers: AUTO, at
    // contact scope.
    await app.page.fill('#people-search', ALICE);
    await app.page.click('#people-add');
    await app.page.waitForSelector(`#people-grid [data-key="${ALICE}"]`, {
      timeout: 15_000,
    });
    await setMode(app, ALICE, 'auto');
    await app.page.waitForSelector(
      `#people-grid [data-key="${ALICE}"][data-mode="auto"]`,
      { timeout: 15_000 },
    );

    // The screen refuses to claim it worked: the ladder resolves to
    // DRAFT-ONLY and names the rung that took it.
    const scope = await readScope(app);
    expect(scope.effective).toBe('draft-only');
    expect(scope.narrowed).toBe('GLOBAL');
    expect(scope.sentence).toContain('AT MOST DRAFT-ONLY');

    // …and the daemon agrees, twice over. The agent is asked this time, and
    // what it is told is DRAFT-ONLY: the resolved mode, never the AUTO the
    // operator just chose.
    fixture.fixture.addMessage({
      chatId: fixture.ids.aliceChat,
      handleId: fixture.ids.alice,
      text: 'and when is the rent due in march?',
    });
    await expect
      .poll(() => fake.requests().length, { timeout: 120_000, interval: 250 })
      .toBe(1);
    expect(fake.requests()[0]?.respondMode).toBe('draft-only');
    await expect
      .poll(
        async () =>
          (await fixture.directClient.listDrafts({ state: 'pending' })).length,
        { timeout: 60_000, interval: 250 },
      )
      .toBe(1);
    // Nothing was auto-approved and nothing left the machine.
    expect(
      await fixture.directClient.listAudit({ event: 'auto.approved' }),
    ).toEqual([]);
    await fixture.daemon.tick();
    expect(fixture.loopback.callCount()).toBe(0);
  }, 300_000);

  it('and the SAME fixture auto-sends the moment the global rung allows it', async () => {
    const fixture = await boot(async (f) => {
      // The one difference from the row above.
      await f.directClient.setGlobalMode('auto');
      await f.directClient.setContactPolicy(ALICE, 'auto', {
        displayName: 'Test User 1',
      });
      await f.directClient.createRule(rent());
    });
    const fake = await agent(fixture, ANSWER);
    fixture.fixture.addMessage({
      chatId: fixture.ids.aliceChat,
      handleId: fixture.ids.alice,
      text: 'is the rent due friday?',
    });
    await expect
      .poll(() => fake.requests().length, { timeout: 120_000, interval: 250 })
      .toBe(1);
    // The SAME rule, the SAME contact row, one rung different, and the
    // resolved mode changed with it. That contrast is what makes the row
    // above an observation rather than a screen that always agrees.
    expect(fake.requests()[0]?.respondMode).toBe('auto');
    await expect
      .poll(
        async () =>
          (await fixture.directClient.listAudit({ event: 'auto.approved' }))
            .length,
        { timeout: 120_000, interval: 250 },
      )
      .toBe(1);
    fixture.clock.set(
      new Date(fixture.clock.nowMs() + 3_600_000).toISOString(),
    );
    await fixture.daemon.tick();
    await expect
      .poll(() => fixture.loopback.callCount(), { timeout: 60_000 })
      .toBe(1);
    expect(fixture.loopback.calls()[0]?.body).toBe(ANSWER);

    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toPeople(app);
    await waitForPeopleRows(app, 1);
    await app.page.click(`#people-grid [data-key="${ALICE}"] .people-handle`);
    await app.page.waitForSelector('#people-scope', { timeout: 15_000 });
    const scope = await readScope(app);
    expect(scope.effective).toBe('auto');
    expect(scope.narrowed).toBe('');
  }, 300_000);
});

/* ── row 11: the clamp binds the machine, never the person ────────────── */

describe('s8 Sc12 row 11: sms-auto-forbidden clamps autonomy and not a human', () => {
  it('withholds the auto-approval and still lets an operator approve and send', async () => {
    const fixture = await boot(async (f) => {
      await f.directClient.setGlobalMode('auto');
      await f.directClient.setContactPolicy(DIEGO, 'auto', {
        displayName: 'Test User 4',
      });
      await f.directClient.createRule(rent());
    });
    const fake = await agent(fixture, ANSWER);
    fixture.fixture.addMessage({
      chatId: fixture.ids.diegoChat,
      handleId: fixture.ids.diego,
      service: 'SMS',
      text: 'is the rent due friday?',
    });
    // Every rung says AUTO, and the agent is told DRAFT-ONLY anyway: the
    // clamp is applied at the draft moment and travels with the request.
    await expect
      .poll(() => fake.requests().length, { timeout: 120_000, interval: 250 })
      .toBe(1);
    expect(fake.requests()[0]?.respondMode).toBe('draft-only');
    await expect
      .poll(
        async () =>
          (await fixture.directClient.listDrafts({ state: 'pending' })).length,
        { timeout: 60_000, interval: 250 },
      )
      .toBe(1);
    // …and it was NOT auto-approved. `smsAutoForbidden` is the last branch
    // of §1.7's else-if chain, and `send.allowSmsAuto` has no owning route
    // in this slice, so there is no gesture anywhere that turns it off.
    expect(
      await fixture.directClient.listAudit({ event: 'auto.approved' }),
    ).toEqual([]);

    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toPeople(app);
    await waitForPeopleRows(app, 1);

    // The screen says WHY, on the row, and does not pretend AUTO took.
    const row = (await readGrid(app)).rows[0];
    expect(row?.service).toBe('sms');
    expect(row?.mode).toBe('auto');
    expect(row?.held).toBe('sms-auto-forbidden');
    expect(row?.autoText).toMatch(/SMS/);

    // …and the person is not blocked. Back to the queue, approve, and it
    // goes: `dispatchApproved` reads the clamp only inside its
    // `isAutoApproval` block.
    const id = (await fixture.directClient.listDrafts({ state: 'pending' }))[0]
      ?.id;
    await app.page.keyboard.press('Meta+Digit1');
    await app.page.waitForSelector('html[data-screen="queue"]', {
      timeout: 15_000,
    });
    await app.page.waitForSelector('html[data-store-rows="1"]', {
      timeout: 30_000,
    });
    await app.page.focus('#queue-list');
    await app.page.keyboard.press('a');
    await expect
      .poll(
        async () => (await fixture.directClient.getDraft(id ?? '')).draft.state,
        {
          timeout: 30_000,
        },
      )
      .toBe('approved');
    fixture.clock.set(
      new Date(fixture.clock.nowMs() + 3_600_000).toISOString(),
    );
    await fixture.daemon.tick();
    await expect
      .poll(() => fixture.loopback.callCount(), { timeout: 60_000 })
      .toBe(1);
    expect((await fixture.directClient.getDraft(id ?? '')).draft.state).toBe(
      'sent',
    );
  }, 300_000);
});

/* ── row 12: a policy edit is not a send path (INV-2) ─────────────────── */

describe('s8 Sc12 row 12: loosening a policy re-decides nothing already queued', () => {
  it('leaves a draft minted under the old policy exactly where it was', async () => {
    const fixture = await boot(async (f) => {
      await f.directClient.setGlobalMode('auto');
      await f.directClient.setContactPolicy(BRUNO, 'draft-only', {
        displayName: 'Test User 2',
      });
    });
    // A draft that already exists, minted while the policy said draft-only.
    const at = new Date(fixture.clock.nowMs() - 60_000).toISOString();
    fixture.daemon.store.insertDraft({
      id: '01HQ0000000000000000000PPL',
      inboundGuid: null,
      chatGuid: BRUNO_CHAT,
      ruleId: null,
      adapterId: 'agent-one',
      idempotencyKey: 'sc12-inflight-1',
      body: 'the answer under the old policy',
      originalBody: 'the answer under the old policy',
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
    await toPeople(app);
    await waitForPeopleRows(app, 1);

    // The screen SAYS it before anything is changed.
    await app.page.click(`#people-grid [data-key="${BRUNO}"] .people-handle`);
    await app.page.waitForSelector('#people-scope', { timeout: 15_000 });
    expect((await readScope(app)).sentence).toMatch(
      /ALREADY IN THE QUEUE|NOTHING ALREADY|NOT RE-?DECIDED/i,
    );

    const mark = since(fixture);
    await setMode(app, BRUNO, 'auto');
    await app.page.waitForSelector(
      `#people-grid [data-key="${BRUNO}"][data-mode="auto"]`,
      { timeout: 15_000 },
    );

    // One PUT. No approval, no dispatch, no send. Loosening a policy
    // changes what AUTONOMY may do NEXT and says nothing about work a human
    // has already been asked to decide.
    const asked = mark();
    expect(writes(asked)).toEqual([
      `PUT /v1/contacts/${encodeURIComponent(BRUNO)}`,
    ]);
    expect(asked.join('\n')).not.toMatch(/approve|dispatch/i);
    expect(fixture.loopback.calls()).toEqual([]);
    expect(
      (await fixture.directClient.getDraft('01HQ0000000000000000000PPL')).draft
        .state,
    ).toBe('pending');
    // …and over the WHOLE session, not just since the mark. This row was
    // written asserting that no request anywhere named an approval, and
    // that was factually wrong about the screen it is testing: the
    // AUTO-SENDS column is counted from `auto.approved` audit rows, so the
    // people binding READS a ledger whose event name contains the word. A
    // screen that reports past approvals cannot be stopped from spelling
    // one; what it must never do is issue one. So the claim is split, and
    // it is stronger than the original for it — every request in the
    // session that names an approval is enumerated, and every one of them
    // is a GET.
    const naming = urls(fixture).filter((u) => /approve|dispatch/i.test(u));
    expect(naming).not.toEqual([]);
    expect(writes(naming)).toEqual([]);
    expect([...new Set(naming)]).toEqual([
      'GET /v1/audit?event=auto.approved&limit=1000',
    ]);

    // …and still nothing after a tick, which is the moment a dispatcher
    // that had been handed an approval would act.
    await fixture.daemon.tick();
    expect(fixture.loopback.callCount()).toBe(0);
    expect(
      (await fixture.directClient.getDraft('01HQ0000000000000000000PPL')).draft
        .state,
    ).toBe('pending');
  }, 300_000);
});
