import Foundation
import Testing

@testable import WeMessageApp

/// A1: WEMESSAGE_UI_APPEARANCE is read exactly, so a UI test that asks for a
/// dark window gets one and anything else gets the system's choice.
@Suite("Appearance")
struct AppearanceTests {
  @Test("A1: parse accepts exactly 'light' and 'dark' and nothing else")
  func parse() {
    #expect(Appearance.parse("light") == .light)
    #expect(Appearance.parse("dark") == .dark)
    #expect(Appearance.parse("Dark") == nil)
    #expect(Appearance.parse("") == nil)
    #expect(Appearance.parse(nil) == nil)
    #expect(Appearance.parse("auto") == nil)
  }

  @Test("A1+: TestHooks.install reads the UI-test flag and the appearance from the environment, and an empty environment leaves both off")
  @MainActor
  func install() {
    TestHooks.install(from: ["WEMESSAGE_UI_APPEARANCE": "dark", "WEMESSAGE_UI_TEST": "1"])
    #expect(TestHooks.appearance == .dark)
    #expect(TestHooks.isUITest)
    TestHooks.install(from: ["WEMESSAGE_UI_TEST": "yes"])
    #expect(TestHooks.appearance == nil)
    #expect(!TestHooks.isUITest)
    TestHooks.install(from: [:])
    #expect(TestHooks.appearance == nil)
    #expect(!TestHooks.isUITest)
  }
}
