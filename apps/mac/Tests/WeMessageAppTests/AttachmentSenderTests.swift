import Foundation
import Testing
import WeMessageKit

@testable import WeMessageApp

/// v2 F6f: the app's file send over a fake daemon port. Every image is a
/// grey PNG written byte by byte here, with a hand-built eXIf chunk that
/// carries a location (KitHygiene holds this bundle to Foundation and
/// Testing, so no image framework draws one); nothing reads a file and
/// nothing reaches a daemon.
@MainActor
@Suite("AttachmentSender (v2 F6f)")
struct AttachmentSenderTests {
  /// Everything the daemon port and the caption funnel saw, in one order.
  final class Port: AttachmentSending, @unchecked Sendable {
    private let lock = NSLock()
    private var seen: [String] = []
    private var stagedBytes: [Data] = []
    let outcome: String
    let code: String?

    init(outcome: String = "sent", code: String? = nil) {
      self.outcome = outcome
      self.code = code
    }

    var log: [String] { lock.withLock { seen } }
    var bytes: [Data] { lock.withLock { stagedBytes } }
    func note(_ line: String) { lock.withLock { seen.append(line) } }

    func stageAttachment(name: String, mime: String, bytes: Data) async throws -> StagedAttachment {
      lock.withLock {
        seen.append("stage " + name + " " + mime)
        stagedBytes.append(bytes)
      }
      return StagedAttachment(stageId: String(repeating: "a", count: 64), name: name, mime: mime, bytes: bytes.count)
    }

    func sendFile(to handle: String, stageId: String) async throws -> SendResult {
      note("file " + handle)
      let error = code.map { #","error":{"code":"\#($0)","message":"m"}"# } ?? ""
      let json = #"{"draftId":"d1","outcome":"\#(outcome)""# + error + "}"
      return try JSONDecoder().decode(SendResult.self, from: Data(json.utf8))
    }
  }

  static let chat = "iMessage;-;+15551234567"
  static let handle = "+15551234567"

  private static func be32(_ v: UInt32) -> [UInt8] { [UInt8(v >> 24), UInt8(v >> 16 & 0xFF), UInt8(v >> 8 & 0xFF), UInt8(v & 0xFF)] }
  private static func be16(_ v: UInt16) -> [UInt8] { [UInt8(v >> 8), UInt8(v & 0xFF)] }

  /// A TIFF-shaped EXIF block whose only IFD points at a GPS IFD: version,
  /// N, and a latitude of 37 46 30.
  static func gpsExif() -> [UInt8] {
    func entry(_ tag: UInt16, _ type: UInt16, _ count: UInt32, _ value: [UInt8]) -> [UInt8] {
      be16(tag) + be16(type) + be32(count) + value
    }
    var t: [UInt8] = Array("MM".utf8) + be16(42) + be32(8)
    t += be16(1) + entry(0x8825, 4, 1, be32(26)) + be32(0)
    t += be16(3)
    t += entry(0x0000, 1, 4, [2, 2, 0, 0])
    t += entry(0x0001, 2, 2, Array("N".utf8) + [0, 0, 0])
    t += entry(0x0002, 5, 3, be32(68))
    t += be32(0)
    t += be32(37) + be32(1) + be32(46) + be32(1) + be32(30) + be32(1)
    return t
  }

  /// A 4 x 4 grey PNG (AttachmentThumbnailsTests' writer) with the GPS
  /// block in an eXIf chunk after IHDR.
  static func pngWithLocation() -> Data {
    let plain = [UInt8](AttachmentThumbnailsTests.encoded(4, 4).data)
    // Signature (8) + IHDR (4 + 4 + 13 + 4 = 25): insert after them.
    let exif = gpsExif()
    let typed = Array("eXIf".utf8) + exif
    var crc: UInt32 = 0xFFFF_FFFF
    for b in typed {
      crc ^= UInt32(b)
      for _ in 0..<8 { crc = crc & 1 == 1 ? 0xEDB8_8320 ^ (crc >> 1) : crc >> 1 }
    }
    let chunk = be32(UInt32(exif.count)) + typed + be32(crc ^ 0xFFFF_FFFF)
    return Data(plain[0..<33] + chunk + plain[33...])
  }

  static func file(_ name: String, _ kind: StagedFile.Kind, bytes: Int64 = 1_000) -> StagedFile {
    StagedFile(id: "/fixture/" + name, name: name, kind: kind, bytes: bytes, width: 4, height: 4, hasLocation: true)
  }

  static func set(_ files: [StagedFile], caption: String) -> OutboundAttachments? {
    var tray = StagingTray(channel: .imessage, walls: .standard)
    tray.stage(files)
    tray.caption = caption
    return OutboundAttachments(tray: tray)
  }

  static func sender(_ port: Port, data: Data, kill: Bool? = false) -> AttachmentSender {
    let sender = AttachmentSender(
      port: port, killSwitch: { kill }, read: { _ in data },
      caption: { _, handle, body in
        port.note("caption " + handle + " " + body)
        return nil
      }, now: { Date(timeIntervalSince1970: 0) })
    sender.isOn = true
    return sender
  }

  @Test("gpsStrippedBeforeStage: the bytes staged carry no location, and HEIC leaves as JPEG without one")
  func gpsStrippedBeforeStage() async throws {
    let png = Self.pngWithLocation()
    #expect(AttachmentPrep.carriesLocation(png), "the fixture carries no location, so this proves nothing")
    #expect(AttachmentPrep.sniff(png) == "image/png")

    let port = Port()
    let sender = Self.sender(port, data: png)
    let set = try #require(Self.set([Self.file("grey.png", .image(.png))], caption: ""))
    _ = await sender.deliver(set, chatGuid: Self.chat, handle: Self.handle)
    let staged = try #require(port.bytes.first)
    #expect(port.log.first == "stage grey.png image/png")
    #expect(!AttachmentPrep.carriesLocation(staged), "a location reached the outbox")
    #expect(AttachmentPrep.sniff(staged) == "image/png")

    // A file the tray calls HEIC is converted: JPEG bytes, a .jpg name, and
    // still no location. (The input is the PNG above: this bundle cannot
    // write a HEIC, and the conversion decodes whatever ImageIO can read.)
    let heicPort = Port()
    let heic = Self.sender(heicPort, data: png)
    let heicSet = try #require(Self.set([Self.file("IMG_0001.HEIC", .image(.heic))], caption: ""))
    _ = await heic.deliver(heicSet, chatGuid: Self.chat, handle: Self.handle)
    let jpeg = try #require(heicPort.bytes.first)
    #expect(heicPort.log.first == "stage IMG_0001.jpg image/jpeg")
    #expect(AttachmentPrep.sniff(jpeg) == "image/jpeg")
    #expect(!AttachmentPrep.carriesLocation(jpeg))
  }

  @Test("captionSentOnlyAfterFileVerified: stage, file, then the words; an unverified file sends no words and is outlined")
  func captionSentOnlyAfterFileVerified() async throws {
    let png = Self.pngWithLocation()
    let set = try #require(Self.set([Self.file("grey.png", .image(.png))], caption: "north elevation"))

    let port = Port()
    let sender = Self.sender(port, data: png)
    let line = await sender.deliver(set, chatGuid: Self.chat, handle: Self.handle)
    #expect(
      port.log == ["stage grey.png image/png", "file " + Self.handle, "caption " + Self.handle + " north elevation"])
    let id = String(repeating: "a", count: 64)
    #expect(sender.journal == [.prepared(name: "grey.png"), .staged(stageId: id), .fileSent(stageId: id), .caption])
    #expect(line == ProvisionalUI.attachmentConfirmed(at: Date(timeIntervalSince1970: 0)))
    #expect(!sender.outlined)

    // Accepted but never seen in chat.db: no caption, the outlined line.
    let quiet = Port(outcome: "failed", code: "unverified")
    let unconfirmed = Self.sender(quiet, data: png)
    let words = await unconfirmed.deliver(set, chatGuid: Self.chat, handle: Self.handle)
    #expect(quiet.log == ["stage grey.png image/png", "file " + Self.handle])
    #expect(words == ProvisionalUI.attachmentUnconfirmed)
    #expect(unconfirmed.outlined)
    #expect(!unconfirmed.journal.contains(.caption))

    // The kill switch on at the minute: staged, never sent, no words.
    let held = Port()
    let killed = Self.sender(held, data: png, kill: true)
    _ = await killed.deliver(set, chatGuid: Self.chat, handle: Self.handle)
    #expect(held.log == ["stage grey.png image/png"])
    #expect(killed.line == ProvisionalUI.attachmentNotSent("kill switch on"))
  }

  @Test("offPrintsParkedAndJournalHasNoStage: the tray's Send while attachments are off prints D-UI-224 and stages nothing")
  func offPrintsParkedAndJournalHasNoStage() async throws {
    let port = Port()
    let sender = Self.sender(port, data: Self.pngWithLocation())
    sender.isOn = false
    let model = AttachmentsModel(
      content: FixtureAttachments.content(),
      send: { sender.start($0, chatGuid: Self.chat, handle: Self.handle) },
      save: { _ in URL(fileURLWithPath: "/tmp") }, reveal: { _ in }, copy: { _ in })
    model.attach([Self.file("grey.png", .image(.png))])
    model.caption = "hello"
    model.sendTray()
    #expect(model.note == ProvisionalUI.attachmentsOff)
    #expect(sender.journal.isEmpty)
    #expect(!sender.busy)
    try await Task.sleep(for: .milliseconds(50))
    #expect(port.log.isEmpty, "a stage or send left while off: \(port.log)")
    // Unknown is off: no settings read means no setting.
    #expect(!AttachmentPrep.enabled(nil))
    #expect(!AttachmentPrep.enabled(.bool(false)))
    #expect(!AttachmentPrep.enabled(.string("1")))
    #expect(AttachmentPrep.enabled(.bool(true)))
  }

  @Test("refusals read in words: 409 off, 413 and 415 by their code")
  func refusalWords() {
    let off = GatewayError.conflict(ConflictDetail(error: "attachments-unproven"))
    #expect(AttachmentSender.words(for: off) == ProvisionalUI.attachmentsOff)
    let big = GatewayError.request(status: 413, body: .object(["error": .string("attachment-too-large")]))
    #expect(AttachmentSender.words(for: big) == ProvisionalUI.attachmentNotSent("attachment-too-large"))
    #expect(AttachmentPrep.sniff(Data("<html>".utf8)) == nil)
  }
}
