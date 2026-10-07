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
  static func make(appearance: String) -> XCUIApplication {
    let env = ProcessInfo.processInfo.environment
    let app = XCUIApplication()
    app.launchArguments = ["-ApplePersistenceIgnoreState", "YES", "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
    var launch: [String: String] = ["WEMESSAGE_UI_TEST": "1", "WEMESSAGE_UI_APPEARANCE": appearance]
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

  /// Parses "frame=WxH visible=WxH" from the shell root's accessibility
  /// value: the window size the APP computed and the visible frame the APP
  /// saw. Nil until the app has published it.
  static func shellGeometry(_ app: XCUIApplication) -> (frame: CGSize, visible: CGSize)? {
    guard let raw = shellElement(app).value as? String else { return nil }
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
