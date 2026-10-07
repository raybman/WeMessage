import Foundation

/// One turn of a transcript, as board 02 draws it (plan 3.1). The daemon
/// serves three kinds today, "text", "attachment-only" and "audio"; each
/// maps here, and anything else (an unknown kind, an unknown sender side, a
/// time that does not parse) maps to nil, so a new kind the app has not
/// learned is skipped rather than drawn as something it is not. Board 08's
/// richer kinds (media, links, polls, reactions, delivery) arrive with S4e.
public struct MessageTurn: Equatable, Sendable {
  public enum Direction: String, Equatable, Sendable {
    case inbound, outbound
  }

  public enum Kind: Equatable, Sendable {
    /// A text message.
    case text
    /// Attachments and no text: the daemon serves a count, never the files.
    case attachments(count: Int)
    /// An audio message. The daemon serves no transcript yet.
    case voice(transcript: String?)
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

  public init(
    guid: String, direction: Direction, kind: Kind, text: String?, sentAt: Date, handle: String? = nil,
    isEdited: Bool = false, isUnsent: Bool = false, attachments: Int = 0
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
