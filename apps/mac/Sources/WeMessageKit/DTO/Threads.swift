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
  /// v2 Phase B: per-board fixture detail (WhatsApp linked device, LinkedIn
  /// inbox, email subject). Only the fake daemon's preview-* scenarios send
  /// it; the real daemon never does. Absent means none.
  public var meta: [String: JSONValue]?

  enum CodingKeys: String, CodingKey, CaseIterable {
    case chatGuid, channel, title, isGroup, lastLine, lastFromMe, lastAt, meta
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
    try c.encodeIfPresent(meta, forKey: .meta)
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
    meta = try c.decodeIfPresent([String: JSONValue].self, forKey: .meta)
  }
}

/// v2 F4: where an outbound turn is, as the daemon claims it: "sent",
/// "delivered", "read" or "failed". `at` is required and nullable;
/// `errorCode` rides only on "failed".
public struct WireDelivery: Codable, Equatable, Sendable {
  public var state: String
  public var at: String?
  public var errorCode: Int?

  enum CodingKeys: String, CodingKey, CaseIterable {
    case state, at, errorCode
  }

  public init(state: String, at: String?, errorCode: Int? = nil) {
    self.state = state
    self.at = at
    self.errorCode = errorCode
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    state = try c.decode(String.self, forKey: .state)
    at = try c.decode(String?.self, forKey: .at)
    errorCode = try c.decodeIfPresent(Int.self, forKey: .errorCode)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(state, forKey: .state)
    try c.encode(at, forKey: .at)
    try c.encodeIfPresent(errorCode, forKey: .errorCode)
  }
}

/// v2 F4: one tapback. `kind` is "love", "like", "dislike", "laugh",
/// "emphasize", "question" or "other"; `from` is "me" or "them".
public struct WireReaction: Codable, Equatable, Sendable {
  public var kind: String
  public var from: String
  public var handle: String?

  enum CodingKeys: String, CodingKey, CaseIterable {
    case kind, from, handle
  }

  public init(kind: String, from: String, handle: String? = nil) {
    self.kind = kind
    self.from = from
    self.handle = handle
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    kind = try c.decode(String.self, forKey: .kind)
    from = try c.decode(String.self, forKey: .from)
    handle = try c.decodeIfPresent(String.self, forKey: .handle)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(kind, forKey: .kind)
    try c.encode(from, forKey: .from)
    try c.encodeIfPresent(handle, forKey: .handle)
  }
}

/// v2 F4: one file as metadata: a basename at most, never a path. Every
/// member is required; the four optionals are the wire's null. v2 F6c:
/// `id` (chat.db's attachment.guid, what GET /v1/attachments/:id takes) is
/// the one optional member: a turn recorded before F6c has none.
public struct WireFile: Codable, Equatable, Sendable {
  public var id: String?
  public var name: String?
  public var mime: String?
  public var uti: String?
  public var bytes: Int?
  public var sticker: Bool
  public var hidden: Bool

  enum CodingKeys: String, CodingKey, CaseIterable {
    case id, name, mime, uti, bytes, sticker, hidden
  }

  public init(
    id: String? = nil, name: String?, mime: String?, uti: String? = nil, bytes: Int?, sticker: Bool = false,
    hidden: Bool = false
  ) {
    self.id = id
    self.name = name
    self.mime = mime
    self.uti = uti
    self.bytes = bytes
    self.sticker = sticker
    self.hidden = hidden
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    id = try c.decodeIfPresent(String.self, forKey: .id)
    name = try c.decode(String?.self, forKey: .name)
    mime = try c.decode(String?.self, forKey: .mime)
    uti = try c.decode(String?.self, forKey: .uti)
    bytes = try c.decode(Int?.self, forKey: .bytes)
    sticker = try c.decode(Bool.self, forKey: .sticker)
    hidden = try c.decode(Bool.self, forKey: .hidden)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encodeIfPresent(id, forKey: .id)
    try c.encode(name, forKey: .name)
    try c.encode(mime, forKey: .mime)
    try c.encode(uti, forKey: .uti)
    try c.encode(bytes, forKey: .bytes)
    try c.encode(sticker, forKey: .sticker)
    try c.encode(hidden, forKey: .hidden)
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
  /// v2 Phase B: per-board fixture detail (reactions, a voice note's
  /// transcript, an email envelope). Fake daemon preview-* scenarios only.
  public var meta: [String: JSONValue]?
  /// v2 F4: "imessage", "sms", "rcs" or "unknown". Nil: absent, the source
  /// does not say.
  public var service: String?
  /// v2 F4: an outbound turn's delivery. The outer nil is an absent key (the
  /// source does not say); `.some(nil)` is the wire's null (no rung proven).
  public var delivery: WireDelivery??
  /// v2 F4: one standing reaction per sender. Nil: absent; `[]`: none.
  public var reactions: [WireReaction]?
  /// v2 F4: file metadata, never a path. Nil: absent; `[]`: none.
  public var files: [WireFile]?

  enum CodingKeys: String, CodingKey, CaseIterable {
    case guid, from, kind, text, at, handle, editedAt, unsentAt, attachments, meta, service, delivery, reactions,
      files
  }

  public init(
    guid: String, from: String, kind: String, text: String?, at: String, handle: String? = nil,
    editedAt: String? = nil, unsentAt: String? = nil, attachments: Int, meta: [String: JSONValue]? = nil,
    service: String? = nil, delivery: WireDelivery?? = nil, reactions: [WireReaction]? = nil,
    files: [WireFile]? = nil
  ) {
    self.guid = guid
    self.from = from
    self.kind = kind
    self.text = text
    self.at = at
    self.handle = handle
    self.editedAt = editedAt
    self.unsentAt = unsentAt
    self.attachments = attachments
    self.meta = meta
    self.service = service
    self.delivery = delivery
    self.reactions = reactions
    self.files = files
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
    try c.encodeIfPresent(meta, forKey: .meta)
    try c.encodeIfPresent(service, forKey: .service)
    switch delivery {
    case .none: break
    case .some(.none): try c.encodeNil(forKey: .delivery)
    case .some(.some(let value)): try c.encode(value, forKey: .delivery)
    }
    try c.encodeIfPresent(reactions, forKey: .reactions)
    try c.encodeIfPresent(files, forKey: .files)
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
    meta = try c.decodeIfPresent([String: JSONValue].self, forKey: .meta)
    service = try c.decodeIfPresent(String.self, forKey: .service)
    delivery = c.contains(.delivery) ? .some(try c.decode(WireDelivery?.self, forKey: .delivery)) : nil
    reactions = try c.decodeIfPresent([WireReaction].self, forKey: .reactions)
    files = try c.decodeIfPresent([WireFile].self, forKey: .files)
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

/// v2 F5: the conversation `GET /v1/threads/by-handle/:handle` found: the
/// newest 1:1 holding the handle, else the newest group (isGroup true).
public struct ResolvedConversation: Codable, Equatable, Sendable {
  /// The daemon's guid, which may be "any;-;..." on macOS 26. Drafts use it
  /// as given; the client never synthesises one.
  public var chatGuid: String
  /// "imessage", "sms", "rcs" or "unknown".
  public var service: String
  public var isGroup: Bool

  public init(chatGuid: String, service: String, isGroup: Bool) {
    self.chatGuid = chatGuid
    self.service = service
    self.isGroup = isGroup
  }

  enum CodingKeys: String, CodingKey, CaseIterable {
    case chatGuid, service, isGroup
  }
}

extension ResolvedConversation {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    chatGuid = try c.decode(String.self, forKey: .chatGuid)
    service = try c.decode(String.self, forKey: .service)
    isGroup = try c.decode(Bool.self, forKey: .isGroup)
  }
}

/// v2 F5: the answer for one handle, in the daemon's normalised form.
public struct HandleResolution: Codable, Equatable, Sendable {
  public var handle: String
  /// Required and nullable: null when this Mac has no conversation with it.
  public var conversation: ResolvedConversation?
  public var asOf: String

  public init(handle: String, conversation: ResolvedConversation?, asOf: String) {
    self.handle = handle
    self.conversation = conversation
    self.asOf = asOf
  }

  enum CodingKeys: String, CodingKey, CaseIterable {
    case handle, conversation, asOf
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(handle, forKey: .handle)
    try c.encode(conversation, forKey: .conversation)
    try c.encode(asOf, forKey: .asOf)
  }
}

extension HandleResolution {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    handle = try c.decode(String.self, forKey: .handle)
    conversation = try c.decode(ResolvedConversation?.self, forKey: .conversation)
    asOf = try c.decode(String.self, forKey: .asOf)
  }
}
