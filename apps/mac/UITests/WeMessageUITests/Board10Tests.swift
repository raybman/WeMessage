import AppKit
import Foundation
import XCTest

/// v2 S4h1: board 10, the states. Two launches per appearance, no more
/// (the UI job's time budget):
/// - degraded: the fake daemon's "degraded" scenario raises the trust
///   banner (10.A); its one action pins the per-channel ages, where the
///   unconnected channels say not connected and show no number. Then
///   "fda-denied" and the reload key: the thread list is
///   source-unavailable after a readable scan, so the revoked banner shows
///   (10.C); Fix opens the Full Disk Access screen, and Open asks the
///   fixture seam, which opens nothing.
/// - empties: WEMESSAGE_UI_BOARD=10.B opens the states sheet, the six
///   empties stacked (10.B), each its own cause and exactly one action;
///   then its Settings page, the ages, pacing and collision (10.A, 10.D,
///   10.E).
/// The light launches run the accessibility audit. Every launch ends on the
/// journal: no send, no draft action, no write. Shots are
/// board-10-<state>-<appearance>.png. CI only.
final class Board10Tests: XCTestCase {
  override func setUp() async throws {
    try await FakeDaemon.reset()
  }

  /// The six cases' raw values, in the sheet's order.
  static let empties = ["zero", "quiet", "unselected", "search", "unconnected", "new"]
  /// The scopes the age table names beside iMessage.
  static let unconnected = ["whatsapp", "linkedin", "email"]
  /// 10.C's four headings.
  static let headings = ["What it grants", "Why we need it", "What we do with it", "What we never do"]

  @MainActor
  func testBoard10Light() async throws {
    try await degraded(appearance: "light")
  }

  @MainActor
  func testBoard10Dark() async throws {
    try await degraded(appearance: "dark")
  }

  @MainActor
  func testBoard10EmptiesLight() async throws {
    try await empties(appearance: "light")
  }

  @MainActor
  func testBoard10EmptiesDark() async throws {
    try await empties(appearance: "dark")
  }

  @MainActor
  private func shown(_ app: XCUIApplication, _ words: String) -> Bool {
    app.descendants(matching: .any).matching(NSPredicate(format: "label == %@ OR value == %@", words, words)).count > 0
  }

  @MainActor
  private func degraded(appearance: String) async throws {
    try await FakeDaemon.scenario("degraded")
    let app = UITestApp.make(appearance: appearance, reduceTransparency: false)
    app.launch()
    defer { app.terminate() }
    XCTAssertTrue(UITestApp.shellElement(app).waitForExistence(timeout: UITestApp.timeout), "the shell never appeared")
    let geometry = settledGeometry(app)
    let started = Date()
    let luminance: (Double) -> Void = { mean in
      if appearance == "light" {
        XCTAssertGreaterThan(mean, 0.6, "a light board 10 renders dark: mean luminance \(mean)")
      } else {
        XCTAssertLessThan(mean, 0.4, "a dark board 10 renders light: mean luminance \(mean)")
      }
    }

    // 10.A: the trust banner names the channel and since when, in words.
    let banner = QueueUI.element(app, ID.trustBanner)
    XCTAssertTrue(banner.waitForExistence(timeout: UITestApp.timeout), "degraded: no trust banner")
    let line = QueueUI.label(app, ID.trustBanner)
    XCTAssertTrue(line.hasPrefix("iMessage has not synced since "), "trust banner: \(line)")
    XCTAssertTrue(line.hasSuffix("You may be missing messages."), "trust banner: \(line)")
    XCTAssertEqual(QueueUI.value(app, ID.railIMessage), "stale")
    XCTAssertFalse(QueueUI.element(app, ID.fda).exists, "the FDA screen while the source is readable")
    QueueUI.settle()
    capture(
      app, geometry: geometry, appearance: appearance, frost: true, name: "board-10-degraded-\(appearance).png",
      layout: .banner, luminance: luminance)
    QueueUI.printTime("BOARD10", appearance, "degraded", since: started)

    // The banner's one action pins the ages.
    let action = QueueUI.element(app, ID.trustAction)
    XCTAssertEqual(QueueUI.label(app, ID.trustAction), ProvisionalUI.trustBannerAction)
    action.click()
    XCTAssertTrue(QueueUI.element(app, ID.freshness).waitForExistence(timeout: UITestApp.timeout), "no age table")
    let imessage = QueueUI.label(app, ID.freshnessRowPrefix + "imessage")
    XCTAssertTrue(imessage.contains("STALE"), "iMessage row: \(imessage)")
    for scope in Self.unconnected {
      let row = QueueUI.label(app, ID.freshnessRowPrefix + scope)
      XCTAssertTrue(row.contains("not connected"), "\(scope) row: \(row)")
      XCTAssertNil(row.rangeOfCharacter(from: .decimalDigits), "\(scope) shows a number: \(row)")
    }
    let footer = QueueUI.label(app, ID.freshnessFooter)
    XCTAssertTrue(footer.hasPrefix("CANNOT SAY iMessage stale since "), "foot: \(footer)")
    QueueUI.settle()
    glance(app, name: "board-10-ages-\(appearance).png")
    if appearance == "light" { try audit(app, window: "audit-board-10-ages") }
    action.click()
    XCTAssertTrue(QueueUI.waitUntil { !QueueUI.element(app, ID.freshness).exists }, "the ages never closed")

    // 10.C: the source goes unreadable after a readable scan.
    try await FakeDaemon.scenario("fda-denied")
    app.typeKey("r", modifierFlags: [.command, .option])
    let revoked = QueueUI.element(app, ID.revokedBanner)
    XCTAssertTrue(revoked.waitForExistence(timeout: UITestApp.timeout), "fda-denied: no revoked banner")
    XCTAssertFalse(QueueUI.element(app, ID.trustBanner).exists, "the trust banner beside the revoked one")
    XCTAssertFalse(QueueUI.element(app, ID.fda).exists, "the FDA screen before Fix")
    QueueUI.settle()
    glance(app, name: "board-10-revoked-\(appearance).png")
    QueueUI.printTime("BOARD10", appearance, "revoked", since: started)

    QueueUI.element(app, ID.revokedFix).click()
    XCTAssertTrue(QueueUI.element(app, ID.fda).waitForExistence(timeout: UITestApp.timeout), "Fix opened no FDA screen")
    for heading in Self.headings {
      XCTAssertTrue(shown(app, heading), "FDA screen: no heading \(heading)")
    }
    XCTAssertEqual(QueueUI.value(app, ID.fdaOpen), "asked 0")
    QueueUI.settle()
    glance(app, name: "board-10-fda-\(appearance).png")
    let png = app.windows.firstMatch.screenshot().pngRepresentation
    XCTAssertGreaterThan(
      NoGreen.tinted(png, hue: NoGreen.tintHue, tolerance: 15, minSaturation: 0.5), 0, "FDA screen: no tint on screen")
    if appearance == "light" { try audit(app, window: "audit-board-10-fda") }
    // Open asks the seam; the fixture counts and opens nothing.
    QueueUI.element(app, ID.fdaOpen).click()
    XCTAssertTrue(QueueUI.waitUntil { QueueUI.value(app, ID.fdaOpen) == "asked 1" }, "Open: \(QueueUI.value(app, ID.fdaOpen))")
    XCTAssertTrue(app.state == .runningForeground, "Open left the app")
    QueueUI.element(app, ID.fdaSkip).click()
    XCTAssertTrue(QueueUI.waitUntil { !QueueUI.element(app, ID.fda).exists }, "Skip left the FDA screen up")

    QueueUI.printTime("BOARD10", appearance, "fda", since: started)
    try await QueueUI.assertJournal("board 10 \(appearance)")
  }

  @MainActor
  private func empties(appearance: String) async throws {
    try await FakeDaemon.scenario("rich")
    let app = UITestApp.make(appearance: appearance, reduceTransparency: false, board: "10.B")
    app.launch()
    defer { app.terminate() }
    let sheet = app.descendants(matching: .any)[ID.states]
    XCTAssertTrue(sheet.waitForExistence(timeout: UITestApp.timeout), "the states sheet never appeared")
    XCTAssertFalse(UITestApp.shellElement(app).exists, "the shell is drawn beside the states sheet")
    let started = Date()
    XCTAssertTrue(
      QueueUI.element(app, ID.statesPagePrefix + "empties").waitForExistence(timeout: UITestApp.timeout), "no empties page")

    // 10.B: six cards, six causes, one action each, none generic.
    var headlines: [String] = []
    for raw in Self.empties {
      let card = QueueUI.element(app, ID.emptyPrefix + raw)
      XCTAssertTrue(card.exists, "no \(raw) empty")
      let headline = QueueUI.label(app, ID.emptyPrefix + raw)
      headlines.append(headline)
      XCTAssertNotEqual(headline.lowercased(), "nothing here", "\(raw): a generic empty")
      XCTAssertEqual(QueueUI.count(app, containing: ID.emptyPrefix + raw + "."), 1, "\(raw): not exactly one action")
      let label = QueueUI.label(app, ID.emptyPrefix + raw + ".action")
      if raw == "unconnected" {
        XCTAssertTrue(label.hasPrefix("Connect "), "\(raw): \(label)")
        XCTAssertNil(headline.rangeOfCharacter(from: .decimalDigits), "the not-connected empty shows a number: \(headline)")
      } else {
        XCTAssertEqual(label, ProvisionalUI.emptyActions[raw], "\(raw): action \(label)")
      }
    }
    XCTAssertEqual(Set(headlines).count, 6, "two empties share a headline: \(headlines)")
    QueueUI.settle()
    glance(app, name: "board-10-empties-\(appearance).png")
    if appearance == "light" { try audit(app, window: "audit-board-10-empties") }
    QueueUI.printTime("BOARD10", appearance, "empties", since: started)

    // The Settings copy: the ages, pacing and the collision notice.
    QueueUI.element(app, ID.statesTabPrefix + "settings").click()
    XCTAssertTrue(
      QueueUI.element(app, ID.statesPagePrefix + "settings").waitForExistence(timeout: UITestApp.timeout),
      "no settings page")
    XCTAssertTrue(QueueUI.label(app, ID.freshnessRowPrefix + "imessage").contains("live"))
    for scope in Self.unconnected {
      let row = QueueUI.label(app, ID.freshnessRowPrefix + scope)
      XCTAssertTrue(row.contains("not connected"), "\(scope) row: \(row)")
      XCTAssertNil(row.rangeOfCharacter(from: .decimalDigits), "\(scope) shows a number: \(row)")
    }
    XCTAssertTrue(QueueUI.label(app, ID.freshnessFooter).hasPrefix("Mirrored as of "))
    XCTAssertTrue(QueueUI.element(app, ID.pacing).exists, "no pacing table")
    XCTAssertTrue(QueueUI.label(app, ID.collision).contains("Your typing wins."), "collision: \(QueueUI.label(app, ID.collision))")
    QueueUI.settle()
    glance(app, name: "board-10-settings-\(appearance).png")
    QueueUI.printTime("BOARD10", appearance, "settings", since: started)
    try await QueueUI.assertJournal("board 10 empties \(appearance)")
  }
}
