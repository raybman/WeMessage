/**
 * s7-execution Scenario 3 ★ CHECKPOINT — `GET /v1/events/sse`, the `?events=`
 * filter on BOTH transports, and WS/SSE parity. Ratchet update #21.
 *
 * **The claim this file exists to make.** A stranger writing an adapter picks
 * a transport for reasons that have nothing to do with us: a browser reaches
 * for `EventSource`, a shell script reaches for `curl -N`, a Node process
 * reaches for a WebSocket. Whichever they pick, they must get the SAME BYTES.
 * The moment the two wires can disagree — about a payload key, about what a
 * filter means, about whether the greeting arrives — the protocol reference
 * becomes a document that is true of one transport and approximately true of
 * the other, and the person who finds out is a stranger debugging at 2am.
 *
 * **So the parity rows are the strong version, deliberately.** They boot a
 * REAL daemon on a REAL port, open a REAL WebSocket and a REAL SSE stream at
 * the same time with the same filter, provoke the same events through the one
 * `sink` every production emitter already uses, and compare the bytes after
 * stripping transport framing. A test that called a shared serializer twice
 * and asserted the two results matched would prove only that `JSON.stringify`
 * is deterministic; it would stay green through a route that forgot the
 * greeting, mis-framed `data:`, applied the filter in the wrong place, or
 * dropped a key on its way out. Row 1's last sub-row goes one step further
 * and provokes `toggle.changed` through `POST /v1/toggles/kill-switch` — a
 * shipped route, not an injected fixture — so at least one parity assertion
 * rides a path no test wrote.
 *
 * **What makes parity structural rather than lucky (the GREEN it drove).**
 * `broadcast()` serializes ONCE and applies the filter ONCE, then hands both
 * the payload and that single string to every subscriber. WS writes the
 * string; SSE wraps the same string in `data:`. `addClient` is now sugar over
 * `subscribe`, so the WS path is not a separate implementation that happens
 * to agree — it is the same implementation. The named teeth (`TN-filter-ws-only`)
 * moves the filter back into the WS wrapper, which is the natural place to put
 * it if you start from the WS code, and row 3 fails immediately.
 *
 * **The negative rows are the point (C-3).** An unknown name in `?events=` is
 * a 400 on SSE and a 4400 close on WS, never a silently-ignored token; an
 * empty `?events=` is that same refusal rather than "everything", because a
 * monitor that silently subscribes to the whole firehose after a typo is a
 * monitor that will never tell you it stopped watching `draft.sent`. And
 * `?token=` is not a credential (F-84): the adapter/operator token is minted
 * once and never re-displayed, so a query string — which lands in shell
 * history, proxy logs and `ps` output — is a leak path we decline to open,
 * even though it is the only way `EventSource` could authenticate itself in a
 * browser. There is no browser client in this repo; there is a CLI and there
 * are adapters, and both can set a header.
 *
 * Every handle is synthetic (`+1555…`), every payload comes from the Part 3
 * fixtures, and no readiness anywhere is a sleep.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GATEWAY_EVENT_NAMES,
  FRAME_SPECS,
  type GatewayEventName,
  type GatewayEventPayload,
} from '@wemessage/protocol';
import { schemaErrors, type JsonSchema } from '@wemessage/fixtures';
import { SETTING_KILL_SWITCH, systemActor } from '@wemessage/core';
import type { SseTimer } from '@wemessage/daemon';
import { auditEvents } from './helpers/draft-harness.js';
import {
  bootAgent,
  cleanupAgentHarness,
  type AgentHarness,
} from './helpers/agent-harness.js';
import { openSse, probeHttp, type SseStream } from './helpers/sse-client.js';
import {
  PORT_IMPORTER_ALLOWLIST,
  ROUTE_TABLE,
} from './transport-surface.snapshot.js';

const SSE_PATH = '/v1/events/sse';
const WS_PATH = '/v1/events';

const fixtureDir = fileURLToPath(
  new URL('../../../fixtures/events/', import.meta.url),
);
const schemaDir = fileURLToPath(
  new URL('../../protocol/src/schemas/events/', import.meta.url),
);
const sseRouteFile = fileURLToPath(
  new URL('../src/routes/events-sse.ts', import.meta.url),
);

function fixture(name: GatewayEventName): GatewayEventPayload {
  return JSON.parse(
    readFileSync(`${fixtureDir}${name}.json`, 'utf8'),
  ) as GatewayEventPayload;
}

function eventSchema(name: GatewayEventName): JsonSchema {
  return JSON.parse(
    readFileSync(`${schemaDir}${name}.json`, 'utf8'),
  ) as JsonSchema;
}

/* --------------------------------------------------------------------- *
 * A WS client that keeps the bytes, not a parse of them. Byte identity is
 * the claim, so nothing here may normalise anything on the way in.
 * --------------------------------------------------------------------- */

interface WsStream {
  frames: string[];
  waitFor(n: number, label?: string): Promise<void>;
  closeCode: Promise<number>;
  closeReason: Promise<string>;
  close(): Promise<void>;
}

const openWebSockets: WebSocket[] = [];
const openStreams: SseStream[] = [];

function openWs(
  h: AgentHarness,
  query = '',
  headers: Record<string, string> = h.headers,
): Promise<WsStream> {
  const ws = new WebSocket(`${h.baseUrl}${WS_PATH}${query}`, { headers });
  openWebSockets.push(ws);
  const frames: string[] = [];
  let notify: (() => void) | null = null;
  let resolveReason: (r: string) => void = () => {};
  const closeReason = new Promise<string>((res) => {
    resolveReason = res;
  });
  const closeCode = new Promise<number>((res) => {
    ws.on('close', (code, reason) => {
      resolveReason(reason.toString('utf8'));
      notify?.();
      res(code);
    });
  });
  ws.on('message', (data) => {
    // `data` is a Buffer; utf8 decoding is injective, so comparing decoded
    // strings IS comparing bytes — and it makes a failure readable.
    frames.push((data as Buffer).toString('utf8'));
    notify?.();
  });
  return new Promise<WsStream>((resolve, reject) => {
    ws.on('error', reject);
    ws.on('open', () =>
      resolve({
        frames,
        closeCode,
        closeReason,
        waitFor: (n, label) =>
          new Promise<void>((ok, fail) => {
            if (frames.length >= n) return ok();
            const budget = setTimeout(() => {
              notify = null;
              fail(
                new Error(
                  `openWs: timed out waiting for ${label ?? `${String(n)} frames`} (have ${String(frames.length)})`,
                ),
              );
            }, 4000);
            notify = () => {
              if (frames.length < n) return;
              clearTimeout(budget);
              notify = null;
              ok();
            };
          }),
        close: () =>
          new Promise<void>((done) => {
            if (ws.readyState === ws.CLOSED) return done();
            ws.on('close', () => done());
            ws.close();
          }),
      }),
    );
  });
}

/** The keepalive seam (C-5): a timer the test fires by hand, never a clock. */
interface ManualTimers {
  timer: SseTimer;
  registered: Array<{ everyMs: number; cancelled: boolean }>;
  /** One tick = one `everyMs` elapsing on every live timer. */
  fire(): void;
  live(): number;
}

function manualTimers(): ManualTimers {
  const entries: Array<{
    everyMs: number;
    cancelled: boolean;
    onTick: () => void;
  }> = [];
  return {
    registered: entries,
    timer: (onTick, everyMs) => {
      const entry = { everyMs, cancelled: false, onTick };
      entries.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    fire() {
      for (const entry of entries) if (!entry.cancelled) entry.onTick();
    },
    live: () => entries.filter((e) => !e.cancelled).length,
  };
}

function httpUrl(h: AgentHarness): string {
  return h.baseUrl.replace(/^ws:/, 'http:');
}

async function bothStreams(
  h: AgentHarness,
  query = '',
): Promise<{ ws: WsStream; sse: SseStream }> {
  const ws = await openWs(h, query);
  const sse = await openSse(httpUrl(h), `${SSE_PATH}${query}`, {
    headers: h.headers,
  });
  openStreams.push(sse);
  return { ws, sse };
}

afterEach(async () => {
  await Promise.all(openStreams.splice(0).map((s) => s.close()));
  await Promise.all(
    openWebSockets.splice(0).map(
      (ws) =>
        new Promise<void>((done) => {
          if (ws.readyState === ws.CLOSED) return done();
          ws.on('close', () => done());
          ws.close();
        }),
    ),
  );
  await cleanupAgentHarness();
});

describe('SSE, event filters and WS/SSE parity (s7 Scenario 3, ★)', () => {
  it('row 1: every §3.4 event reaches WS and SSE as identical bytes, valid against its schema', async () => {
    const h = await bootAgent({ greeting: true });
    const { ws, sse } = await bothStreams(h);

    // Both transports open with the SAME greeting, and it is the same bytes.
    await ws.waitFor(1, 'ws greeting');
    await sse.waitForEvents(1, 'sse greeting');
    expect(sse.events[0]?.event).toBe('connection.state');
    expect(sse.events[0]?.data).toBe(ws.frames[0]);

    for (const [i, name] of GATEWAY_EVENT_NAMES.entries()) {
      const payload = fixture(name);
      h.sink.broadcast(payload);
      // greeting + one frame per event so far
      await ws.waitFor(i + 2, `ws frame for ${name}`);
      await sse.waitForEvents(i + 2, `sse frame for ${name}`);

      // exactly one frame each, no duplicates and no dropped events
      expect(ws.frames).toHaveLength(i + 2);
      expect(sse.events).toHaveLength(i + 2);

      const wsFrame = ws.frames[i + 1] as string;
      const sseFrame = sse.events[i + 1];
      expect(sseFrame?.event, `${name}: SSE event: field`).toBe(name);
      // The load-bearing assertion of the whole scenario.
      expect(sseFrame?.data, `${name}: SSE data bytes != WS bytes`).toBe(
        wsFrame,
      );
      // ...and the id counter is per-connection, from 1, greeting included.
      expect(sseFrame?.id).toBe(String(i + 2));

      const schema = eventSchema(name);
      expect(schemaErrors(schema, JSON.parse(wsFrame)), `${name}: WS`).toEqual(
        [],
      );
      expect(
        schemaErrors(schema, JSON.parse(sseFrame?.data ?? '')),
        `${name}: SSE`,
      ).toEqual([]);
      expect(JSON.parse(wsFrame)).toEqual(payload);
    }
  });

  it('row 1 (provoked, not injected): POST /v1/toggles/kill-switch lands identically on both wires', async () => {
    const h = await bootAgent({ greeting: true });
    const { ws, sse } = await bothStreams(h);
    await ws.waitFor(1, 'ws greeting');
    await sse.waitForEvents(1, 'sse greeting');

    const res = await h.server.app.inject({
      method: 'POST',
      url: '/v1/toggles/kill-switch',
      headers: h.headers,
      payload: { on: true },
    });
    expect(res.statusCode).toBe(200);

    await ws.waitFor(2, 'ws toggle.changed');
    await sse.waitForEvents(2, 'sse toggle.changed');
    const wsFrame = ws.frames[1] as string;
    expect(sse.events[1]?.event).toBe('toggle.changed');
    expect(sse.events[1]?.data).toBe(wsFrame);
    const parsed = JSON.parse(wsFrame) as { event: string; key: string };
    expect(parsed.event).toBe('toggle.changed');
    expect(parsed.key).toBe(SETTING_KILL_SWITCH);
    expect(schemaErrors(eventSchema('toggle.changed'), parsed)).toEqual([]);
  });

  it('row 2: the audit row is already durable when a subscriber runs (§1.8)', async () => {
    const h = await bootAgent({ greeting: true });
    const seen: Array<{ event: string; auditCount: number }> = [];
    // A subscriber that reads the store SYNCHRONOUSLY inside the callback is
    // the only way to tell "appended then broadcast" from the reverse: the
    // final log looks the same either way, and the difference only shows up
    // as a lost record on a crash between the two.
    const off = h.sink.subscribe((payload) => {
      seen.push({
        event: payload.event,
        auditCount: auditEvents(h.store).length,
      });
    });

    let expected = 0;
    for (const name of GATEWAY_EVENT_NAMES) {
      h.sink.append(
        { type: 'toggle.changed', key: `probe.${name}`, on: true },
        systemActor('expiry'),
      );
      expected += 1;
      h.sink.broadcast(fixture(name));
      const last = seen.at(-1);
      expect(last?.event, name).toBe(name);
      expect(
        last?.auditCount,
        `${name}: broadcast preceded its audit row`,
      ).toBe(expected);
    }
    off();
    expect(seen).toHaveLength(GATEWAY_EVENT_NAMES.length);
  });

  it('row 3: ?events= filters both transports identically, and the greeting is never filtered out', async () => {
    const h = await bootAgent({ greeting: true });
    const query = '?events=draft.created,draft.sent';
    const { ws, sse } = await bothStreams(h, query);
    await ws.waitFor(1, 'ws greeting');
    await sse.waitForEvents(1, 'sse greeting');

    for (const name of GATEWAY_EVENT_NAMES) h.sink.broadcast(fixture(name));

    await ws.waitFor(3, 'ws filtered burst');
    await sse.waitForEvents(3, 'sse filtered burst');
    // An unfiltered subscriber would now hold 18. Give a wrong filter a
    // chance to show itself before asserting the count.
    const unfiltered = await openWs(h);
    await unfiltered.waitFor(1, 'settling probe');

    const names = (frames: string[]): string[] =>
      frames.map((f) => (JSON.parse(f) as { event: string }).event);
    expect(names(ws.frames)).toEqual([
      'connection.state',
      'draft.created',
      'draft.sent',
    ]);
    expect(sse.events.map((e) => e.event)).toEqual([
      'connection.state',
      'draft.created',
      'draft.sent',
    ]);
    expect(sse.events.map((e) => e.data)).toEqual(ws.frames);
  });

  it('row 4: SSE authenticates by header only — ?token= is not a credential (F-84)', async () => {
    const h = await bootAgent({ greeting: true });
    const token = h.headers.authorization.replace('Bearer ', '');

    const viaQuery = await probeHttp(
      httpUrl(h),
      `${SSE_PATH}?token=${encodeURIComponent(token)}`,
    );
    expect(viaQuery.status).toBe(401);
    expect(JSON.parse(viaQuery.body)).toEqual({ error: 'unauthorized' });
    // The real token must not have been echoed back in the refusal.
    expect(viaQuery.body).not.toContain(token);

    const noAuth = await probeHttp(httpUrl(h), SSE_PATH);
    expect(noAuth.status).toBe(401);

    const withHeader = await openSse(httpUrl(h), SSE_PATH, {
      headers: h.headers,
    });
    openStreams.push(withHeader);
    expect(withHeader.status).toBe(200);
    expect(withHeader.headers['content-type']).toContain('text/event-stream');
    expect(withHeader.headers['cache-control']).toContain('no-cache');
    // A proxy that buffers turns a live stream into a stalled one.
    expect(withHeader.headers['x-accel-buffering']).toBe('no');
    expect(withHeader.headers['content-encoding']).toBeUndefined();
  });

  it('row 5: an unknown event name is refused, not ignored (SSE 400, WS 4400)', async () => {
    const h = await bootAgent({ greeting: true });
    const query = '?events=draft.created,draft.typo';
    const before = auditEvents(h.store).length;
    const broadcastsBefore = h.broadcasts.length;

    const refused = await probeHttp(httpUrl(h), `${SSE_PATH}${query}`, {
      headers: h.headers,
    });
    expect(refused.status).toBe(400);
    expect(JSON.parse(refused.body)).toEqual({
      error: 'unknown-event',
      name: 'draft.typo',
    });

    const ws = await openWs(h, query);
    expect(await ws.closeCode).toBe(4400);
    expect(await ws.closeReason).toContain('unknown-event');
    // Never a greeting: a refused subscription must not look briefly live.
    expect(ws.frames).toEqual([]);

    expect(auditEvents(h.store)).toHaveLength(before);
    expect(h.broadcasts).toHaveLength(broadcastsBefore);
  });

  it('row 6: an empty ?events= is a typo, not "everything"', async () => {
    const h = await bootAgent({ greeting: true });
    const refused = await probeHttp(httpUrl(h), `${SSE_PATH}?events=`, {
      headers: h.headers,
    });
    expect(refused.status).toBe(400);
    expect(JSON.parse(refused.body)).toEqual({
      error: 'unknown-event',
      name: '',
    });

    const ws = await openWs(h, '?events=');
    expect(await ws.closeCode).toBe(4400);
    expect(ws.frames).toEqual([]);

    // ...while an ABSENT `events` still means everything.
    const all = await openSse(httpUrl(h), SSE_PATH, { headers: h.headers });
    openStreams.push(all);
    expect(all.status).toBe(200);
    await all.waitForEvents(1, 'greeting on the unfiltered stream');
    h.sink.broadcast(fixture('draft.failed'));
    await all.waitForEvents(2, 'unfiltered draft.failed');
    expect(all.events[1]?.event).toBe('draft.failed');
  });

  it('row 7: the route and its HEAD twin are pinned, and HEAD registers no subscriber', async () => {
    expect(ROUTE_TABLE).toContain(`GET ${SSE_PATH}`);
    expect(ROUTE_TABLE).toContain(`HEAD ${SSE_PATH}`);
    // Ratchet #21 arithmetic: one GET is +2 (itself plus fastify's auto-HEAD
    // twin); a POST would be +1. 62 -> 64.
    expect(ROUTE_TABLE).toHaveLength(64);

    const h = await bootAgent({ greeting: true });
    const before = h.sink.subscriberCount();
    const head = await probeHttp(httpUrl(h), SSE_PATH, {
      method: 'HEAD',
      headers: h.headers,
    });
    expect(head.status).toBe(200);
    expect(head.headers['content-type']).toContain('text/event-stream');
    expect(head.body).toBe('');
    expect(h.sink.subscriberCount()).toBe(before);

    // ...and it is bearer-gated like every other route (C-7).
    const unauthed = await probeHttp(httpUrl(h), SSE_PATH, { method: 'HEAD' });
    expect(unauthed.status).toBe(401);
  });

  it('row 8: 50 SSE connect/disconnect cycles leak no subscribers', async () => {
    const h = await bootAgent({ greeting: true });
    const timers = manualTimers();
    const before = h.sink.subscriberCount();
    for (let i = 0; i < 50; i += 1) {
      const sse = await openSse(httpUrl(h), SSE_PATH, { headers: h.headers });
      expect(sse.status).toBe(200);
      await sse.waitForEvents(1, `greeting on cycle ${String(i)}`);
      expect(h.sink.subscriberCount()).toBe(before + 1);
      await sse.close();
      // The unsubscribe rides the socket's own close, so wait for the sink to
      // observe it rather than assuming the same tick.
      await waitUntilCount(h, before, `cycle ${String(i)} unsubscribe`);
    }
    expect(h.sink.subscriberCount()).toBe(before);
    expect(timers.live()).toBe(0);
  });

  it('row 9: the keepalive is one comment per injected tick, and the WS sees nothing', async () => {
    const timers = manualTimers();
    const h = await bootAgent({ greeting: true, sse: { timer: timers.timer } });
    const { ws, sse } = await bothStreams(h);
    await ws.waitFor(1, 'ws greeting');
    await sse.waitForEvents(1, 'sse greeting');

    expect(timers.registered).toHaveLength(1);
    // 15 s (§1.7). Pinned so "keepalive exists" cannot pass with a 15-minute
    // interval that every proxy on the path would idle-kill first.
    expect(timers.registered[0]?.everyMs).toBe(15_000);

    timers.fire();
    await sse.waitForComments(1, 'keepalive comment');
    expect(sse.comments).toEqual([': keepalive']);
    // A comment is not an event: it must not appear as a frame on either wire.
    expect(sse.events).toHaveLength(1);
    expect(ws.frames).toHaveLength(1);
    expect(sse.raw).toContain(': keepalive\n\n');

    // ...and it stops when the client goes away. The WS client is still
    // subscribed, so the sink drops to ONE, not to zero: a teardown that
    // detached everybody would be a bug wearing a passing test.
    const withBoth = h.sink.subscriberCount();
    expect(withBoth).toBe(2);
    await sse.close();
    await waitUntilCount(h, 1, 'keepalive teardown');
    expect(timers.live()).toBe(0);
  });

  it('row 10: the SSE route offers no path toward a SendBackend (INV-2)', () => {
    // Comments stripped first: this row is about what the module can REACH,
    // not what its prose is allowed to discuss. The header explains at length
    // why there is no send path here, and a scan that failed on the
    // explanation would push the explanation out of the file.
    const source = stripComments(readFileSync(sseRouteFile, 'utf8'));
    expect(source).not.toContain('SendBackend');
    expect(source).not.toContain('ChatDbReader');
    expect(source).not.toContain('dispatchApproved');
    expect(source).not.toMatch(/from '[^']*sending/);
    expect(source).not.toMatch(/from '[^']*@wemessage\/core/);
    expect(PORT_IMPORTER_ALLOWLIST).toHaveLength(15);
    expect(PORT_IMPORTER_ALLOWLIST).not.toContain(
      'packages/daemon/src/routes/events-sse.ts',
    );
    // The wire has nine frames and none of them is a send (INV-2).
    expect(Object.keys(FRAME_SPECS)).toHaveLength(9);
    expect(Object.keys(FRAME_SPECS)).not.toContain('send');
  });
});

/** Poll the sink's own view — never a sleep, never the client's opinion. */
async function waitUntilCount(
  h: AgentHarness,
  target: number,
  label: string,
): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (h.sink.subscriberCount() === target) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(
    `subscriberCount never reached ${String(target)} (${label}); saw ${String(h.sink.subscriberCount())}`,
  );
}

/** Block and line comments out; string contents are left alone. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}
