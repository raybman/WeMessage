import AppKit
import Foundation
import Observation

/// The app's copy of the system's accessibility display options (plan 2.4,
/// risk R9). Views read it, never the workspace: with Reduce Transparency on
/// the app paints layer0 under the panes itself, so the opaque rendering is
/// the designed one rather than whatever the system substitutes.
///
/// The system flags come from an injected reader and the change notification
/// from an injected centre, so the unit tests drive both without touching the
/// workspace. A UI test may force any flag (Overrides, read from the
/// environment by TestHooks under the UI-test flag only); a forced value
/// always wins over the system's.
@MainActor
@Observable
final class AccessibilityMirror {
  /// The three display options the app follows.
  struct Flags: Equatable, Sendable {
    var reduceTransparency: Bool
    var increaseContrast: Bool
    var reduceMotion: Bool
  }

  /// Forced values; nil leaves the system in charge of that flag.
  struct Overrides: Equatable, Sendable {
    var reduceTransparency: Bool? = nil
    var increaseContrast: Bool? = nil
    var reduceMotion: Bool? = nil

    /// WEMESSAGE_UI_REDUCE_TRANSPARENCY, WEMESSAGE_UI_INCREASE_CONTRAST and
    /// WEMESSAGE_UI_REDUCE_MOTION: exactly "1" forces on, exactly "0" forces
    /// off, anything else (or nothing) is nil.
    static func parse(_ environment: [String: String]) -> Overrides {
      func flag(_ key: String) -> Bool? {
        switch environment[key] {
        case "1": true
        case "0": false
        default: nil
        }
      }
      return Overrides(
        reduceTransparency: flag("WEMESSAGE_UI_REDUCE_TRANSPARENCY"),
        increaseContrast: flag("WEMESSAGE_UI_INCREASE_CONTRAST"),
        reduceMotion: flag("WEMESSAGE_UI_REDUCE_MOTION"))
    }

    func applied(to system: Flags) -> Flags {
      Flags(
        reduceTransparency: reduceTransparency ?? system.reduceTransparency,
        increaseContrast: increaseContrast ?? system.increaseContrast,
        reduceMotion: reduceMotion ?? system.reduceMotion)
    }
  }

  /// The system's "display options changed" notification.
  static let changeNotification = NSWorkspace.accessibilityDisplayOptionsDidChangeNotification

  private(set) var flags: Flags

  var reduceTransparency: Bool { flags.reduceTransparency }
  var increaseContrast: Bool { flags.increaseContrast }
  var reduceMotion: Bool { flags.reduceMotion }

  @ObservationIgnored private let overrides: Overrides
  @ObservationIgnored private let read: @MainActor () -> Flags
  @ObservationIgnored private var observation: ObserverToken?

  init(overrides: Overrides, center: NotificationCenter, read: @escaping @MainActor () -> Flags) {
    self.overrides = overrides
    self.read = read
    self.flags = overrides.applied(to: read())
    // Delivered on the posting thread; the workspace posts on the main
    // thread, and anything else hops there.
    let token = center.addObserver(forName: Self.changeNotification, object: nil, queue: nil) { [weak self] _ in
      if Thread.isMainThread {
        MainActor.assumeIsolated { self?.refresh() }
      } else {
        Task { @MainActor in self?.refresh() }
      }
    }
    observation = ObserverToken(center: center, token: token)
  }

  /// The live mirror: the workspace's flags and its notification centre,
  /// with the UI test's forced values on top.
  static func live() -> AccessibilityMirror {
    let workspace = NSWorkspace.shared
    return AccessibilityMirror(overrides: TestHooks.accessibilityOverrides, center: workspace.notificationCenter) {
      Flags(
        reduceTransparency: workspace.accessibilityDisplayShouldReduceTransparency,
        increaseContrast: workspace.accessibilityDisplayShouldIncreaseContrast,
        reduceMotion: workspace.accessibilityDisplayShouldReduceMotion)
    }
  }

  /// Re-reads the system and applies the forced values again.
  func refresh() {
    let next = overrides.applied(to: read())
    if next != flags { flags = next }
  }

  /// Removes the observer when the mirror goes away.
  private final class ObserverToken: @unchecked Sendable {
    let center: NotificationCenter
    let token: any NSObjectProtocol

    init(center: NotificationCenter, token: any NSObjectProtocol) {
      self.center = center
      self.token = token
    }

    deinit { center.removeObserver(token) }
  }
}
