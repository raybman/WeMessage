/**
 * A complete wemessage adapter. Copy this file, change `reply`, ship it.
 *
 * No install, no build, no dependency: Node 22 ships a global `WebSocket`, so
 * this file is the whole thing. Run it through the conformance kit with
 *
 *   npx @wemessage/adapter-testkit --cmd "node reference-adapter.mjs"
 *
 * and it passes all six checks.
 *
 * The kit, and the daemon, hand you five environment variables and nothing
 * else. The token arrives by environment on purpose: argv is world-readable
 * through `ps`, so a credential on a command line is a credential published
 * to every user on the machine. Read it, put it in `hello`, never print it.
 *
 *   WEMESSAGE_GATEWAY_URL      ws://host:port/v1/agent
 *   WEMESSAGE_ADAPTER_TOKEN    wm_ followed by 64 hex characters
 *   WEMESSAGE_ADAPTER_ID       echo this back in your hello frame
 *   WEMESSAGE_BACKOFF_MS       how long to wait between reconnects
 *   WEMESSAGE_MAX_ATTEMPTS     give up after this many dials, non-zero exit
 *
 * Two rules the checks will hold you to. Answer a replayed request with the
 * SAME idempotency key, because a daemon restart re-delivers the inbound and
 * a key made of entropy would put a second draft in front of a human. And
 * give up: an adapter that retries forever against a gateway that has already
 * refused it is a wedged process nobody gets paged about.
 *
 * There is no frame here for putting a message on somebody's phone. There is
 * no such frame in the protocol at all. An adapter proposes a draft and a
 * human approves it, and that is the only path text ever takes to a
 * recipient. If you are hunting for the one this file forgot, it does not
 * exist, and an adapter that invents one is refused at the socket.
 */
const env = process.env;
const adapterId = env.WEMESSAGE_ADAPTER_ID;
const token = env.WEMESSAGE_ADAPTER_TOKEN;
const backoffMs = Number(env.WEMESSAGE_BACKOFF_MS ?? 0);
const maxAttempts = Number(env.WEMESSAGE_MAX_ATTEMPTS ?? 3);
const iso = () => new Date().toISOString();

/** Your bit. Return the draft text, or null to decline this request. */
const reply = (text) => (text.trim() === '' ? null : `Got it: ${text.trim()}`);

const onFrame = (frame, emit) => {
  if (frame?.v !== 1) return; // a wire we do not speak: refuse, never guess
  if (frame.type === 'ping') return emit('pong', {});
  if (frame.type !== 'draft.request') return;
  const { correlation, message, constraints: c } = frame.payload;
  const key = `ref:${correlation.inboundGuid ?? correlation.requestId}`;
  const body = reply(message.content.text ?? '');
  const draft = body ? { body: body.slice(0, c.maxChars) } : { declined: true };
  emit('draft.submit', { correlation, idempotencyKey: key, ...draft });
};

const session = () =>
  new Promise((done) => {
    const socket = new WebSocket(env.WEMESSAGE_GATEWAY_URL);
    const emit = (type, payload) => {
      const id = crypto.randomUUID();
      socket.send(JSON.stringify({ v: 1, id, type, ts: iso(), payload }));
    };
    socket.onopen = () => emit('hello', { adapterId, token, wire: 1 });
    socket.onclose = socket.onerror = () => done();
    socket.onmessage = (event) => {
      try {
        onFrame(JSON.parse(String(event.data)), emit);
      } catch {
        /* malformed input is refused, never answered, and never fatal */
      }
    };
  });

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  await session();
  if (backoffMs > 0)
    await new Promise((go) => setTimeout(go, backoffMs * attempt));
}
process.exit(1); // fail closed: the operator has to find out that we gave up
