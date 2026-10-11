import AppKit
import Foundation
import WeMessageKit

// v2 F6c (D-UI-219, D-F6-6, D-F6-8): transcript thumbnails. A tile asks
// when it is drawn; a file over the cap, or of a size the source did not
// say, is never fetched. Bytes go through GatewayClient (the bearer, no
// URL cache) and are thumbnailed with ImageIO at 256 px; only the
// thumbnail is kept, in memory, in an NSCache. A refusal is remembered
// for the session, so a file in iCloud is asked once, never in a loop.

/// What a thumbnailer reads bytes through: GatewayClient in the app, a
/// fake in tests.
protocol AttachmentFetching: Sendable {
  func attachmentBytes(_ id: String, range: ClosedRange<Int>?) async throws -> AttachmentBytes
}

extension GatewayClient: AttachmentFetching {}

/// What one transcript tile draws.
enum ThumbState: Equatable {
  /// A 256 px thumbnail of the file's bytes.
  case image(CGImage)
  /// Over the cap, or a size the source did not say: never fetched (the
  /// tile says so, D-UI-219).
  case tooLarge
  /// The daemon could not serve it, and said why.
  case missing(AttachmentFailure)
  /// Nothing to thumbnail: not an image, no id, or bytes ImageIO cannot
  /// read. The D-UI-201 tile stays.
  case notImage
  /// The daemon did not answer. Not remembered: the next draw asks again.
  case unreachable
}

@MainActor
final class AttachmentThumbnails {
  nonisolated static let pixelSize = 256

  let maxBytes: Int
  private let client: any AttachmentFetching
  private let images = NSCache<NSString, Entry>()
  private var refused: [String: AttachmentFailure] = [:]
  private var inFlight: [String: Task<ThumbState, Never>] = [:]

  /// NSCache holds a class, so a thumbnail rides in this box.
  private final class Entry {
    let image: CGImage
    init(_ image: CGImage) { self.image = image }
  }

  init(client: any AttachmentFetching, maxBytes: Int = 25_000_000, cacheCost: Int = 64 << 20) {
    self.client = client
    self.maxBytes = maxBytes
    images.totalCostLimit = cacheCost
  }

  /// True when a tile would ask the daemon for this file at all.
  func fetches(_ file: MessageTurn.Attachment) -> Bool {
    guard file.id != nil, (file.mime ?? "").hasPrefix("image/") else { return false }
    guard let bytes = file.bytes else { return false }
    return bytes <= maxBytes
  }

  func thumbnail(for file: MessageTurn.Attachment) async -> ThumbState {
    guard let id = file.id, (file.mime ?? "").hasPrefix("image/") else { return .notImage }
    guard fetches(file) else { return .tooLarge }
    if let hit = images.object(forKey: id as NSString) { return .image(hit.image) }
    if let failure = refused[id] { return .missing(failure) }
    if let running = inFlight[id] { return await running.value }
    let client = self.client
    let cap = maxBytes
    let task = Task<ThumbState, Never> {
      do {
        let got = try await client.attachmentBytes(id, range: nil)
        guard got.data.count <= cap else { return .tooLarge }
        guard got.mime.hasPrefix("image/") else { return .notImage }
        let data = got.data
        let image = await Task.detached(priority: .userInitiated) { Self.thumbnail(data) }.value
        return image.map(ThumbState.image) ?? .notImage
      } catch let failure as AttachmentFailure {
        return .missing(failure)
      } catch {
        return .unreachable
      }
    }
    inFlight[id] = task
    let state = await task.value
    inFlight[id] = nil
    switch state {
    case .image(let image): images.setObject(Entry(image), forKey: id as NSString, cost: image.bytesPerRow * image.height)
    case .missing(let failure): refused[id] = failure
    default: break
    }
    return state
  }

  /// The whole file, for the viewer (D-UI-222). Never cached.
  func full(_ id: String) async throws -> AttachmentBytes {
    try await client.attachmentBytes(id, range: nil)
  }

  /// A 256 px thumbnail of `data`, its orientation applied; nil for bytes
  /// ImageIO cannot read.
  nonisolated static func thumbnail(_ data: Data) -> CGImage? {
    guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary)
    else { return nil }
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: pixelSize,
    ]
    return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
  }
}
