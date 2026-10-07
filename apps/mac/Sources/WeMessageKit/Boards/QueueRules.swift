import Foundation

/// How far back the queue looks (plan 3.1; the app reads the length from
/// ProvisionalUI D-UI-18).
public struct QueueWindow: Equatable, Sendable {
  public var days: Int

  public init(days: Int = 14) {
    self.days = days
  }
}

/// Why something is waiting on the user.
public enum QueueReason: Equatable, Sendable {
  case directQuestion
  case mention
  case ruleFired(String)
  case agentFlag
  case pendingDraft
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

  /// The queue the daemon can vouch for today: one item per pending draft,
  /// on its thread's channel, arrived when the draft was made. Drafts in any
  /// other state, and drafts whose creation time does not parse, are not
  /// waiting on anyone.
  public static func items(drafts: [DraftPayload], threads: [ThreadSummary]) -> [QueueItem] {
    var channelOf: [String: String] = [:]
    for thread in threads { channelOf[thread.chatGuid] = thread.channel }
    return drafts.compactMap { draft in
      guard draft.state == .pending, let at = WireDate.parse(draft.createdAt) else { return nil }
      return QueueItem(
        threadGuid: draft.chatGuid, channel: channelOf[draft.chatGuid] ?? "imessage", reason: .pendingDraft,
        arrivedAt: at, draftId: draft.id)
    }
  }
}

/// The daemon's timestamps: ISO 8601, with or without fractional seconds.
public enum WireDate {
  public static func parse(_ raw: String) -> Date? {
    if let date = try? Date(raw, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) { return date }
    return try? Date(raw, strategy: Date.ISO8601FormatStyle())
  }
}
