import Foundation
import Testing

@testable import WeMessageApp

/// M1 to M4: the app's copy of the system accessibility display options
/// (plan 2.4, risk R9). The system flags are read through an injected reader
/// and the change notification arrives on an injected centre, so nothing
/// here touches the workspace or the window server; a UI test's forced value
/// always wins over the system's.
@Suite("AccessibilityMirror")
@MainActor
struct AccessibilityMirrorTests {
  /// A reader the test can flip, standing in for the workspace's flags.
  final class System {
    var flags = AccessibilityMirror.Flags(reduceTransparency: false, increaseContrast: false, reduceMotion: false)
  }

  static let changed = AccessibilityMirror.changeNotification

  @Test("M1: Overrides.parse reads '1' as on and '0' as off, and anything else leaves the system in charge")
  func parse() {
    let none = AccessibilityMirror.Overrides.parse([:])
    #expect(none == AccessibilityMirror.Overrides())
    let on = AccessibilityMirror.Overrides.parse([
      "WEMESSAGE_UI_REDUCE_TRANSPARENCY": "1", "WEMESSAGE_UI_INCREASE_CONTRAST": "1", "WEMESSAGE_UI_REDUCE_MOTION": "1",
    ])
    #expect(on.reduceTransparency == true)
    #expect(on.increaseContrast == true)
    #expect(on.reduceMotion == true)
    let off = AccessibilityMirror.Overrides.parse(["WEMESSAGE_UI_REDUCE_TRANSPARENCY": "0"])
    #expect(off.reduceTransparency == false)
    #expect(off.increaseContrast == nil)
    #expect(off.reduceMotion == nil)
    for junk in ["", "yes", "true", "01", " 1", "on"] {
      #expect(AccessibilityMirror.Overrides.parse(["WEMESSAGE_UI_REDUCE_TRANSPARENCY": junk]).reduceTransparency == nil, "\(junk)")
    }
  }

  @Test("M2: TestHooks forwards the overrides only under the UI-test flag")
  func installGatesOverrides() {
    TestHooks.install(from: ["WEMESSAGE_UI_TEST": "1", "WEMESSAGE_UI_REDUCE_TRANSPARENCY": "1"])
    #expect(TestHooks.accessibilityOverrides.reduceTransparency == true)
    TestHooks.install(from: ["WEMESSAGE_UI_REDUCE_TRANSPARENCY": "1"])
    #expect(TestHooks.accessibilityOverrides == AccessibilityMirror.Overrides())
    TestHooks.install(from: [:])
    #expect(TestHooks.accessibilityOverrides == AccessibilityMirror.Overrides())
  }

  @Test("M3: the mirror follows the system and re-reads it when the display options change")
  func followsSystem() {
    let system = System()
    let center = NotificationCenter()
    let mirror = AccessibilityMirror(overrides: .init(), center: center) { system.flags }
    #expect(!mirror.reduceTransparency)
    #expect(!mirror.increaseContrast)
    #expect(!mirror.reduceMotion)
    system.flags = .init(reduceTransparency: true, increaseContrast: true, reduceMotion: true)
    // Nothing changes until the system says so.
    #expect(!mirror.reduceTransparency)
    center.post(name: Self.changed, object: nil)
    #expect(mirror.reduceTransparency)
    #expect(mirror.increaseContrast)
    #expect(mirror.reduceMotion)
    system.flags = .init(reduceTransparency: false, increaseContrast: true, reduceMotion: false)
    center.post(name: Self.changed, object: nil)
    #expect(!mirror.reduceTransparency)
    #expect(mirror.increaseContrast)
    #expect(!mirror.reduceMotion)
    // Another notification name is not a display options change.
    system.flags = .init(reduceTransparency: true, increaseContrast: false, reduceMotion: false)
    center.post(name: Notification.Name("wemessage.test.unrelated"), object: nil)
    #expect(!mirror.reduceTransparency)
    // The live centre is the workspace's, and the live name is the system's.
    #expect(AccessibilityMirror.changeNotification.rawValue.contains("AccessibilityDisplayOptions"))
  }

  @Test("M4: a forced value wins over the system in both directions, and only for the flag it names")
  func overridesWin() {
    let system = System()
    let center = NotificationCenter()
    system.flags = .init(reduceTransparency: false, increaseContrast: true, reduceMotion: false)
    let forcedOn = AccessibilityMirror(overrides: .init(reduceTransparency: true), center: center) { system.flags }
    #expect(forcedOn.reduceTransparency)
    #expect(forcedOn.increaseContrast)
    system.flags = .init(reduceTransparency: true, increaseContrast: false, reduceMotion: true)
    let forcedOff = AccessibilityMirror(overrides: .init(reduceTransparency: false), center: center) { system.flags }
    #expect(!forcedOff.reduceTransparency)
    #expect(!forcedOff.increaseContrast)
    #expect(forcedOff.reduceMotion)
    // A change notification never undoes the forced value.
    center.post(name: Self.changed, object: nil)
    #expect(forcedOn.reduceTransparency)
    #expect(!forcedOff.reduceTransparency)
    #expect(forcedOn.reduceMotion)
  }

  @Test("M5: the frost decision: reduce transparency paints layer0, otherwise the D-UI-21 material")
  func frostDecision() {
    #expect(FrostBackground.Fill.decide(reduceTransparency: true) == .layer0)
    #expect(FrostBackground.Fill.decide(reduceTransparency: false) == .material(ProvisionalUI.frostMaterial))
    #expect(ProvisionalUI.frostMaterial == .regular)
  }
}
