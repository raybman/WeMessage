import Foundation
import XCTest

/// v2 F1: the app against the fake daemon's `long` scenario, 250 threads
/// (three pages of the list) and a 450-turn transcript on the newest one
/// (three pages of turns). Scrolling the list to its end reads the two
/// older pages and draws the 250th chat; scrolling the transcript to its
/// top reads the two older pages and draws the first turn. CI only.
final class PagingTests: XCTestCase {
  override func setUp() async throws {
    try await FakeDaemon.reset()
  }

  /// The newest thread in tools/swift/bulk.mjs LONG: index 0, a +1555 number.
  static let newest = "iMessage;-;+15552000000"
  /// The 250th thread, index 249, a generated group (test/swift-scenarios.spec.ts
  /// holds this to the generator).
  static let last = "iMessage;+;chat5552000249"
  /// The newest thread's first and last turns.
  static let firstTurn = "bulk-0-0000"
  static let lastTurn = "bulk-0-0449"

  @MainActor
  func testScrollToTheLastChat() async throws {
    try await FakeDaemon.scenario("long")
    let app = UITestApp.make(appearance: "light")
    app.launch()
    defer { app.terminate() }
    let top = element(app, ID.rowPrefix + Self.newest)
    XCTAssertTrue(waitUntil { top.exists && top.isHittable }, "the newest chat was never drawn")
    let sidebar = element(app, ID.sidebar)
    let target = element(app, ID.rowPrefix + Self.last)
    // The wheel's sign differs between hosts: the way that hides the top
    // row is the way to the end.
    let delta = towardEnd(sidebar, hides: top)
    for _ in 0..<120 where !(target.exists && target.isHittable) {
      sidebar.scroll(byDeltaX: 0, deltaY: delta)
      settle()
    }
    XCTAssertTrue(target.exists && target.isHittable, "the 250th chat was never drawn")
    let reads = try await FakeDaemon.journal().requests.filter { $0.path == "/v1/threads" }
    let older = reads.map(\.query).filter { !$0.isEmpty }
    XCTAssertEqual(older, ["cursor=o100", "cursor=o200"], "the list read other pages: \(reads)")
    XCTAssertTrue(reads.allSatisfy { $0.status == 200 })
  }

  @MainActor
  func testScrollToTheFirstTurn() async throws {
    try await FakeDaemon.scenario("long")
    let app = UITestApp.make(appearance: "light")
    app.launch()
    defer { app.terminate() }
    let row = element(app, ID.rowPrefix + Self.newest)
    XCTAssertTrue(waitUntil { row.exists && row.isHittable }, "the newest chat was never drawn")
    row.click()
    let thread = element(app, ID.thread)
    XCTAssertTrue(waitUntil { thread.exists && thread.label.hasSuffix(": loaded") }, "the long thread reads \(thread.label)")
    let newestTurn = element(app, ID.bubblePrefix + Self.lastTurn)
    XCTAssertTrue(waitUntil { newestTurn.exists && newestTurn.isHittable }, "the newest turn was never drawn")
    let transcript = app.descendants(matching: .any)
      .matching(NSPredicate(format: "label == %@", "Transcript")).firstMatch
    XCTAssertTrue(transcript.exists, "no transcript")
    let target = element(app, ID.bubblePrefix + Self.firstTurn)
    let delta = towardEnd(transcript, hides: newestTurn)
    for _ in 0..<200 where !(target.exists && target.isHittable) {
      transcript.scroll(byDeltaX: 0, deltaY: delta)
      settle()
    }
    XCTAssertTrue(target.exists && target.isHittable, "the first turn was never drawn")
    let reads = try await FakeDaemon.journal().requests.filter { $0.path.hasSuffix("/messages") }
    XCTAssertEqual(reads.first?.query, "limit=200", "the first read changed: \(reads)")
    let befores = reads.compactMap { read in
      read.query.split(separator: "&").first { $0.hasPrefix("before=") }.map(String.init)
    }
    XCTAssertEqual(befores, ["before=o200", "before=o400"], "the transcript read other pages: \(reads)")
    XCTAssertTrue(reads.allSatisfy { $0.status == 200 })
  }

  // MARK: Helpers

  /// The scroll delta that moves `view` away from `shown`: one probe each
  /// way, keeping the one that hid it.
  @MainActor
  private func towardEnd(_ view: XCUIElement, hides shown: XCUIElement) -> CGFloat {
    view.scroll(byDeltaX: 0, deltaY: -600)
    settle()
    if !shown.isHittable { return -600 }
    view.scroll(byDeltaX: 0, deltaY: 600)
    view.scroll(byDeltaX: 0, deltaY: 600)
    settle()
    return 600
  }

  @MainActor
  private func settle() {
    Thread.sleep(forTimeInterval: 0.15)
  }

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: id).firstMatch
  }

  /// Polls until `done` holds or the wait runs out; true when it held.
  @MainActor
  private func waitUntil(_ done: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(UITestApp.timeout)
    var held = done()
    while !held && Date() < deadline {
      Thread.sleep(forTimeInterval: 0.05)
      held = done()
    }
    return held
  }
}
