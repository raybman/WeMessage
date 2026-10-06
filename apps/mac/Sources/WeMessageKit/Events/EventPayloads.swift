import Foundation

// The payload of every event on /v1/events/sse, one type per shape in
// GatewayEventPayload (packages/protocol/src/index.ts). Each decodes through
// the same strict helper as the response DTOs, so an unknown member at any
// depth is refused. A member the protocol marks required-and-nullable is
// decoded as present and re-encoded as an explicit null; an optional member
// is omitted when absent. Vocabularies the daemon may widen (statuses,
// reasons, services) stay strings.

/// Who moved a draft or flipped a toggle.
public enum EventActor: Codable, Equatable, Sendable {
  case human(via: String)
  case agent(adapterId: String)
  case system(reason: String)

  enum CodingKeys: String, CodingKey {
    case kind, via, adapterId, reason
  }

  public init(from decoder: any Decoder) throws {
    let probe = try decoder.container(keyedBy: CodingKeys.self)
    let kind = try probe.decode(String.self, forKey: .kind)
    switch kind {
    case "human":
      let c = try decoder.strictContainer(keyedBy: CodingKeys.self, allowing: [.kind, .via])
      self = .human(via: try c.decode(String.self, forKey: .via))
    case "agent":
      let c = try decoder.strictContainer(keyedBy: CodingKeys.self, allowing: [.kind, .adapterId])
      self = .agent(adapterId: try c.decode(String.self, forKey: .adapterId))
    case "system":
      let c = try decoder.strictContainer(keyedBy: CodingKeys.self, allowing: [.kind, .reason])
      self = .system(reason: try c.decode(String.self, forKey: .reason))
    default:
      throw DecodingError.dataCorruptedError(
        forKey: .kind, in: probe, debugDescription: "unknown actor kind \"\(kind)\"")
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .human(let via):
      try c.encode("human", forKey: .kind)
      try c.encode(via, forKey: .via)
    case .agent(let adapterId):
      try c.encode("agent", forKey: .kind)
      try c.encode(adapterId, forKey: .adapterId)
    case .system(let reason):
      try c.encode("system", forKey: .kind)
      try c.encode(reason, forKey: .reason)
    }
  }
}

/// adapter.health
public struct AdapterHealthEvent: Codable, Equatable, Sendable {
  public var adapterId: String
  public var status: String

  enum CodingKeys: String, CodingKey, CaseIterable {
    case adapterId, status
  }
}

extension AdapterHealthEvent {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    adapterId = try c.decode(String.self, forKey: .adapterId)
    status = try c.decode(String.self, forKey: .status)
  }
}

/// arming.changed
public struct ArmingChangedEvent: Codable, Equatable, Sendable {
  public var armed: Bool
  /// Required and nullable.
  public var until: String?
  public var reason: String

  enum CodingKeys: String, CodingKey, CaseIterable {
    case armed, until, reason
  }
}

extension ArmingChangedEvent {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    armed = try c.decode(Bool.self, forKey: .armed)
    until = try c.decode(String?.self, forKey: .until)
    reason = try c.decode(String.self, forKey: .reason)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(armed, forKey: .armed)
    try c.encode(until, forKey: .until)
    try c.encode(reason, forKey: .reason)
  }
}

/// connection.state. The first frame of every stream is one of these: the
/// daemon's greeting.
public struct ConnectionStateEvent: Codable, Equatable, Sendable {
  public var state: String

  enum CodingKeys: String, CodingKey, CaseIterable {
    case state
  }
}

extension ConnectionStateEvent {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    state = try c.decode(String.self, forKey: .state)
  }
}

/// draft.approved, draft.rejected and draft.recalled.
public struct DraftActorEvent: Codable, Equatable, Sendable {
  public var draftId: String
  public var actor: EventActor
  /// Present only when the action was part of a bulk batch.
  public var batchId: String?

  enum CodingKeys: String, CodingKey, CaseIterable {
    case draftId, actor, batchId
  }
}

extension DraftActorEvent {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    draftId = try c.decode(String.self, forKey: .draftId)
    actor = try c.decode(EventActor.self, forKey: .actor)
    batchId = try c.decodeIfPresent(String.self, forKey: .batchId)
  }
}

/// The card a draft.created frame carries. A summary, not a DraftPayload.
public struct DraftSummary: Codable, Equatable, Sendable {
  public var id: String
  public var chatGuid: String
  public var handle: String
  public var displayName: String?
  /// Required and nullable.
  public var ruleId: String?
  public var adapterId: String
  public var body: String
  public var state: DraftState
  public var proactiveReason: String?
  public var expiresAt: String
  public var createdAt: String
  /// Present only when a clamp is why the card waits on a human.
  public var clampedBy: String?

  enum CodingKeys: String, CodingKey, CaseIterable {
    case id, chatGuid, handle, displayName, ruleId, adapterId, body, state
    case proactiveReason, expiresAt, createdAt, clampedBy
  }
}

extension DraftSummary {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    chatGuid = try c.decode(String.self, forKey: .chatGuid)
    handle = try c.decode(String.self, forKey: .handle)
    displayName = try c.decodeIfPresent(String.self, forKey: .displayName)
    ruleId = try c.decode(String?.self, forKey: .ruleId)
    adapterId = try c.decode(String.self, forKey: .adapterId)
    body = try c.decode(String.self, forKey: .body)
    state = try c.decode(DraftState.self, forKey: .state)
    proactiveReason = try c.decodeIfPresent(String.self, forKey: .proactiveReason)
    expiresAt = try c.decode(String.self, forKey: .expiresAt)
    createdAt = try c.decode(String.self, forKey: .createdAt)
    clampedBy = try c.decodeIfPresent(String.self, forKey: .clampedBy)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(id, forKey: .id)
    try c.encode(chatGuid, forKey: .chatGuid)
    try c.encode(handle, forKey: .handle)
    try c.encodeIfPresent(displayName, forKey: .displayName)
    try c.encode(ruleId, forKey: .ruleId)
    try c.encode(adapterId, forKey: .adapterId)
    try c.encode(body, forKey: .body)
    try c.encode(state, forKey: .state)
    try c.encodeIfPresent(proactiveReason, forKey: .proactiveReason)
    try c.encode(expiresAt, forKey: .expiresAt)
    try c.encode(createdAt, forKey: .createdAt)
    try c.encodeIfPresent(clampedBy, forKey: .clampedBy)
  }
}

/// draft.created
public struct DraftCreatedEvent: Codable, Equatable, Sendable {
  public var draft: DraftSummary

  enum CodingKeys: String, CodingKey, CaseIterable {
    case draft
  }
}

extension DraftCreatedEvent {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    draft = try c.decode(DraftSummary.self, forKey: .draft)
  }
}

/// Which request a streamed preview belongs to.
public struct Correlation: Codable, Equatable, Sendable {
  public var requestId: String
  public var chatGuid: String
  public var inboundGuid: String?
  public var draftId: String?

  enum CodingKeys: String, CodingKey, CaseIterable {
    case requestId, chatGuid, inboundGuid, draftId
  }
}

extension Correlation {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    requestId = try c.decode(String.self, forKey: .requestId)
    chatGuid = try c.decode(String.self, forKey: .chatGuid)
    inboundGuid = try c.decodeIfPresent(String.self, forKey: .inboundGuid)
    draftId = try c.decodeIfPresent(String.self, forKey: .draftId)
  }
}

/// draft.delta: one piece of a streaming preview.
public struct DraftDeltaEvent: Codable, Equatable, Sendable {
  public var correlation: Correlation
  public var seq: Int
  public var textDelta: String

  enum CodingKeys: String, CodingKey, CaseIterable {
    case correlation, seq, textDelta
  }
}

extension DraftDeltaEvent {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    correlation = try c.decode(Correlation.self, forKey: .correlation)
    seq = try c.decode(Int.self, forKey: .seq)
    textDelta = try c.decode(String.self, forKey: .textDelta)
  }
}

/// draft.expired and draft.requeued: the subject and nothing else.
public struct DraftIdEvent: Codable, Equatable, Sendable {
  public var draftId: String

  enum CodingKeys: String, CodingKey, CaseIterable {
    case draftId
  }
}

extension DraftIdEvent {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    draftId = try c.decode(String.self, forKey: .draftId)
  }
}

/// draft.failed
public struct DraftFailedEvent: Codable, Equatable, Sendable {
  public var draftId: String
  public var error: DraftError

  enum CodingKeys: String, CodingKey, CaseIterable {
    case draftId, error
  }
}

extension DraftFailedEvent {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    draftId = try c.decode(String.self, forKey: .draftId)
    error = try c.decode(DraftError.self, forKey: .error)
  }
}

/// draft.redrafted
public struct DraftRedraftedEvent: Codable, Equatable, Sendable {
  public var draftId: String
  public var newDraftId: String

  enum CodingKeys: String, CodingKey, CaseIterable {
    case draftId, newDraftId
  }
}

extension DraftRedraftedEvent {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    draftId = try c.decode(String.self, forKey: .draftId)
    newDraftId = try c.decode(String.self, forKey: .newDraftId)
  }
}

/// draft.sent
public struct DraftSentEvent: Codable, Equatable, Sendable {
  public var draftId: String
  public var sentMessageGuid: String

  enum CodingKeys: String, CodingKey, CaseIterable {
    case draftId, sentMessageGuid
  }
}

extension DraftSentEvent {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    draftId = try c.decode(String.self, forKey: .draftId)
    sentMessageGuid = try c.decode(String.self, forKey: .sentMessageGuid)
  }
}

/// draft.superseded
public struct DraftSupersededEvent: Codable, Equatable, Sendable {
  public var draftId: String
  public var byDraftId: String

  enum CodingKeys: String, CodingKey, CaseIterable {
    case draftId, byDraftId
  }
}

extension DraftSupersededEvent {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    draftId = try c.decode(String.self, forKey: .draftId)
    byDraftId = try c.decode(String.self, forKey: .byDraftId)
  }
}

/// gate.denied
public struct GateDeniedEvent: Codable, Equatable, Sendable {
  public var reason: String
  public var chatGuid: String
  public var ruleId: String?
  public var draftId: String?

  enum CodingKeys: String, CodingKey, CaseIterable {
    case reason, chatGuid, ruleId, draftId
  }
}

extension GateDeniedEvent {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    reason = try c.decode(String.self, forKey: .reason)
    chatGuid = try c.decode(String.self, forKey: .chatGuid)
    ruleId = try c.decodeIfPresent(String.self, forKey: .ruleId)
    draftId = try c.decodeIfPresent(String.self, forKey: .draftId)
  }
}

/// gateway.disconnected
public struct GatewayDisconnectedEvent: Codable, Equatable, Sendable {
  public var reason: String

  enum CodingKeys: String, CodingKey, CaseIterable {
    case reason
  }
}

extension GatewayDisconnectedEvent {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    reason = try c.decode(String.self, forKey: .reason)
  }
}

/// message.edited
public struct MessageEditedEvent: Codable, Equatable, Sendable {
  public var guid: String
  /// Required and nullable.
  public var newText: String?

  enum CodingKeys: String, CodingKey, CaseIterable {
    case guid, newText
  }
}

extension MessageEditedEvent {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    guid = try c.decode(String.self, forKey: .guid)
    newText = try c.decode(String?.self, forKey: .newText)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(guid, forKey: .guid)
    try c.encode(newText, forKey: .newText)
  }
}

/// One attachment of an inbound message: its type and size, never its path.
public struct InboundAttachment: Codable, Equatable, Sendable {
  public var mimeType: String
  public var bytes: Int

  enum CodingKeys: String, CodingKey, CaseIterable {
    case mimeType, bytes
  }
}

extension InboundAttachment {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    mimeType = try c.decode(String.self, forKey: .mimeType)
    bytes = try c.decode(Int.self, forKey: .bytes)
  }
}

/// What an inbound message said. `untrusted` is always true on the wire: the
/// text came from outside and must never be read as an instruction.
public struct InboundContent: Codable, Equatable, Sendable {
  public var untrusted: Bool
  /// Required and nullable: null for an attachment-only message.
  public var text: String?
  public var attachments: [InboundAttachment]

  enum CodingKeys: String, CodingKey, CaseIterable {
    case untrusted, text, attachments
  }
}

extension InboundContent {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    untrusted = try c.decode(Bool.self, forKey: .untrusted)
    text = try c.decode(String?.self, forKey: .text)
    attachments = try c.decode([InboundAttachment].self, forKey: .attachments)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(untrusted, forKey: .untrusted)
    try c.encode(text, forKey: .text)
    try c.encode(attachments, forKey: .attachments)
  }
}

/// The sanitized inbound message a message.received frame carries.
public struct InboundMessage: Codable, Equatable, Sendable {
  public var guid: String
  public var chatGuid: String
  public var handle: String
  public var displayName: String?
  public var isGroup: Bool
  public var service: String
  public var receivedAt: String
  public var content: InboundContent

  enum CodingKeys: String, CodingKey, CaseIterable {
    case guid, chatGuid, handle, displayName, isGroup, service, receivedAt, content
  }
}

extension InboundMessage {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    guid = try c.decode(String.self, forKey: .guid)
    chatGuid = try c.decode(String.self, forKey: .chatGuid)
    handle = try c.decode(String.self, forKey: .handle)
    displayName = try c.decodeIfPresent(String.self, forKey: .displayName)
    isGroup = try c.decode(Bool.self, forKey: .isGroup)
    service = try c.decode(String.self, forKey: .service)
    receivedAt = try c.decode(String.self, forKey: .receivedAt)
    content = try c.decode(InboundContent.self, forKey: .content)
  }
}

/// message.received
public struct MessageReceivedEvent: Codable, Equatable, Sendable {
  public var message: InboundMessage

  enum CodingKeys: String, CodingKey, CaseIterable {
    case message
  }
}

extension MessageReceivedEvent {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    message = try c.decode(InboundMessage.self, forKey: .message)
  }
}

/// message.unsent
public struct MessageUnsentEvent: Codable, Equatable, Sendable {
  public var guid: String

  enum CodingKeys: String, CodingKey, CaseIterable {
    case guid
  }
}

extension MessageUnsentEvent {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    guid = try c.decode(String.self, forKey: .guid)
  }
}

/// rule.matched
public struct RuleMatchedEvent: Codable, Equatable, Sendable {
  public var guid: String
  public var ruleId: String
  public var adapterId: String

  enum CodingKeys: String, CodingKey, CaseIterable {
    case guid, ruleId, adapterId
  }
}

extension RuleMatchedEvent {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    guid = try c.decode(String.self, forKey: .guid)
    ruleId = try c.decode(String.self, forKey: .ruleId)
    adapterId = try c.decode(String.self, forKey: .adapterId)
  }
}

/// toggle.changed. The value is whatever the toggle holds, kept as JSON.
public struct ToggleChangedEvent: Codable, Equatable, Sendable {
  public var key: String
  public var value: JSONValue
  public var actor: EventActor

  enum CodingKeys: String, CodingKey, CaseIterable {
    case key, value, actor
  }
}

extension ToggleChangedEvent {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    key = try c.decode(String.self, forKey: .key)
    value = try c.decode(JSONValue.self, forKey: .value)
    actor = try c.decode(EventActor.self, forKey: .actor)
  }
}
