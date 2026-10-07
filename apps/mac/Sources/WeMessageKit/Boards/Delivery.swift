import Foundation

/// Where an outbound message is on its way (board 08.G's delivery ladder,
/// plan 3.1). Sending, Sent, Delivered and Read are quiet; Not delivered is
/// the one state that escalates, and it always names its cause, because
/// "not delivered" alone is useless when four transports fail four ways.
///
/// The ladder only climbs: a late "sent" never undoes a "read", and a
/// failure can only replace a state the message had not yet got past.
public enum Delivery: Equatable, Sendable {
  case sending
  case sent(at: Date?)
  case delivered
  case read(at: Date)
  case notDelivered(reason: String)

  /// The rung, 0 (sending) to 3 (read); nil for a failure, which is off
  /// the ladder.
  public var rung: Int? {
    switch self {
    case .sending: 0
    case .sent: 1
    case .delivered: 2
    case .read: 3
    case .notDelivered: nil
    }
  }

  /// Only a failure escalates in visual weight (a dotted 2 pt border) and
  /// offers Retry.
  public var isFailure: Bool { rung == nil }

  /// The state after `next` arrives. A higher rung wins; a lower one is
  /// stale and ignored. A failure replaces sending or sent, never a message
  /// the other side already has; a later rung replaces a failure (a retry
  /// that got through).
  public func merged(with next: Delivery) -> Delivery {
    switch (rung, next.rung) {
    case (let a?, let b?): return b > a ? next : self
    case (let a?, nil): return a <= 1 ? next : self
    case (nil, _?): return next
    case (nil, nil): return next
    }
  }
}

extension Delivery: Codable {
  private enum Key: String, CodingKey { case state, at, reason }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Key.self)
    let state = try c.decode(String.self, forKey: .state)
    func date(_ required: Bool) throws -> Date? {
      guard let raw = try c.decodeIfPresent(String.self, forKey: .at) else {
        if required { throw DecodingError.keyNotFound(Key.at, .init(codingPath: c.codingPath, debugDescription: state)) }
        return nil
      }
      guard let parsed = WireDate.parse(raw) else {
        throw DecodingError.dataCorruptedError(forKey: .at, in: c, debugDescription: "not a time: \(raw)")
      }
      return parsed
    }
    switch state {
    case "sending": self = .sending
    case "sent": self = .sent(at: try date(false))
    case "delivered": self = .delivered
    case "read": self = .read(at: try date(true)!)
    case "notDelivered":
      let reason = try c.decode(String.self, forKey: .reason)
      guard !reason.isEmpty else {
        throw DecodingError.dataCorruptedError(forKey: .reason, in: c, debugDescription: "a failure names its cause")
      }
      self = .notDelivered(reason: reason)
    default:
      throw DecodingError.dataCorruptedError(forKey: .state, in: c, debugDescription: "unknown delivery state \(state)")
    }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: Key.self)
    switch self {
    case .sending: try c.encode("sending", forKey: .state)
    case .sent(let at):
      try c.encode("sent", forKey: .state)
      try c.encodeIfPresent(at.map(WireDate.format), forKey: .at)
    case .delivered: try c.encode("delivered", forKey: .state)
    case .read(let at):
      try c.encode("read", forKey: .state)
      try c.encode(WireDate.format(at), forKey: .at)
    case .notDelivered(let reason):
      try c.encode("notDelivered", forKey: .state)
      try c.encode(reason, forKey: .reason)
    }
  }
}
