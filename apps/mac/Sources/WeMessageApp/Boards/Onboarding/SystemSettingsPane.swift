import AppKit
import Foundation

/// The one place the app names System Settings' Full Disk Access pane
/// (12.B, D-UI-64). The shipped seam calls it; under the UI-test flag
/// nothing reaches it, and it refuses to run if something does (H-S4-7).
@MainActor
enum SystemSettingsPane {
  static let fullDiskAccess = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"

  static func openFullDiskAccess() {
    precondition(!TestHooks.isUITest, "the Full Disk Access pane under the UI-test flag")
    guard let url = URL(string: fullDiskAccess) else { return }
    NSWorkspace.shared.open(url)
  }
}
