import AppKit
import Foundation
import Observation
import WeMessageKit

/// The resolved avatars, least recently used out first, keyed by the
/// normalised handle (AvatarKey). A miss asks the provider once; "no photo"
/// is cached as well as a photo. Without access every key resolves to
/// initials and nothing is cached or fetched. Contacts is asked for only
/// from userActed(), only while undetermined, and never twice.
actor AvatarCache {
  static let capacity = 512

  private struct Entry {
    var photo: Data?
    var used: UInt64
  }

  private let provider: any AvatarProvider
  private let capacity: Int
  private var entries: [String: Entry] = [:]
  private var tick: UInt64 = 0
  private var asked = false

  init(provider: any AvatarProvider, capacity: Int = AvatarCache.capacity) {
    self.provider = provider
    self.capacity = max(1, capacity)
  }

  var count: Int { entries.count }

  func resolve(_ key: String) async -> AvatarResolution {
    guard await provider.access() == .authorized else { return .initials }
    tick += 1
    if var entry = entries[key] {
      entry.used = tick
      entries[key] = entry
      return entry.photo.map(AvatarResolution.photo) ?? .initials
    }
    let photo = await provider.photo(for: key)
    tick += 1
    entries[key] = Entry(photo: photo, used: tick)
    while entries.count > capacity, let oldest = entries.min(by: { $0.value.used < $1.value.used })?.key {
      entries.removeValue(forKey: oldest)
    }
    return photo.map(AvatarResolution.photo) ?? .initials
  }

  /// The user did something in the window (D-UI-54: opened a thread). The
  /// first call while access is undetermined asks the system; every later
  /// call, and every call made while the first is still asking, only reads.
  @discardableResult
  func userActed() async -> ContactAccess {
    guard !asked else { return await provider.access() }
    asked = true
    let access = await provider.access()
    guard access == .notDetermined else { return access }
    return await provider.requestAccess()
  }
}

/// The window's view of the cache: the photos for the listed threads,
/// decoded once, read by the list rows, the thread head and the inspector.
@MainActor
@Observable
final class AvatarBook {
  enum Look: Equatable, Sendable {
    case photo, initials
  }

  @ObservationIgnored private let cache: AvatarCache
  private(set) var images: [String: NSImage] = [:]

  init(provider: any AvatarProvider) {
    cache = AvatarCache(provider: provider)
  }

  /// A book that draws initials for everyone and never reaches Contacts.
  static func initialsOnly() -> AvatarBook { AvatarBook(provider: InitialsOnlyAvatars()) }

  func image(for thread: ThreadSummary) -> NSImage? { images[AvatarKey.of(thread)] }

  func look(for thread: ThreadSummary) -> Look { image(for: thread) == nil ? .initials : .photo }

  /// Resolves every listed thread and keeps only their photos.
  func prefetch(_ threads: [ThreadSummary]) async {
    var next: [String: NSImage] = [:]
    for thread in threads {
      if Task.isCancelled { return }
      let key = AvatarKey.of(thread)
      if case .photo(let data) = await cache.resolve(key), let image = images[key] ?? NSImage(data: data) {
        next[key] = image
      }
    }
    images = next
  }

  /// A user act: may ask for Contacts once, then resolves again.
  func userActed(_ threads: [ThreadSummary]) async {
    if await cache.userActed() == .authorized { await prefetch(threads) }
  }
}
