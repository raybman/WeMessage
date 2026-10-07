import AppKit
import Foundation

/// The only file under Sources/WeMessageApp that names the application
/// object (AppHygieneTests H-A7), so `swift test` never reaches the window
/// server through a stray reference.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  private var observers: [NSObjectProtocol] = []
  /// Caps setFrame calls, so a window the system keeps constraining can
  /// never ping-pong with the resize observer.
  private var pins = 0

  func applicationDidFinishLaunching(_ note: Notification) {
    if let appearance = TestHooks.appearance {
      NSApp.appearance = NSAppearance(named: appearance.nsAppearanceName)
    }
    guard TestHooks.isUITest else { return }
    // The CI runner's only display is smaller than the default size, so under
    // the UI-test flag the window is pinned to min(requested, visibleFrame)
    // and the result is published for the test to read. Re-pinned whenever
    // the screen's visible frame settles or the window moves under it.
    let center = NotificationCenter.default
    for name in [NSApplication.didChangeScreenParametersNotification, NSWindow.didResizeNotification] {
      observers.append(
        center.addObserver(forName: name, object: nil, queue: .main) { _ in
          MainActor.assumeIsolated { _ = self.pin() }
        })
    }
    Task { @MainActor in
      for _ in 0..<100 {
        if self.pin() { return }
        try? await Task.sleep(for: .milliseconds(100))
      }
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

  /// Pins the shell window and publishes "frame=WxH visible=WxH". Returns
  /// false while no window is on screen yet.
  @discardableResult
  private func pin() -> Bool {
    guard let window = NSApp.windows.first(where: { $0.isVisible && $0.canBecomeMain }),
      let screen = window.screen ?? NSScreen.main
    else { return false }
    let visible = screen.visibleFrame
    let width = min(ProvisionalUI.windowDefaultWidth, visible.width)
    let height = min(ProvisionalUI.windowDefaultHeight, visible.height)
    let target = NSRect(x: visible.minX, y: visible.minY, width: width, height: height)
    if abs(window.frame.width - width) > 0.5 || abs(window.frame.height - height) > 0.5
      || abs(window.frame.minX - target.minX) > 0.5 || abs(window.frame.minY - target.minY) > 0.5,
      pins < 20
    {
      pins += 1
      window.setFrame(target, display: true)
    }
    let published =
      "frame=\(Int(width.rounded()))x\(Int(height.rounded())) visible=\(Int(visible.width.rounded()))x\(Int(visible.height.rounded()))"
    if TestHooks.geometry.value != published { TestHooks.geometry.value = published }
    return true
  }
}
