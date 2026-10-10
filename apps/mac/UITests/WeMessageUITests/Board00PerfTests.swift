import AppKit
import Foundation
import XCTest

/// v2 S7a (G2): the app against the fake daemon's `bulk` scenario, 4,000
/// threads and a 2,000-turn transcript on the newest one. Every number is
/// printed as a `G2|` line (G2Limits.line) that tools/swift/g2-report.sh
/// gathers into G2-REPORT.md.
///
/// Hard rows, from G2Limits (pinned by the kit's G2PerfTests):
///   first paint: the first thread row hittable within firstPaintMs of
///   `app.launch()` returning;
///   mounted rows: the 2,000-turn thread, read at its 200-turn page, mounts
///   at most mountedTranscriptRows transcript rows (the lazy stack).
/// Soft rows, measured and reported, never failed: launch time, the app's
/// resident memory (proc_pid_rusage from the runner), and event-to-UI
/// latency (a connection.state frame from POST /v1/_emit until the
/// connection line says it). CI only.
final class Board00PerfTests: XCTestCase {
  override func setUp() async throws {
    try await FakeDaemon.reset()
  }

  /// The newest thread in tools/swift/bulk.mjs: index 0, a +1555 number.
  static let long = "iMessage;-;+15552000000"
  /// The state the emitted frame names; the golden greeting says fully-connected.
  static let flipped = "read-only"

  @MainActor
  func testBulkPerf() async throws {
    try await FakeDaemon.scenario("bulk")
    let app = UITestApp.make(appearance: "light")
    let launchStart = ContinuousClock.now
    app.launch()
    let launched = ContinuousClock.now
    defer { app.terminate() }
    report("launch", ms(launched - launchStart), "ms", nil, .soft)

    // First paint: polled tight, so the wait adds little to the number.
    let first = element(app, ID.rowPrefix + Self.long)
    let paint = try XCTUnwrap(firstHittable(first, since: launched), "the first thread row never became hittable")
    report("first-paint", ms(paint), "ms", G2Limits.firstPaintMs, .hard)
    // The cost of one poll, measured once the row is there: how much of the
    // number above is the query, not the app.
    let probeStart = ContinuousClock.now
    _ = first.exists && first.isHittable
    print("BOARD00| first paint \(ms(paint)) ms, one hittable poll costs \(ms(ContinuousClock.now - probeStart)) ms")
    XCTAssertLessThanOrEqual(ms(paint), Double(G2Limits.firstPaintMs), "first paint over the G2 limit")

    // Mounted rows: open the long thread at its full page.
    first.click()
    let thread = element(app, ID.thread)
    XCTAssertTrue(waitUntil { thread.exists && thread.label.hasSuffix(": loaded") }, "the long thread reads \(thread.label)")
    let journal = try await FakeDaemon.waitForRequests(["GET /v1/threads/\(Self.encoded(Self.long))/messages"])
    let read = journal.requests.first { $0.path.hasSuffix("/messages") }
    XCTAssertEqual(read?.query, "limit=200", "the transcript read a different page: \(String(describing: read))")
    XCTAssertEqual(read?.status, 200)
    let mounted = countRows(app)
    report("mounted-rows", Double(mounted), "rows", G2Limits.mountedTranscriptRows, .hard)
    XCTAssertGreaterThan(mounted, 0, "the long thread mounted no rows")
    XCTAssertLessThanOrEqual(mounted, G2Limits.mountedTranscriptRows, "the transcript mounted every row")

    // Resident memory, soft: the runner may not be allowed to read it.
    if let bytes = Self.residentBytes(bundle: "sh.wemessage.gateway") {
      report("rss", Double(bytes) / 1_048_576, "MB", nil, .soft)
    } else {
      print("G2|rss|-|MB|-|soft")
    }

    // Event to UI, soft: the stream must be open before the frame is sent.
    _ = try await FakeDaemon.waitForRequests(["GET /v1/events/sse"])
    let line = element(app, ID.connection)
    let want = ProvisionalUI.connectedLine(state: Self.flipped)
    let sent = ContinuousClock.now
    try await FakeDaemon.emit(state: Self.flipped)
    if waitUntil({ (line.value as? String) == want }) {
      report("event-to-ui", ms(ContinuousClock.now - sent), "ms", nil, .soft)
    } else {
      print("G2|event-to-ui|-|ms|-|soft")
      print("BOARD00| the connection line still reads \(String(describing: line.value))")
    }
  }

  // MARK: Measures

  /// Transcript rows in the window: bubbles and day separators.
  @MainActor
  private func countRows(_ app: XCUIApplication) -> Int {
    let predicate = NSPredicate(
      format: "identifier BEGINSWITH %@ OR identifier BEGINSWITH %@", ID.bubblePrefix, ID.dayPrefix)
    return app.descendants(matching: .any).matching(predicate).count
  }

  /// The app's resident size from proc_pid_rusage (libproc, through
  /// Foundation's Darwin), or nil when the runner cannot see the process.
  @MainActor
  static func residentBytes(bundle: String) -> UInt64? {
    guard let pid = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first?.processIdentifier
    else { return nil }
    var info = rusage_info_v4()
    let rc = withUnsafeMutablePointer(to: &info) { pointer in
      pointer.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) }
    }
    return rc == 0 ? info.ri_resident_size : nil
  }

  static func encoded(_ guid: String) -> String {
    var allowed = CharacterSet.urlPathAllowed
    allowed.remove(charactersIn: ";+/")
    return guid.addingPercentEncoding(withAllowedCharacters: allowed) ?? guid
  }

  private func ms(_ duration: Duration) -> Double {
    Double(duration.components.seconds) * 1_000 + Double(duration.components.attoseconds) / 1e15
  }

  private func report(_ metric: String, _ value: Double, _ unit: String, _ limit: Int?, _ kind: G2Limits.Kind) {
    print(G2Limits.line(metric: metric, value: value, unit: unit, limit: limit, kind: kind))
  }

  // MARK: Helpers

  /// Time from `since` until `element` is hittable, polled every 10 ms; nil
  /// when the wait runs out. Synchronous on purpose: Thread.sleep is not
  /// allowed in the async test body.
  @MainActor
  private func firstHittable(_ element: XCUIElement, since: ContinuousClock.Instant) -> Duration? {
    let deadline = since + .seconds(UITestApp.timeout)
    var polls = 0
    var existed: Duration?
    while ContinuousClock.now < deadline {
      polls += 1
      let exists = element.exists
      if exists && existed == nil { existed = ContinuousClock.now - since }
      if exists && element.isHittable {
        let at = ContinuousClock.now - since
        print("BOARD00| first row: \(polls) polls, exists at \(existed.map { ms($0) } ?? -1) ms, hittable at \(ms(at)) ms")
        return at
      }
      Thread.sleep(forTimeInterval: 0.01)
    }
    return nil
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
