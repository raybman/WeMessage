import Foundation
import XCTest

/// U-X1/U-X2 (plan §4.5, §5.3): the shell passes the system accessibility
/// audit with nothing ignored, and the keyboard reaches every part of it.
/// CI only.
final class AccessibilityTests: XCTestCase {
  /// The rail tiles in rail order, which is cmd-1..5 order.
  static let railIDs = ID.railTiles

  /// U-X1: the default audit types, and a handler that keeps every issue.
  /// Each issue is also written to the log so a red run names it.
  @MainActor
  func testShellPassesAccessibilityAudit() throws {
    let app = UITestApp.make(appearance: "light")
    app.launch()
    XCTAssertTrue(UITestApp.shellElement(app).waitForExistence(timeout: UITestApp.timeout), "the shell never appeared")
    try app.performAccessibilityAudit() { issue in
      let who = issue.element.map { "\($0.identifier) '\($0.label)'" } ?? "(no element)"
      print("audit issue: \(issue.auditType) \(who): \(issue.compactDescription)")
      return false
    }
    app.terminate()
  }

  /// The element that has keyboard focus now, by identifier ("" when it has none).
  @MainActor
  static func focusedIdentifier(_ app: XCUIApplication) -> String {
    let focused = app.descendants(matching: .any).matching(NSPredicate(format: "hasKeyboardFocus == true")).firstMatch
    return focused.exists ? focused.identifier : ""
  }

  /// True when the lens picker or one of its segments has keyboard focus.
  @MainActor
  static func lensHasFocus(_ app: XCUIApplication) -> Bool {
    let lens = app.descendants(matching: .any)[ID.lens]
    let inside = lens.descendants(matching: .any).matching(NSPredicate(format: "hasKeyboardFocus == true"))
    return focusedIdentifier(app) == ID.lens || inside.count > 0
  }

  /// U-X2: cmd-1..5 select the rail tiles in order, and Tab walks the rail
  /// and then reaches the lens.
  @MainActor
  func testKeyboardPath() throws {
    // The job turns Full Keyboard Access on before xcodebuild (§4.7, P1-3).
    // Without it Tab never lands, so a missing step reads as a named skip.
    let mode = UserDefaults.standard.integer(forKey: "AppleKeyboardUIMode")
    try XCTSkipUnless(mode & 2 != 0, "Full Keyboard Access off: the job step is missing")

    let app = UITestApp.make(appearance: "light")
    app.launch()
    XCTAssertTrue(UITestApp.shellElement(app).waitForExistence(timeout: UITestApp.timeout), "the shell never appeared")

    let digits = ["1", "2", "3", "4", "5"]
    for (index, digit) in digits.enumerated() {
      app.typeKey(digit, modifierFlags: .command)
      let selected = app.descendants(matching: .any)[Self.railIDs[index]]
      let became = expectation(for: NSPredicate(format: "isSelected == true"), evaluatedWith: selected)
      wait(for: [became], timeout: 5)
      for (other, id) in Self.railIDs.enumerated() where other != index {
        XCTAssertFalse(app.descendants(matching: .any)[id].isSelected, "cmd-\(digit) left \(id) selected")
      }
    }
    app.typeKey("1", modifierFlags: .command)

    // Natural order from the view tree: every rail tile is a stop, then the
    // lens. Record each stop so a wrong order reads as the path it took.
    var path: [String] = []
    var reached = false
    for _ in 0..<(Self.railIDs.count + 4) {
      app.typeKey("\t", modifierFlags: [])
      Thread.sleep(forTimeInterval: 0.2)
      if Self.lensHasFocus(app) {
        reached = true
        break
      }
      path.append(Self.focusedIdentifier(app))
    }
    XCTAssertTrue(reached, "Tab never reached the lens; stops: \(path)")
    let strays = path.filter { !$0.isEmpty && !Self.railIDs.contains($0) }
    XCTAssertEqual(strays, [], "Tab stopped outside the rail before the lens; stops: \(path)")
    XCTAssertTrue(path.contains(where: { Self.railIDs.contains($0) }), "Tab skipped the rail; stops: \(path)")
    app.terminate()
  }
}
