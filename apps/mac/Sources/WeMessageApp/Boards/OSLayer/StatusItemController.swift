import AppKit
import SwiftUI
import WeMessageKit

/// v2 S4l, board 16.A: the menu bar extra. Five states, one glyph: the
/// badge carries the state, a stroke marks the kill switch, reduced alpha
/// marks a lost connection. A click opens the popover. Made by the delegate
/// outside the UI-test flag only (D-UI-112): no test ever creates one.
@MainActor
final class StatusItemController: NSObject {
  private let item: NSStatusItem
  private let popover = NSPopover()
  private let hub: OSLayerHub
  private var confirming = false
  private let openApp: () -> Void

  init(hub: OSLayerHub = .shared, openApp: @escaping () -> Void) {
    self.hub = hub
    self.openApp = openApp
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    super.init()
    popover.behavior = .transient
    popover.contentSize = NSSize(width: PopoverView.width, height: PopoverView.height)
    item.button?.target = self
    item.button?.action = #selector(toggle(_:))
    hub.listen { [weak self] in self?.refresh() }
    refresh()
  }

  /// Redraws the glyph and, while open, the popover.
  func refresh() {
    let glyph = OSLayer.glyph(hub.snapshot)
    if let button = item.button {
      button.image = Self.image(glyph)
      button.alphaValue = 1
      button.setAccessibilityLabel(glyph.spoken)
    }
    if popover.isShown { popover.contentViewController = host() }
  }

  /// The glyph as a template image, from the same view the board draws.
  static func image(_ glyph: StatusGlyph) -> NSImage? {
    let renderer = ImageRenderer(content: StatusGlyphView(glyph: glyph, ink: .black, size: 14).padding(.horizontal, 1))
    renderer.scale = 2
    guard let image = renderer.nsImage else { return nil }
    image.isTemplate = true
    return image
  }

  @objc private func toggle(_ sender: Any?) {
    if popover.isShown {
      popover.performClose(sender)
      return
    }
    confirming = false
    popover.contentViewController = host()
    if let button = item.button { popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY) }
  }

  private func host() -> NSViewController {
    let input =
      hub.popover
      ?? PopoverInput(snapshot: hub.snapshot, stamp: "", entries: [], sources: [], oldestSync: "")
    let dark = item.button?.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
    let view = PopoverView(
      content: PopoverRules.content(input), palette: Tokens.palette(dark: dark), mirror: AccessibilityMirror.live(),
      dark: dark, confirming: confirming, held: input.entries.count,
      drafts: input.entries.filter { $0.kind == .draft }.count,
      onVerb: { [weak self] verb, entry in
        self?.hub.popoverVerb(verb, entry)
        if verb == .open { self?.close() }
      },
      onOpenApp: { [weak self] in self?.close() },
      onKill: { [weak self] in
        guard let self else { return }
        if self.hub.snapshot.killed {
          self.close()
        } else {
          self.confirming = true
          self.popover.contentViewController = self.host()
        }
      },
      onEngage: { [weak self] in
        self?.hub.perform("kill:engage")
        self?.confirming = false
      },
      onCancel: { [weak self] in
        guard let self else { return }
        self.confirming = false
        self.popover.contentViewController = self.host()
      },
      onSettings: { [weak self] in
        self?.hub.perform("app:settings")
        self?.close()
      })
    return NSHostingController(rootView: view)
  }

  /// Closes the popover and brings the window forward.
  private func close() {
    popover.performClose(nil)
    openApp()
  }
}
