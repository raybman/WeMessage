import Foundation

/// One meter row's state (wireframe 17.A): four states, one mark each,
/// mutually exclusive. A number means items are waiting; CLEAR (with the
/// 3 pt baseline) is earned zero on a fresh source; cannot tell is a stale
/// source and never a number; not connected is a dashed empty slot.
public enum MeterState: Equatable, Sendable {
  case count(Int)
  case clear
  case cannotTell
  case notConnected
}

/// One channel's meter (17.A): the remaining count, what arrived today and
/// what was cleared of it. The only denominator is today's arrivals, which
/// we wrote ourselves; there is no percentage, target, trend or comparison.
public struct MeterRow: Equatable, Sendable {
  public var channel: String
  public var remaining: Int
  public var arrivedToday: Int
  public var clearedToday: Int
  public var connected: Bool
  public var fresh: Bool

  public init(channel: String, remaining: Int, arrivedToday: Int, clearedToday: Int, connected: Bool, fresh: Bool) {
    self.channel = channel
    self.remaining = remaining
    self.arrivedToday = arrivedToday
    self.clearedToday = clearedToday
    self.connected = connected
    self.fresh = fresh
  }

  public var state: MeterState {
    guard connected else { return .notConnected }
    guard fresh else { return .cannotTell }
    return remaining > 0 ? .count(remaining) : .clear
  }

  /// The track's fill, 0 to 1: what was cleared of today's arrivals. CLEAR
  /// is drawn full; a stale or unconnected row has no fill at all.
  public var fill: Double? {
    switch state {
    case .notConnected, .cannotTell: return nil
    case .clear: return 1
    case .count:
      guard arrivedToday > 0 else { return 0 }
      return min(1, Double(clearedToday) / Double(arrivedToday))
    }
  }
}

/// A day on the streak ribbon (17.C). Cleared extends the run; left unclear
/// is the only day that breaks it; the other three are skipped and neither
/// extend nor break it.
public enum Day: Equatable, Sendable, CaseIterable {
  case cleared
  case nothingArrived
  case notOpened
  case leftUnclear
  /// A source was stale all day, so the global meter could not be CLEAR;
  /// the user is not charged for our sync failure (17.C, D-UI-124).
  case degraded

  public var breaks: Bool { self == .leftUnclear }
  public var skipped: Bool { self == .nothingArrived || self == .notOpened || self == .degraded }
}

/// The run (17.C): the current one, the longest (which never resets), and
/// where the most recent break was, with the run it ended.
public struct Streak: Equatable, Sendable {
  public var current: Int
  public var longest: Int
  public var days: [Day]
  /// The index into `days` of the most recent day that broke a run.
  public var lastBreak: Int?
  /// The length of the run that the most recent break ended.
  public var runBeforeBreak: Int?
}

/// One thing that entered the queue, and the act that closed it, if any.
public struct ItemSpan: Equatable, Sendable {
  public enum Act: Equatable, Sendable, CaseIterable {
    case replied, approved, done, muted, snoozed

    /// Snooze is a deferral, not a terminal state (06.A), so a snoozed item
    /// is still open at the boundary (17.C legend 7).
    public var clears: Bool { self != .snoozed }
  }

  public var arrivedAt: Date
  public var act: Act?
  public var actAt: Date?

  public init(arrivedAt: Date, act: Act?, actAt: Date?) {
    self.arrivedAt = arrivedAt
    self.act = act
    self.actAt = actAt
  }

  /// When a clearing act closed it, else nil.
  public var clearedAt: Date? {
    guard let act, act.clears else { return nil }
    return actAt
  }

  /// In the queue at `t`: arrived by then and not yet cleared.
  public func isOpen(at t: Date) -> Bool {
    guard arrivedAt <= t else { return false }
    guard let cleared = clearedAt else { return true }
    return cleared > t
  }
}

/// What the streak is computed from: the queue's items, the moments the
/// main window was frontmost or Triage was entered (17.C "Opened is
/// fuzzy"), and the spans a connected source was stale.
public struct ProgressHistory: Equatable, Sendable {
  public var items: [ItemSpan]
  public var opens: [Date]
  public var stale: [DateInterval]

  public init(items: [ItemSpan], opens: [Date], stale: [DateInterval] = []) {
    self.items = items
    self.opens = opens
    self.stale = stale
  }
}

/// Which zero screen to draw (17.H).
public enum ZeroKind: Equatable, Sendable {
  /// The moment the last item cleared: the numeral and the receipt.
  case earned
  /// The same day, later: a status report, the praise already spent.
  case stillClear(since: Date?)
  /// Nothing arrived today: no receipt, and a Verify button.
  case nothingArrived
}

/// Board 17's arithmetic. Pure: nothing here reads a clock or a time zone
/// the caller did not pass.
public enum ProgressRules {
  /// The hour the day turns over (17.C): 04:00, not midnight, so a clear at
  /// 00:30 counts for the day it finished.
  public static let boundaryHour = 4

  /// The global meter (17.B): CLEAR if and only if every connected channel
  /// is clear and fresh. A stale connected channel makes it "cannot tell";
  /// otherwise the remaining count over the union of the queues. Channels
  /// that are not connected leave the conjunction. Never an average.
  public static func globalMeter(rows: [MeterRow]) -> MeterState {
    globalRow(rows: rows).state
  }

  /// The global row: the union of the connected rows' queues, fresh only if
  /// every connected row is fresh.
  public static func globalRow(rows: [MeterRow]) -> MeterRow {
    let live = rows.filter(\.connected)
    return MeterRow(
      channel: "all", remaining: live.reduce(0) { $0 + $1.remaining },
      arrivedToday: live.reduce(0) { $0 + $1.arrivedToday }, clearedToday: live.reduce(0) { $0 + $1.clearedToday },
      connected: !live.isEmpty, fresh: live.allSatisfy(\.fresh))
  }

  /// "4 of 4 sources": how many rows take part in the conjunction.
  public static func connectedCount(rows: [MeterRow]) -> Int {
    rows.filter(\.connected).count
  }

  /// The 04:00 at or before `date`, local to `tz`.
  public static func dayBoundary(_ date: Date, tz: TimeZone) -> Date {
    let cal = calendar(tz)
    let midnight = cal.startOfDay(for: date)
    let four = cal.date(bySettingHour: boundaryHour, minute: 0, second: 0, of: midnight) ?? midnight
    if date >= four { return four }
    let yesterday = cal.date(byAdding: .day, value: -1, to: midnight) ?? midnight
    return cal.date(bySettingHour: boundaryHour, minute: 0, second: 0, of: yesterday) ?? yesterday
  }

  /// The next 04:00 after the boundary `start` (23, 24 or 25 hours later).
  public static func nextBoundary(after start: Date, tz: TimeZone) -> Date {
    let cal = calendar(tz)
    let next = cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: start)) ?? start
    return cal.date(bySettingHour: boundaryHour, minute: 0, second: 0, of: next) ?? next
  }

  /// One day, from the boundary `start` to the next (17.C). Degraded if a
  /// source was stale across the whole day; nothing arrived if nothing was
  /// open at the start and nothing arrived during it; cleared if a clearing
  /// act left nothing open while every source was fresh; otherwise left
  /// unclear if the app was opened, and not opened if it was not.
  public static func day(start: Date, history: ProgressHistory, tz: TimeZone) -> Day {
    let end = nextBoundary(after: start, tz: tz)
    if history.stale.contains(where: { $0.start <= start && $0.end >= end }) { return .degraded }
    let work = history.items.filter { $0.isOpen(at: start) || ($0.arrivedAt >= start && $0.arrivedAt < end) }
    if work.isEmpty { return .nothingArrived }
    let clears = history.items.compactMap(\.clearedAt).filter { $0 >= start && $0 < end }
    let reached = clears.contains { t in
      !history.items.contains { $0.isOpen(at: t) } && !history.stale.contains { $0.contains(t) }
    }
    if reached { return .cleared }
    return history.opens.contains { $0 >= start && $0 < end } ? .leftUnclear : .notOpened
  }

  /// Every whole day from the boundary at or before `from` up to (not
  /// including) the day that contains `through`, oldest first.
  public static func days(from: Date, through: Date, history: ProgressHistory, tz: TimeZone) -> [Day] {
    var out: [Day] = []
    var start = dayBoundary(from, tz: tz)
    let last = dayBoundary(through, tz: tz)
    while start < last {
      out.append(day(start: start, history: history, tz: tz))
      start = nextBoundary(after: start, tz: tz)
    }
    return out
  }

  /// The run over `days`, oldest first. `longestBefore` is the longest run
  /// in history older than `days`; the longest never falls below it.
  public static func streak(days: [Day], longestBefore: Int = 0) -> Streak {
    var run = 0
    var longest = longestBefore
    var lastBreak: Int?
    var runBeforeBreak: Int?
    for (i, d) in days.enumerated() {
      switch d {
      case .cleared:
        run += 1
        longest = max(longest, run)
      case .leftUnclear:
        lastBreak = i
        runBeforeBreak = run
        run = 0
      case .nothingArrived, .notOpened, .degraded:
        break
      }
    }
    return Streak(current: run, longest: longest, days: days, lastBreak: lastBreak, runBeforeBreak: runBeforeBreak)
  }

  /// Days at zero (17.D): days that reached CLEAR, out of the days that
  /// had anything to clear. A count, not a run, so a break cannot lose it.
  public static func daysAtZero(days: [Day]) -> (atZero: Int, hadWork: Int) {
    (days.filter { $0 == .cleared }.count, days.filter { $0 == .cleared || $0 == .leftUnclear || $0 == .notOpened }.count)
  }

  /// "How long things waited" (17.D): the median arrival-to-cleared time
  /// of the items that were cleared. Survivorship is the caller's caveat.
  public static func median(_ values: [TimeInterval]) -> TimeInterval? {
    guard !values.isEmpty else { return nil }
    let sorted = values.sorted()
    let mid = sorted.count / 2
    return sorted.count % 2 == 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  }

  /// Which zero screen (17.H). Nothing arrived and nothing cleared is its
  /// own state; a clear inside `praiseFor` seconds is earned; anything
  /// later the same day is still clear, the praise already spent.
  public static func zeroKind(
    arrivedToday: Int, clearedToday: Int, lastClearAt: Date?, now: Date, praiseFor: TimeInterval
  ) -> ZeroKind {
    if arrivedToday == 0 && clearedToday == 0 { return .nothingArrived }
    if clearedToday > 0, let last = lastClearAt, now.timeIntervalSince(last) < praiseFor { return .earned }
    return .stillClear(since: lastClearAt)
  }

  /// The card (17.E): the streak's two numbers and two counts, dated.
  public static func card(
    streak: Streak, clearedThisWeek: Int, daysAtZeroInMonth: Int, periodStart: Date, periodEnd: Date
  ) -> ShareCard {
    ShareCard(
      streakDays: streak.current, longestRunDays: streak.longest, clearedThisWeek: clearedThisWeek,
      daysAtZeroInMonth: daysAtZeroInMonth, periodStart: periodStart, periodEnd: periodEnd)
  }

  private static func calendar(_ tz: TimeZone) -> Calendar {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = tz
    return cal
  }
}
