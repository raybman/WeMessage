import AppKit
import SwiftUI

/// The one window frost (plan 2.4, G2): the D-UI-21 material as the window's
/// container background under transparent panes, or, with Reduce
/// Transparency, a plain layer0 fill the app paints itself. Panes never carry
/// their own material; that is what makes the frost even.
struct FrostBackground: ViewModifier {
  /// What sits behind the panes.
  enum Fill: Equatable, Sendable {
    case layer0
    case material(ProvisionalUI.FrostMaterial)

    static func decide(reduceTransparency: Bool) -> Fill {
      reduceTransparency ? .layer0 : .material(ProvisionalUI.frostMaterial)
    }

    /// The layer0 wash drawn over the material: light only (D-UI-21), never
    /// over the opaque layer0 fill.
    static func washAlpha(_ fill: Fill, dark: Bool) -> Double {
      guard case .material = fill, !dark else { return 0 }
      return ProvisionalUI.frostLightWashAlpha
    }
  }

  let mirror: AccessibilityMirror
  let palette: Tokens.Palette
  @Environment(\.colorScheme) private var scheme

  func body(content: Content) -> some View {
    let fill = Fill.decide(reduceTransparency: mirror.reduceTransparency)
    let wash = Fill.washAlpha(fill, dark: scheme == .dark)
    content
      // v2 F10: a received bubble lets the frost through only when there is
      // frost behind it (BubbleLook).
      .environment(\.behindFrost, fill != .layer0)
      // Neither the clearing view nor the fill is content: hidden from the
      // accessibility tree (run 37571025343's audit flagged a window-sized
      // group with no description).
      .background(ClearWindow().accessibilityHidden(true))
      .containerBackground(for: .window) {
        ZStack {
          switch fill {
          case .layer0: Rectangle().fill(Tokens.color(palette.layer0))
          case .material(.regular): Rectangle().fill(.regularMaterial)
          case .material(.ultraThin): Rectangle().fill(.ultraThinMaterial)
          case .material(.hudWindow): BehindWindowEffect(material: .hudWindow)
          }
          if wash > 0 { Rectangle().fill(Tokens.color(palette.layer0).opacity(wash)) }
        }
        .accessibilityHidden(true)
      }
  }
}

private struct BehindFrostKey: EnvironmentKey {
  static let defaultValue = false
}

extension EnvironmentValues {
  /// True under the window frost; false with Reduce Transparency, where the
  /// app paints layer0, and outside the frost modifier. (A key by hand:
  /// SwiftPM builds without the SwiftUI macro plugin, so no @Entry.)
  var behindFrost: Bool {
    get { self[BehindFrostKey.self] }
    set { self[BehindFrostKey.self] = newValue }
  }
}

/// The 0.5 pt pane divider: translucent over frost, its opaque composite
/// over layer0 with Reduce Transparency, full ink with Increase Contrast.
struct Hairline: View {
  let mirror: AccessibilityMirror
  let palette: Tokens.Palette
  let dark: Bool
  /// Under the title bar the divider runs across, not down.
  var horizontal = false

  private var color: Color {
    if mirror.increaseContrast { return Tokens.color(palette.ink) }
    if mirror.reduceTransparency { return Tokens.color(dark ? Tokens.Hairline.opaqueDark : Tokens.Hairline.opaqueLight) }
    return Tokens.color(dark ? Tokens.Hairline.dark : Tokens.Hairline.light)
  }

  var body: some View {
    Rectangle()
      .fill(color)
      .frame(width: horizontal ? nil : 0.5, height: horizontal ? 0.5 : nil)
      .frame(maxWidth: horizontal ? .infinity : nil, maxHeight: horizontal ? nil : .infinity)
      .accessibilityHidden(true)
  }
}

/// Makes the hosting window non-opaque with a clear background, so the
/// container background is all that is drawn behind the panes (measured in
/// the S4a.0 spike with exactly this window state).
private struct ClearWindow: NSViewRepresentable {
  func makeNSView(context: Context) -> ClearingView { ClearingView() }
  func updateNSView(_ view: ClearingView, context: Context) { view.clear() }

  final class ClearingView: NSView {
    override func isAccessibilityElement() -> Bool { false }
    override func accessibilityChildren() -> [Any]? { [] }

    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      clear()
    }

    func clear() {
      guard let window else { return }
      if window.isOpaque { window.isOpaque = false }
      if window.backgroundColor != .clear { window.backgroundColor = .clear }
    }
  }
}

/// An AppKit material, blending behind the window, always active (a window
/// that is not key would otherwise draw it flat).
private struct BehindWindowEffect: NSViewRepresentable {
  let material: NSVisualEffectView.Material

  func makeNSView(context: Context) -> NSVisualEffectView {
    let view = NSVisualEffectView()
    view.blendingMode = .behindWindow
    updateNSView(view, context: context)
    return view
  }

  func updateNSView(_ view: NSVisualEffectView, context: Context) {
    if view.material != material { view.material = material }
    if view.state != .active { view.state = .active }
  }
}
