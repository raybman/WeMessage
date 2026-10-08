import Foundation
import Testing
@testable import WeMessageKit

/// S4m: board 17's arithmetic (plan 3.1, wireframe 17.A, 17.B, 17.C, 17.H).
/// A meter is a remaining count and a fill over today's arrivals; the
/// global meter is a conjunction, never an average; a day runs 04:00 to
/// 04:00 local; a day counts if the global meter reached CLEAR by a clearing
/// act; a day you did not open, a day with nothing to clear and a degraded
/// day are skipped; only a day you opened and left unclear breaks the run;
/// and Snooze is never a clear.
@Suite("ProgressRules")
struct ProgressRulesTests {
  static let tz = TimeZone(identifier: "America/Los_Angeles")!
  static let hour: TimeInterval = 3_600

  /// 2026-09-14 at hh:mm local, in the fixed zone.
  static func at(_ day: Int, _ h: Int, _ m: Int = 0) -> Date {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = tz
    return cal.date(from: DateComponents(year: 2026, month: 9, day: day, hour: h, minute: m))!
  }

  static func row(_ remaining: Int, arrived: Int = 3, cleared: Int = 1, connected: Bool = true, fresh: Bool = true)
    -> MeterRow
  {
    MeterRow(
      channel: "imessage", remaining: remaining, arrivedToday: arrived, clearedToday: cleared, connected: connected,
      fresh: fresh)
  }

  // MARK: meters

  @Test("a row has exactly one of four states: a count, CLEAR, cannot tell, not connected")
  func rowStates() {
    #expect(Self.row(2).state == .count(2))
    #expect(Self.row(0, arrived: 2, cleared: 2).state == .clear)
    #expect(Self.row(4, fresh: false).state == .cannotTell)
    #expect(Self.row(0, fresh: false).state == .cannotTell, "a stale source rendered as zero")
    #expect(Self.row(0, connected: false).state == .notConnected)
    #expect(Self.row(3, connected: false, fresh: false).state == .notConnected)
  }

  @Test("the fill is cleared over today's arrivals; full at CLEAR; no fill when stale or not connected")
  func fill() {
    #expect(Self.row(9, arrived: 14, cleared: 5).fill == 5.0 / 14.0)
    #expect(Self.row(0, arrived: 2, cleared: 2).fill == 1)
    #expect(Self.row(0, arrived: 0, cleared: 0).fill == 1, "CLEAR is drawn full")
    #expect(Self.row(3, arrived: 0, cleared: 0).fill == 0, "nothing arrived today, nothing cleared, three carried in")
    #expect(Self.row(4, fresh: false).fill == nil)
    #expect(Self.row(4, connected: false).fill == nil)
  }

  @Test("the global meter is a conjunction: CLEAR only if every connected channel is clear and fresh")
  func conjunction() {
    let clear = Self.row(0, arrived: 2, cleared: 2)
    // Three clear and one with 4 left is 4 left, never 75 percent.
    #expect(ProgressRules.globalMeter(rows: [clear, clear, clear, Self.row(4)]) == .count(4))
    #expect(ProgressRules.globalMeter(rows: [Self.row(2), Self.row(3), Self.row(4), clear]) == .count(9))
    #expect(ProgressRules.globalMeter(rows: [clear, clear, clear, clear]) == .clear)
    // One stale channel: the global row cannot be clear and cannot be a count.
    #expect(ProgressRules.globalMeter(rows: [clear, clear, clear, Self.row(0, fresh: false)]) == .cannotTell)
    #expect(ProgressRules.globalMeter(rows: [Self.row(2), Self.row(0, fresh: false)]) == .cannotTell)
    // Not connected leaves the conjunction entirely.
    #expect(ProgressRules.globalMeter(rows: [clear, clear, clear, Self.row(3, connected: false)]) == .clear)
    #expect(ProgressRules.globalMeter(rows: [Self.row(0, connected: false)]) == .notConnected)
    #expect(ProgressRules.globalMeter(rows: []) == .notConnected)
  }

  @Test("the global row is the union of the connected queues, not an average")
  func globalRow() {
    let rows = [
      Self.row(2, arrived: 3, cleared: 1), Self.row(3, arrived: 4, cleared: 1), Self.row(4, arrived: 5, cleared: 1),
      Self.row(0, arrived: 2, cleared: 2), Self.row(7, arrived: 9, cleared: 0, connected: false),
    ]
    let all = ProgressRules.globalRow(rows: rows)
    #expect(all.remaining == 9)
    #expect(all.arrivedToday == 14)
    #expect(all.clearedToday == 5)
    #expect(all.state == .count(9))
    #expect(ProgressRules.connectedCount(rows: rows) == 4)
  }

  // MARK: the day

  @Test("the day runs 04:00 to 04:00 local: 03:59 is yesterday, 04:00 is today, 00:30 is yesterday")
  func boundary() {
    #expect(ProgressRules.dayBoundary(Self.at(14, 4), tz: Self.tz) == Self.at(14, 4))
    #expect(ProgressRules.dayBoundary(Self.at(14, 3, 59), tz: Self.tz) == Self.at(13, 4))
    #expect(ProgressRules.dayBoundary(Self.at(15, 0, 30), tz: Self.tz) == Self.at(14, 4))
    #expect(ProgressRules.dayBoundary(Self.at(14, 23, 59), tz: Self.tz) == Self.at(14, 4))
    #expect(ProgressRules.nextBoundary(after: Self.at(14, 4), tz: Self.tz) == Self.at(15, 4))
    // Across a daylight saving change the day is 25 hours long, still 04:00 to 04:00.
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = Self.tz
    let fallBack = cal.date(from: DateComponents(year: 2026, month: 10, day: 31, hour: 4))!
    let next = ProgressRules.nextBoundary(after: fallBack, tz: Self.tz)
    #expect(next.timeIntervalSince(fallBack) == 25 * Self.hour)
    #expect(cal.component(.hour, from: next) == 4)
  }

  @Test("a clear at 00:30 counts for the day that began at 04:00 the day before")
  func lateClear() {
    let history = ProgressHistory(
      items: [ItemSpan(arrivedAt: Self.at(14, 18), act: .replied, actAt: Self.at(15, 0, 30))],
      opens: [Self.at(15, 0, 20)])
    #expect(ProgressRules.day(start: Self.at(14, 4), history: history, tz: Self.tz) == .cleared)
    #expect(ProgressRules.day(start: Self.at(15, 4), history: history, tz: Self.tz) == .nothingArrived)
  }

  @Test("a day counts only when a clearing act leaves nothing open; reaching zero by having nothing is not a win")
  func earnedOnly() {
    let start = Self.at(14, 4)
    let cleared = ProgressHistory(
      items: [
        ItemSpan(arrivedAt: Self.at(14, 9), act: .done, actAt: Self.at(14, 10)),
        ItemSpan(arrivedAt: Self.at(14, 11), act: .muted, actAt: Self.at(14, 12)),
      ], opens: [Self.at(14, 9, 30)])
    #expect(ProgressRules.day(start: start, history: cleared, tz: Self.tz) == .cleared)
    let empty = ProgressHistory(items: [], opens: [Self.at(14, 9)])
    #expect(ProgressRules.day(start: start, history: empty, tz: Self.tz) == .nothingArrived)
    // Cleared one of two: opened and left unclear.
    let half = ProgressHistory(
      items: [
        ItemSpan(arrivedAt: Self.at(14, 9), act: .done, actAt: Self.at(14, 10)),
        ItemSpan(arrivedAt: Self.at(14, 9, 5), act: nil, actAt: nil),
      ], opens: [Self.at(14, 9, 30)])
    #expect(ProgressRules.day(start: start, history: half, tz: Self.tz) == .leftUnclear)
    // An item carried in from yesterday is work today.
    let carried = ProgressHistory(
      items: [ItemSpan(arrivedAt: Self.at(13, 20), act: .replied, actAt: Self.at(14, 8))], opens: [Self.at(14, 8)])
    #expect(ProgressRules.day(start: start, history: carried, tz: Self.tz) == .cleared)
  }

  @Test("a snoozed item keeps the day open: Snooze is a deferral, never a clear")
  func snoozeKeepsOpen() {
    let start = Self.at(14, 4)
    let history = ProgressHistory(
      items: [
        ItemSpan(arrivedAt: Self.at(14, 9), act: .replied, actAt: Self.at(14, 10)),
        ItemSpan(arrivedAt: Self.at(14, 9, 10), act: .snoozed, actAt: Self.at(14, 10, 5)),
      ], opens: [Self.at(14, 9, 30)])
    #expect(ProgressRules.day(start: start, history: history, tz: Self.tz) == .leftUnclear)
    #expect(ItemSpan.Act.snoozed.clears == false)
    #expect(ItemSpan.Act.allCases.filter(\.clears) == [.replied, .approved, .done, .muted])
  }

  @Test("a day you never opened is skipped, whatever was waiting")
  func notOpened() {
    let history = ProgressHistory(
      items: [ItemSpan(arrivedAt: Self.at(14, 9), act: nil, actAt: nil)], opens: [Self.at(13, 9)])
    #expect(ProgressRules.day(start: Self.at(14, 4), history: history, tz: Self.tz) == .notOpened)
  }

  @Test("a degraded day is skipped: a source stale all day cannot be charged to the user")
  func degradedSkipped() {
    let start = Self.at(14, 4)
    let stale = DateInterval(start: Self.at(14, 2), end: Self.at(15, 5))
    let history = ProgressHistory(
      items: [ItemSpan(arrivedAt: Self.at(14, 9), act: nil, actAt: nil)], opens: [Self.at(14, 10)], stale: [stale])
    #expect(ProgressRules.day(start: start, history: history, tz: Self.tz) == .degraded)
    // A clear while a source is stale is not CLEAR either (17.B).
    let partial = DateInterval(start: Self.at(14, 9), end: Self.at(14, 11))
    let during = ProgressHistory(
      items: [ItemSpan(arrivedAt: Self.at(14, 9), act: .done, actAt: Self.at(14, 10))], opens: [Self.at(14, 10)],
      stale: [partial])
    #expect(ProgressRules.day(start: start, history: during, tz: Self.tz) == .leftUnclear)
    #expect(Day.degraded.skipped && !Day.degraded.breaks)
  }

  // MARK: the streak

  @Test("skipped days neither extend nor break the run; only opened and left unclear breaks it")
  func skippedDays() {
    let days: [Day] = [.cleared, .cleared, .notOpened, .notOpened, .nothingArrived, .degraded, .cleared]
    let s = ProgressRules.streak(days: days)
    #expect(s.current == 3)
    #expect(s.longest == 3)
    let broken = ProgressRules.streak(days: [.cleared, .cleared, .cleared, .leftUnclear, .cleared])
    #expect(broken.current == 1)
    #expect(broken.longest == 3)
    #expect(broken.lastBreak == 3)
    #expect(broken.runBeforeBreak == 3)
    #expect(ProgressRules.streak(days: []).current == 0)
  }

  @Test("the longest run never resets and is never less than the current run")
  func longestMonotonic() {
    let s = ProgressRules.streak(days: [.cleared, .leftUnclear, .cleared, .cleared], longestBefore: 23)
    #expect(s.current == 2)
    #expect(s.longest == 23)
    let t = ProgressRules.streak(days: Array(repeating: .cleared, count: 30), longestBefore: 23)
    #expect(t.longest == 30)
  }

  @Test("days at zero counts only days that had work, and a count cannot be lost to a break")
  func daysAtZero() {
    let days: [Day] = [.cleared, .nothingArrived, .leftUnclear, .cleared, .notOpened, .degraded]
    let z = ProgressRules.daysAtZero(days: days)
    #expect(z.atZero == 2)
    #expect(z.hadWork == 4)
  }

  @Test("how long things waited is the median of the cleared items only")
  func median() {
    #expect(ProgressRules.median([]) == nil)
    #expect(ProgressRules.median([5]) == 5)
    #expect(ProgressRules.median([9, 1, 5]) == 5)
    #expect(ProgressRules.median([1, 2, 3, 10]) == 2.5)
  }

  // MARK: the zero screen

  @Test("the zero screen: earned once, then still clear, and nothing arrived is its own state")
  func zeroKinds() {
    let now = Self.at(14, 18, 7)
    #expect(
      ProgressRules.zeroKind(arrivedToday: 14, clearedToday: 14, lastClearAt: now - 3, now: now, praiseFor: 600)
        == .earned)
    #expect(
      ProgressRules.zeroKind(
        arrivedToday: 14, clearedToday: 14, lastClearAt: Self.at(14, 18, 7), now: Self.at(14, 21, 14), praiseFor: 600)
        == .stillClear(since: Self.at(14, 18, 7)))
    #expect(
      ProgressRules.zeroKind(arrivedToday: 0, clearedToday: 0, lastClearAt: nil, now: now, praiseFor: 600)
        == .nothingArrived)
    // Arrived and cleared elsewhere, no act here: a status report, not praise.
    #expect(
      ProgressRules.zeroKind(arrivedToday: 2, clearedToday: 0, lastClearAt: nil, now: now, praiseFor: 600)
        == .stillClear(since: nil))
  }

  @Test("the card is built from the streak and two counts, and nothing else")
  func card() {
    let streak = ProgressRules.streak(days: Array(repeating: .cleared, count: 11), longestBefore: 23)
    let card = ProgressRules.card(
      streak: streak, clearedThisWeek: 63, daysAtZeroInMonth: 14, periodStart: Self.at(15, 4),
      periodEnd: Self.at(21, 4))
    #expect(card.streakDays == 11)
    #expect(card.longestRunDays == 23)
    #expect(card.clearedThisWeek == 63)
    #expect(card.daysAtZeroInMonth == 14)
    #expect(card.zeroed().streakDays == 0 && card.zeroed().periodStart == card.periodStart)
  }
}
