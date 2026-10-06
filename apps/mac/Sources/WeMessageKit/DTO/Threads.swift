import Foundation

/// One conversation in `GET /v1/threads`.
public struct ThreadSummary: Codable, Equatable, Sendable {
  public var chatGuid: String
  public var channel: String
  public var title: String
  public var isGroup: Bool
  /// Required and nullable: null when there is no readable line to show.
  public var lastLine: String?
  public var lastFromMe: Bool
  public var lastAt: String

  enum CodingKeys: String, CodingKey, CaseIterable {
    case chatGuid, channel, title, isGroup, lastLine, lastFromMe, lastAt
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(chatGuid, forKey: .chatGuid)
    try c.encode(channel, forKey: .channel)
    try c.encode(title, forKey: .title)
    try c.encode(isGroup, forKey: .isGroup)
    try c.encode(lastLine, forKey: .lastLine)
    try c.encode(lastFromMe, forKey: .lastFromMe)
    try c.encode(lastAt, forKey: .lastAt)
  }
}

extension ThreadSummary {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    chatGuid = try c.decode(String.self, forKey: .chatGuid)
    channel = try c.decode(String.self, forKey: .channel)
    title = try c.decode(String.self, forKey: .title)
    isGroup = try c.decode(Bool.self, forKey: .isGroup)
    lastLine = try c.decode(String?.self, forKey: .lastLine)
    lastFromMe = try c.decode(Bool.self, forKey: .lastFromMe)
    lastAt = try c.decode(String.self, forKey: .lastAt)
  }
}

public struct ThreadsPage: Codable, Equatable, Sendable {
  public var threads: [ThreadSummary]
  /// Required and nullable: null on the last page.
  public var nextCursor: String?
  public var total: Int
  public var asOf: String

  enum CodingKeys: String, CodingKey, CaseIterable {
    case threads, nextCursor, total, asOf
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(threads, forKey: .threads)
    try c.encode(nextCursor, forKey: .nextCursor)
    try c.encode(total, forKey: .total)
    try c.encode(asOf, forKey: .asOf)
  }
}

extension ThreadsPage {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    threads = try c.decode([ThreadSummary].self, forKey: .threads)
    nextCursor = try c.decode(String?.self, forKey: .nextCursor)
    total = try c.decode(Int.self, forKey: .total)
    asOf = try c.decode(String.self, forKey: .asOf)
  }
}

/// One message in a transcript.
public struct ThreadTurn: Codable, Equatable, Sendable {
  public var guid: String
  /// "me" or "them".
  public var from: String
  /// "text", "attachment-only" or "audio".
  public var kind: String
  /// Required and nullable: null when unsent or when there is no text.
  public var text: String?
  public var at: String
  public var handle: String?
  public var editedAt: String?
  public var unsentAt: String?
  /// How many attachments the message carries. A count, never the files.
  public var attachments: Int

  enum CodingKeys: String, CodingKey, CaseIterable {
    case guid, from, kind, text, at, handle, editedAt, unsentAt, attachments
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(guid, forKey: .guid)
    try c.encode(from, forKey: .from)
    try c.encode(kind, forKey: .kind)
    try c.encode(text, forKey: .text)
    try c.encode(at, forKey: .at)
    try c.encodeIfPresent(handle, forKey: .handle)
    try c.encodeIfPresent(editedAt, forKey: .editedAt)
    try c.encodeIfPresent(unsentAt, forKey: .unsentAt)
    try c.encode(attachments, forKey: .attachments)
  }
}

extension ThreadTurn {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    guid = try c.decode(String.self, forKey: .guid)
    from = try c.decode(String.self, forKey: .from)
    kind = try c.decode(String.self, forKey: .kind)
    text = try c.decode(String?.self, forKey: .text)
    at = try c.decode(String.self, forKey: .at)
    handle = try c.decodeIfPresent(String.self, forKey: .handle)
    editedAt = try c.decodeIfPresent(String.self, forKey: .editedAt)
    unsentAt = try c.decodeIfPresent(String.self, forKey: .unsentAt)
    attachments = try c.decode(Int.self, forKey: .attachments)
  }
}

public struct ThreadMessagesPage: Codable, Equatable, Sendable {
  public var chatGuid: String
  public var channel: String
  public var turns: [ThreadTurn]
  /// Required and nullable: null at the start of the conversation.
  public var nextBefore: String?
  public var asOf: String

  enum CodingKeys: String, CodingKey, CaseIterable {
    case chatGuid, channel, turns, nextBefore, asOf
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(chatGuid, forKey: .chatGuid)
    try c.encode(channel, forKey: .channel)
    try c.encode(turns, forKey: .turns)
    try c.encode(nextBefore, forKey: .nextBefore)
    try c.encode(asOf, forKey: .asOf)
  }
}

extension ThreadMessagesPage {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    chatGuid = try c.decode(String.self, forKey: .chatGuid)
    channel = try c.decode(String.self, forKey: .channel)
    turns = try c.decode([ThreadTurn].self, forKey: .turns)
    nextBefore = try c.decode(String?.self, forKey: .nextBefore)
    asOf = try c.decode(String.self, forKey: .asOf)
  }
}
