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

  const server: Server = createServer((client) => {
    sockets.add(client);
    const upstream = scanUpstream((r) => requests.push(r));
    const downstream = scanDownstream((s) => statuses.push(s));
    const server2 = connect({ port: targetPort, host: '127.0.0.1' });
    sockets.add(server2);
    client.on('data', (d: Buffer) => {
      upstream(d);
      server2.write(d);
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
    close: async () => {
      for (const s of sockets) s.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
