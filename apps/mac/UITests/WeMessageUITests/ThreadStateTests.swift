import Foundation
import XCTest

/// v2 F3 (G-06a): Done, Snooze and Mute live in the daemon, so they survive
/// a quit. The app against the fake daemon's `thread-state` scenario (the
/// pending queue with Daniel's thread already snoozed by the daemon): a
/// fresh launch draws that snooze it never made, H on Priya writes one PUT
/// of thread state, and a relaunch against the same fake daemon still
/// draws both. A queue row says why it is there (D-UI-190). CI only.
final class ThreadStateTests: XCTestCase {
  override func setUp() async throws {
    try await FakeDaemon.reset()
  }

  @MainActor
  func testSnoozeSurvivesRelaunch() async throws {
    try await FakeDaemon.scenario("thread-state")
    let app = UITestApp.make(appearance: "light")
    app.launch()
    defer { app.terminate() }
    XCTAssertTrue(UITestApp.shellElement(app).waitForExistence(timeout: UITestApp.timeout), "the shell never appeared")
    let danielRow = ID.rowPrefix + QueueUI.daniel
    let priyaRow = ID.rowPrefix + QueueUI.priya
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.label(app, danielRow).contains("Snoozed until") },
      "hydrate: Daniel's row reads \(QueueUI.label(app, danielRow))")

    // H snoozes Priya's open thread in Triage: one PUT, the act only.
    app.typeKey("t", modifierFlags: .command)
    XCTAssertTrue(QueueUI.waitUntil { QueueUI.element(app, ID.triageBar).exists }, "triage: no triage bar")
    QueueUI.open(app, QueueUI.priya)
    app.typeKey("h", modifierFlags: [])
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.label(app, priyaRow).contains("Snoozed until") }, "snooze: row reads \(QueueUI.label(app, priyaRow))")
    var puts: [FakeDaemon.Request] = []
    for _ in 0..<40 where puts.isEmpty {
      puts = QueueUI.stateWrites(try await FakeDaemon.journal().requests)
      if puts.isEmpty { try await Task.sleep(nanoseconds: 250_000_000) }
    }
    XCTAssertEqual(puts.count, 1, "snooze: thread-state writes \(puts)")
    XCTAssertEqual(puts.first?.path, "/v1/threads/SMS%3B-%3B%2B15550100004/state")
    XCTAssertEqual(puts.first?.status, 200)
    XCTAssertEqual(puts.first?.bodyKeys, ["act", "ifUpdatedAt", "snoozedUntil"])
    XCTAssertFalse(QueueUI.element(app, ID.threadStateFailure).exists, "D-UI-192: a saved act drew a line")

    // Quit and launch again against the same fake daemon: both snoozes
    // come back from the daemon, and the relaunch writes nothing.
    app.terminate()
    app.launch()
    XCTAssertTrue(UITestApp.shellElement(app).waitForExistence(timeout: UITestApp.timeout), "relaunch: the shell never appeared")
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.label(app, priyaRow).contains("Snoozed until") },
      "relaunch: Priya's row reads \(QueueUI.label(app, priyaRow))")
    XCTAssertTrue(
      QueueUI.label(app, danielRow).contains("Snoozed until"), "relaunch: Daniel's row reads \(QueueUI.label(app, danielRow))")
    try await QueueUI.assertJournal("thread state relaunch")
    XCTAssertEqual(QueueUI.stateWrites(try await FakeDaemon.journal().requests).count, 1, "the relaunch wrote thread state")
  }

  @MainActor
  func testReasonLineShowsRule() async throws {
    try await FakeDaemon.scenario("pending")
    let app = UITestApp.make(appearance: "light")
    app.launch()
    defer { app.terminate() }
    let lens = QueueUI.element(app, ID.lensNeedsYou)
    XCTAssertTrue(lens.waitForExistence(timeout: UITestApp.timeout), "no Needs You segment")
    lens.click()
    // Maya's draft came from rule rul-0201, which the shell cannot name.
    let mayaRow = ID.rowPrefix + QueueUI.maya
    let rule = ProvisionalUI.ruleLine(nil)
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.label(app, mayaRow).contains(rule) }, "needsyou: Maya's row reads \(QueueUI.label(app, mayaRow))")
    // D-UI-193: Triage draws no reason line.
    app.typeKey("t", modifierFlags: .command)
    XCTAssertTrue(QueueUI.waitUntil { QueueUI.element(app, ID.triageBar).exists }, "triage: no triage bar")
    XCTAssertTrue(
      QueueUI.waitUntil { !QueueUI.label(app, mayaRow).contains(rule) }, "triage: Maya's row reads \(QueueUI.label(app, mayaRow))")
    try await QueueUI.assertJournal("reason line")
  }
}
