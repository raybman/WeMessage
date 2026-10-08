import AppKit
import Foundation
import XCTest

/// v2 S4m: board 17, progress. WEMESSAGE_UI_BOARD=17 opens a window of its
/// own over fixtures (D-UI-121): the meters in three states, the streak
/// ribbon intact and broken, the stat tiles, the share card and its zeroed
/// twin, the rail and title bar marks, and the three zero screens. Nothing
/// opens it outside the flag in this version (D-UI-123), and it builds no
/// client. Under the flag the card's Copy writes a named test pasteboard
/// and Save a temporary folder (D-UI-131); nothing touches the general
/// pasteboard or the user's folders. Shots are board-17-<page>-<appearance>.png.
/// CI only.
final class Board17Tests: XCTestCase {
  override func setUp() async throws {
    try await FakeDaemon.reset()
  }

  @MainActor
  func testBoard17Light() async throws {
    try await walk(appearance: "light")
  }

  @MainActor
  func testBoard17Dark() async throws {
    try await walk(appearance: "dark")
  }

  /// 17.H earned: the receipt and the run, no Verify (D-UI-128).
  @MainActor
  func testBoard17ZeroEarned() async throws {
    try await zero(
      "earned", kind: "earned: ", receipt: true, verify: false, streak: "11 days cleared in a row.")
  }

  /// 17.H still clear: the same day, later; no receipt, no run, no Verify.
  @MainActor
  func testBoard17ZeroStillClear() async throws {
    try await zero("still", kind: "still clear: ", receipt: false, verify: false, streak: nil)
  }

  /// 17.H nothing arrived: no receipt, no run, and Verify asks again.
  @MainActor
  func testBoard17ZeroQuiet() async throws {
    try await zero("quiet", kind: "nothing arrived: ", receipt: false, verify: true, streak: nil)
  }

  /// 17.E: the card carries no words that change. The fixture's card and
  /// its zeroed twin are copied to the test pasteboard as 640 by 400 PNGs
  /// and compared pixel by pixel: they differ, and only inside the numeral
  /// boxes the app reports. No OCR. Save writes the temporary folder.
  @MainActor
  func testShareCardHasNoText() async throws {
    let app = try await Self.launch(appearance: "light")
    defer { app.terminate() }
    Self.page(app, "card")
    let (board, full, boxes) = try Self.copyCard(app, after: nil)
    defer { NSPasteboard(name: board).clearContents() }
    XCTAssertNotEqual(board, NSPasteboard.Name.general, "Copy reached the general pasteboard")
    XCTAssertTrue(board.rawValue.contains("uitest"), "Copy used \(board.rawValue)")
    XCTAssertEqual(boxes.count, 4, "the numeral boxes read \(boxes)")
    QueueUI.settle()
    glance(app, name: "board-17-card-light.png")

    Self.page(app, "cardzero")
    let (again, zeroed, sameBoxes) = try Self.copyCard(app, after: full)
    XCTAssertEqual(again, board, "the zeroed card went to another pasteboard")
    XCTAssertEqual(sameBoxes, boxes, "the boxes moved between the two cards")
    QueueUI.settle()
    glance(app, name: "board-17-cardzero-light.png")

    let a = try XCTUnwrap(NSBitmapImageRep(data: full), "the card is not a PNG")
    let b = try XCTUnwrap(NSBitmapImageRep(data: zeroed), "the zeroed card is not a PNG")
    for rep in [a, b] {
      XCTAssertEqual(rep.pixelsWide, 640, "the card is \(rep.pixelsWide) wide")
      XCTAssertEqual(rep.pixelsHigh, 400, "the card is \(rep.pixelsHigh) high")
    }
    let changed = try Self.changedPixels(a, b)
    XCTAssertGreaterThan(changed.count, 0, "zeroing the numbers changed no pixel")
    let grown = boxes.map { $0.insetBy(dx: -1, dy: -1) }
    let outside = changed.filter { p in !grown.contains { $0.contains(CGPoint(x: Double(p.x) + 0.5, y: Double(p.y) + 0.5)) } }
    XCTAssertEqual(outside.count, 0, "pixels changed outside the numeral boxes, first at \(outside.prefix(5).map { "(\($0.x),\($0.y))" })")
    print("BOARD17| card changed=\(changed.count) outside=\(outside.count)")

    // Save under the flag: a temporary folder, no panel.
    QueueUI.element(app, ID.cardSave).click()
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.label(app, ID.cardStatus).contains("saved=temporary folder") },
      "Save reads \(QueueUI.label(app, ID.cardStatus))")
    XCTAssertEqual(app.sheets.count, 0, "Save opened a panel")
    try await Self.assertNothingSent()
  }

  // MARK: helpers

  @MainActor
  private static func launch(appearance: String) async throws -> XCUIApplication {
    try await FakeDaemon.scenario("rich")
    let app = UITestApp.make(appearance: appearance, reduceTransparency: false, board: "17")
    app.launch()
    let window = QueueUI.element(app, ID.progress)
    XCTAssertTrue(window.waitForExistence(timeout: UITestApp.timeout), "the Progress window never appeared")
    XCTAssertFalse(UITestApp.shellElement(app).exists, "the shell is drawn beside the Progress window")
    return app
  }

  @MainActor
  private static func page(_ app: XCUIApplication, _ name: String) {
    let tab = QueueUI.element(app, ID.progressTabPrefix + name)
    XCTAssertTrue(tab.waitForExistence(timeout: UITestApp.timeout), "no \(name) tab")
    tab.click()
  }

  /// The board asks the daemon for nothing: no send, no write of any kind.
  @MainActor
  private static func assertNothingSent() async throws {
    let requests = try await FakeDaemon.journal().requests
    XCTAssertEqual(requests.filter { $0.path.hasPrefix("/v1/send") }, [], "board 17 asked to send")
    XCTAssertEqual(requests.filter { $0.method != "GET" }.map(\.description), [], "board 17 wrote to the daemon")
  }

  /// Waits for the card's PNG, clicks Copy, and reads back the pasteboard
  /// the status names and the numeral boxes it reports. `after` is the
  /// previous copy, so the read waits for the new one.
  @MainActor
  private static func copyCard(_ app: XCUIApplication, after previous: Data?) throws -> (NSPasteboard.Name, Data, [CGRect]) {
    XCTAssertTrue(
      QueueUI.waitUntil {
        let status = QueueUI.label(app, ID.cardStatus)
        return status.hasPrefix("png=640x400 ") && !status.contains(" bytes=0 ")
      },
      "the card never rendered: \(QueueUI.label(app, ID.cardStatus))")
    QueueUI.element(app, ID.cardCopy).click()
    XCTAssertTrue(
      QueueUI.waitUntil { !field("pasteboard", in: QueueUI.label(app, ID.cardStatus)).isEmpty },
      "Copy never reported: \(QueueUI.label(app, ID.cardStatus))")
    let status = QueueUI.label(app, ID.cardStatus)
    let board = NSPasteboard.Name(field("pasteboard", in: status))
    var data: Data?
    let arrived = QueueUI.waitUntil {
      data = NSPasteboard(name: board).data(forType: .png)
      return data != nil && data != previous
    }
    XCTAssertTrue(arrived, "no new PNG on \(board.rawValue)")
    let boxes = field("boxes", in: status).split(separator: ";").compactMap { box -> CGRect? in
      let n = box.split(separator: ",").compactMap { Double($0) }
      return n.count == 4 ? CGRect(x: n[0], y: n[1], width: n[2], height: n[3]) : nil
    }
    let png = try XCTUnwrap(data, "no PNG on \(board.rawValue)")
    return (board, png, boxes)
  }

  /// One `key=value` field of the card status; empty for none or missing.
  /// The pasteboard name is the last word that has no "=" before the next
  /// key, so a name with spaces survives.
  private static func field(_ key: String, in status: String) -> String {
    guard let start = status.range(of: key + "=") else { return "" }
    let rest = status[start.upperBound...]
    let end = rest.range(of: #" [a-z]+="#, options: .regularExpression)?.lowerBound ?? rest.endIndex
    let value = String(rest[..<end])
    return value == "none" ? "" : value
  }

  /// Every pixel, top-left origin, whose bytes differ between two reps of
  /// the same size and layout.
  private static func changedPixels(_ a: NSBitmapImageRep, _ b: NSBitmapImageRep) throws -> [(x: Int, y: Int)] {
    XCTAssertEqual(a.bitsPerPixel, b.bitsPerPixel, "the two renders differ in format")
    XCTAssertEqual(a.bytesPerRow, b.bytesPerRow, "the two renders differ in layout")
    let pa = try XCTUnwrap(a.bitmapData, "no bitmap")
    let pb = try XCTUnwrap(b.bitmapData, "no bitmap")
    let bytes = a.bitsPerPixel / 8
    XCTAssertFalse(a.isPlanar || bytes == 0, "an unexpected PNG layout")
    var changed: [(x: Int, y: Int)] = []
    for y in 0..<min(a.pixelsHigh, b.pixelsHigh) {
      let row = y * a.bytesPerRow
      for x in 0..<min(a.pixelsWide, b.pixelsWide) {
        let at = row + x * bytes
        if (0..<bytes).contains(where: { pa[at + $0] != pb[at + $0] }) {
          changed.append((x, y))
        }
      }
    }
    return changed
  }

  /// One zero screen: its kind, the receipt, the run, Verify and the
  /// Progress link, under the title bar's CLEAR with its clock.
  @MainActor
  private func zero(_ name: String, kind: String, receipt: Bool, verify: Bool, streak: String?) async throws {
    let app = try await Self.launch(appearance: "light")
    defer { app.terminate() }
    Self.page(app, name)
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.label(app, ID.zeroKind).hasPrefix(kind) },
      "\(name): the zero reads \(QueueUI.label(app, ID.zeroKind))")
    XCTAssertEqual(QueueUI.element(app, ID.zeroReceipt).exists, receipt, "\(name): receipt")
    XCTAssertEqual(QueueUI.element(app, ID.zeroVerify).exists, verify, "\(name): Verify now")
    XCTAssertTrue(QueueUI.element(app, ID.zeroProgress).exists, "\(name): no Progress link")
    if let streak {
      XCTAssertEqual(QueueUI.label(app, ID.zeroStreak), streak)
    } else {
      XCTAssertFalse(QueueUI.element(app, ID.zeroStreak).exists, "\(name): a run on a zero that earned none")
    }
    XCTAssertEqual(QueueUI.label(app, ID.titleCounter), "Clear as of 18:07:41")
    // Nothing on a zero screen celebrates in words beyond the heading.
    for word in ["Congrat", "Great job", "Well done", "Inbox zero"] {
      XCTAssertEqual(
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@", word, word)).count,
        0, "\(name): \(word)")
    }
    QueueUI.settle()
    glance(app, name: "board-17-zero-\(name)-light.png")
    try audit(app, window: "audit-board-17-zero-\(name)")
    if verify {
      QueueUI.element(app, ID.zeroVerify).click()
    }
    // Progress goes back to the meters.
    QueueUI.element(app, ID.zeroProgress).click()
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.element(app, ID.meterAll + ".state").exists },
      "\(name): Progress did not open the meters")
    try await Self.assertNothingSent()
    print("BOARD17| zero \(name)")
  }

  /// The eight non-zero pages in one launch.
  @MainActor
  private func walk(appearance: String) async throws {
    let app = try await Self.launch(appearance: appearance)
    defer { app.terminate() }
    let started = Date()
    let light = appearance == "light"

    // 17.A: four channels and one total, words in place of a fraction.
    Self.page(app, "meters")
    let state = { (scope: String) in QueueUI.label(app, ID.meterPrefix + scope + ".state") }
    XCTAssertTrue(QueueUI.waitUntil { state("all") == "9 left" }, "the total reads \(state("all"))")
    XCTAssertEqual(state("imessage"), "2 left")
    XCTAssertEqual(state("whatsapp"), "3 left")
    XCTAssertEqual(state("linkedin"), "4 left")
    XCTAssertEqual(state("email"), "clear")
    try Self.noFraction(app, "meters")
    QueueUI.settle()
    glance(app, name: "board-17-meters-\(appearance).png")
    if light { try audit(app, window: "audit-board-17-meters") }

    // 17.B: CLEAR only when every connected channel is clear and fresh.
    Self.page(app, "atzero")
    XCTAssertTrue(QueueUI.waitUntil { state("all") == "clear" }, "at zero, the total reads \(state("all"))")
    for scope in ["imessage", "whatsapp", "linkedin", "email"] {
      XCTAssertEqual(state(scope), "clear", "at zero, \(scope)")
    }
    QueueUI.settle()
    glance(app, name: "board-17-atzero-\(appearance).png")

    // 17.A degraded: one stale source makes the total cannot tell.
    Self.page(app, "degraded")
    XCTAssertTrue(QueueUI.waitUntil { state("all") == "cannot tell" }, "degraded, the total reads \(state("all"))")
    XCTAssertEqual(state("linkedin"), "cannot tell")
    XCTAssertEqual(state("whatsapp"), "not connected")
    XCTAssertEqual(state("imessage"), "2 left")
    try Self.noFraction(app, "degraded")
    QueueUI.settle()
    glance(app, name: "board-17-degraded-\(appearance).png")
    if light { try audit(app, window: "audit-board-17-degraded") }

    // 17.C intact: the run crosses the away days.
    Self.page(app, "streak")
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.label(app, ID.streakCurrent).hasPrefix("Current run: 11 days.") },
      "the run reads \(QueueUI.label(app, ID.streakCurrent))")
    XCTAssertTrue(QueueUI.label(app, ID.streakLongest).hasPrefix("Longest run: 23 days."), QueueUI.label(app, ID.streakLongest))
    let ribbon = QueueUI.label(app, ID.streakRibbon)
    XCTAssertTrue(ribbon.contains("Sep 4 app not opened"), "the ribbon reads \(ribbon)")
    XCTAssertFalse(ribbon.contains("left unclear"), "the intact ribbon has a broken day: \(ribbon)")
    QueueUI.settle()
    glance(app, name: "board-17-streak-\(appearance).png")
    if light { try audit(app, window: "audit-board-17-streak") }

    // 17.C broken: said plainly, the longest never resets.
    Self.page(app, "broken")
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.label(app, ID.streakCurrent).hasPrefix("Current run: 3 days.") },
      "the broken run reads \(QueueUI.label(app, ID.streakCurrent))")
    XCTAssertTrue(QueueUI.label(app, ID.streakLongest).hasPrefix("Longest run: 23 days."), QueueUI.label(app, ID.streakLongest))
    XCTAssertTrue(QueueUI.label(app, ID.streakRibbon).contains("Sep 14 opened, left unclear"), QueueUI.label(app, ID.streakRibbon))
    QueueUI.settle()
    glance(app, name: "board-17-broken-\(appearance).png")

    // 17.D: every tile carries its caveat; the unwelcome one first.
    Self.page(app, "stats")
    let keys = ["longestWaiting", "cleared", "draftSplit", "waited", "daysAtZero"]
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.element(app, ID.statPrefix + "daysAtZero").exists }, "the stat tiles never appeared")
    for key in keys {
      let words = QueueUI.label(app, ID.statPrefix + key)
      let parts = words.components(separatedBy: ". ")
      XCTAssertGreaterThanOrEqual(parts.count, 2, "\(key) carries no caveat: \(words)")
      XCTAssertFalse((parts.dropFirst().joined()).trimmingCharacters(in: .whitespaces).isEmpty, "\(key): an empty caveat")
      XCTAssertFalse(words.contains("%"), "\(key) prints a percentage: \(words)")
    }
    XCTAssertTrue(QueueUI.label(app, ID.statPrefix + "longestWaiting").hasPrefix("LONGEST WAITING, STILL OPEN: 11 days."))
    let tops = keys.map { QueueUI.element(app, ID.statPrefix + $0).frame }
    XCTAssertTrue(tops.dropFirst().allSatisfy { tops[0].minY <= $0.minY }, "the unwelcome tile is not first: \(tops)")
    QueueUI.settle()
    glance(app, name: "board-17-stats-\(appearance).png")
    if light { try audit(app, window: "audit-board-17-stats") }

    // 17.E: the card, rendered locally, and its three ways out.
    Self.page(app, "card")
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.label(app, ID.cardStatus).hasPrefix("png=640x400 ") },
      "the card status reads \(QueueUI.label(app, ID.cardStatus))")
    for id in [ID.card, ID.cardCopy, ID.cardSave, ID.cardShare] {
      XCTAssertTrue(QueueUI.element(app, id).exists, "the card page has no \(id)")
    }
    let card = QueueUI.element(app, ID.card).frame
    XCTAssertEqual(card.width, 640, accuracy: 1, "the card is \(card.width) wide")
    XCTAssertEqual(card.height, 400, accuracy: 1, "the card is \(card.height) high")
    QueueUI.settle()
    glance(app, name: "board-17-card-\(appearance).png")
    if light { try audit(app, window: "audit-board-17-card") }

    // 17.G: the rail's marks and the title bar's two states. No chrome
    // says streak.
    Self.page(app, "chrome")
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.label(app, ID.titleCounter) == "Clear as of 18:07:41" },
      "the title counter reads \(QueueUI.label(app, ID.titleCounter))")
    XCTAssertEqual(
      app.descendants(matching: .any).matching(
        NSPredicate(format: "label == %@ OR value == %@", "9 left as of 16:42:07", "9 left as of 16:42:07")
      ).count, 1,
      "the title bar's left state")
    let rail: [(String, String)] = [
      (ID.railAll, ": cannot tell"), (ID.railIMessage, ": 2 waiting"), (ID.railWhatsApp, ": 3 waiting"),
      (ID.railLinkedIn, ": cannot tell"), (ID.railEmail, ": clear and fresh"),
    ]
    for (id, suffix) in rail {
      XCTAssertTrue(QueueUI.label(app, id).hasSuffix(suffix), "\(id) reads \(QueueUI.label(app, id))")
    }
    // The board's own Streak tab is not chrome.
    let streaky = app.descendants(matching: .any).matching(
      NSPredicate(
        format: "(label CONTAINS[c] 'streak' OR value CONTAINS[c] 'streak') AND NOT (identifier BEGINSWITH %@)",
        ID.progressTabPrefix))
    XCTAssertEqual(streaky.count, 0, "the chrome says streak")
    QueueUI.settle()
    glance(app, name: "board-17-chrome-\(appearance).png")
    if light { try audit(app, window: "audit-board-17-chrome") }
    QueueUI.printTime("BOARD17", appearance, "walk", since: started)
    try await Self.assertNothingSent()
  }

  /// No meter row or note carries a percentage or an arrow.
  @MainActor
  private static func noFraction(_ app: XCUIApplication, _ page: String) throws {
    let marks = ["%", "\u{2191}", "\u{2193}", "\u{2192}", "\u{2190}", "\u{25B2}", "\u{25BC}"]
    for mark in marks {
      let hits = app.descendants(matching: .any).matching(
        NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", mark, mark))
      XCTAssertEqual(hits.count, 0, "\(page): \(mark) on the board")
    }
  }
}
