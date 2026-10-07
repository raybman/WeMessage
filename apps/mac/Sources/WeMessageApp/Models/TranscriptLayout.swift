import Foundation
import WeMessageKit

/// Board 02's transcript geometry, pure (wireframe .msgs, .row, .bub,
/// .daysep): day separators between calendar days, 4 pt between two turns
/// from the same side and 8 pt where the side changes, the 17 pt bubble
/// radius squared to 5 on the tail corner of a turn that continues a run,
/// the time stamp beside the first turn of a run, and in a group the sender's
/// name above an inbound run.
enum TranscriptLayout {
  /// The gap above a turn from the same sender as the one before it.
  static let sameSenderGap: Double = 4
  /// The gap above a turn whose sender differs from the one before it.
  static let senderChangeGap: Double = 8
  /// The bubble radius (wireframe --bubble).
  static let radius: Double = 17
  /// The tail corner of a turn that continues a run (wireframe .bub.mid).
  static let tailRadius: Double = 5
  /// The transcript's padding (wireframe .msgs: 16 pt top and bottom, 12 pt
  /// at the sides).
  static let verticalPadding: Double = 16
  static let horizontalPadding: Double = 12
  /// One "ch" of the 13 pt body face, for min(64%, 56ch).
  static let characterWidth: Double = 7.5

  /// A bubble's four corner radii, in reading order.
  struct Corners: Equatable {
    let topLeading, topTrailing, bottomLeading, bottomTrailing: Double
  }

  /// One turn as the transcript places it.
  struct Bubble: Equatable {
    let turn: MessageTurn
    /// The space above the row (0 under a day separator).
    let gap: Double
    /// The turn before it is from the same sender, on the same day.
    let continuesRun: Bool
    /// A group's inbound run names its sender on its first turn.
    let senderName: String?
    /// The first turn of a run carries the time stamp beside it.
    let showsTime: Bool

    var corners: Corners { TranscriptLayout.corners(turn.direction, continuesRun: continuesRun) }
  }

  enum Row: Equatable, Identifiable {
    /// A day separator: its id is the day as yyyy-mm-dd.
    case day(id: String, label: String)
    case bubble(Bubble)

    var id: String {
      switch self {
      case .day(let id, _): "day." + id
      case .bubble(let bubble): "bubble." + bubble.turn.guid
      }
    }
  }

  /// The widest a bubble may be in a pane `paneWidth` wide:
  /// min(64% of the row, 56ch).
  static func maxBubbleWidth(paneWidth: Double) -> Double {
    let row = max(0, paneWidth - 2 * horizontalPadding)
    return min(0.64 * row, 56 * characterWidth)
  }

  /// The squared corner is the tail's: bottom trailing on an outbound turn,
  /// bottom leading on an inbound one.
  static func corners(_ direction: MessageTurn.Direction, continuesRun: Bool) -> Corners {
    let tail = continuesRun ? tailRadius : radius
    switch direction {
    case .outbound:
      return Corners(topLeading: radius, topTrailing: radius, bottomLeading: radius, bottomTrailing: tail)
    case .inbound:
      return Corners(topLeading: radius, topTrailing: radius, bottomLeading: tail, bottomTrailing: radius)
    }
  }

  /// "yyyy-mm-dd" in `calendar`'s zone.
  static func dayID(_ date: Date, calendar: Calendar) -> String {
    let c = calendar.dateComponents([.year, .month, .day], from: date)
    return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
  }

  /// D-UI-31: Today and Yesterday measured from the page's as-of; older
  /// days by weekday, month and day.
  static func dayLabel(_ date: Date, asOf: Date, calendar: Calendar) -> String {
    let days =
      calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: asOf)).day ?? 0
    if ProvisionalUI.dayLabels == .relativeToAsOf {
      if days == 0 { return "Today" }
      if days == 1 { return "Yesterday" }
    }
    let formatter = DateFormatter()
    formatter.calendar = calendar
    formatter.timeZone = calendar.timeZone
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "EEE, MMM d"
    return formatter.string(from: date)
  }

  /// The rows for `turns` (oldest first): a separator at each new day, then
  /// the day's turns with their gaps, runs and names. `senderName` resolves
  /// a group sender's handle (D-UI-35).
  static func rows(
    _ turns: [MessageTurn], asOf: Date, calendar: Calendar, isGroup: Bool, senderName: (String) -> String? = { _ in nil }
  ) -> [Row] {
    var rows: [Row] = []
    var previous: MessageTurn?
    var previousDay: String?
    for turn in turns {
      let day = dayID(turn.sentAt, calendar: calendar)
      let newDay = day != previousDay
      if newDay {
        rows.append(.day(id: day, label: dayLabel(turn.sentAt, asOf: asOf, calendar: calendar)))
        previousDay = day
      }
      let continues = !newDay && previous.map { sameSender($0, turn) } ?? false
      let gap: Double = newDay ? 0 : (continues ? sameSenderGap : senderChangeGap)
      var name: String? = nil
      if isGroup, turn.direction == .inbound, !continues, let handle = turn.handle {
        name = senderName(handle) ?? handle
      }
      rows.append(.bubble(Bubble(turn: turn, gap: gap, continuesRun: continues, senderName: name, showsTime: !continues)))
      previous = turn
    }
    return rows
  }

  /// Two turns are one sender's: both outbound, or both inbound from the same
  /// handle (in a one-to-one chat every inbound turn shares one).
  static func sameSender(_ a: MessageTurn, _ b: MessageTurn) -> Bool {
    guard a.direction == b.direction else { return false }
    return a.direction == .outbound || a.handle == b.handle
  }
}
