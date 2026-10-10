import AppKit
import Foundation
import XCTest

/// v2 S4i: board 11, search. One launch per appearance, no more (the UI
/// job's time budget), over the fake daemon's "search" scenario: the rich
/// inbox plus a Maya transcript from 2022 to today. Search runs over what
/// the daemon's index serves (GET /v1/search, v2 F2); nothing reads a chat.db. The
/// launch never touches the mouse while a key can do it:
/// - shift-cmd-F opens search with its field holding the keyboard; "cabin"
///   is four results, newest first, the first selected (11.A);
/// - operators are chips, and an operator that does not parse is a dashed
///   chip that says why, never silently dropped; zero results are board
///   10's "Nothing for ..." empty (11.B, 11.G);
/// - a bare Return opens nothing; cmd-Return opens the selected result in
///   its thread with the year scrubber beside it, and opt-cmd-down and
///   opt-cmd-up step a year (11.D, 11.F);
/// - cmd-F finds in the open thread, newest match first, down steps older;
///   Escape closes it, and the next Escape goes back to the same results
///   (11.C, 11.D);
/// - cmd-K opens the switcher empty, every time: "theo", Escape, cmd-K
///   again and nothing of "theo" is left (11.E).
/// The light launch runs the accessibility audit once, on the results.
/// The launch ends on the
/// journal: no send, no draft action, no write. Shots are
/// board-11-<state>-<appearance>.png. CI only.
final class Board11Tests: XCTestCase {
  override func setUp() async throws {
    try await FakeDaemon.reset()
  }

  static let theo = "iMessage;-;theo.lindqvist@example.com"

  @MainActor
  func testBoard11Light() async throws {
    try await search(appearance: "light")
  }

  @MainActor
  func testBoard11Dark() async throws {
    try await search(appearance: "dark")
  }

  /// v2 F2: while the daemon is still building its index, the coverage
  /// says how far it is, and a token honoured in part says so on its chip
  /// (D-UI-204, D-UI-207). One light launch, over "search-indexing".
  @MainActor
  func testBoard11IndexingLight() async throws {
    try await FakeDaemon.scenario("search-indexing")
    let app = UITestApp.make(appearance: "light", reduceTransparency: false)
    app.launch()
    defer { app.terminate() }
    XCTAssertTrue(UITestApp.shellElement(app).waitForExistence(timeout: UITestApp.timeout), "the shell never appeared")
    let row = QueueUI.element(app, ID.rowPrefix + QueueUI.maya)
    XCTAssertTrue(row.waitForExistence(timeout: UITestApp.timeout), "the thread list never loaded")
    app.typeKey("f", modifierFlags: [.command, .shift])
    XCTAssertTrue(QueueUI.element(app, ID.search).waitForExistence(timeout: UITestApp.timeout), "shift-cmd-F opened no search")
    type(app, into: ID.searchField, "from:maya cabin")
    XCTAssertTrue(QueueUI.waitUntil { self.results(app) == 1 }, "from:maya cabin: \(results(app)) results")
    XCTAssertTrue(selected(app, "msg-0504"), "the one result is not selected")
    let coverage = QueueUI.label(app, ID.searchCoverage)
    XCTAssertTrue(coverage.contains("Indexing iMessage: 41%"), "coverage: \(coverage)")
    XCTAssertTrue(coverage.contains("Not searched: "), "coverage names no unsearched channel: \(coverage)")
    let chip = ID.searchTokenPrefix + "0"
    XCTAssertEqual(QueueUI.value(app, chip), "parsed", "a partial token is drawn as parsed")
    let word = ProvisionalUI.searchChipWords["handles-and-saved-names"] ?? "missing"
    XCTAssertTrue(QueueUI.label(app, chip).contains(word), "the partial chip says nothing: \(QueueUI.label(app, chip))")
    QueueUI.settle()
    glance(app, name: "board-11-indexing-light.png")
    try await QueueUI.assertJournal("board 11 indexing")
  }

  @MainActor
  private func results(_ app: XCUIApplication) -> Int {
    QueueUI.count(app, containing: ID.searchResultPrefix)
  }

  @MainActor
  private func selected(_ app: XCUIApplication, _ guid: String) -> Bool {
    QueueUI.value(app, ID.searchResultPrefix + guid) == "selected"
  }

  /// Types into a board 11 field, which must already hold the keyboard:
  /// it was opened by a key, and keyboard-first means no click. On a miss
  /// the test fails, then clicks once so the rest of the launch still runs.
  @MainActor
  private func type(_ app: XCUIApplication, into id: String, _ text: String) {
    let field = QueueUI.element(app, id)
    XCTAssertTrue(field.waitForExistence(timeout: UITestApp.timeout), "no \(id)")
    let holding = NSPredicate(format: "identifier == %@ AND hasKeyboardFocus == true", id)
    let focused = QueueUI.waitUntil(3) { app.descendants(matching: .any).matching(holding).count > 0 }
    XCTAssertTrue(focused, "\(id) did not take the keyboard when it opened")
    if !focused {
      print("BOARD11| claim-miss \(id)")
      field.click()
    }
    app.typeText(text)
  }

  /// Replaces the focused field's text.
  @MainActor
  private func retype(_ app: XCUIApplication, _ text: String) {
    app.typeKey("a", modifierFlags: .command)
    app.typeText(text)
  }

  @MainActor
  private func search(appearance: String) async throws {
    try await FakeDaemon.scenario("search")
    let app = UITestApp.make(appearance: appearance, reduceTransparency: false)
    app.launch()
    defer { app.terminate() }
    XCTAssertTrue(UITestApp.shellElement(app).waitForExistence(timeout: UITestApp.timeout), "the shell never appeared")
    let row = QueueUI.element(app, ID.rowPrefix + QueueUI.maya)
    XCTAssertTrue(row.waitForExistence(timeout: UITestApp.timeout), "the thread list never loaded")
    let started = Date()
    let light = appearance == "light"
    let shot: (String) -> Void = { state in
      QueueUI.settle()
      self.glance(app, name: "board-11-\(state)-\(appearance).png")
    }

    // 11.A: shift-cmd-F, from anywhere; the panes give way to search.
    app.typeKey("f", modifierFlags: [.command, .shift])
    XCTAssertTrue(QueueUI.element(app, ID.search).waitForExistence(timeout: UITestApp.timeout), "shift-cmd-F opened no search")
    XCTAssertFalse(QueueUI.element(app, ID.composer).exists, "the composer is drawn under search")
    type(app, into: ID.searchField, "cabin")
    XCTAssertTrue(QueueUI.waitUntil { self.results(app) == 4 }, "cabin: \(results(app)) results")
    XCTAssertTrue(selected(app, "msg-0510"), "the newest result is not selected first")
    XCTAssertTrue(QueueUI.element(app, ID.searchGroupPrefix + "imessage").exists, "no iMessage group")
    let coverage = QueueUI.label(app, ID.searchCoverage)
    XCTAssertTrue(coverage.hasPrefix("Searched "), "coverage: \(coverage)")
    XCTAssertTrue(coverage.contains("Not searched: "), "coverage names no unsearched channel: \(coverage)")
    XCTAssertTrue(QueueUI.element(app, ID.searchFacets).exists, "no facets")
    shot("results")
    if light { try audit(app, window: "audit-board-11-results") }
    QueueUI.printTime("BOARD11", appearance, "results", since: started)

    // 11.B: operators are chips; all three parse.
    retype(app, "from:me cabin after:2024-06-01")
    XCTAssertTrue(QueueUI.waitUntil { self.results(app) == 2 }, "tokens: \(results(app)) results")
    for index in 0..<3 {
      XCTAssertEqual(QueueUI.value(app, ID.searchTokenPrefix + String(index)), "parsed", "chip \(index)")
    }
    XCTAssertTrue(selected(app, "msg-0510"), "tokens: the newest result is not selected")
    shot("tokens")

    // 11.G: an operator that does not parse is a dashed chip that says
    // why; it narrows to nothing rather than vanishing, and the empty is
    // board 10's.
    app.typeText(" before:last")
    let unparsed = ID.searchTokenPrefix + "3"
    XCTAssertTrue(QueueUI.waitUntil { QueueUI.value(app, unparsed) == "unparsed" }, "before:last: \(QueueUI.value(app, unparsed))")
    XCTAssertTrue(QueueUI.label(app, unparsed).contains("before"), "unparsed chip: \(QueueUI.label(app, unparsed))")
    let empty = QueueUI.element(app, ID.emptyPrefix + "search")
    XCTAssertTrue(empty.waitForExistence(timeout: UITestApp.timeout), "zero results drew no board 10 empty")
    XCTAssertTrue(QueueUI.label(app, ID.emptyPrefix + "search").hasPrefix("Nothing for "), "empty: \(QueueUI.label(app, ID.emptyPrefix + "search"))")
    XCTAssertEqual(results(app), 0)
    shot("unparsed")
    QueueUI.printTime("BOARD11", appearance, "tokens", since: started)

    // 11.D: arrows move; a bare Return opens nothing; cmd-Return opens the
    // result in its thread, the scrubber beside it on the result's year.
    retype(app, "cabin")
    XCTAssertTrue(QueueUI.waitUntil { self.results(app) == 4 }, "cabin again: \(results(app)) results")
    app.typeKey(.downArrow, modifierFlags: [])
    app.typeKey(.downArrow, modifierFlags: [])
    XCTAssertTrue(QueueUI.waitUntil { self.selected(app, "msg-0504") }, "two downs did not reach msg-0504")
    app.typeKey(.return, modifierFlags: [])
    QueueUI.settle()
    XCTAssertTrue(QueueUI.element(app, ID.search).exists, "a bare Return opened a result")
    app.typeKey(.return, modifierFlags: .command)
    XCTAssertTrue(QueueUI.waitUntil { !QueueUI.element(app, ID.search).exists }, "cmd-Return left search up")
    let thread = QueueUI.element(app, ID.thread)
    XCTAssertTrue(QueueUI.waitUntil { thread.exists && thread.label.hasSuffix(": loaded") }, "the jump loaded no thread: \(thread.label)")
    XCTAssertTrue(QueueUI.element(app, ID.scrubber).waitForExistence(timeout: UITestApp.timeout), "no scrubber after the jump")
    let year = { (y: Int) in QueueUI.value(app, ID.scrubberYearPrefix + String(y)) }
    XCTAssertEqual(year(2024), "viewing")
    XCTAssertEqual(year(2023), "empty", "the empty year is not kept, muted")
    // 11.F: opt-cmd-down is a year older, opt-cmd-up a year newer.
    app.typeKey(.downArrow, modifierFlags: [.command, .option])
    XCTAssertTrue(QueueUI.waitUntil { year(2023) == "viewing" }, "opt-cmd-down: 2023 reads \(year(2023))")
    app.typeKey(.upArrow, modifierFlags: [.command, .option])
    XCTAssertTrue(QueueUI.waitUntil { year(2024) == "viewing" }, "opt-cmd-up: 2024 reads \(year(2024))")
    let line = QueueUI.label(app, ID.scrubberLine)
    XCTAssertTrue(line.hasPrefix("viewing 2024 "), "scrubber line: \(line)")
    shot("scrubber")
    QueueUI.printTime("BOARD11", appearance, "scrubber", since: started)

    // 11.C: cmd-F in the open thread; newest match first, down is older.
    app.typeKey("f", modifierFlags: .command)
    XCTAssertTrue(QueueUI.element(app, ID.findBar).waitForExistence(timeout: UITestApp.timeout), "cmd-F opened no find bar")
    type(app, into: ID.findField, "cabin")
    XCTAssertTrue(QueueUI.waitUntil { QueueUI.label(app, ID.findCounter) == "1 of 4" }, "find: \(QueueUI.label(app, ID.findCounter))")
    app.typeKey(.downArrow, modifierFlags: [])
    XCTAssertTrue(QueueUI.waitUntil { QueueUI.label(app, ID.findCounter) == "2 of 4" }, "down: \(QueueUI.label(app, ID.findCounter))")
    shot("find")
    // No second audit here: it cost 25 s of the light launch (run
    // 37764667738) and the budget is 2 min; the counter's ink, the one
    // thing it ever caught, is pinned by H-S4-8.
    // Escape closes the bar; the next goes back to the same results.
    app.typeKey(.escape, modifierFlags: [])
    XCTAssertTrue(QueueUI.waitUntil { !QueueUI.element(app, ID.findBar).exists }, "Escape left the find bar up")
    app.typeKey(.escape, modifierFlags: [])
    XCTAssertTrue(QueueUI.element(app, ID.search).waitForExistence(timeout: UITestApp.timeout), "Escape did not go back to the results")
    XCTAssertTrue(QueueUI.waitUntil { self.selected(app, "msg-0504") }, "back: msg-0504 is not selected")
    app.typeKey(.escape, modifierFlags: [])
    XCTAssertTrue(QueueUI.waitUntil { !QueueUI.element(app, ID.search).exists }, "Escape left search up")
    QueueUI.printTime("BOARD11", appearance, "find", since: started)

    // 11.E: cmd-K opens empty, every time; nothing of the last query stays.
    app.typeKey("k", modifierFlags: .command)
    XCTAssertTrue(QueueUI.element(app, ID.switcher).waitForExistence(timeout: UITestApp.timeout), "cmd-K opened no switcher")
    type(app, into: ID.switcherField, "theo")
    XCTAssertTrue(
      QueueUI.element(app, ID.switcherRowPrefix + "thread:" + Self.theo).waitForExistence(timeout: UITestApp.timeout), "theo: no row")
    app.typeKey(.escape, modifierFlags: [])
    XCTAssertTrue(QueueUI.waitUntil { !QueueUI.element(app, ID.switcher).exists }, "Escape left the switcher up")
    app.typeKey("k", modifierFlags: .command)
    XCTAssertTrue(QueueUI.element(app, ID.switcher).waitForExistence(timeout: UITestApp.timeout), "cmd-K did not reopen")
    XCTAssertEqual(QueueUI.value(app, ID.switcherField), "", "the switcher reopened on the last query")
    XCTAssertEqual(QueueUI.count(app, containing: ID.switcherRowPrefix), 0, "the switcher reopened with stale rows")
    type(app, into: ID.switcherField, "ma")
    let maya = ID.switcherRowPrefix + "thread:" + QueueUI.maya
    XCTAssertTrue(QueueUI.element(app, maya).waitForExistence(timeout: UITestApp.timeout), "ma: no Maya row")
    shot("switcher")
    app.typeKey(.escape, modifierFlags: [])
    XCTAssertTrue(QueueUI.waitUntil { !QueueUI.element(app, ID.switcher).exists }, "Escape left the switcher up")

    QueueUI.printTime("BOARD11", appearance, "switcher", since: started)
    try await QueueUI.assertJournal("board 11 \(appearance)")
  }
}
