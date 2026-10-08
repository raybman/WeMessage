import AppKit
import Foundation
import Observation
import WeMessageKit

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

  /// Board 14's compose window, under the UI-test flag with
  /// WEMESSAGE_UI_BOARD=14 only: no cmd-N door in this version (D-UI-95,
  /// H-S4-10).
  static private(set) var composeBoard = false

  /// Board 14's people and its opt-cmd-D proposal: fixtures in this version
  /// (D-UI-98, D-UI-100).
  static var composePeople: [ComposePerson] { FixtureCompose.people }
  static let composeProposal: @Sendable (ComposePerson) -> String = { FixtureCompose.proposal(for: $0) }

  /// Board 15's media window, under the UI-test flag with
  /// WEMESSAGE_UI_BOARD=15 only: no attach, drop or paste door reaches the
  /// shipped thread in this version (D-UI-102, H-S4-11).
  static private(set) var attachmentsBoard = false

  /// Board 16's OS layer, under the UI-test flag with
  /// WEMESSAGE_UI_BOARD=16: the popover's content view, the extra's five
  /// glyphs and the Dock menu in a window of their own over fixtures
  /// (D-UI-112). No status item is made and nothing posts.
  static private(set) var osLayerBoard = false

  /// Board 16's popover inputs (healthy, degraded, killed) and the glyph
  /// strip's five snapshots: fixtures in this version (D-UI-112).
  static var osLayerInputs: (healthy: PopoverInput, degraded: PopoverInput, killed: PopoverInput) {
    (FixtureOSLayer.healthy, FixtureOSLayer.degraded, FixtureOSLayer.killed)
  }
  static var osLayerStates: [(StatusState, OSSnapshot)] { FixtureOSLayer.states }

  /// Board 17's progress window, under the UI-test flag with
  /// WEMESSAGE_UI_BOARD=17 only: the meters, the ribbon, the tiles, the
  /// card and the three zero screens over fixtures (D-UI-121, H-S4-13).
  /// No menu item, key or link reaches it in this version (D-UI-123).
  static private(set) var progressBoard = false

  /// Board 17's words and numbers: fixtures in this version (D-UI-121).
  static var progressContent: ProgressContent { FixtureProgress.content() }

  /// Board 15's thread and the files its doors bring: fixtures in this
  /// version (D-UI-103).
  static var mediaContent: MediaContent { FixtureAttachments.content() }

  /// Where board 15's Save writes under the flag: a temporary folder named
  /// Downloads, never the runner's own (D-UI-108).
  static var mediaDownloads: URL {
    FileManager.default.temporaryDirectory
      .appendingPathComponent("wemessage-ui-\(ProcessInfo.processInfo.processIdentifier)", isDirectory: true)
      .appendingPathComponent("Downloads", isDirectory: true)
  }

  static func install(from environment: [String: String]) {
    isUITest = environment["WEMESSAGE_UI_TEST"] == "1"
    appearance = Appearance.parse(environment["WEMESSAGE_UI_APPEARANCE"])
    accessibilityOverrides = isUITest ? AccessibilityMirror.Overrides.parse(environment) : AccessibilityMirror.Overrides()
    specimens = isUITest && environment["WEMESSAGE_UI_BOARD"] == "08" ? try? FixtureCatalogue.specimens() : nil
    statesSheet = isUITest && environment["WEMESSAGE_UI_BOARD"] == "10.B" ? FixtureStates.content() : nil
    onboarding = onboardingModel(board: environment["WEMESSAGE_UI_BOARD"])
    settingsBoard = isUITest && environment["WEMESSAGE_UI_BOARD"] == "13"
    composeBoard = isUITest && environment["WEMESSAGE_UI_BOARD"] == "14"
    attachmentsBoard = isUITest && environment["WEMESSAGE_UI_BOARD"] == "15"
    osLayerBoard = isUITest && environment["WEMESSAGE_UI_BOARD"] == "16"
    progressBoard = isUITest && environment["WEMESSAGE_UI_BOARD"] == "17"
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
