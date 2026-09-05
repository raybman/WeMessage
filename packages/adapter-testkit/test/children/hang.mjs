/**
 * Connects and then does nothing at all, forever. The wedged adapter.
 *
 * It is the harder of the two failure modes to report well: the socket is
 * open, the process is alive, and every naive parent waits out its whole
 * budget and then says `timeout` — which is right here, and wrong for
 * `crash.mjs`, which looks identical from the outside if you only watch the
 * clock. The kit tells them apart by watching the process, not the socket.
 */
const socket = new WebSocket(process.env.WEMESSAGE_GATEWAY_URL);
socket.onopen = () => {};
socket.onerror = () => {};

/* Keep the loop alive so the kit has something to reap. */
setInterval(() => {}, 60_000);
