import Foundation

// v2 F2d: `GET /v1/search` (route ratchet #30) and
// `GET /v1/threads/:guid/years` (#31), strictly decoded like every other DTO.
// The kit sends structured tokens only; parsing what the operator typed is
// the app's job (WeMessageApp/Models/SearchQuery.swift).

/// What `GET /v1/search` is asked. Lists repeat their key on the wire
/// (`term=a&term=b`), in the TS client's fixed order. `fromMe` wins over
/// `fromName`: the wire carries one `from`, and "me" is the operator.
public struct SearchParams: Sendable, Equatable {
  public var terms: [String]
  public var fromMe: Bool
  public var fromName: String?
  public var inThread: String?
  /// "imessage", "whatsapp", "linkedin" or "email".
  public var channels: [String]
  /// "attachment", "link" or "voice".
  public var has: [String]
  /// Instants, sent as ISO-8601 UTC with milliseconds.
  public var before: Date?
  public var after: Date?
  /// The IANA zone the year facets are counted in. Required.
  public var tz: String
  public var limit: Int
  /// Passed back verbatim; bound to the query and zone that minted it.
  public var cursor: String?

  public init(
    terms: [String] = [], fromMe: Bool = false, fromName: String? = nil, inThread: String? = nil,
    channels: [String] = [], has: [String] = [], before: Date? = nil, after: Date? = nil, tz: String,
    limit: Int = 50, cursor: String? = nil
  ) {
    self.terms = terms
    self.fromMe = fromMe
    self.fromName = fromName
    self.inThread = inThread
    self.channels = channels
    self.has = has
    self.before = before
    self.after = after
    self.tz = tz
    self.limit = limit
    self.cursor = cursor
  }

  /// The query, in the TS client's order: term, from, in, channel, has,
  /// before, after, tz, limit, cursor.
  var queryItems: [URLQueryItem] {
    var items: [URLQueryItem] = []
    func add(_ name: String, _ value: String?) {
      if let value { items.append(URLQueryItem(name: name, value: value)) }
    }
    for term in terms { add("term", term) }
    add("from", fromMe ? "me" : fromName)
    add("in", inThread)
    for channel in channels { add("channel", channel) }
    for kind in has { add("has", kind) }
    add("before", before.map(Self.instant))
    add("after", after.map(Self.instant))
    add("tz", tz)
    add("limit", String(limit))
    add("cursor", cursor)
    return items
  }

  /// "2024-01-01T08:00:00.000Z": what `new Date().toISOString()` writes.
  static func instant(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.timeZone = TimeZone(identifier: "UTC")
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
  }
}

/// One hit. Never an attachment path.
public struct SearchHitDTO: Codable, Equatable, Sendable {
  public var guid: String
  public var chatGuid: String
  /// Required and nullable: null when the daemon could not read titles.
  public var title: String?
  public var isGroup: Bool
  public var channel: String
  /// "me" or "them".
  public var from: String
  /// Required and nullable: null for the operator's own.
  public var handle: String?
  public var text: String?
  public var sentAt: String
  public var hasAttachment: Bool

  enum CodingKeys: String, CodingKey, CaseIterable {
    case guid, chatGuid, title, isGroup, channel, from, handle, text, sentAt, hasAttachment
  }

  public init(
    guid: String, chatGuid: String, title: String?, isGroup: Bool, channel: String = "imessage", from: String,
    handle: String?, text: String?, sentAt: String, hasAttachment: Bool = false
  ) {
    self.guid = guid
    self.chatGuid = chatGuid
    self.title = title
    self.isGroup = isGroup
    self.channel = channel
    self.from = from
    self.handle = handle
    self.text = text
    self.sentAt = sentAt
    self.hasAttachment = hasAttachment
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    guid = try c.decode(String.self, forKey: .guid)
    chatGuid = try c.decode(String.self, forKey: .chatGuid)
    title = try c.decode(String?.self, forKey: .title)
    isGroup = try c.decode(Bool.self, forKey: .isGroup)
    channel = try c.decode(String.self, forKey: .channel)
    from = try c.decode(String.self, forKey: .from)
    handle = try c.decode(String?.self, forKey: .handle)
    text = try c.decode(String?.self, forKey: .text)
    sentAt = try c.decode(String.self, forKey: .sentAt)
    hasAttachment = try c.decode(Bool.self, forKey: .hasAttachment)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(guid, forKey: .guid)
    try c.encode(chatGuid, forKey: .chatGuid)
    try c.encode(title, forKey: .title)
    try c.encode(isGroup, forKey: .isGroup)
    try c.encode(channel, forKey: .channel)
    try c.encode(from, forKey: .from)
    try c.encode(handle, forKey: .handle)
    try c.encode(text, forKey: .text)
    try c.encode(sentAt, forKey: .sentAt)
    try c.encode(hasAttachment, forKey: .hasAttachment)
  }
}

/// Matches in one year, counted in the query's zone.
public struct YearFacetDTO: Codable, Equatable, Sendable {
  public var year: Int
  public var count: Int

  enum CodingKeys: String, CodingKey, CaseIterable { case year, count }

  public init(year: Int, count: Int) {
    self.year = year
    self.count = count
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    year = try c.decode(Int.self, forKey: .year)
    count = try c.decode(Int.self, forKey: .count)
  }
}

public struct ChannelFacetDTO: Codable, Equatable, Sendable {
  public var channel: String
  public var count: Int

  enum CodingKeys: String, CodingKey, CaseIterable { case channel, count }

  public init(channel: String, count: Int) {
    self.channel = channel
    self.count = count
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    channel = try c.decode(String.self, forKey: .channel)
    count = try c.decode(Int.self, forKey: .count)
  }
}

/// A sender's match count; `handle` is "me" for the operator's own.
public struct SenderFacetDTO: Codable, Equatable, Sendable {
  public var handle: String
  public var count: Int

  enum CodingKeys: String, CodingKey, CaseIterable { case handle, count }

  public init(handle: String, count: Int) {
    self.handle = handle
    self.count = count
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    handle = try c.decode(String.self, forKey: .handle)
    count = try c.decode(Int.self, forKey: .count)
  }
}

public struct SearchFacetsDTO: Codable, Equatable, Sendable {
  public var years: [YearFacetDTO]
  public var channels: [ChannelFacetDTO]
  public var senders: [SenderFacetDTO]

  enum CodingKeys: String, CodingKey, CaseIterable { case years, channels, senders }

  public init(years: [YearFacetDTO] = [], channels: [ChannelFacetDTO] = [], senders: [SenderFacetDTO] = []) {
    self.years = years
    self.channels = channels
    self.senders = senders
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    years = try c.decode([YearFacetDTO].self, forKey: .years)
    channels = try c.decode([ChannelFacetDTO].self, forKey: .channels)
    senders = try c.decode([SenderFacetDTO].self, forKey: .senders)
  }
}

/// Whether one channel was searched. iMessage, when searched, says how much
/// of the mirror the index holds; any channel not searched says why
/// ("no-source": this version reads nothing from it; "not-requested").
public enum ChannelCoverageDTO: Codable, Equatable, Sendable {
  case searched(indexed: Int, eligible: Int, indexedThroughRowid: Int, mirrorAsOf: String?)
  case notSearched(channel: String, reason: String)

  enum CodingKeys: String, CodingKey, CaseIterable {
    case channel, state, indexed, eligible, indexedThroughRowid, mirrorAsOf, reason
  }

  public var channel: String {
    switch self {
    case .searched: return "imessage"
    case .notSearched(let channel, _): return channel
    }
  }

  public init(from decoder: any Decoder) throws {
    let peek = try decoder.container(keyedBy: CodingKeys.self)
    let state = try peek.decode(String.self, forKey: .state)
    switch state {
    case "searched":
      let c = try decoder.strictContainer(
        keyedBy: CodingKeys.self,
        allowing: [.channel, .state, .indexed, .eligible, .indexedThroughRowid, .mirrorAsOf])
      let channel = try c.decode(String.self, forKey: .channel)
      guard channel == "imessage" else {
        throw DecodingError.dataCorrupted(
          DecodingError.Context(
            codingPath: c.codingPath + [CodingKeys.channel],
            debugDescription: "only imessage is ever searched, got \"\(channel)\""))
      }
      self = .searched(
        indexed: try c.decode(Int.self, forKey: .indexed),
        eligible: try c.decode(Int.self, forKey: .eligible),
        indexedThroughRowid: try c.decode(Int.self, forKey: .indexedThroughRowid),
        mirrorAsOf: try c.decode(String?.self, forKey: .mirrorAsOf))
    case "not-searched":
      let c = try decoder.strictContainer(keyedBy: CodingKeys.self, allowing: [.channel, .state, .reason])
      self = .notSearched(
        channel: try c.decode(String.self, forKey: .channel),
        reason: try c.decode(String.self, forKey: .reason))
    default:
      throw DecodingError.dataCorrupted(
        DecodingError.Context(
          codingPath: peek.codingPath + [CodingKeys.state],
          debugDescription: "unknown coverage state \"\(state)\""))
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .searched(let indexed, let eligible, let through, let mirrorAsOf):
      try c.encode("imessage", forKey: .channel)
      try c.encode("searched", forKey: .state)
      try c.encode(indexed, forKey: .indexed)
      try c.encode(eligible, forKey: .eligible)
      try c.encode(through, forKey: .indexedThroughRowid)
      try c.encode(mirrorAsOf, forKey: .mirrorAsOf)
    case .notSearched(let channel, let reason):
      try c.encode(channel, forKey: .channel)
      try c.encode("not-searched", forKey: .state)
      try c.encode(reason, forKey: .reason)
    }
  }
}

/// One token the app sent, and how far the daemon honoured it: `applied`
/// is "applied", "partial" or "not-applied"; `reason` rides on the last two.
public struct TokenAppliedDTO: Codable, Equatable, Sendable {
  /// "term", "from", "in", "channel", "has", "before" or "after".
  public var op: String
  public var value: String
  public var applied: String
  public var reason: String?

  enum CodingKeys: String, CodingKey, CaseIterable { case op, value, applied, reason }

  public init(op: String, value: String, applied: String, reason: String? = nil) {
    self.op = op
    self.value = value
    self.applied = applied
    self.reason = reason
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    op = try c.decode(String.self, forKey: .op)
    value = try c.decode(String.self, forKey: .value)
    applied = try c.decode(String.self, forKey: .applied)
    reason = try c.decodeIfPresent(String.self, forKey: .reason)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(op, forKey: .op)
    try c.encode(value, forKey: .value)
    try c.encode(applied, forKey: .applied)
    try c.encodeIfPresent(reason, forKey: .reason)
  }
}

/// What was searched and what was not: the line the app draws under results.
public struct SearchCoverageDTO: Codable, Equatable, Sendable {
  public var channels: [ChannelCoverageDTO]
  public var tokens: [TokenAppliedDTO]
  /// More matched than the daemon keeps; the newest were kept.
  public var capped: Bool
  /// Hits on this page dropped because Messages no longer holds them.
  public var deletedHidden: Int
  /// False when chat.db could not be asked, so deleted hits may show.
  public var deletionsChecked: Bool

  enum CodingKeys: String, CodingKey, CaseIterable {
    case channels, tokens, capped, deletedHidden, deletionsChecked
  }

  public init(
    channels: [ChannelCoverageDTO], tokens: [TokenAppliedDTO], capped: Bool = false, deletedHidden: Int = 0,
    deletionsChecked: Bool = true
  ) {
    self.channels = channels
    self.tokens = tokens
    self.capped = capped
    self.deletedHidden = deletedHidden
    self.deletionsChecked = deletionsChecked
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    channels = try c.decode([ChannelCoverageDTO].self, forKey: .channels)
    tokens = try c.decode([TokenAppliedDTO].self, forKey: .tokens)
    capped = try c.decode(Bool.self, forKey: .capped)
    deletedHidden = try c.decode(Int.self, forKey: .deletedHidden)
    deletionsChecked = try c.decode(Bool.self, forKey: .deletionsChecked)
  }
}

/// One page of `GET /v1/search`.
public struct SearchPage: Codable, Equatable, Sendable {
  public var hits: [SearchHitDTO]
  /// Every match, not just this page's.
  public var total: Int
  /// Required and nullable: null on the last page.
  public var nextCursor: String?
  public var asOf: String
  public var facets: SearchFacetsDTO
  public var coverage: SearchCoverageDTO

  enum CodingKeys: String, CodingKey, CaseIterable {
    case hits, total, nextCursor, asOf, facets, coverage
  }

  public init(
    hits: [SearchHitDTO], total: Int, nextCursor: String?, asOf: String, facets: SearchFacetsDTO,
    coverage: SearchCoverageDTO
  ) {
    self.hits = hits
    self.total = total
    self.nextCursor = nextCursor
    self.asOf = asOf
    self.facets = facets
    self.coverage = coverage
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    hits = try c.decode([SearchHitDTO].self, forKey: .hits)
    total = try c.decode(Int.self, forKey: .total)
    nextCursor = try c.decode(String?.self, forKey: .nextCursor)
    asOf = try c.decode(String.self, forKey: .asOf)
    facets = try c.decode(SearchFacetsDTO.self, forKey: .facets)
    coverage = try c.decode(SearchCoverageDTO.self, forKey: .coverage)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(hits, forKey: .hits)
    try c.encode(total, forKey: .total)
    try c.encode(nextCursor, forKey: .nextCursor)
    try c.encode(asOf, forKey: .asOf)
    try c.encode(facets, forKey: .facets)
    try c.encode(coverage, forKey: .coverage)
  }
}

/// One year of a conversation, counted in the asked zone. An empty year
/// between two is kept, with a count of 0 and no first or last.
public struct YearCountDTO: Codable, Equatable, Sendable {
  public var year: Int
  public var count: Int
  /// Required and nullable: the year's oldest and newest turn.
  public var first: String?
  public var last: String?

  enum CodingKeys: String, CodingKey, CaseIterable { case year, count, first, last }

  public init(year: Int, count: Int, first: String?, last: String?) {
    self.year = year
    self.count = count
    self.first = first
    self.last = last
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    year = try c.decode(Int.self, forKey: .year)
    count = try c.decode(Int.self, forKey: .count)
    first = try c.decode(String?.self, forKey: .first)
    last = try c.decode(String?.self, forKey: .last)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(year, forKey: .year)
    try c.encode(count, forKey: .count)
    try c.encode(first, forKey: .first)
    try c.encode(last, forKey: .last)
  }
}

/// `GET /v1/threads/:guid/years`: newest year first.
public struct ThreadYears: Codable, Equatable, Sendable {
  public var chatGuid: String
  public var tz: String
  public var years: [YearCountDTO]
  public var asOf: String

  enum CodingKeys: String, CodingKey, CaseIterable { case chatGuid, tz, years, asOf }

  public init(chatGuid: String, tz: String, years: [YearCountDTO], asOf: String) {
    self.chatGuid = chatGuid
    self.tz = tz
    self.years = years
    self.asOf = asOf
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    chatGuid = try c.decode(String.self, forKey: .chatGuid)
    tz = try c.decode(String.self, forKey: .tz)
    years = try c.decode([YearCountDTO].self, forKey: .years)
    asOf = try c.decode(String.self, forKey: .asOf)
  }
}
