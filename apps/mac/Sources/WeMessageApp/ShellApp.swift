import SwiftUI

/// The SwiftUI app. It has no entry-point attribute: AppEntry.run starts it,
/// after main.swift has ruled out `--daemon`.
struct ShellApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate

  var body: some Scene {
    WindowGroup("WeMessage") {
      // S4a.0 spike only: the frost variant over the test-only backdrop.
      if let frost = TestHooks.spikeFrost {
        SpikeView(frost: frost)
      } else {
        ShellView()
      }
    }
    .defaultSize(width: ProvisionalUI.windowDefaultWidth, height: ProvisionalUI.windowDefaultHeight)
    .windowStyle(.hiddenTitleBar)
    .windowResizability(.contentMinSize)
  }
}
