import AppKit
import Foundation
import XCTest

/// U-X1/U-X2 (plan §4.5, §5.3): the shell passes the system accessibility
/// audit with nothing of its own ignored, and the keyboard reaches every
/// part of it.
/// CI only.
final class AccessibilityTests: XCTestCase {
  /// v2 S4b: every UI test starts from the S0 goldens and an empty journal.
  override func setUp() async throws {
    try await FakeDaemon.reset()
  }

  /// The rail tiles in rail order, which is cmd-1..5 order.
  static let railIDs = ID.railTiles

  /// U-X1: the default audit types, and a handler that keeps every issue
  /// the app's own views raise, with one measured exception: a `.contrast`
  /// issue is set aside only when the element's own screenshot clears WCAG
  /// AA (PixelContrast; the audit flags 9.6:1 labels on the 1x runner).
  /// Each issue is also written to the log, with its pixel measurement, so a
  /// red run names it.
  @MainActor
  func testShellPassesAccessibilityAudit() throws {
    let app = UITestApp.make(appearance: "light")
    app.launch()
    XCTAssertTrue(UITestApp.shellElement(app).waitForExistence(timeout: UITestApp.timeout), "the shell never appeared")
    try audit(app, window: "audit-window")
    app.terminate()
  }

  /// The U-X1 audit of whatever `app` shows now; the window is attached
  /// as `window`.
  @MainActor
  static func audit(_ app: XCUIApplication, window: String, test: XCTestCase) throws {
    let shot = app.windows.firstMatch.screenshot()
    test.add(XCTAttachment(data: shot.pngRepresentation, uniformTypeIdentifier: "public.png").kept(window))
    try app.performAccessibilityAudit() { issue in
      let who = issue.element.map { "\($0.elementType.rawValue) \($0.identifier) '\($0.label)' frame=\($0.frame)" } ?? "(no element)"
      let chrome = Self.isSystemChrome(issue, in: app)
      let editor = Self.isFieldEditor(issue, in: app)
      var measured: PixelContrast.Measurement?
      var away = false
      if !chrome, let element = issue.element, element.exists {
        let shot = element.screenshot()
        test.add(XCTAttachment(data: shot.pngRepresentation, uniformTypeIdentifier: "public.png").kept("audit-\(element.identifier)"))
        if issue.auditType == .contrast, let image = shot.image.cgImage(forProposedRect: nil, context: nil, hints: nil) {
          measured = PixelContrast.measure(image)
          if measured?.passes != true { away = Self.isScrolledAway(element, in: app) }
        }
      }
      let cleared = measured?.passes ?? false
      var note = measured.map { " (pixels: \($0)\($0.passes ? ", ignored" : ""))" } ?? ""
      if chrome { note = " (system chrome, ignored)" }
      if editor { note = " (AppKit field editor, ignored)" }
      if away { note += " (scrolled out of its scroll view, ignored)" }
      print("audit issue: \(issue.auditType) \(who): \(issue.compactDescription)\(note)")
      print("audit detail: \(issue.detailedDescription)")
      if !chrome && !editor && !cleared && !away, let element = issue.element, element.exists {
        // A kept issue names its element's subtree, so a red run says which view it was.
        print("audit tree: \(element.debugDescription)")
      }
      return chrome || editor || cleared || away
    }
  }

  /// v2 S4d: the same audit with board 02 open on an agent draft (Priya,
  /// SMS), so the transcript, the draft's verbs, the banner and the
  /// composer are all in the tree the audit walks.
  @MainActor
  func testBoard02PassesAccessibilityAudit() async throws {
    try await FakeDaemon.scenario("rich")
    let app = UITestApp.make(appearance: "light")
    app.launch()
    XCTAssertTrue(UITestApp.shellElement(app).waitForExistence(timeout: UITestApp.timeout), "the shell never appeared")
    let row = app.descendants(matching: .any)[ID.rowPrefix + "SMS;-;+15550100004"]
    XCTAssertTrue(row.waitForExistence(timeout: UITestApp.timeout), "no row for the SMS thread")
    row.click()
    XCTAssertTrue(
      app.descendants(matching: .any)[ID.draft].waitForExistence(timeout: UITestApp.timeout), "the draft never drew")
    try audit(app, window: "audit-board-02")
    app.terminate()
  }

  /// v2 S4e: the same audit over every page of board 08, the message
  /// atlas, in one launch: each page is a click on its page dot.
  @MainActor
  func testBoard08PassesAccessibilityAudit() throws {
    let app = UITestApp.make(appearance: "light", reduceTransparency: false, board: "08")
    app.launch()
    XCTAssertTrue(
      app.descendants(matching: .any)[ID.atlas].waitForExistence(timeout: UITestApp.timeout), "the atlas never appeared")
    for (index, slug) in Board08Tests.slugs.enumerated() {
      let letter = String(UnicodeScalar(UInt8(65 + index)))
      let dot = app.buttons.matching(NSPredicate(format: "label == %@", "Specimen page 08." + letter)).firstMatch
      XCTAssertTrue(dot.waitForExistence(timeout: UITestApp.timeout), "08.\(letter): no page dot")
      dot.click()
      XCTAssertTrue(
        app.descendants(matching: .any).matching(identifier: ID.atlasPagePrefix + slug).firstMatch
          .waitForExistence(timeout: UITestApp.timeout), "08.\(letter): page \(slug) never drew")
      try audit(app, window: "audit-board-08-\(slug)")
    }
    app.terminate()
  }

  /// The two issues the audit raises on elements the app does not draw,
  /// observed on the ci-swift runner's Xcode 26.6 (17F113), run 37555284794:
  /// "Element has no description" on the TouchBar element the test runner
  /// exposes, and "Parent/Child mismatch" on the group directly under the
  /// runner's `_XCUI:FullScreenWindow` button, whose child lives in another
  /// process. Each match needs the audit type, the description and the
  /// element; anything else, including any issue on the app's own views, is
  /// kept. Re-check both on the next Xcode bump (17F113 is the build seen).
  ///
  /// v2 S4e adds a third, run 37608951010: once the composer's text view
  /// holds the keyboard (the S4d focus fix), AppKit puts its "emoji &
  /// symbols" item in the runner's Touch Bar, and the audit flags it with
  /// "Element has no description" and "Action is missing". It matches only
  /// as a pop-up button with that exact label, no identifier, lying inside
  /// the Touch Bar element's frame (79,-1 74x32 inside 80,0 685x30).
  @MainActor
  static func isSystemChrome(_ issue: XCUIAccessibilityAuditIssue, in app: XCUIApplication) -> Bool {
    guard let element = issue.element, element.identifier.isEmpty else { return false }
    if element.elementType == .popUpButton, element.label == "emoji & symbols",
      (issue.auditType == .sufficientElementDescription && issue.compactDescription == "Element has no description")
        || (issue.auditType == .action && issue.compactDescription == "Action is missing")
    {
      let touchBar = app.descendants(matching: .touchBar).firstMatch
      guard touchBar.exists else { return false }
      return touchBar.frame.intersects(element.frame)  // 17F113: the Touch Bar's emoji item
    }
    if issue.auditType == .sufficientElementDescription,
      issue.compactDescription == "Element has no description"
    {
      return element.elementType == .touchBar  // 17F113: the runner's TouchBar
    }
    if issue.auditType == .parentChild, issue.compactDescription == "Parent/Child mismatch",
      element.elementType == .group
    {
      let fullScreen = app.descendants(matching: .any)["_XCUI:FullScreenWindow"]
      guard fullScreen.exists else { return false }
      let frame = element.frame
      return fullScreen.children(matching: .group).allElementsBoundByIndex.contains { $0.frame == frame }  // 17F113
    }
    return false
  }

  /// v2 S4i, run 37756434645: while one of board 11's text fields holds the
  /// keyboard, the audit raises one "Parent/Child mismatch" that names no
  /// element. The same run audited boards 02, 06, 08, 09, 10 and 12 (the
  /// composer is a text view, not a field) without it, and raised it in
  /// both board 11 audits, each with a field focused: it is AppKit's field
  /// editor, the text view a focused NSTextField borrows, which XCUI cannot
  /// resolve to an element. It matches only with no element, that exact
  /// description, and keyboard focus on one of the three named fields.
  @MainActor
  static func isFieldEditor(_ issue: XCUIAccessibilityAuditIssue, in app: XCUIApplication) -> Bool {
    guard issue.element == nil, issue.auditType == .parentChild,
      issue.compactDescription == "Parent/Child mismatch"
    else { return false }
    let fields = [ID.searchField, ID.findField, ID.switcherField]
    let focused = app.textFields.matching(NSPredicate(format: "hasKeyboardFocus == true")).firstMatch
    return focused.exists && fields.contains(focused.identifier)
  }

  /// v2 S4i, run 37756434645: with a thread scrolled to a find match, a
  /// transcript label below the scroll view's edge is still in the tree,
  /// and its screenshot is whatever is drawn over that spot (the channel
  /// banner). A contrast issue is set aside here only when the element is
  /// a descendant of a scroll view, by frame, and not wholly inside that
  /// scroll view's visible frame: nobody can read it there, and board 02's
  /// audit reads the same labels in view.
  @MainActor
  static func isScrolledAway(_ element: XCUIElement, in app: XCUIApplication) -> Bool {
    let frame = element.frame
    guard !frame.isEmpty else { return false }
    var inside = false
    for scroll in app.scrollViews.allElementsBoundByIndex where !inside && !scroll.frame.contains(frame) {
      guard let tree = try? scroll.snapshot() else { continue }
      var queue: [XCUIElementSnapshot] = tree.children
      while !inside, let node = queue.popLast() {
        inside = node.frame == frame && node.elementType == element.elementType
        queue.append(contentsOf: node.children)
      }
    }
    return inside
  }

  /// The element that has keyboard focus now, by identifier ("" when it has none).
  @MainActor
  static func focusedIdentifier(_ app: XCUIApplication) -> String {
    let focused = app.descendants(matching: .any).matching(NSPredicate(format: "hasKeyboardFocus == true")).firstMatch
    return focused.exists ? focused.identifier : ""
  }

  /// True when the lens picker or one of its segments has keyboard focus.
  @MainActor
  static func lensHasFocus(_ app: XCUIApplication) -> Bool {
    let lens = app.descendants(matching: .any)[ID.lens]
    let inside = lens.descendants(matching: .any).matching(NSPredicate(format: "hasKeyboardFocus == true"))
    return focusedIdentifier(app) == ID.lens || inside.count > 0
  }

  /// U-X2: cmd-1..5 select the rail tiles in order, Tab reaches the lens,
  /// then the kill chip, and the rail, and cmd-T selects Triage.
  @MainActor
  func testKeyboardPath() throws {
    // The job turns Full Keyboard Access on before xcodebuild (§4.7, P1-3).
    // Without it Tab never lands, so a missing step reads as a named skip.
    let mode = UserDefaults.standard.integer(forKey: "AppleKeyboardUIMode")
    try XCTSkipUnless(mode & 2 != 0, "Full Keyboard Access off: the job step is missing")

    let app = UITestApp.make(appearance: "light")
    app.launch()
    XCTAssertTrue(UITestApp.shellElement(app).waitForExistence(timeout: UITestApp.timeout), "the shell never appeared")

    let digits = ["1", "2", "3", "4", "5"]
    for (index, digit) in digits.enumerated() {
      app.typeKey(digit, modifierFlags: .command)
      let selected = app.descendants(matching: .any)[Self.railIDs[index]]
      let became = expectation(for: NSPredicate(format: "isSelected == true"), evaluatedWith: selected)
      wait(for: [became], timeout: 5)
      for (other, id) in Self.railIDs.enumerated() where other != index {
        XCTAssertFalse(app.descendants(matching: .any)[id].isSelected, "cmd-\(digit) left \(id) selected")
      }
    }
    app.typeKey("1", modifierFlags: .command)

    // v2 S4c: SwiftUI's key loop follows reading order, and the wireframe
    // puts the 52pt title band above the rail, so Tab walks the title bar
    // first (lens, then the kill chip) and then the rail. Record every stop
    // so a wrong order reads as the path it took. Nothing outside the rail,
    // the lens and the chip may take a stop: rows and the content pane
    // stay out of the loop.
    let lensStops = [ID.lens, ID.lensRecent, ID.lensNeedsYou, ID.lensTriage]
    var path: [String] = []
    var firstLens: Int?
    var chipAt: Int?
    var railAt: Int?
    for step in 0..<(Self.railIDs.count + 10) {
      app.typeKey("\t", modifierFlags: [])
      Thread.sleep(forTimeInterval: 0.2)
      let now = Self.lensHasFocus(app) && !lensStops.contains(Self.focusedIdentifier(app)) ? ID.lens : Self.focusedIdentifier(app)
      path.append(now)
      if firstLens == nil, now == ID.lens || lensStops.contains(now) { firstLens = step }
      if chipAt == nil, now == ID.killChip { chipAt = step }
      if railAt == nil, Self.railIDs.contains(now) { railAt = step }
      if firstLens != nil, chipAt != nil, railAt != nil { break }
    }
    XCTAssertNotNil(firstLens, "Tab never reached the lens; stops: \(path)")
    XCTAssertNotNil(chipAt, "Tab never reached the kill chip; stops: \(path)")
    XCTAssertNotNil(railAt, "Tab skipped the rail; stops: \(path)")
    if let lens = firstLens, let chip = chipAt {
      XCTAssertLessThan(lens, chip, "the kill chip came before the lens; stops: \(path)")
    }
    let allowed = Set(Self.railIDs + lensStops + [ID.killChip, ""])
    XCTAssertEqual(path.filter { !allowed.contains($0) }, [], "Tab stopped outside the rail, lens and chip; stops: \(path)")

    // cmd-T selects Triage.
    app.typeKey("t", modifierFlags: .command)
    let triage = app.descendants(matching: .any)[ID.lensTriage]
    wait(for: [expectation(for: NSPredicate(format: "isSelected == true"), evaluatedWith: triage)], timeout: 5)
    XCTAssertFalse(app.descendants(matching: .any)[ID.lensRecent].isSelected, "cmd-T left Recent selected")
    app.terminate()
  }
}

extension XCTAttachment {
  /// Named, and kept even when the test passes, so a red audit run carries
  /// the pixels the audit judged (read from the xcresult artifact).
  func kept(_ name: String) -> XCTAttachment {
    self.name = name
    lifetime = .keepAlways
    return self
  }
}

/// The U-X1 audit, shared so a board's own launch can run it (v2 S4f: no
/// extra launch for an audit).
extension XCTestCase {
  @MainActor
  func audit(_ app: XCUIApplication, window: String) throws {
    try AccessibilityTests.audit(app, window: window, test: self)
  }
}
