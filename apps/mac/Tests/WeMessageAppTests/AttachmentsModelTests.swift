import Foundation
import Testing
import WeMessageKit

@testable import WeMessageApp

/// v2 S4k, board 15: the media model. Three doors land in the tray and none
/// of them sends; a staged file reaches the outbound sink only through the
/// tray's Send, built from the tray, and never over the wall. The viewer
/// pins the offset when it opens and restores it with the origin outlined.
@Suite("AttachmentsModel")
@MainActor
struct AttachmentsModelTests {
  /// Everything the model's injected effects saw.
  final class Seen {
    var sent: [OutboundAttachments] = []
    var saved: [String] = []
    var revealed: [URL] = []
    var copied: [String] = []
  }

  static func model(outlineSeconds: Int = 60) -> (AttachmentsModel, Seen) {
    let seen = Seen()
    let model = AttachmentsModel(
      content: FixtureAttachments.content(), outlineSeconds: outlineSeconds,
      send: { set in
        seen.sent.append(set)
        return "sink"
      },
      save: { item in
        seen.saved.append(item.wireName)
        return URL(fileURLWithPath: "/tmp/Downloads").appendingPathComponent(item.wireName)
      },
      reveal: { seen.revealed.append($0) },
      copy: { seen.copied.append($0.wireName) })
    return (model, seen)
  }

  @Test("a drop stages into the tray and reaches no sink: every door lands in the tray, and only Send reaches Outbound")
  func dropNeverSends() {
    let (model, seen) = Self.model()
    let dropped = model.content.dropped
    model.hover(.thread, files: dropped)
    guard case .targeted = model.drop.state else {
      Issue.record("over the thread did not target: \(model.drop.state)")
      return
    }
    #expect(model.release(dropped) == .staged(dropped))
    #expect(model.tray.items == dropped)
    #expect(seen.sent.isEmpty, "a drop reached the sink: \(seen.sent)")
    #expect(model.drop.state == .resting)
    // The other two doors stage too, and send nothing.
    model.attach(model.content.attached)
    let p = model.content.pasted
    model.paste(bytes: p.bytes, width: p.width, height: p.height, at: p.at)
    #expect(model.tray.items.count == 8)
    #expect(model.tray.items.last?.name.hasPrefix("pasted-") == true)
    #expect(seen.sent.isEmpty, "a door reached the sink: \(seen.sent)")
  }

  @Test("a staged file never reaches Outbound without the tray: no set over the wall, and the set the sink gets is the tray's")
  func onlyThroughTheTray() throws {
    let (model, seen) = Self.model()
    // Nothing staged: Send does nothing, and no set can be built.
    model.sendTray()
    #expect(seen.sent.isEmpty)
    #expect(OutboundAttachments(tray: StagingTray(channel: .imessage, walls: .standard)) == nil)
    // Over the wall: Send is inert, and nothing offers to send anyway.
    model.hover(.thread, files: model.content.dropped)
    model.release(model.content.dropped)
    #expect(!model.tray.canSend)
    model.sendTray()
    #expect(seen.sent.isEmpty, "a set over the wall reached the sink")
    // Remove the video: the sink gets exactly the tray, with JPEG names.
    let video = try #require(model.tray.items.first { $0.isVideo })
    model.remove(video.id)
    model.attach(model.content.attached)
    model.caption = "Site visit, north elevation"
    model.sendTray()
    let set = try #require(seen.sent.first)
    #expect(seen.sent.count == 1)
    #expect(set.files == model.tray.items)
    #expect(set.wireNames.contains("IMG_4417.jpg"))
    #expect(!set.wireNames.contains { $0.hasSuffix(".HEIC") })
    #expect(set.caption == "Site visit, north elevation")
    #expect(model.note == "sink")
  }

  @Test("a refused drop prints its reason and stages nothing")
  func refusedDrop() {
    let (model, seen) = Self.model()
    model.hover(.rail, files: model.content.dropped)
    #expect(model.release(model.content.dropped) == .refused(DropMachine.railReason))
    #expect(model.tray.isEmpty)
    #expect(model.note == DropMachine.railReason)
    #expect(seen.sent.isEmpty)
  }

  @Test("a list row stages only after the dwell opens its thread")
  func dwell() async throws {
    let (model, _) = Self.model()
    model.hover(.listRow("maya"), files: model.content.dropped)
    #expect(model.drop.state == .dwelling(row: "maya"))
    try await Task.sleep(for: .milliseconds(DropMachine.dwellMilliseconds + 400))
    guard case .targeted = model.drop.state else {
      Issue.record("the dwell never opened the thread: \(model.drop.state)")
      return
    }
    #expect(model.drop.openedRow == "maya")
  }

  @Test("the viewer pins the offset at open, and Esc restores it and outlines the origin, not where the arrows went")
  func viewerRestores() async throws {
    let (model, _) = Self.model(outlineSeconds: 1)
    model.scrollY = 412
    model.open(2, from: "m6")
    #expect(model.viewer?.position == "3 / 7")
    #expect(model.pinned == 412)
    model.scrollY = 0
    model.next(); model.next(); model.next()
    #expect(model.viewer?.position == "6 / 7")
    for _ in 0..<5 { model.next() }
    #expect(model.viewer?.position == "7 / 7", "the set wrapped or crossed threads")
    model.close()
    #expect(model.viewer == nil)
    #expect(model.restore == 412)
    #expect(model.outlined == "m6")
    model.restored()
    #expect(model.restore == nil)
    try await Task.sleep(for: .milliseconds(1400))
    #expect(model.outlined == nil, "the outline never faded")
  }

  @Test("Save names the converted copy; Reveal before a save offers the save and never the cache; Copy copies")
  func viewerActions() {
    let (model, seen) = Self.model()
    model.open(2, from: "m6")
    #expect(model.viewerLine == AttachmentsModel.cachedLine)
    model.revealSaved()
    #expect(seen.revealed.isEmpty, "Reveal opened something before a save")
    #expect(model.viewerLine.contains("Save a copy first"))
    model.save()
    #expect(seen.saved == ["IMG_4417.jpg"])
    #expect(model.viewerLine == "Saved to Downloads as IMG_4417.jpg")
    model.revealSaved()
    #expect(seen.revealed.map(\.lastPathComponent) == ["IMG_4417.jpg"])
    model.copyCurrent()
    #expect(seen.copied == ["IMG_4417.jpg"])
  }

  @Test("the record slot on iMessage is absent with a reason; the refusal's fourth part moves words and sends nothing")
  func refusal() {
    let (model, seen) = Self.model()
    #expect(!model.record.drawsControl)
    #expect(model.record.reason?.isEmpty == false)
    model.page = .refusal
    model.takeDraftedWords()
    #expect(model.composerWords == model.content.draftedWords)
    #expect(seen.sent.isEmpty)
  }
}
