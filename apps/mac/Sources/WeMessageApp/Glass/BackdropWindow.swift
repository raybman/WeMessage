import AppKit
import Observation
import SwiftUI

/// The CI-only backdrop (plan 2.5, D-UI-12): a borderless, screen-sized
/// window one level below normal, filled with the Tokens.Backdrop gradient
/// and a black and white stripe band kept under FrostProbe.stripeBand of the
/// main window. The frost then blurs a known, deterministic, non-green
/// picture on every runner image, and the stripe proves it blurs.
///
/// Never key, never main, ignores the mouse, not an accessibility element
/// (the audit and app.windows never see it), and built only under the
/// UI-test flag (AppHygieneTests H-S4-3).
final class BackdropWindow: NSWindow {
  private let placement = BackdropPlacement()

  init(screenFrame: NSRect, dark: Bool) {
    precondition(TestHooks.isUITest, "the backdrop window is a UI-test fixture")
    super.init(contentRect: screenFrame, styleMask: [.borderless], backing: .buffered, defer: false)
    level = NSWindow.Level(rawValue: NSWindow.Level.normal.rawValue - 1)
    ignoresMouseEvents = true
    isReleasedWhenClosed = false
    hasShadow = false
    isOpaque = true
    collectionBehavior = [.stationary, .ignoresCycle, .fullScreenNone]
    contentView = NSHostingView(rootView: BackdropView(placement: placement, dark: dark))
    setAccessibilityElement(false)
  }

  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
  override func isAccessibilityElement() -> Bool { false }

  /// Moves the stripe band under the main window's FrostProbe.stripeBand.
  /// `main` is the main window's frame in screen coordinates.
  func place(under main: NSRect) {
    let screen = frame
    let origin = CGPoint(
      x: main.minX - screen.minX + FrostProbe.stripeBand.x,
      y: (screen.maxY - main.maxY) + FrostProbe.stripeBand.y)
    if placement.stripeOrigin != origin { placement.stripeOrigin = origin }
  }
}

/// Where the stripe band sits, in backdrop-local top-leading points.
@MainActor
@Observable
private final class BackdropPlacement {
  var stripeOrigin: CGPoint = .zero
}

private struct BackdropView: View {
  let placement: BackdropPlacement
  let dark: Bool

  var body: some View {
    let (top, bottom) = Tokens.Backdrop.stops(dark: dark)
    let stripe = FrostProbe.stripeWidth
    ZStack(alignment: .topLeading) {
      LinearGradient(colors: [Tokens.color(top), Tokens.color(bottom)], startPoint: .top, endPoint: .bottom)
      Canvas { context, size in
        context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(Tokens.color(Tokens.Backdrop.stripeLight)))
        var x: CGFloat = 0
        while x < size.width {
          context.fill(
            Path(CGRect(x: x, y: 0, width: stripe, height: size.height)),
            with: .color(Tokens.color(Tokens.Backdrop.stripeDark)))
          x += 2 * stripe
        }
      }
      .frame(width: FrostProbe.stripeBand.width, height: FrostProbe.stripeBand.height)
      .offset(x: placement.stripeOrigin.x, y: placement.stripeOrigin.y)
    }
    .ignoresSafeArea()
    .accessibilityHidden(true)
  }
}
