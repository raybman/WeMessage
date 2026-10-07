import AppKit
import Foundation
import XCTest

/// v2 S4d: board 02, the thread and its composer, from the fake daemon's
/// "rich" and "kill" scenarios. One launch per appearance (the S4 runtime
/// rule): each state is a row click, a keystroke, or a scenario switch plus
/// the test-only reload key (cmd-opt-R), never a relaunch. Each state is
/// shot with the frost on as board-02-<state>-<appearance>.png, swept for
/// green and held to the frost evidence at the thread layout's patches.
///
/// The teeth: a send without cmd-Return (bare Return must leave a newline
/// in the field and nothing in the journal), a send inside the 4 s window
/// or after cmd-Z took it back, a Hold until beside an agent draft, and a
/// green pixel anywhere in a transcript. POST /v1/send is parked on the
/// fake daemon (409), so the one send that does go out reads as parked.
/// CI only.
final class Board02Tests: XCTestCase {
  override func setUp() async throws {
    try await FakeDaemon.reset()
  }

  static let daniel = "iMessage;-;+15550100002"
  static let priya = "SMS;-;+15550100004"
  static let sam = "iMessage;-;sam.whitfield@example.com"
  static let flat = "iMessage;+;chat5550100104"
  static let hike = "iMessage;+;chat5550100103"

  // MARK: Snapshots

  @MainActor
  func testBoard02Light() async throws {
    try await board02(appearance: "light") { mean in
      XCTAssertGreaterThan(mean, 0.6, "a light thread renders dark: mean luminance \(mean)")
    }
  }

  @MainActor
  func testBoard02Dark() async throws {
    try await board02(appearance: "dark") { mean in
      XCTAssertLessThan(mean, 0.4, "a dark thread renders light: mean luminance \(mean)")
    }
  }

  @MainActor
  private func board02(appearance: String, luminance: (Double) -> Void) async throws {
    try await FakeDaemon.scenario("rich")
    let app = UITestApp.make(appearance: appearance, reduceTransparency: false)
    app.launch()
    defer { app.terminate() }
    XCTAssertTrue(UITestApp.shellElement(app).waitForExistence(timeout: UITestApp.timeout), "the shell never appeared")
    let geometry = settledGeometry(app)
    let started = Date()
    func shoot(_ state: String) {
      settle()
      capture(
        app, geometry: geometry, appearance: appearance, frost: true, name: "board-02-\(state)-\(appearance).png",
        layout: .thread, luminance: luminance)
    }

    // draft: Priya's SMS thread with sol-main's pending draft. Approve, Edit
    // and Hold are drawn; Hold until is not.
    open(app, Self.priya)
    XCTAssertTrue(waitUntil { self.label(app, ID.draft).hasPrefix("DRAFT") }, "draft: \(label(app, ID.draft))")
    XCTAssertTrue(label(app, ID.draft).contains("SOL-MAIN"), "draft: not sol-main's: \(label(app, ID.draft))")
    for id in [ID.draftApprove, ID.draftEdit, ID.draftHold, ID.threadBanner, ID.capabilityNote] {
      XCTAssertTrue(element(app, id).exists, "draft: \(id) is missing")
    }
    assertNoHoldUntil(app, "draft")
    XCTAssertTrue(label(app, ID.bubblePrefix + "msg-0016").hasPrefix("Sent, "), "draft: msg-0016 reads \(label(app, ID.bubblePrefix + "msg-0016"))")
    shoot("draft")

    // resting: Daniel, no draft, an empty field and Send beside it.
    open(app, Self.daniel)
    XCTAssertTrue(
      waitUntil { self.label(app, ID.bubblePrefix + "msg-0012").hasPrefix("Sent, ") },
      "resting: msg-0012 reads \(label(app, ID.bubblePrefix + "msg-0012"))")
    XCTAssertTrue(label(app, ID.bubblePrefix + "msg-0013").hasPrefix("Received, "), "resting: msg-0013 reads \(label(app, ID.bubblePrefix + "msg-0013"))")
    XCTAssertFalse(element(app, ID.draft).exists, "resting: a draft in Daniel's thread")
    XCTAssertTrue(element(app, ID.composerSend).exists, "resting: no Send")
    assertNoHoldUntil(app, "resting")
    shoot("resting")

    // unsent: Sam's thread keeps the unsent message's slot as a placeholder.
    open(app, Self.sam)
    XCTAssertTrue(
      waitUntil { self.label(app, ID.bubblePrefix + "msg-0019").hasPrefix("Unsent, ") },
      "unsent: msg-0019 reads \(label(app, ID.bubblePrefix + "msg-0019"))")
    shoot("unsent")

    // group: Flat 4B. INV-5 is a strip, Send is absent with its reason.
    open(app, Self.flat)
    XCTAssertTrue(waitUntil { self.element(app, ID.inv5).exists }, "group: no INV-5 strip")
    XCTAssertTrue(waitUntil { self.element(app, ID.bubblePrefix + "msg-0025").exists }, "group: msg-0025")
    XCTAssertFalse(element(app, ID.composerSend).exists, "group: Send is placed in a group")
    assertNoHoldUntil(app, "group")
    shoot("group")

    // sending, then parked: Daniel, typed, cmd-Return. Inside the window the
    // journal holds no send; after it, one POST /v1/send, parked (409).
    open(app, Self.daniel)
    XCTAssertTrue(waitUntil { self.element(app, ID.bubblePrefix + "msg-0012").exists }, "sending: Daniel never opened")
    let field = composerField(app)
    field.click()
    app.typeText("on my way")
    dump(app, "sending")
    app.typeKey(.return, modifierFlags: .command)
    XCTAssertTrue(waitUntil { self.counting(app) }, "sending: no countdown")
    try await Self.assertSends(0, "inside the 4 s window")
    shoot("sending")
    XCTAssertTrue(waitUntil { self.parked(app) }, "parked: \(label(app, ID.composerOutbox))")
    shoot("parked")
    try await Self.assertSends(1, "after the window")

    // kill: back on Priya with text in the field, then the switch goes on.
    // Send, the draft's verbs and Hold until are all absent; the text stays.
    open(app, Self.priya)
    XCTAssertTrue(waitUntil { self.element(app, ID.draft).exists }, "kill: Priya never opened")
    composerField(app).click()
    app.typeText("ring me after 4")
    try await FakeDaemon.scenario("kill")
    app.typeKey("r", modifierFlags: [.command, .option])
    XCTAssertTrue(waitUntil { self.value(app, ID.killChip) == "on" }, "kill chip: \(value(app, ID.killChip))")
    XCTAssertTrue(waitUntil { !self.element(app, ID.draftApprove).exists }, "kill: Approve is still placed")
    XCTAssertFalse(element(app, ID.composerSend).exists, "kill: Send is placed under the kill switch")
    XCTAssertFalse(element(app, ID.draftEdit).exists, "kill: Edit is placed under the kill switch")
    assertNoHoldUntil(app, "kill")
    XCTAssertTrue(fieldText(app).contains("ring me after 4"), "kill: the typed text was dropped: \(fieldText(app))")
    shoot("kill")

    print("BOARD02| \(appearance) states=7 seconds=\(Int(Date().timeIntervalSince(started)))")
    try await Self.assertSends(1, "at the end of the board")
  }

  // MARK: The composer's teeth

  /// Return is a newline: type, press Return, and after the whole window
  /// the journal has no send and the field holds the newline.
  @MainActor
  func testReturnNeverSends() async throws {
    try await FakeDaemon.scenario("rich")
    let app = UITestApp.make(appearance: "light", reduceTransparency: false)
    app.launch()
    defer { app.terminate() }
    XCTAssertTrue(UITestApp.shellElement(app).waitForExistence(timeout: UITestApp.timeout), "the shell never appeared")
    open(app, Self.daniel)
    XCTAssertTrue(waitUntil { self.element(app, ID.bubblePrefix + "msg-0012").exists }, "Daniel never opened")
    composerField(app).click()
    app.typeText("first line")
    dump(app, "before return")
    app.typeKey(.return, modifierFlags: [])
    dump(app, "after return")
    app.typeText("second line")
    dump(app, "return")
    // Past the 4 s window and then some.
    try await Task.sleep(for: .seconds(6))
    XCTAssertFalse(element(app, ID.composerOutbox).exists, "bare Return started a send: \(label(app, ID.composerOutbox))")
    let text = fieldText(app)
    XCTAssertTrue(text.contains("first line\nsecond line"), "the field has no newline: \(text.debugDescription)")
    try await FakeDaemon.assertNoSend()
  }

  /// cmd-Return starts the 4 s window and sends nothing inside it; cmd-Z
  /// takes it back and nothing goes out; a second cmd-Return left alone
  /// sends exactly once after the window, and the 409 reads as parked.
  @MainActor
  func testCmdReturnSendsAfterUndo() async throws {
    try await FakeDaemon.scenario("rich")
    let app = UITestApp.make(appearance: "light", reduceTransparency: false)
    app.launch()
    defer { app.terminate() }
    XCTAssertTrue(UITestApp.shellElement(app).waitForExistence(timeout: UITestApp.timeout), "the shell never appeared")
    open(app, Self.daniel)
    XCTAssertTrue(waitUntil { self.element(app, ID.bubblePrefix + "msg-0012").exists }, "Daniel never opened")

    composerField(app).click()
    app.typeText("take this back")
    app.typeKey(.return, modifierFlags: .command)
    XCTAssertTrue(waitUntil { self.counting(app) }, "no countdown after cmd-Return")
    try await Self.assertSends(0, "inside the window")
    app.typeKey("z", modifierFlags: .command)
    XCTAssertTrue(waitUntil { !self.element(app, ID.composerOutbox).exists }, "cmd-Z left \(label(app, ID.composerOutbox))")
    XCTAssertTrue(fieldText(app).contains("take this back"), "cmd-Z did not return the text: \(fieldText(app))")
    try await Task.sleep(for: .seconds(6))
    try await Self.assertSends(0, "after cmd-Z took it back")

    // The field holds the restored text; send it and leave it alone.
    composerField(app).click()
    app.typeKey(.return, modifierFlags: .command)
    XCTAssertTrue(waitUntil { self.counting(app) }, "no second countdown")
    try await Self.assertSends(0, "inside the second window")
    XCTAssertTrue(waitUntil { self.parked(app) }, "not parked: \(label(app, ID.composerOutbox))")
    try await Self.assertSends(1, "after the second window")
  }

  /// An agent draft never has Hold until beside it (02.J, D-UI-17): its
  /// verbs are Approve, Edit and Hold, and the reason is printed. The
  /// keycaps are drawn, not bound: a typed "a" is text, not an approval.
  @MainActor
  func testHoldUntilAbsentOnAgentDraft() async throws {
    try await FakeDaemon.scenario("rich")
    let app = UITestApp.make(appearance: "light", reduceTransparency: false)
    app.launch()
    defer { app.terminate() }
    XCTAssertTrue(UITestApp.shellElement(app).waitForExistence(timeout: UITestApp.timeout), "the shell never appeared")
    for guid in [Self.priya, Self.hike] {
      open(app, guid)
      XCTAssertTrue(waitUntil { self.element(app, ID.draftApprove).exists }, "\(guid): no draft verbs")
      assertNoHoldUntil(app, guid)
      let note = element(app, ID.capabilityNote)
      XCTAssertTrue(note.exists, "\(guid): no capability note")
      if ProvisionalUI.holdUntil == .absentWithReason {
        XCTAssertTrue(note.label.contains(ProvisionalUI.holdUntilReason), "\(guid): the reason is not printed: \(note.label)")
      }
    }
    open(app, Self.priya)
    XCTAssertTrue(waitUntil { self.element(app, ID.draft).exists }, "Priya never reopened")
    composerField(app).click()
    app.typeText("a")
    try await Task.sleep(for: .seconds(1))
    let approvals = try await FakeDaemon.journal().requests.filter { $0.method == "POST" && $0.path.hasPrefix("/v1/drafts/") }
    XCTAssertEqual(approvals, [], "a keycap is bound")
    XCTAssertFalse(element(app, ID.composerOutbox).exists, "a keycap started an approval")
    try await FakeDaemon.assertNoSend()
  }

  // MARK: Helpers

  @MainActor
  private func assertNoHoldUntil(_ app: XCUIApplication, _ state: String) {
    XCTAssertFalse(element(app, ID.composerHold).exists, "\(state): Hold until is placed")
    let labelled = app.descendants(matching: .button).matching(NSPredicate(format: "label BEGINSWITH[c] %@", "Hold until"))
    XCTAssertEqual(labelled.count, 0, "\(state): a button reads Hold until")
  }

  /// The journal's POST /v1/send count is `count`, each one parked.
  private static func assertSends(_ count: Int, _ when: String, file: StaticString = #filePath, line: UInt = #line) async throws {
    let sends = try await FakeDaemon.journal().requests.filter { $0.method == "POST" && $0.path == "/v1/send" }
    XCTAssertEqual(sends.count, count, "\(when): \(sends)", file: file, line: line)
    XCTAssertTrue(sends.allSatisfy { $0.status == 409 }, "\(when): a send was not parked: \(sends)", file: file, line: line)
  }

  /// Clicks the list row for `guid`; its thread head and thread follow.
  @MainActor
  private func open(_ app: XCUIApplication, _ guid: String) {
    let row = element(app, ID.rowPrefix + guid)
    XCTAssertTrue(row.waitForExistence(timeout: UITestApp.timeout), "no list row for \(guid)")
    row.click()
    let thread = element(app, ID.thread)
    XCTAssertTrue(waitUntil { thread.exists && thread.label.hasSuffix(": loaded") }, "\(guid): thread reads \(thread.label)")
  }

  /// The composer's text view (the identifier may sit on its scroll view).
  @MainActor
  private func composerField(_ app: XCUIApplication) -> XCUIElement {
    let tagged = app.descendants(matching: .any).matching(identifier: ID.composerField).firstMatch
    XCTAssertTrue(tagged.waitForExistence(timeout: UITestApp.timeout), "no composer field")
    if tagged.elementType == .textView { return tagged }
    let inner = tagged.descendants(matching: .textView).firstMatch
    return inner.exists ? inner : tagged
  }

  @MainActor
  private func fieldText(_ app: XCUIApplication) -> String {
    (composerField(app).value as? String) ?? ""
  }

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: id).firstMatch
  }

  @MainActor
  private func label(_ app: XCUIApplication, _ id: String) -> String {
    let e = element(app, id)
    return e.exists ? e.label : "(missing)"
  }

  /// The outbox counts down: its label leads with the countdown.
  @MainActor
  private func counting(_ app: XCUIApplication) -> Bool {
    label(app, ID.composerOutbox).hasPrefix("SENDING in ")
  }

  /// The outbox reads parked: the daemon answered 409.
  @MainActor
  private func parked(_ app: XCUIApplication) -> Bool {
    label(app, ID.composerOutbox).hasPrefix(ProvisionalUI.parkedLine)
  }

  /// The composer's subtree, printed once per typed state, so a field that
  /// never takes text can be read from the run's log.
  @MainActor
  private func dump(_ app: XCUIApplication, _ state: String) {
    print("COMPOSER| \(state) field=\(fieldText(app).debugDescription)")
    print(element(app, ID.composer).debugDescription)
  }

  @MainActor
  private func value(_ app: XCUIApplication, _ id: String) -> String {
    let e = element(app, id)
    return e.exists ? ((e.value as? String) ?? "") : "(missing)"
  }

  /// One more frame after the values arrive, before the shot.
  @MainActor
  private func settle() { Thread.sleep(forTimeInterval: 0.3) }

  /// Polls until `done` holds or the wait runs out; true when it held.
  @MainActor
  private func waitUntil(_ done: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(UITestApp.timeout)
    var held = done()
    while !held && Date() < deadline {
      Thread.sleep(forTimeInterval: 0.25)
      held = done()
    }
    return held
  }
}
