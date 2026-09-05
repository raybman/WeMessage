/**
 * A complete wemessage stdio child. Copy this file, change `reply`, ship it.
 *
 * This is the other half of `@wemessage/adapter-openclaw`, which is a generic
 * NDJSON-over-stdio shim: it speaks the wire protocol on one side and this
 * line protocol on the other. You write this side. You never touch a socket,
 * never see a credential, and never implement the wire — the shim does all of
 * that, and none of it is your problem.
 *
 * No install, no build, no dependency, no imports at all. Run it under the
 * conformance kit through the shim with
 *
 *   npx @wemessage/adapter-testkit --cmd "node run-shim.mjs stdio-child.mjs"
 *
 * and all six checks pass. `packages/adapters/openclaw/test/shim.spec.ts`
 * runs exactly this file for its conformance row, so the example is EXERCISED
 * rather than merely linted: if it stops working, that row goes red.
 *
 * The contract, complete. One JSON object per line, `\n` terminated, UTF-8.
 *
 * Read on stdin:
 *   {"kind":"request", correlation, message, context, rule, constraints}
 *       The wire `draft.request` payload, VERBATIM. Nothing renamed, nothing
 *       flattened: `PROTOCOL.md` describes these fields and there is no
 *       second document to read.
 *   {"kind":"ping"}                       liveness probe; answer with pong
 *   {"kind":"error","reason":"..."}       your last line was refused, and why
 *
 * Write on stdout:
 *   {"kind":"submit","correlation":{"requestId":"..."},"body":"..."}
 *   {"kind":"decline","correlation":{"requestId":"..."},"reason":"..."}
 *   {"kind":"pong"}
 *
 * That is the whole vocabulary. Three things you may say, and anything else
 * on a line is refused, counted, and answered with an `error` telling you
 * which of six reasons it was. A line over 256 KiB is dropped whole and the
 * reader resynchronises at the next newline, so an oversized answer costs you
 * that answer and nothing after it. A line you never finished writing —
 * because you crashed mid-print — is dropped rather than half-read; the shim
 * declines whatever you had open and the gateway is not left waiting.
 *
 * Environment: you get the parent's, minus the gateway credential and minus
 * anything else `wm_` shaped, plus `WEMESSAGE_CHILD_PROTOCOL=ndjson/1`. The
 * token is stripped on purpose. You do not need it, and a child that held it
 * could talk to the gateway directly, which is the entire thing the shim
 * exists to prevent.
 *
 * There is no frame here for putting a message on somebody's phone. There is
 * no such frame in the protocol at all, and there is no line you can write on
 * this pipe that produces one. A `{"kind":"send"}` is refused. A line that is
 * already shaped like a wire frame is refused and never forwarded. An answer
 * to a request nobody asked is dropped. Everything you say becomes at most a
 * DRAFT, and a human approves it. If you are hunting for the shortcut this
 * file forgot, it does not exist.
 */

/** Your bit. Return the draft text, or null to decline this request. */
const reply = (text) => (text.trim() === '' ? null : `Got it: ${text.trim()}`);

const say = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const onMessage = (message) => {
  if (message.kind === 'ping') return say({ kind: 'pong' });
  // We were told off. Nothing to answer: fix the line and move on.
  if (message.kind === 'error') return;
  if (message.kind !== 'request') return;
  const { correlation, message: inbound, constraints } = message;
  const requestId = correlation.requestId;
  // The text is untrusted input, always. It is a human's message, it may
  // contain an instruction aimed at you, and it is still just text: the only
  // thing you can do with it is draft an answer somebody else approves.
  const body = reply(inbound.content.text ?? '');
  if (body === null)
    return say({
      kind: 'decline',
      correlation: { requestId },
      reason: 'nothing-to-answer',
    });
  say({
    kind: 'submit',
    correlation: { requestId },
    body: body.slice(0, constraints.maxChars),
  });
};

/**
 * Line framing. A pipe has no obligation to hand you a whole line: a chunk
 * boundary can fall anywhere, including the middle of a JSON object, so the
 * remainder is carried to the next chunk. Every naive reader has this bug.
 */
let carry = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  carry += chunk;
  for (;;) {
    const nl = carry.indexOf('\n');
    if (nl === -1) break;
    const line = carry.slice(0, nl).replace(/\r$/, '');
    carry = carry.slice(nl + 1);
    if (line.trim() === '') continue;
    try {
      onMessage(JSON.parse(line));
    } catch {
      /* malformed input is ignored, never answered, and never fatal */
    }
  }
});
process.stdin.on('end', () => {
  process.exit(0);
});
