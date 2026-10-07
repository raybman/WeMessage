import Foundation

// S4f: board 09.B's five draft states, and 09.G's audit row, projected from
// what the daemon serves plus what the app holds locally (an approval still
// inside its undo window, a hold). Named DraftPhase because DraftState is
// the wire enum.

/// Who is holding a draft back.
public enum HoldCause: Equatable, Sendable {
  /// The user pressed Hold at `at`.
  case you(at: Date)
  /// The kill switch is on (09.F): returns to awaiting when disengaged.
  case killSwitch
}

/// The five states 09.B draws. Expired and held read as absent: no verbs.
public enum DraftPhase: Equatable, Sendable {
  case awaiting(proposedAt: Date, expiresAt: Date?)
  case approvedInUndo(approvedAt: Date, sendsAt: Date)
  case sent(at: Date)
  case expired(at: Date)
  case held(HoldCause, expiresAt: Date?)

  /// Only an awaiting draft carries Approve, Edit and Hold.
  public var carriesVerbs: Bool {
    if case .awaiting = self { return true }
    return false
  }

  /// Drawn filled (sent) rather than dashed.
  public var isFilled: Bool {
    if case .sent = self { return true }
    return false
  }

  /// Muted border and ink: the two states that mean "this will not send".
  public var readsAbsent: Bool {
    switch self {
    case .expired, .held: true
    default: false
    }
  }

  /// Project a draft at `now`. `approvedAt` is a local approval still
  /// counting down (the daemon has not been told yet); `heldAt` is a local
  /// hold. Rejected, superseded, recalled and failed drafts are not drawn as
  /// a draft at all: nil.
  public static func project(
    _ draft: DraftPayload, now: Date, approvedAt: Date? = nil, undoSeconds: Int = UndoWindow.agentDefault,
    heldAt: Date? = nil, killSwitch: Bool?
  ) -> DraftPhase? {
    let created = WireDate.parse(draft.createdAt) ?? now
    let changed = WireDate.parse(draft.stateChangedAt) ?? created
    let expires = WireDate.parse(draft.expiresAt)
    switch draft.state {
    case .pending:
      if let expires, expires <= now { return .expired(at: expires) }
      if killSwitch == true { return .held(.killSwitch, expiresAt: expires) }
      if let heldAt { return .held(.you(at: heldAt), expiresAt: expires) }
      if let approvedAt {
        let sends = approvedAt.addingTimeInterval(Double(undoSeconds))
        if now < sends { return .approvedInUndo(approvedAt: approvedAt, sendsAt: sends) }
      }
      return .awaiting(proposedAt: created, expiresAt: expires)
    case .approved, .sending:
      let sends = draft.sendNotBefore.flatMap(WireDate.parse) ?? changed
      return .approvedInUndo(approvedAt: changed, sendsAt: sends)
    case .sent:
      return .sent(at: changed)
    case .expired:
      return .expired(at: expires ?? changed)
    case .rejected, .superseded, .recalled, .failed:
      return nil
    }
  }

  /// The meta line under the bubble (09.A, 09.B). `clock` prints HH:mm and
  /// `longClock` HH:mm:ss; `adapter` is the agent's display name. `long` is
  /// 09.A's open-draft form. `heldTail` ends a user hold's line: the board
  /// says "will not expire", which is only true once the daemon parks the
  /// expiry, so the app chooses the words (ProvisionalUI D-UI-45).
  public func meta(
    adapter: String, clock: (Date) -> String, longClock: (Date) -> String, long: Bool = false,
    heldTail: (Date?) -> String
  ) -> String {
    switch self {
    case .awaiting(let proposed, let expires):
      var parts = long ? ["DRAFT", "proposed by \(adapter) \(clock(proposed))", "not sent"] : ["DRAFT", "\(adapter) \(clock(proposed))"]
      if let expires { parts.append("expires \(clock(expires))") }
      return parts.joined(separator: " · ")
    case .approvedInUndo(let approved, let sends):
      return "APPROVED by you \(longClock(approved)) · sends at \(longClock(sends))"
    case .sent(let at):
      return "Sent \(clock(at)) · approved by you"
    case .expired(let at):
      return "EXPIRED \(clock(at)) · not sent · \(adapter) may propose again"
    case .held(.you(let at), let expires):
      return "HELD by you \(clock(at)) · not sent · \(heldTail(expires))"
    case .held(.killSwitch, _):
      return "HELD by kill switch · not sent · returns to awaiting when disengaged"
    }
  }
}

/// One row of 09.G's audit table, projected from the daemon's audit row.
public struct AuditLine: Equatable, Sendable {
  public var seq: Int
  public var at: Date?
  /// HUMAN, AGENT or SYSTEM.
  public var actor: String
  /// The agent's adapter id, when an agent acted.
  public var actorName: String?
  /// The event type, as the daemon wrote it (draft.created, draft.approved).
  public var verb: String
  /// The draft or message the event is about; empty when it names none.
  public var target: String
  /// The event's own result field. The daemon does not write one today, so
  /// this is nil and the view says so (ProvisionalUI D-UI-49).
  public var result: String?
  /// Four-character prefixes with an ellipsis, as 09.G draws them.
  public var prev: String
  public var hash: String

  public static func short(_ hash: String) -> String {
    String(hash.prefix(4)) + "…"
  }

  public init(_ row: AuditRowPayload) {
    let event = Self.object(row.eventJson)
    let actorObject = Self.object(row.actorJson)
    seq = row.seq
    at = WireDate.parse(row.at)
    switch actorObject["kind"] as? String {
    case "human": actor = "HUMAN"
    case "agent": actor = "AGENT"
    default: actor = "SYSTEM"
    }
    actorName = actorObject["adapterId"] as? String
    verb = event["type"] as? String ?? "unknown"
    target =
      (event["draftId"] as? String) ?? (event["messageGuid"] as? String) ?? (event["chatGuid"] as? String) ?? ""
    result = event["result"] as? String
    prev = Self.short(row.prevHash)
    hash = Self.short(row.hash)
  }

  static func object(_ json: String) -> [String: Any] {
    guard let data = json.data(using: .utf8),
      let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return [:] }
    return value
  }
}
