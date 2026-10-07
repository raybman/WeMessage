import Foundation
import XCTest

/// The bare-launch proof: the one executable, started with no arguments,
/// opens the shell. CI only (the ci-swift `ui` job); nothing launches the
/// app on a laptop.
/// XCUIApplication is main-actor isolated under Swift 6, so every test is.
final class LaunchTests: XCTestCase {
  @MainActor
  func testBareLaunchShowsShell() {
    let app = UITestApp.make(appearance: "light")
    app.launch()
    XCTAssertTrue(UITestApp.shellElement(app).waitForExistence(timeout: UITestApp.timeout), "the shell never appeared")
    app.terminate()
  }

  /// The window is the requested size clamped to the visible frame, as the
  /// APP saw it. Never compared against a monitor size read in this process
  /// (the runner and the app read visible frames 3 pt apart) and never
  /// against a literal size (the runner's display is smaller than the default).
  @MainActor
  func testWindowGeometry() {
    let app = UITestApp.make(appearance: "light")
    app.launch()
    XCTAssertTrue(UITestApp.shellElement(app).waitForExistence(timeout: UITestApp.timeout), "the shell never appeared")
    let window = app.windows.firstMatch

    // The app publishes after it pins, and re-pins if the visible frame
    // settles late, so wait until what it says and what the window is agree.
    var geometry = UITestApp.shellGeometry(app)
    let deadline = Date().addingTimeInterval(UITestApp.timeout)
    while Date() < deadline {
      geometry = UITestApp.shellGeometry(app)
      if let g = geometry, abs(window.frame.width - g.frame.width) <= 1, abs(window.frame.height - g.frame.height) <= 1 {
        break
      }
      Thread.sleep(forTimeInterval: 0.25)
    }
    guard let g = geometry else {
      // The element tree says whether the app never pinned or the value
      // never reached the accessibility layer.
      XCTFail(
        "the shell never published its geometry; value: \(String(describing: UITestApp.shellElement(app).value)); "
          + "window: \(window.frame)\n\(String(app.debugDescription.prefix(6000)))")
      return
    }
    let f = window.frame.size
    XCTAssertEqual(f.width, g.frame.width, accuracy: 1, "window \(f) vs published \(g)")
    XCTAssertEqual(f.height, g.frame.height, accuracy: 1, "window \(f) vs published \(g)")
    XCTAssertLessThanOrEqual(f.width, g.visible.width + 1)
    XCTAssertLessThanOrEqual(f.height, g.visible.height + 1)
    XCTAssertEqual(g.frame.width, min(ProvisionalUI.windowDefaultWidth, g.visible.width).rounded(), "published \(g)")
    XCTAssertEqual(g.frame.height, min(ProvisionalUI.windowDefaultHeight, g.visible.height).rounded(), "published \(g)")
    app.terminate()
  }
}
