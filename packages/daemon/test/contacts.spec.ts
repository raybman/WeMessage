/**
 * s4-execution Scenario 10: contact policies — CRUD, the ladder, and the
 * deny audit.
 *
 * Two distinctions carry the whole suite:
 *
 *  1. **Unknown is not deny.** Both refuse the next rule-driven message, so
 *     collapsing them looks harmless. But then the audit trail can no longer
 *     answer "did the operator ever decide about this person, or have they
 *     simply never come up?", which is the difference between a policy and
 *     an accident. DELETE therefore removes the row and audits `to:null`.
 *  2. **The ladder binds agents, not the operator.** §2.4.5 / F-20: the
 *     allowlist exists to keep hostile inbound from reaching agents. A human
 *     texting from their own Mac through their own daemon is not the threat
 *     model, so a 'deny' row must not block the human path.
 *
 * Normalization is the quiet one. A policy set on '+1 (555) 000-0007' and a
 * message arriving as '+15550000007' must hit the same row, or the
 * operator's decision silently fails to apply to the person they made it
 * about.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  evaluateGate,
  normalizeHandle,
  readGateSettings,
  type ContactMode,
} from '@wemessage/core';
import {
  auditEvents,
  boot,
  cleanupHarness,
  get,
  post,
  type Harness,
} from './helpers/draft-harness.js';

const HANDLE = '+15550000007';
// The normalizer strips ` ( ) - .` and preserves the leading '+'; it does
// NOT invent a country code, so the formatted form has to carry the same
// digits. That is the real ambiguity a UI paste introduces.
const FORMATTED = '+1 (555) 000-0007';

afterEach(async () => {
  await cleanupHarness();
});

function put(h: Harness, handle: string, payload: Record<string, unknown>) {
  return h.server.app.inject({
    method: 'PUT',
    url: `/v1/contacts/${encodeURIComponent(handle)}`,
    headers: h.headers,
    payload,
  });
}

function del(h: Harness, handle: string) {
  return h.server.app.inject({
    method: 'DELETE',
    url: `/v1/contacts/${encodeURIComponent(handle)}`,
    headers: h.headers,
  });
}

function policyChanges(h: Harness): Array<{
  handle?: string;
  from?: ContactMode | null;
  to?: ContactMode | null;
}> {
  return auditEvents(h.store).filter(
    (e) => e.type === 'contact.policy-changed',
  ) as Array<{
    handle?: string;
    from?: ContactMode | null;
    to?: ContactMode | null;
  }>;
}

describe('s4 Scenario 10: contact policies', () => {
  it('PUT upserts, audits from:null, and lists normalized', async () => {
    const h = await boot();
    const res = await put(h, HANDLE, { mode: 'draft-only' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      contact: { handle: HANDLE, mode: 'draft-only' },
    });

    const listed = (await get(h, '/v1/contacts')).json() as {
      contacts: Array<{ handle: string; mode: string }>;
    };
    expect(listed.contacts).toEqual([
      expect.objectContaining({ handle: HANDLE, mode: 'draft-only' }),
    ]);

    expect(policyChanges(h)).toEqual([
      expect.objectContaining({ handle: HANDLE, from: null, to: 'draft-only' }),
    ]);
  });

  it('a formatted handle hits the SAME row, not a second one', async () => {
    const h = await boot();
    await put(h, HANDLE, { mode: 'draft-only' });
    const res = await put(h, FORMATTED, { mode: 'auto' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { contact: { handle: string } }).contact.handle).toBe(
      normalizeHandle(FORMATTED),
    );

    const listed = (await get(h, '/v1/contacts')).json() as {
      contacts: Array<{ handle: string; mode: string }>;
    };
    // One person, one policy. Two rows would mean the operator's second
    // decision quietly failed to replace the first.
    expect(listed.contacts).toHaveLength(1);
    expect(listed.contacts[0]).toMatchObject({ handle: HANDLE, mode: 'auto' });
    expect(policyChanges(h).at(-1)).toMatchObject({
      handle: HANDLE,
      from: 'draft-only',
      to: 'auto',
    });
  });

  it('the ladder walk is audited step by step, and DELETE returns to unknown', async () => {
    const h = await boot();
    for (const mode of ['deny', 'draft-only', 'auto'] as const) {
      expect((await put(h, HANDLE, { mode })).statusCode).toBe(200);
    }
    expect(policyChanges(h).map((e) => [e.from, e.to])).toEqual([
      [null, 'deny'],
      ['deny', 'draft-only'],
      ['draft-only', 'auto'],
    ]);

    const removed = await del(h, HANDLE);
    expect(removed.statusCode).toBe(200);
    // Unknown, NOT deny: the row is gone, and the audit says so.
    expect(h.store.getContactPolicy(HANDLE)).toBeNull();
    expect(policyChanges(h).at(-1)).toMatchObject({ from: 'auto', to: null });
    expect(
      ((await get(h, '/v1/contacts')).json() as { contacts: unknown[] })
        .contacts,
    ).toEqual([]);
  });

  it('gate: rule-driven traffic denies an unknown handle and allows draft-only', async () => {
    const h = await boot();
    const rule = {
      id: 'rule-contact',
      name: 'rule-contact',
      enabled: true,
      matcher: {
        kind: 'keyword' as const,
        keywords: ['x'],
        mode: 'any' as const,
      },
      adapterId: 'human',
      respondMode: 'auto' as const,
      scheduleId: null,
      outsideWindow: 'draft-only' as const,
      allowGroupDrafts: false,
      matchAttachmentOnly: false,
      draftTtlMinutes: 240,
      priority: 100,
      createdAt: h.clockCtl.clock.now(),
      updatedAt: h.clockCtl.clock.now(),
    };
    h.store.insertRule(rule);
    h.store.setSetting('send.globalMode', 'auto');
    const message = {
      isGroup: false,
      service: 'iMessage' as const,
      handle: HANDLE,
      chatGuid: `iMessage;-;${HANDLE}`,
    };
    const counters = {
      contactAutoLast2Min: 0,
      contactAutoLastHour: 0,
      globalSentLastHour: 0,
      consecutiveAutoInChat: 0,
      circuitOpen: false,
    };

    // Unknown handle: §1.3.5's deny-all default is what unknown MEANS.
    const denied = evaluateGate({
      now: h.clockCtl.clock.now(),
      settings: readGateSettings(h.store),
      rule,
      schedule: null,
      contact: h.store.getContactPolicy(HANDLE),
      message,
      counters,
    });
    expect(denied).toEqual({ allow: false, reason: 'contact-denied' });

    // draft-only contact under an auto global: most restrictive wins, so
    // the rule may draft but never send on its own.
    await put(h, HANDLE, { mode: 'draft-only' });
    const allowed = evaluateGate({
      now: h.clockCtl.clock.now(),
      settings: readGateSettings(h.store),
      rule,
      schedule: null,
      contact: h.store.getContactPolicy(HANDLE),
      message,
      counters,
    });
    expect(allowed).toEqual({ allow: true, mode: 'draft-only' });
  });

  it('F-20: a deny row does not block the human path', async () => {
    const h = await boot();
    await put(h, '+15551234567', { mode: 'deny' });

    // §2.4.5: the allowlist is the boundary between hostile INBOUND and
    // agents, not between the operator and their own Mac. A human composing
    // and approving by hand (rule === null) is pinned past the ladder.
    const draft = (
      (
        await post(h, '/v1/drafts', {
          chatGuid: 'iMessage;-;+15551234567',
          body: 'my own phone, my own message',
        })
      ).json() as { draft: { id: string } }
    ).draft;
    const approved = await post(h, `/v1/drafts/${draft.id}/approve`);
    expect(approved.statusCode).toBe(200);

    h.clockCtl.advance(11_000);
    await h.scheduler.tick();
    expect(h.store.getDraft(draft.id)?.state).toBe('sent');
  });

  it('an invalid mode is 400 and DELETE on an unknown handle is 404', async () => {
    const h = await boot();
    const bad = await put(h, HANDLE, { mode: 'sometimes' });
    expect(bad.statusCode).toBe(400);
    expect(h.store.getContactPolicy(HANDLE)).toBeNull();

    const missing = await del(h, '+15559999999');
    expect(missing.statusCode).toBe(404);
    // A 404 that still wrote an audit row would invent a policy change that
    // never happened.
    expect(policyChanges(h)).toEqual([]);
  });
});
