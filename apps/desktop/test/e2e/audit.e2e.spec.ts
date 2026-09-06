/**
 * s8 Sc13 — the audit screen, against a real daemon.
 *
 * This is the first surface in the product whose entire job is to be
 * BELIEVED, and the three ways it can fail are all ways of being subtly
 * unbelievable rather than visibly broken.
 *
 *  - **§1.8 becomes visible here.** "The log is the record, the event is the
 *    courtesy": every emit site in the daemon appends its audit row through
 *    `sink.append` BEFORE handing a frame to `sink.broadcast`. The finished
 *    log is IDENTICAL whichever order those two lines run in, so no
 *    assertion made after the fact can tell them apart — which is precisely
 *    why the ordering has never been proved at the wire. Row 1 proves it,
 *    through the seam the daemon declares for it (`startDaemon`'s
 *    `createAuditSink`), by reading the log from INSIDE `broadcast`. See
 *    `harness.ts`.
 *  - **The log is append-only and the UI may not imply otherwise.** There is
 *    no audit-mutating route: `packages/daemon/src/routes/audit.ts` registers
 *    `GET /v1/audit` and `GET /v1/audit/verify` and nothing else, and
 *    `packages/core/src/ports/index.ts` documents the absence as an API
 *    property of the Store rather than a convention. An arch row pins that
 *    absence so a later scenario cannot quietly add one; this file pins the
 *    consequence — the screen is a READER, and exercising all of it end to
 *    end issues zero writes of any kind (row 9, the INV-2 row).
 *  - **This screen is the highest-leak surface in the slice.** Audit rows
 *    carry message bodies (`draft.created` stores a whole `Draft`), handles
 *    and adapter identities. Row 8 proves no `wm_` token prefix can reach
 *    the document or the exported report, against a daemon that has really
 *    minted and really rotated one.
 *
 * Two plan defects are recorded in the rows rather than papered over:
 *
 *  1. `LOAD MORE` cannot page backwards. `listAudit`'s `sinceAt` is an
 *     INCLUSIVE LOWER bound (`at >= ?` in `packages/store/src/store.ts`) and
 *     the query is `ORDER BY seq DESC LIMIT ?`, so re-fetching with `since`
 *     set from the oldest loaded row returns the SAME page. The route
 *     exposes no upper bound at all (`since`, `event`, `limit` — an arch row
 *     pins exactly that). So the screen can only ever reach the newest 1 000
 *     rows per filter, `LOAD MORE` means "raise the limit to the route's
 *     cap", and once it is there the screen SAYS SO in words instead of
 *     offering a button that would do nothing.
 *  2. The `dialog` stub needs no flag. `WEMESSAGE_DESKTOP_TEST` grants no
 *     capability by design (`main/policy.ts`), and patching the electron
 *     module object from `electronApp.evaluate` reaches the real handler
 *     without production code learning it is under test.
 *
 * Synthetic handles (`+1555…`), synthetic adapter ids and synthetic bodies
 * only, as everywhere in this PUBLIC repo. No row below belongs to anybody.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditRowPayload } from '@wemessage/client';
import {
  bootFixtureDaemon,
  launchApp,
  waitForConnected,
  type FixtureDaemon,
  type LaunchedApp,
} from './harness.js';
import { runtimeGreenOffenders } from './no-green-runtime.js';

const ALICE = '+15550000001';
const ALICE_CHAT = `iMessage;-;${ALICE}`;

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

/**
 * A daemon whose clock starts where the wall clock is.
 *
 * The screen ages every row against an instant the RENDERER read, and the
 * harness's default is months in the past: every row would render as
 * "5000H AGO", which is true and useless. Time is still driven by hand from
 * here on (C-11).
 */
async function boot(before?: (f: Seeded) => Promise<void>): Promise<Seeded> {
  const ids = { alice: 0, aliceChat: 0 };
  const fixture = await bootFixtureDaemon({
    clockAt: new Date().toISOString(),
    seed: (f) => {
      ids.alice = f.addHandle(ALICE);
      ids.aliceChat = f.addChat({ identifier: ALICE, handleIds: [ids.alice] });
    },
  });
  running.push(fixture.stop);
  const seeded: Seeded = { ...fixture, ids };
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

/** `⌘5` — the audit screen. Navigation is a key; see the arch row. */
async function toAudit(app: LaunchedApp): Promise<void> {
  await app.page.keyboard.press('Meta+Digit5');
  await app.page.waitForSelector('html[data-screen="audit"]', {
    timeout: 15_000,
  });
  await app.page.waitForSelector('#audit[data-audit="ready"]', {
    timeout: 60_000,
  });
}

/**
 * Append `n` synthetic rows straight through the store's own writer.
 *
 * `appendAudit` is the ONLY way into `audit_log` and it hash-chains as it
 * goes, so a fixture built this way is a real chain that `verifyAuditChain`
 * really has to walk — not a table somebody filled in.
 */
function seedAudit(fixture: Seeded, n: number, at?: string): void {
  const stamp = at ?? fixture.clock.now();
  for (let i = 0; i < n; i++)
    fixture.daemon.store.appendAudit({
      at: stamp as never,
      eventJson: JSON.stringify({
        type: 'rule.matched',
        guid: `p:0:${String(i)}`,
        ruleId: `01HQ00000000000000000${String(i).padStart(5, '0')}`,
        adapterId: 'agent-one',
        ruleName: 'rent inquiry',
      }),
      actorJson: JSON.stringify({ kind: 'system', reason: 'rule-engine' }),
    });
}

interface TableView {
  readonly present: boolean;
  readonly status: string;
  readonly loaded: string;
  readonly drawn: number;
  readonly seqs: number[];
  readonly kinds: string[];
  readonly actors: string[];
  readonly denies: { reason: string; state: string; text: string }[];
  readonly window: string;
  readonly ceiling: string;
  readonly scope: string;
  readonly more: string;
  readonly empty: string;
  readonly none: string;
  readonly options: string[];
  readonly chips: { actor: string; state: string }[];
  readonly links: number;
  readonly tabIndexes: number;
}

async function readTable(app: LaunchedApp): Promise<TableView> {
  return app.page.evaluate(() => {
    const attr = (el: Element | null, name: string): string =>
      el?.getAttribute(name) ?? '';
    const text = (el: Element | null): string =>
      (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const rows = Array.from(
      document.querySelectorAll('#audit-table tr[data-seq]'),
    );
    return {
      present: document.querySelector('#audit-table') !== null,
      status: attr(document.querySelector('#audit'), 'data-audit'),
      loaded: attr(document.querySelector('#audit'), 'data-loaded'),
      drawn: rows.length,
      seqs: rows.map((r) => Number(attr(r, 'data-seq'))),
      kinds: rows.map((r) => text(r.querySelector('.audit-kind'))),
      actors: rows.map((r) => attr(r, 'data-actor')),
      denies: Array.from(document.querySelectorAll('.audit-deny')).map((d) => ({
        reason: attr(d, 'data-reason'),
        state: attr(d, 'data-state'),
        text: text(d),
      })),
      window: text(document.querySelector('#audit-window')),
      ceiling: text(document.querySelector('#audit-ceiling')),
      scope: text(document.querySelector('#audit-scope')),
      more: text(document.querySelector('#audit-more')),
      empty: text(document.querySelector('#audit-empty')),
      none: text(document.querySelector('#audit-none')),
      options: Array.from(document.querySelectorAll('#audit-event option')).map(
        (o) => (o as HTMLOptionElement).value,
      ),
      chips: Array.from(document.querySelectorAll('.audit-chip')).map((c) => ({
        actor: attr(c, 'data-actor'),
        state: attr(c, 'data-state'),
      })),
      links: document.querySelectorAll('a[href]').length,
      tabIndexes: document.querySelectorAll('[tabindex]').length,
    };
  });
}

interface DrawerView {
  readonly present: boolean;
  readonly seq: string;
  readonly title: string;
  readonly prev: string;
  readonly hash: string;
  readonly eventJson: string;
  readonly actorJson: string;
  readonly copied: string;
  readonly clampPx: number[];
  readonly viewport: number;
  readonly dialogs: number;
}

async function readDrawer(app: LaunchedApp): Promise<DrawerView> {
  return app.page.evaluate(() => {
    const attr = (el: Element | null, name: string): string =>
      el?.getAttribute(name) ?? '';
    const text = (el: Element | null): string =>
      (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const drawer = document.querySelector('#audit-drawer');
    return {
      present: drawer !== null,
      seq: attr(drawer, 'data-seq'),
      title: text(document.querySelector('#audit-drawer-title')),
      prev: text(document.querySelector('#audit-drawer-prev')),
      hash: text(document.querySelector('#audit-drawer-hash')),
      // RAW textContent, not normalised: the claim is that these are the
      // bytes the chain hashed, and collapsing whitespace here would erase
      // exactly the difference this row exists to catch.
      eventJson:
        document.querySelector('#audit-drawer-event')?.textContent ?? '',
      actorJson:
        document.querySelector('#audit-drawer-actor')?.textContent ?? '',
      copied: attr(document.querySelector('#audit-copy'), 'data-copied'),
      clampPx: Array.from(document.querySelectorAll('.audit-json')).map((el) =>
        Number.parseFloat(getComputedStyle(el).maxHeight),
      ),
      viewport: window.innerHeight,
      dialogs: document.querySelectorAll('[role="dialog"]').length,
    };
  });
}

interface VerifyView {
  readonly state: string;
  readonly verdict: string;
  readonly exportPresent: boolean;
  readonly exportNote: string;
}

async function readVerify(app: LaunchedApp): Promise<VerifyView> {
  return app.page.evaluate(() => {
    const attr = (el: Element | null, name: string): string =>
      el?.getAttribute(name) ?? '';
    const text = (el: Element | null): string =>
      (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    return {
      state: attr(document.querySelector('#audit-verdict'), 'data-verify'),
      verdict: text(document.querySelector('#audit-verdict')),
      exportPresent: document.querySelector('#audit-export') !== null,
      exportNote: text(document.querySelector('#audit-export-note')),
    };
  });
}

/* ── row 1: the log is the record, the event is the courtesy (§1.8) ───── */

describe('s8 Sc13 row 1: the row reaches the log before the frame reaches the wire', () => {
  it('has already appended the audit row at the instant it broadcasts', async () => {
    const fixture = await boot();
    // SELF-TRIP, recorded. `drafts.adapter_id` is a real FOREIGN KEY and
    // this file's `boot` seeds handles and chats but no adapters, so the
    // first version of this row was refused by the database before it ever
    // reached the daemon. The database was right; the test was wrong.
    await fixture.directClient.createAdapter({
      id: 'agent-one',
      kind: 'generic',
      displayName: 'agent one',
    });
    // A real act, driven from the GUI: a pending draft, approved with `A`.
    const at = fixture.clock.now();
    fixture.daemon.store.insertDraft({
      id: '01HQ0000000000000000000AU1',
      inboundGuid: null,
      chatGuid: ALICE_CHAT,
      ruleId: null,
      adapterId: 'agent-one',
      idempotencyKey: 'sc13-eighteen-1',
      body: 'the front desk will call you back',
      originalBody: 'the front desk will call you back',
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
    await app.page.focus('#queue-list');
    await app.page.keyboard.press('a', { delay: 60 });
    await expect
      .poll(
        async () =>
          (await fixture.directClient.getDraft('01HQ0000000000000000000AU1'))
            .draft.state,
        { timeout: 30_000 },
      )
      .toBe('approved');
    // …and through the undo grace to a real send, so the row covers two
    // emit sites in two different files rather than one.
    fixture.clock.set(
      new Date(fixture.clock.nowMs() + 3_600_000).toISOString(),
    );
    await fixture.daemon.tick();
    await expect
      .poll(() => fixture.loopback.callCount(), { timeout: 60_000 })
      .toBe(1);

    const seen = [...new Set(fixture.broadcasts.map((b) => b.event))];
    // Non-vacuity FIRST: a witness list that is empty, or that never saw
    // the acts this row is about, would satisfy every claim below.
    expect(seen).toContain('draft.approved');
    expect(seen).toContain('draft.sent');

    /**
     * The frame names that are ALSO audit-event types the daemon appends
     * under the same literal.
     *
     * Deliberately not "every frame", for two separate reasons, and the
     * distinction is the whole reason this list is written out by hand:
     *
     *  - `connection.state`, `adapter.health`, `gateway.disconnected` and
     *    `draft.delta` are derived facts about the host or an in-flight
     *    stream rather than decisions, and no audit row exists for them at
     *    all (`adapters/submit.ts` says so in as many words: "persists
     *    NOTHING and audits nothing"). §1.8 is a claim about the ORDER of
     *    the two when there ARE two, never that the two sets are equal, so
     *    a surjection row here would fail for design reasons.
     *  - `toggle.changed` is a frame whose name does NOT determine its row.
     *    `routes/toggles.ts` appends `toggle.changed`, but
     *    `routes/settings.ts` appends `setting.changed` and broadcasts the
     *    SAME `toggle.changed` frame for it, deliberately reusing the wire
     *    vocabulary for a settings write. Matching on the literal would
     *    therefore be checking the wrong thing, so it is excluded here and
     *    left to Sc14, which owns that route.
     */
    const PAIRED = [
      'draft.approved',
      'draft.created',
      'draft.expired',
      'draft.failed',
      'draft.recalled',
      'draft.rejected',
      'draft.requeued',
      'draft.sent',
      'draft.superseded',
      'gate.denied',
      'rule.matched',
    ];
    for (const witness of fixture.broadcasts) {
      if (!PAIRED.includes(witness.event)) continue;
      expect(
        witness.auditAtBroadcast,
        `${witness.event} broadcast with no row on disk`,
      ).toContain(witness.event);
    }
    // …and for the approval, the STRONGEST form available: its row was the
    // NEWEST row in the log at the instant the frame left. Nothing can sit
    // between the append and the broadcast, which is what makes swapping
    // the two lines in `routes/drafts.ts` a failure here.
    const approved = fixture.broadcasts.filter(
      (b) => b.event === 'draft.approved',
    );
    expect(approved).toHaveLength(1);
    expect(approved[0]?.auditAtBroadcast[0]).toBe('draft.approved');

    // …and the act, its row and its frame all agree on the screen.
    await toAudit(app);
    const table = await readTable(app);
    expect(table.kinds).toContain('draft.approved');
    expect(table.kinds).toContain('draft.sent');
    // The GUI approved it, so the actor on that row is a human at a GUI.
    const idx = table.kinds.indexOf('draft.approved');
    expect(table.actors[idx]).toBe('HUMAN');
  }, 300_000);
});

/* ── row 2: reverse chronological, windowed, and honest about the cap ─── */

describe('s8 Sc13 row 2: five thousand rows, fewer than a hundred nodes', () => {
  it('draws the newest first, in a window, and names the route`s ceiling', async () => {
    const fixture = await boot();
    seedAudit(fixture, 5_000);

    const app = await launch(fixture);
    await waitForConnected(app.page);
    const mark = since(fixture);
    await toAudit(app);

    const first = await readTable(app);
    // Read AFTER the screen has settled. Booting the daemon appends its own
    // rows (recovery, the capability probe), so a newest-seq snapshot taken
    // before launch is a different number than the one the screen fetched.
    const total = fixture.daemon.store.listAudit({ limit: 1 })[0]?.seq ?? 0;
    expect(total).toBeGreaterThanOrEqual(5_000);
    // ONE page, at the plan's limit, and no second one behind it.
    expect(mark().filter((u) => u.includes('/v1/audit'))).toEqual([
      'GET /v1/audit?limit=500',
    ]);
    expect(first.loaded).toBe('500');
    // The window. `<100` is the plan's number and the DOM is the judge.
    expect(first.drawn).toBeGreaterThan(0);
    expect(first.drawn).toBeLessThan(100);
    // Reverse chronological, strictly, and starting at the newest row the
    // daemon has rather than at the newest row of some page.
    expect(first.seqs[0]).toBe(total);
    for (let i = 1; i < first.seqs.length; i++)
      expect(first.seqs[i]).toBeLessThan(first.seqs[i - 1] as number);
    expect(first.window).toBe(
      `SHOWING ${String(first.drawn)} OF 500 LOADED ROWS`,
    );
    // No link, no hand-rolled tab stop, on the screen with the most rows.
    expect(first.links).toBe(0);
    expect(first.tabIndexes).toBe(0);

    // LOAD MORE raises the LIMIT — it cannot page backwards, because
    // `since` is an inclusive LOWER bound under `ORDER BY seq DESC` and the
    // route has no upper bound at all.
    const second = since(fixture);
    expect(first.more).toMatch(/LOAD MORE/);
    await app.page.click('#audit-more');
    await app.page.waitForSelector('#audit[data-loaded="1000"]', {
      timeout: 60_000,
    });
    expect(second().filter((u) => u.includes('/v1/audit'))).toEqual([
      'GET /v1/audit?limit=1000',
    ]);

    const third = await readTable(app);
    expect(third.drawn).toBeLessThan(100);
    expect(third.seqs[0]).toBe(total);
    // At the cap the button is GONE and the sentence is there instead. A
    // control that would re-fetch the same thousand rows is a control that
    // tells an auditor they have seen everything.
    expect(third.more).toBe('');
    expect(third.ceiling).toMatch(/NEWEST 1000/);
    expect(third.ceiling).toMatch(/NARROW/);
  }, 300_000);
});

/* ── row 3: one filter is the daemon's, the rest are ours, and it says ── */

describe('s8 Sc13 row 3: the filter bar says which side of the wire it is on', () => {
  it('filters the event type at the daemon and everything else here', async () => {
    const fixture = await boot();
    seedAudit(fixture, 40);
    await fixture.directClient.createRule({
      name: 'rent inquiry',
      matcher: { kind: 'keyword', keywords: ['rent'], mode: 'any' },
      adapterId: 'agent-one',
      respondMode: 'draft-only',
    });

    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toAudit(app);
    const loaded = (await readTable(app)).loaded;

    // The type list is built from the LOADED rows, so every option can
    // actually select something.
    const opened = await readTable(app);
    expect(opened.options[0]).toBe('');
    expect(opened.options).toContain('rule.matched');
    expect(opened.options).toContain('rule.created');

    // The event type is the DAEMON's filter: one request, with the param.
    const mark = since(fixture);
    await app.page.selectOption('#audit-event', 'rule.created');
    await app.page.waitForSelector('#audit[data-event="rule.created"]', {
      timeout: 30_000,
    });
    expect(mark().filter((u) => u.includes('/v1/audit'))).toEqual([
      'GET /v1/audit?event=rule.created&limit=500',
    ]);
    const filtered = await readTable(app);
    expect(filtered.loaded).toBe('1');
    expect(filtered.kinds).toEqual(['rule.created']);
    expect(Number(filtered.loaded)).toBeLessThan(Number(loaded));

    // …back to everything, then the CLIENT-SIDE half: an actor chip and a
    // free-text box, neither of which may cost a request.
    await app.page.selectOption('#audit-event', '');
    await app.page.waitForSelector('#audit[data-event=""]', {
      timeout: 30_000,
    });
    const quiet = since(fixture);
    await app.page.click('.audit-chip[data-actor="SYSTEM"]');
    await app.page.waitForSelector(
      '.audit-chip[data-actor="SYSTEM"][data-state="ON"]',
      {
        timeout: 15_000,
      },
    );
    const chipped = await readTable(app);
    expect(chipped.actors.every((a) => a === 'SYSTEM')).toBe(true);
    expect(chipped.scope).toBe(
      `CLIENT-SIDE OVER ${chipped.loaded} LOADED ROWS`,
    );

    await app.page.fill('#audit-search', 'rule.matched');
    await app.page.waitForSelector('#audit[data-search="rule.matched"]', {
      timeout: 15_000,
    });
    const searched = await readTable(app);
    expect(searched.kinds.every((k) => k === 'rule.matched')).toBe(true);
    // Not one request for either of them.
    expect(quiet()).toEqual([]);

    // The date range IS the daemon's, because `since` is a route param.
    await app.page.fill('#audit-search', '');
    await app.page.click('.audit-chip[data-actor="SYSTEM"]');
    const dated = since(fixture);
    const day = fixture.clock.now().slice(0, 10);
    await app.page.fill('#audit-since', day);
    await app.page.waitForSelector(`#audit[data-since="${day}"]`, {
      timeout: 30_000,
    });
    expect(dated().filter((u) => u.includes('/v1/audit'))).toEqual([
      `GET /v1/audit?since=${day}T00%3A00%3A00.000Z&limit=500`,
    ]);
  }, 300_000);
});

/* ── row 4: what you see is what was hashed ───────────────────────────── */

describe('s8 Sc13 row 4: the drawer shows the bytes, not a rendering of them', () => {
  it('renders the stored strings verbatim, clamped, with no modal role', async () => {
    const fixture = await boot();
    // A row whose JSON is deliberately NOT what `JSON.stringify` would
    // produce for the same value: reversed key order, extra spacing, an
    // escaped non-ascii. Every one of those survives storage and every one
    // of them would be destroyed by a parse-and-re-serialise.
    const awkward =
      '{"ruleName":"caf\\u00e9",  "type":"rule.matched","ruleId":"01HQ000AWK"}';
    fixture.daemon.store.appendAudit({
      at: fixture.clock.now() as never,
      eventJson: awkward,
      actorJson: '{"via":"gui","kind":"human"}',
    });
    const stored = fixture.daemon.store.listAudit({
      limit: 1,
    })[0] as AuditRowPayload;

    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toAudit(app);

    await app.page.click(`.audit-open[data-seq="${String(stored.seq)}"]`);
    await app.page.waitForSelector('#audit-drawer', { timeout: 15_000 });
    const drawer = await readDrawer(app);
    expect(drawer.title).toBe('WHAT YOU SEE IS WHAT WAS HASHED');
    expect(drawer.seq).toBe(String(stored.seq));
    expect(drawer.prev).toBe(stored.prevHash);
    expect(drawer.hash).toBe(stored.hash);
    // THE claim. Byte for byte, including the two spaces and the escape.
    expect(drawer.eventJson).toBe(awkward);
    expect(drawer.actorJson).toBe('{"via":"gui","kind":"human"}');
    // Non-vacuous: a re-serialised copy would differ, and does.
    expect(JSON.stringify(JSON.parse(awkward))).not.toBe(awkward);

    // 40vh, computed, in both panes.
    expect(drawer.clampPx).toHaveLength(2);
    for (const px of drawer.clampPx)
      expect(px).toBeCloseTo(drawer.viewport * 0.4, 0);

    // A drawer, not a dialog. `role="dialog"` has exactly one home in this
    // app (`components/TypedConfirm.tsx`) and an audit pane is not modal:
    // the table behind it stays readable and the keymap stays live.
    expect(drawer.dialogs).toBe(0);

    // COPY FULL JSON hands over the WHOLE row, and the two verbatim strings
    // survive the envelope.
    await app.page.click('#audit-copy');
    await app.page.waitForSelector(
      '#audit-copy[data-copied]:not([data-copied=""])',
      {
        timeout: 15_000,
      },
    );
    const copied = (await readDrawer(app)).copied;
    const parsed = JSON.parse(copied) as AuditRowPayload;
    expect(parsed.eventJson).toBe(awkward);
    expect(parsed.actorJson).toBe('{"via":"gui","kind":"human"}');
    expect(parsed.seq).toBe(stored.seq);
    expect(parsed.hash).toBe(stored.hash);
  }, 300_000);
});

/* ── row 5: VERIFY CHAIN asks once ────────────────────────────────────── */

describe('s8 Sc13 row 5: the verified card is an answer, never a default', () => {
  it('says nothing until asked, then asks exactly once', async () => {
    const fixture = await boot();
    seedAudit(fixture, 20);

    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toAudit(app);

    // Landing on the screen verifies NOTHING. A card that said "verified"
    // because nothing had gone wrong yet would be the one lie this screen
    // cannot survive.
    const before = await readVerify(app);
    expect(before.state).toBe('unknown');
    expect(before.verdict).toMatch(/NOT VERIFIED/);
    expect(before.exportPresent).toBe(false);

    const mark = since(fixture);
    // The chain's length is whatever it is at the moment it is asked, boot
    // rows included, so it is read here rather than before the app started.
    const length = fixture.daemon.store.listAudit({ limit: 1 })[0]?.seq ?? 0;
    await app.page.click('#audit-verify');
    await app.page.waitForSelector('#audit-verdict[data-verify="ok"]', {
      timeout: 60_000,
    });
    expect(mark().filter((u) => u.includes('/v1/audit'))).toEqual([
      'GET /v1/audit/verify',
    ]);
    const after = await readVerify(app);
    // Glyph AND uppercase word AND `data-verify`; colour carries nothing.
    expect(after.verdict).toContain('✓');
    expect(after.verdict).toContain('VERIFIED');
    expect(after.verdict).toContain(`${String(length)} ROWS`);
  }, 300_000);
});

/* ── row 6: the tamper, and the report ────────────────────────────────── */

describe('s8 Sc13 row 6: a doctored row is found, named, and exportable', () => {
  it('breaks at the seq that was edited and writes a report about it', async () => {
    const fixture = await boot();
    seedAudit(fixture, 12);
    // A row in the MIDDLE, chosen from the log as it actually is rather than
    // from a seq this test assumed: the daemon appends its own boot rows
    // ahead of the fixture's, so the seeded twelve do not start at 1.
    const rows = fixture.daemon.store.listAudit({ limit: 1000 });
    expect(rows.length).toBeGreaterThan(4);
    const target = rows[Math.floor(rows.length / 2)] as AuditRowPayload;
    const BROKEN = target.seq;
    const before = rows.find((r) => r.seq === BROKEN - 1) as AuditRowPayload;
    const after = rows.find((r) => r.seq === BROKEN + 1) as AuditRowPayload;
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    // The one sanctioned tamper: straight into the table, past the store's
    // append-only writer, exactly as `packages/store/test/audit-chain.spec.ts`
    // does it. The arch row that forbids raw writes to `audit_log` exempts
    // `test/` paths for this reason.
    fixture.daemon.store.db
      .prepare('UPDATE audit_log SET event = ? WHERE seq = ?')
      .run('{"type":"rule.matched","ruleId":"DOCTORED"}', BROKEN);

    const report = join(fixture.configDir, 'audit-report.json');
    const app = await launch(fixture);
    await app.app.evaluate((electron, target2: string) => {
      // The electron module OBJECT is patched, not a destructured copy, so
      // the production handler's `dialog.showSaveDialog(...)` reaches this.
      // `WEMESSAGE_DESKTOP_TEST` is not consulted anywhere in that path:
      // the flag grants no capability, by design.
      (
        electron.dialog as unknown as {
          showSaveDialog: () => Promise<{
            canceled: boolean;
            filePath: string;
          }>;
        }
      ).showSaveDialog = () =>
        Promise.resolve({ canceled: false, filePath: target2 });
    }, report);
    await waitForConnected(app.page);
    await toAudit(app);

    await app.page.click('#audit-verify');
    await app.page.waitForSelector('#audit-verdict[data-verify="broken"]', {
      timeout: 60_000,
    });
    const verdict = await readVerify(app);
    expect(verdict.verdict).toContain(`CHAIN BREAK AT SEQ ${String(BROKEN)}`);
    expect(verdict.verdict).toContain('HASH-MISMATCH');
    expect(verdict.exportPresent).toBe(true);

    // The doctored row is still DRAWN, and drawn honestly: its event column
    // no longer parses to anything this screen recognises, and the screen
    // that exists to show you the damage may not be the screen that breaks
    // when there is some.
    const table = await readTable(app);
    expect(table.seqs).toContain(BROKEN);

    // EXPORT REPORT: no daemon traffic at all, and a file on disk.
    const quiet = since(fixture);
    await app.page.click('#audit-export');
    await app.page.waitForSelector(
      '#audit-export-note[data-export="written"]',
      {
        timeout: 30_000,
      },
    );
    expect(quiet()).toEqual([]);

    const written = JSON.parse(readFileSync(report, 'utf8')) as {
      verify: { ok: boolean; brokenAtSeq: number; reason: string };
      broken: AuditRowPayload | null;
      before: AuditRowPayload | null;
      after: AuditRowPayload | null;
      probedAt: string;
      appVersion: string;
    };
    expect(written.verify.ok).toBe(false);
    expect(written.verify.brokenAtSeq).toBe(BROKEN);
    expect(written.verify.reason).toBe('hash-mismatch');
    expect(written.broken?.seq).toBe(BROKEN);
    expect(written.before?.seq).toBe(before.seq);
    expect(written.after?.seq).toBe(after.seq);
    // The predecessor and successor are what makes the report checkable by
    // somebody who does not have the database: the chain is re-derivable
    // across the break from these three rows alone.
    expect(written.broken?.prevHash).toBe(before.hash);
    expect(written.after?.prevHash).toBe(target.hash);
    expect(written.probedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(written.appVersion).not.toBe('');
    // The one substring that must never be in a file the operator will mail
    // to somebody. Row 8 proves the screen honours the same rule.
    expect(readFileSync(report, 'utf8')).not.toContain('wm_');

    // The screen names the FILE and not the path: main returns a basename,
    // so an absolute home path never crosses the bridge into a document.
    expect(verdictName(await readVerify(app))).toBe('audit-report.json');
  }, 300_000);
});

function verdictName(view: VerifyView): string {
  const m = /([A-Za-z0-9._-]+\.json)/.exec(view.exportNote);
  return m?.[1] ?? '';
}

/* ── row 7: the closed deny taxonomy, and the thirteenth reason ───────── */

describe('s8 Sc13 row 7: a deny reason it has never heard of is still drawn', () => {
  it('chips the twelve, and renders a stranger under the ? glyph', async () => {
    const fixture = await boot();
    const at = fixture.clock.now();
    fixture.daemon.store.appendAudit({
      at: at as never,
      eventJson: JSON.stringify({
        type: 'gate.denied',
        guid: 'p:0:1',
        reason: 'contact-denied',
      }),
      actorJson: JSON.stringify({ kind: 'system', reason: 'rule-engine' }),
    });
    // A reason from a daemon newer than this build. It is not in §1.6's
    // twelve and it is not invented here either: the screen shows the
    // literal, under a glyph that says it does not know the word.
    fixture.daemon.store.appendAudit({
      at: at as never,
      eventJson: JSON.stringify({
        type: 'gate.denied',
        guid: 'p:0:2',
        reason: 'quarantined',
      }),
      actorJson: JSON.stringify({ kind: 'system', reason: 'rule-engine' }),
    });

    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toAudit(app);
    const table = await readTable(app);
    const known = table.denies.find((d) => d.reason === 'contact-denied');
    const stranger = table.denies.find((d) => d.reason === 'quarantined');
    expect(known?.state).toBe('KNOWN');
    expect(known?.text).toContain('CONTACT-DENIED');
    expect(stranger?.state).toBe('UNKNOWN');
    expect(stranger?.text).toContain('QUARANTINED');
    expect(stranger?.text).toContain('?');
    // …and nothing crashed on the way: the screen is still live.
    expect(table.status).toBe('ready');
  }, 300_000);
});

/* ── row 8: nothing green, no token, and two kinds of nothing ─────────── */

describe('s8 Sc13 row 8: an empty log, an empty filter, no green and no token', () => {
  it('tells the two emptinesses apart', async () => {
    const fixture = await boot();
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toAudit(app);

    const bare = await readTable(app);
    if (bare.loaded === '0') {
      // The log itself is empty: a statement about the DAEMON.
      expect(bare.empty).not.toBe('');
      expect(bare.none).toBe('');
    }
    // A filter that matches nothing is a statement about the FILTER, and
    // this one is reachable whatever the daemon logged on the way up.
    await app.page.fill('#audit-search', 'nothing-matches-this-string');
    await app.page.waitForSelector(
      '#audit[data-search="nothing-matches-this-string"]',
      {
        timeout: 15_000,
      },
    );
    const none = await readTable(app);
    expect(none.drawn).toBe(0);
    expect(none.none).not.toBe('');
    expect(none.empty).toBe('');
    expect(none.none).not.toBe(bare.empty);
  }, 300_000);

  it('lets no adapter token reach the document, verified card included', async () => {
    const fixture = await boot();
    const made = await fixture.directClient.createAdapter({
      id: 'agent-one',
      kind: 'generic',
      displayName: 'agent one',
    });
    const rotated = await fixture.directClient.rotateAdapterToken('agent-one');
    // Non-vacuity: the daemon really did mint the shape we are banning.
    expect(made.token.startsWith('wm_')).toBe(true);
    expect(rotated.token.startsWith('wm_')).toBe(true);

    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toAudit(app);
    await app.page.click('#audit-verify');
    await app.page.waitForSelector('#audit-verdict[data-verify="ok"]', {
      timeout: 60_000,
    });
    // Every row's drawer, opened, so the raw JSON is really on screen.
    const seqs = (await readTable(app)).seqs;
    expect(seqs.length).toBeGreaterThan(0);
    for (const seq of seqs) {
      await app.page.click(`.audit-open[data-seq="${String(seq)}"]`);
      await app.page.waitForSelector(
        `#audit-drawer[data-seq="${String(seq)}"]`,
        {
          timeout: 15_000,
        },
      );
      await app.page.click('#audit-copy');
    }
    const html = await app.page.evaluate(
      () => document.documentElement.outerHTML,
    );
    // Attributes included, which is where the copy buffer lives.
    expect(html).not.toContain('wm_');
    expect(html).not.toContain(made.token);
    expect(html).not.toContain(rotated.token);

    // …and no green anywhere on it, verified card and all.
    expect(await runtimeGreenOffenders(app.page)).toEqual([]);
  }, 300_000);
});

/* ── row 9: the screen is a reader (INV-2) ────────────────────────────── */

describe('s8 Sc13 row 9: reading the log dispatches, approves and mutates nothing', () => {
  it('leaves every draft where it was, having exercised the whole screen', async () => {
    const fixture = await boot();
    // The same foreign key as row 1: an adapter has to exist before a draft
    // can name one.
    await fixture.directClient.createAdapter({
      id: 'agent-one',
      kind: 'generic',
      displayName: 'agent one',
    });
    const at = fixture.clock.now();
    fixture.daemon.store.insertDraft({
      id: '01HQ0000000000000000000AU2',
      inboundGuid: null,
      chatGuid: ALICE_CHAT,
      ruleId: null,
      adapterId: 'agent-one',
      idempotencyKey: 'sc13-readonly-1',
      body: 'the answer nobody asked this screen about',
      originalBody: 'the answer nobody asked this screen about',
      state: 'pending',
      stateChangedAt: at as never,
      expiresAt: new Date(
        fixture.clock.nowMs() + 3_600_000,
      ).toISOString() as never,
      createdAt: at as never,
    } as never);
    seedAudit(fixture, 30);
    // One row whose TYPE names an approval, so the enumeration below has
    // something real to enumerate.
    fixture.daemon.store.appendAudit({
      at: at as never,
      eventJson: JSON.stringify({
        type: 'auto.approved',
        draftId: '01HQ0000000000000000000AU3',
        approvalId: '01HQ0000000000000000000AU4',
      }),
      actorJson: JSON.stringify({ kind: 'system', reason: 'auto-respond' }),
    });

    const app = await launch(fixture);
    await waitForConnected(app.page);
    await app.page.waitForSelector('html[data-store-rows="1"]', {
      timeout: 30_000,
    });
    const mark = since(fixture);
    await toAudit(app);

    // The WHOLE screen, in one pass.
    await app.page.selectOption('#audit-event', 'auto.approved');
    await app.page.waitForSelector('#audit[data-event="auto.approved"]', {
      timeout: 30_000,
    });
    await app.page.selectOption('#audit-event', '');
    await app.page.waitForSelector('#audit[data-event=""]', {
      timeout: 30_000,
    });
    await app.page.click('.audit-chip[data-actor="SYSTEM"]');
    await app.page.fill('#audit-search', 'rule');
    await app.page.fill('#audit-search', '');
    await app.page.click('.audit-chip[data-actor="SYSTEM"]');
    await app.page.click('#audit-verify');
    await app.page.waitForSelector('#audit-verdict[data-verify="ok"]', {
      timeout: 60_000,
    });
    const seq = (await readTable(app)).seqs[0] as number;
    await app.page.click(`.audit-open[data-seq="${String(seq)}"]`);
    await app.page.waitForSelector('#audit-drawer', { timeout: 15_000 });
    await app.page.click('#audit-copy');

    const asked = mark();
    expect(asked).not.toEqual([]);
    expect(writes(asked)).toEqual([]);

    // Sc12's shape, not a blanket ban: a reader may legitimately NAME an
    // approval in a URL, and a ban that a legitimate reader has to be
    // exempted from is the wrong ban. So every request in the session that
    // names one is enumerated, and every one of them is a GET.
    const naming = urls(fixture).filter((u) => /approve|dispatch/i.test(u));
    expect(naming).not.toEqual([]);
    expect(writes(naming)).toEqual([]);
    expect([...new Set(naming)]).toEqual([
      'GET /v1/audit?event=auto.approved&limit=500',
    ]);

    // Nothing crossed the send port, and the draft is exactly where it was.
    expect(fixture.loopback.calls()).toEqual([]);
    expect(
      (await fixture.directClient.getDraft('01HQ0000000000000000000AU2')).draft
        .state,
    ).toBe('pending');
    // …and still nothing after a tick, which is the moment a dispatcher
    // that had been handed an approval would act.
    await fixture.daemon.tick();
    expect(fixture.loopback.callCount()).toBe(0);
    expect(
      (await fixture.directClient.getDraft('01HQ0000000000000000000AU2')).draft
        .state,
    ).toBe('pending');
  }, 300_000);
});
