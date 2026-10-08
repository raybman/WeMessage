import SwiftUI

/// The SwiftUI app. It has no entry-point attribute: AppEntry.run starts it,
/// after main.swift has ruled out `--daemon`.
struct ShellApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate

  var body: some Scene {
    WindowGroup("WeMessage") {
      if let specimens = TestHooks.specimens {
        SpecimenSheet(content: specimens)
      } else if let states = TestHooks.statesSheet {
        StatesSheet(content: states)
      } else if TestHooks.settingsBoard {
        SettingsRoot()
      } else if let onboarding = TestHooks.onboarding {
        OnboardingRoot(model: onboarding)
      } else {
        ShellView()
      }
    }
    .defaultSize(width: ProvisionalUI.windowDefaultWidth, height: ProvisionalUI.windowDefaultHeight)
    .windowStyle(.hiddenTitleBar)
    .windowResizability(.contentMinSize)
  }
}
