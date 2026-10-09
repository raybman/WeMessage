import Foundation
import XCTest

/// v2 B3: board 04, LinkedIn, drawn over fixtures. The fake daemon's
/// "preview-linkedin" scenario says the channel is in the fixture state and
/// serves seven LinkedIn threads across three inboxes and both categories;
/// "preview-linkedin-ratelimited" is the same threads with LinkedIn pushing
/// back. Only the UI-test flag opens the gate that reads either (H-B-1).
/// One launch per scenario and appearance: cmd-4 selects the LinkedIn tile.
///
/// The board launch walks:
/// - list: the rail's LinkedIn mark (clear), the banner with the account,
///   the inbox scope and the fixture chip, the Focused and Other tabs;
/// - tabs (04.A): Other hides Marcus and shows Priya, Focused brings him
///   back;
/// - inboxes (04.E): the banner's switch narrows to Sales Navigator, where
///   only Grace is, and All brings every inbox back;
/// - cards (04.C, 04.F): Grace's InMail with its cost, Dana's recruiter
///   InMail, Tomas's job application, the ad with no composer;
/// - request (04.D): Priya's request card and no composer;
/// - inspector (04.G): the ladder names Dana's step;
/// - compose: Marcus, typed into, Make draft writes exactly one POST
///   /v1/drafts and nothing is sent.
/// The rate-limited launch (04.H): the blocking banner, no composer on any
/// thread, and not one write. Shots are board-04-<state>-<appearance>.png.
/// The light launches run the accessibility audit. CI only.
final class Board04Tests: XCTestCase {
  override func setUp() async throws {
    try await FakeDaemon.reset()
  }

  static let account = "Avery Park"
  static let marcus = "linkedin;-;marcus-tan"
  static let priya = "linkedin;-;priya-raman"
  static let grace = "linkedin;-;grace-moreno"
  static let dana = "linkedin;-;dana-whitfield"
  static let tomas = "linkedin;-;tomas-kral"
  static let contoso = "linkedin;-;contoso-talent"
  static let riya = "linkedin;-;riya-kapoor"
  static let focused = [marcus, grace, dana, tomas]
  static let reply = "Thursday at ten works. I will bring the adapter notes."

  @MainActor
  func testBoard04Light() async throws {
    try await board(appearance: "light") { mean in
      XCTAssertGreaterThan(mean, 0.6, "a light board 04 renders dark: mean luminance \(mean)")
    }
  }

  @MainActor
  func testBoard04Dark() async throws {
    try await board(appearance: "dark") { mean in
      XCTAssertLessThan(mean, 0.4, "a dark board 04 renders light: mean luminance \(mean)")
    }
  }

  @MainActor
  func testRateLimitedLight() async throws {
    try await rateLimited(appearance: "light")
  }

  @MainActor
  func testRateLimitedDark() async throws {
    try await rateLimited(appearance: "dark")
  }

  /// The writes the daemon has seen so far.
  private static func writes() async throws -> [String] {
    try await FakeDaemon.journal().requests.filter { $0.method != "GET" }.map(\.description)
  }

  /// The compose body's text view: the tagged element, or the text view
  /// inside it when the tag lands on the scroll view.
  @MainActor
  private func bodyField(_ app: XCUIApplication) -> XCUIElement {
    let tagged = QueueUI.element(app, ID.linkedInComposeBody)
    XCTAssertTrue(tagged.waitForExistence(timeout: UITestApp.timeout), "no compose body")
    if tagged.elementType == .textView { return tagged }
    let inner = tagged.descendants(matching: .textView).firstMatch
    return inner.exists ? inner : tagged
  }

  /// True once `field` holds the keyboard, within `seconds`.
  @MainActor
  private func holdsKeyboard(_ field: XCUIElement, within seconds: TimeInterval = 5) -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    var held = (field.value(forKey: "hasKeyboardFocus") as? Bool) == true
    while !held && Date() < deadline {
      Thread.sleep(forTimeInterval: 0.25)
      held = (field.value(forKey: "hasKeyboardFocus") as? Bool) == true
    }
    return held
  }

  /// Each thread's first message: a bubble, an InMail card or a commercial card.
  static let first = [
    marcus: "li-0101", priya: "li-0401", grace: "li-0201", dana: "li-0301", tomas: "li-0601", contoso: "li-0701",
    riya: "li-0501",
  ]

  /// Clicks the list row for `guid` and waits for its first message, drawn
  /// in the LinkedIn thread.
  @MainActor
  private func open(_ app: XCUIApplication, _ guid: String) {
    let row = QueueUI.element(app, ID.rowPrefix + guid)
    XCTAssertTrue(row.waitForExistence(timeout: UITestApp.timeout), "no list row for \(guid)")
    row.click()
    let turn = Self.first[guid] ?? ""
    XCTAssertTrue(
      QueueUI.waitUntil {
        [ID.bubblePrefix, ID.linkedInInMailPrefix, ID.linkedInCommercialPrefix]
          .contains { QueueUI.element(app, $0 + turn).exists }
      },
      "\(guid): \(turn) was not drawn")
    XCTAssertTrue(QueueUI.element(app, ID.linkedInThread).exists, "\(guid): not drawn as a LinkedIn thread")
  }

  /// Waits until the open thread's foot has settled: a composer, or the
  /// line that says why there is none.
  @MainActor
  private func foot(_ app: XCUIApplication) -> String {
    _ = QueueUI.waitUntil {
      QueueUI.element(app, ID.linkedInCompose).exists || QueueUI.element(app, ID.linkedInNoComposer).exists
    }
    return QueueUI.element(app, ID.linkedInCompose).exists ? "composer" : QueueUI.value(app, ID.linkedInNoComposer)
  }

  /// Picks `id` (an inbox or all) in the banner's switch.
  @MainActor
  private func pickInbox(_ app: XCUIApplication, _ id: String) {
    QueueUI.element(app, ID.linkedInBanner).click()
    let row = QueueUI.element(app, ID.linkedInInboxPrefix + id)
    XCTAssertTrue(row.waitForExistence(timeout: UITestApp.timeout), "the inbox switch did not open")
    row.click()
    XCTAssertTrue(
      QueueUI.waitUntil { !QueueUI.element(app, ID.linkedInSwitch).exists }, "choosing an inbox left the switch open")
  }

  @MainActor
  private func board(appearance: String, luminance: (Double) -> Void) async throws {
    try await FakeDaemon.scenario("preview-linkedin")
    let app = UITestApp.make(appearance: appearance, reduceTransparency: false)
    app.launch()
    defer { app.terminate() }
    XCTAssertTrue(UITestApp.shellElement(app).waitForExistence(timeout: UITestApp.timeout), "the shell never appeared")
    let geometry = settledGeometry(app)
    let started = Date()
    let light = appearance == "light"
    let shot: (String) -> Void = { step in
      QueueUI.settle()
      self.glance(app, name: "board-04-\(step)-\(appearance).png")
    }

    // The rail: LinkedIn draws a mark as a connected channel would.
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.value(app, ID.railLinkedIn) == "clear" },
      "rail: LinkedIn reads '\(QueueUI.value(app, ID.railLinkedIn))'")

    // The list: board 04's banner with the fixture chip, over its empty state.
    app.typeKey("4", modifierFlags: .command)
    XCTAssertTrue(QueueUI.waitUntil { QueueUI.element(app, ID.linkedInBoard).exists }, "board 04 never appeared on cmd-4")
    XCTAssertTrue(
      QueueUI.label(app, ID.linkedInBanner).hasPrefix(
        ProvisionalUI.linkedInBanner(account: Self.account, scope: ProvisionalUI.linkedInAllInboxes)),
      "banner: '\(QueueUI.label(app, ID.linkedInBanner))'")
    XCTAssertEqual(QueueUI.value(app, ID.linkedInBanner), ProvisionalUI.linkedInAllInboxes, "inbox scope")
    XCTAssertTrue(QueueUI.element(app, ID.fixtureChip).exists, "the fixture chip is missing")
    XCTAssertEqual(QueueUI.label(app, ID.linkedInEmpty), ProvisionalUI.linkedInEmptyHeadline, "empty state")
    XCTAssertFalse(QueueUI.element(app, ID.zero).exists, "the not-connected zero is drawn under board 04")
    XCTAssertFalse(QueueUI.element(app, ID.linkedInPaused).exists, "a pause banner without a pause")
    XCTAssertTrue(QueueUI.element(app, ID.rowPrefix + Self.marcus).waitForExistence(timeout: UITestApp.timeout), "no list")
    XCTAssertEqual(QueueUI.value(app, ID.linkedInTabPrefix + "focused"), "on", "Focused is not on at launch")
    for guid in Self.focused {
      XCTAssertTrue(QueueUI.element(app, ID.rowPrefix + guid).exists, "Focused hid \(guid)")
    }
    XCTAssertFalse(QueueUI.element(app, ID.rowPrefix + Self.priya).exists, "an Other thread shows under Focused")
    // D-UI-161: under All 3 inboxes every row carries its origin tag.
    let tags = [Self.marcus: " MSG", Self.grace: " SN", Self.tomas: " REC"]
    for (guid, tag) in tags {
      let value = QueueUI.value(app, ID.rowPrefix + guid)
      XCTAssertTrue(value.hasSuffix(tag), "\(guid) reads '\(value)', not its origin tag")
    }
    QueueUI.settle()
    capture(
      app, geometry: geometry, appearance: appearance, frost: true, name: "board-04-list-\(appearance).png",
      layout: .banner, luminance: luminance)
    QueueUI.printTime("BOARD04", appearance, "list", since: started)

    // 04.A: Other hides the focused threads and shows the rest.
    QueueUI.element(app, ID.linkedInTabPrefix + "other").click()
    XCTAssertTrue(
      QueueUI.waitUntil { !QueueUI.element(app, ID.rowPrefix + Self.marcus).exists }, "Other left Marcus in the list")
    XCTAssertTrue(QueueUI.element(app, ID.rowPrefix + Self.priya).waitForExistence(timeout: UITestApp.timeout), "Other hid Priya")
    XCTAssertEqual(QueueUI.value(app, ID.linkedInTabPrefix + "other"), "on")
    XCTAssertEqual(QueueUI.value(app, ID.linkedInTabPrefix + "focused"), "off")

    // 04.D: Priya's request: the card, and no composer.
    open(app, Self.priya)
    XCTAssertEqual(foot(app), "requestPending", "a pending request has a composer")
    XCTAssertTrue(QueueUI.element(app, ID.linkedInRequest).exists, "no request card")
    shot("request")

    // 04.F: the ad: its card, no composer and why.
    open(app, Self.contoso)
    XCTAssertTrue(
      QueueUI.element(app, ID.linkedInCommercialPrefix + "li-0701").waitForExistence(timeout: UITestApp.timeout), "no ad card")
    XCTAssertEqual(QueueUI.value(app, ID.linkedInCommercialPrefix + "li-0701"), "sponsored")
    XCTAssertEqual(foot(app), "sponsored", "an ad has a composer")
    shot("sponsored")

    // A thread no step reaches: no composer.
    open(app, Self.riya)
    XCTAssertEqual(foot(app), "noRung", "a thread no step reaches has a composer")

    QueueUI.element(app, ID.linkedInTabPrefix + "focused").click()
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.element(app, ID.rowPrefix + Self.marcus).exists }, "Focused did not bring Marcus back")
    XCTAssertFalse(QueueUI.element(app, ID.rowPrefix + Self.priya).exists, "Focused left Priya in the list")
    QueueUI.printTime("BOARD04", appearance, "tabs", since: started)

    // 04.E: the banner's switch narrows to one inbox, and All widens again.
    QueueUI.element(app, ID.linkedInBanner).click()
    XCTAssertTrue(
      QueueUI.element(app, ID.linkedInInboxPrefix + "salesNav").waitForExistence(timeout: UITestApp.timeout),
      "the banner opened no inbox switch")
    XCTAssertEqual(QueueUI.value(app, ID.linkedInInboxPrefix + "all"), "on")
    QueueUI.element(app, ID.linkedInInboxPrefix + "salesNav").click()
    XCTAssertTrue(
      QueueUI.waitUntil { !QueueUI.element(app, ID.rowPrefix + Self.marcus).exists },
      "Sales Navigator left a Messaging thread in the list")
    XCTAssertTrue(QueueUI.element(app, ID.rowPrefix + Self.grace).exists, "Sales Navigator hid Grace")
    for guid in [Self.dana, Self.tomas] {
      XCTAssertFalse(QueueUI.element(app, ID.rowPrefix + guid).exists, "Sales Navigator shows \(guid)")
    }
    XCTAssertEqual(QueueUI.value(app, ID.linkedInBanner), "Sales Nav", "the banner does not name the inbox")
    XCTAssertTrue(
      QueueUI.value(app, ID.rowPrefix + Self.grace).hasSuffix(" untagged"),
      "narrowed to one inbox, Grace still carries a tag: '\(QueueUI.value(app, ID.rowPrefix + Self.grace))'")
    shot("salesnav")
    pickInbox(app, "all")
    XCTAssertTrue(
      QueueUI.waitUntil { Self.focused.allSatisfy { QueueUI.element(app, ID.rowPrefix + $0).exists } },
      "All did not bring every inbox back")
    XCTAssertEqual(QueueUI.value(app, ID.linkedInBanner), ProvisionalUI.linkedInAllInboxes)
    QueueUI.printTime("BOARD04", appearance, "inboxes", since: started)

    // 04.C: Grace's InMail to an Open Profile: the card and its cost.
    open(app, Self.grace)
    let inMail = QueueUI.element(app, ID.linkedInInMailPrefix + "li-0201")
    XCTAssertTrue(inMail.waitForExistence(timeout: UITestApp.timeout), "no InMail card")
    XCTAssertEqual(QueueUI.value(app, ID.linkedInInMailPrefix + "li-0201"), ProvisionalUI.linkedInInMailCost(0))
    XCTAssertEqual(foot(app), "composer")
    XCTAssertTrue(QueueUI.element(app, ID.linkedInComposeSubject).exists, "an InMail step has no subject")
    XCTAssertTrue(QueueUI.element(app, ID.linkedInComposeHold).exists, "Hold until says nothing")
    XCTAssertEqual(app.datePickers.count, 0, "a date picker is drawn")
    shot("inmail")

    // 04.F: Tomas's job application is a card, never fetched.
    open(app, Self.tomas)
    XCTAssertTrue(
      QueueUI.element(app, ID.linkedInCommercialPrefix + "li-0601").waitForExistence(timeout: UITestApp.timeout), "no job card")
    XCTAssertEqual(QueueUI.value(app, ID.linkedInCommercialPrefix + "li-0601"), "job")
    shot("job")

    // 04.F and 04.G: Dana's recruiter InMail, and the inspector's ladder.
    open(app, Self.dana)
    XCTAssertTrue(
      QueueUI.element(app, ID.linkedInCommercialPrefix + "li-0301").waitForExistence(timeout: UITestApp.timeout),
      "no recruiter card")
    XCTAssertEqual(QueueUI.value(app, ID.linkedInCommercialPrefix + "li-0301"), "recruiter")
    QueueUI.element(app, ID.inspectorToggle).click()
    XCTAssertTrue(
      QueueUI.element(app, ID.linkedInInspector).waitForExistence(timeout: UITestApp.timeout), "the inspector did not open")
    XCTAssertEqual(QueueUI.value(app, ID.linkedInLadder), ProvisionalUI.linkedInRungTitle(2), "the ladder names another step")
    shot("inspector")
    if light { try audit(app, window: "audit-board-04-inspector") }
    QueueUI.element(app, ID.inspectorToggle).click()
    XCTAssertTrue(
      QueueUI.waitUntil { !QueueUI.element(app, ID.linkedInInspector).exists }, "the inspector did not close")
    var seen = try await Self.writes()
    XCTAssertEqual(seen, [], "reading board 04 wrote something")
    QueueUI.printTime("BOARD04", appearance, "cards", since: started)

    // Compose: Marcus, 1st degree. Make draft makes one draft, sends nothing.
    open(app, Self.marcus)
    XCTAssertEqual(foot(app), "composer")
    XCTAssertFalse(QueueUI.element(app, ID.linkedInComposeSubject).exists, "a message step has a subject")
    XCTAssertEqual(QueueUI.value(app, ID.linkedInComposeDraft), "inert", "Make draft is live on an empty body")
    XCTAssertEqual(QueueUI.value(app, ID.linkedInComposeState), "composing")
    let body = bodyField(app)
    XCTAssertTrue(QueueUI.waitUntil { body.isHittable }, "the composer was not scrolled into view: \(body.frame)")
    var focused = holdsKeyboard(body)
    if !focused {
      body.click()
      focused = holdsKeyboard(body)
    }
    XCTAssertTrue(focused, "the body never took the keyboard")
    app.typeText(Self.reply)
    XCTAssertTrue(
      QueueUI.waitUntil { ((body.value as? String) ?? "").contains(Self.reply) },
      "typed into the body, it reads '\((body.value as? String) ?? "")'")
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.value(app, ID.linkedInComposeDraft) == "enabled" },
      "Make draft stays inert with a body: \(QueueUI.value(app, ID.linkedInComposeDraft))")
    shot("compose")
    if light { try audit(app, window: "audit-board-04-compose") }
    QueueUI.element(app, ID.linkedInComposeDraft).click()
    _ = try await FakeDaemon.waitForRequests(["POST /v1/drafts"])
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.value(app, ID.linkedInComposeState) == "drafted" },
      "the state reads \(QueueUI.value(app, ID.linkedInComposeState))")
    XCTAssertEqual(QueueUI.value(app, ID.linkedInComposeDraft), "inert", "Make draft is live after the draft")
    shot("drafted")

    // The journal: one draft created, nothing sent, nothing else written.
    let requests = try await FakeDaemon.journal().requests
    XCTAssertEqual(requests.filter { $0.path.hasPrefix("/v1/send") }, [], "board 04 asked to send")
    seen = try await Self.writes()
    XCTAssertEqual(seen, ["POST /v1/drafts 201"], "board 04 wrote more than one draft")
    print("BOARD04| \(appearance) seconds=\(Int(Date().timeIntervalSince(started)))")
  }

  /// 04.H: LinkedIn pushed back. The blocking banner, no composer on any
  /// thread, and the fake daemon receives nothing at all.
  @MainActor
  private func rateLimited(appearance: String) async throws {
    try await FakeDaemon.scenario("preview-linkedin-ratelimited")
    let app = UITestApp.make(appearance: appearance, reduceTransparency: false)
    app.launch()
    defer { app.terminate() }
    XCTAssertTrue(UITestApp.shellElement(app).waitForExistence(timeout: UITestApp.timeout), "the shell never appeared")
    let started = Date()
    let shot: (String) -> Void = { step in
      QueueUI.settle()
      self.glance(app, name: "board-04-\(step)-\(appearance).png")
    }

    app.typeKey("4", modifierFlags: .command)
    XCTAssertTrue(QueueUI.waitUntil { QueueUI.element(app, ID.linkedInBoard).exists }, "board 04 never appeared on cmd-4")
    let paused = QueueUI.element(app, ID.linkedInPaused)
    XCTAssertTrue(paused.waitForExistence(timeout: UITestApp.timeout), "no pause banner while LinkedIn pushes back")
    XCTAssertEqual(QueueUI.value(app, ID.linkedInPaused), "paused")
    XCTAssertTrue(QueueUI.element(app, ID.rowPrefix + Self.marcus).waitForExistence(timeout: UITestApp.timeout), "reading stopped")
    shot("paused")

    // Every focused thread, including the 1st-degree one, has no composer.
    for guid in Self.focused {
      open(app, guid)
      XCTAssertEqual(foot(app), "paused", "\(guid): a composer is drawn under the pause")
      XCTAssertFalse(QueueUI.element(app, ID.linkedInCompose).exists, "\(guid): a composer is drawn under the pause")
      XCTAssertFalse(QueueUI.element(app, ID.linkedInComposeDraft).exists, "\(guid): Make draft is drawn under the pause")
      XCTAssertTrue(paused.exists, "\(guid): the pause banner went away")
    }
    open(app, Self.marcus)
    XCTAssertEqual(foot(app), "paused")
    // A keystroke has nowhere to go.
    app.typeText(Self.reply)
    shot("paused-thread")
    if appearance == "light" { try audit(app, window: "audit-board-04-paused") }

    try await Task.sleep(for: .seconds(1))
    let writes = try await Self.writes()
    XCTAssertEqual(writes, [], "the fake daemon received a write under the pause")
    try await QueueUI.assertJournal("board 04 paused \(appearance)")
    print("BOARD04| paused \(appearance) seconds=\(Int(Date().timeIntervalSince(started)))")
  }
}
