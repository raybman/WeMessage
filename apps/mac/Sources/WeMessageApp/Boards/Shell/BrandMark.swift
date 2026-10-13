import SwiftUI

/// v2 F11: the WeMessage mark, drawn from site/logo/mark.svg's geometry
/// (the canonical asset) in its 96-unit view box: the flat blue bubble, the
/// straight tail and the WM monoline ligature. The numbers below are the
/// SVG's; BrandTests reads the SVG and holds them equal, so the app's mark
/// cannot drift from the brand file.
struct BrandMark: View {
  var size: CGFloat = 26

  enum Geometry {
    static let viewBox: CGFloat = 96
    static let bubble = CGRect(x: 6, y: 12, width: 84, height: 60)
    static let bubbleRadius: CGFloat = 19
    static let tail: [CGPoint] = [CGPoint(x: 60, y: 70), CGPoint(x: 86, y: 84), CGPoint(x: 78, y: 58)]
    /// The W, then the M; the W's last upstroke and the M's stem meet at (52, 27).
    static let strokes: [[CGPoint]] = [
      [CGPoint(x: 17, y: 27), CGPoint(x: 26.5, y: 57), CGPoint(x: 34, y: 39), CGPoint(x: 41.5, y: 57), CGPoint(x: 52, y: 27)],
      [CGPoint(x: 52, y: 57), CGPoint(x: 52, y: 27), CGPoint(x: 66, y: 45.5), CGPoint(x: 79, y: 27), CGPoint(x: 79, y: 57)],
    ]
    static let strokeWidth: CGFloat = 6.5
  }

  var body: some View {
    Canvas { context, canvas in
      let k = min(canvas.width, canvas.height) / Geometry.viewBox
      context.scaleBy(x: k, y: k)
      let fill = Tokens.color(Tokens.Brand.mark)
      context.fill(Path(roundedRect: Geometry.bubble, cornerRadius: Geometry.bubbleRadius), with: .color(fill))
      var tail = Path()
      tail.addLines(Geometry.tail)
      tail.closeSubpath()
      context.fill(tail, with: .color(fill))
      let style = StrokeStyle(lineWidth: Geometry.strokeWidth, lineCap: .round, lineJoin: .round)
      for points in Geometry.strokes {
        var line = Path()
        line.addLines(points)
        context.stroke(line, with: .color(Tokens.color(Tokens.Brand.markStroke)), style: style)
      }
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}

/// The lockup after the traffic lights: the mark and the wordmark, "We" in
/// the house blue and "Message" in ink (Tokens.Brand). One element, named
/// WeMessage.
struct BrandLockup: View {
  let palette: Tokens.Palette
  let dark: Bool

  var body: some View {
    HStack(spacing: 7) {
      BrandMark(size: 26)
      Text("\(Text("We").foregroundColor(Tokens.color(Tokens.Brand.we(dark: dark))))\(Text("Message").foregroundColor(Tokens.color(palette.ink)))")
        .font(.system(size: 15, weight: .bold))
        .tracking(-0.2)
        .lineLimit(1)
        .fixedSize()
    }
    // One element, read as text: ignored alone a stack is role Other, which
    // the audit fails as "Unknown role" (run 38367575787).
    .accessibilityElement(children: .ignore)
    .accessibilityAddTraits(.isStaticText)
    .accessibilityLabel("WeMessage")
    .accessibilityIdentifier(ShellID.titleBrand)
  }
}

/// The search field in the middle of the bar. Not a text field: it opens
/// board 11's search pane (the same call as shift-cmd-F, which Board11Keys
/// binds; this button binds no key of its own). On a narrow window it is
/// the magnifier alone.
struct TitleSearchField: View {
  let model: ShellModel
  let palette: Tokens.Palette

  static let hint = "Search people and messages"
  static let shortHint = "Search"
  static let maxWidth: CGFloat = 420
  /// Widest first; the last field step keeps the word and the keys at the
  /// default 1024 pt window, and only a narrower bar drops to the magnifier.
  static let widths: [CGFloat] = [maxWidth, 300, 230]
  static let compactWidth: CGFloat = 150

  private func field(width: CGFloat, hint: String = Self.hint) -> some View {
    HStack(spacing: 6) {
      Image(systemName: "magnifyingglass").font(.system(size: 11, weight: .medium))
      Text(hint).font(.system(size: 12)).lineLimit(1)
      Spacer(minLength: 8)
      Text("\u{21E7}\u{2318}F").font(.system(size: 10, weight: .medium, design: .monospaced))
    }
    .foregroundStyle(Tokens.color(palette.inkDim))
    .padding(.horizontal, 10)
    .frame(width: width, height: 28)
    .background(RoundedRectangle(cornerRadius: 8).fill(Tokens.color(palette.layer1)))
    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Tokens.color(palette.inkDim, opacity: 0.25), lineWidth: 1))
  }

  private var icon: some View {
    Image(systemName: "magnifyingglass")
      .font(.system(size: 12, weight: .medium))
      .foregroundStyle(Tokens.color(palette.inkDim))
      .frame(width: 28, height: 28)
      .background(RoundedRectangle(cornerRadius: 8).fill(Tokens.color(palette.layer1)))
      .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Tokens.color(palette.inkDim, opacity: 0.25), lineWidth: 1))
  }

  var body: some View {
    Button {
      model.openSearch()
    } label: {
      ViewThatFits(in: .horizontal) {
        field(width: Self.widths[0])
        field(width: Self.widths[1], hint: Self.shortHint)
        field(width: Self.widths[2], hint: Self.shortHint)
        field(width: Self.compactWidth, hint: Self.shortHint)
        icon
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .focusable()
    .accessibilityLabel(Self.hint)
    .accessibilityHint("Opens search, shift-command-F")
    .accessibilityIdentifier(ShellID.titleSearch)
  }
}

/// The bar's blue wash (header B): the tint from the leading edge, clear by
/// Tokens.Brand.washEnd of the width. Reduce Transparency draws none, so
/// the bar is the plain layer0 the rest of the window is.
struct TitleWash: View {
  let mirror: AccessibilityMirror
  let dark: Bool

  static func shown(_ mirror: AccessibilityMirror) -> Bool { !mirror.reduceTransparency }

  var body: some View {
    if Self.shown(mirror) {
      LinearGradient(
        stops: [
          .init(color: Tokens.color(Tokens.Brand.wash(dark: dark)), location: 0),
          .init(color: Tokens.color(Tokens.Brand.wash(dark: dark).rgb, opacity: 0), location: Tokens.Brand.washEnd),
        ],
        startPoint: .leading,
        endPoint: .trailing
      )
      .accessibilityHidden(true)
    }
  }
}
