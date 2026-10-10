import Foundation
import XCTest

/// v2 F5: a new conversation by handle, over the fake daemon's compose-new
/// scenario. Compose asks the daemon which conversation a handle has before
/// any draft exists: a typed handle it names none for is refused in words
/// with no composer and no Send, and Maya's 1:1 drafts on the guid the
/// daemon named (an any;-; chat), never one compose made up. One light
/// launch per half; the journal is the proof. CI only.
final class ComposeNewTests: XCTestCase {
  override func setUp() async throws {
    try await FakeDaemon.reset()
  }

  @MainActor
  func testComposeNewHandleRefusesThenExistingDrafts() async throws {
    try await FakeDaemon.scenario("compose-new")
    let app = UITestApp.make(appearance: "light", reduceTransparency: false, board: "14")
    app.launch()
    defer { app.terminate() }

    // A typed handle with no conversation on this Mac: refused, no Send.
    var to = QueueUI.element(app, ID.composeTo)
    XCTAssertTrue(to.waitForExistence(timeout: UITestApp.timeout), "no To field")
    to.click()
    to.typeText("+15550100099")
    let typed = QueueUI.element(app, ID.composeResultTyped)
    XCTAssertTrue(typed.waitForExistence(timeout: UITestApp.timeout), "a typed handle got no row")
    typed.click()
    XCTAssertTrue(
      QueueUI.element(app, ID.composeRefusal).waitForExistence(timeout: UITestApp.timeout),
      "no refusal for a handle with no conversation")
    XCTAssertEqual(QueueUI.value(app, ID.composeChannelPrefix + "imessage"), "no conversation")
    XCTAssertFalse(QueueUI.element(app, ID.composeSend).exists, "Send is drawn beside a refusal")
    XCTAssertFalse(QueueUI.element(app, ID.composeField).exists, "an input is drawn beside a refusal")
    var requests = try await FakeDaemon.journal().requests
    XCTAssertTrue(
      requests.contains { $0.path == "/v1/threads/by-handle/%2B15550100099" && $0.status == 200 },
      "compose never asked the daemon: \(requests)")
    XCTAssertEqual(requests.filter { $0.method != "GET" }, [], "a refused handle reached a write")

    // Relaunched (there is no way back from a chosen person), Maya drafts on
    // the daemon's guid.
    app.terminate()
    app.launch()
    to = QueueUI.element(app, ID.composeTo)
    XCTAssertTrue(to.waitForExistence(timeout: UITestApp.timeout), "no To field after the relaunch")
    to.click()
    to.typeText("ma")
    let maya = QueueUI.element(app, ID.composeResultPrefix + "maya")
    XCTAssertTrue(maya.waitForExistence(timeout: UITestApp.timeout), "ma did not resolve to Maya")
    maya.click()
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.value(app, ID.composeChannelPrefix + "imessage") == "default" },
      "the iMessage card reads \(QueueUI.value(app, ID.composeChannelPrefix + "imessage"))")
    let field = QueueUI.element(app, ID.composeField)
    XCTAssertTrue(field.waitForExistence(timeout: UITestApp.timeout), "no input for Maya")
    field.click()
    field.typeText("Saturday at 9?")
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.value(app, ID.composeSend) == "enabled" },
      "Send reads \(QueueUI.value(app, ID.composeSend))")
    QueueUI.element(app, ID.composeSend).click()
    _ = try await FakeDaemon.waitForRequests(["POST /v1/drafts"])

    requests = try await FakeDaemon.journal().requests
    XCTAssertEqual(requests.filter { $0.path.hasPrefix("/v1/send") }, [], "compose asked to send")
    let drafts = requests.filter { $0.method == "POST" && $0.path == "/v1/drafts" }
    XCTAssertEqual(drafts.map(\.status), [201], "compose wrote \(drafts.count) drafts")
    XCTAssertEqual(drafts.first?.chatGuid, "any;-;+15550100001", "the draft is not on the daemon's guid")
    XCTAssertEqual(
      requests.filter { $0.method != "GET" }.map(\.description), ["POST /v1/drafts 201"],
      "compose wrote something besides the draft")
  }
}
