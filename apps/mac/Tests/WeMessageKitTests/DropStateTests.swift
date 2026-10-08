import Foundation
import Testing
import WeMessageKit

/// v2 S4k, board 15.A: the drop target. A drop stages and never sends; the
/// targeted look changes three properties at once; a list row stages only
/// after its thread has opened; the rail and a blocked chat refuse with a
/// reason.
@Suite("DropState")
struct DropStateTests {
  static let walls = SizeWallTable.standard
  static let files = AttachmentFixtures.dropped

  static func machine() -> DropMachine {
    DropMachine(channel: .imessage, recipient: "Maya Lee", walls: walls)
  }

  @Test("resting draws nothing: no field, no scrim, the thread at full strength")
  func resting() {
    let m = Self.machine()
    #expect(m.state == .resting)
    #expect(m.state.look == DropLook.resting)
    #expect(!m.state.look.field)
    #expect(m.state.look.scrim == 0)
    #expect(m.state.look.threadOpacity == 1)
  }

  @Test("over the thread, three properties change together: the inset dashed field, the 72% scrim and the thread at 35%")
  func threeProperties() {
    var m = Self.machine()
    m.enter(.thread, files: Self.files)
    guard case .targeted(let summary) = m.state else {
      Issue.record("over the thread did not target: \(m.state)")
      return
    }
    let look = m.state.look
    let rest = DropLook.resting
    #expect(look.field != rest.field)
    #expect(look.scrim != rest.scrim)
    #expect(look.threadOpacity != rest.threadOpacity)
    #expect(look.field && look.inset == 7 && look.dash == 3)
    #expect(look.scrim == 0.72)
    #expect(look.threadOpacity == 0.35)
    // The card says what is about to stage, and the wall, while the hand is
    // still on the mouse.
    #expect(summary.count == 3 && summary.images == 2 && summary.videos == 1)
    #expect(summary.title == "Drop to stage")
    #expect(summary.line == "3 files onto Maya Lee \u{00B7} iMessage")
    #expect(summary.detail == "2 images, 1 video \u{00B7} 420 MB total")
    #expect(summary.promise == "Nothing sends. They stage as a draft and you press Send.")
    #expect(summary.overWall == 1)
    #expect(summary.wallLine?.contains("over iMessage's about 100 MB per attachment wall") == true)
  }

  @Test("a drop over the thread stages every file and sends nothing")
  func dropStages() {
    var m = Self.machine()
    m.enter(.thread, files: Self.files)
    let outcome = m.drop(Self.files)
    #expect(outcome == .staged(Self.files))
    #expect(m.state == .resting)
    // The outcome type has no send case: the only thing a drop can do is
    // stage or refuse.
    for o in [outcome, DropOutcome.refused("x")] {
      switch o {
      case .staged, .refused: break
      }
    }
  }

  @Test("the rail and a blocked chat refuse with a reason, never silently")
  func refused() {
    var m = Self.machine()
    m.enter(.rail, files: Self.files)
    guard case .refused(let why) = m.state else {
      Issue.record("the rail accepted a drop: \(m.state)")
      return
    }
    #expect(why.contains("not a recipient"))
    #expect(m.state.look.hatched && !m.state.look.field)
    #expect(m.drop(Self.files) == .refused(why))
    m.exit()
    m.enter(.blockedChat, files: Self.files)
    guard case .refused(let blocked) = m.state else {
      Issue.record("a blocked chat accepted a drop")
      return
    }
    #expect(!blocked.isEmpty)
    #expect(m.drop(Self.files) == .refused(blocked))
  }

  @Test("a list row stages only after the dwell has opened its thread")
  func dwell() {
    var m = Self.machine()
    m.enter(.listRow("maya"), files: Self.files)
    #expect(m.state == .dwelling(row: "maya"))
    #expect(DropMachine.dwellMilliseconds == 600)
    // Dropped before the thread opened: refused, the recipient was unseen.
    if case .staged = m.drop(Self.files) { Issue.record("a drop staged into a thread nobody could see") }
    m.enter(.listRow("maya"), files: Self.files)
    m.dwellElapsed()
    #expect(m.openedRow == "maya")
    guard case .targeted = m.state else {
      Issue.record("the dwell did not open the thread and target it: \(m.state)")
      return
    }
    #expect(m.drop(Self.files) == .staged(Self.files))
  }

  @Test("leaving the target restores the resting look")
  func exit() {
    var m = Self.machine()
    m.enter(.thread, files: Self.files)
    m.exit()
    #expect(m.state == .resting)
    #expect(m.state.look == .resting)
  }

  @Test("no record control on iMessage: absent with a printed reason, never a greyed one")
  func recordAbsent() {
    let control = RecordControl.on(.imessage)
    guard case .absent(let reason) = control else {
      Issue.record("iMessage offers recording: \(control)")
      return
    }
    #expect(reason.contains("audio file"))
    #expect(!control.drawsControl)
    #expect(RecordControl.on(.whatsapp).drawsControl)
    #expect(!RecordControl.on(.linkedin).drawsControl)
    #expect(!RecordControl.on(.email).drawsControl)
  }
}
