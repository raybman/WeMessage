import AppKit
import Foundation
import XCTest

/// v2 S4h2: board 12, onboarding. One launch per appearance, no more (the
/// UI job's time budget): WEMESSAGE_UI_BOARD=12 opens the onboarding window
/// over a memory store and the fixture Full Disk Access seam, which grants
/// on its second probe and opens nothing. The launch steps 12.1 to 12.6,
/// setup complete and 12.I, a shot per step:
/// - 2a is board 10's FDA screen; Open asks the seam and the app stays up;
/// - 2b polls every 2 s; the grant lands on 2c and the poll stops there:
///   the probe count holds still past another interval;
/// - step 6 opens with no drafting selected and every channel box off;
/// - 12.I widens the rail to 200 pt with the voice dock at its foot and the
///   coach row under the panes; a plain "x" dismisses the coach row (any
///   key, not only Escape) and leaves the rail wide; a tile click narrows it.
/// The light launch runs the accessibility audit. Every launch ends on the
/// journal: no send, no draft action, no write. Shots are
/// board-12-<step>-<appearance>.png. CI only.
final class Board12Tests: XCTestCase {
  override func setUp() async throws {
    try await FakeDaemon.reset()
  }

  static let channels = ["imessage", "whatsapp", "linkedin", "email"]

  @MainActor
  func testBoard12Light() async throws {
    try await onboarding(appearance: "light")
  }

  @MainActor
  func testBoard12Dark() async throws {
    try await onboarding(appearance: "dark")
  }

  @MainActor
  private func page(_ app: XCUIApplication, _ slug: String) -> XCUIElement {
    QueueUI.element(app, ID.onboardingPagePrefix + slug)
  }

  /// Clicks the page's one forward button and waits for the next page.
  @MainActor
  private func next(_ app: XCUIApplication, to slug: String) {
    QueueUI.element(app, ID.onboardingNext).click()
    XCTAssertTrue(page(app, slug).waitForExistence(timeout: UITestApp.timeout), "never reached \(slug)")
  }

  @MainActor
  private func railWidth(_ app: XCUIApplication) -> CGFloat {
    let rail = QueueUI.element(app, ID.rail)
    return rail.exists ? rail.frame.width : -1
  }

  @MainActor
  private func onboarding(appearance: String) async throws {
    try await FakeDaemon.scenario("rich")
    let app = UITestApp.make(appearance: appearance, reduceTransparency: false, board: "12")
    app.launch()
    defer { app.terminate() }
    let window = QueueUI.element(app, ID.onboarding)
    XCTAssertTrue(window.waitForExistence(timeout: UITestApp.timeout), "the onboarding window never appeared")
    XCTAssertFalse(UITestApp.shellElement(app).exists, "the shell is drawn beside onboarding")
    let started = Date()
    let light = appearance == "light"
    let shot: (String) -> Void = { step in
      QueueUI.settle()
      self.glance(app, name: "board-12-\(step)-\(appearance).png")
    }

    // 12.A, step 1: four cards, each its own Connect and Skip.
    XCTAssertTrue(page(app, "1").waitForExistence(timeout: UITestApp.timeout), "no step 1")
    XCTAssertEqual(QueueUI.label(app, ID.onboardingStep), "Step 1 of 6 \u{00B7} Connect channels")
    for channel in Self.channels {
      XCTAssertTrue(QueueUI.element(app, ID.onboardingCardPrefix + channel).exists, "no \(channel) card")
      XCTAssertTrue(QueueUI.element(app, ID.onboardingConnectPrefix + channel).exists, "\(channel): no Connect")
      XCTAssertTrue(QueueUI.element(app, ID.onboardingSkipPrefix + channel).exists, "\(channel): no Skip")
    }
    XCTAssertEqual(QueueUI.label(app, ID.onboardingNext), "Continue with 0 connected")
    shot("1")
    if light { try audit(app, window: "audit-board-12-1") }
    QueueUI.printTime("BOARD12", appearance, "1", since: started)

    // 12.B, 2a: board 10's FDA screen; Open asks the fixture seam only.
    next(app, to: "2a")
    // FDAScreen's own identifier is folded into the page's on 2a, so the
    // screen is known by its two controls.
    XCTAssertTrue(QueueUI.element(app, ID.fdaOpen).exists, "2a: no Open System Settings")
    XCTAssertTrue(QueueUI.element(app, ID.fdaSkip).exists, "2a: no Skip")
    XCTAssertEqual(QueueUI.value(app, ID.fdaOpen), "asked 0")
    shot("2a")
    QueueUI.element(app, ID.fdaOpen).click()

    // 2b: waiting, polling every 2 s; the fixture grants on probe 2.
    XCTAssertTrue(page(app, "2b").waitForExistence(timeout: UITestApp.timeout), "Open never reached 2b")
    XCTAssertTrue(app.state == .runningForeground, "Open left the app")
    let waiting = QueueUI.value(app, ID.onboardingOpenAgain)
    XCTAssertTrue(waiting.hasPrefix("asked 1, probes "), "2b: \(waiting)")
    XCTAssertTrue(waiting.hasSuffix("polling on"), "2b: \(waiting)")
    shot("2b")
    QueueUI.printTime("BOARD12", appearance, "2b", since: started)

    // 2c: the grant stopped the poll; another interval probes nothing.
    XCTAssertTrue(page(app, "2c").waitForExistence(timeout: UITestApp.timeout), "the poll never reached 2c")
    XCTAssertEqual(QueueUI.label(app, ID.onboardingStep), "Step 2 of 6 \u{00B7} access granted")
    XCTAssertEqual(QueueUI.value(app, ID.onboardingNext), "probes 2, polling off")
    try await Task.sleep(for: .milliseconds(2500))
    XCTAssertEqual(QueueUI.value(app, ID.onboardingNext), "probes 2, polling off", "the poll probed after the grant")
    XCTAssertTrue(QueueUI.label(app, ID.onboardingSizing).contains("messages"), "2c: \(QueueUI.label(app, ID.onboardingSizing))")
    shot("2c")
    if light { try audit(app, window: "audit-board-12-2c") }
    QueueUI.printTime("BOARD12", appearance, "2c", since: started)

    // CopyProgress, then steps 3 to 5: each a disclosure and its Skip.
    next(app, to: "2c-copy")
    XCTAssertTrue(QueueUI.element(app, ID.onboardingProgress).exists, "no CopyProgress")
    shot("2c-copy")
    next(app, to: "3")
    for (slug, following) in [("3", "4"), ("4", "5"), ("5", "6")] {
      XCTAssertEqual(QueueUI.label(app, ID.onboardingStep), "Step \(slug) of 6")
      XCTAssertTrue(QueueUI.element(app, ID.onboardingNotBuilt).exists, "\(slug): no not-built line")
      XCTAssertTrue(QueueUI.label(app, ID.onboardingNext).hasPrefix("Skip "), "\(slug): \(QueueUI.label(app, ID.onboardingNext))")
      shot(slug)
      next(app, to: following)
    }
    QueueUI.printTime("BOARD12", appearance, "5", since: started)

    // 12.F, step 6: no drafting is the default; no channel box is ticked
    // or tickable; KillIntro is drawn.
    XCTAssertEqual(QueueUI.value(app, ID.onboardingAgentOff), "selected", "AgentStep did not open on no drafting")
    XCTAssertNotEqual(QueueUI.value(app, ID.onboardingAgentDraft), "selected", "AgentStep opened on drafting")
    for channel in Self.channels {
      let box = QueueUI.element(app, ID.onboardingAgentChannelPrefix + channel)
      XCTAssertEqual(QueueUI.value(app, ID.onboardingAgentChannelPrefix + channel), "off", "\(channel): ticked by default")
      XCTAssertFalse(box.isEnabled, "\(channel): tickable while drafting is off")
    }
    XCTAssertTrue(QueueUI.element(app, ID.onboardingKill).exists, "no KillIntro")
    shot("6")
    if light { try audit(app, window: "audit-board-12-6") }
    QueueUI.printTime("BOARD12", appearance, "6", since: started)

    // 12.G: setup complete, a line per channel.
    next(app, to: "done")
    XCTAssertEqual(QueueUI.label(app, ID.onboardingStep), "Setup complete")
    XCTAssertTrue(QueueUI.element(app, ID.onboardingDone).exists, "no setup lines")
    shot("done")

    // 12.I: the first thread, the rail at 200 pt, the coach row.
    QueueUI.element(app, ID.onboardingNext).click()
    XCTAssertTrue(UITestApp.shellElement(app).waitForExistence(timeout: UITestApp.timeout), "Open inbox opened no shell")
    let coach = QueueUI.element(app, ID.coach)
    XCTAssertTrue(coach.waitForExistence(timeout: UITestApp.timeout), "12.I: no coach row")
    XCTAssertTrue(QueueUI.element(app, ID.voiceDock).exists, "12.I: no voice dock")
    XCTAssertEqual(railWidth(app), 200, accuracy: 2, "12.I: the rail is not 200 pt")
    shot("I")
    if light { try audit(app, window: "audit-board-12-I") }

    // Any key: a plain x, not Escape, dismisses the coach row, once.
    app.typeKey("x", modifierFlags: [])
    XCTAssertTrue(QueueUI.waitUntil { !QueueUI.element(app, ID.coach).exists }, "x left the coach row up")
    XCTAssertEqual(railWidth(app), 200, accuracy: 2, "a key narrowed the rail")
    shot("I-dismissed")
    // The first tile click narrows the rail to its resting width.
    QueueUI.element(app, ID.railIMessage).click()
    XCTAssertTrue(QueueUI.waitUntil { abs(self.railWidth(app) - 58) <= 2 }, "a tile click left the rail at \(railWidth(app))")
    XCTAssertFalse(QueueUI.element(app, ID.voiceDock).exists, "the voice dock outlived the wide rail")

    QueueUI.printTime("BOARD12", appearance, "I", since: started)
    try await QueueUI.assertJournal("board 12 \(appearance)")
  }
}
