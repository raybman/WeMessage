/**
 * Row 4's subject. It answers correctly AND replays the gateway's own
 * `draft.request` back up the socket, which is the mistake a naive proxy or
 * a chatty debug wrapper makes without meaning anything by it.
 *
 * `draft.request` is a real frame type — nine of them exist and this is one.
 * A direction-blind parser accepts it and the replay is laundered. Only
 * `parseAgentFrame`, which knows the frame is `gateway->agent`, catches it,
 * which is why the spawn transport uses that one and why swapping it is the
 * named teeth mutation for this scenario.
 *
 * The replay goes out BEFORE the submit so that the violation is on the wire
 * by the time the kit sees an answer. Frames on one socket are ordered.
 */
const env = process.env;
const iso = () => new Date().toISOString();

const session = () =>
  new Promise((done) => {
    const socket = new WebSocket(env.WEMESSAGE_GATEWAY_URL);
    const emit = (type, payload) => {
      const id = crypto.randomUUID();
      socket.send(JSON.stringify({ v: 1, id, type, ts: iso(), payload }));
    };
    socket.onopen = () =>
      emit('hello', {
        adapterId: env.WEMESSAGE_ADAPTER_ID,
        token: env.WEMESSAGE_ADAPTER_TOKEN,
        wire: 1,
      });
    socket.onclose = socket.onerror = () => done();
    socket.onmessage = (event) => {
      try {
        const frame = JSON.parse(String(event.data));
        if (frame?.v !== 1) return;
        if (frame.type === 'ping') return emit('pong', {});
        if (frame.type !== 'draft.request') return;
        emit('draft.request', frame.payload);
        const { correlation, message } = frame.payload;
        const text = message.content.text ?? '';
        emit('draft.submit', {
          correlation,
          idempotencyKey: `replay:${correlation.inboundGuid}`,
          ...(text.trim() === '' ? { declined: true } : { body: text.trim() }),
        });
      } catch {
        /* ignored on purpose */
      }
    };
  });

for (let n = 1; n <= Number(env.WEMESSAGE_MAX_ATTEMPTS ?? 3); n += 1)
  await session();
process.exit(1);
