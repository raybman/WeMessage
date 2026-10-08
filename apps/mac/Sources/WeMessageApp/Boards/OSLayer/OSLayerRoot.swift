import SwiftUI
import WeMessageKit

/// Board 16 under the UI-test flag with WEMESSAGE_UI_BOARD=16 (D-UI-112):
/// the popover's content view at its drawn size over fixtures, beside the
/// extra's five glyphs, the Dock badge and Dock menu, and the notification
/// sets. A Menu tab reads back the live main menu the delegate installed.
/// It builds no client; nothing here sends or posts.
struct OSLayerRoot: View {
  enum Page: String, CaseIterable {
    case healthy, degraded, killed, confirm, menu

    var title: String {
      switch self {
      case .healthy: "Healthy"
      case .degraded: "Degraded"
      case .killed: "Killed"
      case .confirm: "Confirm"
      case .menu: "Menu"
      }
    }
  }

  @State private var page: Page = .healthy
  @State private var mirror = AccessibilityMirror.live()
  @Environment(\.colorScheme) private var scheme
  private let hub = OSLayerHub.shared

  private var palette: Tokens.Palette { Tokens.palette(dark: scheme == .dark) }
  private var dark: Bool { scheme == .dark }

  private var input: PopoverInput {
    switch page {
    case .healthy, .confirm, .menu: TestHooks.osLayerInputs.healthy
    case .degraded: TestHooks.osLayerInputs.degraded
    case .killed: TestHooks.osLayerInputs.killed
    }
  }

  var body: some View {
    GeometryReader { geometry in
      ZStack(alignment: .topLeading) {
        content
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
    .accessibilityIdentifier(ShellID.osLayer)
    .accessibilityValue(TestHooks.geometry.value ?? "")
    .accessibilityLabel(Text(TestHooks.geometry.value ?? ""))
    .transaction { if TestHooks.isUITest { $0.disablesAnimations = true } }
  }

  private var band: some View {
    HStack(spacing: 10) {
      Text("OS LAYER")
        .font(.system(size: 9, weight: .semibold))
        .tracking(1.4)
        .foregroundStyle(Tokens.color(palette.inkDim))
      ForEach(Page.allCases, id: \.self) { item in
        let shown = item == page
        Button {
          page = item
        } label: {
          Text(item.title)
            .font(.system(size: 12, weight: shown ? .semibold : .regular))
            .foregroundStyle(Tokens.color(palette.ink))
            .padding(.vertical, 3)
            .padding(.horizontal, 10)
            .background(Capsule().fill(shown ? Tokens.color(palette.layer2) : Color.clear))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .focusable()
        .accessibilityLabel(item.title)
        .accessibilityValue(shown ? "shown" : "")
        .accessibilityIdentifier(ShellID.osLayerTabPrefix + item.rawValue)
      }
      Spacer(minLength: 8)
    }
    .padding(.leading, TitleBar.lightsReserve + 8)
    .padding(.trailing, 16)
    .frame(height: ShellView.titleBand)
  }

  @ViewBuilder
  private var content: some View {
    if page == .menu {
      MenuReadback(lines: hub.menuDump, installs: hub.menuInstalls, palette: palette)
        .padding(16)
    } else {
      HStack(alignment: .top, spacing: 24) {
        PopoverView(
          content: PopoverRules.content(input), palette: palette, mirror: mirror, dark: dark,
          confirming: page == .confirm, held: input.entries.count,
          drafts: input.entries.filter { $0.kind == .draft }.count,
          onKill: { page = .confirm }, onEngage: { page = .killed }, onCancel: { page = .healthy })
          .clipShape(RoundedRectangle(cornerRadius: 10))
          .overlay(
            RoundedRectangle(cornerRadius: 10)
              .strokeBorder(Tokens.color(palette.inkDim), lineWidth: 0.5)
              .accessibilityHidden(true))
        SidePanel(snapshot: input.snapshot, palette: palette)
      }
      .padding(16)
    }
  }
}

/// The extra in its five states, the Dock badge for this page's snapshot,
/// the Dock menu and the notification sets.
private struct SidePanel: View {
  let snapshot: OSSnapshot
  let palette: Tokens.Palette

  private func heading(_ text: String) -> some View {
    Text(text)
      .font(.system(size: 10, weight: .semibold))
      .tracking(1.2)
      .foregroundStyle(Tokens.color(palette.inkDim))
      .accessibilityAddTraits(.isHeader)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      heading("MENU BAR")
      HStack(spacing: 14) {
        ForEach(TestHooks.osLayerStates, id: \.0) { state, shot in
          let glyph = OSLayer.glyph(shot)
          VStack(spacing: 4) {
            StatusGlyphView(glyph: glyph, ink: Tokens.color(palette.ink), size: 16)
              .frame(height: 22)
            Text(state.rawValue.uppercased())
              .font(.system(size: 10, weight: .semibold))
              .foregroundStyle(Tokens.color(palette.inkDim))
          }
          .accessibilityElement(children: .ignore)
          .accessibilityLabel(glyph.spoken)
          .accessibilityAddTraits(.isImage)
          .accessibilityIdentifier(ShellID.osLayerGlyphPrefix + state.rawValue)
        }
      }
      heading("DOCK")
      let badge = OSLayer.dockBadge(snapshot)
      let lines = DockMenu.lines(
        snapshot: snapshot, drafts: 3, asOf: "16:42:07", sourcesLine: "4 sources synced, oldest 1m ago",
        perChannel: [("iMessage", 4), ("WhatsApp", 2), ("LinkedIn", 3), ("Email", 0)])
      VStack(alignment: .leading, spacing: 3) {
        Text("Badge: " + (badge ?? "none"))
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.ink))
        ForEach(lines, id: \.id) { line in
          HStack {
            Text(line.title)
              .font(.system(size: 11, weight: line.enabled ? .medium : .semibold))
              .foregroundStyle(Tokens.color(line.enabled ? palette.ink : palette.inkDim))
            Spacer(minLength: 8)
            Text(line.chord)
              .font(.system(size: 10, weight: .semibold, design: .monospaced))
              .foregroundStyle(Tokens.color(palette.inkDim))
          }
          .frame(width: 300)
        }
      }
      .accessibilityElement(children: .ignore)
      .accessibilityAddTraits(.isStaticText)
      .accessibilityLabel("Dock badge " + (badge ?? "none") + ". " + lines.map(\.title).joined(separator: "; "))
      .accessibilityIdentifier(ShellID.osLayerDock)
      heading("NOTIFICATIONS")
      VStack(alignment: .leading, spacing: 3) {
        ForEach(NotificationKind.allCases, id: \.self) { kind in
          Text(kind.rawValue + ": " + kind.actions.map(\.title).joined(separator: " \u{00B7} "))
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(Tokens.color(palette.ink))
        }
      }
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, alignment: .topLeading)
  }
}

/// The live main menu, as the delegate read it back from the application.
private struct MenuReadback: View {
  let lines: [String]
  let installs: Int
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("\(lines.count) menu items, read back from the installed main menu (installed \(installs)x)")
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(lines.joined(separator: "\n"))
        .accessibilityIdentifier(ShellID.osLayerMenu)
      ScrollView(.vertical) {
        VStack(alignment: .leading, spacing: 1) {
          ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
            Text(line)
              .font(.system(size: 10, weight: .semibold, design: .monospaced))
              .foregroundStyle(Tokens.color(palette.ink))
              .lineLimit(1)
          }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
      }
    }
  }
}
