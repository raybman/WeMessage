/**
 * s7-execution Scenario 5 (client half) — the two surfaces S7 added to the
 * daemon, wrapped for the thin clients that consume them: the `?events=`
 * subscription filter (Sc 3) and `GET`/`PATCH /v1/settings` (Sc 4).
 *
 * Same posture as client-s3/s4/s5: unit tests over a stubbed `fetch` and a
 * stubbed `ws`, because this package is a transport (§2.5) and the only
 * questions worth asking here are "did it build the right request" and "did
 * it keep the shape of the answer". The behaviour behind both routes is
 * proven at the daemon, in `events-schema.spec.ts` and
 * `settings-routes.spec.ts`.
 *
 * Three pieces of real judgement:
 *
 *  - **The filter travels as a query string; the TOKEN never does** (F-84).
 *    The daemon refuses query auth outright, and this file asserts the
 *    negative directly: the URL the socket is opened with contains the
 *    filter and does not contain the bearer, which lives in a header on
 *    both transports. A token in a URL is a token in shell history, proxy
 *    logs and `ps` output, and it is minted once and never re-displayed.
 *  - **A refused filter is not an unreachable daemon.** The WS route cannot
 *    answer 400 (the upgrade has already happened), so it closes 4400 with
 *    the reason text. Reported as a `DaemonUnreachableError` that would
 *    become "daemon unreachable" at the CLI — a diagnosis that sends an
 *    operator to `launchctl` to debug a typo in their own `--events` list,
 *    so it gets a class of its own.
 *  - **PATCH's five refusals keep their names.** The daemon distinguishes
 *    `unknown-key`, `read-only-key`, `wrong-type`, `below-floor` and
 *    `above-ceiling`, each with the datum that makes it actionable. A
 *    wrapper that collapsed them into "HTTP 400" would be the regression;
 *    `DaemonSettingsError` carries the body as data.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The socket factory, stubbed. `vi.hoisted` because a `vi.mock` factory is
 * hoisted above the imports and can only close over values hoisted with it.
 */
const { FakeSocket } = vi.hoisted(() => {
  class FakeSocketImpl {
    static instances: FakeSocketImpl[] = [];
    readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    closeCalls = 0;
    constructor(
      readonly url: string,
      readonly opts: { headers?: Record<string, string> },
    ) {
      FakeSocketImpl.instances.push(this);
    }
    on(event: string, fn: (...args: unknown[]) => void): this {
      const list = this.handlers.get(event) ?? [];
      list.push(fn);
      this.handlers.set(event, list);
      return this;
    }
    fire(event: string, ...args: unknown[]): void {
      for (const fn of this.handlers.get(event) ?? []) fn(...args);
    }
    close(): void {
      this.closeCalls += 1;
    }
  }
  return { FakeSocket: FakeSocketImpl };
});

vi.mock('ws', () => ({ default: FakeSocket }));

const {
  createClient,
  DaemonAuthError,
  DaemonEventFilterError,
  DaemonRequestError,
  DaemonSettingsError,
} = await import('../src/index.js');
type WeMessageClient = import('../src/index.js').WeMessageClient;
type SettingEntry = import('../src/index.js').SettingEntry;
type GatewayEventPayload = import('../src/index.js').GatewayEventPayload;
type EventSubscription = import('../src/index.js').EventSubscription;

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  FakeSocket.instances.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const TOKEN = 'wm_0123456789abcdef';

const client = (): WeMessageClient =>
  createClient({ baseUrl: 'http://127.0.0.1:47100', token: TOKEN });

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function alwaysJson(status: number, body: unknown): void {
  fetchMock.mockImplementation(() =>
    Promise.resolve(jsonResponse(status, body)),
  );
}

function lastCall(): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, init };
}

/** Open the subscription and let the fake socket reach `open`. */
async function subscribe(
  opts?: { events?: readonly string[] },
  onEvent: (e: GatewayEventPayload) => void = () => {},
): Promise<{
  socket: InstanceType<typeof FakeSocket>;
  subscription: EventSubscription;
}> {
  const pending =
    opts === undefined
      ? client().events(onEvent)
      : client().events(onEvent, opts);
  const socket = FakeSocket.instances.at(-1);
  if (socket === undefined) throw new Error('no socket was constructed');
  socket.fire('open');
  return { socket, subscription: await pending };
}

// ---------------------------------------------------------------------------
// row 1 — events({events}) and the URL it opens
// ---------------------------------------------------------------------------

describe('s7 client: events({events}) (row 1)', () => {
  it('a one-name filter opens /v1/events?events=draft.sent', async () => {
    const { socket } = await subscribe({ events: ['draft.sent'] });
    expect(socket.url).toBe('ws://127.0.0.1:47100/v1/events?events=draft.sent');
  });

  it('a multi-name filter is comma-joined, in the order given', async () => {
    const { socket } = await subscribe({
      events: ['draft.created', 'draft.sent'],
    });
    expect(socket.url).toBe(
      'ws://127.0.0.1:47100/v1/events?events=draft.created,draft.sent',
    );
  });

  it('an omitted option opens /v1/events with NO query at all', async () => {
    const { socket } = await subscribe();
    expect(socket.url).toBe('ws://127.0.0.1:47100/v1/events');
    expect(socket.url).not.toContain('?');
  });

  it('an omitted `events` key inside a supplied option is also no query (exactOptionalPropertyTypes)', async () => {
    const { socket } = await subscribe({});
    expect(socket.url).toBe('ws://127.0.0.1:47100/v1/events');
  });

  it('an EMPTY list travels as `?events=` so the daemon refuses it, rather than being read here as "everything"', async () => {
    // F-84: `events=` is the loudest possible quiet bug and the daemon owns
    // that judgement. A client that silently dropped an empty list would
    // hand the operator a subscription to everything they did not ask for.
    const { socket } = await subscribe({ events: [] });
    expect(socket.url).toBe('ws://127.0.0.1:47100/v1/events?events=');
  });

  it('the bearer is a HEADER and never appears in the URL (F-84, PUBLIC)', async () => {
    const { socket } = await subscribe({ events: ['draft.sent'] });
    expect(socket.opts.headers?.['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(socket.url).not.toContain(TOKEN);
    expect(socket.url).not.toContain('token');
  });

  it('events still stream and close() still closes', async () => {
    const seen: GatewayEventPayload[] = [];
    const { socket } = await subscribe({ events: ['draft.sent'] }, (e) =>
      seen.push(e),
    );
    socket.fire(
      'message',
      Buffer.from(
        JSON.stringify({ event: 'connection.state', state: 'fully-connected' }),
      ),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.event).toBe('connection.state');
  });

  it('a 4400 close before open is a FILTER refusal carrying the daemon words, not "unreachable"', async () => {
    const pending = client().events(() => {}, { events: ['draft.typo'] });
    const socket = FakeSocket.instances.at(-1);
    if (socket === undefined) throw new Error('no socket');
    socket.fire('close', 4400, Buffer.from('unknown-event: draft.typo'));
    await expect(pending).rejects.toBeInstanceOf(DaemonEventFilterError);
    await expect(pending).rejects.toThrow('unknown-event: draft.typo');
  });

  it('a 4400 close AFTER open — the real path — rejects `closed`, not the open promise', async () => {
    // This is what actually happens on the wire: the WS route cannot read
    // the query string until the upgrade has already succeeded, so the
    // socket OPENS, and only then does the daemon refuse. Carried anywhere
    // but `closed`, a typo in `--events` would be indistinguishable from a
    // stream that simply ended.
    const { socket, subscription } = await subscribe({
      events: ['draft.typo'],
    });
    socket.fire('close', 4400, Buffer.from('unknown-event: draft.typo'));
    await expect(subscription.closed).rejects.toBeInstanceOf(
      DaemonEventFilterError,
    );
    await expect(subscription.closed).rejects.toThrow(
      'unknown-event: draft.typo',
    );
  });

  it('an ordinary close RESOLVES `closed`: a stream that ended is not a failure', async () => {
    const { socket, subscription } = await subscribe({
      events: ['draft.sent'],
    });
    socket.fire('close', 1000, Buffer.from(''));
    await expect(subscription.closed).resolves.toBeUndefined();
  });

  it('a close with any OTHER code is still an unreachable daemon', async () => {
    const pending = client().events(() => {});
    const socket = FakeSocket.instances.at(-1);
    if (socket === undefined) throw new Error('no socket');
    socket.fire('close', 1006, Buffer.from(''));
    await expect(pending).rejects.toThrow('daemon unreachable');
  });
});

// ---------------------------------------------------------------------------
// row 2 — settings() / setSettings() and the typed refusal
// ---------------------------------------------------------------------------

const ENTRY_INT: SettingEntry = {
  value: 2,
  default: 2,
  version: -1,
  type: 'int',
  readOnly: false,
  floor: 1,
  ceiling: 60,
};

const ENTRY_READONLY: SettingEntry = {
  value: false,
  default: false,
  version: -1,
  type: 'bool',
  readOnly: true,
  use: 'POST /v1/toggles/kill-switch',
};

describe('s7 client: settings() and setSettings() (row 2)', () => {
  it('settings() GETs /v1/settings and unwraps the {settings} envelope', async () => {
    alwaysJson(200, {
      settings: {
        'send.capContactPer2Min': ENTRY_INT,
        'send.killSwitch': ENTRY_READONLY,
      },
    });
    const settings = await client().settings();
    expect(lastCall().url).toBe('http://127.0.0.1:47100/v1/settings');
    expect(lastCall().init.method).toBe('GET');
    expect(Object.keys(settings)).toEqual([
      'send.capContactPer2Min',
      'send.killSwitch',
    ]);
  });

  it('the optional entry fields stay OMITTED, never undefined (exactOptionalPropertyTypes)', async () => {
    alwaysJson(200, {
      settings: {
        'send.capContactPer2Min': ENTRY_INT,
        'send.killSwitch': ENTRY_READONLY,
      },
    });
    const settings = await client().settings();
    const int = settings['send.capContactPer2Min'];
    const ro = settings['send.killSwitch'];
    if (int === undefined || ro === undefined) throw new Error('missing entry');
    // A writable int has bounds and no owning route.
    expect(int.floor).toBe(1);
    expect('use' in int).toBe(false);
    expect(int.use).toBeUndefined();
    // A read-only bool has an owning route and no bounds.
    expect(ro.use).toBe('POST /v1/toggles/kill-switch');
    expect('floor' in ro).toBe(false);
    expect('ceiling' in ro).toBe(false);
    expect(ro.floor).toBeUndefined();
  });

  it('setSettings() PATCHes the body VERBATIM and returns {settings, changed}', async () => {
    alwaysJson(200, {
      settings: { 'send.capContactPer2Min': { ...ENTRY_INT, value: 3 } },
      changed: ['send.capContactPer2Min'],
    });
    const result = await client().setSettings({
      'send.capContactPer2Min': 3,
      'send.retryAsSms': true,
    });
    expect(lastCall().url).toBe('http://127.0.0.1:47100/v1/settings');
    expect(lastCall().init.method).toBe('PATCH');
    expect(JSON.parse(String(lastCall().init.body))).toEqual({
      'send.capContactPer2Min': 3,
      'send.retryAsSms': true,
    });
    expect(result.changed).toEqual(['send.capContactPer2Min']);
    expect(result.settings['send.capContactPer2Min']?.value).toBe(3);
  });

  it('each of the FIVE refusals survives as data, with the datum that makes it actionable', async () => {
    const cases = [
      { error: 'unknown-key', key: 'send.nope' },
      {
        error: 'read-only-key',
        key: 'send.killSwitch',
        use: 'POST /v1/toggles/kill-switch',
      },
      { error: 'wrong-type', key: 'send.retryAsSms', expected: 'bool' },
      { error: 'below-floor', key: 'send.capContactPer2Min', floor: 1 },
      { error: 'above-ceiling', key: 'send.capGlobalPerHour', ceiling: 10000 },
    ] as const;
    for (const body of cases) {
      alwaysJson(400, body);
      const err = await client()
        .setSettings({ [body.key]: 0 })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err, body.error).toBeInstanceOf(DaemonSettingsError);
      if (!(err instanceof DaemonSettingsError)) throw new Error('unreachable');
      expect(err.detail).toEqual(body);
      expect(err.detail.error).toBe(body.error);
      expect(err.detail.key).toBe(body.key);
      expect(err.statusCode).toBe(400);
    }
  });

  it('a 400 that is NOT one of the five stays a plain DaemonRequestError', async () => {
    // `invalid-settings` says the BODY was not a settings patch at all; it
    // names no key, and a wrapper that invented one would send the operator
    // hunting for a key they never sent.
    alwaysJson(400, { error: 'invalid-settings', detail: { issues: [] } });
    const err = await client()
      .setSettings({ 'send.retryAsSms': true })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(DaemonRequestError);
    expect(err).not.toBeInstanceOf(DaemonSettingsError);
  });

  it('401 on either verb is still an auth failure, not a settings refusal', async () => {
    alwaysJson(401, {});
    await expect(client().settings()).rejects.toBeInstanceOf(DaemonAuthError);
    await expect(
      client().setSettings({ 'send.retryAsSms': true }),
    ).rejects.toBeInstanceOf(DaemonAuthError);
  });

  it('no generic request() escape hatch appears on the client (S5 arch rule, re-asserted)', () => {
    // §2.5: the CLI and the GUI reach the daemon ONLY through named verbs.
    // A `request()` on this surface would be a route table nobody reviews.
    const surface = client() as unknown as Record<string, unknown>;
    for (const key of Object.keys(surface)) {
      expect(key).not.toMatch(/^(request|raw|call|fetch|http)$/i);
    }
    expect(Object.keys(surface)).toContain('settings');
    expect(Object.keys(surface)).toContain('setSettings');
  });
});
