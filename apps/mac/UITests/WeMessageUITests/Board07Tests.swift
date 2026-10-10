import AppKit
import Foundation
import XCTest

/// v2 B4: board 07, the voice dock, drawn over fixtures. There is no
/// microphone and no speech engine in this version: every dock state is the
/// fake daemon's status.meta.voice from a "preview-voice*" scenario, and
/// only the UI-test flag opens the gate that reads it (H-B-1). One launch
/// per appearance: each state is a scenario switch plus the test-only
/// reload key (cmd-opt-R), over Priya's thread and her pending draft.
///
/// What is checked, in every state: the dock sits bottom-centre over the
/// reader, above the composer, at its size's width (D-UI-138); the reader
/// insets from the dock's measured rect, so the draft's bottom edge is
/// never under the dock (D-UI-179); the caption is drawn and holds words
/// (D-UI-172); the dock holds no switch or checkbox; one chip.
/// - idle and speaking: the two smaller sizes, no failure line, no card;
/// - the six failure modes (07.F): unheard, misheard, selfheard,
///   interrupted, muted, each its own line, and transport, whose card is
///   disarmed: cmd-Return there does nothing;
/// - confirm: a spoken approve armed the card and that is all it did: the
///   journal holds no draft action. cmd-Return then starts the same 10 s
///   window as A (the outbox counts down, as on board 02), nothing reaches
///   the daemon inside it, and when it elapses the one request is
///   POST /v1/drafts/drf-0102/approve. Never /v1/send.
/// The chip is read by its words: a value set on it never reaches XCUI.
/// Shots are board-07-<state>-<appearance>.png. The idle dock is held to
/// the frost evidence (the thread layout's patches are clear of it); the
/// larger, opaque states are glanced (attached and swept for green).
/// The light launch also runs the accessibility audit. CI only.
final class Board07Tests: XCTestCase {
  override func setUp() async throws {
    // D-S7a-9: the light launch walks every state and runs the audit, whose
    // contrast probe screenshots each flagged element; board 07 light passed 120 s and was restarted in run 38017941867.
    // Under ci-swift's 300 s maximum.
    executionTimeAllowance = 240
    try await FakeDaemon.reset()
  }

  @MainActor
  func testBoard07Light() async throws {
    try await board07(appearance: "light") { mean in
      XCTAssertGreaterThan(mean, 0.6, "a light board 07 renders dark: mean luminance \(mean)")
    }
  }

  @MainActor
  func testBoard07Dark() async throws {
    try await board07(appearance: "dark") { mean in
      XCTAssertLessThan(mean, 0.4, "a dark board 07 renders light: mean luminance \(mean)")
    }
  }

  /// The six failure modes and their scenarios, transport last: it is the
  /// one with a card, which the confirm state then re-arms.
  static let failures = ["unheard", "misheard", "selfheard", "interrupted", "muted", "transport"]

  @MainActor
  private func board07(appearance: String, luminance: (Double) -> Void) async throws {
    try await FakeDaemon.scenario("preview-voice")
    let app = UITestApp.make(appearance: appearance, reduceTransparency: false)
    app.launch()
    defer { app.terminate() }
    XCTAssertTrue(UITestApp.shellElement(app).waitForExistence(timeout: UITestApp.timeout), "the shell never appeared")
    let geometry = settledGeometry(app)
    let started = Date()
    let dock = QueueUI.element(app, ID.voiceDockBoard07)
    let priya = QueueUI.priyaDraft
    func meta() -> String { QueueUI.meta(app, priya) }
    func size() -> String { dock.exists ? dock.label : "(missing)" }
    func glanceAt(_ state: String) {
      QueueUI.settle()
      glance(app, name: "board-07-\(state)-\(appearance).png")
      QueueUI.printTime("BOARD07", appearance, state, since: started)
    }

    /// Serve `scenario`, reload, and wait for the dock to say `wanted`.
    func switchTo(_ scenario: String, size wanted: String) async throws {
      try await FakeDaemon.scenario(scenario)
      app.typeKey("r", modifierFlags: [.command, .option])
      XCTAssertTrue(
        QueueUI.waitUntil { size() == "Voice dock, " + wanted }, "\(scenario): the dock reads '\(size())'")
    }

    /// What every state shares: anchor, width, the inset, the caption, one
    /// chip, and no switch anywhere in the dock.
    func checkDock(_ state: String, width: Double) {
      QueueUI.settle()
      XCTAssertEqual(Double(dock.frame.width), width, accuracy: 1, "\(state): dock width")
      let thread = QueueUI.element(app, ID.thread)
      XCTAssertEqual(Double(dock.frame.midX), Double(thread.frame.midX), accuracy: 2, "\(state): the dock is not centred over the reader")
      let field = QueueUI.element(app, ID.composerField)
      if field.exists {
        XCTAssertLessThanOrEqual(dock.frame.maxY, field.frame.minY, "\(state): the dock covers the composer")
      }
      // D-UI-179: the reader's content ends above the dock, in every size.
      let draft = QueueUI.element(app, ID.draft)
      XCTAssertTrue(draft.exists, "\(state): Priya's draft is not drawn")
      XCTAssertLessThanOrEqual(
        draft.frame.maxY, dock.frame.minY + 0.5,
        "\(state): the draft (maxY \(draft.frame.maxY)) is under the dock (minY \(dock.frame.minY))")
      // D-UI-172: the caption is always on.
      let caption = QueueUI.element(app, ID.voiceDockCaption)
      XCTAssertTrue(caption.exists, "\(state): no caption")
      XCTAssertFalse(QueueUI.words(caption).isEmpty, "\(state): the caption is empty")
      XCTAssertTrue(caption.frame.minY >= dock.frame.minY && caption.frame.maxY <= dock.frame.maxY, "\(state): caption")
      XCTAssertEqual(QueueUI.count(app, containing: ID.voiceDockChip), 1, "\(state): not one chip")
      XCTAssertEqual(dock.descendants(matching: .switch).count, 0, "\(state): a switch in the dock")
      XCTAssertEqual(dock.descendants(matching: .checkBox).count, 0, "\(state): a checkbox in the dock")
      XCTAssertTrue(QueueUI.element(app, ID.voiceDockMic).exists, "\(state): no mic indicator")
    }

    // idle: the smallest dock, over Priya's thread with her pending draft.
    QueueUI.open(app, QueueUI.priya)
    XCTAssertTrue(QueueUI.waitUntil { size() == "Voice dock, idle" }, "idle: the dock reads '\(size())'")
    checkDock("idle", width: ProvisionalUI.voiceDockWidthIdle)
    XCTAssertEqual(QueueUI.label(app, ID.voiceDockChip), ProvisionalUI.voiceChipIdle, "idle: chip")
    XCTAssertFalse(QueueUI.element(app, ID.voiceDockFailure).exists, "idle: a failure line")
    XCTAssertFalse(QueueUI.element(app, ID.voiceDockCard).exists, "idle: a confirm card")
    XCTAssertTrue(meta().hasPrefix("DRAFT"), "idle: meta reads \(meta())")
    QueueUI.settle()
    capture(
      app, geometry: geometry, appearance: appearance, frost: true, name: "board-07-idle-\(appearance).png",
      layout: .thread, luminance: luminance)
    QueueUI.printTime("BOARD07", appearance, "idle", since: started)
    if appearance == "light" { try audit(app, window: "audit-board-07-idle") }

    // speaking: the middle size.
    try await switchTo("preview-voice-speaking", size: "speaking")
    checkDock("speaking", width: ProvisionalUI.voiceDockWidthSpeaking)
    XCTAssertEqual(QueueUI.label(app, ID.voiceDockChip), ProvisionalUI.voiceChipSpeaking, "speaking: chip")
    XCTAssertFalse(QueueUI.element(app, ID.voiceDockFailure).exists, "speaking: a failure line")
    glanceAt("speaking")

    // The six failure modes (07.F), each its own line under the caption.
    let lines = [
      "unheard": ProvisionalUI.voiceFailureUnheard,
      "selfheard": ProvisionalUI.voiceFailureSelfHeard,
      "interrupted": ProvisionalUI.voiceFailureInterrupted,
      "muted": ProvisionalUI.voiceFailureMuted,
      "transport": ProvisionalUI.voiceFailureTransport,
    ]
    for failure in Self.failures {
      let wanted = failure == "transport" ? "confirm" : "speaking"
      try await switchTo("preview-voice-" + failure, size: wanted)
      let width = wanted == "confirm" ? ProvisionalUI.voiceDockWidthConfirm : ProvisionalUI.voiceDockWidthSpeaking
      checkDock(failure, width: width)
      let line = QueueUI.label(app, ID.voiceDockFailure)
      if let expected = lines[failure] {
        XCTAssertEqual(line, expected, "\(failure): failure line")
      } else {
        XCTAssertTrue(line.hasSuffix("Meant Maya? \u{2318}["), "\(failure): failure line reads \(line)")
      }
      if failure == "muted" { XCTAssertEqual(QueueUI.value(app, ID.voiceDockMic), "muted", "muted: mic") }
      glanceAt("failure-\(failure)")
    }

    // transport: the link expired while armed. The card is drawn disarmed,
    // Send is gone, and cmd-Return does nothing.
    let card = QueueUI.element(app, ID.voiceDockCard)
    XCTAssertTrue(card.exists, "transport: no card")
    XCTAssertEqual(card.label, ProvisionalUI.voiceCardDisarmedLine, "transport: the card is not disarmed")
    XCTAssertFalse(QueueUI.element(app, ID.voiceDockSend).exists, "transport: Send is drawn on a disarmed card")
    app.typeKey(.return, modifierFlags: .command)
    try await Task.sleep(nanoseconds: 1_000_000_000)
    XCTAssertTrue(meta().hasPrefix("DRAFT"), "transport: cmd-Return approved: meta reads \(meta())")
    XCTAssertFalse(QueueUI.element(app, ID.composerOutbox).exists, "transport: cmd-Return started a window")
    try await QueueUI.assertJournal("transport, after cmd-Return")

    // confirm: a spoken approve armed the card. Armed is all it did.
    try await switchTo("preview-voice-confirm", size: "confirm")
    checkDock("confirm", width: ProvisionalUI.voiceDockWidthConfirm)
    XCTAssertEqual(QueueUI.label(app, ID.voiceDockChip), ProvisionalUI.voiceChipConfirm, "confirm: chip")
    XCTAssertTrue(QueueUI.waitUntil { card.exists && card.label == ProvisionalUI.voiceCardArmedLine }, "confirm: card reads \(card.label)")
    XCTAssertTrue(QueueUI.element(app, ID.voiceDockSend).exists, "confirm: no Send on the armed card")
    XCTAssertTrue(QueueUI.element(app, ID.voiceDockCancel).exists, "confirm: no Cancel on the armed card")
    XCTAssertTrue(card.frame.minY >= dock.frame.minY && card.frame.maxY <= dock.frame.maxY, "confirm: the card is outside the dock")
    XCTAssertTrue(meta().hasPrefix("DRAFT"), "confirm: the spoken approve did more than arm: meta reads \(meta())")
    XCTAssertFalse(QueueUI.element(app, ID.composerOutbox).exists, "confirm: the spoken approve started a window")
    glanceAt("confirm-armed")
    if appearance == "light" { try audit(app, window: "audit-board-07-confirm") }
    try await QueueUI.assertJournal("armed by voice")

    // cmd-Return: the existing approve path, its window first.
    app.typeKey(.return, modifierFlags: .command)
    func outbox() -> String { QueueUI.label(app, ID.composerOutbox) }
    XCTAssertTrue(QueueUI.waitUntil(5) { outbox().hasPrefix("SENDING in ") }, "cmd-Return: the outbox reads \(outbox())")
    try await QueueUI.assertJournal("inside the approve window")
    let approve = "POST /v1/drafts/\(priya)/approve"
    let journal = try await FakeDaemon.waitForRequests([approve], timeout: 45)
    let writes = journal.requests.filter { $0.method != "GET" }.map { "\($0.method) \($0.path)" }
    XCTAssertEqual(writes, [approve], "cmd-Return: the writes were \(writes)")
    try await FakeDaemon.assertNoSend()
    QueueUI.printTime("BOARD07", appearance, "approved", since: started)
  }
}
