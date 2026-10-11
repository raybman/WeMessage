import Foundation
import WeMessageKit

// v2 S4h, board 10: the states that decide whether a user trusts the app.
// Everything here is pure: the same facts always give the same words, and
// nothing reads a clock. Every duration is computed from two dates the
// caller passes, so a sentence is always dated by the facts it came from.

// MARK: - 10.B, the six empties

/// The six empties (10.B). Each states its cause and offers exactly one
/// next action; none is a generic "nothing here".
public enum EmptyStateCase: String, CaseIterable, Sendable {
  /// Inbox Zero reached, earned.
  case inboxZero = "zero"
  /// Connected, fresh, and nothing arrived: the one a boolean cannot say.
  case nothingArrived = "quiet"
  /// No thread selected.
  case noThreadSelected = "unselected"
  /// No search results.
  case noSearchResults = "search"
  /// Channel not connected yet.
  case notConnected = "unconnected"
  /// Brand new thread, no history.
  case newThread = "new"
}

/// The one next action an empty offers.
public struct EmptyAction: Equatable, Sendable {
  public let label: String
  /// Stable per case: the action's accessibility identifier suffix.
  public let slug: String
}

/// One empty's words.
public struct EmptyStateCopy: Equatable, Sendable {
  public let kind: EmptyStateCase
  /// The mark above the headline (10.B: "0", an ellipsis, a box, a lens,
  /// a ring, a pen). Monochrome, ink only.
  public let glyph: String
  public let headline: String
  public let detail: String
  /// The dated counter under the detail, when the empty carries numbers
  /// (10.B: "the moment is printed").
  public let dated: String?
  /// Exactly one.
  public let actions: [EmptyAction]
}

/// What the empties are built from. The 10.B sheet passes the fixture's
/// facts; nothing here is guessed.
public struct EmptyFacts: Equatable, Sendable {
  public var channel: String
  public var cleared: Int
  public var arrived: Int
  public var snoozed: Int
  public var waitingOn: String
  public var asOf: Date
  public var syncedAt: Date
  public var lastArrival: Date
  public var query: String
  public var searched: Int
  public var channels: Int
  public var searchMillis: Int
  public var indexAsOf: Date
  public var unconnectedChannel: String
  public var newThreadWith: String

  public init(
    channel: String, cleared: Int, arrived: Int, snoozed: Int, waitingOn: String, asOf: Date, syncedAt: Date,
    lastArrival: Date, query: String, searched: Int, channels: Int, searchMillis: Int, indexAsOf: Date,
    unconnectedChannel: String, newThreadWith: String
  ) {
    self.channel = channel
    self.cleared = cleared
    self.arrived = arrived
    self.snoozed = snoozed
    self.waitingOn = waitingOn
    self.asOf = asOf
    self.syncedAt = syncedAt
    self.lastArrival = lastArrival
    self.query = query
    self.searched = searched
    self.channels = channels
    self.searchMillis = searchMillis
    self.indexAsOf = indexAsOf
    self.unconnectedChannel = unconnectedChannel
    self.newThreadWith = newThreadWith
  }
}

public enum EmptyStates {
  /// The words for one empty. The wireframe's copy (10.B), trimmed to what
  /// this build can make true (D-UI-62, D-UI-63).
  public static func copy(_ kind: EmptyStateCase, _ f: EmptyFacts, zone: TimeZone = .current) -> EmptyStateCopy {
    switch kind {
    case .inboxZero:
      return EmptyStateCopy(
        kind: kind, glyph: "0", headline: "\(f.channel) is clear",
        detail:
          "You cleared \(f.cleared) of the \(f.arrived) that arrived today. \(f.snoozed) snoozed to tomorrow, 1 waiting on \(f.waitingOn).",
        dated: "Clear as of " + ShellText.clock(f.asOf, zone: zone),
        actions: [EmptyAction(label: ProvisionalUI.emptyActions[kind.rawValue] ?? "", slug: "done")])
    case .nothingArrived:
      return EmptyStateCopy(
        kind: kind, glyph: "\u{22EF}", headline: "Nothing new on \(f.channel) today",
        detail:
          "Synced \(age(from: f.syncedAt, to: f.asOf)) ago. Nothing has arrived since \(ShellText.shortClock(f.lastArrival, zone: zone)). This is not a sync problem. The rail tile would carry an exclamation instead of a clear baseline if it were.",
        dated: nil,
        actions: [EmptyAction(label: ProvisionalUI.emptyActions[kind.rawValue] ?? "", slug: "yesterday")])
    case .noThreadSelected:
      return EmptyStateCopy(
        kind: kind, glyph: "\u{25A2}", headline: "No conversation selected",
        detail: "Pick a thread, or press \u{2191} \u{2193} to move through the list.",
        dated: nil,
        actions: [EmptyAction(label: ProvisionalUI.emptyActions[kind.rawValue] ?? "", slug: "needsyou")])
    case .noSearchResults:
      let noun = f.channels == 1 ? "channel" : "channels"
      return EmptyStateCopy(
        kind: kind, glyph: "\u{2315}", headline: "Nothing for \u{201C}\(f.query)\u{201D}",
        detail:
          "Searched \(grouped(f.searched)) messages across \(f.channels) \(noun) in \(f.searchMillis)ms. Index as of \(ShellText.clock(f.indexAsOf, zone: zone)).",
        dated: nil,
        actions: [EmptyAction(label: ProvisionalUI.emptyActions[kind.rawValue] ?? "", slug: "muted")])
    case .notConnected:
      return EmptyStateCopy(
        kind: kind, glyph: "\u{25EF}", headline: "\(f.unconnectedChannel) is not connected",
        detail:
          "WeMessage will open a real \(f.unconnectedChannel) window and stay signed in as you. Your password never leaves that window.",
        dated: nil,
        actions: [EmptyAction(label: "Connect \(f.unconnectedChannel)", slug: "connect")])
    case .newThread:
      return EmptyStateCopy(
        kind: kind, glyph: "\u{270E}", headline: "No messages yet",
        detail: "First message to \(f.newThreadWith) on \(f.channel).",
        dated: nil,
        actions: [EmptyAction(label: ProvisionalUI.emptyActions[kind.rawValue] ?? "", slug: "write")])
    }
  }

  /// "12 seconds", "6 minutes", "6h 12m": the span between two dates the
  /// caller passed, never against the wall clock.
  public static func age(from: Date, to: Date) -> String {
    let s = max(0, Int(to.timeIntervalSince(from)))
    switch s {
    case ..<60: return s == 1 ? "1 second" : "\(s) seconds"
    case ..<3600: return s / 60 == 1 ? "1 minute" : "\(s / 60) minutes"
    default: return "\(s / 3600)h \((s % 3600) / 60)m"
    }
  }

  static func grouped(_ n: Int) -> String {
    let f = NumberFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.numberStyle = .decimal
    f.groupingSeparator = ","
    f.usesGroupingSeparator = true
    return f.string(from: NSNumber(value: n)) ?? String(n)
  }
}

// MARK: - 10.A, the trust line

/// One row of the per-channel age table (10.A): the hover popover off the
/// rail, and the same rows in Settings (D-UI-61).
public struct FreshnessRow: Equatable, Sendable {
  public enum State: Equatable, Sendable {
    /// Fresh, dated by its own last sync.
    case live(asOf: Date?)
    /// Cannot vouch: the last sync it can, if any.
    case stale(since: Date?)
    /// Not connected: no age and no count, ever.
    case notConnected
  }

  public let scope: ShellModel.Scope
  public let state: State
  /// Today's messages, dated by this row's own sync; nil for a channel that
  /// is not connected (never a 0).
  public let today: Int?
  /// v2 F7e (D-UI-213): how long the daemon has read nothing, when that is
  /// why the row is stale.
  public var quietFor: Int? = nil

  public init(scope: ShellModel.Scope, state: State, today: Int?, quietFor: Int? = nil) {
    self.scope = scope
    self.state = state
    self.today = today
    self.quietFor = quietFor
  }

  /// 10.A's own words for a channel with no transport: never a number.
  public static let notConnectedWords = "not connected"

  /// The channel name as the table prints it (10.A: "iMESSAGE").
  public var name: String {
    switch scope {
    case .imessage: "iMESSAGE"
    default: scope.fullLabel.uppercased()
    }
  }

  /// The age column's words.
  public func age(zone: TimeZone = .current) -> String {
    switch state {
    case .live(let at): at.map { "live \u{00B7} as of " + ShellText.clock($0, zone: zone) } ?? "live"
    case .stale(let since):
      (since.map { "STALE \u{00B7} since " + ShellText.clock($0, zone: zone) } ?? "STALE \u{00B7} never synced")
        + (quietFor.map(ProvisionalUI.noReadFor) ?? "")
    case .notConnected:
      Self.notConnectedWords
    }
  }

  /// The count column's words: nothing at all for a channel that is not
  /// connected.
  public var count: String {
    guard case .notConnected = state else { return today.map { "\($0) today" } ?? "" }
    return ""
  }

  /// The row as one sentence, for its accessibility value.
  public func sentence(zone: TimeZone = .current) -> String {
    [name, age(zone: zone), count].filter { !$0.isEmpty }.joined(separator: " ")
  }
}

public enum Freshness {
  /// The four rows, folded from the board's marks: a digit or a baseline is
  /// live, an exclamation is stale, nothing is not connected.
  public static func rows(board: ShellBoard, status: StatusPayload?) -> [FreshnessRow] {
    ShellModel.Scope.allCases.filter { $0 != .all }.map { scope in
      switch board.mark(scope) {
      case .digit, .baseline:
        FreshnessRow(scope: scope, state: .live(asOf: board.lastScan), today: today(scope, status))
      case .stale:
        FreshnessRow(
          scope: scope, state: .stale(since: board.lastScan), today: today(scope, status),
          quietFor: scope == .imessage ? board.quietFor : nil)
      case .none:
        FreshnessRow(scope: scope, state: .notConnected, today: nil)
      }
    }
  }

  static func today(_ scope: ShellModel.Scope, _ status: StatusPayload?) -> Int? {
    // v2 F7: the iMessage entry's own count, the top-level one from a
    // daemon that does not carry it on the entry.
    guard scope == .imessage else { return nil }
    return status?.channels.first(where: { $0.channel == "imessage" })?.today ?? status?.counts.messagesToday
  }

  /// The table's foot (10.A): the clock it was computed at while every
  /// connected row is live; CANNOT SAY, with the stale channel and since
  /// when, the moment one is not. Nil when nothing is connected.
  public static func footer(_ rows: [FreshnessRow], zone: TimeZone = .current) -> String? {
    if let stale = rows.first(where: { if case .stale = $0.state { true } else { false } }) {
      guard case .stale(let since) = stale.state else { return nil }
      let when = since.map { " since " + ShellText.clock($0, zone: zone) } ?? ", never synced"
      return "CANNOT SAY \(stale.scope.fullLabel) stale" + when + (stale.quietFor.map(ProvisionalUI.noReadFor) ?? "")
    }
    let dates = rows.compactMap { row -> Date? in
      if case .live(let at) = row.state { return at }
      return nil
    }
    guard let latest = dates.max() else { return nil }
    return "Mirrored as of " + ShellText.clock(latest, zone: zone)
  }
}

/// The banner a stale tile triggers (10.A): which channel and since when,
/// in words. Nil while no connected channel is stale.
public enum TrustBanner {
  public static func line(board: ShellBoard, zone: TimeZone = .current) -> String? {
    guard let scope = ShellModel.Scope.allCases.first(where: { $0 != .all && board.mark($0) == .stale }) else {
      return nil
    }
    guard let since = board.lastScan else {
      return "\(scope.fullLabel) has never synced. You may be missing messages."
    }
    return "\(scope.fullLabel) has not synced since \(ShellText.clock(since, zone: zone)). You may be missing messages."
  }
}

// MARK: - 10.C, Full Disk Access

/// What the window knows about Full Disk Access. The daemon reads chat.db,
/// so the daemon's answer is the probe: a 503 source-unavailable on the
/// thread list means it cannot.
public enum FDAState: Equatable, Sendable {
  case granted
  /// Never readable while this window watched: the first-run screen.
  case firstRun
  /// Readable once, then not: the revoked banner, with the last time the
  /// source was readable.
  case revoked(lastReadable: Date)

  public static func fold(sourceUnavailable: Bool, lastReadable: Date?) -> FDAState {
    guard sourceUnavailable else { return .granted }
    return lastReadable.map { .revoked(lastReadable: $0) } ?? .firstRun
  }
}

/// The seam over Full Disk Access (10.C). The screen names no URL and opens
/// nothing itself; it asks the seam. Under the UI-test flag the seam is the
/// fixture, which records the ask and opens nothing (H-S4-6).
@MainActor
public protocol FullDiskAccessSeam: AnyObject {
  /// The daemon's answer folded with what this window saw.
  func state(sourceUnavailable: Bool, lastReadable: Date?) -> FDAState
  /// The user asked to open System Settings.
  func openSettings()
  /// How many times openSettings was asked (the fixture's record; the
  /// system seam counts too, for the same accessibility value).
  var asked: Int { get }
  /// Onboarding's poll (12.B, every 2 s on 2b): can chat.db be read now?
  func probe() async -> Bool
  /// How many times probe was asked.
  var probes: Int { get }
  /// 2c's count query, once readable; nil while the daemon has none.
  func sizing() async -> CopySizing?
  /// CopyProgress, once the copy was asked for; nil while the daemon has none.
  func copyProgress() async -> CopyProgressFacts?
}

/// The shipped seam. The daemon's answer is the probe, as the fixture's is;
/// the ask opens the Full Disk Access pane through SystemSettingsPane, the
/// one file that names it (D-UI-64, H-S4-7). Never built under the UI-test
/// flag (H-S4-6).
@MainActor
public final class SystemFullDiskAccess: FullDiskAccessSeam {
  public private(set) var asked = 0
  public private(set) var probes = 0
  public init() {}
  public func state(sourceUnavailable: Bool, lastReadable: Date?) -> FDAState {
    FDAState.fold(sourceUnavailable: sourceUnavailable, lastReadable: lastReadable)
  }
  public func openSettings() {
    precondition(!TestHooks.isUITest, "the system Full Disk Access seam under the UI-test flag")
    asked += 1
    SystemSettingsPane.openFullDiskAccess()
  }
  /// The daemon reads chat.db, so its thread list is the probe: readable
  /// unless it answers source-unavailable or does not answer.
  public func probe() async -> Bool {
    precondition(!TestHooks.isUITest, "the system Full Disk Access seam under the UI-test flag")
    probes += 1
    guard let listed = try? await GatewayClient().listThreads(limit: 1) else { return false }
    if case .ok = listed { return true }
    return false
  }
  /// v2 F7e: the copy as the daemon's status counts it (`mirror`); nil
  /// from a daemon that does not answer or carries none.
  public func sizing() async -> CopySizing? {
    precondition(!TestHooks.isUITest, "the system Full Disk Access seam under the UI-test flag")
    return CopySizing.from(try? await GatewayClient().status().mirror)
  }
  /// v2 F7e: the same status's index progress (D-UI-216).
  public func copyProgress() async -> CopyProgressFacts? {
    precondition(!TestHooks.isUITest, "the system Full Disk Access seam under the UI-test flag")
    return CopyProgressFacts.from(try? await GatewayClient().status().mirror)
  }
}

/// The FDA screen's words (10.C): the four headings and what each says.
public enum FDACopy {
  public static let title = "WeMessage needs Full Disk Access"
  public static let step = "Set up iMessage"
  public static let headings = ["What it grants", "Why we need it", "What we do with it", "What we never do"]
  public static let bodies = [
    "Read access to ~/Library/Messages/chat.db, the database Messages.app already keeps on this Mac.",
    "There is no API for iMessage. Reading that file is the only way any app on macOS can show you your own messages.",
    "We copy your messages into ~/Library/Application Support/WeMessage/wemessage.db so search and history work offline. That is a real second copy of your message history on this disk. It is never uploaded. You can delete it in Settings, and the app tells you its exact size.",
    "We never send a message without you approving that exact text first. There is one send path in the codebase and it requires your approval record.",
  ]
  public static let open = "Open System Settings"
  public static let skip = "Skip iMessage for now"

  public static let revokedLine = "Lost access to chat.db. Full Disk Access was turned off."
  public static func revokedDetail(_ lastReadable: Date, zone: TimeZone = .current) -> String {
    "iMessage history is still readable from the local mirror up to \(ShellText.clock(lastReadable, zone: zone)). Nothing new will arrive until access is restored."
  }
}

// MARK: - 10.D, pacing

/// One pacing row (10.D): iMessage's two, in this build.
public struct PacingRow: Equatable, Sendable {
  public let channel: String
  public let action: String
  public let pace: String
  public let today: String
}

public enum Pacing {
  /// iMessage's rows. Read is a local file, unlimited, with no count; send
  /// is the user's own account, with today's sends when served, else the
  /// auditResultUnserved words (D-UI-66), never a 0 standing in for unknown.
  public static func rows(sendsToday: Int?) -> [PacingRow] {
    [
      PacingRow(channel: "iMessage", action: "read", pace: "local file, unlimited", today: "\u{00B7}"),
      PacingRow(
        channel: "iMessage", action: "send", pace: "your own account",
        today: sendsToday.map(String.init) ?? ProvisionalUI.auditResultUnserved),
    ]
  }

  public static func footer(asOf: Date?, zone: TimeZone = .current) -> String {
    let dated = asOf.map { " Counts are for today so far, as of \(ShellText.clock($0, zone: zone))." } ?? ""
    return "Pacing is a hard stop, not a warning." + dated
  }
}

// MARK: - 10.E, collision

/// The agent drafted while the human was typing (10.E): the human's
/// keystrokes win and the draft is parked behind this notice.
public enum CollisionNotice {
  public static func line(agent: String) -> String { "\(agent) drafted a reply to this thread. Your typing wins." }
  public static let actions = ["See it", "Dismiss"]
}
