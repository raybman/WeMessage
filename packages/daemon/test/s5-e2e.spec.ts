/**
 * s5-execution Scenario 14 — S5 end to end: §4.2's demo, in test form.
 *
 * One narrative, one temp dir, one fixture chat.db, the loopback backend, a
 * hand-driven clock, and the REAL `@wemessage/adapter-echo` running
 * in-process over a real loopback WebSocket against the real composed
 * daemon. No GREEN is expected: every mechanism landed in Scenarios 1
 * through 13. What this file adds is the only thing the per-scenario suites
 * structurally cannot — proof that registry, transport, dispatch, submit,
 * deltas, feedback, proactive, the S4 queue and the S2 audit chain compose
 * into the demo an operator will actually run.
 *
 * Deliberate reading of row 1's `GET /v1/status`: this harness composes
 * `buildServer` directly, and `/v1/status`'s adapter list is the F-5 payload
 * that S5 is the slice to fill in. Both the fallback in `server.ts` and
 * `daemon.ts`'s `getStatus` now report `store.listAdapters()` rather than a
 * hardcoded `[]`, so the row is asserted literally here.
 *
 * The meta-assertions at the end (§4.1 rows 2-7 and C-9) are the standing
 * proof of the non-negotiables: a verifying audit chain over the whole mix,
 * only vocabulary-listed events on the client bus, zero osascript, zero
 * writes outside the temp dir, zero sockets off the loopback interface, and
 * no ANSI at all in the CLI transcripts this file collects.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEvent, Draft, Message } from '@wemessage/core';
import { verifyChain } from '@wemessage/core';
import { createInboundDispatch, toGatewayEvent } from '@wemessage/daemon';
import {
  createEchoAdapter,
  type EchoAdapter,
  type EchoSocketFactory,
} from '@wemessage/adapter-echo';
import {
  auditActors,
  auditEvents,
  CHAT,
  HANDLE,
  T0,
} from './helpers/draft-harness.js';
import {
  bootAgent,
  cleanupAgentHarness,
  waitUntil,
  type AgentHarness,
} from './helpers/agent-harness.js';
import { WS_EVENT_VOCABULARY } from './transport-surface.snapshot.js';

const CLI_BIN = fileURLToPath(
  new URL('../../cli/dist/bin.js', import.meta.url),
);
/** Any ANSI escape (covers green): C-9, asserted at its strictest. */
const ANSI_RE = /\x1b\[/;

const PAST_GRACE_MS = 11_000;
/** The rule's own TTL is 45 minutes (F-48); this is comfortably past it. */
const PAST_TTL_MS = 46 * 60_000;
/** Inside the 10s grace: the kill switch has to land mid-window. */
const MID_GRACE_MS = 4_000;

const ADAPTER_ID = 'echo-1';
/** The handle an operator has explicitly refused (§2.4.3's deny row). */
const DENIED_HANDLE = '+15550000077';
const DENIED_CHAT = `iMessage;-;${DENIED_HANDLE}`;

const children: ChildProcess[] = [];
const transcripts: string[] = [];
const openSockets: WebSocket[] = [];
const echoes: EchoAdapter[] = [];

afterEach(async () => {
  for (const echo of echoes.splice(0)) echo.stop();
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await Promise.all(
    openSockets.splice(0).map(
      (ws) =>
        new Promise<void>((resolve) => {
          if (ws.readyState === ws.CLOSED) return resolve();
          ws.on('close', () => resolve());
          ws.close();
        }),
    ),
  );
  await cleanupAgentHarness();
});

interface Frame {
  type: string;
  payload: Record<string, unknown>;
}

/**
 * A real loopback socket for the real echo adapter, with a tap: every frame
 * the gateway sends is recorded before echo sees it, and the raw socket is
 * kept so the narrative can also put a hand-written frame on the SAME
 * authenticated wire (the supersede row needs a second submit under a new
 * idempotency key, which echo by design never produces).
 */
interface EchoRig {
  /** Gateway -> adapter. */
  frames: Frame[];
  /** Adapter -> gateway, tapped at the socket echo actually writes to. */
  sent: Frame[];
  raw: WebSocket[];
  factory: EchoSocketFactory;
}

function echoRig(): EchoRig {
  const rig: EchoRig = {
    frames: [],
    sent: [],
    raw: [],
    factory: (url, handlers) =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        openSockets.push(ws);
        rig.raw.push(ws);
        ws.on('message', (data) => {
          const raw = String(data);
          rig.frames.push(JSON.parse(raw) as Frame);
          handlers.onMessage(raw);
        });
        ws.on('close', (code) => handlers.onClose(code));
        ws.on('error', reject);
        ws.on('open', () =>
          resolve({
            send: (data) => {
              rig.sent.push(JSON.parse(data) as Frame);
              ws.send(data);
            },
            close: (code) => ws.close(code ?? 1000),
          }),
        );
      }),
  };
  return rig;
}

function framesOf(rig: EchoRig, type: string): Frame[] {
  return rig.frames.filter((f) => f.type === type);
}

function sentOf(rig: EchoRig, type: string): Frame[] {
  return rig.sent.filter((f) => f.type === type);
}

/** The daemon's `deliver` in miniature, composed exactly as `daemon.ts` does. */
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
    issueRequest: (req) => h.server.agentRequests?.issue(req),
  });
  return async (message) => {
    h.store.insertInboundMessage(message);
    h.sink.broadcast(toGatewayEvent(message));
    await dispatch.emitWinner(message, h.store.listRules());
  };
}

function inbound(guid: string, text: string, at: string): Message {
  return {
    guid,
    sourceRowid: Number(guid.replace(/\D/g, '')) + 100,
    chatGuid: CHAT,
    handle: HANDLE,
    isFromMe: false,
    isGroup: false,
    service: 'iMessage',
    kind: 'text',
    text,
    attachments: [],
    sentAt: at,
    receivedAt: at,
  };
}

function drafts(h: AgentHarness): Draft[] {
  return h.store.listDrafts({});
}

function events(h: AgentHarness, type: string): AuditEvent[] {
  return auditEvents(h.store).filter((e) => e.type === type);
}

function runCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      env: { ...process.env, ...env },
    });
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      transcripts.push(stdout, stderr);
      resolve({ code, stdout, stderr });
    });
  });
}

describe('s5 Scenario 14: the agent demo, end to end', () => {
  it('runs §4.2: register, connect, match, stream, draft, send, dedup, supersede, reject, expire, redraft, propose, kill, rotate', async () => {
    // ---- 1. boot fully connected, register + connect the echo adapter ----
    const h = await bootAgent({ rules: true });
    const before = new Set(readdirSync(h.dir));
    const port = Number(new URL(h.baseUrl).port);
    const env = {
      WEMESSAGE_PORT: String(port),
      WEMESSAGE_TOKEN: h.server.token ?? '',
    };

    // A second, explicitly refused conversation for the proactive row, and a
    // two-sided history so `readChatTurns` returns turns from BOTH sides.
    const deniedHandleId = h.fixture.addHandle(DENIED_HANDLE);
    h.fixture.addChat({
      identifier: DENIED_HANDLE,
      handleIds: [deniedHandleId],
    });
    const chatId = (
      h.fixture.db
        .prepare('SELECT ROWID AS rowid FROM chat WHERE guid = ?')
        .get(CHAT) as { rowid: number }
    ).rowid;
    const handleId = (
      h.fixture.db
        .prepare('SELECT ROWID AS rowid FROM handle WHERE id = ?')
        .get(HANDLE) as { rowid: number }
    ).rowid;
    // 14 turns, alternating, so the §3.3 limit of 12 genuinely bites.
    for (let i = 1; i <= 14; i += 1) {
      const at = new Date(Date.parse(T0) - (20 - i) * 60_000).toISOString();
      if (i % 2 === 1) {
        h.fixture.addMessage({ chatId, handleId, text: `them ${i}`, at });
      } else {
        h.fixture.addSelfMessage({ chatId, text: `me ${i}`, at });
      }
    }

    expect(
      (
        await h.server.app.inject({
          method: 'PUT',
          url: `/v1/contacts/${encodeURIComponent(HANDLE)}`,
          headers: h.headers,
          payload: { mode: 'draft-only' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await h.server.app.inject({
          method: 'PUT',
          url: `/v1/contacts/${encodeURIComponent(DENIED_HANDLE)}`,
          headers: h.headers,
          payload: { mode: 'deny' },
        })
      ).statusCode,
    ).toBe(200);

    // The client bus watcher: a REAL authenticated /v1/events socket, which
    // is what `wemessage watch` is.
    const busFrames: Array<{ event: string }> = [];
    const bus = new WebSocket(`${h.baseUrl}/v1/events`, {
      headers: h.headers,
    });
    openSockets.push(bus);
    bus.on('message', (d) =>
      busFrames.push(JSON.parse(String(d)) as { event: string }),
    );
    await new Promise<void>((resolve) => bus.on('open', () => resolve()));

    const created = await h.server.app.inject({
      method: 'POST',
      url: '/v1/adapters',
      headers: h.headers,
      payload: { id: ADAPTER_ID, kind: 'echo', displayName: 'Echo' },
    });
    expect(created.statusCode).toBe(201);
    const { token, connectCmd } = created.json() as {
      token: string;
      connectCmd: string;
    };
    expect(connectCmd).toContain('/v1/agent');

    const rig = echoRig();
    const echo = createEchoAdapter({
      url: `${h.baseUrl}/v1/agent`,
      token,
      adapterId: ADAPTER_ID,
      ws: rig.factory,
      clock: h.clockCtl.clock,
      streaming: true,
      delay: () => Promise.resolve(),
    });
    echoes.push(echo);
    void echo.run();
    await waitUntil(
      () => h.store.getAdapter(ADAPTER_ID)?.health === 'connected',
      'echo connected',
    );

    const status = (
      await h.server.app.inject({
        method: 'GET',
        url: '/v1/status',
        headers: h.headers,
      })
    ).json() as { adapters: Array<{ id: string; health: string }> };
    expect(status.adapters).toEqual([
      expect.objectContaining({ id: ADAPTER_ID, health: 'connected' }),
    ]);
    await waitUntil(
      () =>
        busFrames.some(
          (f) =>
            f.event === 'adapter.health' &&
            (f as unknown as { status?: string }).status === 'connected',
        ),
      'adapter.health on the client bus',
    );

    // ---- 2-3. a rule, an inbound, and the whole request/stream/submit leg -
    const ruleRes = await h.server.app.inject({
      method: 'POST',
      url: '/v1/rules',
      headers: h.headers,
      payload: {
        name: 'demo',
        matcher: { kind: 'keyword', keywords: ['tacos'], mode: 'any' },
        adapterId: ADAPTER_ID,
        draftTtlMinutes: 45,
      },
    });
    expect(ruleRes.statusCode).toBe(201);

    const deliver = deliverer(h);
    await deliver(inbound('GUID-1', 'tacos tonight?', T0));
    await waitUntil(() => drafts(h).length === 1, 'first agent draft');

    expect(events(h, 'rule.matched')).toHaveLength(1);
    const request = framesOf(rig, 'draft.request')[0];
    expect(request).toBeDefined();
    const ctx = request?.payload['context'] as Array<{ from: string }>;
    expect(ctx).toHaveLength(12);
    expect(new Set(ctx.map((t) => t.from))).toEqual(new Set(['them', 'me']));

    // The client bus is a real socket: the deltas are in flight, not in a
    // synchronous witness array.
    await waitUntil(
      () => busFrames.filter((f) => f.event === 'draft.delta').length === 3,
      'three deltas on the client bus',
    );
    const deltas = busFrames.filter((f) => f.event === 'draft.delta') as Array<{
      seq: number;
      textDelta: string;
    }>;
    expect(deltas.map((d) => d.seq)).toEqual([1, 2, 3]);
    const first = drafts(h)[0] as Draft;
    expect(deltas.map((d) => d.textDelta).join('')).toBe(first.body);
    expect(first.body).toBe('echo: tacos tonight?');
    expect(first.state).toBe('pending');
    expect(first.adapterId).toBe(ADAPTER_ID);
    // F-48: the TTL is the RULE's 45 minutes, not the 240 route default.
    expect(Date.parse(first.expiresAt) - Date.parse(first.createdAt)).toBe(
      45 * 60_000,
    );
    const queue = (
      await h.server.app.inject({
        method: 'GET',
        url: '/v1/drafts',
        headers: h.headers,
      })
    ).json() as { drafts: Array<{ id: string; state: string }> };
    expect(queue.drafts).toEqual([
      expect.objectContaining({ id: first.id, state: 'pending' }),
    ]);

    // ---- 4. approve (the untouched S4 path), grace, dispatch, feedback ----
    expect(
      (
        await h.server.app.inject({
          method: 'POST',
          url: `/v1/drafts/${first.id}/approve`,
          headers: h.headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    h.clockCtl.advance(PAST_GRACE_MS);
    await h.scheduler.tick();
    expect(h.store.getDraft(first.id)?.state).toBe('sent');
    await waitUntil(
      () =>
        framesOf(rig, 'draft.feedback').some(
          (f) => f.payload['kind'] === 'send_verified',
        ),
      'send_verified feedback',
    );
    const verified = framesOf(rig, 'draft.feedback').find(
      (f) => f.payload['kind'] === 'send_verified',
    );
    expect(verified?.payload['finalBody']).toBe('echo: tacos tonight?');

    // ---- 5. replay dedups; a second key supersedes -----------------------
    // A FRESH dispatcher: the seen-set is in-process (F-15), so a restart is
    // exactly a dispatcher that has never seen this guid. The gateway dedups
    // on echo's derived idempotency key, read from the STORE.
    await deliverer(h)(inbound('GUID-1', 'tacos tonight?', T0));
    await waitUntil(
      () => framesOf(rig, 'draft.request').length === 2,
      're-asked after replay',
    );
    await waitUntil(
      () => sentOf(rig, 'draft.submit').length === 2,
      'echo answered the replay',
    );
    // Same derived key, so the gateway dedups: no second draft exists, and
    // the sent one has already left the queue.
    expect(drafts(h)).toHaveLength(0);

    const second = inbound('GUID-2', 'tacos again?', T0);
    await deliver(second);
    await waitUntil(() => drafts(h).length === 1, 'second agent draft');
    const superseded = drafts(h)[0] as Draft;
    const corr = (framesOf(rig, 'draft.request').at(-1) as Frame).payload[
      'correlation'
    ];
    rig.raw.at(-1)?.send(
      JSON.stringify({
        v: 1,
        id: 'e2e-supersede-000001',
        type: 'draft.submit',
        ts: h.clockCtl.clock.now(),
        payload: {
          correlation: corr,
          idempotencyKey: 'e2e-better-answer',
          body: 'echo: a better answer',
        },
      }),
    );
    await waitUntil(
      () => h.store.getDraft(superseded.id)?.state === 'superseded',
      'first draft superseded',
    );
    const replacement = drafts(h)[0] as Draft;
    expect(replacement.body).toBe('echo: a better answer');

    // ---- 6. reject, expire, redraft --------------------------------------
    expect(
      (
        await h.server.app.inject({
          method: 'POST',
          url: `/v1/drafts/${replacement.id}/reject`,
          headers: h.headers,
          payload: { reason: 'wrong restaurant' },
        })
      ).statusCode,
    ).toBe(200);
    await waitUntil(
      () =>
        framesOf(rig, 'draft.feedback').some(
          (f) => f.payload['kind'] === 'draft_rejected',
        ),
      'draft_rejected feedback',
    );
    expect(
      framesOf(rig, 'draft.feedback').find(
        (f) => f.payload['kind'] === 'draft_rejected',
      )?.payload['reason'],
    ).toBe('wrong restaurant');

    const third = inbound('GUID-3', 'tacos on friday?', h.clockCtl.clock.now());
    await deliver(third);
    await waitUntil(() => drafts(h).length === 1, 'third agent draft');
    const lapsing = drafts(h)[0] as Draft;
    h.clockCtl.advance(PAST_TTL_MS);
    await h.scheduler.tick();
    expect(h.store.getDraft(lapsing.id)?.state).toBe('expired');
    await waitUntil(
      () =>
        framesOf(rig, 'draft.feedback').some(
          (f) => f.payload['kind'] === 'draft_expired',
        ),
      'draft_expired feedback',
    );

    const requestsBefore = framesOf(rig, 'draft.request').length;
    expect(
      (
        await h.server.app.inject({
          method: 'POST',
          url: `/v1/drafts/${lapsing.id}/redraft`,
          headers: h.headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    await waitUntil(
      () => framesOf(rig, 'draft.request').length === requestsBefore + 1,
      'redraft re-asked the adapter',
    );
    await waitUntil(
      () =>
        sentOf(rig, 'draft.submit').filter(
          (f) =>
            (f.payload['idempotencyKey'] as string) === `echo:${third.guid}`,
        ).length === 2,
      'the adapter answered again',
    );

    // ---- 7. proactive: refused to a denied handle, pending to an allowed one
    const raw = rig.raw.at(-1) as WebSocket;
    const propose = (over: Record<string, unknown>): void => {
      raw.send(
        JSON.stringify({
          v: 1,
          id: `e2e-propose-${String(rig.frames.length).padStart(6, '0')}`,
          type: 'proactive.propose',
          ts: h.clockCtl.clock.now(),
          payload: {
            idempotencyKey: 'prop-denied',
            target: { chatGuid: DENIED_CHAT },
            body: 'their flight is delayed',
            reason: 'flight status changed',
            ...over,
          },
        }),
      );
    };
    propose({});
    await waitUntil(
      () =>
        events(h, 'gate.denied').some(
          (e) => (e as { reason?: string }).reason === 'contact-denied',
        ),
      'proactive to a denied handle refused',
    );
    await waitUntil(
      () =>
        framesOf(rig, 'draft.feedback').some(
          (f) => f.payload['reason'] === 'contact-denied',
        ),
      'the adapter was told why its proposal was refused',
    );
    const refusal = framesOf(rig, 'draft.feedback').find(
      (f) => f.payload['reason'] === 'contact-denied',
    ) as Frame;
    expect(refusal.payload['kind']).toBe('draft_rejected');

    const draftsBefore = drafts(h).length;
    propose({
      idempotencyKey: 'prop-allowed',
      target: { handle: HANDLE },
      reason: 'their flight lands at 9',
    });
    await waitUntil(
      () => drafts(h).length === draftsBefore + 1,
      'proactive draft minted',
    );
    const proactive = drafts(h).find((d) => d.ruleId === null) as Draft;
    expect(proactive.inboundGuid).toBeNull();
    expect(proactive.proactiveReason).toBe('their flight lands at 9');
    expect(proactive.state).toBe('pending');
    // Never auto-approved: a tick moves nothing, and no approval exists.
    await h.scheduler.tick();
    expect(h.store.getDraft(proactive.id)?.state).toBe('pending');

    // ---- 8. kill switch mid-grace ----------------------------------------
    expect(
      (
        await h.server.app.inject({
          method: 'POST',
          url: `/v1/drafts/${proactive.id}/approve`,
          headers: h.headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    h.clockCtl.advance(MID_GRACE_MS);
    expect(
      (
        await h.server.app.inject({
          method: 'POST',
          url: '/v1/toggles/kill-switch',
          headers: h.headers,
          payload: { on: true },
        })
      ).statusCode,
    ).toBe(200);
    expect(h.store.getDraft(proactive.id)?.state).toBe('rejected');
    expect(auditActors(h.store, 'draft.rejected')).toContainEqual({
      kind: 'system',
      reason: 'kill-switch',
    });

    // s6 Sc5 (F-60): the kill switch now binds the DRAFT moment on the rule
    // path too. Through S5 this block asserted that inbound still produced a
    // draft while the switch was on, because createInboundDispatch never
    // consulted the gate (C-3) — a killed daemon still handed a stranger's
    // text to an agent's process. The kill switch is a deny at BOTH moments,
    // so the message is now refused in the daemon: no frame, no draft, one
    // gate.denied row naming the message.
    const requestsWhenKilled = framesOf(rig, 'draft.request').length;
    await deliver(inbound('GUID-4', 'tacos sunday?', h.clockCtl.clock.now()));
    expect(drafts(h).some((d) => d.inboundGuid === 'GUID-4')).toBe(false);
    expect(framesOf(rig, 'draft.request')).toHaveLength(requestsWhenKilled);
    expect(
      events(h, 'gate.denied').filter(
        (e) => (e as { guid?: string }).guid === 'GUID-4',
      ),
    ).toHaveLength(1);

    // Drafting is still not sending. With the switch off a draft lands as
    // before; flipping it back on refuses the approval and leaves the draft
    // exactly where it was.
    await h.server.app.inject({
      method: 'POST',
      url: '/v1/toggles/kill-switch',
      headers: h.headers,
      payload: { on: false },
    });
    await deliver(
      inbound('GUID-6', 'tacos sunday, then?', h.clockCtl.clock.now()),
    );
    await waitUntil(
      () => drafts(h).some((d) => d.inboundGuid === 'GUID-6'),
      'a draft lands once the kill switch is off',
    );
    const armed = drafts(h).find((d) => d.inboundGuid === 'GUID-6') as Draft;
    expect(
      (
        await h.server.app.inject({
          method: 'POST',
          url: '/v1/toggles/kill-switch',
          headers: h.headers,
          payload: { on: true },
        })
      ).statusCode,
    ).toBe(200);
    // A pending draft is not in grace, so the switch does not cancel it...
    expect(h.store.getDraft(armed.id)?.state).toBe('pending');
    // ...and it cannot be approved.
    const denied = await h.server.app.inject({
      method: 'POST',
      url: `/v1/drafts/${armed.id}/approve`,
      headers: h.headers,
      payload: {},
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({
      error: 'gate-denied',
      reason: 'kill-switch',
    });
    expect(h.store.getDraft(armed.id)?.state).toBe('pending');
    await h.server.app.inject({
      method: 'POST',
      url: '/v1/toggles/kill-switch',
      headers: h.headers,
      payload: { on: false },
    });

    // ---- 9. token rotation inside the 60s window -------------------------
    const rotated = await h.server.app.inject({
      method: 'POST',
      url: `/v1/adapters/${ADAPTER_ID}/token`,
      headers: h.headers,
      payload: {},
    });
    expect(rotated.statusCode).toBe(200);
    const nextToken = (rotated.json() as { token: string }).token;
    expect(nextToken).not.toBe(token);

    // The live socket, authenticated with the now-previous token, keeps
    // answering: rotation must not drop a request in flight.
    const requestsAtRotation = framesOf(rig, 'draft.request').length;
    await deliver(inbound('GUID-5', 'tacos monday?', h.clockCtl.clock.now()));
    await waitUntil(
      () => framesOf(rig, 'draft.request').length === requestsAtRotation + 1,
      'request delivered across rotation',
    );
    await waitUntil(
      () => drafts(h).some((d) => d.inboundGuid === 'GUID-5'),
      'answered across rotation',
    );

    // Then the adapter comes back on the new token, inside the window.
    echo.stop();
    await waitUntil(
      () => h.store.getAdapter(ADAPTER_ID)?.health !== 'connected',
      'old session gone',
    );
    const rig2 = echoRig();
    const echo2 = createEchoAdapter({
      url: `${h.baseUrl}/v1/agent`,
      token: nextToken,
      adapterId: ADAPTER_ID,
      ws: rig2.factory,
      clock: h.clockCtl.clock,
      delay: () => Promise.resolve(),
    });
    echoes.push(echo2);
    void echo2.run();
    await waitUntil(
      () => h.store.getAdapter(ADAPTER_ID)?.health === 'connected',
      'reconnected on the rotated token',
    );

    // ---- 10. the meta-assertions (§4.1 rows 2-7, C-9) --------------------

    // `wemessage audit verify` is green over the whole mix, and the chain
    // verifies in-process too (the CLI reads the same route).
    const cliVerify = await runCli(['audit', 'verify', '--json'], env);
    expect(cliVerify.code).toBe(0);
    expect(JSON.parse(cliVerify.stdout) as { ok: boolean }).toMatchObject({
      ok: true,
    });
    expect(verifyChain(h.store.readAuditRows(0, 5000))).toMatchObject({
      ok: true,
    });
    const cliAdapters = await runCli(['adapters', 'list'], env);
    expect(cliAdapters.code).toBe(0);
    expect(cliAdapters.stdout).toContain(ADAPTER_ID);
    // No token material after mint, on any surface the operator sees.
    for (const text of transcripts) {
      expect(text).not.toContain(token);
      expect(text).not.toContain(nextToken);
      expect(ANSI_RE.test(text)).toBe(false);
    }

    // The WS watcher collected only vocabulary-listed events.
    expect(busFrames.length).toBeGreaterThan(0);
    for (const frame of busFrames) {
      expect(WS_EVENT_VOCABULARY).toContain(frame.event);
    }

    // Every terminal state came through the transition table, and the only
    // gate denials are the two this narrative actually provoked. Expiry is
    // never a denial (C-6), and neither is a forbidden frame.
    expect(events(h, 'draft.illegal-transition')).toHaveLength(0);
    const reasons = new Set(
      events(h, 'gate.denied').map((e) => (e as { reason?: string }).reason),
    );
    expect(reasons).toEqual(new Set(['contact-denied', 'kill-switch']));

    // Zero osascript: the loopback backend is the only send path, and every
    // call it saw belongs to this narrative's one conversation.
    expect(h.backend.calls().length).toBeGreaterThan(0);
    for (const call of h.backend.calls()) expect(call.chatGuid).toBe(CHAT);

    // Zero real network sockets: every socket this test opened is loopback.
    for (const ws of openSockets) expect(ws.url).toContain('127.0.0.1');

    // Zero writes outside the temp dir.
    // Zero writes outside the temp dir, and nothing new inside it beyond
    // the sqlite sidecars the store and the fixture legitimately open.
    const added = readdirSync(h.dir).filter((e) => !before.has(e));
    expect(added.filter((e) => !/-(wal|shm|journal)$/.test(e))).toEqual([]);
  });
});
