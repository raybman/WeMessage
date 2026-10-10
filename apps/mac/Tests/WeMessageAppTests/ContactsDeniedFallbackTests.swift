import Foundation
import Testing
import WeMessageKit

@testable import WeMessageApp

/// v2 S5e: what a user who says no to Contacts sees. The real provider
/// (ContactsAvatarProvider) is driven through the ContactFetching seam, so no
/// Contacts database is read and no system contacts store is built. Denied
/// and restricted must give every thread the D-UI-10 fallback face: never a
/// photo, never an empty face, never an error, and never a prompt.
@Suite("ContactsDeniedFallback")
struct ContactsDeniedFallbackTests {
  @Test("AvatarProvider denied state produces fallback, not nil")
  @MainActor
  func deniedProducesFallback() async throws {
    let threads = try AvatarCacheTests.richThreads()
    #expect(threads.count == 8)
    for access in [ContactAccess.denied, .restricted] {
      // The seam holds a photo for every photographed key: a provider that
      // ignored the refusal would find them.
      var photos: [String: Data] = [:]
      for key in AvatarCacheTests.photographed { photos[key] = AvatarCacheTests.png }
      let fetching = ScriptedFetching(status: access, byPhone: photos, byEmail: photos)
      let provider = ContactsAvatarProvider(fetching: fetching)
      #expect(await provider.access() == access)

      // The cache: initials for every key, before and after the user acts.
      let cache = AvatarCache(provider: provider)
      for thread in threads {
        #expect(await cache.resolve(AvatarKey.of(thread)) == .initials, "\(access): \(thread.title)")
      }
      #expect(await cache.userActed() == access)
      for key in AvatarCacheTests.photographed {
        #expect(await cache.resolve(key) == .initials, "\(access): \(key) after the user acted")
      }

      // The book the window reads: no image and the initials look.
      let book = AvatarBook(provider: provider)
      await book.prefetch(threads)
      await book.userActed(threads)
      for thread in threads {
        #expect(book.image(for: thread) == nil, "\(access): \(thread.title) has a photo")
        #expect(book.look(for: thread) == .initials, "\(access): \(thread.title)")
      }

      // Nothing asked the system and nothing was read through the seam.
      #expect(fetching.calls.isEmpty, "\(access): \(fetching.calls)")
    }

    // The face drawn instead (D-UI-10): never empty, whatever the title.
    #expect(ProvisionalUI.deniedAvatar == .initialsDisc)
    for thread in threads {
      let face = AvatarFace.make(title: thread.title, handle: threadHandle(thread), denied: ProvisionalUI.deniedAvatar)
      switch face {
      case .letters(let letters):
        #expect(!letters.isEmpty, "\(thread.title) draws an empty disc")
      case .glyph:
        break
      }
    }
    #expect(
      AvatarFace.make(title: "Maya Okafor", handle: "+15550100001", denied: ProvisionalUI.deniedAvatar)
        == .letters("MO"))
    #expect(AvatarFace.make(title: "", handle: nil, denied: ProvisionalUI.deniedAvatar) == .glyph)
  }
}
