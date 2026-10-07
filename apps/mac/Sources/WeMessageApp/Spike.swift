import AppKit
import Observation
import SwiftUI

// S4a.0 MEASUREMENT SPIKE, branch build/s4-spike, never merged.
// Under WEMESSAGE_UI_TEST=1 and WEMESSAGE_SPIKE_FROST=<variant> the app
// opens a test-only backdrop window behind the main window and the main
// window draws one frost variant over it, so the UI test runner can measure
// what each capture path really sees.

/// The frost variants the spike cycles through.
enum SpikeFrost: String, CaseIterable, Sendable {
  /// Control: the window paints layer0, no frost.
  case opaque
  /// Control: a fully transparent window, the backdrop unblurred.
  case clear
  /// NSVisualEffectView, .underWindowBackground, behind-window blending.
  case underWindow
  /// NSVisualEffectView, .hudWindow, behind-window blending.
  case hud
  /// SwiftUI .glassEffect over a transparent window.
  case glass
  /// SwiftUI .containerBackground(.regularMaterial, for: .window).
  case container

  /// True when the main window must be non-opaque with a clear background.
  var wantsClearWindow: Bool { self != .opaque }
}

/// Window-local rectangles, points, top-leading origin. The UI test reads
/// the same numbers from the info label, never from literals of its own.
enum SpikeLayout {
  /// The black/white stripe band drawn on the backdrop under the window.
  static let stripeBand = CGRect(x: 260, y: 160, width: 200, height: 200)
  /// The opaque layer0 swatch drawn inside the window.
  static let layer0Swatch = CGRect(x: 60, y: 420, width: 120, height: 120)
  /// Stripe period in points: 2 black then 2 white.
  static let stripeWidth: CGFloat = 2
}

/// Where the backdrop draws the stripe band, in backdrop-local points.
@MainActor
@Observable
final class SpikeBackdropModel {
  var stripeOrigin: CGPoint = .zero
}

/// The test-only backdrop: borderless, screen-sized, one level below normal,
/// never key or main, ignores the mouse and is not an accessibility element.
final class BackdropWindow: NSWindow {
  let model = SpikeBackdropModel()

  init(screenFrame: NSRect, dark: Bool) {
    super.init(contentRect: screenFrame, styleMask: [.borderless], backing: .buffered, defer: false)
    level = NSWindow.Level(rawValue: NSWindow.Level.normal.rawValue - 1)
    ignoresMouseEvents = true
    isReleasedWhenClosed = false
    hasShadow = false
    isOpaque = true
    collectionBehavior = [.stationary, .ignoresCycle, .fullScreenNone]
    contentView = NSHostingView(rootView: SpikeBackdropView(model: model, dark: dark))
    setAccessibilityElement(false)
  }

  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
  override func isAccessibilityElement() -> Bool { false }

  /// Moves the stripe band under the main window's stripe rectangle.
  func place(under main: NSRect) {
    let screen = frame
    let x = main.minX - screen.minX + SpikeLayout.stripeBand.minX
    let y = (screen.maxY - main.maxY) + SpikeLayout.stripeBand.minY
    let origin = CGPoint(x: x, y: y)
    if model.stripeOrigin != origin { model.stripeOrigin = origin }
  }
}

private struct SpikeBackdropView: View {
  let model: SpikeBackdropModel
  let dark: Bool

  var body: some View {
    let top = dark ? Tokens.SpikeBackdrop.darkTop : Tokens.SpikeBackdrop.lightTop
    let bottom = dark ? Tokens.SpikeBackdrop.darkBottom : Tokens.SpikeBackdrop.lightBottom
    ZStack(alignment: .topLeading) {
      LinearGradient(colors: [Tokens.color(top), Tokens.color(bottom)], startPoint: .top, endPoint: .bottom)
      Canvas { ctx, size in
        ctx.fill(Path(CGRect(origin: .zero, size: size)), with: .color(.white))
        var x: CGFloat = 0
        while x < size.width {
          ctx.fill(Path(CGRect(x: x, y: 0, width: SpikeLayout.stripeWidth, height: size.height)), with: .color(.black))
          x += 2 * SpikeLayout.stripeWidth
        }
      }
      .frame(width: SpikeLayout.stripeBand.width, height: SpikeLayout.stripeBand.height)
      .offset(x: model.stripeOrigin.x, y: model.stripeOrigin.y)
    }
    .ignoresSafeArea()
    .accessibilityHidden(true)
  }
}

/// NSVisualEffectView, behind-window, always active (a runner window may
/// never become key, and an inactive material renders flat).
private struct SpikeEffect: NSViewRepresentable {
  let material: NSVisualEffectView.Material

  func makeNSView(context: Context) -> NSVisualEffectView {
    let view = NSVisualEffectView()
    view.material = material
    view.blendingMode = .behindWindow
    view.state = .active
    return view
  }

  func updateNSView(_ view: NSVisualEffectView, context: Context) {
    view.material = material
    view.state = .active
  }
}

/// The spike's main window content: one frost variant, a layer0 swatch and
/// an info line that carries the app-side readings.
struct SpikeView: View {
  let frost: SpikeFrost
  @Environment(\.colorScheme) private var scheme
  @Environment(\.accessibilityReduceTransparency) private var envReduce

  private var info: String {
    let workspace = NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency
    return
      "variant=\(frost.rawValue) appRT=\(workspace ? 1 : 0) envRT=\(envReduce ? 1 : 0) glass=compiled"
      + " stripe=\(Int(SpikeLayout.stripeBand.minX)),\(Int(SpikeLayout.stripeBand.minY)),"
      + "\(Int(SpikeLayout.stripeBand.width)),\(Int(SpikeLayout.stripeBand.height))"
      + " swatch=\(Int(SpikeLayout.layer0Swatch.minX)),\(Int(SpikeLayout.layer0Swatch.minY)),"
      + "\(Int(SpikeLayout.layer0Swatch.width)),\(Int(SpikeLayout.layer0Swatch.height))"
  }

  var body: some View {
    let palette = Tokens.palette(dark: scheme == .dark)
    let root = ZStack(alignment: .topLeading) {
      background(palette)
      Rectangle()
        .fill(Tokens.color(palette.layer0))
        .frame(width: SpikeLayout.layer0Swatch.width, height: SpikeLayout.layer0Swatch.height)
        .offset(x: SpikeLayout.layer0Swatch.minX, y: SpikeLayout.layer0Swatch.minY)
      VStack {
        Spacer(minLength: 0)
        HStack {
          Text(info)
            .font(.system(size: 9))
            .foregroundStyle(Tokens.color(palette.inkDim))
            .accessibilityValue(info)
            .accessibilityIdentifier("wemessage.spike.info")
          Spacer(minLength: 0)
        }
        .padding(4)
      }
    }
    .frame(minWidth: ProvisionalUI.windowMinWidth, minHeight: ProvisionalUI.windowMinHeight)
    .ignoresSafeArea()
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("wemessage.spike")
    .transaction { $0.disablesAnimations = true }

    if frost == .container {
      root.containerBackground(.regularMaterial, for: .window)
    } else {
      root
    }
  }

  @ViewBuilder
  private func background(_ palette: Tokens.Palette) -> some View {
    switch frost {
    case .opaque: Rectangle().fill(Tokens.color(palette.layer0))
    case .clear, .container: Color.clear
    case .underWindow: SpikeEffect(material: .underWindowBackground)
    case .hud: SpikeEffect(material: .hudWindow)
    case .glass: Color.clear.glassEffect(.regular, in: Rectangle())
    }
  }
}
