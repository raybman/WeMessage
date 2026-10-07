import Foundation
import XCTest

/// v2 S4b: the proof that the FakeDaemon helper works end to end. The test
/// resets, serves the "degraded" scenario, launches the app, and reads back
/// what the app did: its connection line says the scenario's state, the
/// journal holds the status read and the resync, and nothing was sent.
/// CI only (the ci-swift `ui` job).
final class FakeDaemonControlTests: XCTestCase {
  override func setUp() async throws {
    try await FakeDaemon.reset()
  }

  @MainActor
  private func connectionValue(_ app: XCUIApplication, until done: (String) -> Bool) -> String {
    let line = app.descendants(matching: .any)[ID.connection]
    let deadline = Date().addingTimeInterval(UITestApp.timeout)
    var last = ""
    repeat {
      last = (line.value as? String) ?? ""
      if done(last) { return last }
      Thread.sleep(forTimeInterval: 0.25)
    } while Date() < deadline
    return last
  }

  @MainActor
  func testScenarioDrivesTheAppAndTheJournalSeesIt() async throws {
    let fresh = try await FakeDaemon.journal()
    XCTAssertEqual(fresh.scenario, "default")
    XCTAssertEqual(fresh.requests, [], "reset left requests in the journal")

    try await FakeDaemon.scenario("degraded")
    let app = UITestApp.make(appearance: "light")
    app.launch()
    XCTAssertTrue(UITestApp.shellElement(app).waitForExistence(timeout: UITestApp.timeout), "the shell never appeared")
    let expected = ProvisionalUI.connectedLine(state: "read-only")
    XCTAssertEqual(connectionValue(app) { $0 == expected }, expected)

    let journal = try await FakeDaemon.waitForRequests(["GET /v1/status", "GET /v1/events/sse", "GET /v1/drafts"])
    XCTAssertEqual(journal.scenario, "degraded")
    let seen = Set(journal.requests.map { "\($0.method) \($0.path)" })
    for wanted in ["GET /v1/status", "GET /v1/events/sse", "GET /v1/drafts"] {
      XCTAssertTrue(seen.contains(wanted), "\(wanted) never reached the fake daemon: \(journal.requests)")
    }
    XCTAssertEqual(journal.requests.filter { $0.status == 401 }, [], "the app's bearer was refused")
    try await FakeDaemon.assertNoSend()
    app.terminate()
  }
}
