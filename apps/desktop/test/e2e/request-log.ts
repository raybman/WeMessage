/**
 * s8 Sc 4 — the wire, observed.
 *
 * Several rows in this scenario are claims about what the app did NOT do:
 * "no request reaches the daemon", "exactly one 401, because the app does
 * not retry auth failures in a loop". Neither is answerable from inside the
 * app (asking the thing under test whether it behaved is S7 §0.1's "our
 * TypeScript agreeing with our TypeScript") and neither is answerable from
 * the daemon, because Fastify's hooks are sealed once it is listening.
 *
 * So the harness puts a TCP tee in front. The app is pointed at this port;
 * every byte is forwarded verbatim to the real daemon and back, and the
 * upstream direction is parsed far enough to name each request. It is a
 * tee, not a mock: the daemon on the other side is the real one, the
 * responses are its own, and nothing here can change a verdict.
 *
 * Two deliberate limits, stated rather than hidden:
 *
 *  - Upstream parsing STOPS at an `Upgrade:` request. After the 101 the
 *    connection carries WebSocket frames, and continuing to look for
 *    request lines in binary frames would invent requests that were never
 *    made. The upgrade itself is logged, which is the request that matters.
 *  - Downstream is scanned for status lines rather than fully parsed
 *    (chunked transfer-encoding would desync a length-driven parser). A
 *    status line is only counted at a message boundary — the start of the
 *    stream or immediately after a header terminator — so a body would have
 *    to contain that exact preamble to be miscounted.
 */
import { connect, createServer, type Server, type Socket } from 'node:net';

export interface LoggedRequest {
  readonly method: string;
  readonly url: string;
}

export interface RequestLog {
  /** The port the app should be pointed at. */
  readonly port: number;
  /** Every HTTP request line seen upstream, in the order it was sent. */
  requests(): LoggedRequest[];
  /** Every HTTP status code seen downstream, in arrival order. */
  statuses(): number[];
  /**
   * Cut every live connection and refuse new ones, keeping the port BOUND.
   *
   * s8 Sc5's outage, and the reason it is done here rather than by stopping
   * the daemon: the daemon has to keep running and keep recording, so that
   * what happened during the outage is a real thing the app can go and
   * discover afterwards. Stopping it would make the gap unobservable and
   * turn the resync row into a test of an empty list.
   *
   * The port stays bound so the app's reconnect attempts are ACCEPTED and
   * then dropped, which is the shape of a daemon that restarted underneath
   * a running client. A refused connection is the other shape; both are
   * transients and both retry.
   */
  sever(): void;
  /** Let connections through again. */
  restore(): void;
  /** How many connections have been accepted since boot. */
  connections(): number;
  /**
   * Rewrite the FIRST upstream occurrence of `from` to `to`, once, and then
   * never again. Returns nothing; `rewrites()` says whether it fired.
   *
   * s8 Sc15, and the one thing in this file that is not a passive tee — so
   * it is worth saying exactly what it is for and what it is not.
   *
   * `link:stream-refused` is a real exit state with real product copy ("that
   * is a version mismatch rather than a fault"), and it is reached when the
   * daemon accepts the websocket upgrade and then closes it with 4400
   * because it could not parse the event filter it was sent. `/v1/events`
   * closes exactly one way and that is the way. But this desktop app sends
   * no `?events=` filter at all — `live.events(onEvent)` is called with no
   * options — so the state cannot arise between THIS app and THIS daemon,
   * today, at these two versions.
   *
   * It can arise the moment those two versions differ, which is the whole
   * point of the state: a newer app subscribing to an event name an older
   * daemon does not know, or a filter syntax that changed under it. A wizard
   * row that skipped the state because the current pair happens to agree
   * would be a row that tests the pair rather than the product.
   *
   * So the skew is injected at the wire, not faked in the app: the request
   * line the app really sent is altered in flight, the REAL daemon really
   * refuses it, and the app really receives the real 4400 from the real
   * `parseEventFilter`. Nothing downstream is simulated. The rewrite is
   * counted so that a silent no-op — a chunk boundary landing mid-needle, a
   * request line that changed shape — fails the row instead of quietly
   * turning it into a test of the happy path.
   */
  rewriteOnce(from: string, to: string): void;
  /** How many times `rewriteOnce`'s needle has actually been replaced. */
  rewrites(): number;
  close(): Promise<void>;
}

const REQUEST_LINE = /^([A-Z]{3,8}) (\S+) HTTP\/1\.1\r\n/;
const UPGRADE_HEADER = /\r\nupgrade:\s*\S/i;
const CONTENT_LENGTH = /\r\ncontent-length:\s*(\d+)\r\n/i;

/**
 * A streaming scanner for the client -> server direction.
 *
 * Length-driven rather than regex-over-the-whole-buffer: a POST body that
 * happened to contain the text `GET /v1/drafts HTTP/1.1` would otherwise be
 * logged as a request the app never made, and a request log that can invent
 * entries cannot be used to assert that a log is EMPTY.
 */
function scanUpstream(sink: (request: LoggedRequest) => void) {
  let buf = Buffer.alloc(0);
  let bodyRemaining = 0;
  let stopped = false;
  return (chunk: Buffer): void => {
    if (stopped) return;
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (bodyRemaining > 0) {
        const take = Math.min(bodyRemaining, buf.length);
        if (take === 0) return;
        buf = buf.subarray(take);
        bodyRemaining -= take;
        continue;
      }
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = buf.subarray(0, end + 4).toString('latin1');
      buf = buf.subarray(end + 4);
      const line = REQUEST_LINE.exec(head);
      if (line === null) {
        // Not an HTTP message start. The stream is no longer something this
        // scanner understands; going quiet is the honest response.
        stopped = true;
        return;
      }
      sink({ method: line[1] as string, url: line[2] as string });
      if (UPGRADE_HEADER.test(head)) {
        stopped = true;
        return;
      }
      const length = CONTENT_LENGTH.exec(head);
      bodyRemaining = length === null ? 0 : Number(length[1]);
    }
  };
}

/** Status lines, counted only where a message may begin. */
function scanDownstream(sink: (status: number) => void) {
  let tail = '';
  return (chunk: Buffer): void => {
    const text = tail + chunk.toString('latin1');
    const re = /(?:^|\r\n\r\n)HTTP\/1\.1 (\d{3})/g;
    for (let m = re.exec(text); m !== null; m = re.exec(text))
      sink(Number(m[1]));
    // Keep enough of the tail that a boundary split across two chunks is
    // still seen exactly once (never twice: only the unscanned remainder is
    // carried forward).
    tail = text.slice(Math.max(0, text.length - 16));
  };
}

/**
 * Listen on an ephemeral port and forward every connection to `targetPort`.
 */
export async function startRequestLog(targetPort: number): Promise<RequestLog> {
  const requests: LoggedRequest[] = [];
  const statuses: number[] = [];
  const sockets = new Set<Socket>();

  let severed = false;
  let connections = 0;
  let rewrite: { from: string; to: string } | null = null;
  let rewrites = 0;

  const server: Server = createServer((client) => {
    connections += 1;
    if (severed) {
      // Accepted and dropped: the app sees a connection that dies, which is
      // exactly what a daemon restarting underneath it looks like.
      client.destroy();
      return;
    }
    sockets.add(client);
    const upstream = scanUpstream((r) => requests.push(r));
    const downstream = scanDownstream((s) => statuses.push(s));
    const server2 = connect({ port: targetPort, host: '127.0.0.1' });
    sockets.add(server2);
    client.on('data', (d: Buffer) => {
      let out = d;
      if (rewrite !== null) {
        const at = out.indexOf(rewrite.from, 0, 'latin1');
        if (at >= 0) {
          const { from, to } = rewrite;
          // Armed once and disarmed on the hit, so a reconnect that repeats
          // the request goes through untouched: the skew is a fact about
          // one attempt, not a permanent property of the socket.
          rewrite = null;
          rewrites += 1;
          out = Buffer.concat([
            out.subarray(0, at),
            Buffer.from(to, 'latin1'),
            out.subarray(at + Buffer.byteLength(from, 'latin1')),
          ]);
        }
      }
      // Scanned AFTER the rewrite, so `requests()` reports what the daemon
      // was actually asked rather than what the app intended to ask.
      upstream(out);
      server2.write(out);
    });
    server2.on('data', (d: Buffer) => {
      downstream(d);
      client.write(d);
    });
    const drop = (): void => {
      client.destroy();
      server2.destroy();
      sockets.delete(client);
      sockets.delete(server2);
    };
    client.on('end', drop);
    client.on('error', drop);
    server2.on('end', drop);
    server2.on('error', drop);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('request log did not bind a TCP port');

  return {
    port: address.port,
    requests: () => [...requests],
    statuses: () => [...statuses],
    connections: () => connections,
    rewriteOnce: (from: string, to: string) => {
      rewrite = { from, to };
    },
    rewrites: () => rewrites,
    sever: () => {
      severed = true;
      for (const s of sockets) s.destroy();
      sockets.clear();
    },
    restore: () => {
      severed = false;
    },
    close: async () => {
      for (const s of sockets) s.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
