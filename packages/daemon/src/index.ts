// @wemessage/daemon — process composition (auth, /v1/health, /v1/status,
// WS /v1/events, wiring). Ingest/recovery boot ordering lands in Scenario 11.
export {
  buildServer,
  startServer,
  type DaemonOptions,
  type DaemonServer,
} from './server.js';
export {
  generateToken,
  loadOrCreateToken,
  tokenEquals,
  TOKEN_FILENAME,
  TOKEN_PREFIX,
} from './auth.js';
