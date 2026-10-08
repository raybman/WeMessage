import AppKit
import Foundation
import XCTest

/// v2 S4j: board 14, compose. One launch per appearance (the UI job's time
/// budget): WEMESSAGE_UI_BOARD=14 opens the compose window over the fake
/// daemon's rich scenario. The launch walks 14.A to 14.F, a shot per state:
/// - empty: one field, To, and no channel, banner, input or Send at all;
/// - resolve: "ma" resolves to rows ordered by last exchange;
/// - person: Maya chosen; iMessage is the default and the banner names it,
///   the other channels say not connected, and nothing is a picker;
/// - proposal: opt-cmd-D's Ask fills the region and the input stays empty;
/// - handoff: Approve moves the text down into the input;
/// - undo: Send opens the 4 s window; Undo inside it writes nothing;
/// - drafted: Send again, the window runs out, and one draft is created;
/// - states: the six 14.F specimens.
/// The light launch runs the accessibility audit. Every launch ends on the
/// journal: no POST /v1/send, exactly one POST /v1/drafts (201), and no
/// other write. Shots are board-14-<state>-<appearance>.png. CI only.
final class Board14Tests: XCTestCase {
  override func setUp() async throws {
    try await FakeDaemon.reset()
  }

  static let channels = ["imessage", "whatsapp", "linkedin", "email"]
  static let proposal = "Saturday works for me. Same trailhead at 9?"

  @MainActor
  func testBoard14Light() async throws {
    try await compose(appearance: "light")
  }

  @MainActor
  func testBoard14Dark() async throws {
    try await compose(appearance: "dark")
  }

  /// The writes the daemon has seen so far.
  private func writes() async throws -> [String] {
    try await FakeDaemon.journal().requests.filter { $0.method != "GET" }.map(\.description)
  }

  @MainActor
  private func compose(appearance: String) async throws {
    try await FakeDaemon.scenario("rich")
    let app = UITestApp.make(appearance: appearance, reduceTransparency: false, board: "14")
    app.launch()
    defer { app.terminate() }
    let window = QueueUI.element(app, ID.compose)
    XCTAssertTrue(window.waitForExistence(timeout: UITestApp.timeout), "the compose window never appeared")
    XCTAssertFalse(UITestApp.shellElement(app).exists, "the shell is drawn beside compose")
    let started = Date()
    let light = appearance == "light"
    let shot: (String) -> Void = { step in
      QueueUI.settle()
      self.glance(app, name: "board-14-\(step)-\(appearance).png")
    }

    // 14.A step 1: one field, and no channel affordance of any kind.
    let to = QueueUI.element(app, ID.composeTo)
    XCTAssertTrue(to.waitForExistence(timeout: UITestApp.timeout), "no To field")
    XCTAssertEqual(QueueUI.value(app, ID.composeTabPrefix + "new"), "shown")
    for id in [ID.composeBanner, ID.composeStrip, ID.composeField, ID.composeSend, ID.composeProposal] {
      XCTAssertFalse(QueueUI.element(app, id).exists, "\(id) is drawn before a person")
    }
    XCTAssertEqual(QueueUI.count(app, containing: ID.composeChannelPrefix), 0, "a channel is drawn before a person")
    XCTAssertEqual(app.popUpButtons.count, 0, "a picker is drawn")
    XCTAssertEqual(app.radioGroups.count, 0, "a channel choice is drawn")
    shot("empty")
    QueueUI.printTime("BOARD14", appearance, "empty", since: started)

    // 14.A step 2: rows by recency, with evidence.
    to.click()
    to.typeText("ma")
    let maya = QueueUI.element(app, ID.composeResultPrefix + "maya")
    XCTAssertTrue(maya.waitForExistence(timeout: UITestApp.timeout), "ma did not resolve to Maya")
    XCTAssertTrue(QueueUI.element(app, ID.composeResultPrefix + "marta").exists, "ma did not resolve to Marta")
    XCTAssertLessThan(
      maya.frame.minY, QueueUI.element(app, ID.composeResultPrefix + "marta").frame.minY,
      "rows are not ordered by last exchange")
    XCTAssertTrue(QueueUI.label(app, ID.composeResultPrefix + "maya").contains("last exchange"), "a row has no evidence")
    XCTAssertEqual(QueueUI.count(app, containing: ID.composeChannelPrefix), 0, "a channel is drawn before a person")
    shot("resolve")

    // 14.A step 3 and 14.B: the person, then the channel, named.
    maya.click()
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.value(app, ID.composeRecipient) == "maya" },
      "the chip reads \(QueueUI.value(app, ID.composeRecipient))")
    XCTAssertEqual(QueueUI.value(app, ID.composeChannelPrefix + "imessage"), "default")
    for channel in Self.channels.dropFirst() {
      XCTAssertEqual(QueueUI.value(app, ID.composeChannelPrefix + channel), "not connected", "\(channel) card")
    }
    XCTAssertTrue(QueueUI.label(app, ID.composeBanner).contains("iMessage to +1 555 010 0001"), "the banner names no channel")
    XCTAssertEqual(QueueUI.value(app, ID.composeSlotPrefix + "emoji"), "can")
    XCTAssertEqual(QueueUI.value(app, ID.composeSlotPrefix + "hold"), "struck")
    XCTAssertEqual(QueueUI.value(app, ID.composeField), "", "the input is not empty")
    XCTAssertEqual(QueueUI.value(app, ID.composeSend), "inert", "Send is live on an empty input")
    XCTAssertEqual(app.popUpButtons.count, 0, "a picker is drawn")
    shot("person")
    if light { try audit(app, window: "audit-board-14-person") }
    QueueUI.printTime("BOARD14", appearance, "person", since: started)

    // 14.E: the proposal arrives above, and the input stays empty.
    QueueUI.element(app, ID.composeProposalAsk).click()
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.value(app, ID.composeProposal) == "proposal" },
      "the region reads \(QueueUI.value(app, ID.composeProposal))")
    XCTAssertEqual(QueueUI.value(app, ID.composeField), "", "the proposal wrote the input")
    XCTAssertEqual(QueueUI.value(app, ID.composeSend), "inert", "Send is live with only a proposal")
    shot("proposal")

    QueueUI.element(app, ID.composeProposalTake).click()
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.value(app, ID.composeField) == Self.proposal },
      "Approve did not move the text: \(QueueUI.value(app, ID.composeField))")
    XCTAssertEqual(QueueUI.value(app, ID.composeProposal), "moved")
    XCTAssertEqual(QueueUI.value(app, ID.composeSend), "enabled", "Send is inert after the handoff")
    shot("handoff")
    var seen = try await writes()
    XCTAssertEqual(seen, [], "the proposal reached the daemon")

    // 14.F state 2: the undo window. Undo inside it writes nothing.
    QueueUI.element(app, ID.composeSend).click()
    let undo = QueueUI.element(app, ID.composeUndo)
    XCTAssertTrue(undo.waitForExistence(timeout: UITestApp.timeout), "Send opened no undo window")
    XCTAssertEqual(QueueUI.value(app, ID.composeBubble), "undo")
    shot("undo")
    undo.click()
    XCTAssertTrue(QueueUI.waitUntil { !QueueUI.element(app, ID.composeBubble).exists }, "undo left the bubble up")
    try await Task.sleep(for: .milliseconds(4500))
    seen = try await writes()
    XCTAssertEqual(seen, [], "undo still created a draft")
    XCTAssertEqual(QueueUI.value(app, ID.composeField), Self.proposal, "undo lost the text")
    QueueUI.printTime("BOARD14", appearance, "undo", since: started)

    // Send again: the window runs out and one pending draft is created.
    QueueUI.element(app, ID.composeSend).click()
    _ = try await FakeDaemon.waitForRequests(["POST /v1/drafts"])
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.value(app, ID.composeBubble) == "drafted" },
      "the bubble reads \(QueueUI.value(app, ID.composeBubble))")
    shot("drafted")

    // 14.F: the six states.
    QueueUI.element(app, ID.composeTabPrefix + "states").click()
    XCTAssertTrue(
      QueueUI.element(app, ID.composePagePrefix + "states").waitForExistence(timeout: UITestApp.timeout),
      "never reached the states page")
    for state in ["composed", "undo", "queued", "sending", "sent", "failed"] {
      XCTAssertTrue(QueueUI.element(app, ID.composeStatePrefix + state).exists, "no \(state) specimen")
    }
    XCTAssertEqual(QueueUI.value(app, ID.composeStatePrefix + "sent"), "filled")
    XCTAssertEqual(QueueUI.value(app, ID.composeStatePrefix + "failed"), "dotted")
    XCTAssertEqual(QueueUI.value(app, ID.composeStatePrefix + "undo"), "dashed")
    shot("states")
    if light { try audit(app, window: "audit-board-14-states") }

    // The journal: one draft created, nothing sent, nothing else written.
    let requests = try await FakeDaemon.journal().requests
    XCTAssertEqual(requests.filter { $0.path.hasPrefix("/v1/send") }, [], "compose asked to send")
    seen = try await writes()
    XCTAssertEqual(seen, ["POST /v1/drafts 201"], "compose wrote more than one draft")
    print("BOARD14| \(appearance) states=8 seconds=\(Int(Date().timeIntervalSince(started)))")
  }
}
