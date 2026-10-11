import AppKit
import Foundation
import XCTest

/// v2 S4j: board 13, settings. One launch per appearance (the UI job's time
/// budget): WEMESSAGE_UI_BOARD=13 opens the settings window over the fake
/// daemon's kill scenario, so the switch reads on. The launch steps the
/// seven panes in the plan's order, a shot per pane:
/// - Drafting draws auto-send and schedules parked, with no control at all:
///   no switch and no checkbox anywhere in the window;
/// - Appearance mirrors macOS read-only; Keyboard is a table, five rows
///   editable by kind and the fixed rows fixed;
/// - Storage's Delete the local copy opens the confirm card and its go is
///   disabled; Cancel closes it and nothing is written;
/// - Confirmations releases the kill switch through the card, the one write.
/// The light launch runs the accessibility audit. Every launch ends on the
/// journal: no send, no draft action, one kill toggle and no other write.
/// Shots are board-13-<pane>-<appearance>.png, plus storage-confirm and
/// confirm-release for the two cards. CI only.
final class Board13Tests: XCTestCase {
  override func setUp() async throws {
    try await FakeDaemon.reset()
  }

  static let panes = ["accounts", "drafting", "notifications", "appearance", "keyboard", "storage", "confirm"]
  static let editable = ["reply", "approve", "done", "snooze", "mute", "movement", "hold"]
  static let fixed = ["send", "return", "undo", "kill"]

  @MainActor
  func testBoard13Light() async throws {
    try await settings(appearance: "light")
  }

  @MainActor
  func testBoard13Dark() async throws {
    try await settings(appearance: "dark")
  }

  /// Clicks a pane's sidebar row and waits for its page.
  @MainActor
  private func open(_ app: XCUIApplication, _ pane: String) {
    QueueUI.element(app, ID.settingsPanePrefix + pane).click()
    let page = QueueUI.element(app, ID.settingsPagePrefix + pane)
    XCTAssertTrue(page.waitForExistence(timeout: UITestApp.timeout), "never reached the \(pane) pane")
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.value(app, ID.settingsPanePrefix + pane) == "shown" },
      "\(pane): its row is not the shown one")
  }

  @MainActor
  private func noControls(_ app: XCUIApplication, _ when: String) {
    XCTAssertEqual(app.switches.count, 0, "\(when): a switch is drawn")
    XCTAssertEqual(app.checkBoxes.count, 0, "\(when): a checkbox is drawn")
    XCTAssertEqual(app.sliders.count, 0, "\(when): a slider is drawn")
    XCTAssertEqual(app.textFields.count, 0, "\(when): a field is drawn")
  }

  @MainActor
  private func settings(appearance: String) async throws {
    try await FakeDaemon.scenario("kill")
    let app = UITestApp.make(appearance: appearance, reduceTransparency: false, board: "13")
    app.launch()
    defer { app.terminate() }
    let window = QueueUI.element(app, ID.settings)
    XCTAssertTrue(window.waitForExistence(timeout: UITestApp.timeout), "the settings window never appeared")
    XCTAssertFalse(UITestApp.shellElement(app).exists, "the shell is drawn beside settings")
    let started = Date()
    let light = appearance == "light"
    let shot: (String) -> Void = { step in
      QueueUI.settle()
      self.glance(app, name: "board-13-\(step)-\(appearance).png")
    }

    // 13.A: the seven rows, accounts shown first.
    for pane in Self.panes {
      XCTAssertTrue(QueueUI.element(app, ID.settingsPanePrefix + pane).exists, "no \(pane) row")
    }
    XCTAssertTrue(QueueUI.element(app, ID.settingsPagePrefix + "accounts").waitForExistence(timeout: UITestApp.timeout))
    shot("accounts")
    if light { try audit(app, window: "audit-board-13-accounts") }
    QueueUI.printTime("BOARD13", appearance, "accounts", since: started)

    // 13.C: parked, never armable.
    open(app, "drafting")
    for id in [ID.settingsParkedAutosend, ID.settingsParkedSchedules] {
      XCTAssertTrue(QueueUI.element(app, id).waitForExistence(timeout: UITestApp.timeout), "no \(id)")
      XCTAssertEqual(QueueUI.value(app, id), "parked", "\(id) is not parked")
    }
    noControls(app, "drafting")
    shot("drafting")
    QueueUI.printTime("BOARD13", appearance, "drafting", since: started)

    open(app, "notifications")
    shot("notifications")

    // 13.E: mirrored, display only.
    open(app, "appearance")
    XCTAssertEqual(QueueUI.value(app, ID.settingsTheme), "system")
    XCTAssertEqual(QueueUI.value(app, ID.settingsReduceTransparency), "off", "reduce transparency is forced off")
    for id in ["increasecontrast", "reducemotion"] {
      let value = QueueUI.value(app, ID.settingsAppearancePrefix + id)
      XCTAssertTrue(["on", "off"].contains(value), "\(id) reads \(value)")
    }
    noControls(app, "appearance")
    shot("appearance")
    if light { try audit(app, window: "audit-board-13-appearance") }

    // 13.F: the keymap table.
    open(app, "keyboard")
    for id in Self.editable {
      XCTAssertEqual(QueueUI.value(app, ID.settingsKeyboardRowPrefix + id), "editable", "\(id) row")
    }
    for id in Self.fixed {
      XCTAssertEqual(QueueUI.value(app, ID.settingsKeyboardRowPrefix + id), "fixed", "\(id) row")
    }
    noControls(app, "keyboard")
    shot("keyboard")
    QueueUI.printTime("BOARD13", appearance, "keyboard", since: started)

    // 13.G: delete asks, and its go is disabled.
    open(app, "storage")
    XCTAssertTrue(QueueUI.element(app, ID.settingsStorage).exists, "no storage pane")
    // v2 F7e (D-UI-214): the kill scenario's status carries the mirror, so
    // the pane says the copy's size and where it lives, never "size unknown".
    let pane = QueueUI.element(app, ID.settingsStorage)
    let sized = NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", " MB", " MB")
    XCTAssertTrue(
      QueueUI.waitUntil { pane.descendants(matching: .any).matching(sized).count > 0 }, "the storage pane names no size")
    let unknown = NSPredicate(format: "label == %@ OR value == %@", "size unknown", "size unknown")
    XCTAssertEqual(pane.descendants(matching: .any).matching(unknown).count, 0, "the storage pane says size unknown")
    shot("storage")
    QueueUI.element(app, ID.settingsStorageDelete).click()
    let sheet = QueueUI.element(app, ID.settingsConfirmSheet)
    XCTAssertTrue(sheet.waitForExistence(timeout: UITestApp.timeout), "delete opened no confirm card")
    XCTAssertEqual(QueueUI.value(app, ID.settingsConfirmSheet), "deleteCopy")
    let go = QueueUI.element(app, ID.settingsConfirmGo)
    XCTAssertFalse(go.isEnabled, "delete's go can be pressed")
    XCTAssertEqual(QueueUI.value(app, ID.settingsConfirmGo), "not in this version")
    shot("storage-confirm")
    if light { try audit(app, window: "audit-board-13-storage-confirm") }
    QueueUI.element(app, ID.settingsConfirmCancel).click()
    XCTAssertTrue(QueueUI.waitUntil { !sheet.exists }, "cancel left the card up")

    // 13.H: release confirms; go is the shell's own disengage.
    open(app, "confirm")
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.value(app, ID.settingsKillState) == "on" },
      "the kill switch reads \(QueueUI.value(app, ID.settingsKillState))")
    shot("confirm")
    QueueUI.element(app, ID.settingsKillRelease).click()
    XCTAssertTrue(sheet.waitForExistence(timeout: UITestApp.timeout), "release opened no confirm card")
    XCTAssertEqual(QueueUI.value(app, ID.settingsConfirmSheet), "releaseKill")
    XCTAssertTrue(go.isEnabled, "release's go is disabled")
    shot("confirm-release")
    go.click()
    _ = try await FakeDaemon.waitForRequests(["POST /v1/toggles/kill-switch"])
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.value(app, ID.settingsKillState) == "off" },
      "release: the switch reads \(QueueUI.value(app, ID.settingsKillState))")
    XCTAssertFalse(QueueUI.element(app, ID.settingsKillRelease).exists, "release stays up with the switch off")
    XCTAssertFalse(sheet.exists, "the card stayed up after go")

    try await QueueUI.assertJournal("board 13 \(appearance)", toggles: 1)
    print("BOARD13| \(appearance) panes=7 seconds=\(Int(Date().timeIntervalSince(started)))")
  }
}
