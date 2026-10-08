import SwiftUI
import WeMessageKit

/// Board 14 under the UI-test flag with WEMESSAGE_UI_BOARD=14: a window and
/// client of its own, over the fake daemon. The shipped cmd-N sheet is not
/// wired in this version (D-UI-95).
struct ComposeRoot: View {
  @State private var model = ComposeModel(
    client: GatewayClient(), people: TestHooks.composePeople, propose: TestHooks.composeProposal)

  var body: some View {
    ComposeWindow(model: model)
  }
}

/// Board 14: two pages behind the title band's tabs. New message is the
/// person-first compose (14.A to 14.E); Send states draws the six states
/// 14.F names, as specimens.
struct ComposeWindow: View {
  @Bindable var model: ComposeModel
  @State private var mirror = AccessibilityMirror.live()
  @Environment(\.colorScheme) private var scheme

  static let margin: Double = 16

  private var palette: Tokens.Palette { Tokens.palette(dark: scheme == .dark) }
  private var dark: Bool { scheme == .dark }

  var body: some View {
    GeometryReader { geometry in
      ZStack(alignment: .topLeading) {
        page
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
    .accessibilityIdentifier(ShellID.compose)
    .accessibilityValue(TestHooks.geometry.value ?? "")
    .accessibilityLabel(Text(TestHooks.geometry.value ?? ""))
    .transaction { if TestHooks.isUITest { $0.disablesAnimations = true } }
  }

  /// The title band: the board's name and the two tabs, clear of the lights.
  private var band: some View {
    HStack(spacing: 10) {
      Text("COMPOSE")
        .font(.system(size: 9, weight: .semibold))
        .tracking(1.4)
        .foregroundStyle(Tokens.color(palette.inkDim))
      ForEach(ComposeModel.Page.allCases, id: \.self) { page in
        let shown = page == model.page
        Button {
          model.page = page
        } label: {
          Text(page.title)
            .font(.system(size: 12, weight: shown ? .semibold : .regular))
            .foregroundStyle(Tokens.color(palette.ink))
            .padding(.vertical, 3)
            .padding(.horizontal, 10)
            .background(Capsule().fill(shown ? Tokens.color(palette.layer2) : Color.clear))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .focusable()
        .accessibilityLabel(page.title)
        .accessibilityValue(shown ? "shown" : "")
        .accessibilityIdentifier(ShellID.composeTabPrefix + page.rawValue)
      }
      Spacer(minLength: 8)
    }
    .padding(.leading, TitleBar.lightsReserve + 8)
    .padding(.trailing, Self.margin)
    .frame(height: ShellView.titleBand)
  }

  private var page: some View {
    ScrollView(.vertical) {
      VStack(alignment: .leading, spacing: 14) {
        switch model.page {
        case .new: NewMessagePage(model: model, palette: palette)
        case .states: SendStatesPage(palette: palette)
        }
      }
      .frame(maxWidth: 640, alignment: .topLeading)
      .padding(Self.margin)
      .frame(maxWidth: .infinity, alignment: .topLeading)
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(model.page.title)
    .accessibilityIdentifier(ShellID.composePagePrefix + model.page.rawValue)
  }
}
