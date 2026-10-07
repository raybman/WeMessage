import Foundation
import XCTest

/// U-C1/U-C2 (plan §4.5, §5.2): the connection line, in words, against the
/// fake daemon the ci-swift `ui` job starts from tools/swift/fake-daemon.mjs
/// over the S0 goldens. CI only. The expected strings come from
/// ProvisionalUI.swift (D-UI-3, pending Eric), never from literals here.
final class ConnectionTests: XCTestCase {
  /// v2 S4b: every UI test starts from the S0 goldens and an empty journal.
  override func setUp() async throws {
    try await FakeDaemon.reset()
  }

  /// Polls the connection line until `done` holds or the timeout passes, and
  /// returns the last value read.
  @MainActor
  private func connectionValue(
    _ app: XCUIApplication, timeout: TimeInterval = UITestApp.timeout, until done: (String) -> Bool
  ) -> String {
    let line = app.descendants(matching: .any)[ID.connection]
    let deadline = Date().addingTimeInterval(timeout)
    var last = ""
    repeat {
      last = (line.value as? String) ?? ""
      if done(last) { return last }
      Thread.sleep(forTimeInterval: 0.25)
    } while Date() < deadline
    return last
  }

  /// The token file is in the app's WEMESSAGE_DIR; no label or value in the
  /// window ever shows any part of a bearer.
  @MainActor
  private func assertNoTokenRendered(_ app: XCUIApplication) {
    let elements = app.windows.firstMatch.descendants(matching: .any).allElementsBoundByIndex
    XCTAssertGreaterThan(elements.count, 0, "the window exposed no elements to sweep")
    for element in elements {
      XCTAssertFalse(element.label.contains("wm_"), "a label shows a token: \(element.identifier)")
      if let value = element.value as? String {
        XCTAssertFalse(value.contains("wm_"), "a value shows a token: \(element.identifier)")
      }
    }
  }

  /// U-C1: the fake daemon answers status with the golden's connectionState.
  @MainActor
  func testConnectsToFakeDaemon() {
    let app = UITestApp.make(appearance: "light")
    app.launch()
    XCTAssertTrue(UITestApp.shellElement(app).waitForExistence(timeout: UITestApp.timeout), "the shell never appeared")
    let expected = ProvisionalUI.connectedLine(state: "fully-connected")
    let value = connectionValue(app) { $0 == expected }
    XCTAssertEqual(value, expected)
    XCTAssertTrue(value.contains("fully-connected"), "status.json's connectionState is not on the line: \(value)")
    assertNoTokenRendered(app)
    app.terminate()
  }

  /// U-C2 (P0-2): nothing listens on 47199. The line says the D-UI-3 down
  /// string, and still says it three seconds later, while the kit's stream
  /// keeps retrying underneath (about five backoffs).
  @MainActor
  func testDaemonDownIsSaidPlainly() {
    let app = UITestApp.make(appearance: "light")
    app.launchEnvironment["WEMESSAGE_PORT"] = "47199"
    app.launch()
    XCTAssertTrue(UITestApp.shellElement(app).waitForExistence(timeout: UITestApp.timeout), "the shell never appeared")
    let first = connectionValue(app) { $0 == ProvisionalUI.downLine }
    XCTAssertEqual(first, ProvisionalUI.downLine)
    Thread.sleep(forTimeInterval: 3)
    let later = connectionValue(app, timeout: 0) { _ in true }
    XCTAssertEqual(later, ProvisionalUI.downLine, "the down line moved while the stream retried")
    assertNoTokenRendered(app)
    app.terminate()
  }
}
