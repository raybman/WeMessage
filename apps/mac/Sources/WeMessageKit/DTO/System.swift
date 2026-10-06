import Foundation

// Health, status, arming and toggles, doctor and disconnect, audit, send and
// contacts: the daemon's smaller responses, each decoded strictly.

public struct HealthPayload: Codable, Equatable, Sendable {
  public var status: String

  enum CodingKeys: String, CodingKey, CaseIterable {
    case status
  }
}

extension HealthPayload {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    status = try c.decode(String.self, forKey: .status)
  }
}

/// A delete's answer: the id or handle that went away.
public struct Deleted: Codable, Equatable, Sendable {
  public var deleted: String

  public init(deleted: String) {
    self.deleted = deleted
  }

  enum CodingKeys: String, CodingKey, CaseIterable {
    case deleted
  }
}

extension Deleted {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    deleted = try c.decode(String.self, forKey: .deleted)
  }
}

// MARK: status and arming

public struct StatusCursor: Codable, Equatable, Sendable {
  public var lastRowid: Int
  public var lastScanAt: String

  enum CodingKeys: String, CodingKey, CaseIterable {
    case lastRowid, lastScanAt
  }
}

extension StatusCursor {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    lastRowid = try c.decode(Int.self, forKey: .lastRowid)
    lastScanAt = try c.decode(String.self, forKey: .lastScanAt)
  }
}

public struct StatusCounts: Codable, Equatable, Sendable {
  public var messagesToday: Int

  enum CodingKeys: String, CodingKey, CaseIterable {
    case messagesToday
  }
}

extension StatusCounts {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    messagesToday = try c.decode(Int.self, forKey: .messagesToday)
  }
}

/// Whether auto-send may fire right now, and which hold wins if not.
public struct ArmingStatePayload: Codable, Equatable, Sendable {
  public var armed: Bool
  /// Required and nullable: when a pause ends, if one is set.
  public var until: String?
  public var reason: String

  enum CodingKeys: String, CodingKey, CaseIterable {
    case armed, until, reason
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(armed, forKey: .armed)
    try c.encode(until, forKey: .until)
    try c.encode(reason, forKey: .reason)
  }
}

extension ArmingStatePayload {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    armed = try c.decode(Bool.self, forKey: .armed)
    until = try c.decode(String?.self, forKey: .until)
    reason = try c.decode(String.self, forKey: .reason)
  }
}

public struct StatusPayload: Codable, Equatable, Sendable {
  public var connectionState: String
  /// Required and nullable: null before the first scan.
  public var cursor: StatusCursor?
  public var counts: StatusCounts
  public var adapters: [JSONValue]
  /// Required and nullable.
  public var killSwitch: Bool?
  /// Required and nullable.
  public var armed: ArmingStatePayload?

  enum CodingKeys: String, CodingKey, CaseIterable {
    case connectionState, cursor, counts, adapters, killSwitch, armed
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(connectionState, forKey: .connectionState)
    try c.encode(cursor, forKey: .cursor)
    try c.encode(counts, forKey: .counts)
    try c.encode(adapters, forKey: .adapters)
    try c.encode(killSwitch, forKey: .killSwitch)
    try c.encode(armed, forKey: .armed)
  }
}

extension StatusPayload {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    connectionState = try c.decode(String.self, forKey: .connectionState)
    cursor = try c.decode(StatusCursor?.self, forKey: .cursor)
    counts = try c.decode(StatusCounts.self, forKey: .counts)
    adapters = try c.decode([JSONValue].self, forKey: .adapters)
    killSwitch = try c.decode(Bool?.self, forKey: .killSwitch)
    armed = try c.decode(ArmingStatePayload?.self, forKey: .armed)
  }
}

public struct GlobalModeResult: Codable, Equatable, Sendable {
  public var key: String
  public var mode: RespondMode
  public var armed: ArmingStatePayload

  enum CodingKeys: String, CodingKey, CaseIterable {
    case key, mode, armed
  }
}

extension GlobalModeResult {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    key = try c.decode(String.self, forKey: .key)
    mode = try c.decode(RespondMode.self, forKey: .mode)
    armed = try c.decode(ArmingStatePayload.self, forKey: .armed)
  }
}

public struct KillSwitchResult: Codable, Equatable, Sendable {
  public var key: String
  public var on: Bool
  public var version: Int
  public var cancelled: [String]
  public var circuitCleared: Bool

  enum CodingKeys: String, CodingKey, CaseIterable {
    case key, on, version, cancelled, circuitCleared
  }
}

extension KillSwitchResult {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    key = try c.decode(String.self, forKey: .key)
    on = try c.decode(Bool.self, forKey: .on)
    version = try c.decode(Int.self, forKey: .version)
    cancelled = try c.decode([String].self, forKey: .cancelled)
    circuitCleared = try c.decode(Bool.self, forKey: .circuitCleared)
  }
}

/// pause and resume (both `POST /v1/toggles/pause`).
public struct PauseResult: Codable, Equatable, Sendable {
  public var key: String
  /// Required and nullable: null after a resume.
  public var until: String?
  public var armed: ArmingStatePayload

  enum CodingKeys: String, CodingKey, CaseIterable {
    case key, until, armed
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(key, forKey: .key)
    try c.encode(until, forKey: .until)
    try c.encode(armed, forKey: .armed)
  }
}

extension PauseResult {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    key = try c.decode(String.self, forKey: .key)
    until = try c.decode(String?.self, forKey: .until)
    armed = try c.decode(ArmingStatePayload.self, forKey: .armed)
  }
}

// MARK: doctor and disconnect

public struct DoctorCheckPayload: Codable, Equatable, Sendable {
  public var id: String
  public var status: String
  public var detail: String?
  public var remediation: String?

  enum CodingKeys: String, CodingKey, CaseIterable {
    case id, status, detail, remediation
  }
}

extension DoctorCheckPayload {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    status = try c.decode(String.self, forKey: .status)
    detail = try c.decodeIfPresent(String.self, forKey: .detail)
    remediation = try c.decodeIfPresent(String.self, forKey: .remediation)
  }
}

/// Which runtime answered, and for which host: a union on `kind`, present
/// only when the daemon can name one. `electron` is the Electron app
/// re-entered as Node; `node` is this app's own Node, which the daemon knows
/// from `WEMESSAGE_HOST=swift`. Each variant refuses the other's members, so
/// a report can never be read as both.
public enum DoctorRuntimePayload: Codable, Equatable, Sendable {
  case electron(electron: String, node: String, abi: Int)
  case node(host: String, node: String, abi: Int)

  enum CodingKeys: String, CodingKey {
    case kind, electron, host, node, abi
  }

  public init(from decoder: any Decoder) throws {
    let probe = try decoder.container(keyedBy: CodingKeys.self)
    let kind = try probe.decode(String.self, forKey: .kind)
    switch kind {
    case "electron":
      let c = try decoder.strictContainer(keyedBy: CodingKeys.self, allowing: [.kind, .electron, .node, .abi])
      self = .electron(
        electron: try c.decode(String.self, forKey: .electron),
        node: try c.decode(String.self, forKey: .node),
        abi: try c.decode(Int.self, forKey: .abi))
    case "node":
      let c = try decoder.strictContainer(keyedBy: CodingKeys.self, allowing: [.kind, .host, .node, .abi])
      self = .node(
        host: try c.decode(String.self, forKey: .host),
        node: try c.decode(String.self, forKey: .node),
        abi: try c.decode(Int.self, forKey: .abi))
    default:
      throw DecodingError.dataCorruptedError(
        forKey: .kind, in: probe, debugDescription: "unknown runtime kind \"\(kind)\"")
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .electron(let electron, let node, let abi):
      try c.encode("electron", forKey: .kind)
      try c.encode(electron, forKey: .electron)
      try c.encode(node, forKey: .node)
      try c.encode(abi, forKey: .abi)
    case .node(let host, let node, let abi):
      try c.encode("node", forKey: .kind)
      try c.encode(host, forKey: .host)
      try c.encode(node, forKey: .node)
      try c.encode(abi, forKey: .abi)
    }
  }
}

/// `GET /v1/doctor` and `POST /v1/connect`.
public struct DoctorReportPayload: Codable, Equatable, Sendable {
  public var state: String
  public var checks: [DoctorCheckPayload]
  public var probedAt: String
  public var supervisor: String
  public var runtime: DoctorRuntimePayload?

  enum CodingKeys: String, CodingKey, CaseIterable {
    case state, checks, probedAt, supervisor, runtime
  }
}

extension DoctorReportPayload {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    state = try c.decode(String.self, forKey: .state)
    checks = try c.decode([DoctorCheckPayload].self, forKey: .checks)
    probedAt = try c.decode(String.self, forKey: .probedAt)
    supervisor = try c.decode(String.self, forKey: .supervisor)
    runtime = try c.decodeIfPresent(DoctorRuntimePayload.self, forKey: .runtime)
  }
}

public struct DisconnectStepPayload: Codable, Equatable, Sendable {
  public var id: String
  public var status: String
  public var detail: String?
  public var plistRemoved: Bool?

  enum CodingKeys: String, CodingKey, CaseIterable {
    case id, status, detail, plistRemoved
  }
}

extension DisconnectStepPayload {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    status = try c.decode(String.self, forKey: .status)
    detail = try c.decodeIfPresent(String.self, forKey: .detail)
    plistRemoved = try c.decodeIfPresent(Bool.self, forKey: .plistRemoved)
  }
}

public struct DisconnectReportPayload: Codable, Equatable, Sendable {
  public var state: String
  public var steps: [DisconnectStepPayload]
  public var manualRevocation: [String]

  enum CodingKeys: String, CodingKey, CaseIterable {
    case state, steps, manualRevocation
  }
}

extension DisconnectReportPayload {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    state = try c.decode(String.self, forKey: .state)
    steps = try c.decode([DisconnectStepPayload].self, forKey: .steps)
    manualRevocation = try c.decode([String].self, forKey: .manualRevocation)
  }
}

// MARK: audit

/// One hash-chained audit row. `eventJson` and `actorJson` are JSON text,
/// kept verbatim because the chain hashes those exact bytes.
public struct AuditRowPayload: Codable, Equatable, Sendable {
  public var seq: Int
  public var at: String
  public var eventJson: String
  public var actorJson: String
  public var prevHash: String
  public var hash: String

  enum CodingKeys: String, CodingKey, CaseIterable {
    case seq, at, eventJson, actorJson, prevHash, hash
  }
}

extension AuditRowPayload {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    seq = try c.decode(Int.self, forKey: .seq)
    at = try c.decode(String.self, forKey: .at)
    eventJson = try c.decode(String.self, forKey: .eventJson)
    actorJson = try c.decode(String.self, forKey: .actorJson)
    prevHash = try c.decode(String.self, forKey: .prevHash)
    hash = try c.decode(String.self, forKey: .hash)
  }
}

public struct AuditVerifyResult: Codable, Equatable, Sendable {
  public var ok: Bool
  public var length: Int
  public var brokenAtSeq: Int?
  public var reason: String?
  public var expectedHash: String?
  public var actualHash: String?

  enum CodingKeys: String, CodingKey, CaseIterable {
    case ok, length, brokenAtSeq, reason, expectedHash, actualHash
  }
}

extension AuditVerifyResult {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    ok = try c.decode(Bool.self, forKey: .ok)
    length = try c.decode(Int.self, forKey: .length)
    brokenAtSeq = try c.decodeIfPresent(Int.self, forKey: .brokenAtSeq)
    reason = try c.decodeIfPresent(String.self, forKey: .reason)
    expectedHash = try c.decodeIfPresent(String.self, forKey: .expectedHash)
    actualHash = try c.decodeIfPresent(String.self, forKey: .actualHash)
  }
}

/// `GET /v1/audit` query.
public struct AuditQuery: Equatable, Sendable {
  public var since: String?
  public var event: String?
  public var limit: Int?

  public init(since: String? = nil, event: String? = nil, limit: Int? = nil) {
    self.since = since
    self.event = event
    self.limit = limit
  }
}

// MARK: send

public struct SendError: Codable, Equatable, Sendable {
  public var code: String
  public var message: String

  enum CodingKeys: String, CodingKey, CaseIterable {
    case code, message
  }
}

extension SendError {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    code = try c.decode(String.self, forKey: .code)
    message = try c.decode(String.self, forKey: .message)
  }
}

/// `POST /v1/send`: sent with an outbound guid, or failed with an error.
public struct SendResult: Codable, Equatable, Sendable {
  public var draftId: String
  public var outcome: String
  public var sentMessageGuid: String?
  public var error: SendError?

  enum CodingKeys: String, CodingKey, CaseIterable {
    case draftId, outcome, sentMessageGuid, error
  }
}

extension SendResult {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    draftId = try c.decode(String.self, forKey: .draftId)
    outcome = try c.decode(String.self, forKey: .outcome)
    sentMessageGuid = try c.decodeIfPresent(String.self, forKey: .sentMessageGuid)
    error = try c.decodeIfPresent(SendError.self, forKey: .error)
  }
}

// MARK: contacts

/// Who may be answered, and how.
public enum ContactMode: String, Codable, CaseIterable, Equatable, Sendable {
  case deny
  case draftOnly = "draft-only"
  case auto
}

public struct ContactPolicyPayload: Codable, Equatable, Sendable {
  public var handle: String
  public var displayName: String?
  public var mode: ContactMode
  public var updatedAt: String

  enum CodingKeys: String, CodingKey, CaseIterable {
    case handle, displayName, mode, updatedAt
  }
}

extension ContactPolicyPayload {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    handle = try c.decode(String.self, forKey: .handle)
    displayName = try c.decodeIfPresent(String.self, forKey: .displayName)
    mode = try c.decode(ContactMode.self, forKey: .mode)
    updatedAt = try c.decode(String.self, forKey: .updatedAt)
  }
}

public struct ContactsEnvelope: Codable, Equatable, Sendable {
  public var contacts: [ContactPolicyPayload]

  enum CodingKeys: String, CodingKey, CaseIterable {
    case contacts
  }
}

extension ContactsEnvelope {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    contacts = try c.decode([ContactPolicyPayload].self, forKey: .contacts)
  }
}

public struct ContactEnvelope: Codable, Equatable, Sendable {
  public var contact: ContactPolicyPayload

  enum CodingKeys: String, CodingKey, CaseIterable {
    case contact
  }
}

extension ContactEnvelope {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    contact = try c.decode(ContactPolicyPayload.self, forKey: .contact)
  }
}
