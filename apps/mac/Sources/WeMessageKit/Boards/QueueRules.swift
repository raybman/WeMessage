import Foundation

/// How far back the queue looks (plan 3.1; the app reads the length from
/// ProvisionalUI D-UI-18).
public struct QueueWindow: Equatable, Sendable {
  public var days: Int

  public init(days: Int = 14) {
    self.days = days
  }
}

/// Why something is waiting on the user, only as far as a draft proves it
/// (v2 F3, G-06b). There is no direct-question or mention reason: nothing in
/// the daemon detects either, and a reason nobody proved is a guess.
public enum QueueReason: Equatable, Sendable {
  /// The draft carries a rule id. The rule's name when the shell has it,
  /// else nil (the app then says "a rule").
  case ruleFired(String?)
  /// The draft is proactive. The agent's own words, as one sanitised line:
  /// shown as what the agent said, never as a verdict.
  case agentFlag(String)
  /// A draft is ready, and nothing says more than that.
  case pendingDraft
}

/// The one place a queue reason is decided.
public enum QueueReasons {
  /// A rule id outranks a proactive reason (the rule is what produced the
  /// draft); a proactive reason that sanitises to nothing proves nothing.
  public static func derive(_ draft: DraftPayload, ruleName: (String) -> String? = { _ in nil }) -> QueueReason {
    if let id = draft.ruleId { return .ruleFired(ruleName(id)) }
    if let raw = draft.proactiveReason {
      let line = oneLine(raw)
      if !line.isEmpty { return .agentFlag(line) }
    }
    return .pendingDraft
  }

  /// Agent-supplied text as one line: control and format characters (line
  /// breaks, tabs, bidi overrides) become spaces, runs of whitespace become
  /// one space, and the ends are trimmed. Truncation is the view's (D-UI-194).
  public static func oneLine(_ raw: String) -> String {
    var out = ""
    var pendingSpace = false
    for scalar in raw.unicodeScalars {
      let props = scalar.properties
      let blank =
        props.isWhitespace || props.generalCategory == .control || props.generalCategory == .format
        || props.generalCategory == .lineSeparator || props.generalCategory == .paragraphSeparator
      if blank {
        pendingSpace = !out.isEmpty
        continue
      }
      if pendingSpace { out.unicodeScalars.append(" ") }
      pendingSpace = false
      out.unicodeScalars.append(scalar)
    }
    return out
  }
}

/// One thing waiting on the user.
public struct QueueItem: Equatable, Sendable {
  public var threadGuid: String
  /// "imessage", "sms", and so on: ThreadSummary.channel.
  public var channel: String
  public var reason: QueueReason
  public var arrivedAt: Date
  public var draftId: String?

  public init(threadGuid: String, channel: String, reason: QueueReason, arrivedAt: Date, draftId: String? = nil) {
    self.threadGuid = threadGuid
    self.channel = channel
    self.reason = reason
    self.arrivedAt = arrivedAt
    self.draftId = draftId
  }
}

/// What a rail tile says about its channel (wireframe 17.G legend): a digit
/// is items waiting, the baseline is clear and fresh, "!" is stale (never a
/// count), and nothing at all is not connected.
public enum RailMark: Equatable, Sendable {
  case digit(Int)
  case baseline
  case stale
  case none
}

/// The queue's pure rules. Nothing here reads a clock: every caller passes
/// the moment it means.
public enum QueueRules {
  /// Items that arrived inside the window ending at `now`: after
  /// `now - days` and not after `now`.
  public static func queueCount(items: [QueueItem], now: Date, window: QueueWindow = QueueWindow()) -> Int {
    let start = now.addingTimeInterval(-Double(window.days) * 86_400)
    return items.filter { $0.arrivedAt > start && $0.arrivedAt <= now }.count
  }

  /// One tile's mark. A channel that is not connected says nothing; one that
  /// is connected but not fresh says "cannot say", whatever it counted; only
  /// a fresh channel shows a digit or the clear baseline.
  public static func railMark(count: Int, fresh: Bool, connected: Bool) -> RailMark {
    guard connected else { return .none }
    guard fresh else { return .stale }
    return count > 0 ? .digit(count) : .baseline
  }

  /// The ALL tile inherits the worst tile: any stale channel makes it stale
  /// (a total that quietly drops a stale channel is the number that does
  /// harm), otherwise the sum of the digits, otherwise clear. Channels that
  /// are not connected are left out; with none connected it says nothing.
  public static func allMark(_ marks: [RailMark]) -> RailMark {
    let live = marks.filter { $0 != .none }
    if live.isEmpty { return .none }
    if live.contains(.stale) { return .stale }
    let total = live.reduce(0) { sum, mark in
      if case .digit(let n) = mark { return sum + n }
      return sum
    }
    return total > 0 ? .digit(total) : .baseline
  }

  /// The queue the daemon can vouch for today: one item per thread with a
  /// pending draft (06.G: the rail, the counter and Triage say one number,
  /// so a thread with two drafts is one thing waiting), on its thread's
  /// channel, carrying the newest draft and arrived when it was made, in the
  /// order the threads first appear. Drafts in any other state, drafts whose
  /// creation time does not parse, and drafts `excluding` names (held, or
  /// cleared by an act) are not waiting on anyone. Each item's reason is the
  /// newest draft's, from QueueReasons.derive.
  public static func items(
    drafts: [DraftPayload], threads: [ThreadSummary], excluding: Set<String> = [],
    ruleName: (String) -> String? = { _ in nil }
  ) -> [QueueItem] {
    var channelOf: [String: String] = [:]
    for thread in threads { channelOf[thread.chatGuid] = thread.channel }
    var order: [String] = []
    var newest: [String: QueueItem] = [:]
    for draft in drafts {
      guard draft.state == .pending, !excluding.contains(draft.id), let at = WireDate.parse(draft.createdAt)
      else { continue }
      let item = QueueItem(
        threadGuid: draft.chatGuid, channel: channelOf[draft.chatGuid] ?? "imessage", reason: QueueReasons.derive(draft, ruleName: ruleName),
        arrivedAt: at, draftId: draft.id)
      if let seen = newest[draft.chatGuid] {
        if at >= seen.arrivedAt { newest[draft.chatGuid] = item }
      } else {
        order.append(draft.chatGuid)
        newest[draft.chatGuid] = item
      }
    }
    return order.compactMap { newest[$0] }
  }
}

/// The daemon's timestamps: ISO 8601, with or without fractional seconds.
public enum WireDate {
  public static func parse(_ raw: String) -> Date? {
    if let date = try? Date(raw, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) { return date }
    return try? Date(raw, strategy: Date.ISO8601FormatStyle())
  }

  /// The wire form of `date`: ISO 8601 in UTC with milliseconds.
  public static func format(_ date: Date) -> String {
    date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
  }
}
