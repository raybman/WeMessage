import Foundation
import WeMessageKit

/// Board 01's numbers, folded from what the daemon said: one mark per rail
/// tile, the title counter, and the list the lens shows. Pure: the same
/// status, threads and drafts always give the same board, and nothing here
/// reads a clock.
///
/// The queue's clock is the data's own "as of" (the last scan, else the
/// thread list's asOf), never the wall clock: a daemon that stopped scanning
/// must not have its queue age out of the window while nobody can see it,
/// and the synthetic fixtures (dated 2026-09-01) stay inside the window on
/// any day the tests run.
public struct ShellBoard: Equatable, Sendable {
  /// What the title counter says for the selected scope (wireframe 06.C,
  /// 10.A, 17.G).
  public enum Counter: Equatable, Sendable {
    /// "N left as of hh:mm:ss".
    case left(Int, asOf: Date)
    /// "CLEAR hh:mm:ss".
    case clear(asOf: Date)
    /// "Cannot say", with the reason, and never a number.
    case cannotSay(staleSince: Date?)
    /// Not connected: no counter at all.
    case hidden
  }

  public var marks: [ShellModel.Scope: RailMark]
  /// The last scan, when the daemon has done one.
  public var lastScan: Date?
  /// The queue's clock: see `clock(status:threads:drafts:)`.
  public var asOf: Date?
  /// What is waiting, inside the window.
  public var queue: [QueueItem]

  public static let empty = ShellBoard(
    marks: Dictionary(uniqueKeysWithValues: ShellModel.Scope.allCases.map { ($0, RailMark.none) }), lastScan: nil,
    asOf: nil, queue: [])

  /// The channel each scope reads. ALL is the fold of the others.
  static func channel(of scope: ShellModel.Scope) -> Channel? { scope.channel }

  /// The fold. iMessage has a daemon today: it is connected unless status
  /// is missing or says "disconnected", and fresh only when the daemon is
  /// fully connected and has scanned at least once (a read-only daemon
  /// cannot vouch for what it has not read). Another channel draws a mark
  /// only when `channels` says it is connected or a fixture board (v2 B0,
  /// D-UI-140), on the same freshness; not connected says nothing. With no
  /// `channels` every other channel is not connected, as in this version.
  public static func fold(
    status: StatusPayload?, threads: ThreadsPage?, drafts: [DraftPayload], window: QueueWindow,
    excluding: Set<String> = [], channels: [Channel: ChannelAvailability] = [:]
  ) -> ShellBoard {
    let lastScan = status?.cursor.flatMap { WireDate.parse($0.lastScanAt) }
    let asOf = clock(status: status, threads: threads, drafts: drafts)
    let connected = status.map { $0.connectionState != "disconnected" } ?? false
    let fresh = connected && status?.connectionState == "fully-connected" && lastScan != nil
    let items = QueueRules.items(drafts: drafts, threads: threads?.threads ?? [], excluding: excluding)
    let queue = asOf.map { now in
      items.filter { QueueRules.queueCount(items: [$0], now: now, window: window) == 1 }
    } ?? []

    var marks: [ShellModel.Scope: RailMark] = [:]
    for scope in ShellModel.Scope.allCases {
      guard let channel = scope.channel else { continue }
      guard channel == .imessage || drawsMark(channels[channel]) else {
        marks[scope] = RailMark.none
        continue
      }
      let count = queue.filter { $0.channel == channel.rawValue }.count
      marks[scope] = QueueRules.railMark(count: count, fresh: fresh, connected: connected)
    }
    let channels = ShellModel.Scope.allCases.filter { $0 != .all }.map { marks[$0] ?? RailMark.none }
    marks[.all] = QueueRules.allMark(channels)
    return ShellBoard(marks: marks, lastScan: lastScan, asOf: asOf, queue: queue)
  }

  /// Whether a channel other than iMessage gets a rail mark: connected
  /// and a fixture board do (D-UI-140: the same mark, the board's chip
  /// carries the difference); not connected, or not named, does not.
  static func drawsMark(_ availability: ChannelAvailability?) -> Bool {
    switch ProvisionalUI.fixtureRailMark {
    case .connectedMark: availability?.drawsMark ?? false
    }
  }

  /// The queue's clock: the last scan, else the thread list's asOf, moved
  /// on to the newest pending draft the daemon served when that is later
  /// (D-UI-43: a draft the stream delivered after the last scan is still
  /// waiting, and the counter, the rail and Triage say one number). Never
  /// the wall clock; nil when the data carries no time at all.
  public static func clock(status: StatusPayload?, threads: ThreadsPage?, drafts: [DraftPayload]) -> Date? {
    let lastScan = status?.cursor.flatMap { WireDate.parse($0.lastScanAt) }
    guard let base = lastScan ?? threads.flatMap({ WireDate.parse($0.asOf) }) else { return nil }
    guard ProvisionalUI.queueClock == .laterOfScanAndNewestDraft else { return base }
    let newest = drafts.filter { $0.state == .pending }.compactMap { WireDate.parse($0.createdAt) }.max()
    return max(base, newest ?? base)
  }

  public func mark(_ scope: ShellModel.Scope) -> RailMark { marks[scope] ?? RailMark.none }

  /// The counter for `scope`: a digit's count, the clear time, "cannot say"
  /// for a stale mark (never a total), or nothing for a channel that is not
  /// connected.
  public func counter(_ scope: ShellModel.Scope) -> Counter {
    switch mark(scope) {
    case .digit(let n): asOf.map { .left(n, asOf: $0) } ?? .cannotSay(staleSince: lastScan)
    case .baseline: asOf.map { .clear(asOf: $0) } ?? .cannotSay(staleSince: lastScan)
    case .stale: .cannotSay(staleSince: lastScan)
    case .none: .hidden
    }
  }

  /// The Needs You count beside the lens: only a fresh digit, never a stale
  /// or clear one.
  public func needsYou(_ scope: ShellModel.Scope) -> Int? {
    if case .digit(let n) = mark(scope) { return n }
    return nil
  }

  /// The threads the list shows for a scope and a lens: the scope's channel
  /// (ALL is every channel), and under Needs You or Triage only the threads
  /// something is waiting on, in the daemon's order.
  /// `including` adds threads the queue no longer holds but Triage still
  /// draws (a snoozed thread, at 45%, 06.C).
  public func rows(
    _ threads: [ThreadSummary], scope: ShellModel.Scope, lens: ShellModel.Lens, including: Set<String> = []
  ) -> [ThreadSummary] {
    let scoped = threads.filter { thread in Self.channel(of: scope).map { $0.rawValue == thread.channel } ?? true }
    guard lens != .recent else { return scoped }
    let waiting = Set(queue.map(\.threadGuid)).union(lens == .triage ? including : [])
    return scoped.filter { waiting.contains($0.chatGuid) }
  }
}

/// Board 01's words and times. The counter's words are the wireframe's
/// (06.C, 10.A, 17.G), not provisional; the cannot-say reason is D-UI-23.
public enum ShellText {
  /// hh:mm:ss, 24 hour, in `zone`.
  public static func clock(_ date: Date, zone: TimeZone = .current) -> String {
    format(date, "HH:mm:ss", zone)
  }

  /// hh:mm, for the list's "as of".
  public static func shortClock(_ date: Date, zone: TimeZone = .current) -> String {
    format(date, "HH:mm", zone)
  }

  static func format(_ date: Date, _ pattern: String, _ zone: TimeZone) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = zone
    f.dateFormat = pattern
    return f.string(from: date)
  }

  /// The counter's sentence, as the accessibility value and (upper-cased)
  /// on screen; nil when the counter is hidden.
  public static func counter(_ counter: ShellBoard.Counter, channel: String, zone: TimeZone = .current) -> String? {
    switch counter {
    case .left(let n, let asOf): "\(n) left as of \(clock(asOf, zone: zone))"
    case .clear(let asOf): "Clear \(clock(asOf, zone: zone))"
    case .cannotSay(let since):
      "Cannot say, " + ProvisionalUI.cannotSayDetail(channel: channel, staleSince: since.map { clock($0, zone: zone) })
    case .hidden: nil
    }
  }

  /// A row's time, against the list's asOf (wireframe 01.B: "9:41", "Yest",
  /// "Fri"): the time on the same day, "Yest" the day before, the weekday
  /// within the week, else month/day.
  public static func rowTime(_ raw: String, asOf: Date?, zone: TimeZone = .current) -> String {
    guard let at = WireDate.parse(raw) else { return "" }
    guard let asOf else { return format(at, "H:mm", zone) }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = zone
    let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: at), to: calendar.startOfDay(for: asOf)).day ?? 0
    switch days {
    case ...0: return format(at, "H:mm", zone)
    case 1: return "Yest"
    case 2...6: return format(at, "EEE", zone)
    default: return format(at, "M/d", zone)
    }
  }

  /// Up to two initials from the words of a name; "" for a name with no
  /// letters (a bare number gets an empty disc, as the wireframe's thread
  /// header draws one).
  public static func initials(_ title: String) -> String {
    let words = title.split(whereSeparator: { $0 == " " || $0 == "-" }).filter { $0.first?.isLetter == true }
    return String(words.prefix(2).compactMap(\.first)).uppercased()
  }

  /// The list's preview line: "You: " before a line the user sent.
  public static func preview(_ thread: ThreadSummary) -> String? {
    guard let line = thread.lastLine, !line.isEmpty else { return nil }
    return thread.lastFromMe ? "You: " + line : line
  }
}
