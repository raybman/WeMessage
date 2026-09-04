/**
 * s5-execution Scenario 5 — the adapter-transport harness.
 *
 * `draft-harness.ts` builds a server with `app.inject`, which never opens a
 * real socket. WS needs a bound port, so this wraps `boot()` with a real
 * `startServer` listen and adds a scripted fake adapter socket that records
 * every frame it receives and can send raw bytes, not just well-formed ones
 * (Scenario 5's malformed-input rows need that).
 */
import WebSocket from 'ws';
import { startServer } from '@wemessage/daemon';
import {
  boot,
  cleanupHarness,
  type BootOptions,
  type Harness,
} from './draft-harness.js';

export interface AgentHarness extends Harness {
  baseUrl: string;
}

const ports: Array<() => void> = [];
const sockets: WebSocket[] = [];
const harnesses: AgentHarness[] = [];

export async function bootAgent(opts: BootOptions = {}): Promise<AgentHarness> {
  const h = await boot(opts);
  const port = await startServer(h.server);
  const agent = { ...h, baseUrl: `ws://127.0.0.1:${String(port)}` };
  harnesses.push(agent);
  return agent;
}

export async function cleanupAgentHarness(): Promise<void> {
  // Close every client socket and let its server-side 'close' handler run
  // BEFORE the store goes away: that handler writes the adapter.disconnected
  // audit row, and a store closed out from under it would surface as an
  // unhandled exception that has nothing to do with the test that ran.
  await Promise.all(
    sockets.splice(0).map(
      (ws) =>
        new Promise<void>((resolve) => {
          if (ws.readyState === ws.CLOSED) return resolve();
          ws.on('close', () => resolve());
          ws.close();
        }),
    ),
  );
  // Drain against the SERVER's view, not the client's: the client's 'close'
  // fires first, and the row the server writes on its side is exactly the one
  // that would explode against a closed store.
  for (const h of harnesses.splice(0)) {
    h.server.agentTransport?.closeAll();
    await waitUntil(
      () => (h.server.agentTransport?.openSessions() ?? 0) === 0,
      'adapter sessions drained',
    );
  }
  for (const close of ports.splice(0)) close();
  await cleanupHarness();
}

export interface FakeAdapterSocket {
  ws: WebSocket;
  frames: unknown[];
  closeCode: Promise<number>;
  closeReason: Promise<string>;
  waitFor(n: number): Promise<void>;
  send(raw: string | Buffer): void;
  sendFrame(
    type: string,
    payload: unknown,
    overrides?: Record<string, unknown>,
  ): void;
  close(): void;
}

/** A raw socket to /v1/agent. Auth happens over `hello`, not a header. */
export function connectAgent(h: AgentHarness): Promise<FakeAdapterSocket> {
  const ws = new WebSocket(`${h.baseUrl}/v1/agent`);
  sockets.push(ws);
  const frames: unknown[] = [];
  let notify: (() => void) | null = null;
  ws.on('message', (data) => {
    frames.push(JSON.parse(String(data)));
    notify?.();
  });
  let resolveReason: (r: string) => void = () => {};
  const closeReason = new Promise<string>((resolve) => {
    resolveReason = resolve;
  });
  const closeCode = new Promise<number>((resolve) => {
    ws.on('close', (code, reason) => {
      resolveReason(String(reason));
      resolve(code);
    });
  });
  return new Promise((resolve, reject) => {
    ws.on('open', () =>
      resolve({
        ws,
        frames,
        closeCode,
        closeReason,
        waitFor(n) {
          if (frames.length >= n) return Promise.resolve();
          return new Promise((res) => {
            notify = () => {
              if (frames.length >= n) res();
            };
          });
        },
        send(raw) {
          ws.send(raw);
        },
        sendFrame(type, payload, overrides) {
          ws.send(
            JSON.stringify({
              v: 1,
              id: `01${'F'.repeat(24)}`,
              type,
              ts: h.clockCtl.clock.now(),
              payload,
              ...overrides,
            }),
          );
        },
        close() {
          ws.close();
        },
      }),
    );
    ws.on('error', reject);
  });
}

/** Register an adapter through the real route and keep its one-shot token. */
export async function addAdapter(
  h: AgentHarness,
  id = 'echo-1',
  kind = 'echo',
): Promise<{ id: string; token: string }> {
  const res = await h.server.app.inject({
    method: 'POST',
    url: '/v1/adapters',
    headers: h.headers,
    payload: { id, kind, displayName: id },
  });
  if (res.statusCode !== 201) throw new Error(`addAdapter: ${res.statusCode}`);
  return { id, token: (res.json() as { token: string }).token };
}

/** Connect + hello + wait for the socket to be authenticated. */
export async function connectAuthed(
  h: AgentHarness,
  cred: { id: string; token: string },
): Promise<FakeAdapterSocket> {
  const sock = await connectAgent(h);
  sock.sendFrame('hello', { adapterId: cred.id, token: cred.token, wire: 1 });
  await waitUntil(() => h.store.getAdapter(cred.id)?.health === 'connected');
  return sock;
}

/** Poll a predicate off the event loop — no wall-clock sleeps in assertions. */
export async function waitUntil(
  pred: () => boolean,
  label = 'condition',
): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (pred()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`waitUntil: ${label} never became true`);
}
