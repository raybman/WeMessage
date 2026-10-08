import Foundation
import Testing
@testable import WeMessageKit

/// S4m: the shareable card is a struct of four Ints and two Dates (wireframe
/// 17.E). No String, no Data, no image: a name can only reach the card by
/// widening this struct, which a diff shows and this test refuses.
@Suite("ShareCard")
struct ShareCardTests {
  static let card = ShareCard(
    streakDays: 11, longestRunDays: 23, clearedThisWeek: 63, daysAtZeroInMonth: 14,
    periodStart: Date(timeIntervalSince1970: 1_789_455_600), periodEnd: Date(timeIntervalSince1970: 1_789_974_000))

  @Test("the Mirror has exactly six children: four Int and two Date, and no String")
  func sixFields() {
    let children = Array(Mirror(reflecting: Self.card).children)
    #expect(children.count == 6, "\(children.map { $0.label ?? "?" })")
    let ints = children.filter { $0.value is Int }
    let dates = children.filter { $0.value is Date }
    #expect(ints.count == 4)
    #expect(dates.count == 2)
    #expect(children.allSatisfy { !($0.value is String) && !($0.value is Substring) && !($0.value is Data) })
    #expect(children.allSatisfy { $0.value is Int || $0.value is Date }, "a field that is neither Int nor Date")
    #expect(
      children.map { $0.label ?? "" }
        == ["streakDays", "longestRunDays", "clearedThisWeek", "daysAtZeroInMonth", "periodStart", "periodEnd"])
    // Non-vacuity: the same check sees a String field when there is one.
    struct Leaky { var streakDays = 1; var name = "Dana" }
    #expect(Array(Mirror(reflecting: Leaky()).children).contains { $0.value is String })
  }

  @Test("the zeroed card keeps its dates and sets every Int to 0")
  func zeroed() {
    let z = Self.card.zeroed()
    #expect(z.streakDays == 0 && z.longestRunDays == 0 && z.clearedThisWeek == 0 && z.daysAtZeroInMonth == 0)
    #expect(z.periodStart == Self.card.periodStart && z.periodEnd == Self.card.periodEnd)
    #expect(z != Self.card)
  }
}
