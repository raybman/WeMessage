import SwiftUI
import WeMessageKit

/// The first window: channel rail, sidebar with the lens and the connection
/// line, and the content pane. S3 keeps the whole view tree in this file on
/// purpose; S4 splits it per board.
///
/// The accessibility identifiers below are the contract with the UI tests
/// (AppHygieneTests H-A5 holds both sides to the same list).
struct ShellView: View {
  /// The client reads WEMESSAGE_PORT and WEMESSAGE_DIR/daemon.token from the
  /// environment, as the shipped app does (H10-H12).
  @State private var model = ShellModel(client: GatewayClient())
  @Environment(\.colorScheme) private var scheme

  /// The title band the hidden title bar leaves to the traffic lights.
  static let titleBand: CGFloat = 52
  static let sidebarWidth: CGFloat = 248

  private var palette: Tokens.Palette { Tokens.palette(dark: scheme == .dark) }

  var body: some View {
    HStack(spacing: 0) {
      RailView(model: model, palette: palette)
      SidebarView(model: model, palette: palette)
      ContentPane(palette: palette)
    }
    .frame(minWidth: ProvisionalUI.windowMinWidth, minHeight: ProvisionalUI.windowMinHeight)
    .background(Tokens.color(palette.layer0))
    .ignoresSafeArea()
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("wemessage.shell")
    // Under the UI-test flag only, the pinned geometry. Measured (run
    // 37553425686): a SwiftUI container's value never reaches AX on macOS,
    // so it rides the label too, and the delegate sets it on the window.
    .accessibilityValue(TestHooks.geometry.value ?? "")
    .accessibilityLabel(Text(TestHooks.geometry.value ?? ""))
    .task { model.start() }
  }
}

/// The channel rail: one tile per scope.
private struct RailView: View {
  let model: ShellModel
  let palette: Tokens.Palette

  static func identifier(_ scope: ShellModel.Scope) -> String {
    switch scope {
    case .all: "wemessage.rail.all"
    case .imessage: "wemessage.rail.imessage"
    case .whatsapp: "wemessage.rail.whatsapp"
    case .linkedin: "wemessage.rail.linkedin"
    case .email: "wemessage.rail.email"
    }
  }

  var body: some View {
    VStack(spacing: 6) {
      Color.clear.frame(height: ShellView.titleBand)
      ForEach(ShellModel.Scope.allCases, id: \.self) { scope in
        RailTile(scope: scope, selected: model.scope == scope, palette: palette) { model.scope = scope }
          .accessibilityLabel(scope.fullLabel)
          .keyboardShortcut(KeyEquivalent(scope.shortcutDigit), modifiers: .command)
          .accessibilityIdentifier(Self.identifier(scope))
      }
      Spacer(minLength: 0)
    }
    .frame(width: ProvisionalUI.railWidth)
    .frame(maxHeight: .infinity)
    .background(Tokens.color(palette.layer1))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("wemessage.rail")
  }
}

private struct RailTile: View {
  let scope: ShellModel.Scope
  let selected: Bool
  let palette: Tokens.Palette
  let action: () -> Void

  private var labelColor: Color {
    guard selected else { return Tokens.color(palette.ink) }
    switch ProvisionalUI.selectedTile {
    case .filledTint: return .white
    case .tintLabel, .tintBar: return Tokens.color(Tokens.tint)
    }
  }

  var body: some View {
    Button(action: action) {
      Text(scope.label)
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(labelColor)
        .frame(width: 42, height: 36)
        .background {
          if selected && ProvisionalUI.selectedTile == .filledTint {
            RoundedRectangle(cornerRadius: 8).fill(Tokens.color(Tokens.tint))
          }
        }
        .overlay(alignment: .leading) {
          if selected && ProvisionalUI.selectedTile == .tintBar {
            Rectangle().fill(Tokens.color(Tokens.tint)).frame(width: 3)
          }
        }
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    // A plain-style button is not a Tab stop on macOS; this makes each tile one.
    .focusable()
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}

/// The sidebar: the lens, the (empty) list and the connection line.
private struct SidebarView: View {
  @Bindable var model: ShellModel
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Color.clear.frame(height: ShellView.titleBand)
      Picker("Lens", selection: $model.lens) {
        ForEach(ShellModel.Lens.allCases, id: \.self) { lens in
          Text(lens.label).tag(lens)
        }
      }
      .pickerStyle(.segmented)
      .labelsHidden()
      .accessibilityLabel("Lens")
      .accessibilityIdentifier("wemessage.lens")
      Spacer(minLength: 0)
      Text(ProvisionalUI.sidebarEmpty)
        .font(.system(size: 13))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("wemessage.sidebar.empty")
      Spacer(minLength: 0)
      Text(model.connectionLine)
        .font(.system(size: ProvisionalUI.connectionFontSize))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .accessibilityValue(model.connectionLine)
        .accessibilityIdentifier("wemessage.connection")
    }
    .padding(.horizontal, 12)
    .padding(.bottom, 12)
    .frame(width: ShellView.sidebarWidth)
    .frame(maxHeight: .infinity)
    .background(Tokens.color(palette.layer2))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("wemessage.sidebar")
  }
}

/// The content pane with nothing selected (D-UI-5, provisional: text only).
private struct ContentPane: View {
  let palette: Tokens.Palette

  var body: some View {
    Text(ProvisionalUI.contentEmpty)
      .font(.system(size: 13))
      .foregroundStyle(Tokens.color(palette.inkDim))
      .multilineTextAlignment(.center)
      .frame(maxWidth: 360)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .accessibilityIdentifier("wemessage.content.empty")
  }
}
