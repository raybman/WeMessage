import Foundation

// v2 F3 (G-06a): the daemon's record of Done, Snooze and Mute for one
// conversation, `PUT /v1/threads/:guid/state` and `GET /v1/threads/state`.
// The act and attention vocabularies stay strings, as every vocabulary the
// daemon may widen does; the board maps them (unknown values read as none).

/// One conversation's stored state, plus `awake`, which the daemon computes
/// against its own clock on every read and frame (it is never stored).
public struct ThreadStateRecord: Codable, Equatable, Sendable {
  public var chatGuid: String
  /// "done", "snoozed" or "muted"; null when only attention is set.
  public var act: String?
  public var actAt: String?
  /// Set only for a snooze.
  public var snoozedUntil: String?
  /// "queue", "stream" or "muted"; null means the derived default.
  public var attention: String?
  public var updatedAt: String
  public var awake: Bool

  public init(
    chatGuid: String, act: String?, actAt: String?, snoozedUntil: String?, attention: String?,
    updatedAt: String, awake: Bool
  ) {
    self.chatGuid = chatGuid
    self.act = act
    self.actAt = actAt
    self.snoozedUntil = snoozedUntil
    self.attention = attention
    self.updatedAt = updatedAt
    self.awake = awake
  }

  enum CodingKeys: String, CodingKey, CaseIterable {
    case chatGuid, act, actAt, snoozedUntil, attention, updatedAt, awake
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(chatGuid, forKey: .chatGuid)
    try c.encode(act, forKey: .act)
    try c.encode(actAt, forKey: .actAt)
    try c.encode(snoozedUntil, forKey: .snoozedUntil)
    try c.encode(attention, forKey: .attention)
    try c.encode(updatedAt, forKey: .updatedAt)
    try c.encode(awake, forKey: .awake)
  }
}

extension ThreadStateRecord {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    chatGuid = try c.decode(String.self, forKey: .chatGuid)
    act = try c.decode(String?.self, forKey: .act)
    actAt = try c.decode(String?.self, forKey: .actAt)
    snoozedUntil = try c.decode(String?.self, forKey: .snoozedUntil)
    attention = try c.decode(String?.self, forKey: .attention)
    updatedAt = try c.decode(String.self, forKey: .updatedAt)
    awake = try c.decode(Bool.self, forKey: .awake)
  }
}

/// The answer to a PUT: the record as stored, or null when the write cleared
/// it (no act and no attention means the derived default).
public struct ThreadStateEnvelope: Codable, Equatable, Sendable {
  public var state: ThreadStateRecord?

  public init(state: ThreadStateRecord?) {
    self.state = state
  }

  enum CodingKeys: String, CodingKey, CaseIterable {
    case state
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(state, forKey: .state)
  }
}

extension ThreadStateEnvelope {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    state = try c.decode(ThreadStateRecord?.self, forKey: .state)
  }
}

/// `GET /v1/threads/state`: every stored record, and the daemon's clock.
public struct ThreadStatesPage: Codable, Equatable, Sendable {
  public var states: [ThreadStateRecord]
  public var asOf: String

  public init(states: [ThreadStateRecord], asOf: String) {
    self.states = states
    self.asOf = asOf
  }

  enum CodingKeys: String, CodingKey, CaseIterable {
    case states, asOf
  }
}

extension ThreadStatesPage {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    states = try c.decode([ThreadStateRecord].self, forKey: .states)
    asOf = try c.decode(String.self, forKey: .asOf)
  }
}

/// `PUT /v1/threads/:guid/state`. `act` is always sent (null clears it).
/// For the other fields, nil leaves the key off the wire; `attention: .null`
/// returns attention to the default, and `ifUpdatedAt: .null` says "I expect
/// no record" (a nil ifUpdatedAt skips the concurrency check).
public struct ThreadStateInput: Equatable, Sendable {
  public var act: String?
  /// Undo restore only: the original act's instant.
  public var actAt: String?
  public var snoozedUntil: String?
  public var attention: Nullable<String>?
  public var ifUpdatedAt: Nullable<String>?

  public init(
    act: String?, actAt: String? = nil, snoozedUntil: String? = nil, attention: Nullable<String>? = nil,
    ifUpdatedAt: Nullable<String>? = nil
  ) {
    self.act = act
    self.actAt = actAt
    self.snoozedUntil = snoozedUntil
    self.attention = attention
    self.ifUpdatedAt = ifUpdatedAt
  }

  var json: JSONValue {
    var fields: [String: JSONValue] = ["act": act.map(JSONValue.string) ?? .null]
    if let actAt { fields["actAt"] = .string(actAt) }
    if let snoozedUntil { fields["snoozedUntil"] = .string(snoozedUntil) }
    if let attention { fields["attention"] = attention.json }
    if let ifUpdatedAt { fields["ifUpdatedAt"] = ifUpdatedAt.json }
    return .object(fields)
  }
}

/// thread.state: a conversation's record changed; null means it was cleared.
public struct ThreadStateEvent: Codable, Equatable, Sendable {
  public var chatGuid: String
  public var state: ThreadStateRecord?

  public init(chatGuid: String, state: ThreadStateRecord?) {
    self.chatGuid = chatGuid
    self.state = state
  }

  enum CodingKeys: String, CodingKey, CaseIterable {
    case chatGuid, state
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(chatGuid, forKey: .chatGuid)
    try c.encode(state, forKey: .state)
  }
}

extension ThreadStateEvent {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    chatGuid = try c.decode(String.self, forKey: .chatGuid)
    state = try c.decode(ThreadStateRecord?.self, forKey: .state)
  }
}
