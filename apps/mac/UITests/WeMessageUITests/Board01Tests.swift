import AppKit
import Foundation
import XCTest

/// v2 S4c: board 01, the shell, from the fake daemon's scenarios. One
/// launch per appearance (the S4 runtime rule): the app starts on "rich",
/// and each later state is a scenario switch plus the test-only reload key
/// (cmd-opt-R), never a relaunch. Each state is shot with the frost on as
/// board-01-<state>-<appearance>.png and swept like every snapshot. The
/// teeth: a digit on a stale tile fails, a total while degraded fails, the
/// kill chip missing fails, and the journal never holds POST /v1/send.
/// The plan's testBoard01DegradedLight/Dark and testKillChipAlwaysVisible
/// are states inside these two launches, not launches of their own.
/// CI only.
final class Board01Tests: XCTestCase {
  override func setUp() async throws {
    try await FakeDaemon.reset()
  }

  @MainActor
  func testBoard01Light() async throws {
    try await board01(appearance: "light") { mean in
      XCTAssertGreaterThan(mean, 0.65, "a light shell renders dark: mean luminance \(mean)")
    }
  }

  @MainActor
  func testBoard01Dark() async throws {
    try await board01(appearance: "dark") { mean in
      XCTAssertLessThan(mean, 0.35, "a dark shell renders light: mean luminance \(mean)")
    }
  }

  /// What a state must show before it is shot.
  struct Expect {
    let scenario: String
    let state: String
    /// The iMessage and ALL tiles' accessibility value: a digit, "clear" or
    /// "stale".
    let mark: String
    /// The counter's sentence starts with this.
    let counter: String
    /// The Needs You segment's value.
    let needsYou: String
  }

  static let states = [
    Expect(scenario: "rich", state: "rich", mark: "4", counter: "4 left as of ", needsYou: "4"),
    Expect(scenario: "empty-earned", state: "empty", mark: "clear", counter: "Clear ", needsYou: ""),
    Expect(scenario: "degraded", state: "degraded", mark: "stale", counter: "Cannot say", needsYou: ""),
    Expect(scenario: "quiet", state: "quiet", mark: "stale", counter: "Cannot say", needsYou: ""),
  ]

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id]
  }

  @MainActor
  private func value(_ app: XCUIApplication, _ id: String) -> String {
    let e = element(app, id)
    return e.exists ? ((e.value as? String) ?? "") : "(missing)"
  }

  /// One more frame after the values arrive, before the shot.
  @MainActor
  private func settle() { Thread.sleep(forTimeInterval: 0.3) }

  /// Polls until `done` holds or the wait runs out; true when it held.
  @MainActor
  private func waitUntil(_ done: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(UITestApp.timeout)
    repeat {
      if done() { return true }
      Thread.sleep(forTimeInterval: 0.25)
    } while Date() < deadline
    return done()
  }

  @MainActor
  private func board01(appearance: String, luminance: (Double) -> Void) async throws {
    try await FakeDaemon.scenario("rich")
    let app = UITestApp.make(appearance: appearance, reduceTransparency: false)
    app.launch()
    defer { app.terminate() }
    XCTAssertTrue(UITestApp.shellElement(app).waitForExistence(timeout: UITestApp.timeout), "the shell never appeared")
    let geometry = settledGeometry(app)
    let started = Date()

    for (index, expect) in Self.states.enumerated() {
      if index > 0 {
        try await FakeDaemon.scenario(expect.scenario)
        app.typeKey("r", modifierFlags: [.command, .option])
      }
      let name = "board-01-\(expect.state)-\(appearance).png"
      let settled = waitUntil {
        value(app, ID.railIMessage) == expect.mark && value(app, ID.railAll) == expect.mark
          && value(app, ID.titleCounter).hasPrefix(expect.counter)
      }
      XCTAssertTrue(
        settled,
        "\(name): iM=\(value(app, ID.railIMessage)) ALL=\(value(app, ID.railAll)) counter=\(value(app, ID.titleCounter))")
      settle()
      assertBoard(app, expect, name: name)
      capture(app, geometry: geometry, appearance: appearance, frost: true, name: name, luminance: luminance)
    }

    // The kill scenario: the chip reads the status's switch, and is still
    // the same chip.
    try await FakeDaemon.scenario("kill")
    app.typeKey("r", modifierFlags: [.command, .option])
    XCTAssertTrue(waitUntil { value(app, ID.killChip) == "on" }, "kill chip: \(value(app, ID.killChip))")
    assertKillChipAlwaysVisible(app)

    // A row opens its thread head, and the inspector toggles beside it.
    let row = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", ID.rowPrefix)).firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: UITestApp.timeout), "no list row under the kill scenario")
    row.click()
    XCTAssertTrue(element(app, ID.content).waitForExistence(timeout: UITestApp.timeout), "a row opened no thread head")
    XCTAssertFalse(element(app, ID.inspector).exists, "the inspector opened by itself")
    element(app, ID.inspectorToggle).click()
    XCTAssertTrue(element(app, ID.inspector).waitForExistence(timeout: UITestApp.timeout), "the inspector never opened")
    element(app, ID.inspectorToggle).click()
    XCTAssertTrue(waitUntil { !element(app, ID.inspector).exists }, "the inspector never closed")

    print("BOARD01| \(appearance) states=\(Self.states.count) seconds=\(Int(Date().timeIntervalSince(started)))")
    try await FakeDaemon.assertNoSend()
  }

  /// The teeth, per state.
  @MainActor
  private func assertBoard(_ app: XCUIApplication, _ expect: Expect, name: String) {
    for id in [ID.railIMessage, ID.railAll] {
      let mark = value(app, id)
      if mark == "stale" || expect.mark == "stale" {
        XCTAssertNil(Int(mark), "\(name): \(id) shows a digit while stale")
        XCTAssertEqual(mark, "stale", "\(name): \(id)")
      }
    }
    for id in [ID.railWhatsApp, ID.railLinkedIn, ID.railEmail] {
      XCTAssertEqual(value(app, id), "", "\(name): \(id) is not connected and must say nothing")
    }
    let counter = value(app, ID.titleCounter)
    let needsYou = value(app, ID.lensNeedsYou)
    XCTAssertEqual(needsYou, expect.needsYou, "\(name): Needs You count")
    if expect.mark == "stale" {
      XCTAssertFalse(counter.contains(" left "), "\(name): a total while stale: \(counter)")
      XCTAssertEqual(needsYou, "", "\(name): a Needs You total while stale")
    }
    assertKillChipAlwaysVisible(app)
    XCTAssertFalse(element(app, ID.content).exists, "\(name): a thread is selected in the snapshot")
    XCTAssertFalse(element(app, ID.inspector).exists, "\(name): the inspector is open in the snapshot")
    XCTAssertTrue(element(app, ID.contentEmpty).exists, "\(name): the content pane is not empty")
  }

  /// The kill chip is on screen in every state.
  @MainActor
  private func assertKillChipAlwaysVisible(_ app: XCUIApplication) {
    let chip = element(app, ID.killChip)
    XCTAssertTrue(chip.exists, "the kill chip is missing")
    XCTAssertTrue(chip.isHittable, "the kill chip is not hittable")
    XCTAssertEqual(chip.label, "Kill switch")
  }
}
