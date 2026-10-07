import SwiftUI
import WeMessageKit

/// The initials disc (wireframe .av: a grey disc with a rule border). The
/// D-UI-8 colours arrive with the avatar work; board 01 draws the disc as
/// the wireframe does.
struct InitialsDisc: View {
  let title: String
  let size: CGFloat
  let palette: Tokens.Palette

  var body: some View {
    Circle()
      .fill(Tokens.color(palette.layer2))
      .overlay(Circle().strokeBorder(Tokens.color(palette.inkDim, opacity: 0.35), lineWidth: 1))
      .overlay(
        Text(ShellText.initials(title))
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.inkDim))
      )
      .frame(width: size, height: size)
      .accessibilityHidden(true)
  }
}

/// The channel tag (wireframe .ch: mono 700 8, ink border, radius 3).
struct ChannelTag: View {
  let channel: String
  let palette: Tokens.Palette

  var body: some View {
    Text(ShellModel.Scope(rawValue: channel)?.label ?? channel)
      .font(.system(size: 8, weight: .bold, design: .monospaced))
      .foregroundStyle(Tokens.color(palette.ink))
      .fixedSize()
      .padding(.vertical, 2)
      .padding(.horizontal, 3)
      .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
  }
}

/// One conversation in the list (wireframe .conv). One accessibility
/// element; never a Tab stop (the rows are reached with the arrows in S4d).
struct ListRow: View {
  let thread: ThreadSummary
  let showsChannel: Bool
  let selected: Bool
  let asOf: Date?
  let palette: Tokens.Palette
  let dark: Bool
  let action: () -> Void

  private var spoken: String {
    let channel = ShellModel.Scope(rawValue: thread.channel)?.fullLabel ?? thread.channel
    return [thread.title, channel, ShellText.preview(thread)].compactMap { $0 }.joined(separator: ", ")
  }

  private var selectedFill: Color {
    switch ProvisionalUI.selectedRow {
    case .tintBarWash: Tokens.color(Tokens.Selection.wash(dark: dark))
    case .inkBarFill: Tokens.color(palette.layer2)
    }
  }

  private var selectedBar: Color {
    switch ProvisionalUI.selectedRow {
    case .tintBarWash: Tokens.color(Tokens.tint)
    case .inkBarFill: Tokens.color(palette.ink)
    }
  }

  var body: some View {
    Button(action: action) {
      HStack(alignment: .top, spacing: 8) {
        InitialsDisc(title: thread.title, size: 36, palette: palette)
        VStack(alignment: .leading, spacing: 2) {
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            if showsChannel { ChannelTag(channel: thread.channel, palette: palette) }
            Text(thread.title)
              .font(.system(size: 12, weight: .semibold))
              .foregroundStyle(Tokens.color(palette.ink))
              .lineLimit(1)
              .truncationMode(.tail)
            Spacer(minLength: 4)
            Text(ShellText.rowTime(thread.lastAt, asOf: asOf))
              .font(.system(size: 9))
              .foregroundStyle(Tokens.color(palette.inkDim))
              .fixedSize()
          }
          if let preview = ShellText.preview(thread) {
            Text(preview)
              .font(.system(size: 10))
              .foregroundStyle(Tokens.color(palette.inkDim))
              .lineLimit(2)
              .multilineTextAlignment(.leading)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
        }
      }
      .padding(.vertical, 8)
      .padding(.horizontal, 12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(selected ? selectedFill : Color.clear)
      .overlay(alignment: .leading) {
        if selected { Rectangle().fill(selectedBar).frame(width: 3) }
      }
      .overlay(alignment: .bottom) {
        Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.15)).frame(height: 0.5)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .focusable(false)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(spoken)
    .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
  }
}

/// The content pane: the D-UI-5 empty state, or the selected thread's head
/// (wireframe .thread-head) with the inspector toggle. The thread itself is
/// S4d's.
struct ContentPane: View {
  @Bindable var model: ShellModel
  let palette: Tokens.Palette

  var body: some View {
    if let thread = model.selected {
      VStack(spacing: 0) {
        ThreadHeader(thread: thread, palette: palette) { model.inspectorShown.toggle() }
        Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.2)).frame(height: 0.5).accessibilityHidden(true)
        Spacer(minLength: 0)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .accessibilityElement(children: .contain)
      .accessibilityLabel(thread.title)
      .accessibilityIdentifier(ShellID.content)
    } else {
      Text(ProvisionalUI.contentEmpty)
        .font(.system(size: 13))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .multilineTextAlignment(.center)
        .frame(maxWidth: 360)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier(ShellID.contentEmpty)
    }
  }
}

/// The handle a one-to-one chat guid carries after its service and ";-;".
func threadHandle(_ thread: ThreadSummary) -> String? {
  guard !thread.isGroup, let range = thread.chatGuid.range(of: ";-;") else { return nil }
  return String(thread.chatGuid[range.upperBound...])
}

/// The thread head: avatar, name, channel and handle, and the ⓘ toggle.
struct ThreadHeader: View {
  let thread: ThreadSummary
  let palette: Tokens.Palette
  let toggle: () -> Void

  var body: some View {
    HStack(spacing: 8) {
      InitialsDisc(title: thread.title, size: 28, palette: palette)
      VStack(alignment: .leading, spacing: 2) {
        Text(thread.title)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.ink))
          .lineLimit(1)
        Text(subline)
          .font(.system(size: 9))
          .foregroundStyle(Tokens.color(palette.inkDim))
          .lineLimit(1)
      }
      Spacer(minLength: 0)
      Button(action: toggle) {
        Text("\u{24D8}")
          .font(.system(size: 12))
          .foregroundStyle(Tokens.color(palette.ink))
          .frame(width: 26, height: 26)
          .background(RoundedRectangle(cornerRadius: 5).fill(Tokens.color(palette.layer1)))
          .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(Tokens.color(palette.inkDim, opacity: 0.35), lineWidth: 1))
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .focusable()
      .accessibilityLabel("Inspector")
      .accessibilityIdentifier(ShellID.inspectorToggle)
    }
    .padding(.vertical, 8)
    .padding(.horizontal, 12)
    .frame(minHeight: 52)
  }

  private var subline: String {
    let channel = ShellModel.Scope(rawValue: thread.channel)?.fullLabel ?? thread.channel
    return [channel, threadHandle(thread)].compactMap { $0 }.joined(separator: " \u{00B7} ")
  }
}

/// The inspector column (D-UI-24: identity only until S4d and S4g).
struct InspectorPane: View {
  let thread: ThreadSummary
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if ProvisionalUI.inspectorContent == .identityOnly {
        InitialsDisc(title: thread.title, size: 36, palette: palette)
        Text(thread.title)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.ink))
        Text(ShellModel.Scope(rawValue: thread.channel)?.fullLabel ?? thread.channel)
          .font(.system(size: 9))
          .foregroundStyle(Tokens.color(palette.inkDim))
        if let handle = threadHandle(thread) {
          Text(handle)
            .font(.system(size: 9, design: .monospaced))
            .foregroundStyle(Tokens.color(palette.inkDim))
        }
      }
      Spacer(minLength: 0)
    }
    .padding(12)
    .frame(width: ProvisionalUI.inspectorWidth)
    .frame(maxHeight: .infinity, alignment: .top)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Inspector")
    .accessibilityIdentifier(ShellID.inspector)
  }
}
