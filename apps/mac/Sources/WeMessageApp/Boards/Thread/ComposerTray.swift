import SwiftUI
import WeMessageKit

/// v2 F6f: the file the attach door picked, waiting above the composer. It
/// prints what changes on the way out (HEIC to JPEG, the location strip),
/// and its own Send is the one way the file leaves: the field's text rides
/// along as the caption, sent only after the file is verified. While
/// attachments are off the Send prints why and nothing is staged.
///
/// A failed or unconfirmed send is told apart by an outline and its words,
/// never by colour.
struct ComposerTray: View {
  @Bindable var tray: AttachmentsModel
  let sender: AttachmentSender
  let caption: Binding<String>
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if !tray.tray.isEmpty {
        ForEach(tray.tray.items, id: \.id) { item in
          HStack(spacing: 8) {
            Text(item.wireName)
              .font(.system(size: 11, weight: .semibold).monospaced())
              .foregroundStyle(Tokens.color(palette.ink))
              .lineLimit(1)
            Text(item.chip)
              .font(.system(size: 10).monospacedDigit())
              .foregroundStyle(Tokens.color(palette.inkDim))
              .lineLimit(1)
            Spacer(minLength: 0)
            Button {
              tray.remove(item.id)
            } label: {
              Text("\u{2715}")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(Tokens.color(palette.ink))
                .frame(width: 22, height: 22)
                .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .focusable()
            .accessibilityLabel(ProvisionalUI.attachTrayRemove)
          }
        }
        if let conversion = tray.tray.conversionLine { note(conversion) }
        if let location = tray.tray.locationLine { note(location) }
        Button(action: send) {
          Text(ProvisionalUI.attachTraySend)
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(Tokens.color(palette.ink))
            .padding(.horizontal, 12)
            .frame(height: 26)
            .overlay(Capsule().strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .focusable()
        .accessibilityLabel(ProvisionalUI.attachTraySend)
        .accessibilityIdentifier(ShellID.composerTraySend)
      }
      if let line = tray.note ?? sender.line {
        Text(line)
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.ink))
          .fixedSize(horizontal: false, vertical: true)
          .padding(.horizontal, sender.outlined ? 6 : 0)
          .padding(.vertical, sender.outlined ? 3 : 0)
          .overlay {
            if sender.outlined {
              RoundedRectangle(cornerRadius: 4).strokeBorder(Tokens.color(palette.ink), style: BubbleStroke.dotted)
            }
          }
          .accessibilityIdentifier(ShellID.composerTrayLine)
      }
    }
    .padding(8)
    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Tokens.color(palette.inkDim, opacity: 0.5), lineWidth: 1))
    .accessibilityElement(children: .contain)
    .accessibilityLabel(tray.tray.isEmpty ? "Attachment" : tray.tray.header)
    .accessibilityIdentifier(ShellID.composerTray)
  }

  private func note(_ words: String) -> some View {
    Text(words)
      .font(.system(size: 10))
      .foregroundStyle(Tokens.color(palette.inkDim))
      .fixedSize(horizontal: false, vertical: true)
  }

  /// The tray's Send: the field's words become the caption. While the
  /// sender is off the tray and the field both stay as they were.
  private func send() {
    tray.caption = caption.wrappedValue
    tray.sendTray()
    guard sender.isOn else { return }
    caption.wrappedValue = ""
    tray.clearTray()
  }
}
