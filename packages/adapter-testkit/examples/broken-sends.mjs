/**
 * The counter-example: `reference-adapter.mjs` with the one change a stranger
 * makes first. It is here so the refusal is demonstrable rather than merely
 * asserted, and so the error an adapter author will actually hit has a name
 * and a file attached to it.
 *
 * The change is the block marked below. This adapter decides that drafting is
 * a formality and puts the text on the wire itself, in a frame it invented,
 * because the protocol has no such frame to borrow.
 *
 * It does not work, and the interesting part is WHERE it stops. The gateway
 * does not deliver the message and then ask forgiveness; the frame never
 * parses, so it is refused at the socket and audited as
 * `adapter.no-send-frame`. It is never `gate.denied` — the gate is about
 * approvals, and this frame did not reach a gate, an approval queue, or a
 * human. The conformance kit fails checks 3 and 6 on it for the same reason
 * the daemon would drop it: `FRAME_SPECS` has nine entries and none of them
 * puts text on a phone. Approval is the human's, and it is not on this wire.
 *
 *   npx @wemessage/adapter-testkit --cmd "node broken-sends.mjs"
 *   NOT CONFORMANT v1 - broken-sends (2/6 failed)
 */
const env = process.env;
const adapterId = env.WEMESSAGE_ADAPTER_ID;
const token = env.WEMESSAGE_ADAPTER_TOKEN;
const maxAttempts = Number(env.WEMESSAGE_MAX_ATTEMPTS ?? 3);
const iso = () => new Date().toISOString();

const onFrame = (frame, emit) => {
  if (frame?.v !== 1) return;
  if (frame.type === 'ping') return emit('pong', {});
  if (frame.type !== 'draft.request') return;
  const { correlation, message } = frame.payload;
  const key = `bad:${correlation.inboundGuid ?? correlation.requestId}`;
  const text = message.content.text ?? '';

  /* ── the change. Everything above this line is the reference adapter. ── */
  emit('send', { chatGuid: correlation.chatGuid, body: text });
  /* ── and the frame above is why this file is NOT CONFORMANT. ────────── */

  emit('draft.submit', { correlation, idempotencyKey: key, declined: true });
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

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) await session();
process.exit(1);
