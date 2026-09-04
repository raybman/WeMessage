// @wemessage/daemon — process composition: auth, /v1/health, /v1/status,
// WS /v1/events, and the Scenario 11 tail pipeline (recovery -> watcher ->
// scan -> normalize -> mirror -> event emission).
export {
  buildServer,
  startServer,
  type DaemonOptions,
  type DaemonServer,
} from './server.js';
export { createAuditSink, type AuditSink } from './audit-sink.js';
export {
  createScheduler,
  type Scheduler,
  type SchedulerDeps,
} from './scheduler.js';
export { registerRuleRoutes, type RuleRouteDeps } from './routes/rules.js';
export { registerDoctorRoutes, type DoctorRouteDeps } from './routes/doctor.js';
export { registerSendRoutes, type SendRouteDeps } from './routes/send.js';
export {
  registerConnectionRoutes,
  type ConnectionRouteDeps,
} from './routes/connection.js';
export {
  generateToken,
  loadOrCreateToken,
  readToken,
  rotateToken,
  tokenEquals,
  TOKEN_FILENAME,
  TOKEN_PREFIX,
} from './auth.js';
export {
  disconnectDaemon,
  connectDaemon,
  MANUAL_REVOCATION,
  type ConnectDeps,
  type DisconnectDeps,
  type DisconnectReport,
  type DisconnectStep,
  type DisconnectStepId,
} from './connection.js';
export { sanitizeInbound, stripControlChars } from './sanitize.js';
export {
  startDaemon,
  toGatewayEvent,
  type RunningDaemon,
  type StartDaemonOptions,
} from './daemon.js';
export {
  evaluateDoctor,
  macOsMajorFromRelease,
  readConnectionState,
  runDoctor,
  createRealDoctorProbes,
  AUTOMATION_DENIED,
  FDA_EPERM,
  type DoctorCheck,
  type DoctorProbes,
  type DoctorReport,
  type DoctorSnapshot,
  type RunDoctorDeps,
} from './doctor.js';
export {
  createInboundDispatch,
  CONTEXT_TURN_LIMIT,
  DRAFT_REQUEST_CONSTRAINTS,
  type DispatchTransport,
  type InboundDispatch,
  type InboundDispatchDeps,
} from './adapters/dispatch.js';
export {
  createAdapterTransport,
  type AdapterTransportDeps,
  type AdapterTransportHandle,
} from './adapters/transport.js';
