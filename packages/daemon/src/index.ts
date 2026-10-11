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
  createAuditSink,
  type AuditSink,
  type EventSubscriber,
} from './audit-sink.js';
// s7 Scenario 3: the `?events=` filter, shared by both event transports.
export {
  closeReasonFor,
  parseEventFilter,
  type EventFilter,
  type EventFilterResult,
} from './events-filter.js';
export {
  registerSseRoute,
  SSE_KEEPALIVE_MS,
  SSE_PATH,
  type SseRouteDeps,
  type SseTimer,
} from './routes/events-sse.js';
// v2 S0: every request schema, public, keyed by route (fixtures/contract).
export {
  contractSlug,
  PARAM_SCHEMAS,
  paramJsonSchemas,
  REQUEST_SCHEMAS,
  requestJsonSchemas,
  type RequestSchemaKey,
} from './contract.js';
export {
  createScheduler,
  type Scheduler,
  type SchedulerDeps,
} from './scheduler.js';
export { registerRuleRoutes, type RuleRouteDeps } from './routes/rules.js';
export { registerDoctorRoutes, type DoctorRouteDeps } from './routes/doctor.js';
export { registerSendRoutes, type SendRouteDeps } from './routes/send.js';
// v2 F2b: message search over the daemon's own index.
export { registerSearchRoutes, type SearchRouteDeps } from './routes/search.js';
// v2 F6b: attachment bytes, from the Attachments folder only.
export {
  ATTACHMENT_ID,
  registerAttachmentRoutes,
  type AttachmentRouteDeps,
} from './routes/attachments.js';
export {
  parseRange,
  resolveAttachment,
  type ResolveDeps,
  type ResolveFail,
  type ResolveFs,
  type Resolved,
} from './attachments/resolve.js';
export { sniff, SNIFF_BYTES, type SniffedMime } from './attachments/sniff.js';
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
  type DisconnectStepStatus,
  type DisconnectOutcome,
  type Supervisor,
  type SupervisionDeps,
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
  describeRuntime,
  createRealDoctorProbes,
  AUTOMATION_DENIED,
  FDA_EPERM,
  type DoctorCheck,
  type DoctorProbes,
  type DoctorReport,
  type DoctorRuntime,
  type DoctorSnapshot,
  type RunDoctorDeps,
  type RuntimeEnv,
  type RuntimeVersions,
} from './doctor.js';
export {
  createAgentFeedback,
  type AgentFeedback,
  type AgentFeedbackDeps,
  type DispatchFn,
  type DraftFeedbackTap,
  type FeedbackInput,
  type FeedbackTransport,
} from './adapters/feedback.js';
export {
  createInboundDispatch,
  createRequestSender,
  type RequestSender,
  CONTEXT_TURN_LIMIT,
  DRAFT_REQUEST_CONSTRAINTS,
  type DispatchTransport,
  type InboundDispatch,
  type InboundDispatchDeps,
} from './adapters/dispatch.js';
export {
  createAgentRequests,
  createAgentSubmitHandler,
  type AgentRequests,
  type AgentSubmitDeps,
  type AgentSubmitHandler,
  type IssuedRequest,
} from './adapters/submit.js';
export {
  createAdapterTransport,
  type AdapterTransportDeps,
  type AdapterTransportHandle,
} from './adapters/transport.js';
// s6 Scenario 11: the arming derivation. Exported because three surfaces
// outside this file need the same answer — `/v1/status`, the toggle routes,
// and (Sc 12) the CLI that renders it — and a second implementation of a
// precedence order is a second precedence order.
export {
  armedWindowClose,
  resolveArming,
  setPause,
  sweepArming,
  SETTING_ARMING_LAST_BROADCAST,
  type ArmingDeps,
  type ArmingSweepDeps,
  type SweepArmingOptions,
} from './arming.js';
export {
  CHANNEL_NAMES,
  NOT_CONNECTED_REASONS,
  channelStatusSchema,
  channelsSchema,
  channelStatuses,
  type ChannelStatusEntry,
  type ImessageLive,
} from './channels.js';
export {
  composeStatus,
  createStatusFacts,
  dbBytes,
  tildePath,
  STATUS_HANDLE_EVERY_MS,
  STATUS_RECOUNT_EVERY_MS,
  type ComposeStatusDeps,
  type MirrorStatus,
  type StatusFacts,
  type StatusFactsDeps,
} from './status-facts.js';
