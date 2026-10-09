import Foundation

// v2 B2, board 05: Email over fixtures. Every type here is a typed reading of
// the per-board `meta` carrier on ThreadSummary and ThreadTurn. Nothing is
// required: a field that is absent or the wrong shape falls back to a safe
// default, and the safe default for remote images is blocked.

/// The four category chips (05.G) and the lane each one rides in.
public enum EmailCategory: String, CaseIterable, Sendable {
  case people, feed, paperTrail, newSenders

  public var title: String {
    switch self {
    case .people: "People"
    case .feed: "Feed"
    case .paperTrail: "Paper Trail"
    case .newSenders: "New senders"
    }
  }

  /// People go to the queue, Feed is a stream, Paper Trail is muted, and a
  /// new sender is unassigned until someone sorts it.
  public enum Mode: String, Sendable { case queue, stream, muted, unassigned }

  public var mode: Mode {
    switch self {
    case .people: .queue
    case .feed: .stream
    case .paperTrail: .muted
    case .newSenders: .unassigned
    }
  }
}

/// One mailbox: an address, and a name when the header carried one.
public struct EmailParticipant: Equatable, Hashable, Sendable {
  public let name: String?
  public let address: String

  public init(name: String?, address: String) {
    self.name = name
    self.address = address
  }

  /// Reads `{name, address}`; nil without an address.
  public init?(_ value: JSONValue?) {
    guard let address = value?["address"]?.stringValue, !address.isEmpty else { return nil }
    let name = value?["name"]?.stringValue
    self.init(name: (name?.isEmpty ?? true) ? nil : name, address: address)
  }

  /// The name when there is one, else the address.
  public var shown: String { name ?? address }

  /// "Name <address>", or the bare address.
  public var printed: String { name.map { "\($0) <\(address)>" } ?? address }

  static func list(_ value: JSONValue?) -> [EmailParticipant] {
    (value?.arrayValue ?? []).compactMap { EmailParticipant($0) }
  }

  /// Same mailbox, whatever the case.
  func same(_ other: EmailParticipant) -> Bool {
    address.lowercased() == other.address.lowercased()
  }
}

/// Remote images in a message. Anything but an explicit "allowed" is
/// blocked: an unknown or missing value never loads a pixel.
public enum EmailRemoteImages: String, Sendable {
  case blocked, allowed

  public init(_ value: JSONValue?) {
    self = value?.stringValue == "allowed" ? .allowed : .blocked
  }
}

/// `thread.meta` for an email thread.
public struct EmailThreadMeta: Equatable, Sendable {
  public let subject: String?
  public let participants: [EmailParticipant]
  public let category: EmailCategory?
  public let sizeBytes: Int64
  public let hasInvite: Bool
  public let remoteImages: EmailRemoteImages
  /// The mailbox this thread lives in, when the fixture names one.
  public let account: String?

  public init(meta: [String: JSONValue]?) {
    let m = meta ?? [:]
    subject = m["subject"]?.stringValue
    participants = EmailParticipant.list(m["participants"])
    category = m["category"]?.stringValue.flatMap(EmailCategory.init(rawValue:))
    sizeBytes = Int64(max(0, m["sizeBytes"]?.intValue ?? 0))
    hasInvite = m["hasInvite"]?.boolValue ?? false
    remoteImages = EmailRemoteImages(m["remoteImages"])
    account = m["account"]?.stringValue
  }

  public init(_ thread: ThreadSummary) { self.init(meta: thread.meta) }
}

/// Who a message went from and to.
public struct EmailEnvelope: Equatable, Sendable {
  public let from: EmailParticipant?
  public let to: [EmailParticipant]
  public let cc: [EmailParticipant]

  public init(from: EmailParticipant?, to: [EmailParticipant], cc: [EmailParticipant]) {
    self.from = from
    self.to = to
    self.cc = cc
  }

  public init(_ value: JSONValue?) {
    self.init(
      from: EmailParticipant(value?["from"]),
      to: EmailParticipant.list(value?["to"]),
      cc: EmailParticipant.list(value?["cc"]))
  }

  public static let empty = EmailEnvelope(from: nil, to: [], cc: [])

  /// Reply: the sender only. Replying to my own message goes back to its To.
  public func reply(me: String) -> EmailEnvelope {
    let mine = EmailParticipant(name: nil, address: me)
    guard let from else { return EmailEnvelope(from: mine, to: [], cc: []) }
    let to = from.same(mine) ? Self.unique(to, without: [mine]) : [from]
    return EmailEnvelope(from: mine, to: to, cc: [])
  }

  /// Reply all: the sender and the original To, then the original Cc, never
  /// me, never anyone twice.
  public func replyAll(me: String) -> EmailEnvelope {
    let mine = EmailParticipant(name: nil, address: me)
    let to = Self.unique((from.map { [$0] } ?? []) + self.to, without: [mine])
    let cc = Self.unique(self.cc, without: [mine] + to)
    return EmailEnvelope(from: mine, to: to, cc: cc)
  }

  /// Forward: nobody yet.
  public func forward(me: String) -> EmailEnvelope {
    EmailEnvelope(from: EmailParticipant(name: nil, address: me), to: [], cc: [])
  }

  static func unique(_ list: [EmailParticipant], without: [EmailParticipant]) -> [EmailParticipant] {
    var out: [EmailParticipant] = []
    for p in list where !without.contains(where: { $0.same(p) }) && !out.contains(where: { $0.same(p) }) {
      out.append(p)
    }
    return out
  }
}

/// A calendar invite carried on a message as `inviteObject`.
public struct EmailInvite: Equatable, Sendable {
  public enum Response: String, Sendable { case accepted, declined, maybe, awaiting }

  public struct Guest: Equatable, Sendable {
    public let who: EmailParticipant
    public let response: Response
  }

  public let title: String
  public let when: String?
  public let place: String?
  public let organizer: EmailParticipant?
  public let guests: [Guest]

  /// Nil when the object has no title: an invite with nothing to name is
  /// not drawn.
  public init?(_ value: JSONValue?) {
    guard let title = value?["title"]?.stringValue, !title.isEmpty else { return nil }
    self.title = title
    when = value?["when"]?.stringValue
    place = value?["place"]?.stringValue
    organizer = EmailParticipant(value?["organizer"])
    guests = (value?["guests"]?.arrayValue ?? []).compactMap { g in
      guard let who = EmailParticipant(g) else { return nil }
      let response = g["response"]?.stringValue.flatMap(Response.init(rawValue:)) ?? .awaiting
      return Guest(who: who, response: response)
    }
  }

  public func count(_ response: Response) -> Int {
    guests.filter { $0.response == response }.count
  }
}

/// A remote image a message refers to. Its bytes are never in the fixture.
public struct EmailImage: Equatable, Sendable {
  public let url: String
  public let width: Int
  public let height: Int
}

/// A file a message carries.
public struct EmailAttachment: Equatable, Sendable {
  public let name: String
  public let mime: String
  public let bytes: Int64

  public init(name: String, mime: String, bytes: Int64) {
    self.name = name
    self.mime = mime
    self.bytes = bytes
  }
}

/// `turn.meta` for one email message.
public struct EmailTurnMeta: Equatable, Sendable {
  /// The fixture undo window when a turn does not say: thirty seconds.
  public static let defaultUndoWindowMs = 30_000

  public let envelope: EmailEnvelope
  public let invite: EmailInvite?
  public let undoWindowMs: Int
  public let images: [EmailImage]
  public let trackers: Int
  public let attachments: [EmailAttachment]

  public init(meta: [String: JSONValue]?) {
    let m = meta ?? [:]
    envelope = EmailEnvelope(m["envelope"])
    invite = EmailInvite(m["inviteObject"])
    let window = m["undoWindowMs"]?.intValue ?? Self.defaultUndoWindowMs
    undoWindowMs = window > 0 ? window : Self.defaultUndoWindowMs
    images = (m["images"]?.arrayValue ?? []).compactMap { v in
      guard let url = v["url"]?.stringValue, !url.isEmpty else { return nil }
      return EmailImage(url: url, width: v["width"]?.intValue ?? 0, height: v["height"]?.intValue ?? 0)
    }
    trackers = max(0, m["trackers"]?.intValue ?? 0)
    attachments = (m["attachments"]?.arrayValue ?? []).compactMap { v in
      guard let name = v["name"]?.stringValue else { return nil }
      return EmailAttachment(
        name: name, mime: v["mime"]?.stringValue ?? "application/octet-stream",
        bytes: Int64(max(0, v["bytes"]?.intValue ?? 0)))
    }
  }

  public init(_ turn: ThreadTurn) { self.init(meta: turn.meta) }

  /// Whole seconds of the undo window, never less than one.
  public var undoSeconds: Int { max(1, undoWindowMs / 1000) }

  public var attachmentBytes: Int64 { attachments.reduce(0) { $0 + $1.bytes } }
}

/// The attachment wall for one outgoing email: a warning from 20 MB, a
/// block from 25 MB, both inclusive, on the bytes of the files themselves.
public enum EmailSizeWall {
  public enum State: String, Sendable { case clear, warn, block }

  public static let warnBytes: Int64 = 20_000_000
  public static let blockBytes: Int64 = 25_000_000

  public static func state(_ bytes: Int64) -> State {
    if bytes >= blockBytes { return .block }
    if bytes >= warnBytes { return .warn }
    return .clear
  }

  /// What is left under the cap, never below zero.
  public static func left(_ bytes: Int64) -> Int64 { max(0, blockBytes - bytes) }
}
