import AppKit
import Foundation
import XCTest

/// v2 S4f: board 06, Triage and the zero screen, from the fake daemon's
/// "pending" scenario. One launch per appearance: every state is a key
/// press, a row click or a rail shortcut. Shots are board-06-<state>-
/// <appearance>.png, swept for green and held to the frost evidence.
///
/// What is checked on the way: cmd-T enters Triage and the bar counts the
/// queue down; Done, Snooze and Mute are drawn as verbs; H snoozes and Z
/// takes it back; E clears the queue to a zero that says what was done;
/// a channel with no source says it is not connected rather than zero.
/// The journal at the end holds no send, no draft action and no read
/// state: Triage reads, and its verbs are local (D-UI-51).
/// The light launch also runs the accessibility audit at the triage state.
/// CI only.
final class Board06Tests: XCTestCase {
  override func setUp() async throws {
    try await FakeDaemon.reset()
  }

  @MainActor
  func testBoard06Light() async throws {
    try await board06(appearance: "light") { mean in
      XCTAssertGreaterThan(mean, 0.6, "a light board 06 renders dark: mean luminance \(mean)")
    }
  }

  @MainActor
  func testBoard06Dark() async throws {
    try await board06(appearance: "dark") { mean in
      XCTAssertLessThan(mean, 0.4, "a dark board 06 renders light: mean luminance \(mean)")
    }
  }

  @MainActor
  private func board06(appearance: String, luminance: (Double) -> Void) async throws {
    try await FakeDaemon.scenario("pending")
    let app = UITestApp.make(appearance: appearance, reduceTransparency: false)
    app.launch()
    defer { app.terminate() }
    XCTAssertTrue(UITestApp.shellElement(app).waitForExistence(timeout: UITestApp.timeout), "the shell never appeared")
    let geometry = settledGeometry(app)
    let started = Date()
    func shoot(_ state: String, _ layout: FrostProbe.Layout) {
      QueueUI.settle()
      capture(
        app, geometry: geometry, appearance: appearance, frost: true, name: "board-06-\(state)-\(appearance).png",
        layout: layout, luminance: luminance)
      QueueUI.printTime("BOARD06", appearance, state, since: started)
    }

    // triage: cmd-T, the bar, and Priya's thread with its verb row.
    app.typeKey("t", modifierFlags: .command)
    XCTAssertTrue(QueueUI.waitUntil { QueueUI.element(app, ID.triageBar).exists }, "triage: no triage bar")
    XCTAssertTrue(QueueUI.label(app, ID.title).contains("Triage"), "triage: title reads \(QueueUI.label(app, ID.title))")
    XCTAssertTrue(QueueUI.label(app, ID.triageBar).contains("5"), "triage: bar reads \(QueueUI.label(app, ID.triageBar))")
    QueueUI.open(app, QueueUI.priya)
    XCTAssertTrue(QueueUI.waitUntil { QueueUI.element(app, ID.verbs).exists }, "triage: no verb row")
    for id in [ID.verbDone, ID.verbSnooze, ID.verbMute, ID.draftVerb(QueueUI.priyaDraft, "approve")] {
      XCTAssertTrue(QueueUI.waitUntil { QueueUI.element(app, id).exists }, "triage: \(id) is missing")
    }
    shoot("triage", .thread)
    if appearance == "light" { try audit(app, window: "audit-board-06-triage") }

    // H snoozes the open thread: its row stays, dimmed, saying until when.
    // Z takes it back.
    let priyaRow = ID.rowPrefix + QueueUI.priya
    app.typeKey("h", modifierFlags: [])
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.label(app, priyaRow).contains("Snoozed until") }, "snooze: row reads \(QueueUI.label(app, priyaRow))")
    app.typeKey("z", modifierFlags: [])
    XCTAssertTrue(
      QueueUI.waitUntil { !QueueUI.label(app, priyaRow).contains("Snoozed until") }, "undo: row reads \(QueueUI.label(app, priyaRow))")

    // zero: E on each thread in turn until the queue is empty.
    var presses = 0
    while presses < 8 && QueueUI.label(app, ID.zero) != "Zero: clear" {
      app.typeKey("j", modifierFlags: [])
      app.typeKey("e", modifierFlags: [])
      presses += 1
      _ = QueueUI.waitUntil(1) { QueueUI.label(app, ID.zero) == "Zero: clear" }
    }
    XCTAssertTrue(QueueUI.waitUntil { QueueUI.label(app, ID.zero) == "Zero: clear" }, "zero: reads \(QueueUI.label(app, ID.zero))")
    XCTAssertTrue(
      QueueUI.label(app, ID.zeroReceipt).contains("5 done"), "zero: receipt reads \(QueueUI.label(app, ID.zeroReceipt))")
    // 17.H: an earned zero carries the receipt and no Verify (D-UI-128).
    XCTAssertTrue(QueueUI.label(app, ID.zeroKind).hasPrefix("earned: "), "zero: kind reads \(QueueUI.label(app, ID.zeroKind))")
    XCTAssertFalse(QueueUI.element(app, ID.zeroVerify).exists, "zero: Verify now on an earned zero")
    XCTAssertFalse(QueueUI.element(app, ID.verbs).exists, "zero: a verb row with nothing open")
    shoot("zero", .shell)

    // notconnected: WhatsApp has no source, so it is not a zero you earned.
    app.typeKey("3", modifierFlags: .command)
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.label(app, ID.zero) == "Zero: not connected" }, "notconnected: reads \(QueueUI.label(app, ID.zero))")
    // The connect card is iMessage's (D-UI-48); WhatsApp has none to offer.
    XCTAssertFalse(QueueUI.element(app, ID.connectCard).exists, "notconnected: the iMessage card on WhatsApp")
    XCTAssertFalse(QueueUI.element(app, ID.zeroVerify).exists, "notconnected: Verify now with nothing to verify")
    shoot("notconnected", .shell)

    try await QueueUI.assertJournal("board 06 \(appearance)")
    print("BOARD06| \(appearance) states=3 presses=\(presses) seconds=\(Int(Date().timeIntervalSince(started)))")
  }
}
