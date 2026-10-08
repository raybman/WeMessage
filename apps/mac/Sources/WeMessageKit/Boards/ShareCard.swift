import Foundation

/// The shareable card (wireframe 17.E): the ONLY input to the renderer.
/// Four integers and two dates. No String, no Data, no image: every word on
/// the card is a literal in the renderer, so there is no code path from a
/// message body, a name or a number to a pixel. Widening this struct is the
/// only way to put anything else on the card, and ShareCardTests refuses it.
public struct ShareCard: Equatable, Sendable {
  public var streakDays: Int
  public var longestRunDays: Int
  public var clearedThisWeek: Int
  public var daysAtZeroInMonth: Int
  public var periodStart: Date
  public var periodEnd: Date

  public init(
    streakDays: Int, longestRunDays: Int, clearedThisWeek: Int, daysAtZeroInMonth: Int, periodStart: Date,
    periodEnd: Date
  ) {
    self.streakDays = streakDays
    self.longestRunDays = longestRunDays
    self.clearedThisWeek = clearedThisWeek
    self.daysAtZeroInMonth = daysAtZeroInMonth
    self.periodStart = periodStart
    self.periodEnd = periodEnd
  }

  /// The same card with every Int at 0 and the dates kept: the reference
  /// render that testShareCardHasNoText compares against, so the two images
  /// may differ only inside the numeral boxes.
  public func zeroed() -> ShareCard {
    ShareCard(
      streakDays: 0, longestRunDays: 0, clearedThisWeek: 0, daysAtZeroInMonth: 0, periodStart: periodStart,
      periodEnd: periodEnd)
  }
}
