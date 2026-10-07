import Foundation

/// One turn of a transcript, as boards 02 and 08 draw it (plan 3.1). The
/// daemon serves three kinds today, "text", "attachment-only" and "audio";
/// each maps here, and anything else (an unknown kind, an unknown sender
/// side, a time that does not parse) maps to nil, so a new kind the app has
/// not learned is skipped rather than drawn as something it is not.
///
/// Board 08's richer kinds (media, files, links, polls, system lines, the
/// unsupported fallback) and its per-message facts (service, delivery,
/// reactions, effect) are Codable here, so the specimen sheet's golden
/// (fixtures/atlas) decodes into the same type the thread draws. The daemon
/// serves none of them yet (gap G-08a): `init(turn:)` leaves them empty.
public struct MessageTurn: Equatable, Sendable {
  public enum Direction: String, Codable, Equatable, Sendable {
    case inbound, outbound
  }

  /// The transport one message went over. An SMS in an iMessage chat is
  /// the fallback board 08.I draws without green.
  public enum Service: String, Codable, Equatable, Sendable {
    case imessage, sms
  }

  /// A file the message carries, as metadata only: the window never holds
  /// the bytes.
  public struct Attachment: Codable, Equatable, Sendable {
    public let name: String
    public let mime: String
    public var bytes: Int?
    public var seconds: Int?
    public var width: Int?
    public var height: Int?
    /// Bytes received so far while downloading.
    public var received: Int?
    /// Gone from the server: the specimen says so instead of a broken image.
    public var expired: Bool?

    public init(
      name: String, mime: String, bytes: Int? = nil, seconds: Int? = nil, width: Int? = nil, height: Int? = nil,
      received: Int? = nil, expired: Bool? = nil
    ) {
      self.name = name
      self.mime = mime
      self.bytes = bytes
      self.seconds = seconds
      self.width = width
      self.height = height
      self.received = received
      self.expired = expired
    }
  }

  /// A tapback or emoji reaction someone else left: read where it exists,
  /// never written on iMessage (08.C).
  public struct Reaction: Codable, Equatable, Sendable {
    public let glyph: String
    public let count: Int

    public init(glyph: String, count: Int) {
      self.glyph = glyph
      self.count = count
    }
  }

  public struct LinkPreview: Codable, Equatable, Sendable {
    public let title: String
    public let host: String

    public init(title: String, host: String) {
      self.title = title
      self.host = host
    }
  }

  public struct ContactCard: Codable, Equatable, Sendable {
    public let name: String
    public let handle: String

    public init(name: String, handle: String) {
      self.name = name
      self.handle = handle
    }
  }

  /// A poll, read-only: there is no vote hook (02.H, 03.F).
  public struct Poll: Codable, Equatable, Sendable {
    public struct Option: Codable, Equatable, Sendable {
      public let title: String
      public let votes: Int

      public init(title: String, votes: Int) {
        self.title = title
        self.votes = votes
      }
    }

    public let question: String
    public let options: [Option]

    public init(question: String, options: [Option]) {
      self.question = question
      self.options = options
    }
  }

  public enum Kind: Equatable, Sendable {
    /// A text message.
    case text
    /// Text that is only emoji, drawn at 2.6x.
    case emojiOnly
    /// Attachments and no text: the daemon serves a count, never the files.
    case attachments(count: Int)
    /// Images or video, the asset is the bubble.
    case media([Attachment])
    /// An audio message, transcript first. The daemon serves no transcript
    /// yet.
    case voice(transcript: String?, seconds: Int? = nil)
    case file(Attachment)
    case link(LinkPreview)
    /// A place, by its address line.
    case location(String)
    case contactCard(ContactCard)
    case poll(Poll)
    /// A centred, unbubbled line (a rename, a join, a missed call).
    case system
    /// A type the app cannot render, by its name: the honest fallback.
    case unsupported(String)
  }

  public let guid: String
  public let direction: Direction
  public let kind: Kind
  /// The words to draw. Always nil for an unsent message: leaving the
  /// original text would defeat the sender's unsend (wireframe 02.C).
  public let text: String?
  public let sentAt: Date
  /// The sender's handle on an inbound turn (in a group, who said it).
  public let handle: String?
  public let isEdited: Bool
  public let isUnsent: Bool
  public let attachments: Int
  public let service: Service
  /// Outbound only; nil when nobody said.
  public let delivery: Delivery?
  public let reactions: [Reaction]
  /// A screen or bubble effect it was sent with ("Fireworks").
  public let effect: String?
  /// The text of the message this one replies to.
  public let quote: String?
  public let isForwarded: Bool

  public init(
    guid: String, direction: Direction, kind: Kind, text: String?, sentAt: Date, handle: String? = nil,
    isEdited: Bool = false, isUnsent: Bool = false, attachments: Int = 0, service: Service = .imessage,
    delivery: Delivery? = nil, reactions: [Reaction] = [], effect: String? = nil, quote: String? = nil,
    isForwarded: Bool = false
  ) {
    self.guid = guid
    self.direction = direction
    self.kind = kind
    self.text = isUnsent ? nil : text
    self.sentAt = sentAt
    self.handle = handle
    self.isEdited = isEdited
    self.isUnsent = isUnsent
    self.attachments = attachments
    self.service = service
    self.delivery = direction == .outbound ? delivery : nil
    self.reactions = reactions
    self.effect = effect
    self.quote = quote
    self.isForwarded = isForwarded
  }

  /// The daemon's turn, or nil when it is a kind, side or time this build
  /// does not know.
  public init?(turn: ThreadTurn) {
    let direction: Direction
    switch turn.from {
    case "me": direction = .outbound
    case "them": direction = .inbound
    default: return nil
    }
    let kind: Kind
    switch turn.kind {
    case "text": kind = .text
    case "attachment-only": kind = .attachments(count: turn.attachments)
    case "audio": kind = .voice(transcript: nil)
    default: return nil
    }
    guard let at = WireDate.parse(turn.at) else { return nil }
    self.init(
      guid: turn.guid, direction: direction, kind: kind, text: turn.text, sentAt: at, handle: turn.handle,
      isEdited: turn.editedAt != nil, isUnsent: turn.unsentAt != nil, attachments: turn.attachments)
  }

  /// Every turn of `page` this build can draw, oldest first, in the page's
  /// own order otherwise.
  public static func turns(_ page: ThreadMessagesPage) -> [MessageTurn] {
    page.turns.compactMap(MessageTurn.init(turn:)).enumerated()
      .sorted { $0.element.sentAt == $1.element.sentAt ? $0.offset < $1.offset : $0.element.sentAt < $1.element.sentAt }
      .map(\.element)
  }
}

extension MessageTurn.Kind: Codable {
  private enum Key: String, CodingKey {
    case type, count, items, transcript, seconds, file, link, address, card, poll, name
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Key.self)
    let type = try c.decode(String.self, forKey: .type)
    switch type {
    case "text": self = .text
    case "emojiOnly": self = .emojiOnly
    case "attachments": self = .attachments(count: try c.decode(Int.self, forKey: .count))
    case "media": self = .media(try c.decode([MessageTurn.Attachment].self, forKey: .items))
    case "voice":
      self = .voice(
        transcript: try c.decodeIfPresent(String.self, forKey: .transcript),
        seconds: try c.decodeIfPresent(Int.self, forKey: .seconds))
    case "file": self = .file(try c.decode(MessageTurn.Attachment.self, forKey: .file))
    case "link": self = .link(try c.decode(MessageTurn.LinkPreview.self, forKey: .link))
    case "location": self = .location(try c.decode(String.self, forKey: .address))
    case "contactCard": self = .contactCard(try c.decode(MessageTurn.ContactCard.self, forKey: .card))
    case "poll": self = .poll(try c.decode(MessageTurn.Poll.self, forKey: .poll))
    case "system": self = .system
    case "unsupported": self = .unsupported(try c.decode(String.self, forKey: .name))
    default:
      throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "unknown kind \(type)")
    }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: Key.self)
    switch self {
    case .text: try c.encode("text", forKey: .type)
    case .emojiOnly: try c.encode("emojiOnly", forKey: .type)
    case .attachments(let count):
      try c.encode("attachments", forKey: .type)
      try c.encode(count, forKey: .count)
    case .media(let items):
      try c.encode("media", forKey: .type)
      try c.encode(items, forKey: .items)
    case .voice(let transcript, let seconds):
      try c.encode("voice", forKey: .type)
      try c.encodeIfPresent(transcript, forKey: .transcript)
      try c.encodeIfPresent(seconds, forKey: .seconds)
    case .file(let file):
      try c.encode("file", forKey: .type)
      try c.encode(file, forKey: .file)
    case .link(let link):
      try c.encode("link", forKey: .type)
      try c.encode(link, forKey: .link)
    case .location(let address):
      try c.encode("location", forKey: .type)
      try c.encode(address, forKey: .address)
    case .contactCard(let card):
      try c.encode("contactCard", forKey: .type)
      try c.encode(card, forKey: .card)
    case .poll(let poll):
      try c.encode("poll", forKey: .type)
      try c.encode(poll, forKey: .poll)
    case .system: try c.encode("system", forKey: .type)
    case .unsupported(let name):
      try c.encode("unsupported", forKey: .type)
      try c.encode(name, forKey: .name)
    }
  }
}

extension MessageTurn: Codable {
  private enum Key: String, CodingKey {
    case guid, direction, kind, text, sentAt, handle, isEdited, isUnsent, attachments, service, delivery, reactions,
      effect, quote, isForwarded
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Key.self)
    let raw = try c.decode(String.self, forKey: .sentAt)
    guard let sentAt = WireDate.parse(raw) else {
      throw DecodingError.dataCorruptedError(forKey: .sentAt, in: c, debugDescription: "not a time: \(raw)")
    }
    let direction = try c.decode(Direction.self, forKey: .direction)
    let delivery = try c.decodeIfPresent(Delivery.self, forKey: .delivery)
    if delivery != nil && direction == .inbound {
      throw DecodingError.dataCorruptedError(
        forKey: .delivery, in: c, debugDescription: "delivery is an outbound fact")
    }
    self.init(
      guid: try c.decode(String.self, forKey: .guid), direction: direction,
      kind: try c.decode(Kind.self, forKey: .kind), text: try c.decodeIfPresent(String.self, forKey: .text),
      sentAt: sentAt, handle: try c.decodeIfPresent(String.self, forKey: .handle),
      isEdited: try c.decodeIfPresent(Bool.self, forKey: .isEdited) ?? false,
      isUnsent: try c.decodeIfPresent(Bool.self, forKey: .isUnsent) ?? false,
      attachments: try c.decodeIfPresent(Int.self, forKey: .attachments) ?? 0,
      service: try c.decodeIfPresent(Service.self, forKey: .service) ?? .imessage, delivery: delivery,
      reactions: try c.decodeIfPresent([Reaction].self, forKey: .reactions) ?? [],
      effect: try c.decodeIfPresent(String.self, forKey: .effect),
      quote: try c.decodeIfPresent(String.self, forKey: .quote),
      isForwarded: try c.decodeIfPresent(Bool.self, forKey: .isForwarded) ?? false)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: Key.self)
    try c.encode(guid, forKey: .guid)
    try c.encode(direction, forKey: .direction)
    try c.encode(kind, forKey: .kind)
    try c.encodeIfPresent(text, forKey: .text)
    try c.encode(WireDate.format(sentAt), forKey: .sentAt)
    try c.encodeIfPresent(handle, forKey: .handle)
    if isEdited { try c.encode(true, forKey: .isEdited) }
    if isUnsent { try c.encode(true, forKey: .isUnsent) }
    if attachments != 0 { try c.encode(attachments, forKey: .attachments) }
    if service != .imessage { try c.encode(service, forKey: .service) }
    try c.encodeIfPresent(delivery, forKey: .delivery)
    if !reactions.isEmpty { try c.encode(reactions, forKey: .reactions) }
    try c.encodeIfPresent(effect, forKey: .effect)
    try c.encodeIfPresent(quote, forKey: .quote)
    if isForwarded { try c.encode(true, forKey: .isForwarded) }
  }
}

/// The specimen sheet's golden (fixtures/atlas/threads.messages.atlas.json):
/// board 08's sections, each a slug, a title and the turns it shows.
public struct AtlasGolden: Codable, Equatable, Sendable {
  public struct Section: Codable, Equatable, Sendable {
    public let slug: String
    public let title: String
    public let turns: [MessageTurn]

    public init(slug: String, title: String, turns: [MessageTurn]) {
      self.slug = slug
      self.title = title
      self.turns = turns
    }
  }

  public let sections: [Section]

  public init(sections: [Section]) {
    self.sections = sections
  }
}
