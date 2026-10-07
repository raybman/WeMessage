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

  static func install(from environment: [String: String]) {
    isUITest = environment["WEMESSAGE_UI_TEST"] == "1"
    appearance = Appearance.parse(environment["WEMESSAGE_UI_APPEARANCE"])
    accessibilityOverrides = isUITest ? AccessibilityMirror.Overrides.parse(environment) : AccessibilityMirror.Overrides()
  }
}

/// "frame=<w>x<h> visible=<w>x<h>", integers in points, or nil when the
/// UI-test flag is off or the window is not placed yet.
@MainActor
@Observable
final class PublishedGeometry {
  var value: String? = nil
}
