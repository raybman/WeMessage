/**
 * s6-execution Part 2 Scenario 6 (caps half) — rate counters become a
 * decision. Spec rows 4-9; §1.7 "Rate counters (Sc 6)"; flags F-66 (caps are
 * default-on, floored at 1, with no disabling value) and F-71 (the counter is
 * bumped when the APPROVAL is written, and the global cap is the one rate
 * limit in this product that tells a human no).
 *
 * **What a cap is for, and why there are three.** The two per-contact caps
 * are pacing: they stop the machine from hammering one person, and they are
 * about that person's experience. The global cap is different in kind — it is
 * the blast-radius bound for the whole daemon, the number that answers "if
 * everything goes wrong at 3am, how bad can it get before I wake up". A bound
 * with an exception is not a bound, so the global cap counts human approvals
 * and refuses them; the per-contact caps do neither, because a person
 * deciding to send three messages in a minute is a person having a
 * conversation.
 *
 * **Where a clamp is observable in THIS scenario.** The auto-approve path
 * (Sc 9) does not exist yet, so "this message would have auto-sent" cannot be
 * read off an approval row. It is read where Sc 5 already put it: the
 * RESOLVED mode in the `draft.request` frame the adapter actually receives
 * (F-60 — "an agent is never told `auto` for a message that structurally
 * cannot auto-send"). A rate clamp therefore shows up on the wire as
 * `respondMode: 'draft-only'`, which is exactly the fact Sc 9's auto path
 * will read. Nothing here simulates an approval it cannot make.
 *
 * **The one stand-in, named.** `bumpSendCounters(..., {auto: true})` is the
 * production counter writer Sc 9's auto path will call after `insertApproval`,
 * and it is what the human approve route calls today. These rows call it
 * directly to seed the history an auto-approval would have left. It is not a
 * test double: the scope strings and bucket boundaries it produces are the
 * ones under test.
 *
 * Every cap this suite moves is written explicitly in the test body (F-66 —
 * no NODE_ENV branch, no test-only bypass; a raise that is invisible in review
 * is a cap nobody is enforcing).
 *
 * Handles are synthetic (`+1555…`); no real iMessage content.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEvent, Message, Rule } from '@wemessage/core';
import {
  bumpSendCounters,
  contactRateScope,
  readRateCaps,
  RATE_SCOPE_GLOBAL,
  SETTING_CAP_CONTACT_PER_2MIN,
  SETTING_CAP_CONTACT_PER_HOUR,
  SETTING_CAP_GLOBAL_PER_HOUR,
  SETTING_GLOBAL_MODE,
} from '@wemessage/core';
import { createInboundDispatch, toGatewayEvent } from '@wemessage/daemon';
import {
  auditEvents,
  boot,
  CHAT,
  createDraft,
  HANDLE,
  post,
  T0,
  type Harness,
} from './helpers/draft-harness.js';
import {
  addAdapter,
  bootAgent,
  cleanupAgentHarness,
  connectAuthed,
  waitUntil,
  type AgentHarness,
  type FakeAdapterSocket,
} from './helpers/agent-harness.js';

afterEach(cleanupAgentHarness);

const ADAPTER = 'echo-1';
const RULE_ID = `${'0'.repeat(24)}R1`;
const MINUTE = 60_000;

function makeRule(): Rule {
  return {
    id: RULE_ID,
    name: 'tacos',
    enabled: true,
    matcher: { kind: 'keyword', keywords: ['tacos'], mode: 'any' },
    adapterId: ADAPTER,
    // The rule scope says auto, and so will the contact policy and the global
    // mode. Everything asserted below is therefore a claim about the CAPS
    // alone: no other scope in the ladder is narrow.
    respondMode: 'auto',
    scheduleId: null,
    outsideWindow: 'draft-only',
    allowGroupDrafts: false,
    matchAttachmentOnly: false,
    draftTtlMinutes: 45,
    priority: 100,
    createdAt: T0,
    updatedAt: T0,
  };
}

let guidSeq = 0;
function inbound(at: string): Message {
  guidSeq += 1;
  return {
    guid: `GUID-RATE-${String(guidSeq)}`,
    sourceRowid: 1_000 + guidSeq,
    chatGuid: CHAT,
    handle: HANDLE,
    isFromMe: false,
    isGroup: false,
    service: 'imessage',
    kind: 'text',
    text: 'tacos tonight?',
    attachments: [],
    sentAt: at,
    receivedAt: at,
  };
}

/** The daemon's `deliver` in miniature — mirror, broadcast, then match. */
function deliverer(h: AgentHarness): (message: Message) => Promise<void> {
  const dispatch = createInboundDispatch({
    store: h.store,
    clock: h.clockCtl.clock,
    sink: h.sink,
    reader: h.reader,
    transport: {
      isConnected: (id) => h.server.agentTransport?.isConnected(id) ?? false,
      sendTo: (id, frame) =>
        h.server.agentTransport?.sendTo(id, frame) ?? false,
    },
  });
  return async (message: Message): Promise<void> => {
    h.store.insertInboundMessage(message);
    h.sink.broadcast(toGatewayEvent(message));
    await dispatch.emitWinner(message, h.store.listRules());
  };
}

interface RequestFrame {
  type: string;
  payload: { rule: { respondMode: string } };
}

function requests(sock: FakeAdapterSocket): RequestFrame[] {
  return (sock.frames as RequestFrame[]).filter(
    (f) => f.type === 'draft.request',
  );
}

/**
 * Wait for the nth `draft.request` and return the mode it carries. Counting
 * `draft.request` frames specifically, rather than all frames, is what keeps
 * these rows honest if the transport ever starts sending anything else.
 */
async function modeOfRequest(
  sock: FakeAdapterSocket,
  n: number,
): Promise<string | null> {
  await waitUntil(() => requests(sock).length >= n, `draft.request #${n}`);
  return requests(sock)[n - 1]?.payload.rule.respondMode ?? null;
}

function auditOf(h: Harness, type: string): AuditEvent[] {
  return auditEvents(h.store).filter((e) => e.type === type);
}

/**
 * Boot + a connected adapter + a fully-`auto` three-scope ladder. Every row
 * that drives the inbound path starts here, so a `draft-only` frame below can
 * only be a clamp.
 */
async function armed(): Promise<{ h: AgentHarness; sock: FakeAdapterSocket }> {
  const h = await bootAgent();
  const cred = await addAdapter(h, ADAPTER);
  const sock = await connectAuthed(h, cred);
  h.store.insertRule(makeRule());
  h.store.setContactPolicy({ handle: HANDLE, mode: 'auto', updatedAt: T0 });
  h.store.setSetting(SETTING_GLOBAL_MODE, 'auto');
  return { h, sock };
}

/** Seed the counter history an auto-approval would have left (see header). */
function seedAutoSend(h: Harness): void {
  bumpSendCounters(h.store, {
    now: h.clockCtl.clock.now(),
    auto: true,
    handle: HANDLE,
  });
}

function approve(h: Harness, draftId: string) {
  return post(h, `/v1/drafts/${draftId}/approve`);
}

// --- RED row 4 -------------------------------------------------------------

describe('s6 Sc6 row 4: per-contact pacing', () => {
  it('a second auto 90 seconds later clamps, and a third at 121 seconds does not', async () => {
    const { h, sock } = await armed();
    const deliver = deliverer(h);

    // The shipped default, asserted rather than set: this row is what pins it.
    expect(readRateCaps(h.store).contactPer2Min).toBe(1);

    await deliver(inbound(h.clockCtl.clock.now()));
    expect(await modeOfRequest(sock, 1)).toBe('auto');
    // The approval Sc 9 will mint, and the budget it spends.
    seedAutoSend(h);

    h.clockCtl.advance(90_000);
    await deliver(inbound(h.clockCtl.clock.now()));
    expect(await modeOfRequest(sock, 2)).toBe('draft-only');

    // 121 seconds after the send: the minute bucket it landed in has fallen
    // out of the rolling two-minute window, so autonomy comes back on its own.
    // No reset, no sweep, no expiry job — the window is arithmetic over rows
    // that are still sitting there.
    h.clockCtl.advance(31_000);
    await deliver(inbound(h.clockCtl.clock.now()));
    expect(await modeOfRequest(sock, 3)).toBe('auto');
    expect(h.store.sumRateCounter(contactRateScope(HANDLE), T0)).toBe(1);
  });
});

// --- RED row 5 (the teeth row, TN-cap-off) ---------------------------------

describe('s6 Sc6 row 5: per-contact hourly', () => {
  it('the eleventh auto in an hour clamps rate-limited', async () => {
    const { h, sock } = await armed();
    const deliver = deliverer(h);

    // Explicit, visible headroom (F-66): pacing and the global bound are
    // raised so the ONLY cap that can bite below is the per-contact hour.
    h.store.setSetting(SETTING_CAP_CONTACT_PER_2MIN, '100');
    h.store.setSetting(SETTING_CAP_GLOBAL_PER_HOUR, '100');
    expect(readRateCaps(h.store).contactPerHour).toBe(10);

    // Nine sends, one per minute, all inside the hour.
    for (let i = 0; i < 9; i += 1) {
      seedAutoSend(h);
      h.clockCtl.advance(MINUTE);
    }
    await deliver(inbound(h.clockCtl.clock.now()));
    // The tenth is still auto: nine spent, ten allowed.
    expect(await modeOfRequest(sock, 1)).toBe('auto');

    seedAutoSend(h);
    h.clockCtl.advance(MINUTE);
    await deliver(inbound(h.clockCtl.clock.now()));
    expect(await modeOfRequest(sock, 2)).toBe('draft-only');
    expect(h.store.sumRateCounter(contactRateScope(HANDLE), T0)).toBe(10);
  });

  it('an hour later the same handle is auto again, and nothing was deleted to make that true', async () => {
    const { h, sock } = await armed();
    const deliver = deliverer(h);
    h.store.setSetting(SETTING_CAP_CONTACT_PER_2MIN, '100');
    h.store.setSetting(SETTING_CAP_GLOBAL_PER_HOUR, '100');

    for (let i = 0; i < 10; i += 1) {
      seedAutoSend(h);
      h.clockCtl.advance(MINUTE);
    }
    // A full hour past the LAST bucket, so every one of the ten is behind the
    // rolling window's trailing edge.
    h.clockCtl.advance(60 * MINUTE);
    await deliver(inbound(h.clockCtl.clock.now()));
    expect(await modeOfRequest(sock, 1)).toBe('auto');
    // The rows are still there. The window moved; the ledger did not.
    expect(h.store.sumRateCounter(contactRateScope(HANDLE), T0)).toBe(10);
  });
});

// --- RED row 6 -------------------------------------------------------------

describe('s6 Sc6 row 6: the global hourly cap counts human and auto alike', () => {
  it('the thirty-first send in an hour clamps, whoever made the first thirty', async () => {
    const { h, sock } = await armed();
    const deliver = deliverer(h);

    // Per-contact headroom (F-66), explicitly: this row is about the global
    // bound, and a contact cap firing first would prove the wrong thing.
    h.store.setSetting(SETTING_CAP_CONTACT_PER_2MIN, '100');
    h.store.setSetting(SETTING_CAP_CONTACT_PER_HOUR, '100');
    // The DEFAULT global cap, asserted rather than set: 30 is the shipped
    // blast radius and this row is what pins it.
    expect(readRateCaps(h.store).globalPerHour).toBe(30);

    // Fifteen decided by a human, through the real approve route.
    for (let i = 0; i < 15; i += 1) {
      const draft = await createDraft(h, `human draft ${String(i)}`);
      expect((await approve(h, draft.id)).statusCode).toBe(200);
    }
    // Fifteen decided by the machine.
    for (let i = 0; i < 15; i += 1) seedAutoSend(h);

    // The global ledger does not distinguish them, which is the point.
    expect(h.store.sumRateCounter(RATE_SCOPE_GLOBAL, T0)).toBe(30);
    // The per-contact ledger counts only the fifteen the machine chose.
    expect(h.store.sumRateCounter(contactRateScope(HANDLE), T0)).toBe(15);

    // The thirty-first, at the draft moment: autonomy is withheld.
    await deliver(inbound(h.clockCtl.clock.now()));
    expect(await modeOfRequest(sock, 1)).toBe('draft-only');
  });
});

// --- RED row 7 -------------------------------------------------------------

describe('s6 Sc6 row 7: a human bypasses pacing, never the global bound', () => {
  it('a saturated per-contact window does not stop a human approval', async () => {
    const h = await boot();
    // Three auto sends to this handle inside one minute: pacing is saturated
    // several times over at the default of one per two minutes.
    for (let i = 0; i < 3; i += 1) seedAutoSend(h);
    expect(h.store.sumRateCounter(contactRateScope(HANDLE), T0)).toBe(3);

    const draft = await createDraft(h, 'a person, deciding');
    const res = await approve(h, draft.id);

    expect(res.statusCode).toBe(200);
    expect(h.store.getDraft(draft.id)?.state).toBe('approved');
    // Pacing is about a machine's cadence. Nothing was refused, so nothing is
    // audited as a refusal.
    expect(auditOf(h, 'gate.denied')).toEqual([]);
    // The human's send counts globally (it is a send this daemon originated)
    // and NOT against this contact's pacing budget.
    expect(h.store.sumRateCounter(RATE_SCOPE_GLOBAL, T0)).toBe(4);
    expect(h.store.sumRateCounter(contactRateScope(HANDLE), T0)).toBe(3);
  });

  it('a saturated global window returns 403 gate-denied {rate-limited, retryAfter}', async () => {
    const h = await boot();
    // Lowered explicitly and visibly so one approval saturates the bound. The
    // floor is 1 (F-66); there is no value that would switch it off.
    h.store.setSetting(SETTING_CAP_GLOBAL_PER_HOUR, '1');

    const first = await createDraft(h, 'the one that fits');
    expect((await approve(h, first.id)).statusCode).toBe(200);

    const second = await createDraft(h, 'the one that does not');
    const res = await approve(h, second.id);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      error: 'gate-denied',
      // Top-level `reason` is what `DaemonGateDeniedError` parses (a 403
      // without it degrades to a plain auth error and the CLI loses exit 5);
      // `detail` is F-71's shape. `retryAfter` is the first instant at which
      // the rolling hour will have room again: the bucket the first approval
      // landed in stops being counted once `now - 60min` passes it, and it
      // sits exactly on 12:00:00.000.
      reason: 'rate-limited',
      detail: {
        reason: 'rate-limited',
        retryAfter: '2026-09-01T13:00:00.001Z',
      },
    });
    // A refusal is a fact worth finding later (F-34), anchored on the draft
    // somebody tried to approve.
    expect(auditOf(h, 'gate.denied')).toEqual([
      { type: 'gate.denied', draftId: second.id, reason: 'rate-limited' },
    ]);
    // And nothing moved: a refused approval is not a half-approval.
    expect(h.store.getDraft(second.id)?.state).toBe('pending');
    expect(h.store.listApprovals(second.id)).toEqual([]);
    // The refusal itself did not spend budget either.
    expect(h.store.sumRateCounter(RATE_SCOPE_GLOBAL, T0)).toBe(1);
  });
});

// --- RED row 8 -------------------------------------------------------------

describe('s6 Sc6 row 8: counted at approval, not at send (F-71)', () => {
  it('a send that later fails still consumed its budget', async () => {
    const h = await boot();
    h.store.setSetting(SETTING_CAP_GLOBAL_PER_HOUR, '1');

    const draft = await createDraft(h, 'this will never verify');
    expect((await approve(h, draft.id)).statusCode).toBe(200);

    // The budget is already spent, and the backend has not been called even
    // once: counting at send would make the cap racy across the whole grace
    // window, and this is the assertion that says it is not.
    expect(h.store.sumRateCounter(RATE_SCOPE_GLOBAL, T0)).toBe(1);
    expect(h.backend.callCount()).toBe(0);

    // Now let the send happen, and fail.
    h.backend.sabotage();
    h.clockCtl.advance(11_000);
    await h.scheduler.tick();
    expect(h.store.getDraft(draft.id)?.state).toBe('failed');
    expect(h.backend.callCount()).toBe(1);

    // No refund. A backend failing thirty times an hour does not get thirty
    // more tries, and a second attempt inside the window is still capped.
    expect(h.store.sumRateCounter(RATE_SCOPE_GLOBAL, T0)).toBe(1);
    const second = await createDraft(h, 'the retry nobody gets');
    expect((await approve(h, second.id)).statusCode).toBe(403);
  });
});

// --- RED row 9 -------------------------------------------------------------

describe('s6 Sc6 row 9: floors (F-66)', () => {
  it('defaults on a fresh store are 1 / 10 / 30', async () => {
    const h = await boot();
    expect(readRateCaps(h.store)).toEqual({
      contactPer2Min: 1,
      contactPerHour: 10,
      globalPerHour: 30,
    });
  });

  it('zero and negative values can never disable a cap', async () => {
    const h = await boot();
    const keys = [
      SETTING_CAP_CONTACT_PER_2MIN,
      SETTING_CAP_CONTACT_PER_HOUR,
      SETTING_CAP_GLOBAL_PER_HOUR,
    ] as const;

    for (const value of ['0', '-5', '-1000000']) {
      for (const key of keys) h.store.setSetting(key, value);
      expect(readRateCaps(h.store), value).toEqual({
        contactPer2Min: 1,
        contactPerHour: 1,
        globalPerHour: 1,
      });
    }

    // Unparseable falls back to the DEFAULT rather than to the floor: an
    // unreadable setting means "nobody set this", and the shipped default is
    // the honest answer to that. A zero is different — somebody typed it.
    for (const value of ['', 'off', 'Infinity', 'NaN', '1e3', '7.5', ' 5 ']) {
      for (const key of keys) h.store.setSetting(key, value);
      expect(readRateCaps(h.store), value).toEqual({
        contactPer2Min: 1,
        contactPerHour: 10,
        globalPerHour: 30,
      });
    }

    // Upward is unbounded.
    for (const key of keys) h.store.setSetting(key, '5000');
    expect(readRateCaps(h.store)).toEqual({
      contactPer2Min: 5000,
      contactPerHour: 5000,
      globalPerHour: 5000,
    });
  });

  it('a raised cap is a real raise: the eleventh auto passes when the hour cap is 20', async () => {
    const { h, sock } = await armed();
    const deliver = deliverer(h);
    h.store.setSetting(SETTING_CAP_CONTACT_PER_2MIN, '100');
    h.store.setSetting(SETTING_CAP_CONTACT_PER_HOUR, '20');
    h.store.setSetting(SETTING_CAP_GLOBAL_PER_HOUR, '100');

    for (let i = 0; i < 10; i += 1) {
      seedAutoSend(h);
      h.clockCtl.advance(MINUTE);
    }
    await deliver(inbound(h.clockCtl.clock.now()));
    expect(await modeOfRequest(sock, 1)).toBe('auto');
    expect(h.store.sumRateCounter(contactRateScope(HANDLE), T0)).toBe(10);
  });
});
