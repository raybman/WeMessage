import SwiftUI
import WeMessageKit

/// Board 17 under the UI-test flag with WEMESSAGE_UI_BOARD=17 (D-UI-121):
/// the meters, the ribbon, the tiles, the card and the three zero screens
/// over fixtures, a page each, beside the rail and title bar marks 17.G
/// adds to the chrome. No menu item, key or link opens it in this version
/// (D-UI-123). It builds no client; nothing here sends.
struct ProgressWindow: View {
  enum Page: String, CaseIterable {
    case meters, atzero, degraded, streak, broken, stats, card, cardzero, chrome, earned, still, quiet

    var title: String {
      switch self {
      case .meters: "Meters"
      case .atzero: "At zero"
      case .degraded: "Degraded"
      case .streak: "Streak"
      case .broken: "Broken"
      case .stats: "Stats"
      case .card: "Card"
      case .cardzero: "Card at 0"
      case .chrome: "Chrome"
      case .earned: "Earned"
      case .still: "Still clear"
      case .quiet: "Quiet"
      }
    }
  }

  @State private var page: Page = .meters
  @State private var mirror = AccessibilityMirror.live()
  @State private var verified = 0
  @Environment(\.colorScheme) private var scheme
  private let content = TestHooks.progressContent

  private var palette: Tokens.Palette { Tokens.palette(dark: scheme == .dark) }
  private var dark: Bool { scheme == .dark }

  var body: some View {
    GeometryReader { geometry in
      ZStack(alignment: .topLeading) {
        pageView
          .padding(.top, ShellView.titleBand + 0.5)
          .frame(width: geometry.size.width, height: geometry.size.height, alignment: .topLeading)
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
    .accessibilityIdentifier(ShellID.progress)
    .accessibilityValue(TestHooks.geometry.value ?? "")
    .accessibilityLabel(Text(TestHooks.geometry.value ?? ""))
    .transaction { if TestHooks.isUITest { $0.disablesAnimations = true } }
  }

  private var band: some View {
    HStack(spacing: 6) {
      Text("PROGRESS")
        .font(.system(size: 9, weight: .semibold))
        .tracking(1.4)
        .foregroundStyle(Tokens.color(palette.inkDim))
        .padding(.trailing, 4)
      ForEach(Page.allCases, id: \.self) { item in
        let shown = item == page
        Button {
          page = item
        } label: {
          Text(item.title)
            .font(.system(size: 11, weight: shown ? .semibold : .regular))
            .foregroundStyle(Tokens.color(palette.ink))
            .lineLimit(1)
            .fixedSize()
            .padding(.vertical, 3)
            .padding(.horizontal, 8)
            .background(Capsule().fill(shown ? Tokens.color(palette.layer2) : Color.clear))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .focusable()
        .accessibilityLabel(item.title)
        .accessibilityValue(shown ? "shown" : "")
        .accessibilityIdentifier(ShellID.progressTabPrefix + item.rawValue)
      }
      Spacer(minLength: 8)
    }
    .padding(.leading, TitleBar.lightsReserve + 8)
    .padding(.trailing, 16)
    .frame(height: ShellView.titleBand)
  }

  @ViewBuilder
  private var pageView: some View {
    switch page {
    case .meters:
      metersPage(content.notZero, note: ProgressWords.noFraction)
    case .atzero:
      metersPage(content.atZero, note: ProgressWords.conjunction)
    case .degraded:
      metersPage(content.degraded, note: ProgressWords.fourStates)
    case .streak:
      StreakPanelView(panel: content.intact, palette: palette).padding(24)
    case .broken:
      StreakPanelView(panel: content.broken, palette: palette).padding(24)
    case .stats:
      StatsPage(caption: content.statsCaption, stats: content.stats, palette: palette).padding(24)
    case .card:
      CardPage(card: content.card, palette: palette).padding(24)
    case .cardzero:
      CardPage(card: content.card.zeroed(), palette: palette).padding(24)
    case .chrome:
      ChromePage(content: content, palette: palette).padding(24)
    case .earned:
      zeroPage(content.earned)
    case .still:
      zeroPage(content.still)
    case .quiet:
      zeroPage(content.quiet)
    }
  }

  private func metersPage(_ panel: MeterPanel, note: String) -> some View {
    HStack(alignment: .top, spacing: 24) {
      MeterPanelView(panel: panel, palette: palette)
        .frame(width: 600)
      Text(note)
        .font(.system(size: 11))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .fixedSize(horizontal: false, vertical: true)
        .padding(.top, 26)
        .frame(maxWidth: 300, alignment: .leading)
    }
    .padding(24)
  }

  /// One zero screen in a window of its own size, under the title bar's
  /// CLEAR with its baseline (17.H).
  private func zeroPage(_ zero: ZeroContent) -> some View {
    VStack(spacing: 0) {
      HStack {
        Text("All Messages")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.ink))
        Spacer(minLength: 0)
        TitleCounter(counter: content.titleClear, channel: "", palette: palette)
          .accessibilityLabel(ProgressWords.counter(content.titleClear))
          .accessibilityIdentifier(ShellID.titleCounter)
      }
      .padding(.horizontal, 16)
      .frame(height: 44)
      Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.35)).frame(height: 1).accessibilityHidden(true)
      ZeroPanel(content: zero, palette: palette, onVerify: { verified += 1 }, onProgress: { page = .meters })
        .padding(.vertical, 28)
        .padding(.horizontal, 24)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Zero: clear")
        .accessibilityIdentifier(ShellID.zero)
    }
    .frame(width: 460)
    .background(RoundedRectangle(cornerRadius: 10).fill(Tokens.color(palette.layer1)))
    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
    .padding(24)
  }
}

/// The notes beside the meter panels, from 17.A and 17.B.
enum ProgressWords {
  static let noFraction =
    "No row carries a fraction of its own, a target, or a comparison with yesterday. The track's only denominator is today's arrivals, which we wrote ourselves."
  static let conjunction =
    "The global row is CLEAR if and only if every connected channel is clear and fresh. It is never an average of the rows above it."
  /// The title counter in words, with its clock: "9 left as of 16:42:07",
  /// "Clear as of 18:07:41".
  static func counter(_ counter: ShellBoard.Counter) -> String {
    switch counter {
    case .left(let n, let asOf): "\(n) left as of " + ShellText.clock(asOf)
    case .clear(let asOf): "Clear as of " + ShellText.clock(asOf)
    case .cannotSay: "Cannot say"
    case .hidden: ""
    }
  }

  static let fourStates =
    "Four states per row, one mark each: a number means items are waiting; CLEAR with the baseline means earned zero on a fresh source; ? with a hatched track means we cannot tell; a dashed empty slot means not connected."
}

/// The five tiles (17.D), the unwelcome one first and emphasized.
private struct StatsPage: View {
  let caption: String
  let stats: [StatItem]
  let palette: Tokens.Palette

  private func tile(_ item: StatItem) -> some View {
    StatTile(
      key: item.key.rawValue, label: item.label, value: item.value, caveat: item.caveat,
      emphasized: item.emphasized, palette: palette)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(caption.uppercased())
        .font(.system(size: 10, weight: .semibold))
        .tracking(1.2)
        .foregroundStyle(Tokens.color(palette.ink))
        .accessibilityAddTraits(.isHeader)
      Grid(horizontalSpacing: 12, verticalSpacing: 12) {
        ForEach(0..<(stats.count / 2), id: \.self) { pair in
          GridRow {
            tile(stats[pair * 2])
            tile(stats[pair * 2 + 1])
          }
        }
        if !stats.count.isMultiple(of: 2), let last = stats.last {
          GridRow {
            tile(last).gridCellColumns(2)
          }
        }
      }
      .frame(maxWidth: 780)
    }
  }
}

/// The card at its export size, with the three ways it leaves (17.E). The
/// status line's label says what the last export did, for the UI test.
private struct CardPage: View {
  let card: ShareCard
  let palette: Tokens.Palette

  @State private var data: Data?
  @State private var pasteboard = "none"
  @State private var saved = "none"

  private var status: String {
    let size = data.flatMap { NSBitmapImageRep(data: $0) }.map { "\($0.pixelsWide)x\($0.pixelsHigh)" } ?? "none"
    let boxes = ShareCardView.numeralBoxes.map {
      "\(Int($0.minX)),\(Int($0.minY)),\(Int($0.width)),\(Int($0.height))"
    }.joined(separator: ";")
    return "png=\(size) bytes=\(data?.count ?? 0) pasteboard=\(pasteboard) saved=\(saved) boxes=\(boxes)"
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      ShareCardView(card: card)
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isImage)
        .accessibilityLabel("Shareable card")
        .accessibilityIdentifier(ShellID.card)
      HStack(spacing: 10) {
        QueueButton(title: "Copy Image", key: nil, filled: true, palette: palette) {
          guard let data else { return }
          pasteboard = ShareCardExport.copy(data, uiTest: TestHooks.isUITest).rawValue
        }
        .accessibilityLabel("Copy Image")
        .accessibilityIdentifier(ShellID.cardCopy)
        QueueButton(title: "Save to File\u{2026}", key: nil, filled: false, palette: palette) {
          guard let data else { return }
          let url = ShareCardExport.save(data, uiTest: TestHooks.isUITest)
          saved = url == nil ? "none" : TestHooks.isUITest ? "temporary folder" : "file"
        }
        .accessibilityLabel("Save to File")
        .accessibilityIdentifier(ShellID.cardSave)
        if let data, let image = ShareCardExport.image(data) {
          ShareLink(item: image, preview: SharePreview("WeMessage card", image: image)) {
            Text("Share\u{2026}")
              .font(.system(size: 11, weight: .semibold))
              .foregroundStyle(Tokens.color(palette.ink))
              .padding(.vertical, 6)
              .padding(.horizontal, 10)
              .background(RoundedRectangle(cornerRadius: 6).fill(Tokens.color(palette.layer1)))
              .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Share")
          .accessibilityIdentifier(ShellID.cardShare)
        }
        Text("PNG, 640x400, rendered locally")
          .font(.system(size: 11))
          .foregroundStyle(Tokens.color(palette.inkDim))
          .accessibilityAddTraits(.isStaticText)
          .accessibilityLabel(status)
          .accessibilityIdentifier(ShellID.cardStatus)
      }
    }
    .task(id: card) { data = ShareCardExport.png(card) }
  }
}

/// 17.G: the rail's four tile states at once and the title bar's two, the
/// marks board 17 adds to chrome. The baseline is the only new one; no
/// chrome surface carries a run, a fraction or a delta.
private struct ChromePage: View {
  let content: ProgressContent
  let palette: Tokens.Palette

  private func markWords(_ mark: RailMark) -> String {
    switch mark {
    case .digit(let n): "\(n) waiting"
    case .baseline: "clear and fresh"
    case .stale: "cannot tell"
    case .none: "not connected"
    }
  }

  var body: some View {
    HStack(alignment: .top, spacing: 32) {
      VStack(spacing: 10) {
        ForEach(ShellModel.Scope.allCases, id: \.self) { scope in
          let mark = content.rail[scope] ?? RailMark.none
          RailTile(scope: scope, selected: scope == .all, mark: mark, palette: palette) {}
            .accessibilityLabel(scope.fullLabel + ": " + markWords(mark))
            .accessibilityIdentifier(ShellID.rail(scope))
        }
      }
      .padding(10)
      .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
      VStack(alignment: .leading, spacing: 16) {
        Text("RAIL AND TITLE BAR")
          .font(.system(size: 10, weight: .semibold))
          .tracking(1.2)
          .foregroundStyle(Tokens.color(palette.ink))
          .accessibilityAddTraits(.isHeader)
        Text(
          "A digit is items waiting. ! is a stale source, never a count. The baseline under a tile is clear and fresh, not a check. A tile with no mark is not connected. ALL inherits the worst tile."
        )
        .font(.system(size: 11))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: 420, alignment: .leading)
        bar(content.titleLeft, id: nil)
        bar(content.titleClear, id: ShellID.titleCounter)
      }
    }
  }

  private func bar(_ counter: ShellBoard.Counter, id: String?) -> some View {
    HStack {
      Text("All Messages")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
      Spacer(minLength: 24)
      TitleCounter(counter: counter, channel: "", palette: palette)
        .accessibilityAddTraits(.isStaticText)
        .accessibilityLabel(ProgressWords.counter(counter))
        .accessibilityIdentifier(id ?? "")
    }
    .padding(.horizontal, 16)
    .frame(width: 420, height: 48)
    .background(RoundedRectangle(cornerRadius: 8).fill(Tokens.color(palette.layer1)))
    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Tokens.color(palette.inkDim, opacity: 0.5), lineWidth: 1))
  }
}
