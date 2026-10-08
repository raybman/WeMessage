import Foundation

// v2 S4l, board 16: the OS layer's pure half. The menu bar extra, the Dock
// badge and the popover all read one snapshot, so the three surfaces can
// never disagree about the one number they share (16.F legend 1). Nothing
// here reads a clock or names AppKit.

/// What every OS surface reads: the queue total across connected channels,
/// whether every connected source is fresh, whether the daemon is
/// connected, the kill switch, and whether Triage is open.
public struct OSSnapshot: Equatable, Sendable {
  /// Queue items in the window across connected channels (06.G), or nil
  /// when nobody can say.
  public var count: Int?
  /// Every connected source synced inside its threshold.
  public var fresh: Bool
  /// The daemon answers.
  public var connected: Bool
  /// The kill switch is engaged.
  public var killed: Bool
  /// Triage is open in the window.
  public var triage: Bool

  public init(count: Int?, fresh: Bool, connected: Bool, killed: Bool, triage: Bool = false) {
    self.count = count
    self.fresh = fresh
    self.connected = connected
    self.killed = killed
    self.triage = triage
  }
}

/// The extra's five states (16.A). There are exactly five.
public enum StatusState: String, CaseIterable, Sendable {
  case idle, waiting, degraded, killed, disconnected
}

/// The extra as drawn: one glyph, one transform (the slash), one tonal move
/// (reduced alpha), and a badge that carries the state.
public struct StatusGlyph: Equatable, Sendable {
  public enum Badge: Equatable, Sendable {
    case none
    /// A count, already capped at "9+".
    case count(String)
    /// "!": the extra cannot say.
    case cannotSay
  }

  public var state: StatusState
  public var slashed: Bool
  public var reducedAlpha: Bool
  public var badge: Badge

  /// Words for the extra, so VoiceOver hears the state the badge carries.
  public var spoken: String {
    switch state {
    case .idle: "WeMessage, nothing waiting"
    case .waiting:
      if case .count(let text) = badge { "WeMessage, \(text) waiting" } else { "WeMessage, Triage open" }
    case .degraded: "WeMessage, cannot say, a source is stale"
    case .killed: "WeMessage, kill switch on, nothing can send"
    case .disconnected: "WeMessage, not connected"
    }
  }
}

public enum OSLayer {
  /// The menu bar's cap: a three digit badge pushes the clock (16.A).
  public static let menuBarCap = 9

  /// The state, by precedence: the deny first (it is the most
  /// consequential fact), then the connection, then freshness, then the
  /// count.
  public static func state(_ s: OSSnapshot) -> StatusState {
    if s.killed { return .killed }
    if !s.connected { return .disconnected }
    guard s.fresh, let count = s.count else { return .degraded }
    return count > 0 ? .waiting : .idle
  }

  /// The one quantity the extra and the Dock share, or nil when it is
  /// suppressed: never while killed, disconnected, degraded or in Triage,
  /// and never a zero (16.A, 16.F).
  public static func badgeCount(_ s: OSSnapshot) -> Int? {
    guard state(s) == .waiting, !s.triage, let count = s.count, count > 0 else { return nil }
    return count
  }

  /// The menu bar's rendering of a count: the digit, or "9+" past nine.
  public static func menuBarText(_ count: Int) -> String {
    count > menuBarCap ? "\(menuBarCap)+" : "\(count)"
  }

  /// The Dock's rendering: the true number, uncapped, or nil (no badge).
  public static func dockBadge(_ s: OSSnapshot) -> String? {
    badgeCount(s).map { String($0) }
  }

  /// The extra's glyph for a snapshot.
  public static func glyph(_ s: OSSnapshot) -> StatusGlyph {
    let state = state(s)
    let badge: StatusGlyph.Badge
    switch state {
    case .degraded: badge = .cannotSay
    case .waiting: badge = badgeCount(s).map { .count(menuBarText($0)) } ?? .none
    case .idle, .killed, .disconnected: badge = .none
    }
    return StatusGlyph(state: state, slashed: state == .killed, reducedAlpha: state == .disconnected, badge: badge)
  }
}

// MARK: The popover (16.B, 16.C, 16.H)

/// One thing waiting, as the popover lists it. Never the draft's text: the
/// popover says a draft exists and shows the inbound line it answers.
public struct PopoverEntry: Equatable, Sendable, Identifiable {
  public enum Kind: Equatable, Sendable { case draft, message }

  public var id: String
  public var threadGuid: String
  public var name: String
  /// The channel scope's raw value: imessage, whatsapp, linkedin, email.
  public var channel: String
  /// The inbound line, never outbound text.
  public var preview: String
  public var kind: Kind
  /// A Stream thread: Mute is not offered (06.B legend 4).
  public var stream: Bool
  /// Its source is stale: Open only (16.C, 06.E legend 3).
  public var sourceStale: Bool
  public var arrivedAt: Date

  public init(
    id: String, threadGuid: String, name: String, channel: String, preview: String, kind: Kind, stream: Bool = false,
    sourceStale: Bool = false, arrivedAt: Date
  ) {
    self.id = id
    self.threadGuid = threadGuid
    self.name = name
    self.channel = channel
    self.preview = preview
    self.kind = kind
    self.stream = stream
    self.sourceStale = sourceStale
    self.arrivedAt = arrivedAt
  }

  /// The one line reason under the preview.
  public var reason: String {
    switch kind {
    case .draft: "Draft ready"
    case .message: stream ? "Direct question in a Stream thread" : "Unanswered"
    }
  }
}

/// The popover's verbs: the three that only change what you look at, and
/// the handoff. Approve and Reply are not cases (16.C).
public enum PopoverVerb: String, CaseIterable, Sendable {
  case done, snooze, mute, open

  public var title: String {
    switch self {
    case .done: "Done"
    case .snooze: "Snooze"
    case .mute: "Mute"
    case .open: "Open"
    }
  }

  /// The hint key, drawn dim beside the title.
  public var hint: String {
    switch self {
    case .done: "E"
    case .snooze: "H"
    case .mute: "M"
    case .open: "\u{21B5}"
    }
  }
}

/// One source's line in the degraded freshness table.
public struct SourceLine: Equatable, Sendable {
  public var channel: String
  public var live: Bool
  /// "4s ago", "6h 12m ago".
  public var age: String

  public init(channel: String, live: Bool, age: String) {
    self.channel = channel
    self.live = live
    self.age = age
  }

  public var printed: String { "\(channel.uppercased()) \(live ? "live" : "STALE") \u{00B7} \(age)" }
}

/// Everything the popover is drawn from.
public struct PopoverInput: Equatable, Sendable {
  public var snapshot: OSSnapshot
  /// "Tue 16:42:07": the moment the counter is as of.
  public var stamp: String
  public var entries: [PopoverEntry]
  public var sources: [SourceLine]
  /// "1m ago": the oldest live source's age, for the healthy line.
  public var oldestSync: String
  /// "16:42:19": when the kill switch went on.
  public var killedSince: String?

  public init(
    snapshot: OSSnapshot, stamp: String, entries: [PopoverEntry], sources: [SourceLine], oldestSync: String,
    killedSince: String? = nil
  ) {
    self.snapshot = snapshot
    self.stamp = stamp
    self.entries = entries
    self.sources = sources
    self.oldestSync = oldestSync
    self.killedSince = killedSince
  }
}

/// The popover as words. The view draws this and nothing else.
public struct PopoverContent: Equatable, Sendable {
  public enum Mode: Equatable, Sendable { case healthy, degraded, killed, disconnected }

  public struct Row: Equatable, Sendable {
    public var entry: PopoverEntry
    public var verbs: [PopoverVerb]
  }

  public var mode: Mode
  /// "9 left", or "Cannot say", or "Kill switch on".
  public var title: String
  public var stamp: String
  public var line: String
  /// At most four, and none under the kill switch or while degraded.
  public var rows: [Row]
  /// "5 more in the app.", or nil when everything is shown.
  public var more: String?
  /// The freshness table: only while degraded.
  public var sources: [SourceLine]
  /// The degraded warning and the reason no total is printed.
  public var notes: [String]
}

public enum PopoverRules {
  /// The list never scrolls: four rows, then a sentence (16.B legend 2).
  public static let maxRows = 4

  /// Drafts before messages, each oldest first, then the first four.
  public static func shown(_ entries: [PopoverEntry]) -> [PopoverEntry] {
    let sorted = entries.sorted { a, b in
      if a.kind != b.kind { return a.kind == .draft }
      if a.arrivedAt != b.arrivedAt { return a.arrivedAt < b.arrivedAt }
      return a.id < b.id
    }
    return Array(sorted.prefix(maxRows))
  }

  /// A row's verbs: Open only when its source is stale; no Mute on a
  /// Stream thread; never Approve, never Reply.
  public static func verbs(for entry: PopoverEntry) -> [PopoverVerb] {
    if entry.sourceStale { return [.open] }
    return entry.stream ? [.done, .snooze, .open] : [.done, .snooze, .mute, .open]
  }

  private static func plural(_ n: Int, _ one: String, _ many: String) -> String { "\(n) \(n == 1 ? one : many)" }

  public static func content(_ input: PopoverInput) -> PopoverContent {
    let s = input.snapshot
    let drafts = input.entries.filter { $0.kind == .draft }.count
    let messages = input.entries.count - drafts
    switch OSLayer.state(s) {
    case .killed:
      let since = input.killedSince.map { " since \($0)" } ?? ""
      return PopoverContent(
        mode: .killed, title: "Kill switch on", stamp: input.stamp, line: "Kill switch on\(since). Nothing can send.",
        rows: [], more: nil, sources: [],
        notes: ["\(input.entries.count) held. Reading continues on all four channels.", "Open WeMessage to release"])
    case .disconnected:
      return PopoverContent(
        mode: .disconnected, title: "Cannot say", stamp: input.stamp,
        line: "Not connected to the daemon. No count shown.", rows: [], more: nil, sources: [],
        notes: ["A count from a source we cannot reach would be a guess."])
    case .degraded:
      let live = input.sources.filter(\.live).count
      var notes: [String] = []
      if let stale = input.sources.first(where: { !$0.live }) {
        notes.append("\(stale.channel) has not synced in \(stale.age.replacingOccurrences(of: " ago", with: "")). You may be missing messages.")
      }
      notes.append("A total that quietly leaves a channel out is worse than no total.")
      return PopoverContent(
        mode: .degraded, title: "Cannot say", stamp: input.stamp,
        line: "\(live) of \(input.sources.count) sources synced. No count shown.", rows: [], more: nil,
        sources: input.sources, notes: notes)
    case .idle, .waiting:
      let total = s.count ?? input.entries.count
      let shown = shown(input.entries)
      let rest = total - shown.count
      let line =
        "\(plural(drafts, "draft", "drafts")) ready \u{00B7} \(messages) unanswered \u{00B7} \(plural(input.sources.count, "source", "sources")) synced, oldest \(input.oldestSync)"
      return PopoverContent(
        mode: .healthy, title: "\(total) left", stamp: input.stamp, line: line,
        rows: shown.map { PopoverContent.Row(entry: $0, verbs: verbs(for: $0)) },
        more: rest > 0 ? "\(rest) more in the app." : nil, sources: [], notes: [])
    }
  }
}

// MARK: The kill confirm (16.H)

public enum KillConfirmText {
  public static let title = "Engage kill switch"
  /// Four facts, in the drawn order: what stops, what is held, what keeps
  /// working, and what connected agents are told.
  public static func facts(held: Int) -> [(label: String, text: String)] {
    [
      ("Stops", "Every send, by anything, on all four channels."),
      ("Holds", "\(held) \(held == 1 ? "draft" : "drafts"). They are kept, not discarded."),
      ("Keeps", "Reading, search, and the queue."),
      ("Tells", "Connected agents get an explicit refusal, not a silent queue."),
    ]
  }
  public static let engage = "Engage"
  public static let cancel = "Cancel"
  public static let releaseNote = "Release is in the app"
}

// MARK: The handoff (16.C)

/// Where a popover click lands. The thread, never the inbox root; the lens
/// is unchanged; the list has focus, not the composer, unless the user
/// pressed R.
public struct Handoff: Equatable, Sendable {
  public enum Focus: Equatable, Sendable { case list, composer }

  public var url: String
  public var threadGuid: String
  public var channel: String
  public var focus: Focus
  /// Never changes the lens: the handoff does not enter Triage for you.
  public let changesLens = false

  public init(url: String, threadGuid: String, channel: String, focus: Focus) {
    self.url = url
    self.threadGuid = threadGuid
    self.channel = channel
    self.focus = focus
  }

  static let slugs = ["imessage": "im", "whatsapp": "wa", "linkedin": "li", "email": "em"]

  /// Reads wemessage://thread/<ch>/<id>?item=<itm> back; nil for anything
  /// else, so a link can only ever open a thread.
  public static func parse(_ url: String) -> Handoff? {
    guard let parts = URLComponents(string: url), parts.scheme == "wemessage", parts.host == "thread" else { return nil }
    let path = parts.percentEncodedPath.split(separator: "/").map(String.init)
    guard path.count == 2, let channel = slugs.first(where: { $0.value == path[0] })?.key,
      let thread = path[1].removingPercentEncoding, !thread.isEmpty
    else { return nil }
    return Handoff(url: url, threadGuid: thread, channel: channel, focus: .list)
  }

  public static func open(_ entry: PopoverEntry, reply: Bool = false) -> Handoff {
    let slug = slugs[entry.channel] ?? entry.channel
    var allowed = CharacterSet.urlPathAllowed
    allowed.remove("/")
    let thread = entry.threadGuid.addingPercentEncoding(withAllowedCharacters: allowed) ?? entry.threadGuid
    return Handoff(
      url: "wemessage://thread/\(slug)/\(thread)?item=\(entry.id)", threadGuid: entry.threadGuid,
      channel: entry.channel, focus: reply ? .composer : .list)
  }
}
