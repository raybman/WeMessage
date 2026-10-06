import Foundation

/// How a rule answers: hold a draft for approval, or send on its own.
public enum RespondMode: String, Codable, CaseIterable, Equatable, Sendable {
  case draftOnly = "draft-only"
  case auto
}

/// `POST /v1/toggles/global-mode` takes the same two modes a rule does.
public typealias GlobalMode = RespondMode

/// What a rule does with a match outside its schedule's windows.
public enum OutsideWindow: String, Codable, CaseIterable, Equatable, Sendable {
  case draftOnly = "draft-only"
  case queue
  case ignore
}

/// Whether a keyword matcher needs any or all of its keywords.
public enum KeywordMode: String, Codable, CaseIterable, Equatable, Sendable {
  case any
  case all
}

/// A rule's matcher. The wire form is a JSON object discriminated by `kind`,
/// and each kind refuses the members the others use.
public enum RuleMatcher: Codable, Equatable, Sendable {
  case keyword([String], mode: KeywordMode = .any, caseSensitive: Bool? = nil, wholeWord: Bool? = nil)
  case regex(String)
  case theme([String], minConfidence: Double)
  case contact([String])
  case allOf([RuleMatcher])
  case anyOf([RuleMatcher])

  enum CodingKeys: String, CodingKey, CaseIterable {
    case kind, keywords, mode, caseSensitive, wholeWord, pattern, themes, minConfidence, handles, matchers
  }

  public init(from decoder: any Decoder) throws {
    let probe = try decoder.container(keyedBy: CodingKeys.self)
    let kind = try probe.decode(String.self, forKey: .kind)
    switch kind {
    case "keyword":
      let c = try decoder.strictContainer(
        keyedBy: CodingKeys.self, allowing: [.kind, .keywords, .mode, .caseSensitive, .wholeWord])
      self = .keyword(
        try c.decode([String].self, forKey: .keywords),
        mode: try c.decode(KeywordMode.self, forKey: .mode),
        caseSensitive: try c.decodeIfPresent(Bool.self, forKey: .caseSensitive),
        wholeWord: try c.decodeIfPresent(Bool.self, forKey: .wholeWord))
    case "regex":
      let c = try decoder.strictContainer(keyedBy: CodingKeys.self, allowing: [.kind, .pattern])
      self = .regex(try c.decode(String.self, forKey: .pattern))
    case "theme":
      let c = try decoder.strictContainer(keyedBy: CodingKeys.self, allowing: [.kind, .themes, .minConfidence])
      self = .theme(
        try c.decode([String].self, forKey: .themes), minConfidence: try c.decode(Double.self, forKey: .minConfidence))
    case "contact":
      let c = try decoder.strictContainer(keyedBy: CodingKeys.self, allowing: [.kind, .handles])
      self = .contact(try c.decode([String].self, forKey: .handles))
    case "all-of":
      let c = try decoder.strictContainer(keyedBy: CodingKeys.self, allowing: [.kind, .matchers])
      self = .allOf(try c.decode([RuleMatcher].self, forKey: .matchers))
    case "any-of":
      let c = try decoder.strictContainer(keyedBy: CodingKeys.self, allowing: [.kind, .matchers])
      self = .anyOf(try c.decode([RuleMatcher].self, forKey: .matchers))
    default:
      throw DecodingError.dataCorruptedError(
        forKey: .kind, in: probe, debugDescription: "unknown matcher kind \"\(kind)\"")
    }
  }

  public func encode(to encoder: any Encoder) throws {
    try json.encode(to: encoder)
  }

  /// The wire object.
  public var json: JSONValue {
    switch self {
    case .keyword(let keywords, let mode, let caseSensitive, let wholeWord):
      var fields: [String: JSONValue] = [
        "kind": "keyword", "keywords": .array(keywords.map(JSONValue.string)), "mode": .string(mode.rawValue),
      ]
      if let caseSensitive { fields["caseSensitive"] = .bool(caseSensitive) }
      if let wholeWord { fields["wholeWord"] = .bool(wholeWord) }
      return .object(fields)
    case .regex(let pattern):
      return ["kind": "regex", "pattern": .string(pattern)]
    case .theme(let themes, let minConfidence):
      return [
        "kind": "theme", "themes": .array(themes.map(JSONValue.string)), "minConfidence": .number(minConfidence),
      ]
    case .contact(let handles):
      return ["kind": "contact", "handles": .array(handles.map(JSONValue.string))]
    case .allOf(let matchers):
      return ["kind": "all-of", "matchers": .array(matchers.map(\.json))]
    case .anyOf(let matchers):
      return ["kind": "any-of", "matchers": .array(matchers.map(\.json))]
    }
  }
}

/// One rule, as the rule routes return it.
public struct RulePayload: Codable, Equatable, Sendable {
  public var id: String
  public var name: String
  public var enabled: Bool
  public var matcher: RuleMatcher
  public var adapterId: String
  public var respondMode: RespondMode
  /// Required and nullable: null when the rule runs at all hours.
  public var scheduleId: String?
  public var outsideWindow: OutsideWindow
  public var allowGroupDrafts: Bool
  public var matchAttachmentOnly: Bool
  public var draftTtlMinutes: Int
  public var priority: Int
  public var createdAt: String
  public var updatedAt: String

  enum CodingKeys: String, CodingKey, CaseIterable {
    case id, name, enabled, matcher, adapterId, respondMode, scheduleId, outsideWindow
    case allowGroupDrafts, matchAttachmentOnly, draftTtlMinutes, priority, createdAt, updatedAt
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(id, forKey: .id)
    try c.encode(name, forKey: .name)
    try c.encode(enabled, forKey: .enabled)
    try c.encode(matcher, forKey: .matcher)
    try c.encode(adapterId, forKey: .adapterId)
    try c.encode(respondMode, forKey: .respondMode)
    try c.encode(scheduleId, forKey: .scheduleId)
    try c.encode(outsideWindow, forKey: .outsideWindow)
    try c.encode(allowGroupDrafts, forKey: .allowGroupDrafts)
    try c.encode(matchAttachmentOnly, forKey: .matchAttachmentOnly)
    try c.encode(draftTtlMinutes, forKey: .draftTtlMinutes)
    try c.encode(priority, forKey: .priority)
    try c.encode(createdAt, forKey: .createdAt)
    try c.encode(updatedAt, forKey: .updatedAt)
  }
}

extension RulePayload {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    name = try c.decode(String.self, forKey: .name)
    enabled = try c.decode(Bool.self, forKey: .enabled)
    matcher = try c.decode(RuleMatcher.self, forKey: .matcher)
    adapterId = try c.decode(String.self, forKey: .adapterId)
    respondMode = try c.decode(RespondMode.self, forKey: .respondMode)
    scheduleId = try c.decode(String?.self, forKey: .scheduleId)
    outsideWindow = try c.decode(OutsideWindow.self, forKey: .outsideWindow)
    allowGroupDrafts = try c.decode(Bool.self, forKey: .allowGroupDrafts)
    matchAttachmentOnly = try c.decode(Bool.self, forKey: .matchAttachmentOnly)
    draftTtlMinutes = try c.decode(Int.self, forKey: .draftTtlMinutes)
    priority = try c.decode(Int.self, forKey: .priority)
    createdAt = try c.decode(String.self, forKey: .createdAt)
    updatedAt = try c.decode(String.self, forKey: .updatedAt)
  }
}

/// create and patch: the rule, and whether its adapter is registered yet.
public struct RuleWriteResult: Codable, Equatable, Sendable {
  public var rule: RulePayload
  public var adapterKnown: Bool

  enum CodingKeys: String, CodingKey, CaseIterable {
    case rule, adapterKnown
  }
}

extension RuleWriteResult {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    rule = try c.decode(RulePayload.self, forKey: .rule)
    adapterKnown = try c.decode(Bool.self, forKey: .adapterKnown)
  }
}

public struct DryRunRow: Codable, Equatable, Sendable {
  public var guid: String
  public var handle: String
  /// Required and nullable.
  public var textPreview: String?
  public var matched: Bool

  enum CodingKeys: String, CodingKey, CaseIterable {
    case guid, handle, textPreview, matched
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(guid, forKey: .guid)
    try c.encode(handle, forKey: .handle)
    try c.encode(textPreview, forKey: .textPreview)
    try c.encode(matched, forKey: .matched)
  }
}

extension DryRunRow {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    guid = try c.decode(String.self, forKey: .guid)
    handle = try c.decode(String.self, forKey: .handle)
    textPreview = try c.decode(String?.self, forKey: .textPreview)
    matched = try c.decode(Bool.self, forKey: .matched)
  }
}

public struct DryRunResult: Codable, Equatable, Sendable {
  public var total: Int
  public var matched: Int
  public var rows: [DryRunRow]

  enum CodingKeys: String, CodingKey, CaseIterable {
    case total, matched, rows
  }
}

extension DryRunResult {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    total = try c.decode(Int.self, forKey: .total)
    matched = try c.decode(Int.self, forKey: .matched)
    rows = try c.decode([DryRunRow].self, forKey: .rows)
  }
}

public struct RuleTestDetail: Codable, Equatable, Sendable {
  public var matchedRuleIds: [String]

  enum CodingKeys: String, CodingKey, CaseIterable {
    case matchedRuleIds
  }
}

extension RuleTestDetail {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    matchedRuleIds = try c.decode([String].self, forKey: .matchedRuleIds)
  }
}

public struct RuleTestResult: Codable, Equatable, Sendable {
  public var matched: Bool
  public var detail: RuleTestDetail

  enum CodingKeys: String, CodingKey, CaseIterable {
    case matched, detail
  }
}

extension RuleTestResult {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    matched = try c.decode(Bool.self, forKey: .matched)
    detail = try c.decode(RuleTestDetail.self, forKey: .detail)
  }
}

// MARK: requests

/// `POST /v1/rules`. Unset optionals are left to the daemon's defaults.
public struct RuleInput: Equatable, Sendable {
  public var name: String
  public var matcher: RuleMatcher
  public var adapterId: String
  public var respondMode: RespondMode?
  public var scheduleId: String?
  public var outsideWindow: OutsideWindow?
  public var allowGroupDrafts: Bool?
  public var matchAttachmentOnly: Bool?
  public var draftTtlMinutes: Int?
  public var priority: Int?
  public var enabled: Bool?

  public init(
    name: String, matcher: RuleMatcher, adapterId: String, respondMode: RespondMode? = nil,
    scheduleId: String? = nil, outsideWindow: OutsideWindow? = nil, allowGroupDrafts: Bool? = nil,
    matchAttachmentOnly: Bool? = nil, draftTtlMinutes: Int? = nil, priority: Int? = nil, enabled: Bool? = nil
  ) {
    self.name = name
    self.matcher = matcher
    self.adapterId = adapterId
    self.respondMode = respondMode
    self.scheduleId = scheduleId
    self.outsideWindow = outsideWindow
    self.allowGroupDrafts = allowGroupDrafts
    self.matchAttachmentOnly = matchAttachmentOnly
    self.draftTtlMinutes = draftTtlMinutes
    self.priority = priority
    self.enabled = enabled
  }

  var json: JSONValue {
    var fields: [String: JSONValue] = [
      "name": .string(name), "matcher": matcher.json, "adapterId": .string(adapterId),
    ]
    if let respondMode { fields["respondMode"] = .string(respondMode.rawValue) }
    if let scheduleId { fields["scheduleId"] = .string(scheduleId) }
    if let outsideWindow { fields["outsideWindow"] = .string(outsideWindow.rawValue) }
    if let allowGroupDrafts { fields["allowGroupDrafts"] = .bool(allowGroupDrafts) }
    if let matchAttachmentOnly { fields["matchAttachmentOnly"] = .bool(matchAttachmentOnly) }
    if let draftTtlMinutes { fields["draftTtlMinutes"] = .number(Double(draftTtlMinutes)) }
    if let priority { fields["priority"] = .number(Double(priority)) }
    if let enabled { fields["enabled"] = .bool(enabled) }
    return .object(fields)
  }
}

/// `PATCH /v1/rules/:id`. Nil leaves a field alone; `scheduleId: .null`
/// detaches the schedule.
public struct RulePatch: Equatable, Sendable {
  public var name: String?
  public var matcher: RuleMatcher?
  public var adapterId: String?
  public var respondMode: RespondMode?
  public var scheduleId: Nullable<String>?
  public var outsideWindow: OutsideWindow?
  public var allowGroupDrafts: Bool?
  public var matchAttachmentOnly: Bool?
  public var draftTtlMinutes: Int?
  public var priority: Int?
  public var enabled: Bool?

  public init(
    name: String? = nil, matcher: RuleMatcher? = nil, adapterId: String? = nil, respondMode: RespondMode? = nil,
    scheduleId: Nullable<String>? = nil, outsideWindow: OutsideWindow? = nil, allowGroupDrafts: Bool? = nil,
    matchAttachmentOnly: Bool? = nil, draftTtlMinutes: Int? = nil, priority: Int? = nil, enabled: Bool? = nil
  ) {
    self.name = name
    self.matcher = matcher
    self.adapterId = adapterId
    self.respondMode = respondMode
    self.scheduleId = scheduleId
    self.outsideWindow = outsideWindow
    self.allowGroupDrafts = allowGroupDrafts
    self.matchAttachmentOnly = matchAttachmentOnly
    self.draftTtlMinutes = draftTtlMinutes
    self.priority = priority
    self.enabled = enabled
  }

  var json: JSONValue {
    var fields: [String: JSONValue] = [:]
    if let name { fields["name"] = .string(name) }
    if let matcher { fields["matcher"] = matcher.json }
    if let adapterId { fields["adapterId"] = .string(adapterId) }
    if let respondMode { fields["respondMode"] = .string(respondMode.rawValue) }
    if let scheduleId { fields["scheduleId"] = scheduleId.json }
    if let outsideWindow { fields["outsideWindow"] = .string(outsideWindow.rawValue) }
    if let allowGroupDrafts { fields["allowGroupDrafts"] = .bool(allowGroupDrafts) }
    if let matchAttachmentOnly { fields["matchAttachmentOnly"] = .bool(matchAttachmentOnly) }
    if let draftTtlMinutes { fields["draftTtlMinutes"] = .number(Double(draftTtlMinutes)) }
    if let priority { fields["priority"] = .number(Double(priority)) }
    if let enabled { fields["enabled"] = .bool(enabled) }
    return .object(fields)
  }
}

/// The kind of message `POST /v1/rules/:id/test` should pretend arrived.
public enum RuleTestKind: String, Codable, CaseIterable, Equatable, Sendable {
  case text
  case tapback
  case edit
  case unsend
  case audio
  case attachmentOnly = "attachment-only"
}

/// `POST /v1/rules/:id/test`. `text` is always sent, as null when absent.
public struct RuleTestInput: Equatable, Sendable {
  public var text: String?
  public var handle: String?
  public var isGroup: Bool?
  public var kind: RuleTestKind?

  public init(text: String?, handle: String? = nil, isGroup: Bool? = nil, kind: RuleTestKind? = nil) {
    self.text = text
    self.handle = handle
    self.isGroup = isGroup
    self.kind = kind
  }

  var json: JSONValue {
    var fields: [String: JSONValue] = ["text": text.map(JSONValue.string) ?? .null]
    if let handle { fields["handle"] = .string(handle) }
    if let isGroup { fields["isGroup"] = .bool(isGroup) }
    if let kind { fields["kind"] = .string(kind.rawValue) }
    return .object(fields)
  }
}
