import AppKit
import Foundation
import XCTest

/// v2 B0: board 03, WhatsApp, drawn over fixtures. The fake daemon's
/// "preview-whatsapp" scenario says the channel is in the fixture state,
/// and only the UI-test flag opens the gate that reads it (H-B-1).
/// One launch per appearance: cmd-3 selects the WhatsApp tile.
///
/// What is checked: the rail draws WhatsApp's mark as a connected channel's
/// (D-UI-140: clear, on the quiet scenario's fresh scan); the pane is board
/// 03, its banner (D-UI-135) carrying the fixture chip at its trailing edge
/// (D-UI-132), over the New here empty state; the not-connected zero and
/// its connect card are not drawn. The other two channels stay silent.
/// Shots are board-03-preview-<appearance>.png, swept for green and held to
/// the frost evidence under the banner. The journal holds no write.
/// The light launch also runs the accessibility audit. CI only.
final class Board03Tests: XCTestCase {
  override func setUp() async throws {
    try await FakeDaemon.reset()
  }

  @MainActor
  func testPreviewEmptyStateLight() async throws {
    try await previewEmptyState(appearance: "light") { mean in
      XCTAssertGreaterThan(mean, 0.6, "a light board 03 renders dark: mean luminance \(mean)")
    }
  }

  @MainActor
  func testPreviewEmptyStateDark() async throws {
    try await previewEmptyState(appearance: "dark") { mean in
      XCTAssertLessThan(mean, 0.4, "a dark board 03 renders light: mean luminance \(mean)")
    }
  }

  @MainActor
  private func previewEmptyState(appearance: String, luminance: (Double) -> Void) async throws {
    try await FakeDaemon.scenario("preview-whatsapp")
    let app = UITestApp.make(appearance: appearance, reduceTransparency: false)
    app.launch()
    defer { app.terminate() }
    XCTAssertTrue(UITestApp.shellElement(app).waitForExistence(timeout: UITestApp.timeout), "the shell never appeared")
    let geometry = settledGeometry(app)
    let started = Date()

    // The rail: WhatsApp draws a mark as a connected channel would; the two
    // channels still not connected say nothing.
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.value(app, ID.railWhatsApp) == "clear" },
      "rail: WhatsApp reads '\(QueueUI.value(app, ID.railWhatsApp))'")
    for id in [ID.railLinkedIn, ID.railEmail] {
      XCTAssertEqual(QueueUI.value(app, id), "", "rail: \(id) is not connected and must say nothing")
    }

    app.typeKey("3", modifierFlags: .command)
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.element(app, ID.whatsAppBoard).exists }, "board 03 never appeared on cmd-3")
    XCTAssertEqual(QueueUI.label(app, ID.whatsAppBanner), ProvisionalUI.whatsAppBannerName, "banner")
    XCTAssertTrue(QueueUI.element(app, ID.fixtureChip).exists, "the fixture chip is missing")
    XCTAssertFalse(QueueUI.label(app, ID.fixtureChip).isEmpty, "the fixture chip says nothing")
    XCTAssertEqual(QueueUI.label(app, ID.whatsAppEmpty), ProvisionalUI.whatsAppEmptyHeadline, "empty state")
    XCTAssertFalse(QueueUI.element(app, ID.zero).exists, "the not-connected zero is drawn under board 03")
    XCTAssertFalse(QueueUI.element(app, ID.connectCard).exists, "a connect card is drawn under board 03")
    XCTAssertEqual(QueueUI.value(app, ID.railWhatsApp), "clear", "rail: WhatsApp lost its mark on select")

    QueueUI.settle()
    capture(
      app, geometry: geometry, appearance: appearance, frost: true, name: "board-03-preview-\(appearance).png",
      layout: .banner, luminance: luminance)
    QueueUI.printTime("BOARD03", appearance, "preview", since: started)
    if appearance == "light" { try audit(app, window: "audit-board-03-preview") }

    try await QueueUI.assertJournal("board 03 \(appearance)")
  }
}
