import Foundation
import WeMessageKit

/// What the user has let the app read from Contacts.
public enum ContactAccess: Sendable, Equatable {
  case notDetermined, authorized, denied, restricted
}

/// What one avatar draws: a photo's encoded bytes, or the initials disc.
public enum AvatarResolution: Sendable, Equatable {
  case photo(Data)
  case initials
}

/// Where avatar photos come from (S4g). The app's provider reads Contacts
/// through the ContactFetching seam; under the UI-test flag the fixtures
/// stand in, so the ui job never reaches Contacts (H-S4-5).
public protocol AvatarProvider: Sendable {
  /// The current access. Never prompts.
  func access() async -> ContactAccess
  /// Asks the system. AvatarCache calls this once, on a user act, and only
  /// while access is undetermined.
  func requestAccess() async -> ContactAccess
  /// The photo for a normalised key (AvatarKey), or nil. Called only while
  /// access is authorized.
  func photo(for key: String) async -> Data?
}

/// The system's contact book, behind a seam the unit tests fake. The one
/// implementation that reaches Contacts is SystemContacts, in
/// ContactsAvatarProvider.swift.
public protocol ContactFetching: Sendable {
  func authorization() -> ContactAccess
  /// The system prompt; true when the user said yes.
  func requestAccess() async -> Bool
  func thumbnail(phone: String) -> Data?
  func thumbnail(email: String) -> Data?
}

/// The provider a model gets when none is given: initials for everyone,
/// and nothing that could ask for Contacts.
struct InitialsOnlyAvatars: AvatarProvider {
  func access() async -> ContactAccess { .denied }
  func requestAccess() async -> ContactAccess { .denied }
  func photo(for key: String) async -> Data? { nil }
}

/// Avatar keys and the disc step. Pure.
public enum AvatarKey {
  /// A thread's key: the normalised handle of a one-to-one thread, or
  /// "group:" and the chat guid.
  public static func of(_ thread: ThreadSummary) -> String {
    guard let handle = threadHandle(thread) else { return "group:" + thread.chatGuid }
    return normalise(handle)
  }

  /// An address lowercased and trimmed; a phone number in E.164 (ten digits
  /// read as North American, eleven starting with 1 likewise); anything
  /// else lowercased and trimmed.
  public static func normalise(_ handle: String) -> String {
    let trimmed = handle.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.contains("@") { return trimmed.lowercased() }
    let digits = trimmed.filter { $0.isASCII && $0.isNumber }
    guard !digits.isEmpty, trimmed.allSatisfy({ $0.isNumber || " +-().".contains($0) }) else {
      return trimmed.lowercased()
    }
    if trimmed.hasPrefix("+") { return "+" + digits }
    if digits.count == 10 { return "+1" + digits }
    if digits.count == 11 && digits.hasPrefix("1") { return "+" + digits }
    return digits
  }

  /// FNV-1a, 32 bits, over the UTF-8 bytes.
  public static func fnv1a(_ text: String) -> UInt32 {
    var hash: UInt32 = 2_166_136_261
    for byte in text.utf8 {
      hash ^= UInt32(byte)
      hash = hash &* 16_777_619
    }
    return hash
  }

  /// The disc step for a key, 0..<steps.
  public static func step(for key: String, steps: Int = 6) -> Int {
    Int(fnv1a(key) % UInt32(steps))
  }
}

/// What an initials disc carries (D-UI-10, D-UI-56). Pure.
public enum AvatarFace: Equatable, Sendable {
  case letters(String)
  case glyph

  public static func make(title: String, handle: String?, denied: ProvisionalUI.DeniedAvatar) -> AvatarFace {
    switch denied {
    case .silhouette:
      return .glyph
    case .lastFourDigits:
      if let handle, !handle.contains("@") {
        let digits = handle.filter { $0.isASCII && $0.isNumber }
        if digits.count >= 4 { return .letters(String(digits.suffix(4))) }
      }
    case .initialsDisc:
      break
    }
    let initials = ShellText.initials(title)
    return initials.isEmpty ? .glyph : .letters(initials)
  }
}
