import AppKit
import Foundation
import XCTest

/// v2 S4f: board 09, Needs You, the undo window, bulk approval, the audit
/// view and the kill switch, from the fake daemon's "pending" scenario and
/// then "kill". One launch per appearance: every state is a key press, a
/// click, or a scenario switch plus the test-only reload key (cmd-opt-R).
/// Shots are board-09-<state>-<appearance>.png. The bulk card and the audit
/// table are opaque over the frost probe patches, so those two are glanced
/// (attached and swept for green) rather than held to the frost evidence.
///
/// The thread is Priya's: it is short, so the stripe patch above it stays
/// bare pane (Maya's longer thread covered it, run 37717485936), and Maya's
/// draft, never opened, is the one the bulk card leaves out.
///
/// The behaviour rows ride in the same launch (the UI job's time budget):
/// - Return outside the bulk card does nothing (09.D: bare Return is the
///   bulk card's alone);
/// - A starts the 10 s window and Z inside it recalls the approval;
/// - shift-A's card includes only drafts whose body was drawn and gives
///   the others a reason; Return confirms it, one Z undoes the whole batch;
/// - the kill switch removes Approve, Edit and Hold (absent, not greyed),
///   prints the banner, dims the composer to its reason, and holds the
///   draft; A, shift-A and Return do nothing under it;
/// - Disengage posts the toggle and the banner goes.
/// The journal at the end holds no send, no draft action, no read state,
/// and exactly one kill switch post. The light launch also runs the
/// accessibility audit at the Needs You and kill states.
/// CI only.
final class Board09Tests: XCTestCase {
  override func setUp() async throws {
    try await FakeDaemon.reset()
  }

  /// ComposerView.killHint, the wireframe's own words (09.F).
  static let killHint = "You can still read."

  @MainActor
  func testBoard09Light() async throws {
    try await board09(appearance: "light") { mean in
      XCTAssertGreaterThan(mean, 0.6, "a light board 09 renders dark: mean luminance \(mean)")
    }
  }

  @MainActor
  func testBoard09Dark() async throws {
    try await board09(appearance: "dark") { mean in
      XCTAssertLessThan(mean, 0.4, "a dark board 09 renders light: mean luminance \(mean)")
    }
  }

  @MainActor
  private func board09(appearance: String, luminance: (Double) -> Void) async throws {
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
        app, geometry: geometry, appearance: appearance, frost: true, name: "board-09-\(state)-\(appearance).png",
        layout: layout, luminance: luminance)
      QueueUI.printTime("BOARD09", appearance, state, since: started)
    }
    let priya = QueueUI.priyaDraft
    let approve = ID.draftVerb(priya, "approve")
    func meta() -> String { QueueUI.meta(app, priya) }

    // needsyou: the lens, the bulk strip, Priya's draft with its long meta
    // line, the rationale and the three verbs.
    let lens = QueueUI.element(app, ID.lensNeedsYou)
    XCTAssertTrue(lens.waitForExistence(timeout: UITestApp.timeout), "no Needs You segment")
    lens.click()
    XCTAssertTrue(QueueUI.waitUntil { QueueUI.element(app, ID.bulkStrip).exists }, "needsyou: no bulk strip")
    QueueUI.open(app, QueueUI.priya)
    XCTAssertTrue(QueueUI.waitUntil { QueueUI.element(app, approve).exists }, "needsyou: no Approve on Priya's draft")
    for verb in ["edit", "hold", "why"] {
      XCTAssertTrue(QueueUI.element(app, ID.draftVerb(priya, verb)).exists, "needsyou: no \(verb)")
    }
    XCTAssertTrue(meta().hasPrefix("DRAFT \u{00B7} proposed by sol-main "), "needsyou: meta reads \(meta())")
    XCTAssertTrue(meta().contains("not sent"), "needsyou: meta reads \(meta())")
    shoot("needsyou", .thread)
    if appearance == "light" { try audit(app, window: "audit-board-09-needsyou") }

    // Bare Return outside the bulk card: nothing starts.
    app.typeKey(.return, modifierFlags: [])
    try await Task.sleep(nanoseconds: 500_000_000)
    XCTAssertTrue(meta().hasPrefix("DRAFT"), "Return approved: meta reads \(meta())")
    XCTAssertFalse(QueueUI.element(app, ID.undoRing).exists, "Return started a batch")

    // approved: A starts the window; nothing reaches the daemon; Z recalls.
    app.typeKey("a", modifierFlags: [])
    XCTAssertTrue(QueueUI.waitUntil { meta().hasPrefix("APPROVED by you ") }, "approved: meta reads \(meta())")
    XCTAssertFalse(QueueUI.element(app, approve).exists, "approved: Approve is still drawn inside the window")
    shoot("approved", .thread)
    try await QueueUI.assertJournal("inside the approve window")
    app.typeKey("z", modifierFlags: [])
    XCTAssertTrue(QueueUI.waitUntil { meta().hasPrefix("DRAFT") }, "recall: meta reads \(meta())")
    XCTAssertTrue(QueueUI.waitUntil { QueueUI.element(app, approve).exists }, "recall: Approve did not come back")

    // bulk: shift-A. Priya's draft was drawn and is included; Maya's never
    // was and is excluded with its reason. Return confirms; one Z undoes.
    app.typeKey("a", modifierFlags: .shift)
    XCTAssertTrue(QueueUI.waitUntil { QueueUI.element(app, ID.bulkSheet).exists }, "bulk: no confirm card")
    XCTAssertTrue(QueueUI.element(app, ID.bulkIncludedPrefix + priya).exists, "bulk: Priya's drawn draft is not included")
    XCTAssertFalse(
      QueueUI.element(app, ID.bulkIncludedPrefix + QueueUI.mayaDraft).exists, "bulk: Maya's undrawn draft is included")
    let excluded = QueueUI.label(app, ID.bulkExcludedPrefix + QueueUI.mayaDraft)
    XCTAssertTrue(excluded.contains("not yet shown"), "bulk: Maya's exclusion reads \(excluded)")
    XCTAssertTrue(QueueUI.label(app, ID.bulkConfirm).hasPrefix("Approve 1"), "bulk: confirm reads \(QueueUI.label(app, ID.bulkConfirm))")
    glance(app, name: "board-09-bulk-\(appearance).png")
    app.typeKey(.return, modifierFlags: [])
    XCTAssertTrue(QueueUI.waitUntil { QueueUI.element(app, ID.undoRing).exists }, "bulk: Return did not start the batch")
    XCTAssertFalse(QueueUI.element(app, ID.bulkSheet).exists, "bulk: the card stayed open")
    try await QueueUI.assertJournal("inside the batch window")
    app.typeKey("z", modifierFlags: [])
    XCTAssertTrue(QueueUI.waitUntil { !QueueUI.element(app, ID.undoRing).exists }, "bulk: Z left the ring")
    XCTAssertTrue(QueueUI.waitUntil { meta().hasPrefix("DRAFT") }, "bulk undo: meta reads \(meta())")

    // audit: the chain, oldest first.
    QueueUI.element(app, ID.auditOpen).click()
    XCTAssertTrue(QueueUI.waitUntil { QueueUI.element(app, ID.audit).exists }, "audit: no audit view")
    // The rich audit golden holds seq 102 to 108: rows are keyed by seq.
    let oldest = QueueUI.element(app, ID.auditRowPrefix + "102")
    let newest = QueueUI.element(app, ID.auditRowPrefix + "108")
    XCTAssertTrue(QueueUI.waitUntil { oldest.exists && newest.exists }, "audit: rows 102 and 108 are not both drawn")
    XCTAssertEqual(QueueUI.count(app, containing: ID.auditRowPrefix), 7, "audit: not the golden's seven rows")
    XCTAssertLessThan(oldest.frame.minY, newest.frame.minY, "audit: the chain is not oldest first")
    glance(app, name: "board-09-audit-\(appearance).png")
    QueueUI.element(app, ID.auditClose).click()
    XCTAssertTrue(QueueUI.waitUntil { !QueueUI.element(app, ID.audit).exists }, "audit: Close left it open")

    // kill: the switch goes on with Priya open. Every draft verb is absent,
    // the banner says so, the composer gives its reason, the draft is held.
    XCTAssertTrue(QueueUI.waitUntil { QueueUI.element(app, approve).exists }, "kill: Priya's draft is not open")
    try await FakeDaemon.scenario("kill")
    app.typeKey("r", modifierFlags: [.command, .option])
    XCTAssertTrue(QueueUI.waitUntil { QueueUI.element(app, ID.killBanner).exists }, "kill: no banner")
    XCTAssertEqual(QueueUI.label(app, ID.killBanner), ProvisionalUI.killBannerLine, "kill: banner reads")
    XCTAssertTrue(QueueUI.waitUntil { QueueUI.count(app, containing: ".approve") == 0 }, "kill: an approve identifier exists")
    for fragment in [".edit", ".hold", ID.composerSend, ID.bulkOpen, ID.release] {
      XCTAssertEqual(QueueUI.count(app, containing: fragment), 0, "kill: \(fragment) is placed under the kill switch")
    }
    // A Text's words reach XCUI as its value on macOS, its label empty.
    let hint = app.staticTexts.matching(
      NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", Self.killHint, Self.killHint)
    ).firstMatch
    XCTAssertTrue(hint.waitForExistence(timeout: UITestApp.timeout), "kill: the composer does not give its reason")
    XCTAssertTrue(QueueUI.waitUntil { meta().hasPrefix("HELD by kill switch") }, "kill: meta reads \(meta())")
    // A, shift-A and Return do nothing under the switch.
    app.typeKey("a", modifierFlags: [])
    app.typeKey("a", modifierFlags: .shift)
    app.typeKey(.return, modifierFlags: [])
    try await Task.sleep(nanoseconds: 500_000_000)
    XCTAssertFalse(QueueUI.element(app, ID.bulkSheet).exists, "kill: shift-A opened the card")
    XCTAssertFalse(QueueUI.element(app, ID.undoRing).exists, "kill: a batch started")
    XCTAssertTrue(meta().hasPrefix("HELD by kill switch"), "kill: a key changed the draft: \(meta())")
    // Escape climbs out of the thread; the banner stays.
    app.typeKey(.escape, modifierFlags: [])
    XCTAssertTrue(QueueUI.waitUntil { !QueueUI.element(app, ID.thread).exists }, "kill: Escape left the thread open")
    XCTAssertTrue(QueueUI.element(app, ID.killBanner).exists, "kill: the banner went with the thread")
    shoot("kill", .banner)
    if appearance == "light" { try audit(app, window: "audit-board-09-kill") }

    // Disengage: one toggle post, and the banner goes.
    QueueUI.element(app, ID.killDisengage).click()
    _ = try await FakeDaemon.waitForRequests(["POST /v1/toggles/kill-switch"])
    XCTAssertTrue(QueueUI.waitUntil { !QueueUI.element(app, ID.killBanner).exists }, "disengage: the banner stayed")

    try await QueueUI.assertJournal("board 09 \(appearance)", toggles: 1)
    print("BOARD09| \(appearance) states=3 glances=2 seconds=\(Int(Date().timeIntervalSince(started)))")
  }
}
