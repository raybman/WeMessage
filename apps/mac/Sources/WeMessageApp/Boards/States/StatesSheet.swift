import SwiftUI
import WeMessageKit

/// What board 10.B's sheet draws: the six empties' facts, the age table's
/// rows, today's sends and the agent that collided, all as of one instant.
/// Built only by the test hooks' catalogue (H-S4-6).
struct StatesContent {
  let facts: EmptyFacts
  let rows: [FreshnessRow]
  let sendsToday: Int
  let asOf: Date
  let agent: String

  /// The sheet prints UTC, as the fixtures are written.
  static let zone = TimeZone(identifier: "UTC") ?? .current
}

/// Board 10's sheet: the six empties stacked on one page (10.B), and the
/// Settings copy of the age table, the pacing table and the collision
/// notice on the other (10.A, 10.D, 10.E). Reachable only under the
/// UI-test flag with WEMESSAGE_UI_BOARD=10.B; no menu item and no key lead
/// here (H-S4-6). Every action is drawn and announced and does nothing.
struct StatesSheet: View {
  let content: StatesContent
  @State private var mirror = AccessibilityMirror.live()
  @State private var page = Page.empties
  @Environment(\.colorScheme) private var scheme

  enum Page: String, CaseIterable {
    case empties
    case settings

    var title: String {
      switch self {
      case .empties: "Empty states"
      case .settings: "Ages and pacing"
      }
    }
  }

  static let margin: Double = 16

  private var palette: Tokens.Palette { Tokens.palette(dark: scheme == .dark) }
  private var dark: Bool { scheme == .dark }

  var body: some View {
    GeometryReader { geometry in
      ZStack(alignment: .topLeading) {
        Group {
          switch page {
          case .empties: empties
          case .settings: settings
          }
        }
        .padding(.horizontal, Self.margin)
        .padding(.top, ShellView.titleBand + 0.5 + 12)
        .padding(.bottom, Self.margin)
        .frame(width: geometry.size.width, height: geometry.size.height, alignment: .topLeading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(page.title)
        .accessibilityIdentifier(ShellID.statesPagePrefix + page.rawValue)
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
    .accessibilityIdentifier(ShellID.states)
    .accessibilityValue(TestHooks.geometry.value ?? "")
    .accessibilityLabel(Text(TestHooks.geometry.value ?? ""))
    .transaction { if TestHooks.isUITest { $0.disablesAnimations = true } }
  }

  /// The six, two rows of three, each its own cause and one action.
  private var empties: some View {
    let copies = EmptyStateCase.allCases.map { EmptyStates.copy($0, content.facts, zone: StatesContent.zone) }
    return VStack(spacing: 12) {
      ForEach([0, 3], id: \.self) { start in
        HStack(spacing: 12) {
          ForEach(copies[start..<start + 3], id: \.kind) { copy in
            EmptyStateView(copy: copy, palette: palette)
          }
        }
      }
    }
  }

  /// The Settings copy: the same age table as the rail's popover, iMessage's
  /// pacing rows and the collision notice.
  private var settings: some View {
    HStack(alignment: .top, spacing: 16) {
      VStack(alignment: .leading, spacing: 16) {
        FreshnessTable(rows: content.rows, palette: palette, zone: StatesContent.zone)
        PacingTable(
          rows: Pacing.rows(sendsToday: content.sendsToday),
          footer: Pacing.footer(asOf: content.asOf, zone: StatesContent.zone), palette: palette)
      }
      .frame(maxWidth: 460, alignment: .topLeading)
      CollisionNoticeView(agent: content.agent, palette: palette)
        .frame(maxWidth: 520, alignment: .topLeading)
      Spacer(minLength: 0)
    }
  }

  /// The title band: the sheet's name and one tab per page, clear of the
  /// traffic lights.
  private var band: some View {
    HStack(spacing: 10) {
      Text("STATES")
        .font(.system(size: 9, weight: .semibold))
        .tracking(1.4)
        .foregroundStyle(Tokens.color(palette.inkDim))
      Text(page.title)
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
        .lineLimit(1)
        .accessibilityAddTraits(.isHeader)
      Spacer(minLength: 8)
      ForEach(Page.allCases, id: \.self) { tab in
        Button {
          page = tab
        } label: {
          Text(tab.title)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(Tokens.color(tab == page ? palette.layer1 : palette.ink))
            .padding(.vertical, 4)
            .padding(.horizontal, 10)
            .background(Capsule().fill(tab == page ? Tokens.color(palette.ink) : Color.clear))
            .overlay(Capsule().strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .focusable()
        .accessibilityLabel(tab.title)
        .accessibilityValue(tab == page ? "shown" : "")
        .accessibilityIdentifier(ShellID.statesTabPrefix + tab.rawValue)
      }
    }
    .padding(.leading, TitleBar.lightsReserve + 8)
    .padding(.trailing, Self.margin)
    .frame(height: ShellView.titleBand)
  }
}
