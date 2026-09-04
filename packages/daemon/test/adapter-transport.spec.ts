/**
 * s5-execution Scenario 5 ★ CHECKPOINT — WS adapter transport.
 *
 * `GET /v1/agent` is the one route that opts out of the operator bearer
 * (F-56): an adapter carries its own per-adapter token and presents it in
 * `hello`, so requiring the operator's bearer at upgrade would mean every
 * agent on the machine holds the key to the whole daemon. The exemption is
 * paid for here: an un-helloed socket may do NOTHING but wait, and it may
 * not wait long.
 *
 * Everything below runs against a real bound port and a real `ws` client —
 * `app.inject` cannot upgrade — with a hand-driven clock and a hand-driven
 * `tick()`, so there is not a single real sleep in the file.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEvent } from '@wemessage/core';
import { auditEvents, auditTypes } from './helpers/draft-harness.js';
import {
  addAdapter,
  bootAgent,
  cleanupAgentHarness,
  connectAgent,
  connectAuthed,
  waitUntil,
  type AgentHarness,
} from './helpers/agent-harness.js';

afterEach(cleanupAgentHarness);

function auditOf(h: AgentHarness, type: string): AuditEvent[] {
  return auditEvents(h.store).filter((e) => e.type === type);
}

describe('adapter transport: hello-first', () => {
  it('closes 4400 on any frame before hello, and mints nothing', async () => {
    const h = await bootAgent();
    const cred = await addAdapter(h);
    const sock = await connectAgent(h);
    sock.sendFrame('draft.submit', {
      correlation: { requestId: 'r1', chatGuid: 'iMessage;-;+15551234567' },
      idempotencyKey: 'k1',
      body: 'hi',
    });
    expect(await sock.closeCode).toBe(4400);
    expect(auditOf(h, 'adapter.protocol-violation')).toHaveLength(1);
    expect(h.store.listDrafts({}).length).toBe(0);
    // Never authenticated => never connected.
    expect(h.store.getAdapter(cred.id)?.health).toBe('unknown');
  });

  it('closes a silent socket once helloDeadlineMs has elapsed', async () => {
    const h = await bootAgent({ helloDeadlineMs: 5000 });
    const sock = await connectAgent(h);
    h.clockCtl.advance(4999);
    h.server.agentTransport?.tick();
    expect(sock.ws.readyState).toBe(sock.ws.OPEN);
    h.clockCtl.advance(2);
    h.server.agentTransport?.tick();
    expect(await sock.closeCode).toBe(4400);
    expect(
      auditOf(h, 'adapter.protocol-violation').map(
        (e) => (e as { reason: string }).reason,
      ),
    ).toEqual(['hello-timeout']);
  });
});

describe('adapter transport: authentication', () => {
  it('accepts a valid token: health connected, audit, broadcast', async () => {
    const h = await bootAgent();
    const cred = await addAdapter(h);
    const sock = await connectAgent(h);
    sock.sendFrame('hello', {
      adapterId: cred.id,
      token: cred.token,
      wire: 1,
    });
    await waitUntil(() => h.store.getAdapter(cred.id)?.health === 'connected');
    expect(sock.ws.readyState).toBe(sock.ws.OPEN);
    expect(auditOf(h, 'adapter.connected')).toEqual([
      { type: 'adapter.connected', adapterId: cred.id },
    ]);
    const health = h.broadcasts.filter(
      (b) => (b.frame as { event: string }).event === 'adapter.health',
    );
    expect(health.map((b) => b.frame)).toEqual([
      { event: 'adapter.health', adapterId: cred.id, status: 'connected' },
    ]);
    // §1.8: the log is the record, the event is the courtesy.
    expect(health[0]?.auditAtBroadcast).toContain('adapter.connected');
  });

  const badRows: Array<
    [
      string,
      (
        h: AgentHarness,
        cred: { id: string; token: string },
      ) => Promise<{ adapterId: string; token: string }>,
    ]
  > = [
    [
      'wrong token',
      async (_h, cred) => ({
        adapterId: cred.id,
        token: 'wm_' + 'a'.repeat(64),
      }),
    ],
    [
      'unknown adapter id',
      async (_h, cred) => ({ adapterId: 'nobody', token: cred.token }),
    ],
    [
      'revoked (NULL hash) adapter',
      async (h, cred) => {
        h.store.clearAdapterTokens();
        return { adapterId: cred.id, token: cred.token };
      },
    ],
    [
      'disabled adapter',
      async (h, cred) => {
        await h.server.app.inject({
          method: 'PATCH',
          url: `/v1/adapters/${cred.id}`,
          headers: h.headers,
          payload: { enabled: false },
        });
        return { adapterId: cred.id, token: cred.token };
      },
    ],
  ];

  for (const [label, prepare] of badRows) {
    it(`refuses ${label} with 4401 and never flips health`, async () => {
      const h = await bootAgent();
      const cred = await addAdapter(h);
      const hello = await prepare(h, cred);
      const sock = await connectAgent(h);
      sock.sendFrame('hello', {
        adapterId: hello.adapterId,
        token: hello.token,
        wire: 1,
      });
      expect(await sock.closeCode).toBe(4401);
      expect(auditOf(h, 'adapter.auth-failed')).toHaveLength(1);
      expect(auditOf(h, 'adapter.connected')).toHaveLength(0);
      expect(h.store.getAdapter(cred.id)?.health).toBe('unknown');
      expect(
        h.broadcasts.filter(
          (b) => (b.frame as { event: string }).event === 'adapter.health',
        ),
      ).toHaveLength(0);
    });
  }

  it('refuses a wire version it does not speak with 4426', async () => {
    const h = await bootAgent();
    const cred = await addAdapter(h);
    const sock = await connectAgent(h);
    sock.sendFrame('hello', { adapterId: cred.id, token: cred.token, wire: 2 });
    expect(await sock.closeCode).toBe(4426);
    expect(await sock.closeReason).toBe(JSON.stringify({ expected: 1 }));
    expect(h.store.getAdapter(cred.id)?.health).toBe('unknown');
  });
});

describe('adapter transport: dual-validity rotation (F-42)', () => {
  it('accepts the rotated-out token inside the grace and refuses it after', async () => {
    const h = await bootAgent();
    const cred = await addAdapter(h);
    await h.server.app.inject({
      method: 'POST',
      url: `/v1/adapters/${cred.id}/token`,
      headers: h.headers,
      payload: {},
    });

    h.clockCtl.advance(30_000);
    const early = await connectAgent(h);
    early.sendFrame('hello', {
      adapterId: cred.id,
      token: cred.token,
      wire: 1,
    });
    await waitUntil(() => h.store.getAdapter(cred.id)?.health === 'connected');
    early.close();
    await early.closeCode;

    h.clockCtl.advance(60_000);
    const late = await connectAgent(h);
    late.sendFrame('hello', { adapterId: cred.id, token: cred.token, wire: 1 });
    expect(await late.closeCode).toBe(4401);
  });
});

describe('adapter transport: forbidden frames (C-6 taxonomy pin)', () => {
  it('drops a send frame and a wrong-direction frame, socket stays open', async () => {
    const h = await bootAgent();
    const cred = await addAdapter(h);
    const sock = await connectAuthed(h, cred);

    sock.sendFrame('send', { chatGuid: 'iMessage;-;+15551234567', body: 'go' });
    sock.sendFrame('draft.request', {
      correlation: { requestId: 'r1', chatGuid: 'iMessage;-;+15551234567' },
      message: {},
      context: [],
      rule: { id: 'r', name: 'n', respondMode: 'draft' },
      constraints: { maxChars: 2000, deadlineMs: 60000 },
    });

    await waitUntil(() => auditOf(h, 'adapter.no-send-frame').length === 2);
    expect(auditOf(h, 'adapter.no-send-frame')).toEqual([
      { type: 'adapter.no-send-frame', adapterId: cred.id, frameType: 'send' },
      {
        type: 'adapter.no-send-frame',
        adapterId: cred.id,
        frameType: 'draft.request',
      },
    ]);
    // C-6: NO_SEND_FRAME is evidence, not a gate decision.
    expect(auditTypes(h.store)).not.toContain('gate.denied');
    expect(sock.ws.readyState).toBe(sock.ws.OPEN);
  });
});

describe('adapter transport: malformed input', () => {
  it('drops non-JSON, arrays and extra-property frames, then still serves', async () => {
    const h = await bootAgent();
    const cred = await addAdapter(h);
    const sock = await connectAuthed(h, cred);

    sock.send(Buffer.from([0xff, 0x00, 0x13]));
    sock.send('[1,2,3]');
    sock.sendFrame('pong', {}, { extra: 'nope' });

    await waitUntil(
      () => auditOf(h, 'adapter.protocol-violation').length === 3,
      'three violations',
    );
    expect(sock.ws.readyState).toBe(sock.ws.OPEN);

    // Still alive and still parsing: a valid frame after three bad ones.
    sock.sendFrame('send', {});
    await waitUntil(() => auditOf(h, 'adapter.no-send-frame').length === 1);
    expect(sock.ws.readyState).toBe(sock.ws.OPEN);
  });
});

describe('adapter transport: liveness', () => {
  it('tolerates one missed pong and closes on the second', async () => {
    const h = await bootAgent();
    const cred = await addAdapter(h);
    const sock = await connectAuthed(h, cred);

    h.server.agentTransport?.tick();
    await sock.waitFor(1);
    expect((sock.frames[0] as { type: string }).type).toBe('ping');

    h.server.agentTransport?.tick(); // one miss: tolerated
    expect(sock.ws.readyState).toBe(sock.ws.OPEN);
    h.server.agentTransport?.tick(); // two: gone

    expect(await sock.closeCode).toBe(4408);
    await waitUntil(() => h.store.getAdapter(cred.id)?.health === 'unhealthy');
    expect(
      h.broadcasts.filter(
        (b) => (b.frame as { status?: string }).status === 'unhealthy',
      ),
    ).toHaveLength(1);
  });

  it('a pong resets the miss counter', async () => {
    const h = await bootAgent();
    const cred = await addAdapter(h);
    const sock = await connectAuthed(h, cred);
    for (let i = 0; i < 5; i += 1) {
      h.server.agentTransport?.tick();
      await sock.waitFor(i + 1);
      sock.sendFrame('pong', {});
      // Deterministic: wait for the daemon to actually credit the pong,
      // rather than racing one microtask hop against the next tick.
      await waitUntil(
        () => h.server.agentTransport?.missedPongs(cred.id) === 0,
      );
    }
    expect(sock.ws.readyState).toBe(sock.ws.OPEN);
    expect(h.store.getAdapter(cred.id)?.health).toBe('connected');
  });
});

describe('adapter transport: revocation mid-session', () => {
  it('closes a live socket at its next frame and flips health', async () => {
    const h = await bootAgent();
    const cred = await addAdapter(h);
    const sock = await connectAuthed(h, cred);

    expect(h.store.clearAdapterTokens()).toBe(1);
    sock.sendFrame('pong', {});

    expect(await sock.closeCode).toBe(4401);
    await waitUntil(
      () => h.store.getAdapter(cred.id)?.health === 'disconnected',
    );
    expect(auditOf(h, 'adapter.disconnected')).toEqual([
      {
        type: 'adapter.disconnected',
        adapterId: cred.id,
        reason: 'revoked',
      },
    ]);
  });

  it('flips health to disconnected when the adapter hangs up', async () => {
    const h = await bootAgent();
    const cred = await addAdapter(h);
    const sock = await connectAuthed(h, cred);
    sock.close();
    await sock.closeCode;
    await waitUntil(
      () => h.store.getAdapter(cred.id)?.health === 'disconnected',
    );
    expect(
      auditOf(h, 'adapter.disconnected').map(
        (e) => (e as { reason: string }).reason,
      ),
    ).toEqual(['closed']);
  });
});

describe('adapter transport: the bearer exemption is narrow (F-56)', () => {
  it('still refuses an unauthenticated GET on every other route', async () => {
    const h = await bootAgent();
    const res = await h.server.app.inject({
      method: 'GET',
      url: '/v1/adapters',
    });
    expect(res.statusCode).toBe(401);
  });
});
