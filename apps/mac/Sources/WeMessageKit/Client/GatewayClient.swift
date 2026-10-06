import Foundation

/// The answer to a call the daemon may refuse: a value, or the refusal.
/// Refusals (a 409 conflict, a 403 gate denial, an unreadable source, an
/// unknown chat) are answers, not faults; every other failure throws.
public enum Outcome<Value> {
  case ok(Value)
  case refused(Refusal)

  public var value: Value? {
    if case .ok(let value) = self { return value }
    return nil
  }

  public var refusal: Refusal? {
    if case .refused(let refusal) = self { return refusal }
    return nil
  }
}

extension Outcome: Sendable where Value: Sendable {}
extension Outcome: Equatable where Value: Equatable {}

/// The daemon client: one actor over an injectable Transport.
///
/// The bearer is resolved on first use and kept. On a 401 the client re-reads
/// its TokenSource exactly once for that call and retries once; a rotated
/// token is kept, and the next call that meets a 401 re-reads again (the
/// re-read is per call, never a sticky flag). Health is the one call that
/// carries no bearer and reads no token.
public actor GatewayClient {
  public nonisolated let config: ClientConfig
  public nonisolated let tokens: TokenSource
  nonisolated let transport: any Transport
  private var token: BearerToken?

  public init(
    config: ClientConfig = ClientConfig(),
    tokens: TokenSource = TokenSource(),
    transport: any Transport = URLSessionTransport()
  ) {
    self.config = config
    self.tokens = tokens
    self.transport = transport
  }

  // MARK: system

  public func health() async throws -> HealthPayload { try await call(.health) }

  public func status() async throws -> StatusPayload { try await call(.status) }

  public func connect() async throws -> DoctorReportPayload { try await call(.connect) }

  public func doctor() async throws -> DoctorReportPayload { try await call(.doctor) }

  public func disconnect(purge: Bool = false) async throws -> DisconnectReportPayload {
    try await call(.disconnect(purge: purge))
  }

  // MARK: adapters

  public func listAdapters() async throws -> AdaptersEnvelope { try await call(.listAdapters) }

  public func getAdapter(_ id: String) async throws -> AdapterEnvelope { try await call(.getAdapter(id: id)) }

  public func createAdapter(_ input: AdapterInput) async throws -> AdapterCredential {
    try await call(.createAdapter(input))
  }

  public func updateAdapter(_ id: String, _ patch: AdapterPatch) async throws -> AdapterEnvelope {
    try await call(.updateAdapter(id: id, patch))
  }

  public func deleteAdapter(_ id: String) async throws -> Deleted {
    try await deletion(.deleteAdapter(id: id), id: id)
  }

  public func rotateAdapterToken(_ id: String) async throws -> AdapterCredential {
    try await call(.rotateAdapterToken(id: id))
  }

  // MARK: audit and batches

  public func listAudit(since: String? = nil, event: String? = nil, limit: Int? = nil) async throws
    -> [AuditRowPayload]
  {
    try await call(.listAudit(AuditQuery(since: since, event: event, limit: limit)))
  }

  public func verifyAudit() async throws -> AuditVerifyResult { try await call(.verifyAudit) }

  public func batchReport(_ id: String) async throws -> BatchReport { try await call(.batchReport(id: id)) }

  // MARK: contacts

  public func listContacts() async throws -> ContactsEnvelope { try await call(.listContacts) }

  public func setContactPolicy(_ handle: String, mode: ContactMode, displayName: String? = nil) async throws
    -> ContactEnvelope
  {
    try await call(.setContactPolicy(handle: handle, mode: mode, displayName: displayName))
  }

  public func deleteContactPolicy(_ handle: String) async throws -> Deleted {
    try await deletion(.deleteContactPolicy(handle: handle), id: handle)
  }

  // MARK: drafts

  public func listDrafts(_ filter: DraftFilter = DraftFilter()) async throws -> DraftsEnvelope {
    try await call(.listDrafts(filter))
  }

  public func getDraft(_ id: String) async throws -> DraftDetail { try await call(.getDraft(id: id)) }

  public func createDraft(_ input: DraftCreateInput) async throws -> DraftEnvelope {
    try await call(.createDraft(input))
  }

  public func approveDraft(_ id: String, editedBody: String? = nil) async throws -> Outcome<DraftActionResult> {
    try await outcome(.approveDraft(id: id, editedBody: editedBody))
  }

  public func rejectDraft(_ id: String, reason: String? = nil) async throws -> Outcome<DraftActionResult> {
    try await outcome(.rejectDraft(id: id, reason: reason))
  }

  public func recallDraft(_ id: String) async throws -> Outcome<DraftActionResult> {
    try await outcome(.recallDraft(id: id))
  }

  public func retryDraft(_ id: String) async throws -> Outcome<DraftActionResult> {
    try await outcome(.retryDraft(id: id))
  }

  public func redraftDraft(_ id: String) async throws -> Outcome<RedraftResult> {
    try await outcome(.redraftDraft(id: id))
  }

  public func bulkDrafts(_ action: BulkAction, _ selector: BulkSelector) async throws -> BulkResult {
    try await call(.bulkDrafts(action, selector))
  }

  // MARK: rules

  public func listRules() async throws -> [RulePayload] { try await call(.listRules) }

  /// The bare rule: GET /v1/rules/:id has no envelope.
  public func getRule(_ id: String) async throws -> RulePayload { try await call(.getRule(id: id)) }

  public func createRule(_ input: RuleInput) async throws -> RuleWriteResult { try await call(.createRule(input)) }

  public func updateRule(_ id: String, _ patch: RulePatch) async throws -> RuleWriteResult {
    try await call(.updateRule(id: id, patch))
  }

  public func deleteRule(_ id: String) async throws -> Deleted { try await deletion(.deleteRule(id: id), id: id) }

  public func dryRunRule(_ id: String, limit: Int? = nil) async throws -> DryRunResult {
    try await call(.dryRunRule(id: id, limit: limit))
  }

  public func testRule(_ id: String, _ input: RuleTestInput) async throws -> RuleTestResult {
    try await call(.testRule(id: id, input))
  }

  // MARK: schedules

  public func listSchedules() async throws -> [SchedulePayload] { try await call(.listSchedules) }

  /// The bare schedule: GET /v1/schedules/:id has no envelope.
  public func getSchedule(_ id: String) async throws -> SchedulePayload { try await call(.getSchedule(id: id)) }

  public func createSchedule(_ input: ScheduleInput) async throws -> ScheduleEnvelope {
    try await call(.createSchedule(input))
  }

  public func updateSchedule(_ id: String, _ patch: SchedulePatch) async throws -> ScheduleEnvelope {
    try await call(.updateSchedule(id: id, patch))
  }

  public func deleteSchedule(_ id: String) async throws -> Deleted {
    try await deletion(.deleteSchedule(id: id), id: id)
  }

  // MARK: send, settings, toggles

  public func send(to handle: String, body: String) async throws -> SendResult {
    try await call(.send(to: handle, body: body))
  }

  public func settings() async throws -> SettingsEnvelope { try await call(.settings) }

  public func setSettings(_ values: [String: SettingPatchValue]) async throws -> SettingsPatchResult {
    try await call(.setSettings(values))
  }

  public func setGlobalMode(_ mode: GlobalMode) async throws -> GlobalModeResult {
    try await call(.setGlobalMode(mode))
  }

  public func setKillSwitch(_ on: Bool, circuit: Bool? = nil) async throws -> KillSwitchResult {
    try await call(.setKillSwitch(on: on, circuit: circuit))
  }

  public func pause(until: String) async throws -> PauseResult { try await call(.pause(until: until)) }

  public func resume() async throws -> PauseResult { try await call(.resume) }

  // MARK: threads

  public func listThreads(limit: Int? = nil, cursor: String? = nil) async throws -> Outcome<ThreadsPage> {
    try await outcome(.listThreads(limit: limit, cursor: cursor))
  }

  public func readThread(_ guid: String, limit: Int? = nil, before: String? = nil, until: String? = nil)
    async throws -> Outcome<ThreadMessagesPage>
  {
    try await outcome(.readThread(guid: guid, limit: limit, before: before, until: until))
  }

  // MARK: the event stream

  /// GET /v1/events/sse as raw frames. Opening it follows the same per-call
  /// 401 retry; a refused open (any non-2xx) throws its classified error, and
  /// a 2xx that is not text/event-stream throws a decoding error. Ending the
  /// iteration cancels the request.
  public nonisolated func events(filter: [EventName]? = nil) -> AsyncThrowingStream<SSEFrame, any Error> {
    let endpoint = Endpoint.events(filter: filter)
    return AsyncThrowingStream { continuation in
      let task = Task {
        do {
          let chunks = try await self.openEventStream(endpoint)
          var decoder = SSEDecoder()
          for try await chunk in chunks {
            for frame in decoder.feed(chunk) { continuation.yield(frame) }
          }
          continuation.finish()
        } catch {
          continuation.finish(throwing: GatewayError.wrap(error))
        }
      }
      continuation.onTermination = { _ in task.cancel() }
    }
  }

  /// The event stream decoded into typed events. Comments and keepalives
  /// never surface; a frame that does not match its event's shape throws.
  public nonisolated func gatewayEvents(filter: [EventName]? = nil) -> AsyncThrowingStream<GatewayEvent, any Error> {
    let frames = events(filter: filter)
    return AsyncThrowingStream { continuation in
      let task = Task {
        do {
          for try await frame in frames {
            continuation.yield(try GatewayEvent(frame: frame))
          }
          continuation.finish()
        } catch {
          continuation.finish(throwing: GatewayError.wrap(error))
        }
      }
      continuation.onTermination = { _ in task.cancel() }
    }
  }

  // MARK: plumbing

  /// The cached bearer, or a first read of the TokenSource.
  private func currentToken() -> BearerToken? {
    if let token { return token }
    let resolved = tokens.resolve()
    if let resolved { token = resolved }
    return resolved
  }

  /// One exchange with the per-call 401 retry. Returns the body, nil on 204.
  private func exchange(_ endpoint: Endpoint) async throws -> Data? {
    if case .health = endpoint {
      return try await perform(endpoint, token: nil)
    }
    do {
      return try await perform(endpoint, token: currentToken())
    } catch GatewayError.unauthorized {
      guard let fresh = tokens.resolve() else { throw GatewayError.unauthorized }
      token = fresh
      return try await perform(endpoint, token: fresh)
    }
  }

  private nonisolated func perform(_ endpoint: Endpoint, token: BearerToken?) async throws -> Data? {
    let request = try endpoint.urlRequest(baseURL: config.baseURL, token: token)
    let (data, response) = try await Self.transported { try await self.transport.send(request) }
    switch GatewayError.classify(status: response.statusCode, body: data, endpoint: endpoint) {
    case .success(let body): return body
    case .failure(let error): throw error
    }
  }

  /// Opens the event stream with the same per-call 401 retry as `exchange`.
  private func openEventStream(_ endpoint: Endpoint) async throws -> AsyncThrowingStream<Data, any Error> {
    do {
      return try await openStream(endpoint, token: currentToken())
    } catch GatewayError.unauthorized {
      guard let fresh = tokens.resolve() else { throw GatewayError.unauthorized }
      token = fresh
      return try await openStream(endpoint, token: fresh)
    }
  }

  private nonisolated func openStream(_ endpoint: Endpoint, token: BearerToken?) async throws
    -> AsyncThrowingStream<Data, any Error>
  {
    let request = try endpoint.urlRequest(baseURL: config.baseURL, token: token)
    let (chunks, response) = try await Self.transported { try await self.transport.stream(request) }
    let status = response.statusCode
    guard (200..<300).contains(status) else {
      var body = Data()
      for try await chunk in chunks { body.append(chunk) }
      if case .failure(let error) = GatewayError.classify(status: status, body: body, endpoint: endpoint) {
        throw error
      }
      throw GatewayError.request(status: status, body: GatewayError.parseErrorBody(body))
    }
    let contentType = response.value(forHTTPHeaderField: "Content-Type")
    guard SSEDecoder.isEventStream(contentType: contentType) else {
      throw GatewayError.decoding(
        path: "content-type", underlying: "expected text/event-stream, got \(contentType ?? "no Content-Type")")
    }
    return chunks
  }

  /// Runs a transport call; anything it throws becomes a GatewayError.
  private static func transported<T: Sendable>(_ body: () async throws -> T) async throws -> T {
    do {
      return try await body()
    } catch let error as GatewayError {
      throw error
    } catch let error as URLError {
      throw GatewayError.transport(error)
    } catch is CancellationError {
      throw GatewayError.transport(URLError(.cancelled))
    } catch {
      throw GatewayError.transport(URLError(.unknown))
    }
  }

  private func call<T: Decodable>(_ endpoint: Endpoint) async throws -> T {
    let data = try await exchange(endpoint)
    return try Self.decode(T.self, from: data ?? Data())
  }

  private func outcome<T: Decodable & Sendable>(_ endpoint: Endpoint) async throws -> Outcome<T> {
    do {
      let value: T = try await call(endpoint)
      return .ok(value)
    } catch let error as GatewayError {
      if let refusal = error.refusal { return .refused(refusal) }
      throw error
    }
  }

  /// A DELETE: 204 means the id is gone; a 200 body says which.
  private func deletion(_ endpoint: Endpoint, id: String) async throws -> Deleted {
    guard let data = try await exchange(endpoint) else { return Deleted(deleted: id) }
    return try Self.decode(Deleted.self, from: data)
  }

  /// The one strict decode every response goes through.
  static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
    do {
      return try JSONDecoder().decode(T.self, from: data)
    } catch {
      throw GatewayError.wrap(error)
    }
  }
}
