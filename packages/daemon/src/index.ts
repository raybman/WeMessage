// @wemessage/daemon — process composition: auth, /v1/health, /v1/status,
// WS /v1/events, and the Scenario 11 tail pipeline (recovery -> watcher ->
// scan -> normalize -> mirror -> event emission).
export {
  buildServer,
  startServer,
  type DaemonOptions,
  type DaemonServer,
} from './server.js';
export {
  generateToken,
  loadOrCreateToken,
  readToken,
  tokenEquals,
  TOKEN_FILENAME,
  TOKEN_PREFIX,
} from './auth.js';
export { sanitizeInbound, stripControlChars } from './sanitize.js';
export {
  startDaemon,
  toGatewayEvent,
  type RunningDaemon,
  type StartDaemonOptions,
} from './daemon.js';
