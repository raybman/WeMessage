import SwiftUI
import WeMessageKit

/// Board 13 under the UI-test flag with WEMESSAGE_UI_BOARD=13: a window and
/// client of its own, over the fake daemon. The shipped cmd-comma door is
/// not built in this version (D-UI-89).
struct SettingsRoot: View {
  @State private var model: SettingsModel = {
    let client = GatewayClient()
    let shell = ShellModel(client: client, avatars: AvatarBook(provider: TestHooks.avatarProvider()))
    return SettingsModel(client: client, shell: shell)
  }()

  var body: some View {
    SettingsWindow(model: model)
      .task {
        model.shell.start()
        await model.load()
      }
  }
}

/// Board 13: a sidebar of seven panes and the chosen pane beside it (13.A).
/// Every row is read-only but two: Delete the local copy and Release, and
/// both open a confirm card first (13.H).
struct SettingsWindow: View {
  @Bindable var model: SettingsModel
  @State private var mirror = AccessibilityMirror.live()
  @Environment(\.colorScheme) private var scheme

  static let margin: Double = 16
  static let sidebarWidth: Double = 220

  private var palette: Tokens.Palette { Tokens.palette(dark: scheme == .dark) }
  private var dark: Bool { scheme == .dark }

  var body: some View {
    GeometryReader { geometry in
      ZStack(alignment: .topLeading) {
        // Under the confirm card the window is a scrim: out of the tree, so
        // neither VoiceOver nor the audit reads what the card covers. A
        // branch, not a toggled accessibilityHidden: toggling it on a live
        // subtree left the root "not an accessibility child of the parent"
        // (run 37781688313), and its false re-exposed the hairlines.
        if model.confirm != nil {
          backdrop(geometry.size).accessibilityHidden(true)
        } else {
          backdrop(geometry.size)
        }
        if let what = model.confirm {
          ConfirmCard(model: model, what: what, palette: palette)
            .frame(width: geometry.size.width, height: geometry.size.height)
        }
      }
      .frame(width: geometry.size.width, height: geometry.size.height, alignment: .topLeading)
    }
    .frame(minWidth: ProvisionalUI.windowMinWidth, minHeight: ProvisionalUI.windowMinHeight)
    .ignoresSafeArea()
    .modifier(FrostBackground(mirror: mirror, palette: palette))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier(ShellID.settings)
    .accessibilityValue(TestHooks.geometry.value ?? "")
    .accessibilityLabel(Text(TestHooks.geometry.value ?? ""))
    .transaction { if TestHooks.isUITest { $0.disablesAnimations = true } }
  }

  /// The panes and the title band: everything the confirm card covers.
  private func backdrop(_ size: CGSize) -> some View {
    ZStack(alignment: .topLeading) {
      HStack(spacing: 0) {
        sidebar
          .frame(width: Self.sidebarWidth, alignment: .topLeading)
        Hairline(mirror: mirror, palette: palette, dark: dark)
        page
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      }
      .padding(.top, ShellView.titleBand + 0.5)
      .frame(width: size.width, height: size.height, alignment: .topLeading)
      VStack(spacing: 0) {
        band
        Hairline(mirror: mirror, palette: palette, dark: dark, horizontal: true)
      }
    }
    .frame(width: size.width, height: size.height, alignment: .topLeading)
  }

  /// The title band: the window's name and the pane's, clear of the lights.
  private var band: some View {
    HStack(spacing: 10) {
      Text("SETTINGS")
        .font(.system(size: 9, weight: .semibold))
        .tracking(1.4)
        .foregroundStyle(Tokens.color(palette.inkDim))
      Text(model.pane.title)
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
        .lineLimit(1)
        .accessibilityAddTraits(.isHeader)
      Spacer(minLength: 8)
    }
    .padding(.leading, TitleBar.lightsReserve + 8)
    .padding(.trailing, Self.margin)
    .frame(height: ShellView.titleBand)
  }

  /// One row per pane, each with the state line a user reads before
  /// choosing it (13.A).
  private var sidebar: some View {
    VStack(alignment: .leading, spacing: 2) {
      ForEach(SettingsPane.allCases, id: \.self) { pane in
        let shown = pane == model.pane
        Button {
          model.pane = pane
        } label: {
          VStack(alignment: .leading, spacing: 1) {
            Text(pane.title)
              .font(.system(size: 13, weight: shown ? .semibold : .regular))
              .foregroundStyle(Tokens.color(palette.ink))
            Text(model.stateLine(pane))
              .font(.system(size: 11))
              .foregroundStyle(Tokens.color(palette.inkDim))
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.vertical, 5)
          .padding(.horizontal, 10)
          .background(RoundedRectangle(cornerRadius: 6).fill(shown ? Tokens.color(palette.layer2) : Color.clear))
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .focusable()
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(pane.title + ", " + model.stateLine(pane))
        .accessibilityValue(shown ? "shown" : "")
        // Ignoring children drops the Button's press; give it back.
        .accessibilityAction { model.pane = pane }
        .accessibilityIdentifier(ShellID.settingsPanePrefix + pane.rawValue)
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 12)
  }

  private var page: some View {
    ScrollView(.vertical) {
      VStack(alignment: .leading, spacing: 16) {
        switch model.pane {
        case .accounts: AccountsPane(model: model, palette: palette)
        case .drafting: DraftingPane(model: model, palette: palette)
        case .notifications: NotificationsPane(palette: palette)
        case .appearance: AppearancePane(mirror: mirror, palette: palette)
        case .keyboard: KeyboardPane(keymap: model.keymap, palette: palette)
        case .storage: StoragePane(model: model, palette: palette)
        case .confirm: ConfirmPane(model: model, palette: palette)
        }
      }
      .frame(maxWidth: 620, alignment: .topLeading)
      .padding(Self.margin)
      .frame(maxWidth: .infinity, alignment: .topLeading)
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(model.pane.title)
    .accessibilityIdentifier(ShellID.settingsPagePrefix + model.pane.rawValue)
  }
}

// MARK: shared pieces

/// A section label: small caps, dim.
struct SettingsHeading: View {
  let text: String
  let palette: Tokens.Palette

  var body: some View {
    Text(text.uppercased())
      .font(.system(size: 9, weight: .semibold))
      .tracking(1.2)
      .foregroundStyle(Tokens.color(palette.inkDim))
      .accessibilityAddTraits(.isHeader)
  }
}

/// A row with no control: what it is, what it says, and a word on the right
/// for its value or its kind (13's "No control", "Structural").
struct SettingsLine: View {
  let title: String
  let detail: String
  var trailing: String? = nil
  let palette: Tokens.Palette

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.ink))
        Text(detail)
          .font(.system(size: 11))
          .foregroundStyle(Tokens.color(palette.inkDim))
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 8)
      if let trailing {
        Text(trailing)
          .font(.system(size: 11, weight: .semibold).monospacedDigit())
          .foregroundStyle(Tokens.color(palette.ink))
          .padding(.vertical, 2)
          .padding(.horizontal, 8)
          .overlay(Capsule().strokeBorder(Tokens.color(palette.inkDim), lineWidth: 1))
      }
    }
    .padding(.vertical, 6)
    .accessibilityElement(children: .combine)
  }
}

/// A plain button drawn as an outlined capsule; danger draws the outline red.
struct SettingsButton: View {
  let title: String
  var danger = false
  let palette: Tokens.Palette
  let id: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Text(title)
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(Tokens.color(danger ? Tokens.danger : palette.ink))
        .padding(.vertical, 5)
        .padding(.horizontal, 12)
        .overlay(Capsule().strokeBorder(Tokens.color(danger ? Tokens.danger : palette.ink), lineWidth: 1))
        .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .focusable()
    .accessibilityLabel(title)
    .accessibilityIdentifier(id)
  }
}
