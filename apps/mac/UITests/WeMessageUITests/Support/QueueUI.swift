import AppKit
import Foundation
import XCTest

/// v2 S4f: what boards 06 and 09 share. Element reads by identifier, a
/// poll, and the journal rules every queue launch ends on: nothing was
/// sent, nothing was approved at the daemon, and nothing was marked seen or
/// read (06.A: the queue reads; it never writes the user's read state).
@MainActor
enum QueueUI {
  static let maya = "iMessage;-;+15550100001"
  static let daniel = "iMessage;-;+15550100002"
  static let priya = "SMS;-;+15550100004"
  static let mayaDraft = "drf-0101"
  static let priyaDraft = "drf-0102"

  static func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: id).firstMatch
  }

  static func label(_ app: XCUIApplication, _ id: String) -> String {
    let e = element(app, id)
    return e.exists ? e.label : "(missing)"
  }

  static func value(_ app: XCUIApplication, _ id: String) -> String {
    let e = element(app, id)
    return e.exists ? ((e.value as? String) ?? "") : "(missing)"
  }

  /// Every element whose identifier contains `fragment`.
  static func count(_ app: XCUIApplication, containing fragment: String) -> Int {
    app.descendants(matching: .any).matching(NSPredicate(format: "identifier CONTAINS %@", fragment)).count
  }

  /// A draft's 09.B meta line: its own element when the tree exposes it,
  /// else the bubble's label, which carries it.
  static func meta(_ app: XCUIApplication, _ draftId: String) -> String {
    let own = element(app, ID.draftVerb(draftId, "meta"))
    return own.exists ? own.label : label(app, ID.draft)
  }

  /// Polls until `done` holds or the wait runs out; true when it held.
  static func waitUntil(_ timeout: TimeInterval = UITestApp.timeout, _ done: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    var held = done()
    while !held && Date() < deadline {
      Thread.sleep(forTimeInterval: 0.25)
      held = done()
    }
    return held
  }

  /// One more frame after the values arrive, before a shot.
  static func settle() { Thread.sleep(forTimeInterval: 0.3) }

  /// Clicks the list row for `guid` and waits for its thread to load.
  static func open(_ app: XCUIApplication, _ guid: String) {
    let row = element(app, ID.rowPrefix + guid)
    XCTAssertTrue(row.waitForExistence(timeout: UITestApp.timeout), "no list row for \(guid)")
    row.click()
    let thread = element(app, ID.thread)
    XCTAssertTrue(waitUntil { thread.exists && thread.label.hasSuffix(": loaded") }, "\(guid): thread reads \(thread.label)")
  }

  /// The journal rules of a queue launch. `toggles` is how many kill
  /// switch posts the launch made on purpose (the banner's Disengage).
  static func assertJournal(_ when: String, toggles: Int = 0, file: StaticString = #filePath, line: UInt = #line) async throws {
    let requests = try await FakeDaemon.journal().requests
    let sends = requests.filter { $0.method == "POST" && $0.path == "/v1/send" }
    XCTAssertEqual(sends, [], "\(when): the queue asked to send", file: file, line: line)
    let drafts = requests.filter { $0.method != "GET" && $0.path.hasPrefix("/v1/drafts") }
    XCTAssertEqual(drafts, [], "\(when): a draft action reached the daemon without an elapsed window", file: file, line: line)
    let seen = requests.filter {
      let path = $0.path.lowercased()
      return path.contains("seen") || path.contains("/read") || path.contains("mark")
    }
    XCTAssertEqual(seen, [], "\(when): the queue wrote read state", file: file, line: line)
    let writes = requests.filter { $0.method != "GET" }
    let kill = writes.filter { $0.method == "POST" && $0.path == "/v1/toggles/kill-switch" }
    XCTAssertEqual(kill.count, toggles, "\(when): kill switch posts \(kill)", file: file, line: line)
    XCTAssertEqual(writes.count, kill.count, "\(when): writes beyond the kill toggle: \(writes)", file: file, line: line)
  }

  static func printTime(_ board: String, _ appearance: String, _ step: String, since start: Date) {
    print("\(board)| \(appearance) \(step) t=\(String(format: "%.1f", Date().timeIntervalSince(start)))s")
  }
}

extension XCTestCase {
  /// A state whose frost probe patches sit under an opaque card (09.D's
  /// bulk confirm, 09.G's audit table): attached and swept for green, not
  /// held to the frost evidence, which needs bare pane at the patches.
  @MainActor
  func glance(_ app: XCUIApplication, name: String) {
    let png = app.windows.firstMatch.screenshot().pngRepresentation
    let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
    guard let size = NoGreen.size(png) else {
      XCTFail("\(name): no decodable PNG")
      return
    }
    let band = NoGreen.trafficLightBand(pngSize: size, windowWidthPoints: app.windows.firstMatch.frame.width)
    XCTAssertEqual(NoGreen.offenders(png, excluding: band), 0, "\(name): green pixels outside the traffic lights")
    XCTAssertFalse(NoGreen.isBlank(png), "\(name): a blank snapshot")
  }
}
