import Foundation

// S4f: the rules behind boards 06 and 09. Wireframe 06.A says when a thread
// is in the queue; 09.F says which verbs exist while sending is stopped.
// Nothing here reads a clock or the network: every caller passes the moment
// and the facts it means.

/// How a thread asks for attention (06.B). Queue: every inbound counts.
/// Stream: only something addressed to you enters. Muted: nothing enters.
public enum ThreadMode: Equatable, Sendable {
  case queue
  case stream
  case muted
}

/// The user's last completion act on a thread (06.A). Reading is never an
/// act, so there is no case for it.
public enum ThreadAct: Equatable, Sendable {
  case done(at: Date)
  case snoozed(at: Date, until: Date)
  case muted(at: Date)

  public var at: Date {
    switch self {
    case .done(let at), .snoozed(let at, _), .muted(let at): at
    }
  }
}

/// What a pending draft does to queue membership. 06.A's table says a
/// pending draft keeps the thread in the queue "always, overrides all";
/// 06.C draws Done, Snooze and Mute live beside a draft. `.always` is the
/// table read literally; `.untilActedOn` lets an act clear the draft that was
/// there when the act was made, and a newer draft re-queues the thread
/// (06.G). The app picks one (ProvisionalUI D-UI-44).
public enum DraftRule: Equatable, Sendable {
  case always
  case untilActedOn
}

/// Everything 06.A's table reads about one thread.
public struct ThreadFacts: Equatable, Sendable {
  /// The newest inbound message. A reaction is never an inbound: callers
  /// leave reactions out of this.
  public var newestInboundAt: Date?
  public var newestOutboundAt: Date?
  /// When the newest awaiting draft on the thread was made (pending and not
  /// held); nil when there is none.
  public var pendingDraftAt: Date?
  public var act: ThreadAct?
  public var mode: ThreadMode
  /// Something addressed to you, as far as anything proves it (a fired rule
  /// or an agent flag): what lets a Stream thread's inbound enter the queue
  /// (06.B).
  public var directToYou: Bool

  public init(
    newestInboundAt: Date? = nil, newestOutboundAt: Date? = nil, pendingDraftAt: Date? = nil,
    act: ThreadAct? = nil, mode: ThreadMode = .queue, directToYou: Bool = false
  ) {
    self.newestInboundAt = newestInboundAt
    self.newestOutboundAt = newestOutboundAt
    self.pendingDraftAt = pendingDraftAt
    self.act = act
    self.mode = mode
    self.directToYou = directToYou
  }
}

/// A verb the queue and the draft bubble can offer.
public enum Verb: String, CaseIterable, Equatable, Sendable {
  case reply
  case approve
  case edit
  case hold
  case done
  case snooze
  case mute
  case select
  case undo
}

/// Why a verb is absent. A verb that is not allowed is not drawn at all,
/// never greyed (09.F rule 1); the reason is printed where it would have been.
public enum VerbRefusal: Equatable, Sendable {
  /// The kill switch is on, or its state is unknown.
  case killSwitch
  /// The channel is paused (a 429 stop).
  case paused
  /// The source is stale or down: Done never succeeds against it (06.E).
  case sourceStale
  /// Bulk and single approve need the body rendered on screen (06.F, 09.D).
  case notRendered
  /// There is no awaiting draft to act on.
  case noDraft
  /// A Stream thread has no Mute (06.B).
  case streamMode
  /// The thread holds an unsaved human edit (06.F, 09.D).
  case unsavedEdit
}

/// What a surface knows when it decides which verbs to draw.
public struct VerbGates: Equatable, Sendable {
  /// nil is unknown, and unknown is treated as on.
  public var killSwitch: Bool?
  public var paused: Bool
  public var sourceStale: Bool
  public var bodyRendered: Bool
  public var hasDraft: Bool
  public var mode: ThreadMode
  public var unsavedEdit: Bool

  public init(
    killSwitch: Bool?, paused: Bool = false, sourceStale: Bool = false, bodyRendered: Bool = false,
    hasDraft: Bool = false, mode: ThreadMode = .queue, unsavedEdit: Bool = false
  ) {
    self.killSwitch = killSwitch
    self.paused = paused
    self.sourceStale = sourceStale
    self.bodyRendered = bodyRendered
    self.hasDraft = hasDraft
    self.mode = mode
    self.unsavedEdit = unsavedEdit
  }
}

public enum CompletionRules {
  /// 06.A: is this thread in the queue at `now`?
  public static func inQueue(
    _ facts: ThreadFacts, now: Date, window: QueueWindow = QueueWindow(), draftRule: DraftRule = .always
  ) -> Bool {
    if let drafted = facts.pendingDraftAt {
      switch draftRule {
      case .always: return true
      case .untilActedOn:
        if let act = facts.act {
          if drafted > act.at { return true }
          // A snooze that has run out returns the thread, draft and all.
          if case .snoozed(_, let until) = act, now >= until { return true }
        } else {
          return true
        }
      }
    }
    if facts.mode == .muted { return false }
    if case .muted = facts.act { return false }
    guard let inbound = facts.newestInboundAt else { return false }
    let start = now.addingTimeInterval(-Double(window.days) * 86_400)
    guard inbound > start, inbound <= now else { return false }
    if let outbound = facts.newestOutboundAt, outbound >= inbound { return false }
    if facts.mode == .stream && !facts.directToYou { return false }
    switch facts.act {
    case .none: return true
    case .done(let at): return inbound > at
    case .snoozed(let at, let until): return now >= until || inbound > at
    case .muted: return false
    }
  }

  /// 09.F and 06.F: is `verb` drawn, and if not, why not. Kill switch on or
  /// unknown removes every verb that could lead to a send (reply, approve,
  /// edit, hold); reading, done, snooze, mute, select and undo stay.
  public static func permit(_ verb: Verb, _ gates: VerbGates) -> VerbRefusal? {
    let killed = gates.killSwitch != false
    switch verb {
    case .reply:
      if killed { return .killSwitch }
      if gates.paused { return .paused }
      return nil
    case .approve:
      if killed { return .killSwitch }
      if gates.paused { return .paused }
      if !gates.hasDraft { return .noDraft }
      if gates.unsavedEdit { return .unsavedEdit }
      if !gates.bodyRendered { return .notRendered }
      return nil
    case .edit, .hold:
      if killed { return .killSwitch }
      if !gates.hasDraft { return .noDraft }
      return nil
    case .done, .snooze:
      if gates.sourceStale { return .sourceStale }
      return nil
    case .mute:
      if gates.mode == .stream { return .streamMode }
      if gates.sourceStale { return .sourceStale }
      return nil
    case .select, .undo:
      return nil
    }
  }

  /// The verbs drawn under `gates`, in `order`.
  public static func drawn(_ order: [Verb], _ gates: VerbGates) -> [Verb] {
    order.filter { permit($0, gates) == nil }
  }
}

/// The undo windows (09.C, D-UI-16): an agent draft's approval waits
/// `send.undoGraceSeconds` clamped to 5...30 (10 when unset or not a
/// number); a typed send waits a fixed 4 seconds.
public enum UndoWindow {
  public static let typed = 4
  public static let agentDefault = 10
  public static let agentRange = 5...30

  public static func agent(fromSetting value: JSONValue?) -> Int {
    guard let raw = value?.doubleValue, raw.isFinite else { return agentDefault }
    let rounded = Int(raw.rounded())
    return min(max(rounded, agentRange.lowerBound), agentRange.upperBound)
  }
}
