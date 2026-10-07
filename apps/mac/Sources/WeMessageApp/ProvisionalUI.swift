import Foundation

// PROVISIONAL pending Eric's D-UI-1..6 decisions (docs/plans/v2-swift-S3.md
// §7.2). Every value below is the plan's default, chosen only so the window
// can be built and tested before the design questions are answered. They
// live in this one file on purpose: when the decisions land, this file is
// the whole edit, and AppHygieneTests fails if any of these values is copied
// as a literal into another app or UI test source.
//
// Foundation only: the CI-only UI test bundle compiles this file too (see
// apps/mac/project.yml), so the XCUITests read the same values the app draws
// and never restate them.
public enum ProvisionalUI {
  // D-UI-1: the channel rail. Collapsed to short labels by default.
  public static let railCollapsed = true
  public static let railCollapsedWidth: Double = 58
  public static let railExpandedWidth: Double = 180
  /// Short tile labels, keyed by the channel scope's raw value.
  public static let railShortLabels: [String: String] = [
    "all": "ALL",
    "imessage": "iM",
    "whatsapp": "WA",
    "linkedin": "LI",
    "email": "EM",
  ]
  public static var railWidth: Double { railCollapsed ? railCollapsedWidth : railExpandedWidth }

  // D-UI-2: the sidebar when there is nothing to list.
  public static let sidebarEmpty = "No conversations yet"

  // D-UI-3: the connection line. Words only, never a coloured dot; inkDim
  // at 11 pt.
  public static let connectionFontSize: Double = 11
  public static let idleLine = "Connecting to the daemon"
  public static let downLine = "Daemon not reachable"
  public static func connectedLine(state: String) -> String { "Connected: " + state }
  public static func reconnectingLine(attempt: Int) -> String { "Reconnecting, attempt " + String(attempt) }

  // D-UI-4: the window's default and minimum size, in points.
  public static let windowDefaultWidth: Double = 1180
  public static let windowDefaultHeight: Double = 760
  public static let windowMinWidth: Double = 870
  public static let windowMinHeight: Double = 560

  // D-UI-5: the content pane with no conversation selected. Text only.
  public static let contentEmpty =
    "No conversation selected. Pick a thread, press up/down to move, or hold shift-cmd-V and just ask."
  public static let contentEmptyGlyph = false

  // D-UI-6: how the selected rail tile is drawn.
  public enum SelectedTileStyle: Sendable {
    /// Filled tint tile with a white label.
    case filledTint
    /// Tint-coloured label on the plain rail.
    case tintLabel
    /// A tint bar on the tile's leading edge.
    case tintBar
  }
  public static let selectedTile: SelectedTileStyle = .filledTint
}
