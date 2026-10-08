import AppKit
import Foundation
import Observation

/// The appearance a UI test asks for through WEMESSAGE_UI_APPEARANCE.
public enum Appearance: String, Sendable {
  case light, dark

  /// "light" or "dark" exactly; anything else is nil, so the system decides.
  public static func parse(_ raw: String?) -> Appearance? {
    guard let raw else { return nil }
    return Appearance(rawValue: raw)
  }

  var nsAppearanceName: NSAppearance.Name { self == .dark ? .darkAqua : .aqua }
}

/// What the CI UI tests may switch on, read once from the environment before
/// the app starts. Nothing here writes a file: the UI tests attach their
/// screenshots to the result bundle and the job exports them.
@MainActor
enum TestHooks {
  /// WEMESSAGE_UI_TEST == "1".
  static private(set) var isUITest = false
  /// WEMESSAGE_UI_APPEARANCE, parsed.
  static private(set) var appearance: Appearance? = nil
  /// The window geometry the delegate computed, published on the shell
  /// root's accessibility value under the UI-test flag only.
  static let geometry = PublishedGeometry()
  /// WEMESSAGE_UI_REDUCE_TRANSPARENCY and its two siblings, parsed, under
  /// the UI-test flag only: the opaque snapshot legs force Reduce
  /// Transparency on without touching the runner's settings.
  static private(set) var accessibilityOverrides = AccessibilityMirror.Overrides()

  /// Board 08's specimen sheet, under the UI-test flag with
  /// WEMESSAGE_UI_BOARD=08 only: the one way to reach it (H-S4-4). No menu
  /// item and no key lead there.
  static private(set) var specimens: SpecimenContent? = nil

  /// Board 10.B's states sheet, under the UI-test flag with
  /// WEMESSAGE_UI_BOARD=10.B only: the one way to reach it (H-S4-6).
  static private(set) var statesSheet: StatesContent? = nil

  /// Board 12's onboarding: under the UI-test flag only with
  /// WEMESSAGE_UI_BOARD=12, in memory, over the fixture seam; otherwise the
  /// shipped store and seam, until the handover is spent (H-S4-7).
  static private(set) var onboarding: OnboardingModel? = nil

  /// Board 13's settings window, under the UI-test flag with
  /// WEMESSAGE_UI_BOARD=13 only: the one way to reach it in this version
  /// (D-UI-89, H-S4-9).
  static private(set) var settingsBoard = false

  static func install(from environment: [String: String]) {
    isUITest = environment["WEMESSAGE_UI_TEST"] == "1"
    appearance = Appearance.parse(environment["WEMESSAGE_UI_APPEARANCE"])
    accessibilityOverrides = isUITest ? AccessibilityMirror.Overrides.parse(environment) : AccessibilityMirror.Overrides()
    specimens = isUITest && environment["WEMESSAGE_UI_BOARD"] == "08" ? try? FixtureCatalogue.specimens() : nil
    statesSheet = isUITest && environment["WEMESSAGE_UI_BOARD"] == "10.B" ? FixtureStates.content() : nil
    onboarding = onboardingModel(board: environment["WEMESSAGE_UI_BOARD"])
    settingsBoard = isUITest && environment["WEMESSAGE_UI_BOARD"] == "13"
  }

  /// The flag returns first: under it the store is memory and the seam the
  /// fixture, so no defaults are written and no pane opens (H-S4-7).
  static func onboardingModel(board: String?) -> OnboardingModel? {
    if isUITest { return board == "12" ? OnboardingModel(store: MemoryOnboardingStore(), seam: fullDiskAccess()) : nil }
    let store = DefaultsOnboardingStore()
    if store.load()?.finished == true { return nil }
    return OnboardingModel(store: store, seam: fullDiskAccess())
  }

  /// Full Disk Access (10.C): the fixture under the UI-test flag, which
  /// counts an ask and opens nothing; the system seam otherwise. The flag
  /// returns first (H-S4-6).
  static func fullDiskAccess() -> any FullDiskAccessSeam {
    if isUITest { return FixtureFullDiskAccess() }
    return SystemFullDiskAccess()
  }

  /// Where the window's avatars come from: the fixture photos under the
  /// UI-test flag, the user's contacts otherwise. The flag returns first,
  /// so the contact store is never built on the CI runner (H-S4-5).
  static func avatarProvider() -> any AvatarProvider {
    if isUITest { return FixtureAvatarProvider() }
    return ContactsAvatarProvider(fetching: SystemContacts())
  }
}

/// "frame=<w>x<h> visible=<w>x<h>", integers in points, or nil when the
/// UI-test flag is off or the window is not placed yet.
@MainActor
@Observable
final class PublishedGeometry {
  var value: String? = nil
}
