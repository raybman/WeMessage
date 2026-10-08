import AppKit
import SwiftUI
import WeMessageKit

/// Board 15 under the UI-test flag with WEMESSAGE_UI_BOARD=15: a window of
/// its own over fixture files (D-UI-102, D-UI-103). It builds no client:
/// the tray's sink parks the set (D-UI-104), Save writes into a temporary
/// Downloads, and Reveal and Copy are recorded (D-UI-108).
struct AttachmentsRoot: View {
  @State private var model = AttachmentsModel(
    content: TestHooks.mediaContent,
    send: { _ in ProvisionalUI.mediaParkedNote },
    save: { item in
      let folder = TestHooks.mediaDownloads
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      let url = folder.appendingPathComponent(item.wireName)
      try Data(item.wireName.utf8).write(to: url)
      return url
    },
    reveal: { _ in },
    copy: { _ in })

  var body: some View {
    AttachmentsWindow(model: model)
  }
}

/// Board 15: three pages behind the title band's tabs. Thread is 15.A, 15.C
/// to 15.F on one iMessage thread; Walls is 15.B and the 15.D table; Refusals
/// is 15.H's iMessage column and its four part panel.
struct AttachmentsWindow: View {
  @Bindable var model: AttachmentsModel
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
        MediaKeyDoors(model: model)
      }
      .frame(width: geometry.size.width, height: geometry.size.height, alignment: .topLeading)
    }
    .frame(minWidth: ProvisionalUI.windowMinWidth, minHeight: ProvisionalUI.windowMinHeight)
    .ignoresSafeArea()
    .modifier(FrostBackground(mirror: mirror, palette: palette))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier(ShellID.media)
    .accessibilityValue(TestHooks.geometry.value ?? "")
    .accessibilityLabel(Text(TestHooks.geometry.value ?? ""))
    .transaction { if TestHooks.isUITest { $0.disablesAnimations = true } }
  }

  /// The title band: the board's name and the three tabs, clear of the
  /// lights.
  private var band: some View {
    HStack(spacing: 10) {
      Text("MEDIA")
        .font(.system(size: 9, weight: .semibold))
        .tracking(1.4)
        .foregroundStyle(Tokens.color(palette.inkDim))
      ForEach(AttachmentsModel.Page.allCases, id: \.self) { page in
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
        .accessibilityIdentifier(ShellID.mediaTabPrefix + page.rawValue)
      }
      Spacer(minLength: 8)
    }
    .padding(.leading, TitleBar.lightsReserve + 8)
    .padding(.trailing, Self.margin)
    .frame(height: ShellView.titleBand)
  }

  @ViewBuilder
  private var page: some View {
    switch model.page {
    case .thread:
      MediaThreadPage(model: model, palette: palette, mirror: mirror, dark: dark)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(model.page.title)
        .accessibilityIdentifier(ShellID.mediaPagePrefix + model.page.rawValue)
    case .walls, .refusal:
      ScrollView(.vertical) {
        VStack(alignment: .leading, spacing: 14) {
          if model.page == .walls {
            WallsPage(model: model, palette: palette)
          } else {
            RefusalPage(model: model, palette: palette)
          }
        }
        .frame(maxWidth: 720, alignment: .topLeading)
        .padding(Self.margin)
        .frame(maxWidth: .infinity, alignment: .topLeading)
      }
      .accessibilityElement(children: .contain)
      .accessibilityLabel(model.page.title)
      .accessibilityIdentifier(ShellID.mediaPagePrefix + model.page.rawValue)
    }
  }
}

/// The board's key doors (D-UI-103): the fixture stand-ins for a drag, a
/// pick and a paste. Each calls the same model method the real door will,
/// so a drop here stages exactly as a drop there would. Not drawn and not
/// in the accessibility tree; reached by their chords only.
struct MediaKeyDoors: View {
  let model: AttachmentsModel

  var body: some View {
    ZStack {
      door("1") { model.hover(.thread, files: model.content.dropped) }
      door("2") { model.hover(.rail, files: model.content.dropped) }
      door("3") { model.release(model.content.dropped) }
      door("4") { model.attach(model.content.attached) }
      door("5") {
        let p = model.content.pasted
        model.paste(bytes: p.bytes, width: p.width, height: p.height, at: p.at)
      }
      door("6") { model.hover(.listRow("maya"), files: model.content.dropped) }
      door("0") { model.leave() }
      door("9") { model.clearTray() }
    }
    .frame(width: 0, height: 0)
    .opacity(0)
    .accessibilityHidden(true)
  }

  private func door(_ key: Character, _ action: @escaping () -> Void) -> some View {
    Button("", action: action)
      .keyboardShortcut(KeyEquivalent(key), modifiers: [.command, .option])
      .buttonStyle(.plain)
  }
}

/// 15.A to 15.F on one thread: the rail and the list, untouched by a drop;
/// the content pane, where the field, the viewer and the tray live.
struct MediaThreadPage: View {
  @Bindable var model: AttachmentsModel
  let palette: Tokens.Palette
  let mirror: AccessibilityMirror
  let dark: Bool

  var body: some View {
    HStack(spacing: 0) {
      MediaRail(model: model, palette: palette)
        .frame(width: ProvisionalUI.railCollapsedWidth)
      Hairline(mirror: mirror, palette: palette, dark: dark)
      MediaList(model: model, palette: palette)
        .frame(width: 220)
      Hairline(mirror: mirror, palette: palette, dark: dark)
      VStack(spacing: 0) {
        MediaHeader(model: model, palette: palette)
        Hairline(mirror: mirror, palette: palette, dark: dark, horizontal: true)
        DropTargetView(model: model, palette: palette, dark: dark)
        Hairline(mirror: mirror, palette: palette, dark: dark, horizontal: true)
        StagingTrayView(model: model, palette: palette)
      }
    }
  }
}

/// The rail: a scope, never a recipient. A drag over it is refused and the
/// rail hatched (15.A rule 4).
struct MediaRail: View {
  let model: AttachmentsModel
  let palette: Tokens.Palette

  private var refused: Bool {
    if case .refused(let why) = model.drop.state, why == DropMachine.railReason { return true }
    return false
  }

  var body: some View {
    VStack(spacing: 10) {
      ForEach(MediaChannel.allCases, id: \.self) { channel in
        Text(ProvisionalUI.railShortLabels[channel.rawValue] ?? "")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(Tokens.color(channel == .imessage ? palette.ink : palette.inkDim))
          .frame(width: 36, height: 30)
          .background(
            RoundedRectangle(cornerRadius: 6).fill(channel == .imessage ? Tokens.color(palette.layer2) : Color.clear)
          )
          .accessibilityLabel(channel.title)
      }
      Spacer()
    }
    .padding(.top, 12)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .overlay { if refused { Hatching(palette: palette) } }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(refused ? "Rail, refused" : "Rail")
    .accessibilityIdentifier(ShellID.mediaRail)
  }
}

/// The kit's "not a normal surface" texture: diagonal ink lines.
struct Hatching: View {
  let palette: Tokens.Palette

  var body: some View {
    Canvas { context, size in
      var path = Path()
      var x = -size.height
      while x < size.width {
        path.move(to: CGPoint(x: x, y: size.height))
        path.addLine(to: CGPoint(x: x + size.height, y: 0))
        x += 7
      }
      context.stroke(path, with: .color(Tokens.color(palette.inkDim, opacity: 0.5)), lineWidth: 1)
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}

/// The list: one row, the thread, and the refusal's printed reason when a
/// drop is refused (never silent).
struct MediaList: View {
  let model: AttachmentsModel
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      VStack(alignment: .leading, spacing: 2) {
        Text(model.content.recipient)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.ink))
        Text("Got them.")
          .font(.system(size: 11))
          .foregroundStyle(Tokens.color(palette.inkDim))
      }
      .padding(8)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: 6).fill(Tokens.color(palette.layer2)))
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier(ShellID.mediaRowPrefix + "maya")
      if case .refused(let why) = model.drop.state {
        Text(why)
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.ink))
          .fixedSize(horizontal: false, vertical: true)
          .padding(8)
          .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
          .accessibilityIdentifier(ShellID.mediaDropReason)
      }
      Spacer()
    }
    .padding(10)
  }
}

/// The thread's header: who, where, and how many attachments. Two values
/// ride on its two lines, because a group drops its value on macOS: the
/// thread's offset on the name, and the drop state on the line.
struct MediaHeader: View {
  let model: AttachmentsModel
  let palette: Tokens.Palette

  var body: some View {
    HStack(spacing: 8) {
      Text(model.content.recipient)
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
        .accessibilityIdentifier(ShellID.mediaHeader)
        .accessibilityValue("y=\(Int(model.scrollY))")
      Text("iMessage \u{00B7} \(ComposeModel.printed(model.content.handle)) \u{00B7} \(model.content.attachments.count) attachments")
        .font(.system(size: 11))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .accessibilityIdentifier(ShellID.mediaDrop)
        .accessibilityValue(model.drop.state.name)
      Spacer()
    }
    .padding(.horizontal, AttachmentsWindow.margin)
    .frame(height: 40)
  }
}
