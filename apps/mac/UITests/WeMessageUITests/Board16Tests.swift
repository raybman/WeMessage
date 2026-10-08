import AppKit
import Foundation
import XCTest

/// v2 S4l: board 16, the OS layer. WEMESSAGE_UI_BOARD=16 opens a window of
/// its own over fixtures (D-UI-112): the popover's content view at 360 by
/// 480, the extra's five glyphs, the Dock badge and Dock menu, and the
/// notification sets. No status item is made, no Dock badge is set and
/// nothing is registered with the notification center under the flag; the
/// board builds no client. The Menu tab reads back the main menu the
/// delegate installed in the application, so testMenuTitlesAndIds checks
/// the live menu, not the table. Shots are board-16-<state>-<appearance>.png.
/// CI only.
final class Board16Tests: XCTestCase {
  override func setUp() async throws {
    try await FakeDaemon.reset()
  }

  @MainActor
  func testBoard16PopoverLight() async throws {
    try await healthy(appearance: "light")
  }

  @MainActor
  func testBoard16PopoverDark() async throws {
    try await healthy(appearance: "dark")
  }

  /// 16.B degraded: "Cannot say", no number and no rows, the per-source
  /// table with the stale one named, and no Dock badge.
  @MainActor
  func testBoard16PopoverDegraded() async throws {
    let app = try await Self.launch(appearance: "light")
    defer { app.terminate() }
    Self.page(app, "degraded")
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.label(app, ID.popover) == "degraded" },
      "the popover reads \(QueueUI.label(app, ID.popover))")
    XCTAssertEqual(QueueUI.label(app, ID.popoverTitle), "Cannot say")
    XCTAssertFalse(QueueUI.label(app, ID.popoverTitle).contains("9"), "a number is shown while degraded")
    XCTAssertEqual(QueueUI.count(app, containing: ID.popoverRowPrefix), 0, "rows are drawn while degraded")
    XCTAssertTrue(QueueUI.label(app, ID.popoverLine).contains("3 of 4 sources synced"), QueueUI.label(app, ID.popoverLine))
    XCTAssertTrue(
      QueueUI.label(app, ID.popoverSourcePrefix + "whatsapp").contains("STALE"),
      "WhatsApp is not named stale: \(QueueUI.label(app, ID.popoverSourcePrefix + "whatsapp"))")
    XCTAssertTrue(QueueUI.label(app, ID.popoverNotes).contains("6h 12m"), QueueUI.label(app, ID.popoverNotes))
    XCTAssertTrue(
      QueueUI.label(app, ID.osLayerDock).hasPrefix("Dock badge none. Cannot say"),
      "the Dock reads \(QueueUI.label(app, ID.osLayerDock))")
    XCTAssertEqual(QueueUI.label(app, ID.osLayerGlyphPrefix + "degraded"), "WeMessage, cannot say, a source is stale")
    QueueUI.settle()
    glance(app, name: "board-16-popover-degraded-light.png")
    try audit(app, window: "audit-board-16-degraded")
    try await Self.assertNothingSent()
    print("BOARD16| degraded")
  }

  /// 16.B killed: the kill line, no draft rows, the held count, and release
  /// lives in the app; no Dock badge.
  @MainActor
  func testBoard16PopoverKilled() async throws {
    let app = try await Self.launch(appearance: "light")
    defer { app.terminate() }
    Self.page(app, "killed")
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.label(app, ID.popover) == "killed" },
      "the popover reads \(QueueUI.label(app, ID.popover))")
    XCTAssertEqual(QueueUI.label(app, ID.popoverTitle), "Kill switch on")
    XCTAssertTrue(QueueUI.label(app, ID.popoverLine).contains("Nothing can send"), QueueUI.label(app, ID.popoverLine))
    XCTAssertEqual(QueueUI.count(app, containing: ID.popoverRowPrefix), 0, "draft rows are drawn under the kill switch")
    let notes = QueueUI.label(app, ID.popoverNotes)
    XCTAssertTrue(notes.contains("9 held"), "the held count is missing: \(notes)")
    XCTAssertTrue(notes.contains("Open WeMessage to release"), "release is offered outside the app: \(notes)")
    XCTAssertEqual(
      app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'release'")).count, 0, "a release button is drawn")
    XCTAssertTrue(
      QueueUI.label(app, ID.osLayerDock).hasPrefix("Dock badge none."), "the Dock reads \(QueueUI.label(app, ID.osLayerDock))")
    XCTAssertEqual(QueueUI.label(app, ID.osLayerGlyphPrefix + "killed"), "WeMessage, kill switch on, nothing can send")
    QueueUI.settle()
    glance(app, name: "board-16-popover-killed-light.png")
    try audit(app, window: "audit-board-16-killed")
    try await Self.assertNothingSent()
    print("BOARD16| killed")
  }

  /// 16.G read back from the application's installed main menu: every id,
  /// the eight titles, the accelerators table, no bare letter, no kill
  /// accelerator, and no Approve.
  @MainActor
  func testMenuTitlesAndIds() async throws {
    let app = try await Self.launch(appearance: "light")
    defer { app.terminate() }
    Self.page(app, "menu")
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.label(app, ID.osLayerMenu).contains("agent:kill") },
      "the menu was never read back: \(QueueUI.label(app, ID.osLayerMenu).prefix(200))")
    let all = QueueUI.label(app, ID.osLayerMenu).components(separatedBy: "\n").map {
      $0.components(separatedBy: " | ")
    }
    XCTAssertTrue(all.allSatisfy { $0.count == 5 }, "a malformed line: \(all.first { $0.count != 5 } ?? [])")
    // Ours, by the table's id prefixes; anything macOS inserts on its own
    // (Dictation, Emoji & Symbols, tab and window items) is left to it.
    let rows = all.filter { row in row.count == 5 && Self.prefixes.contains { row[1].hasPrefix($0) } }
    let ids = rows.map { $0[1] }
    XCTAssertEqual(Set(ids).count, ids.count, "an id repeats")
    for id in Self.expectedIds {
      XCTAssertTrue(ids.contains(id), "\(id) is not in the installed menu")
    }
    XCTAssertEqual(ids.count, Self.expectedIds.count, "extra items: \(Set(ids).subtracting(Self.expectedIds).sorted())")
    // All scope by default: Hold Until is an iMessage and Email feature.
    XCTAssertFalse(ids.contains { $0.hasPrefix("thread:hold-until") }, "Hold Until in the All scope")
    let top = rows.filter { !$0[0].contains(" > ") }.map { $0[2] }
    XCTAssertEqual(top, ["WeMessage", "File", "Edit", "View", "Thread", "Agent", "Window", "Help"])
    let chords = Dictionary(rows.filter { !$0[3].isEmpty }.map { ($0[1], $0[3]) }, uniquingKeysWith: { a, _ in a })
    XCTAssertEqual(chords, Self.accelerators)
    for (id, chord) in chords {
      XCTAssertTrue(chord.contains("\u{2318}") || chord.contains("\u{2303}"), "\(id) binds a bare \(chord)")
    }
    let kill = rows.first { $0[1] == "agent:kill" }
    XCTAssertEqual(kill?[3], "", "the kill switch carries an accelerator")
    let approve = all.filter { $0.count == 5 && $0[2].contains("Approv") }
    XCTAssertEqual(approve.map { $0[1] }, ["thread:approve-note"], "Approve is offered")
    XCTAssertEqual(approve.first?[4], "text", "the approve line is not disabled text")
    for title in ["Approve", "Send", "Release Kill Switch", "Reload", "Save", "Print", "Archive"] {
      XCTAssertFalse(all.contains { $0.count == 5 && $0[2] == title }, "the menu offers \(title)")
    }
    for id in ["edit:smart-dashes", "edit:autocorrect"] {
      XCTAssertEqual(rows.first { $0[1] == id }?[4], "", "\(id) is on")
    }
    // The menu bar the user sees carries the same eight titles.
    for title in ["File", "Edit", "View", "Thread", "Agent", "Window", "Help"] {
      XCTAssertTrue(app.menuBars.menuBarItems[title].exists, "the menu bar has no \(title)")
    }
    XCTAssertFalse(app.menuBars.menuBarItems["Format"].exists, "a Format menu is installed")
    XCTAssertFalse(app.menuBars.menuBarItems["Go"].exists, "a Go menu is installed")
    QueueUI.settle()
    glance(app, name: "board-16-menu-light.png")
    try await Self.assertNothingSent()
    print("BOARD16| menu items=\(ids.count)")
  }

  // MARK: The walk

  /// Every 16.G id the installed menu carries in the All scope. Rows macOS
  /// inserts itself (Start Dictation, Emoji & Symbols) are not ours.
  static let expectedIds: [String] = [
    "menu:app", "app:about", "app:settings", "app:services", "app:hide", "app:hide-others", "app:unhide", "app:quit",
    "menu:file", "file:new", "file:close",
    "menu:edit", "edit:undo", "edit:redo", "edit:cut", "edit:copy", "edit:paste", "edit:paste-plain", "edit:delete",
    "edit:select-all", "edit:find-menu", "edit:find", "edit:find-next", "edit:find-prev", "edit:find-all",
    "edit:spelling", "edit:spell-panel", "edit:spell-now", "edit:autocorrect", "edit:substitutions",
    "edit:smart-dashes", "edit:speech", "edit:speak", "edit:stop-speak",
    "menu:view", "view:lens-recent", "view:lens-needs", "view:lens-triage", "view:scope-all", "view:scope-imessage",
    "view:scope-whatsapp", "view:scope-linkedin", "view:scope-email", "view:inspector", "view:fullscreen",
    "menu:thread", "thread:open", "thread:next", "thread:prev", "thread:switcher", "thread:reply", "thread:done",
    "thread:snooze", "thread:snooze:later-today", "thread:snooze:tonight", "thread:snooze:tomorrow",
    "thread:snooze:weekend", "thread:snooze:next-week", "thread:snooze:pick", "thread:mute", "thread:mute:demote",
    "thread:mute:thread", "thread:mute:sender", "thread:undo", "thread:mode", "thread:mode:queue",
    "thread:mode:stream", "thread:mode:muted", "thread:mark-read", "thread:copy-link", "thread:approve-note",
    "menu:agent", "agent:posture", "agent:draft-here", "agent:why", "agent:pause", "agent:pause:hour",
    "agent:pause:tomorrow", "agent:pause:today", "agent:pause:resume", "agent:kill", "agent:log",
    "menu:window", "win:minimize", "win:zoom", "win:show", "win:front",
    "menu:help", "help:help", "help:shortcuts", "help:limits", "help:setup",
  ]

  static let prefixes = ["menu:", "app:", "file:", "edit:", "view:", "thread:", "agent:", "win:", "help:"]

  /// The 16.G accelerators, by id; every other item binds nothing.
  static let accelerators: [String: String] = [
    "app:settings": "\u{2318},", "app:hide": "\u{2318}H", "app:hide-others": "\u{2325}\u{2318}H",
    "app:quit": "\u{2318}Q", "file:new": "\u{2318}N", "file:close": "\u{2318}W", "edit:undo": "\u{2318}Z",
    "edit:redo": "\u{21E7}\u{2318}Z", "edit:cut": "\u{2318}X", "edit:copy": "\u{2318}C", "edit:paste": "\u{2318}V",
    "edit:paste-plain": "\u{2325}\u{21E7}\u{2318}V", "edit:select-all": "\u{2318}A", "edit:find": "\u{2318}F",
    "edit:find-next": "\u{2318}G", "edit:find-prev": "\u{21E7}\u{2318}G", "edit:find-all": "\u{21E7}\u{2318}F",
    "edit:spell-panel": "\u{2318}:", "edit:spell-now": "\u{2318};", "view:lens-recent": "\u{21E7}\u{2318}R",
    "view:lens-needs": "\u{21E7}\u{2318}N", "view:lens-triage": "\u{2318}T", "view:scope-all": "\u{2318}1",
    "view:scope-imessage": "\u{2318}2", "view:scope-whatsapp": "\u{2318}3", "view:scope-linkedin": "\u{2318}4",
    "view:scope-email": "\u{2318}5", "view:fullscreen": "\u{2303}\u{2318}F", "thread:next": "\u{21E7}\u{2318}]",
    "thread:prev": "\u{21E7}\u{2318}[", "thread:switcher": "\u{2318}K", "thread:mark-read": "\u{21E7}\u{2318}A",
    "win:minimize": "\u{2318}M",
  ]

  @MainActor
  private static func launch(appearance: String) async throws -> XCUIApplication {
    try await FakeDaemon.scenario("rich")
    let app = UITestApp.make(appearance: appearance, reduceTransparency: false, board: "16")
    app.launch()
    let window = QueueUI.element(app, ID.osLayer)
    XCTAssertTrue(window.waitForExistence(timeout: UITestApp.timeout), "the OS layer window never appeared")
    XCTAssertFalse(UITestApp.shellElement(app).exists, "the shell is drawn beside the OS layer")
    return app
  }

  @MainActor
  private static func page(_ app: XCUIApplication, _ name: String) {
    let tab = QueueUI.element(app, ID.osLayerTabPrefix + name)
    XCTAssertTrue(tab.waitForExistence(timeout: UITestApp.timeout), "no \(name) tab")
    tab.click()
  }

  /// The board asks the daemon for nothing it could act on: no send, no
  /// write of any kind.
  @MainActor
  private static func assertNothingSent() async throws {
    let requests = try await FakeDaemon.journal().requests
    XCTAssertEqual(requests.filter { $0.path.hasPrefix("/v1/send") }, [], "the OS layer asked to send")
    XCTAssertEqual(requests.filter { $0.method != "GET" }.map(\.description), [], "the OS layer wrote to the daemon")
  }

  /// 16.B healthy, then 16.H's confirm inside the popover, in one launch.
  @MainActor
  private func healthy(appearance: String) async throws {
    let app = try await Self.launch(appearance: appearance)
    defer { app.terminate() }
    let started = Date()
    let light = appearance == "light"
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.label(app, ID.popover) == "healthy" },
      "the popover reads \(QueueUI.label(app, ID.popover))")
    XCTAssertEqual(QueueUI.label(app, ID.popoverTitle), "9 left")
    XCTAssertTrue(QueueUI.label(app, ID.popoverStamp).hasSuffix("16:42:07"), QueueUI.label(app, ID.popoverStamp))
    let line = QueueUI.label(app, ID.popoverLine)
    XCTAssertTrue(line.hasPrefix("3 drafts ready \u{00B7} 6 unanswered"), "the line reads \(line)")
    // The oldest four, drafts before messages: three drafts, then the
    // oldest message; the rest as a sentence. The list never scrolls.
    XCTAssertEqual(QueueUI.count(app, containing: ID.popoverRowPrefix), 4)
    for id in ["d3", "d2", "d1", "m6"] {
      XCTAssertTrue(QueueUI.element(app, ID.popoverRowPrefix + id).exists, "row \(id) is missing")
    }
    XCTAssertFalse(QueueUI.element(app, ID.popoverRowPrefix + "m5").exists, "a fifth row is drawn")
    let rowsTop = ["d3", "d2", "d1", "m6"].map { QueueUI.element(app, ID.popoverRowPrefix + $0).frame.minY }
    XCTAssertEqual(rowsTop, rowsTop.sorted(), "rows are out of order: \(rowsTop)")
    XCTAssertTrue(QueueUI.label(app, ID.popoverMore).hasPrefix("5 more in the app."), QueueUI.label(app, ID.popoverMore))
    let popover = QueueUI.element(app, ID.popover)
    for word in ["Approve", "Reply", "Send"] {
      XCTAssertEqual(
        popover.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", word)).count, 0, "the popover offers \(word)")
    }
    let frame = popover.frame
    XCTAssertEqual(frame.width, 360, accuracy: 1, "the popover is \(frame.width) wide")
    XCTAssertEqual(frame.height, 480, accuracy: 1, "the popover is \(frame.height) tall")
    for id in [ID.popoverOpen, ID.popoverKill, ID.popoverSettings] {
      XCTAssertTrue(QueueUI.element(app, id).exists, "the footer has no \(id)")
    }
    // The extra's five states, the badge carrying the state.
    XCTAssertEqual(QueueUI.label(app, ID.osLayerGlyphPrefix + "idle"), "WeMessage, nothing waiting")
    XCTAssertEqual(QueueUI.label(app, ID.osLayerGlyphPrefix + "waiting"), "WeMessage, 9+ waiting")
    XCTAssertEqual(QueueUI.label(app, ID.osLayerGlyphPrefix + "disconnected"), "WeMessage, not connected")
    XCTAssertTrue(
      QueueUI.label(app, ID.osLayerDock).hasPrefix("Dock badge 9."), "the Dock reads \(QueueUI.label(app, ID.osLayerDock))")
    QueueUI.settle()
    glance(app, name: "board-16-popover-\(appearance).png")
    if light { try audit(app, window: "audit-board-16-popover") }
    QueueUI.printTime("BOARD16", appearance, "healthy", since: started)

    // 16.H: Kill switch... confirms inside the popover. Return does not
    // engage; Cancel returns to the rows.
    QueueUI.element(app, ID.popoverKill).click()
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.label(app, ID.popover) == "healthy confirm" },
      "the confirm never opened: \(QueueUI.label(app, ID.popover))")
    XCTAssertTrue(QueueUI.element(app, ID.killConfirmEngage).exists)
    XCTAssertTrue(QueueUI.element(app, ID.killConfirmCancel).exists)
    XCTAssertEqual(QueueUI.count(app, containing: ID.popoverRowPrefix), 0, "rows behind the confirm")
    app.typeKey(.return, modifierFlags: [])
    QueueUI.settle()
    XCTAssertEqual(QueueUI.label(app, ID.popover), "healthy confirm", "Return engaged the kill switch")
    glance(app, name: "board-16-confirm-\(appearance).png")
    if light { try audit(app, window: "audit-board-16-confirm") }
    QueueUI.element(app, ID.killConfirmCancel).click()
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.label(app, ID.popover) == "healthy" }, "Cancel did not return to the rows")
    try await Self.assertNothingSent()
    print("BOARD16| \(appearance) seconds=\(Int(Date().timeIntervalSince(started)))")
  }
}
