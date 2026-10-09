import AppKit
import Foundation
import XCTest

/// v2 B2: board 05, Email, drawn over fixtures. The fake daemon's
/// "preview-email" scenario says the channel is in the fixture state and
/// serves eight email threads; only the UI-test flag opens the gate that
/// reads it (H-B-1). One launch per appearance: cmd-5 selects the Email tile.
///
/// The launch walks the board:
/// - list: the rail's Email mark (clear), the banner with the account and
///   the fixture chip, the empty state, the category chips;
/// - chips (05.G): Paper trail leaves the two statements, and again clears;
/// - images (05.E): the newsletter's remote images are blocked, and the
///   journal holds no /remote-image/ request until Load images, after which
///   that message alone asks for them;
/// - invite (05.F): the invite drawn as an object card;
/// - wall (05.D): forwarding the site photos warns at 22.4 MB;
/// - thread (05.A): the Q3 thread as cards at the 68 character measure,
///   never bubbles, the earlier two folded;
/// - compose (05.B): shift-R opens Reply all, Hold until is parked, Send
///   opens the 30 s undo window, Undo writes nothing, Send again writes
///   exactly one POST /v1/drafts once the window runs out.
/// Shots are board-05-<state>-<appearance>.png. The light launch runs the
/// accessibility audit. The journal ends with one draft created, nothing
/// sent and no other write. CI only.
final class Board05Tests: XCTestCase {
  override func setUp() async throws {
    try await FakeDaemon.reset()
  }

  static let terms = "email;-;q3-terms"
  static let review = "email;-;design-review"
  static let weekly = "email;-;contoso-weekly"
  static let photos = "email;-;site-photos"
  static let statements = ["email;-;woodgrove-statement", "email;-;northwind-receipt"]
  static let reply = "Thanks, the revised schedule works. Signed copy by Friday."

  @MainActor
  func testBoard05Light() async throws {
    try await board(appearance: "light") { mean in
      XCTAssertGreaterThan(mean, 0.6, "a light board 05 renders dark: mean luminance \(mean)")
    }
  }

  @MainActor
  func testBoard05Dark() async throws {
    try await board(appearance: "dark") { mean in
      XCTAssertLessThan(mean, 0.4, "a dark board 05 renders light: mean luminance \(mean)")
    }
  }

  /// The writes the daemon has seen so far.
  private static func writes() async throws -> [String] {
    try await FakeDaemon.journal().requests.filter { $0.method != "GET" }.map(\.description)
  }

  /// Every remote image request so far.
  private static func remoteImages() async throws -> [String] {
    try await FakeDaemon.journal().requests.filter { $0.path.hasPrefix("/remote-image/") }.map(\.description)
  }

  /// The card measure (D-UI-136), from the same face the app draws.
  private static func cardWidth() -> Double {
    let zero = ("0" as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: ProvisionalUI.emailBodySize)])
    return (Double(zero.width) * ProvisionalUI.emailMeasureChars).rounded() + 2 * ProvisionalUI.emailCardPadding
  }

  /// Clicks the list row for `guid` and waits for its last message's card.
  @MainActor
  private func open(_ app: XCUIApplication, _ guid: String, last: String) {
    let row = QueueUI.element(app, ID.rowPrefix + guid)
    XCTAssertTrue(row.waitForExistence(timeout: UITestApp.timeout), "no list row for \(guid)")
    row.click()
    XCTAssertTrue(
      QueueUI.element(app, ID.emailCardPrefix + last).waitForExistence(timeout: UITestApp.timeout),
      "\(guid): no card for \(last); the thread is not drawn as cards")
  }

  @MainActor
  private func board(appearance: String, luminance: (Double) -> Void) async throws {
    try await FakeDaemon.scenario("preview-email")
    let app = UITestApp.make(appearance: appearance, reduceTransparency: false)
    app.launch()
    defer { app.terminate() }
    XCTAssertTrue(UITestApp.shellElement(app).waitForExistence(timeout: UITestApp.timeout), "the shell never appeared")
    let geometry = settledGeometry(app)
    let started = Date()
    let light = appearance == "light"
    let shot: (String) -> Void = { step in
      QueueUI.settle()
      self.glance(app, name: "board-05-\(step)-\(appearance).png")
    }

    // The rail: Email draws a mark as a connected channel would.
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.value(app, ID.railEmail) == "clear" },
      "rail: Email reads '\(QueueUI.value(app, ID.railEmail))'")

    // The list: board 05's banner with the fixture chip, over its empty state.
    app.typeKey("5", modifierFlags: .command)
    XCTAssertTrue(QueueUI.waitUntil { QueueUI.element(app, ID.emailBoard).exists }, "board 05 never appeared on cmd-5")
    XCTAssertEqual(QueueUI.label(app, ID.emailBanner), ProvisionalUI.emailBanner(account: "me@example.com"), "banner")
    XCTAssertTrue(QueueUI.element(app, ID.fixtureChip).exists, "the fixture chip is missing")
    XCTAssertEqual(QueueUI.label(app, ID.emailEmpty), ProvisionalUI.emailEmptyHeadline, "empty state")
    XCTAssertFalse(QueueUI.element(app, ID.zero).exists, "the not-connected zero is drawn under board 05")
    XCTAssertTrue(QueueUI.element(app, ID.rowPrefix + Self.terms).waitForExistence(timeout: UITestApp.timeout), "no list")
    QueueUI.settle()
    capture(
      app, geometry: geometry, appearance: appearance, frost: true, name: "board-05-list-\(appearance).png",
      layout: .banner, luminance: luminance)
    QueueUI.printTime("BOARD05", appearance, "list", since: started)

    // 05.G: one chip on filters the list; the same chip again clears it.
    let paper = QueueUI.element(app, ID.emailChipPrefix + "papertrail")
    XCTAssertTrue(paper.waitForExistence(timeout: UITestApp.timeout), "no category chips")
    paper.click()
    XCTAssertTrue(
      QueueUI.waitUntil { !QueueUI.element(app, ID.rowPrefix + Self.terms).exists },
      "Paper trail left a people thread in the list")
    for guid in Self.statements {
      XCTAssertTrue(QueueUI.element(app, ID.rowPrefix + guid).exists, "Paper trail hid \(guid)")
    }
    XCTAssertEqual(QueueUI.value(app, ID.emailChipPrefix + "papertrail"), "on")
    paper.click()
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.element(app, ID.rowPrefix + Self.terms).exists }, "the chip did not clear")
    XCTAssertEqual(QueueUI.value(app, ID.emailChipPrefix + "papertrail"), "off")

    // 05.E: blocked by default, and not one request until Load images.
    open(app, Self.weekly, last: "mail-0106")
    XCTAssertEqual(QueueUI.value(app, ID.emailImagesPrefix + "mail-0106"), "blocked", "remote images load by default")
    try await Task.sleep(for: .seconds(1))
    var images = try await Self.remoteImages()
    XCTAssertEqual(images, [], "remote images were requested before a reveal")
    shot("images-blocked")
    QueueUI.element(app, ID.emailLoadPrefix + "mail-0106").click()
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.value(app, ID.emailImagesPrefix + "mail-0106") == "loaded" },
      "Load images did not reveal: \(QueueUI.value(app, ID.emailImagesPrefix + "mail-0106"))")
    _ = try await FakeDaemon.waitForRequests(["GET /remote-image/contoso-hero.png"])
    images = try await Self.remoteImages()
    XCTAssertEqual(
      Set(images.map { String($0.split(separator: " ")[1]) }),
      ["/remote-image/contoso-hero.png", "/remote-image/contoso-card-1.png", "/remote-image/contoso-card-2.png"],
      "the reveal asked for more or less than its own images: \(images)")
    QueueUI.printTime("BOARD05", appearance, "images", since: started)

    // 05.F: the invite as an object card.
    open(app, Self.review, last: "mail-0105")
    XCTAssertTrue(QueueUI.element(app, ID.emailInvite).waitForExistence(timeout: UITestApp.timeout), "no invite card")
    shot("invite")

    // 05.D: forwarding 22.4 MB of photos warns, and the fixture's images
    // stay blocked in a thread never revealed.
    open(app, Self.photos, last: "mail-0110")
    QueueUI.element(app, ID.emailForward).click()
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.value(app, ID.emailCompose) == "forward" },
      "Forward opened \(QueueUI.value(app, ID.emailCompose))")
    XCTAssertEqual(QueueUI.value(app, ID.emailComposeWall), "warn", "22.4 MB does not warn")
    QueueUI.element(app, ID.emailComposeDiscard).click()
    XCTAssertTrue(QueueUI.waitUntil { !QueueUI.element(app, ID.emailCompose).exists }, "Discard left compose open")

    // 05.A: cards at the measure, never bubbles; the earlier two folded.
    open(app, Self.terms, last: "mail-0104")
    let card = QueueUI.element(app, ID.emailCardPrefix + "mail-0104")
    let width = Self.cardWidth()
    XCTAssertEqual(
      Double(card.frame.width), width, accuracy: 2,
      "the card is \(card.frame.width) pt wide, not the 68 character measure (\(width) pt)")
    XCTAssertFalse(QueueUI.element(app, ID.emailCardPrefix + "mail-0100").exists, "the earlier cards are not folded")
    XCTAssertFalse(QueueUI.element(app, ID.thread).exists, "a bubble thread is drawn under board 05")
    shot("thread")
    if light { try audit(app, window: "audit-board-05-thread") }
    QueueUI.printTime("BOARD05", appearance, "thread", since: started)

    // 05.B and 05.C: shift-R opens Reply all, the hold is parked.
    app.typeKey("r", modifierFlags: .shift)
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.value(app, ID.emailCompose) == "replyAll" },
      "shift-R opened \(QueueUI.value(app, ID.emailCompose))")
    XCTAssertEqual(QueueUI.value(app, ID.emailComposeHold), ProvisionalUI.emailHoldParked, "Hold until is not parked")
    XCTAssertEqual(app.datePickers.count, 0, "a date picker is drawn")
    XCTAssertFalse(QueueUI.value(app, ID.emailComposeTo).isEmpty, "Reply all left To empty")
    XCTAssertEqual(QueueUI.value(app, ID.emailComposeSend), "inert", "Send is live on an empty body")
    let body = QueueUI.element(app, ID.emailComposeBody)
    body.click()
    body.typeText(Self.reply)
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.value(app, ID.emailComposeSend) == "enabled" },
      "Send stays inert with a body: \(QueueUI.value(app, ID.emailComposeSend))")

    // The undo window: Undo inside it writes nothing.
    QueueUI.element(app, ID.emailComposeSend).click()
    let undo = QueueUI.element(app, ID.emailComposeUndo)
    XCTAssertTrue(undo.waitForExistence(timeout: UITestApp.timeout), "Send opened no undo window")
    XCTAssertEqual(QueueUI.value(app, ID.emailComposeState), "undo")
    shot("compose-undo")
    if light { try audit(app, window: "audit-board-05-compose") }
    undo.click()
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.value(app, ID.emailComposeState) == "composing" },
      "Undo left the state at \(QueueUI.value(app, ID.emailComposeState))")
    var seen = try await Self.writes()
    XCTAssertEqual(seen, [], "Undo still created a draft")
    QueueUI.printTime("BOARD05", appearance, "undo", since: started)

    // Send again: the 30 s window runs out and one draft is created.
    QueueUI.element(app, ID.emailComposeSend).click()
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.value(app, ID.emailComposeState) == "undo" },
      "Send again opened no window: \(QueueUI.value(app, ID.emailComposeState))")
    _ = try await FakeDaemon.waitForRequests(["POST /v1/drafts"], timeout: 45)
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.value(app, ID.emailComposeState) == "drafted" },
      "the state reads \(QueueUI.value(app, ID.emailComposeState))")
    shot("compose-drafted")

    // The journal: one draft created, nothing sent, nothing else written.
    let requests = try await FakeDaemon.journal().requests
    XCTAssertEqual(requests.filter { $0.path.hasPrefix("/v1/send") }, [], "board 05 asked to send")
    seen = try await Self.writes()
    XCTAssertEqual(seen, ["POST /v1/drafts 201"], "board 05 wrote more than one draft")
    print("BOARD05| \(appearance) seconds=\(Int(Date().timeIntervalSince(started)))")
  }
}
