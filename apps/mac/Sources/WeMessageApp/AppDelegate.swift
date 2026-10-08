import AppKit
import Foundation
import WeMessageKit

/// The only file under Sources/WeMessageApp that names the application
/// object (AppHygieneTests H-A7), so `swift test` never reaches the window
/// server through a stray reference.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  private var observers: [NSObjectProtocol] = []
  /// Caps setFrame calls, so a window the system keeps constraining can
  /// never ping-pong with the resize observer.
  private var pins = 0
  /// Under the UI-test flag only: the backdrop the frost blurs (plan 2.5).
  private var backdrop: BackdropWindow?
  /// v2 S4l, board 16: the main menu this delegate installed, the context
  /// it was built for, and the extra (never made under the UI-test flag).
  private var installedMenu: NSMenu?
  private var installedContext: MenuContext?
  private var statusItem: StatusItemController?

  func applicationDidFinishLaunching(_ note: Notification) {
    if let appearance = TestHooks.appearance {
      NSApp.appearance = NSAppearance(named: appearance.nsAppearanceName)
    }
    // The window's hosting view is the group above the shell; unnamed, the
    // system accessibility audit reports it as an element with no
    // description (S3c). It takes the window's title, in every mode.
    observers.append(
      NotificationCenter.default.addObserver(forName: NSWindow.didBecomeKeyNotification, object: nil, queue: .main) {
        note in
        let window = note.object as? NSWindow
        MainActor.assumeIsolated {
          Self.describe(window)
          self.installMenuIfReplaced()
        }
      })
    startOSLayer()
    guard TestHooks.isUITest else { return }
    // The CI runner's only display is smaller than the default size, so under
    // the UI-test flag the window is pinned to min(requested, visibleFrame)
    // and the result is published for the test to read. Re-pinned whenever
    // the screen's visible frame settles or the window moves under it; a
    // move also carries the backdrop's stripe band along.
    let center = NotificationCenter.default
    for name in [
      NSApplication.didChangeScreenParametersNotification, NSWindow.didResizeNotification, NSWindow.didMoveNotification,
    ] {
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

  /// Names the window's hosting group, and every other unnamed window-sized
  /// view in the window: with the frost as the window's container
  /// background (S4a) SwiftUI hosts that background in a view of its own
  /// beside the content view, and run 37572419494's audit reported it as an
  /// empty window-sized group with no description directly under the window.
  /// Walks a few levels down from the content view's superview.
  private static func describe(_ window: NSWindow?) {
    guard let window, !window.title.isEmpty, let root = window.contentView else { return }
    if root.accessibilityLabel() != window.title { root.setAccessibilityLabel(window.title) }
    let sizes = [root.bounds.size, window.frame.size]
    var level: [NSView] = (root.superview ?? root).subviews
    for _ in 0..<4 {
      for view in level where view !== root && sizes.contains(view.frame.size) {
        if (view.accessibilityLabel() ?? "").isEmpty { view.setAccessibilityLabel(window.title) }
      }
      level = level.flatMap(\.subviews)
    }
  }

  /// Opens the backdrop behind the shell window once, then keeps its stripe
  /// band under the window's FrostProbe.stripeBand.
  private func placeBackdrop(under window: NSWindow, screen: NSScreen) {
    guard TestHooks.isUITest else { return }
    if backdrop == nil {
      let made = BackdropWindow(screenFrame: screen.frame, dark: TestHooks.appearance == .dark)
      made.orderFront(nil)
      backdrop = made
    }
    backdrop?.place(under: window.frame)
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    ProvisionalUI.closingWindowQuits
  }

  // MARK: v2 S4l, board 16: the OS layer

  /// The main menu (16.G), the Dock badge and menu (16.E, 16.F), the extra
  /// (16.A) and the notification categories (16.D). Under the UI-test flag
  /// only the main menu is real: no extra, no badge, nothing registered
  /// with the notification center (D-UI-112).
  private func startOSLayer() {
    let hub = OSLayerHub.shared
    NSWindow.allowsAutomaticWindowTabbing = false
    hub.register("win:show") { self.showWindow() }
    hub.register("dock:open") { self.showWindow() }
    hub.register("win:front") { NSApp.arrangeInFront(nil) }
    installMenu()
    hub.listen { self.osLayerChanged() }
    observers.append(
      NotificationCenter.default.addObserver(forName: NSApplication.didUpdateNotification, object: nil, queue: .main) {
        _ in
        MainActor.assumeIsolated { self.installMenuIfReplaced() }
      })
    if !TestHooks.isUITest {
      statusItem = StatusItemController(hub: hub) { self.showWindow() }
      if Bundle.main.bundleIdentifier != nil {
        Notifications.poster = SystemPoster(center: .current())
      }
    }
    Notifications.poster.register(Notifications.categories)
    if TestHooks.osLayerBoard {
      // Read the menu back after SwiftUI has had its turn at it.
      Task { @MainActor in
        for _ in 0..<5 {
          try? await Task.sleep(for: .milliseconds(400))
          self.installMenuIfReplaced()
        }
      }
    }
  }

  private func installMenu() {
    let context = OSLayerHub.shared.menuContext
    let menu = MenuBuilder.build(AppMenu.top(context))
    NSApp.mainMenu = menu
    if let services = menu.items.first?.submenu?.items.first(where: { $0.identifier?.rawValue == "app:services" }) {
      NSApp.servicesMenu = services.submenu
    }
    installedMenu = menu
    installedContext = context
    if TestHooks.osLayerBoard { OSLayerHub.shared.menuDump = MenuBuilder.dump(NSApp.mainMenu) }
  }

  /// SwiftUI may put its own menu back when a scene changes: the table
  /// wins, every time.
  private func installMenuIfReplaced() {
    if NSApp.mainMenu !== installedMenu || installedContext != OSLayerHub.shared.menuContext {
      installMenu()
    } else if TestHooks.osLayerBoard {
      let dump = MenuBuilder.dump(NSApp.mainMenu)
      if dump != OSLayerHub.shared.menuDump { OSLayerHub.shared.menuDump = dump }
    }
  }

  private func osLayerChanged() {
    installMenuIfReplaced()
    // The Dock shows the true number, or nothing (16.F); never under the
    // flag, where the runner's Dock is not ours to mark.
    if !TestHooks.isUITest { NSApp.dockTile.badgeLabel = OSLayer.dockBadge(OSLayerHub.shared.snapshot) }
  }

  private func showWindow() {
    NSApp.activate()
    let window = NSApp.windows.first { $0.canBecomeMain && !($0 is BackdropWindow) }
    window?.makeKeyAndOrderFront(nil)
  }

  func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
    let hub = OSLayerHub.shared
    let entries = hub.popover?.entries ?? []
    let perChannel = AppMenu.scopes.filter { $0.id != "all" }.map { scope in
      (title: scope.title, count: entries.filter { $0.channel == scope.id }.count)
    }
    let sources = hub.popover?.sources ?? []
    let oldest = hub.popover?.oldestSync ?? ""
    let line = "\(sources.count) \(sources.count == 1 ? "source" : "sources") synced" + (oldest.isEmpty ? "" : ", oldest \(oldest)")
    let asOf = String(hub.popover?.stamp.split(separator: " ").last ?? "")
    return MenuBuilder.dock(
      DockMenu.lines(
        snapshot: hub.snapshot, drafts: entries.filter { $0.kind == .draft }.count, asOf: asOf, sourcesLine: line,
        perChannel: perChannel))
  }

  /// wemessage://thread/<ch>/<id>: the handoff (16.C). Anything else is
  /// ignored.
  func application(_ application: NSApplication, open urls: [URL]) {
    for url in urls {
      guard let target = Handoff.parse(url.absoluteString) else { continue }
      showWindow()
      OSLayerHub.shared.handoff(target)
    }
  }

  /// Pins the shell window and publishes "frame=WxH visible=WxH". Returns
  /// false while no window is on screen yet.
  @discardableResult
  private func pin() -> Bool {
    let candidate =
      NSApp.windows.first(where: { $0.isVisible && $0.canBecomeMain }) ?? NSApp.mainWindow ?? NSApp.keyWindow
      ?? NSApp.windows.first(where: { $0.isVisible && !($0 is BackdropWindow) })
    guard let window = candidate,
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
    if window.accessibilityValue() as? String != published { window.setAccessibilityValue(published) }
    placeBackdrop(under: window, screen: screen)
    Self.describe(window)
    return true
  }
}
