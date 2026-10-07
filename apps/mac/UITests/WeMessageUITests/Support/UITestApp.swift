import Foundation
import XCTest

/// The accessibility identifiers the app publishes (the contract in
/// Sources/WeMessageApp/ShellView.swift; AppHygieneTests H-A5 holds the two
/// lists equal).
enum ID {
  static let shell = "wemessage.shell"
  static let rail = "wemessage.rail"
  static let railAll = "wemessage.rail.all"
  static let railIMessage = "wemessage.rail.imessage"
  static let railWhatsApp = "wemessage.rail.whatsapp"
  static let railLinkedIn = "wemessage.rail.linkedin"
  static let railEmail = "wemessage.rail.email"
  static let sidebar = "wemessage.sidebar"
  static let lens = "wemessage.lens"
  static let sidebarEmpty = "wemessage.sidebar.empty"
  static let connection = "wemessage.connection"
  static let contentEmpty = "wemessage.content.empty"
  // v2 S4c, board 01.
  static let title = "wemessage.title"
  static let titleCounter = "wemessage.title.counter"
  static let lensRecent = "wemessage.lens.recent"
  static let lensNeedsYou = "wemessage.lens.needsyou"
  static let lensTriage = "wemessage.lens.triage"
  static let killChip = "wemessage.kill.chip"
  static let content = "wemessage.content"
  static let inspector = "wemessage.inspector"
  static let inspectorToggle = "wemessage.inspector.toggle"
  /// A list row is this prefix and its chatGuid.
  static let rowPrefix = "wemessage.sidebar.row."

  static let railTiles = [railAll, railIMessage, railWhatsApp, railLinkedIn, railEmail]
}

@MainActor
enum UITestApp {
  /// Every wait in the bundle.
  nonisolated static let timeout: TimeInterval = 20

  /// The app under test, configured from the runner's environment. Every
  /// WEMESSAGE_* key the job exported with a TEST_RUNNER_ prefix arrives in
  /// ProcessInfo here and is copied to the app explicitly: nothing is
  /// forwarded wholesale.
  ///
  /// `reduceTransparency` forces the app's copy of the Reduce Transparency
  /// display option ("1" on, "0" off); nil leaves the system's value.
  static func make(appearance: String, reduceTransparency: Bool? = nil) -> XCUIApplication {
    let env = ProcessInfo.processInfo.environment
    let app = XCUIApplication()
    app.launchArguments = ["-ApplePersistenceIgnoreState", "YES", "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
    var launch: [String: String] = ["WEMESSAGE_UI_TEST": "1", "WEMESSAGE_UI_APPEARANCE": appearance]
    if let reduceTransparency { launch["WEMESSAGE_UI_REDUCE_TRANSPARENCY"] = reduceTransparency ? "1" : "0" }
    for key in ["WEMESSAGE_DIR", "WEMESSAGE_PORT", "TZ"] {
      if let value = env[key], !value.isEmpty { launch[key] = value }
    }
    app.launchEnvironment = launch
    return app
  }

  static func shellElement(_ app: XCUIApplication) -> XCUIElement {
    app.descendants(matching: .any)[ID.shell]
  }

  // No snapshot directory: the ad hoc-signed runner is sandboxed and cannot
  // write under the job's temp dir. PNGs leave only as .keepAlways attachments.

  /// Where the app's geometry string arrived, and the string. A SwiftUI
  /// container's value is dropped on macOS (measured, run 37553425686), so
  /// the app publishes on the shell's value and label and on the window's
  /// value; the first that carries it wins.
  static func geometryText(_ app: XCUIApplication) -> (channel: String, raw: String)? {
    let shell = shellElement(app)
    let candidates: [(String, String?)] = [
      ("shell.value", shell.value as? String),
      ("shell.label", shell.label),
      ("window.value", app.windows.firstMatch.value as? String),
    ]
    for (channel, raw) in candidates {
      if let raw, raw.hasPrefix("frame=") { return (channel, raw) }
    }
    return nil
  }

  /// Parses "frame=WxH visible=WxH" from the shell root's accessibility
  /// value: the window size the APP computed and the visible frame the APP
  /// saw. Nil until the app has published it.
  static func shellGeometry(_ app: XCUIApplication) -> (frame: CGSize, visible: CGSize)? {
    guard let raw = geometryText(app)?.raw else { return nil }
    var sizes: [String: CGSize] = [:]
    for field in raw.split(separator: " ") {
      let pair = field.split(separator: "=", maxSplits: 1)
      guard pair.count == 2 else { continue }
      let dims = pair[1].split(separator: "x")
      guard dims.count == 2, let w = Double(dims[0]), let h = Double(dims[1]) else { continue }
      sizes[String(pair[0])] = CGSize(width: w, height: h)
    }
    guard let frame = sizes["frame"], let visible = sizes["visible"] else { return nil }
    return (frame, visible)
  }
}
