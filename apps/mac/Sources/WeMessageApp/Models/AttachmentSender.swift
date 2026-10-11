import AppKit
import Foundation
import Observation
import WeMessageKit

// v2 F6f: the app half of a file send. The composer's tray hands this a
// set built from the tray (AttachmentsModel.sendTray is still the only way
// a set exists, H-S4-11); this prepares each file, stages its bytes in the
// daemon's outbox, sends it by stage id, and only once the daemon says the
// file was verified by its transfer name does the caption go, through
// Outbound like any typed message.
//
//  - Off by default (D-F6-1): while `send.attachments` is off, or settings
//    have not been read, nothing is prepared, staged or sent, and the tray
//    prints D-UI-224. The daemon refuses both routes with 409 anyway.
//  - Prepared here (D-F6-3, D-F6-4): an image is decoded and re-encoded
//    with every property but location kept, so GPS never reaches the
//    outbox; HEIC leaves as JPEG at quality 0.9. Any other file goes as it
//    is, typed by its own first bytes over the daemon's closed set.
//  - The kill switch is read again before each file's send. A file send has
//    no undo window: the tray's Send is the decision, and the file cannot be
//    taken back once Messages has it. The caption, being text, keeps
//    Outbound's 4 s window and kill switch checks.

/// What the sender reaches the daemon through: GatewayClient in the app, a
/// fake in tests.
protocol AttachmentSending: Sendable {
  func stageAttachment(name: String, mime: String, bytes: Data) async throws -> StagedAttachment
  func sendFile(to handle: String, stageId: String) async throws -> SendResult
}

extension GatewayClient: AttachmentSending {}

/// A file as it will leave this Mac: the wire name, its sniffed type, and
/// the bytes after preparation.
struct PreparedAttachment: Equatable, Sendable {
  let name: String
  let mime: String
  let bytes: Data
}

enum AttachmentPrep {
  /// The settings key that gates both daemon routes (D-F6-1).
  static let settingKey = "send.attachments"

  /// On only when the daemon says so: absent, unread or not a bool is off.
  static func enabled(_ value: JSONValue?) -> Bool {
    if case .bool(true)? = value { return true }
    return false
  }

  /// The daemon's closed sniff set (packages/daemon/src/attachments/sniff.ts),
  /// mirrored so a file the daemon would refuse is refused before upload.
  static func sniff(_ data: Data) -> String? {
    let b = [UInt8](data.prefix(16))
    func ascii(_ at: Int, _ text: String) -> Bool {
      let want = Array(text.utf8)
      return b.count >= at + want.count && Array(b[at..<(at + want.count)]) == want
    }
    if b.count >= 3 && b[0] == 255 && b[1] == 216 && b[2] == 255 { return "image/jpeg" }
    if b.count >= 8 && b[0..<8].elementsEqual([137, 80, 78, 71, 13, 10, 26, 10]) { return "image/png" }
    if ascii(0, "GIF87a") || ascii(0, "GIF89a") { return "image/gif" }
    if ascii(0, "RIFF") && ascii(8, "WEBP") { return "image/webp" }
    if ascii(0, "%PDF-") { return "application/pdf" }
    if ascii(0, "caff") { return "audio/x-caf" }
    if ascii(4, "ftyp") && b.count >= 12 {
      let brand = String(decoding: b[8..<12], as: UTF8.self)
      if ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].contains(brand) { return "image/heic" }
      if ["isom", "iso2", "mp41", "mp42", "avc1", "M4V "].contains(brand) { return "video/mp4" }
      if brand == "qt  " { return "video/quicktime" }
    }
    return nil
  }

  /// True when ImageIO reads a location dictionary from `data`.
  static func carriesLocation(_ data: Data) -> Bool {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
      let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
    else { return false }
    return props[kCGImagePropertyGPSDictionary] != nil
  }

  /// A picked file as the tray holds it: its path is its id, its size and
  /// frame read from disk without reading the bytes. A video goes by its
  /// extension: measuring its duration needs a media framework H-A1 keeps
  /// out, and the tray never prints a duration it does not know.
  static func pick(_ url: URL) -> StagedFile? {
    guard url.isFileURL else { return nil }
    let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
    let ext = url.pathExtension.lowercased()
    let kind: StagedFile.Kind
    switch ext {
    case "heic", "heif": kind = .image(.heic)
    case "jpg", "jpeg": kind = .image(.jpeg)
    case "png": kind = .image(.png)
    default: kind = .document(ext.isEmpty ? "FILE" : ext.uppercased())
    }
    var width: Int?
    var height: Int?
    var location = false
    if case .image = kind, let source = CGImageSourceCreateWithURL(url as CFURL, nil),
      let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
    {
      width = props[kCGImagePropertyPixelWidth] as? Int
      height = props[kCGImagePropertyPixelHeight] as? Int
      location = props[kCGImagePropertyGPSDictionary] != nil
    }
    return StagedFile(
      id: url.path, name: url.lastPathComponent, kind: kind, bytes: Int64(size), width: width, height: height,
      hasLocation: location)
  }

  /// Prepares one tray file's bytes for the wire, or nil when they cannot
  /// be read as what they claim to be.
  static func prepare(_ file: StagedFile, bytes: Data) -> PreparedAttachment? {
    guard file.isImage else {
      guard let mime = sniff(bytes) else { return nil }
      return PreparedAttachment(name: file.wireName, mime: mime, bytes: bytes)
    }
    // HEIC leaves as JPEG; any other image keeps its own type.
    let type: String
    let mime: String
    if file.isHEIC {
      type = "public.jpeg"
      mime = "image/jpeg"
    } else {
      guard let sniffed = sniff(bytes), sniffed.hasPrefix("image/") else { return nil }
      guard let source = CGImageSourceCreateWithData(bytes as CFData, nil), let uti = CGImageSourceGetType(source) else {
        return nil
      }
      type = uti as String
      mime = sniffed
    }
    guard let out = reencodeWithoutLocation(bytes, as: type, quality: file.isHEIC ? 0.9 : nil) else { return nil }
    return PreparedAttachment(name: file.wireName, mime: mime, bytes: out)
  }

  /// Decodes the first image and writes it again with its own properties,
  /// less the location dictionary. Orientation, date and size are kept.
  static func reencodeWithoutLocation(_ data: Data, as type: String, quality: Double?) -> Data? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else { return nil }
    var props = (CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]) ?? [:]
    props.removeValue(forKey: kCGImagePropertyGPSDictionary)
    if let quality { props[kCGImageDestinationLossyCompressionQuality] = quality }
    let out = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(out, type as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(destination, image, props as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { return nil }
    return out as Data
  }
}

@MainActor
@Observable
final class AttachmentSender {
  /// What happened, in order: the record the caption-after-file rule is
  /// checked against.
  enum Step: Equatable, Sendable {
    case prepared(name: String)
    case staged(stageId: String)
    /// The daemon said the file was sent and verified by its transfer name.
    case fileSent(stageId: String)
    case caption
  }

  /// Read from settings by the shell; off until it has been read.
  var isOn = false
  private(set) var journal: [Step] = []
  /// The tray's line: waiting, confirmed, not confirmed, or why not.
  private(set) var line: String?
  /// True when the line is the outlined "not confirmed" (D-UI-225).
  private(set) var outlined = false
  private(set) var busy = false

  private let port: any AttachmentSending
  private let killSwitch: @MainActor () -> Bool?
  private let read: @MainActor (StagedFile) throws -> Data
  private let caption: @MainActor (_ chatGuid: String, _ handle: String, _ body: String) -> Outbound.Refusal?
  private let now: () -> Date
  private var task: Task<Void, Never>?

  /// - Parameters:
  ///   - read: the file's bytes as picked (the tray's id is its path).
  ///   - caption: the typed words, handed to Outbound after the files.
  init(
    port: any AttachmentSending, killSwitch: @escaping @MainActor () -> Bool?,
    read: @escaping @MainActor (StagedFile) throws -> Data = { try Data(contentsOf: URL(fileURLWithPath: $0.id)) },
    caption: @escaping @MainActor (_ chatGuid: String, _ handle: String, _ body: String) -> Outbound.Refusal?,
    now: @escaping () -> Date = { Date() }
  ) {
    self.port = port
    self.killSwitch = killSwitch
    self.read = read
    self.caption = caption
    self.now = now
  }

  /// The tray's sink: off prints D-UI-224 and touches nothing; on starts
  /// the send and returns the waiting line.
  func start(_ set: OutboundAttachments, chatGuid: String, handle: String) -> String {
    guard isOn else {
      line = ProvisionalUI.attachmentsOff
      outlined = false
      return ProvisionalUI.attachmentsOff
    }
    guard !busy else { return line ?? ProvisionalUI.attachmentWaiting }
    busy = true
    line = ProvisionalUI.attachmentWaiting
    outlined = false
    task = Task { [weak self] in
      guard let self else { return }
      _ = await self.deliver(set, chatGuid: chatGuid, handle: handle)
    }
    return ProvisionalUI.attachmentWaiting
  }

  /// Each file in tray order, then the caption. Returns the final line.
  @discardableResult
  func deliver(_ set: OutboundAttachments, chatGuid: String, handle: String) async -> String {
    defer { busy = false }
    for file in set.files {
      let bytes: Data
      do { bytes = try read(file) } catch { return finish(ProvisionalUI.attachmentNotSent("could not read " + file.name)) }
      guard let prepared = AttachmentPrep.prepare(file, bytes: bytes) else {
        return finish(ProvisionalUI.attachmentNotSent("not a type Messages takes"))
      }
      journal.append(.prepared(name: prepared.name))
      let staged: StagedAttachment
      do {
        staged = try await port.stageAttachment(name: prepared.name, mime: prepared.mime, bytes: prepared.bytes)
      } catch {
        return finish(Self.words(for: error))
      }
      journal.append(.staged(stageId: staged.stageId))
      // The kill switch at the minute the file would go.
      guard killSwitch() == false else { return finish(ProvisionalUI.attachmentNotSent("kill switch on")) }
      let result: SendResult
      do {
        result = try await port.sendFile(to: handle, stageId: staged.stageId)
      } catch {
        return finish(Self.words(for: error))
      }
      guard result.outcome == "sent" else {
        if result.error?.code == "unverified" { return finish(ProvisionalUI.attachmentUnconfirmed, outlined: true) }
        return finish(ProvisionalUI.attachmentNotSent(result.error?.code ?? result.outcome))
      }
      journal.append(.fileSent(stageId: staged.stageId))
    }
    // Every file is verified: only now do the words go.
    let words = set.caption.trimmingCharacters(in: .whitespacesAndNewlines)
    if !words.isEmpty {
      if let refused = caption(chatGuid, handle, set.caption) {
        return finish(ProvisionalUI.attachmentNotSent("caption " + String(describing: refused)))
      }
      journal.append(.caption)
    }
    return finish(ProvisionalUI.attachmentConfirmed(at: now()))
  }

  private func finish(_ words: String, outlined: Bool = false) -> String {
    line = words
    self.outlined = outlined
    return words
  }

  /// A refusal in words: off (409), too large (413), wrong type (415).
  static func words(for error: any Error) -> String {
    guard let error = error as? GatewayError else { return ProvisionalUI.attachmentNotSent("daemon unreachable") }
    if case .conflict(let code, _, _)? = error.refusal {
      return code == "attachments-unproven" ? ProvisionalUI.attachmentsOff : ProvisionalUI.attachmentNotSent(code)
    }
    if case .request(_, let body) = error, let code = body["error"]?.stringValue {
      return ProvisionalUI.attachmentNotSent(code)
    }
    return ProvisionalUI.attachmentNotSent("daemon refused")
  }
}
