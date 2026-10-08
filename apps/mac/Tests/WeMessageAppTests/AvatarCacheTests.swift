import Foundation
import Testing
import WeMessageKit

@testable import WeMessageApp

/// A provider with scripted access and photos that counts every ask.
actor ScriptedAvatars: AvatarProvider {
  var current: ContactAccess
  /// What the system answers when asked.
  let answer: ContactAccess
  let photos: [String: Data]
  private(set) var prompts = 0
  private(set) var fetched: [String] = []

  init(access: ContactAccess, answer: ContactAccess = .authorized, photos: [String: Data] = [:]) {
    self.current = access
    self.answer = answer
    self.photos = photos
  }

  func access() async -> ContactAccess { current }

  func requestAccess() async -> ContactAccess {
    prompts += 1
    current = answer
    return current
  }

  func photo(for key: String) async -> Data? {
    fetched.append(key)
    return photos[key]
  }
}

/// The ContactFetching seam with no system behind it.
final class ScriptedFetching: ContactFetching, @unchecked Sendable {
  private let lock = NSLock()
  private var _status: ContactAccess
  private var _calls: [String] = []
  let byPhone: [String: Data]
  let byEmail: [String: Data]

  init(status: ContactAccess, byPhone: [String: Data] = [:], byEmail: [String: Data] = [:]) {
    _status = status
    self.byPhone = byPhone
    self.byEmail = byEmail
  }

  var calls: [String] { lock.withLock { _calls } }
  private func log(_ s: String) { lock.withLock { _calls.append(s) } }

  func authorization() -> ContactAccess { lock.withLock { _status } }

  func requestAccess() async -> Bool {
    log("request")
    lock.withLock { _status = .authorized }
    return true
  }

  func thumbnail(phone: String) -> Data? {
    log("phone " + phone)
    return byPhone[phone]
  }

  func thumbnail(email: String) -> Data? {
    log("email " + email)
    return byEmail[email]
  }
}

/// S4g: the avatar cache (an LRU of 512 keyed by the normalised handle),
/// Contacts access asked for only on a user act and never twice, and the
/// fixture photos the UI tests draw.
@Suite("AvatarCache")
struct AvatarCacheTests {
  static let png = Data([0x89, 0x50, 0x4E, 0x47])

  @Test("AC1: an LRU: a hit is not fetched again, the least recently used key is the one evicted, and 512 is the default")
  func lru() async {
    let provider = ScriptedAvatars(access: .authorized, photos: ["a": Self.png])
    let cache = AvatarCache(provider: provider, capacity: 3)
    _ = await cache.resolve("a")
    _ = await cache.resolve("b")
    _ = await cache.resolve("c")
    #expect(await cache.resolve("a") == .photo(Self.png))  // a is now the most recent
    _ = await cache.resolve("d")  // evicts b
    #expect(await cache.count == 3)
    #expect(await provider.fetched == ["a", "b", "c", "d"])
    _ = await cache.resolve("a")
    _ = await cache.resolve("c")
    #expect(await provider.fetched == ["a", "b", "c", "d"], "a hit was fetched again")
    _ = await cache.resolve("b")
    #expect(await provider.fetched == ["a", "b", "c", "d", "b"], "b was not the one evicted")
    #expect(AvatarCache.capacity == 512)
    let big = AvatarCache(provider: provider)
    for i in 0..<600 { _ = await big.resolve("k\(i)") }
    #expect(await big.count == 512)
  }

  @Test("AC2: denied and restricted resolve to initials, fetch nothing and never prompt, however often the user acts")
  func deniedIsInitials() async {
    for access in [ContactAccess.denied, .restricted] {
      let provider = ScriptedAvatars(access: access, photos: ["+15550100001": Self.png])
      let cache = AvatarCache(provider: provider)
      #expect(await cache.resolve("+15550100001") == .initials)
      #expect(await cache.userActed() == access)
      #expect(await cache.userActed() == access)
      #expect(await cache.resolve("+15550100001") == .initials)
      #expect(await provider.prompts == 0, "\(access) prompted")
      #expect(await provider.fetched.isEmpty, "\(access) fetched")
      #expect(await cache.count == 0)
    }
  }

  @Test("AC3: never prompts twice: before a user act nothing asks; the first act asks once; later and concurrent acts do not")
  func neverPromptsTwice() async {
    let provider = ScriptedAvatars(access: .notDetermined, answer: .authorized, photos: ["+15550100001": Self.png])
    let cache = AvatarCache(provider: provider)
    #expect(await cache.resolve("+15550100001") == .initials)
    #expect(await provider.prompts == 0, "resolving prompted")
    async let first = cache.userActed()
    async let second = cache.userActed()
    _ = await (first, second)
    _ = await cache.userActed()
    #expect(await provider.prompts == 1)
    #expect(await cache.resolve("+15550100001") == .photo(Self.png))

    // Said no: still once, and initials from then on.
    let refused = ScriptedAvatars(access: .notDetermined, answer: .denied, photos: ["+15550100001": Self.png])
    let other = AvatarCache(provider: refused)
    #expect(await other.userActed() == .denied)
    #expect(await other.userActed() == .denied)
    #expect(await refused.prompts == 1)
    #expect(await other.resolve("+15550100001") == .initials)
  }

  @Test("AC4: ContactsAvatarProvider reads the seam: phone keys by number, addresses by email, groups not at all")
  @MainActor
  func contactsSeam() async {
    let fetching = ScriptedFetching(
      status: .notDetermined, byPhone: ["+15550100001": Self.png], byEmail: ["sam.whitfield@example.com": Self.png])
    let provider = ContactsAvatarProvider(fetching: fetching)
    #expect(await provider.access() == .notDetermined)
    #expect(fetching.calls.isEmpty, "reading access asked")
    #expect(await provider.requestAccess() == .authorized)
    #expect(await provider.photo(for: "+15550100001") == Self.png)
    #expect(await provider.photo(for: "sam.whitfield@example.com") == Self.png)
    #expect(await provider.photo(for: "group:iMessage;+;chat5550100103") == nil)
    #expect(fetching.calls == ["request", "phone +15550100001", "email sam.whitfield@example.com"])
  }

  /// The rich scenario's thread list.
  static func richThreads() throws -> [ThreadSummary] {
    try JSONDecoder().decode(ThreadsPage.self, from: Reply.scenario("rich", "threads.list.json").body).threads
  }

  static let photographed = ["+15550100001", "+15550100004", "sam.whitfield@example.com"]

  @Test("AC5: the fixture provider gives Maya, Priya and Sam photos and every other rich thread initials")
  @MainActor
  func fixtureSplit() async throws {
    let threads = try Self.richThreads()
    #expect(threads.count == 8)
    let book = AvatarBook(provider: FixtureAvatarProvider())
    await book.prefetch(threads)
    var looks: [String: AvatarBook.Look] = [:]
    for thread in threads { looks[AvatarKey.of(thread)] = book.look(for: thread) }
    #expect(looks.filter { $0.value == .photo }.keys.sorted() == Self.photographed.sorted())
    #expect(looks.values.filter { $0 == .initials }.count == 5)
    #expect(book.image(for: threads.first { $0.title == "Maya Okafor" }!) != nil)
  }

  @Test("AC6: the fixture PNGs are tiny 72x72 RGB images with no green pixel, decoded with Foundation alone")
  func fixturePixels() async throws {
    var seen = Set<Data>()
    for key in Self.photographed {
      let data = try #require(await FixtureAvatarProvider().photo(for: key), "no fixture photo for \(key)")
      #expect(data.count < 2048, "\(key): \(data.count) bytes")
      seen.insert(data)
      let image = try #require(TinyPNG.decode(data), "\(key) does not decode")
      #expect(image.width == 72 && image.height == 72)
      var green = 0
      var tinted = 0
      for rgb in image.pixels {
        if AvatarPaletteTests.hasGreenHue(rgb) && rgb.saturation > 0.10 { green += 1 }
        if rgb.saturation > 0.10 { tinted += 1 }
      }
      #expect(green == 0, "\(key): \(green) green pixels")
      #expect(tinted > 72 * 72 / 2, "\(key) is mostly grey")
    }
    #expect(seen.count == 3, "two fixtures share an image")
    #expect(await FixtureAvatarProvider().photo(for: "+15550100002") == nil)
    #expect(await FixtureAvatarProvider().access() == .authorized)
  }

  @Test("AC7: the shell never asks on its own: a refresh resolves without a prompt, and opening threads asks once")
  @MainActor
  func shellAsksOnUserAct() async throws {
    let provider = ScriptedAvatars(access: .notDetermined, answer: .denied)
    let m = ShellModel(
      client: testClient(try ShellModelTests.scenarioTransport("rich")), avatars: AvatarBook(provider: provider))
    await m.refresh()
    await m.avatarTask?.value
    #expect(m.threads?.threads.count == 8)
    #expect(await provider.prompts == 0, "a refresh prompted")
    let threads = try Self.richThreads()
    m.open(threads[0].chatGuid)
    await m.avatarTask?.value
    m.open(threads[1].chatGuid)
    await m.avatarTask?.value
    #expect(m.selectedThread == threads[1].chatGuid)
    #expect(await provider.prompts == 1)
    // A model built without a provider never reaches Contacts at all.
    let plain = ShellModel(client: testClient(try ShellModelTests.scenarioTransport("rich")))
    await plain.refresh()
    await plain.avatarTask?.value
    #expect(threads.allSatisfy { plain.avatars.look(for: $0) == .initials })
  }
}

/// A PNG reader for 8-bit RGB, non-interlaced: enough to sweep the fixture
/// pixels without an image framework (the test target imports Foundation).
enum TinyPNG {
  struct Image {
    let width: Int
    let height: Int
    let pixels: [Tokens.RGB]
  }

  static func decode(_ data: Data) -> Image? {
    let bytes = [UInt8](data)
    guard bytes.count > 8, bytes[0..<8].elementsEqual([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) else { return nil }
    func be32(_ at: Int) -> Int { bytes[at..<at + 4].reduce(0) { $0 << 8 | Int($1) } }
    var at = 8
    var width = 0
    var height = 0
    var idat = [UInt8]()
    while at + 8 <= bytes.count {
      let length = be32(at)
      let type = String(decoding: bytes[at + 4..<at + 8], as: UTF8.self)
      let body = Array(bytes[at + 8..<at + 8 + length])
      if type == "IHDR" {
        width = be32(at + 8)
        height = be32(at + 12)
        // Bit depth 8, colour type 2, no interlace.
        guard body[8] == 8, body[9] == 2, body[12] == 0 else { return nil }
      } else if type == "IDAT" {
        idat += body
      }
      at += 12 + length
    }
    // zlib: drop the two-byte header and the Adler-32 trailer; NSData's zlib
    // is raw DEFLATE.
    guard idat.count > 6,
      let raw = try? (Data(idat[2..<idat.count - 4]) as NSData).decompressed(using: .zlib) as Data
    else { return nil }
    let stride = width * 3
    let rows = [UInt8](raw)
    guard rows.count == height * (stride + 1) else { return nil }
    var out = [UInt8](repeating: 0, count: height * stride)
    for y in 0..<height {
      let filter = rows[y * (stride + 1)]
      for x in 0..<stride {
        let byte = Int(rows[y * (stride + 1) + 1 + x])
        let a = x >= 3 ? Int(out[y * stride + x - 3]) : 0
        let b = y > 0 ? Int(out[(y - 1) * stride + x]) : 0
        let c = x >= 3 && y > 0 ? Int(out[(y - 1) * stride + x - 3]) : 0
        let predicted: Int
        switch filter {
        case 0: predicted = 0
        case 1: predicted = a
        case 2: predicted = b
        case 3: predicted = (a + b) / 2
        case 4:
          let p = a + b - c
          let (pa, pb, pc) = (abs(p - a), abs(p - b), abs(p - c))
          predicted = pa <= pb && pa <= pc ? a : (pb <= pc ? b : c)
        default: return nil
        }
        out[y * stride + x] = UInt8((byte + predicted) & 0xFF)
      }
    }
    let pixels = (0..<width * height).map { i in Tokens.RGB(out[i * 3], out[i * 3 + 1], out[i * 3 + 2]) }
    return Image(width: width, height: height, pixels: pixels)
  }
}
