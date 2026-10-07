import SwiftUI
import WeMessageKit

/// What board 08's specimen sheet draws: the atlas golden's sections, the
/// one agent draft and the thread it sits in, and the instant the golden
/// is read as of. Built only by the test hooks' catalogue (H-S4-4).
struct SpecimenContent {
  let golden: AtlasGolden
  let draft: DraftPayload
  let thread: ThreadSummary
  let asOf: Date

  /// The sheet prints UTC, as the golden is written.
  static let zone = TimeZone(identifier: "UTC") ?? .current

  func section(_ slug: String) -> AtlasGolden.Section? {
    golden.sections.first { $0.slug == slug }
  }

  func turn(_ guid: String) -> MessageTurn? {
    for section in golden.sections {
      if let turn = section.turns.first(where: { $0.guid == guid }) { return turn }
    }
    return nil
  }
}

/// Board 08, the message atlas: every specimen the thread views are built
/// from, drawn by the same components, one page per section (08.A..08.J,
/// D-UI-42). Reachable only under the UI-test flag with
/// WEMESSAGE_UI_BOARD=08; no menu item and no key lead here (H-S4-4).
///
/// The pages are two columns either side of FrostProbe.atlasGutter, so the
/// frost evidence reads bare window in every shot.
struct SpecimenSheet: View {
  let content: SpecimenContent
  @State private var mirror = AccessibilityMirror.live()
  @State private var page = 0
  @Environment(\.colorScheme) private var scheme

  /// The sheet's side margin.
  static let margin: Double = 16

  private var palette: Tokens.Palette { Tokens.palette(dark: scheme == .dark) }
  private var dark: Bool { scheme == .dark }

  /// "A" for the first section, and on.
  static func letter(_ index: Int) -> String {
    String(UnicodeScalar(UInt8(65 + index)))
  }

  var body: some View {
    GeometryReader { geometry in
      let gutter = FrostProbe.atlasGutter
      let left = gutter.x - Self.margin
      let right = max(0, geometry.size.width - Self.margin - (gutter.x + gutter.width))
      ZStack(alignment: .topLeading) {
        if content.golden.sections.indices.contains(page) {
          let section = content.golden.sections[page]
          AtlasPage(
            slug: section.slug, content: content, palette: palette, left: left, gutter: gutter.width, right: right
          )
          .padding(.leading, Self.margin)
          .padding(.top, ShellView.titleBand + 0.5 + 12)
          .accessibilityElement(children: .contain)
          .accessibilityLabel("08." + Self.letter(page) + " " + section.title)
          .accessibilityIdentifier(ShellID.atlasPagePrefix + section.slug)
        }
        VStack(spacing: 0) {
          band
          Hairline(mirror: mirror, palette: palette, dark: dark, horizontal: true)
        }
      }
      .frame(width: geometry.size.width, height: geometry.size.height, alignment: .topLeading)
    }
    .frame(minWidth: ProvisionalUI.windowMinWidth, minHeight: ProvisionalUI.windowMinHeight)
    .ignoresSafeArea()
    .modifier(FrostBackground(mirror: mirror, palette: palette))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier(ShellID.atlas)
    // Under the UI-test flag only, the pinned geometry, as the shell root
    // publishes it.
    .accessibilityValue(TestHooks.geometry.value ?? "")
    .accessibilityLabel(Text(TestHooks.geometry.value ?? ""))
    .transaction { if TestHooks.isUITest { $0.disablesAnimations = true } }
  }

  /// The title band: the sheet's name, the section's badge and title, and
  /// the page marker (D-UI-42), clear of the traffic lights.
  private var band: some View {
    HStack(spacing: 10) {
      Text("MESSAGE ATLAS")
        .font(.system(size: 9, weight: .semibold))
        .tracking(1.4)
        .foregroundStyle(Tokens.color(palette.inkDim))
      if content.golden.sections.indices.contains(page) {
        Text("08." + Self.letter(page))
          .font(.system(size: 10, weight: .bold, design: .monospaced))
          .foregroundStyle(Tokens.color(palette.layer1))
          .padding(.vertical, 3)
          .padding(.horizontal, 6)
          .background(RoundedRectangle(cornerRadius: 4).fill(Tokens.color(palette.ink)))
          .accessibilityHidden(true)
        Text(content.golden.sections[page].title)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.ink))
          .lineLimit(1)
          .accessibilityAddTraits(.isHeader)
      }
      Spacer(minLength: 8)
      switch ProvisionalUI.atlasPageMarker {
      case .tintDots: dots
      }
    }
    .padding(.leading, TitleBar.lightsReserve + 8)
    .padding(.trailing, Self.margin)
    .frame(height: ShellView.titleBand)
  }

  /// One tint dot per page, filled for the page shown. Each is a button
  /// with a 24 pt target and no key.
  private var dots: some View {
    HStack(spacing: 0) {
      ForEach(Array(content.golden.sections.enumerated()), id: \.offset) { index, _ in
        Button {
          page = index
        } label: {
          Circle()
            .fill(index == page ? Tokens.color(Tokens.tint) : Color.clear)
            .overlay(Circle().strokeBorder(Tokens.color(Tokens.tint), lineWidth: 1))
            .frame(width: 8, height: 8)
            .frame(width: 24, height: 24)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Specimen page 08." + Self.letter(index))
        .accessibilityValue(index == page ? "shown" : "")
      }
    }
  }
}

// MARK: The sheet's type

/// A small-caps specimen label (wireframe .lab).
struct AtlasLabel: View {
  let text: String
  let palette: Tokens.Palette

  init(_ text: String, palette: Tokens.Palette) {
    self.text = text
    self.palette = palette
  }

  var body: some View {
    Text(text.uppercased())
      .font(.system(size: 9, weight: .semibold))
      .tracking(1.2)
      .foregroundStyle(Tokens.color(palette.inkDim))
      .accessibilityAddTraits(.isHeader)
  }
}

/// A section's lead paragraph; **bold** where the wireframe bolds.
struct AtlasLead: View {
  let text: String
  let palette: Tokens.Palette

  init(_ text: String, palette: Tokens.Palette) {
    self.text = text
    self.palette = palette
  }

  var body: some View {
    Text(LocalizedStringKey(text))
      .font(.system(size: 11))
      .foregroundStyle(Tokens.color(palette.inkDim))
      .fixedSize(horizontal: false, vertical: true)
  }
}

/// A numbered note (wireframe .legend): an ink disc and the sentence.
struct AtlasNote: View {
  let number: Int
  let text: String
  let palette: Tokens.Palette

  init(_ number: Int, _ text: String, palette: Tokens.Palette) {
    self.number = number
    self.text = text
    self.palette = palette
  }

  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      Circle()
        .fill(Tokens.color(palette.ink))
        .overlay(
          Text("\(number)").font(.system(size: 9, weight: .bold)).foregroundStyle(Tokens.color(palette.layer1))
        )
        .frame(width: 16, height: 16)
        .accessibilityHidden(true)
      Text(LocalizedStringKey(text))
        .font(.system(size: 10))
        .foregroundStyle(Tokens.color(palette.ink))
        .fixedSize(horizontal: false, vertical: true)
    }
  }
}

/// A paper card with a 1 pt ink rule (wireframe .frame).
struct AtlasCard<Content: View>: View {
  let palette: Tokens.Palette
  @ViewBuilder let content: Content

  var body: some View {
    content
      .padding(12)
      .frame(maxWidth: .infinity, alignment: .topLeading)
      .background(RoundedRectangle(cornerRadius: 10).fill(Tokens.color(palette.layer1)))
      .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
  }
}

/// The two columns of a page, either side of the bare gutter.
struct AtlasColumns<Leading: View, Trailing: View>: View {
  let left: Double
  let gutter: Double
  let right: Double
  @ViewBuilder let leading: Leading
  @ViewBuilder let trailing: Trailing

  var body: some View {
    HStack(alignment: .top, spacing: 0) {
      VStack(alignment: .leading, spacing: 8) { leading }
        .frame(width: left, alignment: .topLeading)
      Color.clear.frame(width: gutter, height: 1).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 8) { trailing }
        .frame(width: right, alignment: .topLeading)
    }
  }
}
