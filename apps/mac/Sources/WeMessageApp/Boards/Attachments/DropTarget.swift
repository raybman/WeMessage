import SwiftUI
import WeMessageKit

// v2 S4k, board 15.A: the drop target. The kit's DropMachine decides; this
// view draws its look, which changes three properties at once over the
// thread: a 3 pt dashed field inset 7 pt, a 72% scrim, and the thread at
// 35%. The card says what is about to stage, and the wall, while the hand
// is still on the mouse. Nothing here sends: the content pane holds the
// thread, or the viewer in its place (15.F), and the field over them.

/// The content pane: the thread or the viewer, and the drop field.
struct DropTargetView: View {
  @Bindable var model: AttachmentsModel
  let palette: Tokens.Palette
  let dark: Bool

  var body: some View {
    let look = model.drop.state.look
    ZStack {
      Group {
        if model.viewer != nil {
          ViewerPane(model: model, palette: palette)
        } else {
          MediaThread(model: model, palette: palette)
        }
      }
      .opacity(look.threadOpacity)
      if look.field {
        Rectangle()
          .fill(Tokens.color(palette.layer0, opacity: look.scrim))
          .accessibilityHidden(true)
        RoundedRectangle(cornerRadius: 10)
          .strokeBorder(Tokens.color(palette.ink), style: StrokeStyle(lineWidth: 3, dash: [8, 5]))
          .padding(look.inset)
          .accessibilityHidden(true)
        if case .targeted(let summary) = model.drop.state {
          DropCard(summary: summary, palette: palette)
        }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .clipped()
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Drop target")
    .accessibilityValue(model.drop.state.name)
    .accessibilityIdentifier(ShellID.mediaDrop)
  }
}

/// The card in the field: what stages, onto whom, and the wall.
struct DropCard: View {
  let summary: DropSummary
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(summary.title)
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
      Text(summary.line)
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
      Text(summary.detail)
        .font(.system(size: 12).monospacedDigit())
        .foregroundStyle(Tokens.color(palette.ink))
      Text(summary.promise)
        .font(.system(size: 12))
        .foregroundStyle(Tokens.color(palette.ink))
      if let wall = summary.wallLine {
        HStack(alignment: .top, spacing: 6) {
          Text("!")
            .font(.system(size: 11, weight: .bold))
            .foregroundStyle(Tokens.color(palette.ink))
            .frame(width: 16, height: 16)
            .overlay(Circle().strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
            .accessibilityHidden(true)
          Text(wall)
            .font(.system(size: 11))
            .foregroundStyle(Tokens.color(palette.ink))
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
    .padding(14)
    .frame(width: 360, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 10).fill(Tokens.color(palette.layer1)))
    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier(ShellID.mediaDropCard)
  }
}

/// The thread: messages and their attachments. It reports its offset, and
/// restores the pinned one when the viewer closes (15.F rule 1).
struct MediaThread: View {
  @Bindable var model: AttachmentsModel
  let palette: Tokens.Palette
  @State private var position = ScrollPosition(edge: .top)

  var body: some View {
    ScrollView(.vertical) {
      VStack(alignment: .leading, spacing: 10) {
        ForEach(model.content.messages) { message in
          MediaBubble(model: model, message: message, palette: palette)
        }
      }
      .padding(AttachmentsWindow.margin)
    }
    .scrollPosition($position)
    .onScrollGeometryChange(for: Double.self) { $0.contentOffset.y } action: { _, y in
      model.scrollY = y.rounded()
    }
    .onAppear { restoreIfAsked() }
    .onChange(of: model.restore) { restoreIfAsked() }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Thread")
    .accessibilityValue("y=\(Int(model.scrollY))")
    .accessibilityIdentifier(ShellID.mediaThread)
  }

  private func restoreIfAsked() {
    guard let y = model.restore else { return }
    Task { @MainActor in
      position.scrollTo(y: y)
      model.restored()
    }
  }
}

/// One message: words, or an attachment that opens the viewer. The origin
/// of the last viewer is outlined after Esc, in tint, for D-UI-109's
/// seconds.
struct MediaBubble: View {
  let model: AttachmentsModel
  let message: MediaMessage
  let palette: Tokens.Palette

  private var outlined: Bool { model.outlined == message.id }

  var body: some View {
    HStack {
      if message.fromMe { Spacer(minLength: 120) }
      VStack(alignment: message.fromMe ? .trailing : .leading, spacing: 3) {
        if let text = message.text {
          Text(text)
            .font(.system(size: 13))
            .foregroundStyle(Tokens.color(palette.ink))
            .padding(.vertical, 7)
            .padding(.horizontal, 11)
            .background(
              RoundedRectangle(cornerRadius: 14).fill(Tokens.color(message.fromMe ? palette.layer2 : palette.layer1)))
        }
        if let index = message.attachment, model.content.attachments.indices.contains(index) {
          let item = model.content.attachments[index]
          Button {
            model.open(index, from: message.id)
          } label: {
            MediaThumb(item: item, palette: palette, width: 180, height: item.isImage ? 132 : 100)
          }
          .buttonStyle(.plain)
          .focusable()
          .accessibilityLabel("Open \(item.name)")
          .accessibilityIdentifier(ShellID.mediaItemPrefix + item.id)
        }
        Text(message.time)
          .font(.system(size: 10).monospacedDigit())
          .foregroundStyle(Tokens.color(palette.inkDim))
      }
      .padding(4)
      .overlay(
        RoundedRectangle(cornerRadius: 16)
          .strokeBorder(outlined ? Tokens.color(Tokens.tint) : Color.clear, lineWidth: ProvisionalUI.viewerOutlineWidth))
      if !message.fromMe { Spacer(minLength: 120) }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Message")
    .accessibilityValue(outlined ? "outlined" : "")
    .accessibilityIdentifier(ShellID.mediaMessagePrefix + message.id)
  }
}

/// A file's stand-in where the pixels go (D-UI-107): its kind, its frame
/// and its chip. A video is double bordered and always shows its duration;
/// a document is not drawn as a picture.
struct MediaThumb: View {
  let item: StagedFile
  let palette: Tokens.Palette
  let width: Double
  let height: Double

  var body: some View {
    ZStack(alignment: .bottomLeading) {
      RoundedRectangle(cornerRadius: 8)
        .fill(Tokens.color(palette.layer2))
      VStack(spacing: 2) {
        Text(item.isVideo ? "VIDEO" : item.isImage ? "IMG" : item.chip)
          .font(.system(size: 10, weight: .semibold))
          .tracking(1)
        if let w = item.width, let h = item.height {
          Text("\(w)\u{00D7}\(h)")
            .font(.system(size: 10).monospacedDigit())
        }
      }
      .foregroundStyle(Tokens.color(palette.inkDim))
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      Text(item.chip)
        .font(.system(size: 10, weight: .semibold).monospacedDigit())
        .foregroundStyle(Tokens.color(palette.ink))
        .padding(.vertical, 2)
        .padding(.horizontal, 5)
        .background(Capsule().fill(Tokens.color(palette.layer1)))
        .padding(6)
    }
    .frame(width: width, height: height)
    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
    .overlay(
      RoundedRectangle(cornerRadius: 5)
        .strokeBorder(item.isVideo ? Tokens.color(palette.ink) : Color.clear, lineWidth: 1)
        .padding(3)
    )
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(item.name + ", " + item.chip)
  }
}
