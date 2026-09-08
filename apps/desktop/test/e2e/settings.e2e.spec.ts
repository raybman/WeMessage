/**
 * s8 Sc14 — settings, the kill switch, the Permissions pane and the danger
 * zone, against a real daemon.
 *
 * Five sub-surfaces on one screen, four of which carry a distinct way to do
 * real harm. Each of the four is pinned here by the harm rather than by the
 * markup, because markup is the part that will legitimately change:
 *
 *  - **The kill switch is a DENY, not a clamp.** `evaluateGate` answers
 *    `kill-switch` before it computes `clampedBy`, so the switch binds the
 *    OPERATOR and not merely autonomy. Row 2 proves that at the wire: a
 *    human presses `A` on a pending draft and the daemon answers 403. The
 *    screen has to say so in words, which is what `#kill-note` is asserted
 *    for — a control that reads "pauses automatic replies" would be a lie
 *    about a switch that also refuses the person reading it.
 *  - **Turning it OFF flushes nothing.** `routes/toggles.ts` states it in
 *    source ("Resume means 'new work may flow again', not 'replay whatever
 *    I just halted'"), and row 2's second half proves the GUI inherits it:
 *    the draft that was refused is still `pending` after the switch comes
 *    back on and after a `tick()`, and the send port has never been called.
 *  - **A freshly minted adapter token must not survive being dismissed, and
 *    must not cross the bridge at all.** Row 6 rotates a real token and then
 *    runs Sc4's runtime sweep (DOM, both storages, every performance entry,
 *    every string-valued `window` property) against the real plaintext AND
 *    against the `wm_` prefix — before dismissal, after dismissal, and after
 *    a re-navigation. The secret is delivered to the OS clipboard BY MAIN;
 *    the renderer is handed a receipt naming an environment variable, never
 *    the value. `connectCmd` puts the token in argv (`--token <token>`) and
 *    argv is world-readable through `ps`, so the GUI has no "copy connect
 *    command" affordance at all: the receipt's run line is asserted to name
 *    `WEMESSAGE_ADAPTER_TOKEN` and to contain no token.
 *  - **The danger zone is irreversible.** `POST /v1/disconnect` clears every
 *    adapter token, rotates the daemon's own bearer and closes every event
 *    client. There is exactly one destructive act on this screen, it is
 *    behind a typed confirm with a live count, and `purge` is not offered:
 *    it deletes the config directory, and the audit-log database is in it.
 *    Sc13 pinned that no audit-mutating route exists; a settings screen that
 *    reached for one would be the contradiction, not the fix.
 *
 * The Permissions pane cannot grant anything and does not pretend to. macOS
 * TCC is not programmatically grantable, so the pane REPORTS `GET /v1/doctor`
 * and its remedy is `openSystemSettings`, which takes a pane KEY off a closed
 * allowlist in main and never a URL. `evaluateDoctor` SHORT-CIRCUITS — an
 * fda failure returns two checks and never probes automation or messages —
 * so "absent from `checks`" is a real state the daemon produces and the pane
 * renders it as NOT CHECKED. Row 7 also breaks the probe itself: a doctor
 * call that THROWS leaves all four cards NOT CHECKED, because a check that
 * never ran is not a check that passed.
 *
 * Synthetic everything, as everywhere in this PUBLIC repo: `+1555…` handles,
 * synthetic adapter ids, synthetic bodies. The only real token in this file
 * is one the fixture daemon minted for itself seconds earlier, and it is
 * read to be BANNED, never to be asserted present.
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

const ALICE = '+15550000001';
const ALICE_CHAT = `iMessage;-;${ALICE}`;
/** The one adapter every row that needs a foreign key names. */
const AGENT = 'agent-one';
/** The `echo` adapter, which the screen must label as a dev loopback. */
const ECHO = 'echo-dev';

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
 * The pointer table ages `arming.pauseUntil` against an instant the RENDERER
 * read once, and the harness's default clock is months in the past: every
 * horizon would render as long expired, which is true and useless. Time is
 * still driven by hand from here on (C-11).
 */
async function boot(options?: {
  probes?: BootOptions['probes'];
}): Promise<Seeded> {
  const ids = { alice: 0, aliceChat: 0 };
  const fixture = await bootFixtureDaemon({
    clockAt: new Date().toISOString(),
    ...(options?.probes === undefined ? {} : { probes: options.probes }),
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

/** `⌘6` — the settings screen. Navigation is a key; see the arch row. */
async function toSettings(app: LaunchedApp): Promise<void> {
  await app.page.keyboard.press('Meta+Digit6');
  await app.page.waitForSelector('html[data-screen="settings"]', {
    timeout: 15_000,
  });
  await app.page.waitForSelector('#settings[data-settings="ready"]', {
    timeout: 60_000,
  });
}

/** `⌘1` — back to the queue, which is where an approval can be attempted. */
async function toQueue(app: LaunchedApp): Promise<void> {
  await app.page.keyboard.press('Meta+Digit1');
  await app.page.waitForSelector('html[data-screen="queue"]', {
    timeout: 15_000,
  });
}

/** An adapter, minted through the OTHER terminal so the tee stays clean. */
async function seedAdapter(
  fixture: Seeded,
  id: string,
  kind: 'generic' | 'echo',
): Promise<string> {
  const made = await fixture.directClient.createAdapter({
    id,
    kind,
    displayName: id,
  });
  return made.token;
}

/** A pending draft the kill switch can refuse. Needs an adapter to exist. */
function seedDraft(fixture: Seeded, id: string, key: string): void {
  const at = fixture.clock.now();
  fixture.daemon.store.insertDraft({
    id,
    inboundGuid: null,
    chatGuid: ALICE_CHAT,
    ruleId: null,
    adapterId: AGENT,
    idempotencyKey: key,
    body: 'the front desk will call you back',
    originalBody: 'the front desk will call you back',
    state: 'pending',
    stateChangedAt: at as never,
    expiresAt: new Date(fixture.clock.nowMs() + 3_600_000).toISOString(),
    createdAt: at as never,
  } as never);
}

/* ── readers ──────────────────────────────────────────────────────────── */

interface KillView {
  readonly state: string;
  readonly word: string;
  readonly glyph: string;
  readonly note: string;
  readonly next: string;
  readonly horizon: string;
  readonly horizonArmed: string;
  readonly banner: string;
  readonly toggleDisabled: string;
}

async function readKill(app: LaunchedApp): Promise<KillView> {
  return app.page.evaluate(() => {
    const attr = (el: Element | null, name: string): string =>
      el?.getAttribute(name) ?? '';
    const text = (el: Element | null): string =>
      (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const state = document.querySelector('#kill-state');
    return {
      state: attr(state, 'data-kill'),
      word: text(state),
      glyph: text(document.querySelector('#kill-glyph')),
      note: text(document.querySelector('#kill-note')),
      next: attr(document.querySelector('#kill-toggle'), 'data-next'),
      horizon: text(document.querySelector('#kill-horizon')),
      horizonArmed: attr(document.querySelector('#kill-horizon'), 'data-armed'),
      banner: text(document.querySelector('#kill-banner')),
      toggleDisabled: attr(
        document.querySelector('#kill-toggle'),
        'aria-disabled',
      ),
    };
  });
}

interface FormView {
  readonly mode: string;
  readonly loaded: string;
  readonly dirty: string;
  readonly saveDisabled: string;
  readonly fields: {
    key: string;
    group: string;
    label: string;
    value: string;
    dimmed: string;
    inputs: number;
  }[];
  readonly issues: { key: string; text: string }[];
  readonly pointers: { key: string; use: string; value: string }[];
  readonly pointerInputs: number;
  readonly links: number;
  readonly tabIndexes: number;
}

async function readForm(app: LaunchedApp): Promise<FormView> {
  return app.page.evaluate(() => {
    const attr = (el: Element | null, name: string): string =>
      el?.getAttribute(name) ?? '';
    const text = (el: Element | null): string =>
      (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const fields = Array.from(document.querySelectorAll('.set-field'));
    const pointers = Array.from(document.querySelectorAll('.set-pointer'));
    return {
      mode: attr(document.querySelector('#mode'), 'data-mode'),
      loaded: text(document.querySelector('#set-loaded')),
      dirty: attr(document.querySelector('#set-dirty'), 'data-dirty'),
      saveDisabled: attr(document.querySelector('#set-save'), 'aria-disabled'),
      fields: fields.map((f) => {
        const input = f.querySelector('.set-input');
        return {
          key: attr(f, 'data-key'),
          group: attr(f, 'data-group'),
          label: text(f.querySelector('.set-label')),
          value: input === null ? '' : (input as HTMLInputElement).value,
          dimmed: attr(f, 'aria-disabled'),
          inputs: f.querySelectorAll('input, select, textarea').length,
        };
      }),
      issues: Array.from(document.querySelectorAll('.set-issue')).map((i) => ({
        key: attr(i, 'data-key'),
        text: text(i),
      })),
      pointers: pointers.map((p) => ({
        key: attr(p, 'data-key'),
        use: text(p.querySelector('.set-use')),
        value: text(p.querySelector('.set-value')),
      })),
      pointerInputs: pointers.reduce(
        (n, p) => n + p.querySelectorAll('input, select, textarea').length,
        0,
      ),
      links: document.querySelectorAll('a[href]').length,
      tabIndexes: document.querySelectorAll('[tabindex]').length,
    };
  });
}

interface PermsView {
  readonly probed: string;
  readonly cards: {
    check: string;
    state: string;
    glyph: string;
    word: string;
    detail: string;
    pane: string | null;
  }[];
}

async function readPerms(app: LaunchedApp): Promise<PermsView> {
  return app.page.evaluate(() => {
    const attr = (el: Element | null, name: string): string =>
      el?.getAttribute(name) ?? '';
    const text = (el: Element | null): string =>
      (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    return {
      probed: text(document.querySelector('#perms-probed')),
      cards: Array.from(document.querySelectorAll('.perm-card')).map((c) => {
        const grant = c.querySelector('.perm-grant');
        return {
          check: attr(c, 'data-check'),
          state: attr(c, 'data-state'),
          glyph: text(c.querySelector('.perm-glyph')),
          word: text(c.querySelector('.perm-word')),
          detail: text(c.querySelector('.perm-detail')),
          pane: grant === null ? null : attr(grant, 'data-pane'),
        };
      }),
    };
  });
}

interface AdapterView {
  readonly rows: {
    id: string;
    health: string;
    glyph: string;
    word: string;
    token: string;
    dev: string;
    note: string;
  }[];
  readonly armFor: string;
  readonly receiptFor: string;
  readonly delivered: string;
  readonly variable: string;
  readonly run: string;
  readonly note: string;
}

async function readAdapters(app: LaunchedApp): Promise<AdapterView> {
  return app.page.evaluate(() => {
    const attr = (el: Element | null, name: string): string =>
      el?.getAttribute(name) ?? '';
    const text = (el: Element | null): string =>
      (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    return {
      rows: Array.from(document.querySelectorAll('.adp-row')).map((r) => ({
        id: attr(r, 'data-adapter'),
        health: attr(r, 'data-health'),
        glyph: text(r.querySelector('.adp-glyph')),
        word: text(r.querySelector('.adp-word')),
        token: text(r.querySelector('.adp-token')),
        dev: attr(r, 'data-dev'),
        note: text(r.querySelector('.adp-note')),
      })),
      armFor: attr(document.querySelector('#adp-arm'), 'data-adapter'),
      receiptFor: attr(document.querySelector('#adp-receipt'), 'data-adapter'),
      delivered: attr(document.querySelector('#adp-receipt'), 'data-delivered'),
      variable: text(document.querySelector('#adp-receipt-var')),
      run: text(document.querySelector('#adp-receipt-run')),
      note: text(document.querySelector('#adp-receipt-note')),
    };
  });
}

interface DangerView {
  readonly counts: string;
  readonly bullets: string[];
  readonly steps: { step: string; state: string; text: string }[];
  readonly manual: string[];
  readonly reportPresent: boolean;
}

async function readDanger(app: LaunchedApp): Promise<DangerView> {
  return app.page.evaluate(() => {
    const attr = (el: Element | null, name: string): string =>
      el?.getAttribute(name) ?? '';
    const text = (el: Element | null): string =>
      (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    return {
      counts: text(document.querySelector('#danger-counts')),
      bullets: Array.from(document.querySelectorAll('.danger-bullet')).map(
        (b) => text(b),
      ),
      steps: Array.from(document.querySelectorAll('.danger-step')).map((s) => ({
        step: attr(s, 'data-step'),
        state: attr(s, 'data-state'),
        text: text(s),
      })),
      manual: Array.from(document.querySelectorAll('.danger-manual')).map((m) =>
        text(m),
      ),
      reportPresent: document.querySelector('#danger-report') !== null,
    };
  });
}

/**
 * Sc4's runtime sweep, aimed at a needle of this scenario's choosing.
 *
 * Verbatim in shape from `shell.e2e.spec.ts` row 5 rather than imported,
 * because that row inlines it: DOM (attributes included, which is where a
 * `data-token` would hide), both web storages by key AND by value, every
 * performance entry name, and every string-valued property on `window`.
 * A GUI that mints a secret is precisely where this invariant dies, so it
 * is re-run here against the real plaintext instead of only the prefix.
 */
async function sweepFor(app: LaunchedApp, needle: string): Promise<string[]> {
  return app.page.evaluate((probe: string) => {
    const found: string[] = [];
    if (document.documentElement.outerHTML.includes(probe)) found.push('dom');
    for (const store of ['localStorage', 'sessionStorage']) {
      const s = (window as unknown as Record<string, Storage>)[
        store
      ] as Storage;
      for (let i = 0; i < s.length; i += 1) {
        const key = s.key(i);
        if (key === null) continue;
        if (key.includes(probe) || (s.getItem(key) ?? '').includes(probe))
          found.push(store);
      }
    }
    for (const entry of performance.getEntries())
      if (entry.name.includes(probe)) found.push(`perf:${entry.name}`);
    for (const key of Object.keys(window)) {
      const value = (window as unknown as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.includes(probe))
        found.push(`window.${key}`);
    }
    return found;
  }, needle);
}

/* ── row 1: the switch is first, and the strip follows the EVENT ──────── */

describe('s8 Sc14 row 1: the kill switch is the first thing on the screen', () => {
  it('flips on the daemon’s event, from this window and from another', async () => {
    const fixture = await boot();
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await app.page.waitForSelector('#state-strip[data-outbound="armed"]', {
      timeout: 30_000,
    });
    await toSettings(app);

    const armed = await readKill(app);
    expect(armed.state).toBe('armed');
    expect(armed.word).toContain('OUTBOUND: ARMED');
    expect(armed.next).toBe('on');

    const mark = since(fixture);
    await app.page.click('#kill-toggle');
    await app.page.waitForSelector('#kill-state[data-kill="killed"]', {
      timeout: 30_000,
    });
    // Exactly one write, and it is the route the schema names as the owner
    // of `send.killSwitch`. Not `PATCH /v1/settings`: that key is read-only
    // and the daemon would refuse it with `read-only-key`.
    expect(writes(mark())).toEqual(['POST /v1/toggles/kill-switch']);

    const killed = await readKill(app);
    expect(killed.word).toContain('OUTBOUND: KILLED');
    expect(killed.next).toBe('off');
    expect(killed.glyph).toBe('⊘');
    // The page-wide banner, not a chip on one pane: nothing sends.
    expect(killed.banner).toContain('⊘');
    expect(killed.banner).toContain('NOTHING SENDS');
    // And the strip, which reads the daemon's own arming word.
    await app.page.waitForSelector(
      '#state-strip[data-outbound="kill-switch"]',
      {
        timeout: 30_000,
      },
    );

    // The click is not what flips the strip: the EVENT is. Proved by taking
    // the click away entirely — another terminal turns it off and this
    // window follows, which an optimistic local flag could not do.
    await fixture.directClient.setKillSwitch(false);
    await app.page.waitForSelector('#kill-state[data-kill="armed"]', {
      timeout: 30_000,
    });
    await app.page.waitForSelector('#state-strip[data-outbound="armed"]', {
      timeout: 30_000,
    });
    expect((await readKill(app)).banner).toBe('');
  }, 300_000);
});

/* ── row 2: a DENY, not a clamp — and OFF flushes nothing ─────────────── */

describe('s8 Sc14 row 2: the kill switch refuses the operator too', () => {
  it('denies a human approval at the wire, and releases nothing on the way back', async () => {
    const fixture = await boot();
    await seedAdapter(fixture, AGENT, 'generic');
    seedDraft(fixture, '01HQ00000000000000000SC14A', 'sc14-kill-1');

    const app = await launch(fixture);
    await waitForConnected(app.page);
    await app.page.waitForSelector('html[data-store-rows="1"]', {
      timeout: 30_000,
    });
    await toSettings(app);

    // The words matter as much as the wire. A note that only mentions
    // automatic replies would describe a CLAMP, and this is a DENY.
    const note = (await readKill(app)).note;
    expect(note).toContain('APPROVAL');
    expect(note.toUpperCase()).toContain('REFUSED');

    await app.page.click('#kill-toggle');
    await app.page.waitForSelector('#kill-state[data-kill="killed"]', {
      timeout: 30_000,
    });
    await app.page.waitForSelector(
      '#state-strip[data-outbound="kill-switch"]',
      {
        timeout: 30_000,
      },
    );

    await toQueue(app);
    // Focus the listbox first, the way Sc7's `press` helper and Sc11's
    // approval both do: the keymap is delegated from the list, and a key
    // pressed while `document.body` has focus is a key nobody hears.
    await app.page.focus('#queue-list');
    await app.page.keyboard.press('a', { delay: 60 });
    await app.page.waitForSelector(
      '[data-draft="01HQ00000000000000000SC14A"] .card-badge',
      { timeout: 30_000 },
    );
    const badges = await app.page.evaluate(() =>
      Array.from(
        document.querySelectorAll(
          '[data-draft="01HQ00000000000000000SC14A"] .card-badge',
        ),
      ).map((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim()),
    );
    expect(badges).toContain('DENIED: KILL-SWITCH');
    // A human really did ask, and the daemon really did refuse.
    expect(
      urls(fixture).filter((u) =>
        u.includes('/v1/drafts/01HQ00000000000000000SC14A/approve'),
      ),
    ).toHaveLength(1);
    expect(
      (await fixture.directClient.getDraft('01HQ00000000000000000SC14A')).draft
        .state,
    ).toBe('pending');
    expect(fixture.loopback.calls()).toEqual([]);

    // OFF releases nothing. `routes/toggles.ts` says so in source; this is
    // the GUI half of the same claim.
    await toSettings(app);
    await app.page.click('#kill-toggle');
    await app.page.waitForSelector('#kill-state[data-kill="armed"]', {
      timeout: 30_000,
    });
    await fixture.daemon.tick();
    expect(fixture.loopback.callCount()).toBe(0);
    expect(
      (await fixture.directClient.getDraft('01HQ00000000000000000SC14A')).draft
        .state,
    ).toBe('pending');
  }, 300_000);
});

/* ── row 3: no fade, in either direction (the teeth target) ───────────── */

describe('s8 Sc14 row 3: the kill control flips instantly, by design', () => {
  it('animates in neither direction', async () => {
    const fixture = await boot();
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toSettings(app);

    const motion = async (): Promise<Record<string, string[]>> =>
      app.page.evaluate(() => {
        const out: Record<string, string[]> = {};
        for (const id of ['kill-toggle', 'kill-state', 'kill-glyph']) {
          const el = document.getElementById(id);
          if (el === null) {
            out[id] = ['missing'];
            continue;
          }
          const s = getComputedStyle(el);
          out[id] = [s.transitionDuration, s.animationName];
        }
        return out;
      });

    const before = await motion();
    await app.page.click('#kill-toggle');
    await app.page.waitForSelector('#kill-state[data-kill="killed"]', {
      timeout: 30_000,
    });
    const after = await motion();
    await app.page.click('#kill-toggle');
    await app.page.waitForSelector('#kill-state[data-kill="armed"]', {
      timeout: 30_000,
    });
    const back = await motion();

    for (const snapshot of [before, after, back])
      for (const [id, [duration, animation]] of Object.entries(snapshot)) {
        expect([id, duration]).toEqual([id, '0s']);
        expect([id, animation]).toEqual([id, 'none']);
      }
  }, 300_000);
});

/* ── row 4: GLOBAL MODE, and AUTO asks ────────────────────────────────── */

describe('s8 Sc14 row 4: turning autonomy on for everyone is typed, not clicked', () => {
  it('opens the one dialog for AUTO and writes nothing until the phrase matches', async () => {
    const fixture = await boot();
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toSettings(app);
    expect((await readForm(app)).mode).toBe('draft-only');

    const mark = since(fixture);
    await app.page.click('#mode-auto');
    await app.page.waitForSelector('#typed-confirm[data-phrase="AUTO"]', {
      timeout: 15_000,
    });
    // Not one request. The confirm is the gate, not a courtesy after it.
    expect(writes(mark())).toEqual([]);
    // …and it is the one owner of `role="dialog"` in the whole renderer.
    expect(
      await app.page.evaluate(
        () => document.querySelectorAll('[role="dialog"]').length,
      ),
    ).toBe(1);

    // `TypedConfirm` publishes `yes`/`no`, not `true`/`false`. SELF-TRIP:
    // this row was written against an invented vocabulary; the component is
    // right and the row was wrong, so the row is corrected to assert the
    // NEGATIVE word exactly rather than merely "not armed", which a typo in
    // the attribute name would also have satisfied.
    await app.page.fill('#typed-confirm-input', 'auto');
    expect(await app.page.getAttribute('#typed-confirm', 'data-armed')).toBe(
      'no',
    );
    await app.page.fill('#typed-confirm-input', 'AUTO');
    await app.page.waitForSelector('#typed-confirm[data-armed="yes"]', {
      timeout: 15_000,
    });
    await app.page.click('#typed-confirm-go');
    await app.page.waitForSelector('#mode[data-mode="auto"]', {
      timeout: 30_000,
    });
    expect(writes(mark())).toEqual(['POST /v1/toggles/global-mode']);

    // Back is not dangerous, so back does not ask.
    const back = since(fixture);
    await app.page.click('#mode-draft-only');
    await app.page.waitForSelector('#mode[data-mode="draft-only"]', {
      timeout: 30_000,
    });
    expect(writes(back())).toEqual(['POST /v1/toggles/global-mode']);
    expect(
      await app.page.evaluate(
        () => document.querySelectorAll('[role="dialog"]').length,
      ),
    ).toBe(0);
  }, 300_000);
});

/* ── row 5: the form is total, writes only deltas, quotes the refusal ─── */

describe('s8 Sc14 row 5: the settings form is the daemon’s list, in the daemon’s words', () => {
  it('renders eleven writable keys and four pointers, and writes only what moved', async () => {
    const fixture = await boot();
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toSettings(app);

    const initial = await readForm(app);
    expect(initial.fields).toHaveLength(11);
    expect(initial.pointers).toHaveLength(4);
    // A read-only key gets a POINTER, never an input: the daemon owns it
    // through a route, and a box the operator can type in would be a
    // promise this screen cannot keep.
    expect(initial.pointerInputs).toBe(0);
    expect(initial.pointers.map((p) => p.key).sort()).toEqual([
      'arming.pauseUntil',
      'send.circuitOpenedAt',
      'send.globalMode',
      'send.killSwitch',
    ]);
    const pause = initial.pointers.find((p) => p.key === 'arming.pauseUntil');
    expect(pause?.use).toContain('POST /v1/toggles/pause');
    // Every field has exactly one control, and no screen in this app has a
    // link or a hand-rolled tab stop.
    for (const field of initial.fields) {
      expect([field.key, field.inputs]).toEqual([field.key, 1]);
      expect([field.key, field.label]).toEqual([
        field.key,
        field.label.toUpperCase(),
      ]);
    }
    expect(initial.links).toBe(0);
    expect(initial.tabIndexes).toBe(0);
    expect(initial.dirty).toBe('false');
    expect(initial.saveDisabled).toBe('true');

    // A clean save is not a quiet request; it is no request.
    //
    // Dispatched rather than clicked, and the difference is the assertion.
    // Playwright's actionability treats `aria-disabled="true"` as disabled
    // and would simply refuse to click — which would prove that the SCREEN
    // discourages the gesture, not that the HANDLER refuses it. Every
    // control on this screen is `aria-disabled` and never `disabled`,
    // because a `disabled` button is unreachable by a screen reader's
    // caret; so the gesture really can land, and what must be true is that
    // when it lands on a clean form it puts nothing on the wire. This
    // dispatches a real click on the real element and asserts exactly that.
    const idle = since(fixture);
    await app.page.dispatchEvent('#set-save', 'click');
    expect(idle()).toEqual([]);

    // One edit, one key on the wire.
    const before = await fixture.directClient.settings();
    await app.page.fill('.set-input[data-key="send.undoGraceSeconds"]', '25');
    await app.page.waitForSelector('#set-dirty[data-dirty="true"]', {
      timeout: 15_000,
    });
    const mark = since(fixture);
    await app.page.click('#set-save');
    await app.page.waitForSelector('#set-dirty[data-dirty="false"]', {
      timeout: 30_000,
    });
    expect(writes(mark())).toEqual(['PATCH /v1/settings']);
    const after = await fixture.directClient.settings();
    const moved = Object.keys(after).filter(
      (k) => after[k]?.version !== before[k]?.version,
    );
    expect(moved).toEqual(['send.undoGraceSeconds']);
    expect(after['send.undoGraceSeconds']?.value).toBe(25);
  }, 300_000);

  it('renders the daemon’s own refusal next to the field it names', async () => {
    const fixture = await boot();
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toSettings(app);

    const before = await fixture.directClient.settings();
    // Below the floor. The floor is the DAEMON's (`CAP_FLOOR = 1`); the
    // screen hardcodes none, so this sentence has to come back over the
    // wire in the refusal's own datum.
    await app.page.fill('.set-input[data-key="send.capContactPerHour"]', '0');
    await app.page.waitForSelector('#set-dirty[data-dirty="true"]', {
      timeout: 15_000,
    });
    await app.page.click('#set-save');
    await app.page.waitForSelector(
      '.set-issue[data-key="send.capContactPerHour"]',
      { timeout: 30_000 },
    );
    const issues = (await readForm(app)).issues;
    const issue = issues.find((i) => i.key === 'send.capContactPerHour');
    expect(issue?.text).toContain('BELOW-FLOOR');
    expect(issue?.text).toContain('1');
    // Exactly one complaint, and it is attached to a field that exists.
    expect(issues).toHaveLength(1);
    expect(
      (await readForm(app)).fields.some(
        (f) => f.key === 'send.capContactPerHour',
      ),
    ).toBe(true);
    // And the daemon did not move.
    const after = await fixture.directClient.settings();
    expect(after['send.capContactPerHour']?.version).toBe(
      before['send.capContactPerHour']?.version,
    );
  }, 300_000);
});

/* ── row 6: the adapters table, and a token that never crosses ────────── */

describe('s8 Sc14 row 6: a minted token is shown once and is not recoverable', () => {
  it('never puts the secret in the renderer, in a command line, or in the log', async () => {
    const fixture = await boot();
    await seedAdapter(fixture, AGENT, 'generic');
    await seedAdapter(fixture, ECHO, 'echo');

    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toSettings(app);

    const table = await readAdapters(app);
    expect(table.rows.map((r) => r.id).sort()).toEqual([AGENT, ECHO]);
    const agent = table.rows.find((r) => r.id === AGENT);
    // Colour is never the sole carrier: glyph AND uppercase word AND attr.
    expect(agent?.glyph).not.toBe('');
    expect(agent?.word).toBe(agent?.word.toUpperCase());
    expect(agent?.word).not.toBe('');
    expect(agent?.health).not.toBe('');
    // `hasToken` is a boolean on the wire, and it renders as one.
    expect(agent?.token).toBe('SET');
    const echo = table.rows.find((r) => r.id === ECHO);
    expect(echo?.dev).toBe('true');
    expect(echo?.note.toUpperCase()).toContain('NEVER SENDS');

    // ROTATE is a two-step disclosure, not a fourth typed confirm and not a
    // second modal: `role="dialog"` has one owner in this renderer.
    const mark = since(fixture);
    await app.page.click(`.adp-rotate[data-adapter="${AGENT}"]`);
    await app.page.waitForSelector(`#adp-arm[data-adapter="${AGENT}"]`, {
      timeout: 15_000,
    });
    expect(writes(mark())).toEqual([]);
    expect(
      await app.page.evaluate(
        () => document.querySelectorAll('[role="dialog"]').length,
      ),
    ).toBe(0);

    await app.page.click('#adp-arm-go');
    await app.page.waitForSelector(`#adp-receipt[data-adapter="${AGENT}"]`, {
      timeout: 30_000,
    });
    // The route is `POST /v1/adapters/:id/token` — checked against
    // `transport-surface.snapshot.ts` rather than remembered. Asserted as
    // the WHOLE write list and again as an exact count, because a mint that
    // fired twice would leave the clipboard holding the second token while
    // the receipt on screen describes the first, and a set comparison would
    // not see it.
    const minted = writes(mark());
    expect(minted).toEqual([`POST /v1/adapters/${AGENT}/token`]);
    expect(
      minted.filter((u) => u === `POST /v1/adapters/${AGENT}/token`),
    ).toHaveLength(1);

    // Where the secret actually went: main's clipboard, and nowhere else.
    const clip = await app.app.evaluate(({ clipboard }) =>
      clipboard.readText(),
    );
    expect(clip.startsWith('wm_')).toBe(true);
    expect(clip).toHaveLength(67);

    const receipt = await readAdapters(app);
    expect(receipt.delivered).toBe('clipboard');
    // The run line names the ENVIRONMENT VARIABLE, never the value. argv is
    // world-readable through `ps`, which is why there is no connect command
    // on this screen at all.
    expect(receipt.variable).toBe('WEMESSAGE_ADAPTER_TOKEN');
    expect(receipt.run).toContain('WEMESSAGE_ADAPTER_TOKEN');
    expect(receipt.run).not.toContain('--token');
    expect(receipt.run).not.toContain(clip);
    expect(receipt.note.toUpperCase()).toContain('NOT SHOWN AGAIN');

    // The sweep, while the receipt is still on screen. The token is not in
    // the document because it never reached this process.
    expect(await sweepFor(app, clip)).toEqual([]);
    expect(await sweepFor(app, 'wm_')).toEqual([]);

    // Dismissed, and still gone — including from the bridge's own answers.
    await app.page.click('#adp-dismiss');
    await app.page.waitForSelector('#adp-receipt', {
      state: 'detached',
      timeout: 15_000,
    });
    expect(await sweepFor(app, clip)).toEqual([]);
    await toQueue(app);
    await toSettings(app);
    expect(await sweepFor(app, clip)).toEqual([]);
    expect(await sweepFor(app, 'wm_')).toEqual([]);

    // Nor did it reach the audit log, which the daemon writes for a
    // rotation. Read through the OTHER terminal so the app is not the one
    // being asked.
    const log = await fixture.directClient.listAudit({ limit: 200 });
    expect(JSON.stringify(log)).not.toContain(clip);
    expect(JSON.stringify(log)).not.toContain('wm_');
    // Non-vacuity: the rotation really is in the log.
    expect(JSON.stringify(log)).toContain('adapter');
  }, 300_000);
});

/* ── row 7: the Permissions pane reports, and cannot grant ────────────── */

describe('s8 Sc14 row 7: the Permissions pane tells the truth about four things', () => {
  it('renders the doctor’s own remediation and offers only a System Settings pane', async () => {
    // FDA cannot reach the daemon: `evaluateDoctor` short-circuits after
    // `fda`, so `automation` and `messages` are ABSENT from `checks` — a
    // state the daemon really produces and the pane must not paint over.
    const fixture = await boot({
      probes: { fda: () => Promise.resolve('eperm') },
    });
    await fixture.directClient.doctor();

    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toSettings(app);

    const view = await readPerms(app);
    expect(view.cards.map((c) => c.check)).toEqual([
      'os',
      'fda',
      'automation',
      'messages',
    ]);
    const byId = Object.fromEntries(view.cards.map((c) => [c.check, c]));
    expect(byId['os']?.state).toBe('OK');
    expect(byId['fda']?.state).toBe('FAIL');
    // The two the daemon never reached. "Not granted" and "not yet checked"
    // are different sentences and this is the second one.
    expect(byId['automation']?.state).toBe('NOT CHECKED');
    expect(byId['messages']?.state).toBe('NOT CHECKED');
    // Glyph AND uppercase word AND data-state, never colour alone.
    for (const card of view.cards) {
      expect([card.check, card.glyph]).not.toEqual([card.check, '']);
      expect([card.check, card.word]).toEqual([
        card.check,
        card.word.toUpperCase(),
      ]);
      expect([card.check, card.word]).not.toEqual([card.check, '']);
    }
    // The daemon's own remediation, verbatim, not a paraphrase.
    expect(byId['fda']?.detail).toContain(
      'Full Disk Access is not reaching the daemon',
    );
    // The remedy is a PANE KEY off main's closed allowlist, never a URL and
    // never a grant: macOS TCC is not programmatically grantable.
    expect(byId['fda']?.pane).toBe('fullDisk');
    expect(byId['os']?.pane).toBeNull();
    expect(byId['messages']?.pane).toBeNull();

    // RE-RUN is one GET, and it really re-reads: the probe is repaired and
    // the pane changes its mind.
    fixture.probes.fda = () => Promise.resolve('ok');
    const mark = since(fixture);
    await app.page.click('#perms-rerun');
    await app.page.waitForSelector(
      '.perm-card[data-check="fda"][data-state="OK"]',
      {
        timeout: 30_000,
      },
    );
    expect(mark().filter((u) => u.includes('/v1/doctor'))).toEqual([
      'GET /v1/doctor',
    ]);
    expect(writes(mark())).toEqual([]);
    const healthy = await readPerms(app);
    expect(healthy.cards.map((c) => c.state)).toEqual(['OK', 'OK', 'OK', 'OK']);
  }, 300_000);

  it('says NOT CHECKED, never OK, when the check itself throws', async () => {
    const fixture = await boot();
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toSettings(app);
    expect((await readPerms(app)).cards.map((c) => c.state)).toEqual([
      'OK',
      'OK',
      'OK',
      'OK',
    ]);

    // The probe explodes: `runDoctor` awaits it, the route answers 500 and
    // the channel rejects. A pane that rendered its last good answer, or a
    // blank that reads as fine, would be Sc12's blank policy column again.
    fixture.probes.automation = () =>
      Promise.reject(new Error('probe-exploded'));
    await app.page.click('#perms-rerun');
    await app.page.waitForSelector(
      '.perm-card[data-check="os"][data-state="NOT CHECKED"]',
      { timeout: 30_000 },
    );
    const view = await readPerms(app);
    expect(view.cards.map((c) => c.state)).toEqual([
      'NOT CHECKED',
      'NOT CHECKED',
      'NOT CHECKED',
      'NOT CHECKED',
    ]);
    expect(view.probed.toUpperCase()).toContain('NOT CHECKED');
    // Not one card offers a remedy for a check nobody ran.
    expect(view.cards.filter((c) => c.pane !== null)).toEqual([]);
  }, 300_000);
});

/* ── row 8: the danger zone ───────────────────────────────────────────── */

describe('s8 Sc14 row 8: disconnect is typed, counted and irreversible', () => {
  it('names what it destroys, refuses until the phrase matches, and renders the report', async () => {
    const fixture = await boot();
    await seedAdapter(fixture, AGENT, 'generic');
    await seedAdapter(fixture, ECHO, 'echo');
    seedDraft(fixture, '01HQ00000000000000000SC14D', 'sc14-danger-1');

    const app = await launch(fixture);
    await waitForConnected(app.page);
    await app.page.waitForSelector('html[data-store-rows="1"]', {
      timeout: 30_000,
    });
    await toSettings(app);

    // A live count, not a sentence about "your data". Both numbers come
    // from the daemon; neither is a guess.
    const counts = (await readDanger(app)).counts;
    expect(counts).toContain('2');
    expect(counts).toContain('1');
    expect(counts.toUpperCase()).toContain('ADAPTER');
    expect(counts.toUpperCase()).toContain('DRAFT');

    const mark = since(fixture);
    await app.page.click('#danger-disconnect');
    await app.page.waitForSelector('#typed-confirm[data-phrase="DISCONNECT"]', {
      timeout: 15_000,
    });
    const armedView = await readDanger(app);
    expect(armedView.bullets).toHaveLength(5);
    expect(writes(mark())).toEqual([]);

    // Esc cancels, and cancel is the default.
    await app.page.keyboard.press('Escape');
    await app.page.waitForSelector('#typed-confirm', {
      state: 'detached',
      timeout: 15_000,
    });
    expect(writes(mark())).toEqual([]);

    // Return cancels too — a stray Return on a modal must not destroy.
    await app.page.click('#danger-disconnect');
    await app.page.waitForSelector('#typed-confirm[data-phrase="DISCONNECT"]', {
      timeout: 15_000,
    });
    await app.page.keyboard.press('Enter');
    await app.page.waitForSelector('#typed-confirm', {
      state: 'detached',
      timeout: 15_000,
    });
    expect(writes(mark())).toEqual([]);

    await app.page.click('#danger-disconnect');
    await app.page.waitForSelector('#typed-confirm[data-phrase="DISCONNECT"]', {
      timeout: 15_000,
    });
    await app.page.fill('#typed-confirm-input', 'DISCONNECT');
    await app.page.waitForSelector('#typed-confirm[data-armed="yes"]', {
      timeout: 15_000,
    });
    await app.page.click('#typed-confirm-go');
    await app.page.waitForSelector('#danger-report', { timeout: 60_000 });

    // One write, and NO `purge`: the config directory holds the audit-log
    // database, and Sc13 pinned that no route may mutate that log.
    expect(writes(mark())).toEqual(['POST /v1/disconnect']);
    const report = await readDanger(app);
    expect(report.steps.map((s) => s.step)).toEqual([
      'watcher-stop',
      'state',
      'adapter-tokens',
      'token-rotation',
      'launchd-unload',
      'purge',
    ]);
    const purge = report.steps.find((s) => s.step === 'purge');
    expect(purge?.state).toBe('SKIPPED');
    expect(purge?.text).toContain('purge not requested');
    const tokens = report.steps.find((s) => s.step === 'adapter-tokens');
    expect(tokens?.text).toContain('revoked 2 adapter token(s)');
    // `manualRevocation` verbatim: the two things a disconnect cannot do.
    expect(report.manual).toHaveLength(2);
    expect(report.manual.join(' ')).toContain('tccutil reset AppleEvents');

    // And the honest consequence, said out loud. `POST /v1/disconnect`
    // rotates the daemon's OWN bearer and closes every event client, and
    // main read its credential once at boot: this window is now holding a
    // dead token and cannot reconnect itself.
    // SELF-TRIP: this row first waited on `html[data-reason]`, an attribute
    // this app has never written. `data-conn` is on `<html>`; the REASON is
    // published by the setup card, which is the surface that has to say it.
    // Strengthened rather than dropped: both are asserted, so a window that
    // went down without saying why still fails here.
    await app.page.waitForSelector('html[data-conn="down"]', {
      timeout: 120_000,
    });
    await app.page.waitForSelector(
      '#daemon-not-found[data-reason="token-rejected"]',
      { timeout: 120_000 },
    );
    expect(fixture.loopback.calls()).toEqual([]);
  }, 300_000);

  it('offers no purge and no way to touch the log', async () => {
    const fixture = await boot();
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toSettings(app);
    const text = await app.page.evaluate(
      () => document.getElementById('settings')?.textContent ?? '',
    );
    expect(text.toLowerCase()).not.toContain('purge');
    expect(text.toLowerCase()).not.toContain('delete the log');
    // Exactly one destructive control on the screen, and it is the one
    // above. A second would need its own confirm and its own count.
    const destructive = await app.page.evaluate(() =>
      Array.from(document.querySelectorAll('#set-danger button')).map(
        (b) => b.id,
      ),
    );
    expect(destructive).toEqual(['danger-disconnect']);
  }, 300_000);
});

/* ── row 9: read-only dims the send controls, never the kill switch ───── */

describe('s8 Sc14 row 9: a read-only daemon dims what it cannot honour', () => {
  it('marks the send fields aria-disabled and leaves the kill switch alone', async () => {
    const fixture = await boot({
      probes: { fda: () => Promise.resolve('enoent') },
    });
    await fixture.directClient.doctor();

    const app = await launch(fixture);
    await waitForConnected(app.page);
    await app.page.waitForSelector('#state-strip[data-outbound="read-only"]', {
      timeout: 30_000,
    });
    await toSettings(app);

    const form = await readForm(app);
    // Every send-related field says so to assistive technology, not just to
    // the eye. §1.7: colour is never the sole carrier.
    const send = form.fields.filter((f) => f.key.startsWith('send.'));
    expect(send).toHaveLength(11);
    for (const field of send)
      expect([field.key, field.dimmed]).toEqual([field.key, 'true']);

    // The kill switch stays live. It is moot while the daemon is read-only,
    // and it is exactly the control an operator reaches for when they are
    // not sure — a disabled one would be the app refusing to be turned off.
    const kill = await readKill(app);
    expect(kill.toggleDisabled).not.toBe('true');
    await app.page.click('#kill-toggle');
    await app.page.waitForSelector('#kill-state[data-kill="killed"]', {
      timeout: 30_000,
    });
  }, 300_000);
});

/* ── row 10: the LLM endpoint is a card, not a form (F-112) ───────────── */

describe('s8 Sc14 row 10: the LLM endpoint says "not in v1" and offers nothing', () => {
  it('has no input, no select and no textarea, and no Keychain anywhere near it', async () => {
    const fixture = await boot();
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toSettings(app);

    const card = await app.page.evaluate(() => {
      const el = document.getElementById('set-endpoint');
      return {
        present: el !== null,
        controls: el?.querySelectorAll('input, select, textarea, button')
          .length,
        text: (el?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      };
    });
    expect(card.present).toBe(true);
    expect(card.controls).toBe(0);
    expect(card.text.toUpperCase()).toContain('NOT IN V1');
  }, 300_000);
});

/* ── row 11: nothing green, in every variant ──────────────────────────── */

describe('s8 Sc14 row 11: no green on any variant of this screen', () => {
  it('stays inside the palette armed, killed, refused and reported', async () => {
    const fixture = await boot();
    await seedAdapter(fixture, AGENT, 'generic');
    const app = await launch(fixture);
    await waitForConnected(app.page);
    await toSettings(app);
    expect(await runtimeGreenOffenders(app.page)).toEqual([]);

    await app.page.click('#kill-toggle');
    await app.page.waitForSelector('#kill-state[data-kill="killed"]', {
      timeout: 30_000,
    });
    expect(await runtimeGreenOffenders(app.page)).toEqual([]);

    await app.page.fill('.set-input[data-key="send.capContactPerHour"]', '0');
    await app.page.click('#set-save');
    await app.page.waitForSelector(
      '.set-issue[data-key="send.capContactPerHour"]',
      { timeout: 30_000 },
    );
    expect(await runtimeGreenOffenders(app.page)).toEqual([]);

    await app.page.click(`.adp-rotate[data-adapter="${AGENT}"]`);
    await app.page.waitForSelector(`#adp-arm[data-adapter="${AGENT}"]`, {
      timeout: 15_000,
    });
    await app.page.click('#adp-arm-go');
    await app.page.waitForSelector(`#adp-receipt[data-adapter="${AGENT}"]`, {
      timeout: 30_000,
    });
    expect(await runtimeGreenOffenders(app.page)).toEqual([]);

    await app.page.click('#danger-disconnect');
    await app.page.waitForSelector('#typed-confirm[data-phrase="DISCONNECT"]', {
      timeout: 15_000,
    });
    expect(await runtimeGreenOffenders(app.page)).toEqual([]);
  }, 300_000);
});

/* ── row 12: INV-2 over the whole screen ──────────────────────────────── */

describe('s8 Sc14 row 12: settings dispatches nothing and approves nothing', () => {
  it('leaves the draft exactly where it started, having driven every pane', async () => {
    const fixture = await boot();
    await seedAdapter(fixture, AGENT, 'generic');
    seedDraft(fixture, '01HQ00000000000000000SC14I', 'sc14-inv2-1');

    const app = await launch(fixture);
    await waitForConnected(app.page);
    await app.page.waitForSelector('html[data-store-rows="1"]', {
      timeout: 30_000,
    });
    const mark = since(fixture);
    await toSettings(app);

    // Every pane, in one pass, under the OLD configuration and then the new.
    await app.page.click('#kill-toggle');
    await app.page.waitForSelector('#kill-state[data-kill="killed"]', {
      timeout: 30_000,
    });
    await app.page.click('#kill-toggle');
    await app.page.waitForSelector('#kill-state[data-kill="armed"]', {
      timeout: 30_000,
    });
    await app.page.click('#mode-auto');
    await app.page.waitForSelector('#typed-confirm[data-phrase="AUTO"]', {
      timeout: 15_000,
    });
    await app.page.fill('#typed-confirm-input', 'AUTO');
    await app.page.click('#typed-confirm-go');
    await app.page.waitForSelector('#mode[data-mode="auto"]', {
      timeout: 30_000,
    });
    await app.page.fill('.set-input[data-key="send.undoGraceSeconds"]', '17');
    await app.page.click('#set-save');
    await app.page.waitForSelector('#set-dirty[data-dirty="false"]', {
      timeout: 30_000,
    });
    await app.page.click('#perms-rerun');
    await app.page.click(`.adp-rotate[data-adapter="${AGENT}"]`);
    await app.page.waitForSelector(`#adp-arm[data-adapter="${AGENT}"]`, {
      timeout: 15_000,
    });
    await app.page.click('#adp-arm-go');
    await app.page.waitForSelector(`#adp-receipt[data-adapter="${AGENT}"]`, {
      timeout: 30_000,
    });
    await app.page.click('#adp-dismiss');

    const asked = mark();
    expect(asked).not.toEqual([]);
    // The writes this screen is ENTITLED to, and no others. Enumerated
    // rather than pattern-matched: a set difference is what catches the
    // write nobody meant to add.
    expect([...new Set(writes(asked))].sort()).toEqual(
      [
        'PATCH /v1/settings',
        'POST /v1/toggles/global-mode',
        'POST /v1/toggles/kill-switch',
        `POST /v1/adapters/${AGENT}/token`,
      ].sort(),
    );

    // Sc12/Sc13's shape for a legitimate caller naming a sensitive verb: a
    // ban a legitimate reader has to be exempted from is the wrong ban, so
    // every request that names one is enumerated and every one is a GET.
    const naming = urls(fixture).filter((u) => /approve|dispatch/i.test(u));
    expect(writes(naming)).toEqual([]);

    // Nothing crossed the send port, and the draft never moved — including
    // after a tick, which is the moment a dispatcher holding an approval
    // would act. Turning `auto` on for everyone is a POLICY, not an act.
    expect(fixture.loopback.calls()).toEqual([]);
    expect(
      (await fixture.directClient.getDraft('01HQ00000000000000000SC14I')).draft
        .state,
    ).toBe('pending');
    await fixture.daemon.tick();
    expect(fixture.loopback.callCount()).toBe(0);
    expect(
      (await fixture.directClient.getDraft('01HQ00000000000000000SC14I')).draft
        .state,
    ).toBe('pending');
  }, 300_000);
});

/* ── row 13: a horizon is a string, never a countdown ─────────────────── */

describe('s8 Sc14 row 13: "paused until" does not tick', () => {
  it('renders a fixed horizon that does not move when the screen repaints', async () => {
    const fixture = await boot();
    const until = new Date(fixture.clock.nowMs() + 90 * 60_000).toISOString();
    await fixture.directClient.pause(until);

    const app = await launch(fixture);
    await waitForConnected(app.page);
    await app.page.waitForSelector('#state-strip[data-outbound="paused"]', {
      timeout: 30_000,
    });
    await toSettings(app);

    const first = await readForm(app);
    const horizon = first.pointers.find((p) => p.key === 'arming.pauseUntil');
    expect(horizon?.value.toUpperCase()).toContain('PAUSED UNTIL');
    // The pointer names the route that owns the key. The screen does not
    // offer to write it: `arming.pauseUntil` is read-only and a settings
    // PATCH would be refused with `read-only-key`.
    expect(horizon?.use).toContain('POST /v1/toggles/pause');

    // Repaint the screen by doing something unrelated, and read it again.
    // A live clock would have moved; this is a string derived once from an
    // instant `main.tsx` read at boot and passed down as a prop.
    await app.page.click('#kill-toggle');
    await app.page.waitForSelector('#kill-state[data-kill="killed"]', {
      timeout: 30_000,
    });
    await app.page.click('#kill-toggle');
    await app.page.waitForSelector('#kill-state[data-kill="armed"]', {
      timeout: 30_000,
    });
    const second = await readForm(app);
    expect(
      second.pointers.find((p) => p.key === 'arming.pauseUntil')?.value,
    ).toBe(horizon?.value);
  }, 300_000);
});
