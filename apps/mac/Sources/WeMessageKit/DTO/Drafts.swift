import Foundation

// The draft surface: responses decode strictly (an unknown member is a
// refusal, not a silent drop), requests encode only what the S0 schemas name.

/// Why a draft could not be sent.
public struct DraftError: Codable, Equatable, Sendable {
  public var code: String
  public var message: String
  public var at: String

  public init(code: String, message: String, at: String) {
    self.code = code
    self.message = message
    self.at = at
  }

  enum CodingKeys: String, CodingKey, CaseIterable {
    case code, message, at
  }
}

extension DraftError {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    code = try c.decode(String.self, forKey: .code)
    message = try c.decode(String.self, forKey: .message)
    at = try c.decode(String.self, forKey: .at)
  }
}

/// One draft, as every draft route returns it.
public struct DraftPayload: Codable, Equatable, Sendable {
  public var id: String
  /// Required and nullable: null for a draft no inbound message prompted.
  public var inboundGuid: String?
  public var chatGuid: String
  /// Required and nullable: null for a draft no rule produced.
  public var ruleId: String?
  public var adapterId: String
  public var idempotencyKey: String
  public var body: String
  public var originalBody: String
  /// Present only on a proactive draft.
  public var proactiveReason: String?
  public var state: DraftState
  public var stateChangedAt: String
  public var sendNotBefore: String?
  public var expiresAt: String
  public var createdAt: String
  public var error: DraftError?
  /// Kit-only: the outbound guid a `draft.sent` event reported. Never on the
  /// wire, so it is not a coding key.
  public var sentMessageGuid: String? = nil

  enum CodingKeys: String, CodingKey, CaseIterable {
    case id, inboundGuid, chatGuid, ruleId, adapterId, idempotencyKey, body, originalBody
    case proactiveReason, state, stateChangedAt, sendNotBefore, expiresAt, createdAt, error
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(id, forKey: .id)
    try c.encode(inboundGuid, forKey: .inboundGuid)
    try c.encode(chatGuid, forKey: .chatGuid)
    try c.encode(ruleId, forKey: .ruleId)
    try c.encode(adapterId, forKey: .adapterId)
    try c.encode(idempotencyKey, forKey: .idempotencyKey)
    try c.encode(body, forKey: .body)
    try c.encode(originalBody, forKey: .originalBody)
    try c.encodeIfPresent(proactiveReason, forKey: .proactiveReason)
    try c.encode(state, forKey: .state)
    try c.encode(stateChangedAt, forKey: .stateChangedAt)
    try c.encodeIfPresent(sendNotBefore, forKey: .sendNotBefore)
    try c.encode(expiresAt, forKey: .expiresAt)
    try c.encode(createdAt, forKey: .createdAt)
    try c.encodeIfPresent(error, forKey: .error)
  }
}

extension DraftPayload {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    inboundGuid = try c.decode(String?.self, forKey: .inboundGuid)
    chatGuid = try c.decode(String.self, forKey: .chatGuid)
    ruleId = try c.decode(String?.self, forKey: .ruleId)
    adapterId = try c.decode(String.self, forKey: .adapterId)
    idempotencyKey = try c.decode(String.self, forKey: .idempotencyKey)
    body = try c.decode(String.self, forKey: .body)
    originalBody = try c.decode(String.self, forKey: .originalBody)
    proactiveReason = try c.decodeIfPresent(String.self, forKey: .proactiveReason)
    state = try c.decode(DraftState.self, forKey: .state)
    stateChangedAt = try c.decode(String.self, forKey: .stateChangedAt)
    sendNotBefore = try c.decodeIfPresent(String.self, forKey: .sendNotBefore)
    expiresAt = try c.decode(String.self, forKey: .expiresAt)
    createdAt = try c.decode(String.self, forKey: .createdAt)
    error = try c.decodeIfPresent(DraftError.self, forKey: .error)
    sentMessageGuid = nil
  }
}

/// approve, reject, recall and retry.
public struct DraftActionResult: Codable, Equatable, Sendable {
  public var draft: DraftPayload
  public var approvalId: String

  enum CodingKeys: String, CodingKey, CaseIterable {
    case draft, approvalId
  }
}

extension DraftActionResult {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    draft = try c.decode(DraftPayload.self, forKey: .draft)
    approvalId = try c.decode(String.self, forKey: .approvalId)
  }
}

/// One id a bulk action skipped, and why.
public struct BulkRefusal: Codable, Equatable, Sendable {
  public var id: String
  public var error: String

  enum CodingKeys: String, CodingKey, CaseIterable {
    case id, error
  }
}

extension BulkRefusal {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    error = try c.decode(String.self, forKey: .error)
  }
}

public struct BulkResult: Codable, Equatable, Sendable {
  public var batchId: String
  public var matched: Int
  public var applied: Int
  public var appliedIds: [String]
  public var refused: [BulkRefusal]

  enum CodingKeys: String, CodingKey, CaseIterable {
    case batchId, matched, applied, appliedIds, refused
  }
}

extension BulkResult {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    batchId = try c.decode(String.self, forKey: .batchId)
    matched = try c.decode(Int.self, forKey: .matched)
    applied = try c.decode(Int.self, forKey: .applied)
    appliedIds = try c.decode([String].self, forKey: .appliedIds)
    refused = try c.decode([BulkRefusal].self, forKey: .refused)
  }
}

public struct DraftEnvelope: Codable, Equatable, Sendable {
  public var draft: DraftPayload

  enum CodingKeys: String, CodingKey, CaseIterable {
    case draft
  }
}

extension DraftEnvelope {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    draft = try c.decode(DraftPayload.self, forKey: .draft)
  }
}

public struct DraftsEnvelope: Codable, Equatable, Sendable {
  public var drafts: [DraftPayload]

  enum CodingKeys: String, CodingKey, CaseIterable {
    case drafts
  }
}

extension DraftsEnvelope {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    drafts = try c.decode([DraftPayload].self, forKey: .drafts)
  }
}

/// One recorded decision on a draft.
public struct ApprovalPayload: Codable, Equatable, Sendable {
  public var id: String
  public var draftId: String
  public var action: String
  public var editedBody: String?
  public var batchId: String?
  public var at: String

  enum CodingKeys: String, CodingKey, CaseIterable {
    case id, draftId, action, editedBody, batchId, at
  }
}

extension ApprovalPayload {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    draftId = try c.decode(String.self, forKey: .draftId)
    action = try c.decode(String.self, forKey: .action)
    editedBody = try c.decodeIfPresent(String.self, forKey: .editedBody)
    batchId = try c.decodeIfPresent(String.self, forKey: .batchId)
    at = try c.decode(String.self, forKey: .at)
  }
}

public struct DraftDetail: Codable, Equatable, Sendable {
  public var draft: DraftPayload
  public var approvals: [ApprovalPayload]

  enum CodingKeys: String, CodingKey, CaseIterable {
    case draft, approvals
  }
}

extension DraftDetail {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    draft = try c.decode(DraftPayload.self, forKey: .draft)
    approvals = try c.decode([ApprovalPayload].self, forKey: .approvals)
  }
}

public struct RedraftResult: Codable, Equatable, Sendable {
  public var fromDraftId: String
  public var draft: DraftPayload

  enum CodingKeys: String, CodingKey, CaseIterable {
    case fromDraftId, draft
  }
}

extension RedraftResult {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    fromDraftId = try c.decode(String.self, forKey: .fromDraftId)
    draft = try c.decode(DraftPayload.self, forKey: .draft)
  }
}

/// The reconnect report for one bulk batch (`GET /v1/batches/:id`).
public struct BatchReport: Codable, Equatable, Sendable {
  public var batchId: String
  public var approved: Int
  public var sending: Int
  public var sent: Int
  public var failed: Int
  public var recalled: Int

  enum CodingKeys: String, CodingKey, CaseIterable {
    case batchId, approved, sending, sent, failed, recalled
  }
}

extension BatchReport {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    batchId = try c.decode(String.self, forKey: .batchId)
    approved = try c.decode(Int.self, forKey: .approved)
    sending = try c.decode(Int.self, forKey: .sending)
    sent = try c.decode(Int.self, forKey: .sent)
    failed = try c.decode(Int.self, forKey: .failed)
    recalled = try c.decode(Int.self, forKey: .recalled)
  }
}

// MARK: requests

/// `POST /v1/drafts`.
public struct DraftCreateInput: Equatable, Sendable {
  public var chatGuid: String
  public var body: String
  public var ttlMinutes: Int?

  public init(chatGuid: String, body: String, ttlMinutes: Int? = nil) {
    self.chatGuid = chatGuid
    self.body = body
    self.ttlMinutes = ttlMinutes
  }

  var json: JSONValue {
    var fields: [String: JSONValue] = ["chatGuid": .string(chatGuid), "body": .string(body)]
    if let ttlMinutes { fields["ttlMinutes"] = .number(Double(ttlMinutes)) }
    return .object(fields)
  }
}

/// `GET /v1/drafts` query.
public struct DraftFilter: Equatable, Sendable {
  public var state: DraftState?
  public var ruleId: String?
  public var contact: String?
  public var batchId: String?

  public init(state: DraftState? = nil, ruleId: String? = nil, contact: String? = nil, batchId: String? = nil) {
    self.state = state
    self.ruleId = ruleId
    self.contact = contact
    self.batchId = batchId
  }
}

/// What `POST /v1/drafts/bulk` does to the selection.
public enum BulkAction: String, Codable, Equatable, Sendable, CaseIterable {
  case approve
  case recall
  case reject
}

/// The filter half of a bulk selection.
public struct BulkFilter: Equatable, Sendable {
  public var all: Bool
  public var rule: String?
  public var contact: String?

  public init(all: Bool, rule: String? = nil, contact: String? = nil) {
    self.all = all
    self.rule = rule
    self.contact = contact
  }

  var json: JSONValue {
    var fields: [String: JSONValue] = [:]
    if all { fields["all"] = .bool(true) }
    if let rule { fields["rule"] = .string(rule) }
    if let contact { fields["contact"] = .string(contact) }
    return .object(fields)
  }
}

/// Exactly one of ids or filter (the route 400s on both, and on neither).
public enum BulkSelector: Equatable, Sendable {
  case ids([String])
  case filter(BulkFilter)

  /// Nil for both, for neither, and for an empty id list (which selects nothing).
  public init?(ids: [String]?, filter: BulkFilter?) {
    switch (ids, filter) {
    case (let ids?, nil) where !ids.isEmpty:
      self = .ids(ids)
    case (nil, let filter?):
      self = .filter(filter)
    default:
      return nil
    }
  }
}
