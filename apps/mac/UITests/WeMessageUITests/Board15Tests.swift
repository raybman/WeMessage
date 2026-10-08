import AppKit
import Foundation
import XCTest

/// v2 S4k: board 15, attachments and media. WEMESSAGE_UI_BOARD=15 opens the
/// media window over fixture files and builds no client (D-UI-102). The
/// fixture key doors (D-UI-103) stand in for a drag, a pick and a paste:
/// opt-cmd-1 drags over the thread, 2 over the rail, 6 over the list row,
/// 3 releases, 4 attaches, 5 pastes, 0 leaves and 9 clears the tray.
/// One launch per appearance walks 15.A to 15.H, a shot per state:
/// - resting: the thread, an empty tray, and the record slot's reason;
/// - drop: the field over the thread, its card, and the rail untouched;
/// - refused: the rail hatched and the reason printed in the list;
/// - wall: the dropped set staged with the video over iMessage's wall;
/// - tray: the video removed and the picked images added, HEIC and
///   location printed;
/// - paste: the pasted image staged as one more numbered cell;
/// - viewer: opened from message 6, three arrows on;
/// - walls and refusal: the dated walls and the four part refusal.
/// The light launch runs the accessibility audit. Shots are
/// board-15-<state>-<appearance>.png. CI only.
final class Board15Tests: XCTestCase {
  override func setUp() async throws {
    try await FakeDaemon.reset()
  }

  @MainActor
  func testBoard15Light() async throws {
    try await media(appearance: "light")
  }

  @MainActor
  func testBoard15Dark() async throws {
    try await media(appearance: "dark")
  }

  /// A drop stages and sends nothing: not on release, not over the wall,
  /// not from cmd-Return, and not from the tray's own Send, whose sink is
  /// parked in this version (D-UI-104).
  @MainActor
  func testDropNeverSends() async throws {
    let app = try await Self.launch(appearance: "light")
    defer { app.terminate() }
    Self.door(app, "1")
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.value(app, ID.mediaDrop) == "targeted" },
      "the thread did not target: \(QueueUI.value(app, ID.mediaDrop))")
    Self.door(app, "3")
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.label(app, ID.mediaTray) == "Staged \u{00B7} 3 items" },
      "the drop did not stage: \(QueueUI.label(app, ID.mediaTray))")
    XCTAssertEqual(QueueUI.value(app, ID.mediaDrop), "resting", "the field stayed up after the release")
    XCTAssertFalse(QueueUI.element(app, ID.mediaNote).exists, "the release printed \(QueueUI.label(app, ID.mediaNote))")
    var requests = try await FakeDaemon.journal().requests
    XCTAssertEqual(requests.filter { $0.path.hasPrefix("/v1/send") }, [], "a drop asked to send")

    // Over the wall: Send is inert, cmd-Return and a click do nothing.
    XCTAssertEqual(QueueUI.value(app, ID.mediaSend), "inert", "Send is live over the wall")
    app.typeKey(.return, modifierFlags: .command)
    QueueUI.element(app, ID.mediaSend).click()
    QueueUI.settle()
    XCTAssertFalse(QueueUI.element(app, ID.mediaNote).exists, "Send over the wall did something")
    XCTAssertEqual(
      app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'anyway'")).count, 0, "a send-anyway is drawn")

    // Under the wall the tray's Send reaches only the parked sink.
    QueueUI.element(app, ID.mediaTrayRemovePrefix + "d3").click()
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.value(app, ID.mediaSend) == "enabled" },
      "removing the video left Send \(QueueUI.value(app, ID.mediaSend))")
    QueueUI.element(app, ID.mediaSend).click()
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.label(app, ID.mediaNote) == ProvisionalUI.mediaParkedNote },
      "the tray's Send printed \(QueueUI.label(app, ID.mediaNote))")
    try await Task.sleep(for: .milliseconds(500))
    requests = try await FakeDaemon.journal().requests
    XCTAssertEqual(requests.filter { $0.path.hasPrefix("/v1/send") }, [], "the media board asked to send")
    XCTAssertEqual(requests.filter { $0.method != "GET" }.map(\.description), [], "the media board wrote to the daemon")
  }

  /// 15.F rule 1: Esc puts the thread back at the offset pinned when the
  /// viewer opened, and outlines the message it was opened from, not the
  /// one the arrows reached.
  @MainActor
  func testViewerEscRestoresScroll() async throws {
    let app = try await Self.launch(appearance: "light")
    defer { app.terminate() }
    let thread = QueueUI.element(app, ID.mediaThread)
    let origin = QueueUI.element(app, ID.mediaItemPrefix + "t3")
    XCTAssertTrue(origin.waitForExistence(timeout: UITestApp.timeout), "no IMG_4417 in the thread")
    // Scroll until the thread is off its top and IMG_4417 is still in reach.
    // The wheel's sign differs between hosts, so try one way, then the other.
    var y = Self.offset(app)
    for delta in [-60.0, -60.0, -60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0] where y <= 0 || !origin.isHittable {
      thread.scroll(byDeltaX: 0, deltaY: delta)
      QueueUI.settle()
      y = Self.offset(app)
    }
    XCTAssertGreaterThan(y, 0, "the thread never scrolled: \(QueueUI.value(app, ID.mediaHeader))")
    XCTAssertTrue(origin.isHittable, "IMG_4417 scrolled out of reach at y=\(y)")
    origin.click()
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.label(app, ID.mediaViewerPosition) == "3 / 7" },
      "the viewer opened at \(QueueUI.label(app, ID.mediaViewerPosition))")
    XCTAssertTrue(
      QueueUI.label(app, ID.mediaViewerOrigin).contains("y=\(y)"),
      "the pinned offset is not y=\(y): \(QueueUI.label(app, ID.mediaViewerOrigin))")
    for _ in 0..<3 { app.typeKey(.rightArrow, modifierFlags: []) }
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.label(app, ID.mediaViewerPosition) == "6 / 7" },
      "the arrows reached \(QueueUI.label(app, ID.mediaViewerPosition))")
    app.typeKey(.escape, modifierFlags: [])
    XCTAssertTrue(
      QueueUI.waitUntil { !QueueUI.element(app, ID.mediaViewer).exists }, "Esc did not close the viewer")
    XCTAssertTrue(
      QueueUI.waitUntil { abs(Self.offset(app) - y) <= 1 },
      "Esc restored \(QueueUI.value(app, ID.mediaHeader)) and not y=\(y)")
    XCTAssertTrue(QueueUI.label(app, ID.mediaMessagePrefix + "m6").hasSuffix("outlined"), "the origin is not outlined")
    XCTAssertFalse(QueueUI.label(app, ID.mediaMessagePrefix + "m11").hasSuffix("outlined"), "the arrows' end is outlined")
    XCTAssertTrue(
      QueueUI.waitUntil(Double(ProvisionalUI.viewerOutlineSeconds) + 4) {
        !QueueUI.label(app, ID.mediaMessagePrefix + "m6").hasSuffix("outlined")
      }, "the outline never faded")
    print("BOARD15| esc restored y=\(y)")
  }

  // MARK: The walk

  @MainActor
  private static func launch(appearance: String) async throws -> XCUIApplication {
    try await FakeDaemon.scenario("rich")
    let app = UITestApp.make(appearance: appearance, reduceTransparency: false, board: "15")
    app.launch()
    let window = QueueUI.element(app, ID.media)
    XCTAssertTrue(window.waitForExistence(timeout: UITestApp.timeout), "the media window never appeared")
    XCTAssertFalse(UITestApp.shellElement(app).exists, "the shell is drawn beside media")
    return app
  }

  /// A fixture key door: opt-cmd and a digit.
  private static func door(_ app: XCUIApplication, _ key: String) {
    app.typeKey(key, modifierFlags: [.command, .option])
  }

  /// The thread's reported offset, from the header name's value "y=N".
  /// The scroll view's own value is not reliably exposed, so the model's
  /// offset rides on a Text, which keeps it.
  @MainActor
  private static func offset(_ app: XCUIApplication) -> Int {
    let value = QueueUI.value(app, ID.mediaHeader)
    return Int(value.replacingOccurrences(of: "y=", with: "")) ?? -1
  }

  @MainActor
  private func media(appearance: String) async throws {
    let app = try await Self.launch(appearance: appearance)
    defer { app.terminate() }
    let started = Date()
    let light = appearance == "light"
    let shot: (String) -> Void = { step in
      QueueUI.settle()
      self.glance(app, name: "board-15-\(step)-\(appearance).png")
    }

    // Resting: the thread, nothing staged, and the record slot's reason in
    // place of a control (15.E: ABSENT on iMessage).
    XCTAssertTrue(QueueUI.element(app, ID.mediaThread).waitForExistence(timeout: UITestApp.timeout), "no thread")
    XCTAssertEqual(QueueUI.value(app, ID.mediaTabPrefix + "thread"), "shown")
    XCTAssertEqual(QueueUI.value(app, ID.mediaDrop), "resting")
    XCTAssertFalse(QueueUI.element(app, ID.mediaTray).exists, "a tray is drawn with nothing staged")
    XCTAssertTrue(QueueUI.label(app, ID.mediaRecord).contains("audio file"), "the record slot prints no reason")
    XCTAssertEqual(
      app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'record'")).count, 0, "a record control is drawn")
    XCTAssertEqual(
      app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] 'voice memo'")).count, 0,
      "a voice memo control is drawn")
    shot("resting")
    QueueUI.printTime("BOARD15", appearance, "resting", since: started)

    // 15.A: over the thread, the field and its card; the rail and the list
    // stay as they were.
    Self.door(app, "1")
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.value(app, ID.mediaDrop) == "targeted" },
      "the thread did not target: \(QueueUI.value(app, ID.mediaDrop))")
    let card = QueueUI.label(app, ID.mediaDropCard)
    XCTAssertTrue(card.contains("onto Maya Lee"), "the card names nobody: \(card)")
    XCTAssertTrue(card.contains("over iMessage's"), "the card hides the wall: \(card)")
    XCTAssertFalse(QueueUI.label(app, ID.mediaRail).contains("refused"), "the rail refused a thread drop")
    shot("drop")

    // Over the rail: refused, hatched, and the reason printed.
    Self.door(app, "0")
    Self.door(app, "2")
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.label(app, ID.mediaRail).contains("refused") },
      "the rail did not refuse: \(QueueUI.label(app, ID.mediaRail))")
    XCTAssertEqual(QueueUI.value(app, ID.mediaDrop), "refused")
    XCTAssertTrue(QueueUI.label(app, ID.mediaDropReason).contains("recipient"), "the refusal is silent")
    shot("refused")

    // The list row: the thread opens after the dwell, then the release
    // stages the set with the video over the wall.
    Self.door(app, "0")
    Self.door(app, "6")
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.value(app, ID.mediaDrop) == "targeted" },
      "the dwell never opened the thread: \(QueueUI.value(app, ID.mediaDrop))")
    Self.door(app, "3")
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.label(app, ID.mediaTray) == "Staged \u{00B7} 3 items" },
      "the drop did not stage: \(QueueUI.label(app, ID.mediaTray))")
    XCTAssertTrue(QueueUI.label(app, ID.mediaCounter).contains("over iMessage's wall"), "the wall is not printed")
    XCTAssertEqual(QueueUI.value(app, ID.mediaSend), "inert", "Send is live over the wall")
    XCTAssertTrue(
      QueueUI.label(app, ID.mediaTrayItemPrefix + "d3").hasSuffix("\u{25B6} 4:12"),
      "the video has no duration: \(QueueUI.label(app, ID.mediaTrayItemPrefix + "d3"))")
    XCTAssertTrue(QueueUI.element(app, ID.mediaCompression).exists, "no compression table under the video")
    XCTAssertTrue(
      QueueUI.label(app, ID.mediaCompressionRowPrefix + "original").contains("4:12"), "a target has no duration")
    shot("wall")
    QueueUI.printTime("BOARD15", appearance, "wall", since: started)

    // 15.C: remove the video, then pick four images. The HEIC conversion
    // and the location strip are printed, and the grid previews the set.
    QueueUI.element(app, ID.mediaTrayRemovePrefix + "d3").click()
    Self.door(app, "4")
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.label(app, ID.mediaTray) == "Staged \u{00B7} 6 images" },
      "the pick did not stage: \(QueueUI.label(app, ID.mediaTray))")
    XCTAssertTrue(QueueUI.label(app, ID.mediaConversion).contains("JPEG"), "the HEIC conversion is silent")
    XCTAssertTrue(QueueUI.label(app, ID.mediaLocation).contains("removed"), "the location strip is silent")
    XCTAssertTrue(QueueUI.label(app, ID.mediaCounter).contains("left under"), "the wall is not counted down")
    XCTAssertEqual(QueueUI.value(app, ID.mediaSend), "enabled", "Send is inert under the wall")
    XCTAssertFalse(QueueUI.element(app, ID.mediaCompression).exists, "a compression table with no video")
    shot("tray")
    if light { try audit(app, window: "audit-board-15-tray") }

    // 15.C: a paste is one more numbered cell, never a send.
    Self.door(app, "5")
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.label(app, ID.mediaTray) == "Staged \u{00B7} 7 images" },
      "the paste did not stage: \(QueueUI.label(app, ID.mediaTray))")
    XCTAssertTrue(QueueUI.label(app, ID.mediaGrid).hasSuffix("5 shown, +2"), "the grid reads \(QueueUI.label(app, ID.mediaGrid))")
    shot("paste")
    QueueUI.printTime("BOARD15", appearance, "paste", since: started)
    Self.door(app, "9")
    XCTAssertTrue(QueueUI.waitUntil { !QueueUI.element(app, ID.mediaTray).exists }, "the tray did not clear")

    // 15.F: the viewer, from the thread's first photo, three arrows on. The
    // first photo is in reach without scrolling; the Esc test scrolls.
    QueueUI.element(app, ID.mediaItemPrefix + "t1").click()
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.label(app, ID.mediaViewerPosition) == "1 / 7" },
      "the viewer opened at \(QueueUI.label(app, ID.mediaViewerPosition))")
    for _ in 0..<3 { app.typeKey(.rightArrow, modifierFlags: []) }
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.label(app, ID.mediaViewerPosition) == "4 / 7" },
      "the arrows reached \(QueueUI.label(app, ID.mediaViewerPosition))")
    XCTAssertTrue(QueueUI.label(app, ID.mediaViewerKinds).contains("PDF"), "the strip hides the PDF")
    XCTAssertTrue(QueueUI.element(app, ID.mediaViewerSave).exists)
    XCTAssertTrue(QueueUI.element(app, ID.mediaViewerReveal).exists)
    XCTAssertTrue(QueueUI.element(app, ID.mediaViewerCopy).exists)
    shot("viewer")
    if light { try audit(app, window: "audit-board-15-viewer") }
    app.typeKey("s", modifierFlags: .command)
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.label(app, ID.mediaViewerLine).contains("Downloads as trail-01") },
      "cmd-S saved nothing: \(QueueUI.label(app, ID.mediaViewerLine))")
    app.typeKey(.escape, modifierFlags: [])
    XCTAssertTrue(
      QueueUI.waitUntil { !QueueUI.element(app, ID.mediaViewer).exists }, "Esc did not close the viewer")
    XCTAssertTrue(QueueUI.label(app, ID.mediaMessagePrefix + "m3").hasSuffix("outlined"), "the origin is not outlined")

    // 15.B: the walls, each dated.
    QueueUI.element(app, ID.mediaTabPrefix + "walls").click()
    let imessage = QueueUI.element(app, ID.mediaWallPrefix + "imessage")
    XCTAssertTrue(imessage.waitForExistence(timeout: UITestApp.timeout), "no iMessage wall")
    XCTAssertTrue(QueueUI.value(app, ID.mediaWallPrefix + "imessage").contains("as of 20"), "the wall is undated")
    shot("walls")

    // 15.H: the refusal, four parts, and its fourth part moves words to the
    // composer and sends nothing.
    QueueUI.element(app, ID.mediaTabPrefix + "refusal").click()
    XCTAssertTrue(
      QueueUI.element(app, ID.mediaRefusal).waitForExistence(timeout: UITestApp.timeout), "no refusal panel")
    for part in 1...4 {
      XCTAssertTrue(QueueUI.element(app, ID.mediaRefusalPartPrefix + "\(part)").exists, "no part \(part)")
    }
    XCTAssertTrue(QueueUI.element(app, ID.mediaMatrixPrefix + "0").exists, "no matrix")
    shot("refusal")
    if light { try audit(app, window: "audit-board-15-refusal") }
    QueueUI.element(app, ID.mediaRefusalTake).click()
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.value(app, ID.mediaTabPrefix + "thread") == "shown" },
      "the refusal did not return to the thread")
    XCTAssertFalse(QueueUI.value(app, ID.mediaField).isEmpty, "the words did not move to the composer")
    XCTAssertFalse(QueueUI.element(app, ID.mediaNote).exists, "the refusal sent something")

    let requests = try await FakeDaemon.journal().requests
    XCTAssertEqual(requests.filter { $0.path.hasPrefix("/v1/send") }, [], "the media board asked to send")
    XCTAssertEqual(requests.filter { $0.method != "GET" }.map(\.description), [], "the media board wrote to the daemon")
    print("BOARD15| \(appearance) states=9 seconds=\(Int(Date().timeIntervalSince(started)))")
  }
}
