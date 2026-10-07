import SwiftUI
import WeMessageKit

/// Board 01's title bar (wireframe 01.B): the 78 pt band the traffic lights
/// keep, the scope's title, the dated counter (D-UI-22), the lens segments
/// with the Needs You count, the Triage button and the kill chip at the
/// trailing edge. Transparent over the window frost, like every pane.
struct TitleBar: View {
  @Bindable var model: ShellModel
  let palette: Tokens.Palette

  /// The leading band the hidden title bar leaves to the traffic lights.
  static let lightsReserve: CGFloat = 78

  private var title: String { model.scope == .all ? "All Messages" : model.scope.fullLabel }

  private var showsCounter: Bool {
    switch ProvisionalUI.titleCounter {
    case .always: true
    case .triageOnly: model.lens == .triage
    }
  }

  var body: some View {
    HStack(spacing: 16) {
      Color.clear.frame(width: Self.lightsReserve - 16, height: 1).accessibilityHidden(true)
      Text(title)
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
        .lineLimit(1)
        .fixedSize()
        .accessibilityIdentifier(ShellID.title)
      Spacer(minLength: 0)
      if showsCounter, let sentence = model.counterSentence {
        TitleCounter(counter: model.board.counter(model.scope), channel: model.counterChannel, palette: palette)
          .accessibilityLabel(sentence)
          .accessibilityValue(sentence)
          .accessibilityIdentifier(ShellID.titleCounter)
      }
      LensPicker(model: model, palette: palette)
      KillChip(model: model, palette: palette)
    }
    .padding(.trailing, 16)
    .frame(height: ShellView.titleBand)
    .frame(maxWidth: .infinity)
  }
}

/// The dated counter (wireframe .counter: mono 700 11 upper case, the number
/// at 17, the time regular and dimmed). One Text, so it is one element whose
/// value is the sentence the unit tests check.
struct TitleCounter: View {
  let counter: ShellBoard.Counter
  let channel: String
  let palette: Tokens.Palette

  private func strong(_ s: String, size: CGFloat = 11) -> Text {
    Text(s).font(.system(size: size, weight: .bold, design: .monospaced)).foregroundColor(Tokens.color(palette.ink))
  }

  private func dim(_ s: String) -> Text {
    Text(s).font(.system(size: 11, weight: .regular, design: .monospaced)).foregroundColor(Tokens.color(palette.inkDim))
  }

  var text: Text {
    switch counter {
    case .left(let n, let asOf):
      return Text("\(strong(String(n), size: 17))\(strong(" LEFT "))\(dim("AS OF " + ShellText.clock(asOf)))")
    case .clear(let asOf):
      return Text("\(strong("CLEAR "))\(dim(ShellText.clock(asOf)))")
    case .cannotSay(let since):
      let detail = ProvisionalUI.cannotSayDetail(channel: channel, staleSince: since.map { ShellText.clock($0) })
      return Text("\(strong("CANNOT SAY "))\(dim(detail.uppercased()))")
    case .hidden:
      return Text("")
    }
  }

  var body: some View {
    text
      .tracking(0.6)
      .lineLimit(1)
      .fixedSize()
  }
}

/// The lens segments and the Triage button (wireframe .seg and .btn.sm).
/// The selected lens is drawn per D-UI-25.
struct LensPicker: View {
  @Bindable var model: ShellModel
  let palette: Tokens.Palette

  private func on(_ lens: ShellModel.Lens) -> Bool { model.lens == lens }

  private func fill(_ selected: Bool) -> Color {
    guard selected else { return Tokens.color(palette.layer1) }
    switch ProvisionalUI.lensOn {
    case .filledTint: return Tokens.color(Tokens.tint)
    case .filledInk: return Tokens.color(palette.ink)
    }
  }

  private func label(_ selected: Bool) -> Color {
    guard selected else { return Tokens.color(palette.ink) }
    switch ProvisionalUI.lensOn {
    case .filledTint: return .white
    case .filledInk: return Tokens.color(palette.layer1)
    }
  }

  private var rule: Color { Tokens.color(palette.inkDim, opacity: 0.35) }

  var body: some View {
    let count = model.board.needsYou(model.scope)
    HStack(spacing: 16) {
      HStack(spacing: 0) {
        segment(.recent, Text("Recent"))
          .accessibilityIdentifier(ShellID.lensRecent)
        Rectangle().fill(rule).frame(width: 1).accessibilityHidden(true)
        segment(
          .needsYou,
          count.map { Text("Needs You \(Text(String($0)).fontWeight(.bold))") } ?? Text("Needs You")
        )
        .accessibilityValue(count.map(String.init) ?? "")
        .accessibilityIdentifier(ShellID.lensNeedsYou)
      }
      .fixedSize()
      .clipShape(RoundedRectangle(cornerRadius: 5))
      .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(rule, lineWidth: 1))
      Button {
        model.lens = .triage
      } label: {
        Text(
          "\(Text("Triage").font(.system(size: 10, weight: .semibold)))\(Text(" \u{2318}T").font(.system(size: 8, weight: .medium, design: .monospaced)))"
        )
          .foregroundColor(label(on(.triage)))
          .lineLimit(1)
          .fixedSize()
          .padding(.vertical, 6)
          .padding(.horizontal, 8)
          .background(RoundedRectangle(cornerRadius: 6).fill(fill(on(.triage))))
          .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .focusable()
      .keyboardShortcut("t", modifiers: .command)
      .accessibilityLabel("Triage")
      .accessibilityAddTraits(on(.triage) ? .isSelected : [])
      .accessibilityIdentifier(ShellID.lensTriage)
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Lens")
    .accessibilityIdentifier(ShellID.lens)
  }

  private func segment(_ lens: ShellModel.Lens, _ text: Text) -> some View {
    Button {
      model.lens = lens
    } label: {
      text
        .font(.system(size: 10, weight: .medium))
        .foregroundColor(label(on(lens)))
        .lineLimit(1)
        .fixedSize()
        .padding(.vertical, 6)
        .padding(.horizontal, 8)
        .background(fill(on(lens)))
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .focusable()
    .accessibilityLabel(lens.label)
    .accessibilityAddTraits(on(lens) ? .isSelected : [])
  }
}

/// The kill chip (wireframe .chip.hard: 2 pt ink border, bold), always on
/// screen. It only ever turns sending off; it looks the same once on, since
/// the engaged banner and the disengage path are S4f's.
struct KillChip: View {
  let model: ShellModel
  let palette: Tokens.Palette

  private var value: String {
    switch model.killSwitch {
    case .some(true): "on"
    case .some(false): "off"
    case .none: "unknown"
    }
  }

  var body: some View {
    Button {
      Task { await model.engageKillSwitch() }
    } label: {
      Text(
        "\(Text("KILL").font(.system(size: 10, weight: .bold)))\(Text(" \u{21E7}\u{2318}K").font(.system(size: 8, weight: .medium, design: .monospaced)))"
      )
        .foregroundColor(Tokens.color(palette.ink))
        .lineLimit(1)
        .fixedSize()
        .padding(.vertical, 5)
        .padding(.horizontal, 8)
        .background(Capsule().fill(Tokens.color(palette.layer1)))
        .overlay(Capsule().strokeBorder(Tokens.color(palette.ink), lineWidth: 2))
        .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .focusable()
    .keyboardShortcut("k", modifiers: [.command, .shift])
    .accessibilityLabel("Kill switch")
    .accessibilityValue(value)
    .accessibilityAddTraits(model.killSwitch == true ? .isSelected : [])
    .accessibilityIdentifier(ShellID.killChip)
  }
}
