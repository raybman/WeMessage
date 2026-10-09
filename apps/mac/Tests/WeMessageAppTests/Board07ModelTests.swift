import Foundation
import Testing
import WeMessageKit

@testable import WeMessageApp

/// v2 B4, board 07: the voice dock over fixtures. Every row reads the
/// preview-voice* scenarios the fake daemon serves: three sizes, nine chips
/// told apart without colour, a caption in every state, six failure lines,
/// a reader that never sits under the dock, and a confirm card a spoken
/// approve only arms. cmd-Return is the one way forward, through the same
/// approve path and undo window as A.
@Suite("Board07Model")
@MainActor
struct Board07ModelTests {
  /// The fixture state's word. Assembled: the app's sources spell it once,
  /// in TestHooks (H-B-1).
  static let fixtureWord = "pre" + "view"
  static let open = PreviewGate(state: fixtureWord)
  static let base = fixtureWord + "-voice"
  static let scenarios = [
    base, base + "-speaking", base + "-confirm", base + "-unheard", base + "-misheard", base + "-selfheard",
    base + "-interrupted", base + "-transport", base + "-muted",
  ]
  static let priya = "SMS;-;+15550100004"
  static let maya = "iMessage;-;+15550100001"
  static let priyaDraft = "drf-0102"

  static func status(_ name: String) throws -> StatusPayload {
    try ShellModelTests.decode(Reply.scenario(name, "status.json"), StatusPayload.self)
  }

  /// The dock a scenario's status draws over Priya's thread, whose pending
  /// draft is drf-0102.
  static func dock(_ name: String, pending: String? = priyaDraft) throws -> VoiceDockModel {
    let voice = try status(name).meta?["voice"]
    return try #require(VoiceDockModel.make(voice, threadTitle: "Priya Natarajan", pendingDraftId: pending), "\(name)")
  }

  @Test("V1: every voice scenario draws a dock; the three sizes keep D-UI-138's widths and the rest of status is rich's")
  func everyScenarioDraws() throws {
    var sizes = Set<VoiceDockModel.Size>()
    for name in Self.scenarios {
      let dock = try Self.dock(name)
      sizes.insert(dock.size)
      #expect(dock.size.width == [320, 420, 520][VoiceDockModel.Size.allCases.firstIndex(of: dock.size)!])
    }
    #expect(sizes == Set(VoiceDockModel.Size.allCases))
    #expect(VoiceDockModel.Size.allCases.map(\.width) == [320, 420, 520])
    #expect(try Self.status("rich").meta == nil, "rich carries no voice state, so it draws no dock")
    #expect(VoiceDockModel.make(nil, threadTitle: "x", pendingDraftId: nil) == nil)
    #expect(VoiceDockModel.make(.object(["dockState": .string("loud")]), threadTitle: "x", pendingDraftId: nil) == nil)
    #expect(VoiceDockModel.make(.string("idle"), threadTitle: "x", pendingDraftId: nil) == nil)
  }

  @Test("V2: nine chips, one at a time, each its own glyph, word, outline and weight; none is told apart by colour")
  func nineChips() {
    let chips = VoiceDockModel.Chip.allCases
    #expect(chips.count == 9)
    #expect(Set(chips.map(\.shape)).count == 9, "two chips look the same")
    #expect(Set(chips.map(\.label)).count == 9)
    #expect(Set(chips.map { $0.label.first! }).count == 9, "two chips share a glyph")
    #expect(chips.map(\.label) == [
      "\u{25CB} Idle", "\u{25C9} Listening", "\u{266A} Speaking", "\u{2026} Thinking", "\u{2197} Driving",
      "\u{2716} Interrupted", "\u{25EF} Did not catch that", "\u{26A0} Confirm", "\u{270B} Muted by you",
    ])
    #expect(VoiceDockModel.Chip.confirm.border == 3)
    #expect(chips.filter { $0 != .confirm }.allSatisfy { $0.border == 1 })
    #expect(chips.filter(\.dashed) == [.unheard])
    #expect(chips.filter(\.inverted) == [.muted])
    #expect(VoiceDockModel.Chip.unheard.word == "Did not catch that")
  }

  @Test("V3: the caption is drawn in every state and never empty; a state with no words reads its chip's word")
  func captionAlwaysOn() throws {
    for name in Self.scenarios {
      let dock = try Self.dock(name)
      #expect(!dock.caption.isEmpty, "\(name) has an empty caption")
    }
    for chip in VoiceDockModel.Chip.allCases {
      let dock = try #require(
        VoiceDockModel.make(
          .object(["dockState": .string("idle"), "chip": .string(chip.rawValue), "caption": .string("  ")]),
          threadTitle: "x", pendingDraftId: nil))
      #expect(dock.caption == chip.word)
    }
  }

  @Test("V4: the six failure modes each draw their line (07.F), with the fixture people's names")
  func sixFailures() throws {
    let expected: [(String, VoiceDockModel.Failure, String)] = [
      ("-unheard", .unheard, "Nothing heard. Nothing was done."),
      ("-misheard", .misheard, "Opened Priya Natarajan. Heard \u{201C}Priya\u{201D}. Meant Maya? \u{2318}["),
      ("-selfheard", .selfheard, "\u{201C}approve\u{201D} arrived during playout, discarded."),
      ("-interrupted", .interrupted, "Stopped mid-word. The view does not snap back."),
      ("-transport", .transport, "Voice link expired while this was armed. Card disarmed. Draft kept, nothing was sent."),
      ("-muted", .muted, "Readback suppressed. Drafts are shown, never spoken."),
    ]
    for (suffix, failure, line) in expected {
      let dock = try Self.dock(Self.base + suffix)
      #expect(dock.failure == failure)
      #expect(dock.failureLine == line)
    }
    #expect(Set(expected.map(\.1)) == Set(VoiceDockModel.Failure.allCases))
    for name in [Self.base, Self.base + "-speaking", Self.base + "-confirm"] {
      #expect(try Self.dock(name).failure == nil)
    }
    #expect(try Self.dock(Self.base + "-muted").micMuted)
    #expect(try Self.dock(Self.base + "-muted").chip == .muted)
    #expect(try Self.dock(Self.base + "-unheard").chip == .unheard)
  }

  @Test("V5: only a spoken approve on the confirm size, for this thread's pending draft, with no failure, arms the card")
  func armingRule() throws {
    let armed = try Self.dock(Self.base + "-confirm")
    #expect(armed.size == .confirm && armed.armed && armed.draftId == Self.priyaDraft)
    #expect(armed.readbackToken == "Priya")
    #expect(!(try Self.dock(Self.base + "-confirm", pending: "drf-0101")).armed, "another thread's draft")
    #expect(!(try Self.dock(Self.base + "-confirm", pending: nil)).armed, "no pending draft")
    #expect(!(try Self.dock(Self.base + "-transport")).armed, "a dead link disarms")
    #expect(!(try Self.dock(Self.base + "-selfheard")).armed, "its own voice never arms")
    for name in Self.scenarios where name != Self.base + "-confirm" {
      #expect(!(try Self.dock(name)).armed, "\(name) is armed")
    }
  }

  @Test("V6: the reader insets from the dock's measured top edge plus the gap, so content clears the dock in every size")
  func readerNeverUnderDock() {
    let reader = 600.0
    // Dock heights a size can measure at, idle to a tall confirm card.
    for height in [44.0, 72.0, 96.0, 140.0, 220.0, 260.0] {
      let minY = reader - ProvisionalUI.voiceDockGap - height
      let inset = VoiceDockLayout.readerInset(readerHeight: reader, dockMinY: minY)
      #expect(VoiceDockLayout.clears(readerHeight: reader, dockMinY: minY, inset: inset), "a \(height) pt dock covers the reader")
      #expect(inset == height + 2 * ProvisionalUI.voiceDockGap)
    }
    #expect(VoiceDockLayout.readerInset(readerHeight: reader, dockMinY: nil) == 0, "no dock, no inset")
    #expect(!VoiceDockLayout.clears(readerHeight: reader, dockMinY: 400, inset: 96), "a fixed 96 pt inset under a tall card")
  }

  @Test("V7: ThreadView insets the transcript from the measured dock, never a fixed height")
  func threadViewMeasures() throws {
    let text = try String(
      contentsOf: Repo.url(AppHygieneTests.appDir + "/Boards/Thread/ThreadView.swift"), encoding: .utf8)
    #expect(text.contains("VoiceDockLayout.readerInset("))
    // The transcript takes the measured inset, and no number stands in for it.
    #expect(text.contains("TranscriptView(model: model, thread: thread, palette: palette, bottomInset: readerInset)"))
    let fixed = try NSRegularExpression(pattern: #"bottomInset:\s*[0-9]"#)
    #expect(fixed.numberOfMatches(in: text, range: NSRange(text.startIndex..., in: text)) == 0)
    #expect(text.contains("dockMinY: model.voiceDock == nil ? nil : dockMinY.map(Double.init)"))
    let transcript = try String(
      contentsOf: Repo.url(AppHygieneTests.appDir + "/Boards/Thread/TranscriptView.swift"), encoding: .utf8)
    #expect(transcript.contains(".padding(.bottom, bottomInset)"))
  }

  @Test("V8: a spoken approve only arms; cmd-Return approves through approvePending's gates and window, and nothing reaches the daemon inside it")
  func spokenApproveOnlyArms() async throws {
    let transport = try ShellModelTests.scenarioTransport(Self.base + "-confirm")
    let m = ShellModel(client: testClient(transport))
    m.state = AppState(previewGate: Self.open)
    m.start()
    await ShellModelTests.settle(m) { _ in m.state.queue.count == 5 && m.threads != nil && m.status != nil }
    let confirm = try Self.status(Self.base + "-confirm")
    #expect(m.voiceDock == nil, "no thread open, no dock")
    m.selectedThread = Self.priya
    #expect(m.voiceDock?.armed == true)
    // Not drawn yet: the same gate as A refuses.
    #expect(!m.voiceCommit(in: Self.priya))
    m.outbound.markRendered(Self.priyaDraft)
    // The armed state arriving again does nothing by itself.
    m.status = confirm
    #expect(m.outbound.entries.isEmpty, "an armed card approved without cmd-Return")
    #expect(!m.voiceCommit(in: Self.maya), "another thread")
    #expect(m.outbound.entries.isEmpty)
    // cmd-Return: one entry, the approve gesture, counting; no request.
    #expect(m.voiceCommit(in: Self.priya))
    #expect(m.outbound.entries.count == 1)
    #expect(m.outbound.entries.first?.intent.draftId == Self.priyaDraft)
    #expect(m.outbound.entries.first?.phase == .counting(remaining: m.outbound.approveSeconds))
    #expect(transport.requests.allSatisfy { $0.url?.path != "/v1/send" && !($0.url?.path ?? "").contains("approve") })
    #expect(m.undoLast())

    // Cancel disarms this state; the draft stays pending.
    m.voiceCancel()
    #expect(m.voiceDock?.armed == false)
    #expect(m.voiceDock?.size == .confirm)
    #expect(!m.voiceCommit(in: Self.priya))
    #expect(m.pendingDraft(for: Self.priya)?.id == Self.priyaDraft)
    m.voiceCancelled = nil

    // A dead link and its own voice never commit.
    for name in [Self.base + "-transport", Self.base + "-selfheard"] {
      m.status = try Self.status(name)
      #expect(m.voiceDock?.armed == false, "\(name)")
      #expect(!m.voiceCommit(in: Self.priya), "\(name)")
    }
    // The kill switch refuses the armed card exactly as it refuses A.
    var killed = confirm
    killed.killSwitch = true
    m.status = killed
    #expect(m.voiceDock?.armed == true)
    #expect(!m.voiceCommit(in: Self.priya))
    #expect(m.outbound.entries.count == 1, "only the one undone entry")
    #expect(transport.requests.allSatisfy { $0.url?.path != "/v1/send" && !($0.url?.path ?? "").contains("approve") })
    m.stop()
  }

  @Test("V9: a closed gate draws no dock: the released app never sees a voice state, and would not draw one")
  func closedGate() throws {
    let m = ShellModel(client: testClient(FakeTransport { _ in throw Unreachable() }))
    #expect(m.state.previewGate == .closed)
    m.threads = try ShellModelTests.decode(Reply.scenario("rich", "threads.list.json"), ThreadsPage.self)
    m.status = try Self.status(Self.base + "-confirm")
    m.selectedThread = Self.priya
    #expect(m.voiceDock == nil)
    #expect(!m.voiceCommit(in: Self.priya))
    #expect(m.outbound.entries.isEmpty)
  }
}
