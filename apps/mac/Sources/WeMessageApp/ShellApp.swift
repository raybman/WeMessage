import SwiftUI

/// The SwiftUI app. It has no entry-point attribute: AppEntry.run starts it,
/// after main.swift has ruled out `--daemon`.
struct ShellApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate

  var body: some Scene {
    WindowGroup("WeMessage") {
      ShellView()
    }
    .defaultSize(width: ProvisionalUI.windowDefaultWidth, height: ProvisionalUI.windowDefaultHeight)
    .windowStyle(.hiddenTitleBar)
    .windowResizability(.contentMinSize)
  }
}
