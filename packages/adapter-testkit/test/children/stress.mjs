/**
 * A conformant adapter with one resource-abuse switch, so that each budget in
 * `DEFAULT_SPAWN_BUDGETS` has something that actually trips it. A budget no
 * test crosses is a comment with a type annotation.
 *
 *   STRESS_MODE=stdout  writes far more output than the transcript budget
 *   STRESS_MODE=frames  puts far more frames on the wire than the budget
 *   STRESS_MODE=big     puts one frame on the wire that is far too large
 *
 * `frames` and `big` both use `pong`, which is a legal agent->gateway frame
 * with an empty payload. That is deliberate: the budgets are about VOLUME,
 * and a subject that also broke the vocabulary rules would leave it ambiguous
 * which mechanism did the refusing.
 */
const env = process.env;
const mode = env.STRESS_MODE ?? 'none';
const iso = () => new Date().toISOString();

const stress = (emit) => {
  if (mode === 'stdout')
    for (let i = 0; i < 4_000; i += 1)
      process.stdout.write(`noise ${String(i)} ${'x'.repeat(60)}\n`);
  if (mode === 'frames') for (let i = 0; i < 400; i += 1) emit('pong', {});
  if (mode === 'big') emit('pong', {}, 'z'.repeat(600_000));
};

const session = () =>
  new Promise((done) => {
    const socket = new WebSocket(env.WEMESSAGE_GATEWAY_URL);
    const emit = (type, payload, pad) => {
      const id = pad === undefined ? crypto.randomUUID() : pad;
      socket.send(JSON.stringify({ v: 1, id, type, ts: iso(), payload }));
    };
    socket.onopen = () => {
      emit('hello', {
        adapterId: env.WEMESSAGE_ADAPTER_ID,
        token: env.WEMESSAGE_ADAPTER_TOKEN,
        wire: 1,
      });
      stress(emit);
    };
    socket.onclose = socket.onerror = () => done();
    socket.onmessage = (event) => {
      try {
        const frame = JSON.parse(String(event.data));
        if (frame?.v !== 1) return;
        if (frame.type === 'ping') return emit('pong', {});
        if (frame.type !== 'draft.request') return;
        const { correlation, message } = frame.payload;
        const text = (message.content.text ?? '').trim();
        emit('draft.submit', {
          correlation,
          idempotencyKey: `stress:${correlation.inboundGuid}`,
          ...(text === '' ? { declined: true } : { body: text }),
        });
      } catch {
        /* ignored on purpose */
      }
    };
  });

for (let n = 1; n <= Number(env.WEMESSAGE_MAX_ATTEMPTS ?? 3); n += 1)
  await session();
process.exit(1);
