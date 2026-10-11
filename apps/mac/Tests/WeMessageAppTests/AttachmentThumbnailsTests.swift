import Foundation
import Testing
import WeMessageKit

@testable import WeMessageApp

/// v2 F6c: transcript thumbnails over a fake fetcher. Every image here is
/// a grey PNG written byte by byte in the test (KitHygiene holds this
/// bundle to Foundation and Testing, so no image framework draws one);
/// nothing reads a file.
@MainActor
@Suite("AttachmentThumbnails (v2 F6c)")
struct AttachmentThumbnailsTests {
  /// Counts every fetch and answers from `answer`.
  final class FakeFetcher: AttachmentFetching, @unchecked Sendable {
    private let lock = NSLock()
    private var asked: [String] = []
    let answer: @Sendable (String) throws -> AttachmentBytes

    init(_ answer: @escaping @Sendable (String) throws -> AttachmentBytes) { self.answer = answer }

    var ids: [String] { lock.withLock { asked } }

    func attachmentBytes(_ id: String, range: ClosedRange<Int>?) async throws -> AttachmentBytes {
      lock.withLock { asked.append(id) }
      return try answer(id)
    }
  }

  private static let crcTable: [UInt32] = (0..<256).map { n in
    var c = UInt32(n)
    for _ in 0..<8 { c = c & 1 == 1 ? 0xEDB8_8320 ^ (c >> 1) : c >> 1 }
    return c
  }

  private static func crc32(_ bytes: [UInt8]) -> UInt32 {
    var c: UInt32 = 0xFFFF_FFFF
    for b in bytes { c = crcTable[Int((c ^ UInt32(b)) & 0xFF)] ^ (c >> 8) }
    return c ^ 0xFFFF_FFFF
  }

  private static func be32(_ v: UInt32) -> [UInt8] { [UInt8(v >> 24), UInt8(v >> 16 & 0xFF), UInt8(v >> 8 & 0xFF), UInt8(v & 0xFF)] }

  private static func chunk(_ type: String, _ data: [UInt8]) -> [UInt8] {
    let typed = Array(type.utf8) + data
    return be32(UInt32(data.count)) + typed + be32(crc32(typed))
  }

  /// A `w` x `h` 8-bit grey PNG, its zlib stream in stored (uncompressed)
  /// blocks: valid, decodable, and made of nothing but arithmetic.
  static func encoded(_ w: Int, _ h: Int, grey: UInt8 = 128) -> (data: Data, mime: String) {
    var raw: [UInt8] = []
    raw.reserveCapacity((w + 1) * h)
    for _ in 0..<h {
      raw.append(0)
      raw.append(contentsOf: repeatElement(grey, count: w))
    }
    var z: [UInt8] = [0x78, 0x01]
    var at = 0
    repeat {
      let n = min(65_535, raw.count - at)
      let last: UInt8 = at + n == raw.count ? 1 : 0
      z += [last, UInt8(n & 0xFF), UInt8(n >> 8), UInt8(~n & 0xFF), UInt8((~n >> 8) & 0xFF)]
      z += raw[at..<at + n]
      at += n
    } while at < raw.count
    var a: UInt32 = 1
    var b: UInt32 = 0
    for byte in raw {
      a = (a + UInt32(byte)) % 65_521
      b = (b + a) % 65_521
    }
    z += be32(b << 16 | a)
    let ihdr = be32(UInt32(w)) + be32(UInt32(h)) + [8, 0, 0, 0, 0]
    let png: [UInt8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
      + chunk("IHDR", ihdr) + chunk("IDAT", z) + chunk("IEND", [])
    return (Data(png), "image/png")
  }

  static func file(_ id: String?, mime: String? = "image/heic", bytes: Int? = 1_000) -> MessageTurn.Attachment {
    MessageTurn.Attachment(name: "IMG.heic", mime: mime, uti: nil, bytes: bytes, id: id)
  }

  @Test("imageThumbnails: a 1200 x 900 image comes back at most 256 px, fetched once")
  func imageThumbnails() async throws {
    let (data, mime) = Self.encoded(1200, 900)
    let fetcher = FakeFetcher { _ in AttachmentBytes(data: data, mime: mime, etag: nil, total: data.count) }
    let thumbs = AttachmentThumbnails(client: fetcher)
    let state = await thumbs.thumbnail(for: Self.file("AT-1", bytes: data.count))
    guard case .image(let image) = state else {
      Issue.record("not an image: \(state)")
      return
    }
    #expect(max(image.width, image.height) == AttachmentThumbnails.pixelSize)
    #expect(image.width == 256 && image.height == 192)
    // Drawn again: the memory cache answers.
    _ = await thumbs.thumbnail(for: Self.file("AT-1", bytes: data.count))
    #expect(fetcher.ids == ["AT-1"])
  }

  @Test("overCapIsTooLarge: over 25 MB, or of no stated size, is never fetched")
  func overCapIsTooLarge() async throws {
    let fetcher = FakeFetcher { _ in throw AttachmentFailure.unknownAttachment }
    let thumbs = AttachmentThumbnails(client: fetcher)
    #expect(await thumbs.thumbnail(for: Self.file("AT-BIG", bytes: 25_000_001)) == .tooLarge)
    #expect(await thumbs.thumbnail(for: Self.file("AT-NOSIZE", bytes: nil)) == .tooLarge)
    #expect(thumbs.fetches(Self.file("AT-EDGE", bytes: 25_000_000)))
    #expect(!thumbs.fetches(Self.file("AT-BIG", bytes: 25_000_001)))
    // Not an image, or no id: nothing to fetch either.
    #expect(await thumbs.thumbnail(for: Self.file("AT-PDF", mime: "application/pdf")) == .notImage)
    #expect(await thumbs.thumbnail(for: Self.file(nil)) == .notImage)
    #expect(fetcher.ids.isEmpty, "fetched: \(fetcher.ids)")
  }

  @Test("missingMapsReason: each refusal is its state, asked once; an unanswered fetch asks again")
  func missingMapsReason() async throws {
    for failure in AttachmentFailure.allCases {
      let fetcher = FakeFetcher { _ in throw failure }
      let thumbs = AttachmentThumbnails(client: fetcher)
      #expect(await thumbs.thumbnail(for: Self.file("AT-1")) == .missing(failure))
      #expect(await thumbs.thumbnail(for: Self.file("AT-1")) == .missing(failure))
      #expect(fetcher.ids.count == 1, "\(failure): no retry loop")
    }
    let down = FakeFetcher { _ in throw GatewayError.transport(URLError(.cannotConnectToHost)) }
    let thumbs = AttachmentThumbnails(client: down)
    #expect(await thumbs.thumbnail(for: Self.file("AT-1")) == .unreachable)
    #expect(await thumbs.thumbnail(for: Self.file("AT-1")) == .unreachable)
    #expect(down.ids.count == 2)
    // Bytes that are not an image, whatever the turn said.
    let html = FakeFetcher { _ in AttachmentBytes(data: Data("<html>".utf8), mime: "image/png", etag: nil, total: 6) }
    #expect(await AttachmentThumbnails(client: html).thumbnail(for: Self.file("AT-2")) == .notImage)
  }

  @Test("cacheIsMemoryOnly: the client's session caches nothing on disk, the bytes request skips the cache, and the thumbnailer writes nothing")
  func cacheIsMemoryOnly() throws {
    // The kit's session is ephemeral: its URL cache, if any, has no disk.
    #expect((URLSessionTransport().session.configuration.urlCache?.diskCapacity ?? 0) == 0)
    let request = try Endpoint.attachmentBytes(id: "AT-1", range: nil)
      .urlRequest(baseURL: URL(string: "http://127.0.0.1:47100")!, token: nil)
    #expect(request.cachePolicy == .reloadIgnoringLocalCacheData)
    let source = try Repo.text("apps/mac/Sources/WeMessageApp/Models/AttachmentThumbnails.swift")
    for banned in ["FileManager", "write(to", "URLCache", "UserDefaults", "temporaryDirectory"] {
      #expect(!source.contains(banned), "the thumbnailer names \(banned)")
    }
  }

  @Test("sixtyTiles: 60 visible tiles thumbnail, each fetched once, from the cache on the next draw")
  func sixtyTiles() async throws {
    let (data, mime) = Self.encoded(1200, 900)
    let fetcher = FakeFetcher { _ in AttachmentBytes(data: data, mime: mime, etag: nil, total: data.count) }
    let thumbs = AttachmentThumbnails(client: fetcher)
    for round in 0..<2 {
      await withTaskGroup(of: ThumbState.self) { group in
        for i in 0..<60 {
          let file = Self.file("AT-\(i)", mime: "image/png", bytes: data.count)
          group.addTask { await thumbs.thumbnail(for: file) }
        }
        for await state in group {
          if case .image = state {} else { Issue.record("round \(round): \(state)") }
        }
      }
    }
    #expect(fetcher.ids.count == 60)
  }
  @Test("the viewer's Save keeps the last path part, never overwrites, and falls back to the id")
  func saveNamesSafely() throws {
    #expect(AttachmentViewer.safeName("../../etc/passwd", id: "AT-1") == "passwd")
    #expect(AttachmentViewer.safeName(".hidden", id: "AT-1") == "hidden")
    #expect(AttachmentViewer.safeName(nil, id: "AT-1") == "AT-1")
    #expect(AttachmentViewer.safeName("..", id: "AT-1") == "AT-1")
    let folder = FileManager.default.temporaryDirectory
      .appendingPathComponent("wm-f6c-save-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let one = try AttachmentViewer.saveCopy(Data([1]), name: "grey.png", id: "AT-1", into: folder)
    let two = try AttachmentViewer.saveCopy(Data([2]), name: "grey.png", id: "AT-1", into: folder)
    #expect(one.lastPathComponent == "grey.png")
    #expect(two.lastPathComponent == "grey 2.png")
    #expect(try Data(contentsOf: one) == Data([1]))
    #expect(two.deletingLastPathComponent().standardizedFileURL == folder.standardizedFileURL)
  }

  @Test("a tile says what it is in words: name and size, Open to load, iCloud, FDA, or why")
  func tileWords() {
    let png = Self.file("AT-1", mime: "image/png", bytes: 2_400_000)
    let named = SpecimenText.mediaTile(png)
    #expect(ThumbTile.words(png, state: nil) == named)
    #expect(ThumbTile.words(png, state: .tooLarge) == named + " \u{00B7} " + ProvisionalUI.thumbnailOpenToLoad)
    #expect(ThumbTile.words(png, state: .missing(.notOnThisMac)) == ProvisionalUI.thumbnailNotOnThisMac)
    #expect(ThumbTile.words(png, state: .missing(.sourceUnavailable)) == ProvisionalUI.thumbnailUnreadable)
    #expect(ThumbTile.words(png, state: .missing(.changed)).hasSuffix("the file changed"))
    #expect(ThumbTile.words(png, state: .unreachable).hasSuffix("the daemon did not answer"))
    let movie = Self.file("AT-2", mime: "video/quicktime", bytes: 9_000)
    #expect(ThumbTile.words(movie, state: nil).hasSuffix(ProvisionalUI.viewerSaveToPlay))
  }
}

/// The decode budget, off the main actor. Timing the whole path inside a
/// @MainActor suite times swift-testing's other main-actor suites too (7.3
/// s in the full run, 24 ms alone), so this row times what a tile costs:
/// ImageIO's 256 px thumbnail of a 1200 x 900 image, 60 of them in a row.
@Suite("AttachmentThumbnails perf (v2 F6c)")
struct AttachmentThumbnailsPerfTests {
  @Test("perf: 60 tiles decode in 400 ms or less, one after another, off the main actor")
  func sixtyDecodes() async throws {
    let (data, _) = await AttachmentThumbnailsTests.encoded(1200, 900)
    let took = await Task.detached(priority: .userInitiated) {
      ContinuousClock().measure {
        for _ in 0..<60 {
          let image = AttachmentThumbnails.thumbnail(data)
          precondition(image?.width == 256)
        }
      }
    }.value
    let ms = Double(took.components.attoseconds) / 1e15 + Double(took.components.seconds) * 1000
    print("[perf] F6c 60 tile decodes \(String(format: "%.1f", ms)) ms (<= 400)")
    #expect(ms <= 400)
  }
}
