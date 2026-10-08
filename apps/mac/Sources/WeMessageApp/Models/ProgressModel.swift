import Foundation
import WeMessageKit

/// One meter row as board 17 draws it (17.A): the channel, the Kit row
/// that decides its mark and fill, and the evidence line under it. The
/// evidence ends with the freshness ("Live, 4s ago.") in bold.
struct MeterLine: Equatable, Sendable {
  let scope: ShellModel.Scope
  let row: MeterRow
  let evidence: String
  let live: String
  let note: String
}

/// A panel of meters (17.A, 17.B): the channel rows and the global row,
/// which is computed from them by ProgressRules and never averaged.
struct MeterPanel: Equatable, Sendable {
  let caption: String
  let lines: [MeterLine]
  let globalEvidence: String
  let globalSynced: String
  let globalNote: String

  var global: MeterRow { ProgressRules.globalRow(rows: lines.map(\.row)) }
  var connected: Int { ProgressRules.connectedCount(rows: lines.map(\.row)) }
}

/// The ribbon and its words (17.C). The run is computed from `history`
/// (older days the ribbon does not draw) followed by `days` (the drawn
/// ones), so the headline can never be typed by hand (D-UI-125).
struct StreakPanel: Equatable, Sendable {
  let caption: String
  /// The day of the month each drawn cell is labelled with.
  let labels: [Int]
  let days: [Day]
  let history: [Day]
  let longestBefore: Int
  let currentSince: String
  let longestSpan: String
  let evidence: [String]

  var streak: Streak { ProgressRules.streak(days: history + days, longestBefore: longestBefore) }
  /// True when the drawn days hold a break.
  var broken: Bool { days.contains(.leftUnclear) }
}

/// The five tiles (17.D), in the board's order: the unwelcome one first.
enum StatKey: String, CaseIterable, Sendable {
  case longestWaiting, cleared, draftSplit, waited, daysAtZero
}

/// One tile's words. The caveat is a stored field with no default, so a
/// tile cannot be built without one (H-S4-13).
struct StatItem: Equatable, Sendable {
  let key: StatKey
  let label: String
  let value: String
  let caveat: String
  let emphasized: Bool
}

/// One zero screen's words (17.H): which zero, the heading, the lines
/// above the rule, the receipt (earned only), the lines under the rule,
/// the streak line (earned only, at the freshness line's size), and
/// whether Verify is offered (the quiet zero only, D-UI-128).
struct ZeroContent: Equatable, Sendable {
  let kind: ZeroKind
  let heading: String
  let lines: [String]
  let receipt: String?
  let footer: [String]
  let streakLine: String?

  var verifies: Bool { kind == .nothingArrived || ProvisionalUI.verifyOnEarnedZero }
}

/// The words the zero screens share, live and on board 17.
enum ZeroWords {
  static let quietLine = "No receipt, because there was no work. This does not extend your streak and it does not break it."
  static let wrongLine = "If that is wrong, something is broken rather than quiet."

  /// The accessibility value of the kind element.
  static func kindWord(_ kind: ZeroKind) -> String {
    switch kind {
    case .earned: "earned"
    case .stillClear: "still clear"
    case .nothingArrived: "nothing arrived"
    }
  }

  /// "You cleared it", "Still clear since 18:07", "Nothing arrived today".
  static func heading(_ kind: ZeroKind) -> String {
    switch kind {
    case .earned: "You cleared it"
    case .stillClear(let since): since.map { "Still clear since " + ShellText.shortClock($0) } ?? "Still clear"
    case .nothingArrived: "Nothing arrived today"
    }
  }

  /// "Nothing has arrived in 3 hours 7 minutes."
  static func quietFor(_ seconds: TimeInterval) -> String {
    let minutes = max(0, Int(seconds) / 60)
    let (hours, rest) = minutes.quotientAndRemainder(dividingBy: 60)
    let h = hours == 1 ? "1 hour" : "\(hours) hours"
    let m = rest == 1 ? "1 minute" : "\(rest) minutes"
    if hours == 0 { return "Nothing has arrived in \(m)." }
    return "Nothing has arrived in \(h) \(m)."
  }
}

/// Everything board 17 draws, built by the fixture in this version
/// (D-UI-121).
struct ProgressContent: Sendable {
  let notZero: MeterPanel
  let atZero: MeterPanel
  let degraded: MeterPanel
  let intact: StreakPanel
  let broken: StreakPanel
  let statsCaption: String
  let stats: [StatItem]
  let card: ShareCard
  let earned: ZeroContent
  let still: ZeroContent
  let quiet: ZeroContent
  /// 17.G: the rail's four tile states at once, and the title bar's two.
  let rail: [ShellModel.Scope: RailMark]
  let titleLeft: ShellBoard.Counter
  let titleClear: ShellBoard.Counter
}
