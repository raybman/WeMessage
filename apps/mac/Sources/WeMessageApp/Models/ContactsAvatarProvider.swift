import Contacts
import Foundation

/// Avatar photos from the user's contacts, read through the ContactFetching
/// seam (S4g). This file is the only one that may import Contacts or name
/// the contact store (H-S4-5, arch). Neither type here can be built under
/// the UI-test flag: a system prompt on the CI runner would hang the ui job,
/// so both refuse the flag as their first statement, and TestHooks returns
/// the fixtures before it reaches them.
struct ContactsAvatarProvider: AvatarProvider {
  private let fetching: any ContactFetching

  @MainActor
  init(fetching: any ContactFetching) {
    precondition(!TestHooks.isUITest, "Contacts is never reached under the UI-test flag")
    self.fetching = fetching
  }

  func access() async -> ContactAccess { fetching.authorization() }

  func requestAccess() async -> ContactAccess {
    _ = await fetching.requestAccess()
    return fetching.authorization()
  }

  /// A group has no one contact; an address is looked up as an email, and
  /// anything else as a phone number.
  func photo(for key: String) async -> Data? {
    if key.hasPrefix("group:") { return nil }
    if key.contains("@") { return fetching.thumbnail(email: key) }
    return fetching.thumbnail(phone: key)
  }
}

/// The system contact book. Built only by TestHooks.avatarProvider, after
/// the flag has returned the fixtures. Thumbnails only; nothing is written.
final class SystemContacts: ContactFetching, @unchecked Sendable {
  private let store: CNContactStore

  @MainActor
  init() {
    precondition(!TestHooks.isUITest, "the contact store is never built under the UI-test flag")
    store = CNContactStore()
  }

  func authorization() -> ContactAccess {
    switch CNContactStore.authorizationStatus(for: .contacts) {
    case .authorized: .authorized
    case .notDetermined: .notDetermined
    case .restricted: .restricted
    case .denied: .denied
    default: .denied
    }
  }

  func requestAccess() async -> Bool {
    (try? await store.requestAccess(for: .contacts)) ?? false
  }

  func thumbnail(phone: String) -> Data? {
    firstThumbnail(CNContact.predicateForContacts(matching: CNPhoneNumber(stringValue: phone)))
  }

  func thumbnail(email: String) -> Data? {
    firstThumbnail(CNContact.predicateForContacts(matchingEmailAddress: email))
  }

  private func firstThumbnail(_ predicate: NSPredicate) -> Data? {
    let keys = [CNContactThumbnailImageDataKey as CNKeyDescriptor]
    let found = (try? store.unifiedContacts(matching: predicate, keysToFetch: keys)) ?? []
    return found.lazy.compactMap(\.thumbnailImageData).first
  }
}
