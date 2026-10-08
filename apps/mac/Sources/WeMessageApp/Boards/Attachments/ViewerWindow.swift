import SwiftUI
import WeMessageKit

// v2 S4k, board 15.F: the viewer. It takes the thread's place in the
// content pane and keeps that place: the offset is pinned when it opens,
// and Esc puts the thread back at it with the originating message outlined.
// Its set is this thread's attachments, in order, and the arrows stop at
// both ends. cmd-S saves a converted copy, opt-cmd-R reveals the saved copy
// (never the cache), cmd-C copies. No Delete, no slideshow, no edit, and it
// writes nothing back to the channel.

struct ViewerPane: View {
  @Bindable var model: AttachmentsModel
  let palette: Tokens.Palette
  /// The viewer takes focus when it opens, so the bare arrows and Esc are
  /// key presses on it, never app-wide shortcuts (H-A2+).
  @FocusState private var focused: Bool

  var body: some View {
    if let set = model.viewer, let item = set.current {
      VStack(alignment: .leading, spacing: 10) {
        header(set: set, item: item)
        stage(set: set, item: item)
        filmstrip(set: set)
        actions
      }
      .padding(AttachmentsWindow.margin)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .accessibilityElement(children: .contain)
      .accessibilityLabel("Viewer, " + set.position)
      .accessibilityIdentifier(ShellID.mediaViewer)
      .focusable(interactions: .edit)
      .focusEffectDisabled()
      .focused($focused)
      .onAppear { focused = true }
      .onKeyPress(.leftArrow) {
        model.previous()
        return .handled
      }
      .onKeyPress(.rightArrow) {
        model.next()
        return .handled
      }
      .onKeyPress(.escape) {
        model.close()
        return .handled
      }
    }
  }

  private func header(set: ViewerSet, item: StagedFile) -> some View {
    HStack(alignment: .top, spacing: 10) {
      Text(set.position)
        .font(.system(size: 13, weight: .semibold).monospacedDigit())
        .foregroundStyle(Tokens.color(palette.ink))
        .accessibilityIdentifier(ShellID.mediaViewerPosition)
      VStack(alignment: .leading, spacing: 3) {
        Text(
          [item.name, item.meta, "from " + model.content.recipient, "iMessage"].joined(separator: " \u{00B7} ")
        )
        .font(.system(size: 12))
        .foregroundStyle(Tokens.color(palette.ink))
        .accessibilityIdentifier(ShellID.mediaViewerMeta)
        Text(model.viewerLine)
          .font(.system(size: 11))
          .foregroundStyle(Tokens.color(palette.inkDim))
          .accessibilityIdentifier(ShellID.mediaViewerLine)
        if let origin = model.origin, let pinned = model.pinned {
          Text("Opened from message \(origin.dropFirst()). Offset pinned at open: y=\(Int(pinned)).")
            .font(.system(size: 11).monospacedDigit())
            .foregroundStyle(Tokens.color(palette.inkDim))
            .accessibilityIdentifier(ShellID.mediaViewerOrigin)
        }
      }
      Spacer(minLength: 8)
      SettingsButton(title: "Close  esc", palette: palette, id: ShellID.mediaViewerClose) { model.close() }
    }
  }

  private func stage(set: ViewerSet, item: StagedFile) -> some View {
    HStack(spacing: 12) {
      arrow("\u{2039}", label: "Previous", live: set.canGoBack, id: ShellID.mediaViewerPrevious) { model.previous() }
      MediaThumb(item: item, palette: palette, width: 300, height: 220)
        .frame(maxWidth: .infinity)
      arrow("\u{203A}", label: "Next", live: set.canGoForward, id: ShellID.mediaViewerNext) { model.next() }
    }
    .frame(maxWidth: .infinity)
  }

  /// An arrow at the end of the set is inert, drawn faint, and does not
  /// wrap (15.F rule 2).
  private func arrow(_ glyph: String, label: String, live: Bool, id: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Text(glyph)
        .font(.system(size: 26, weight: .light))
        .foregroundStyle(Tokens.color(live ? palette.ink : palette.inkDim))
        .frame(width: 36, height: 56)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .focusable()
    .accessibilityLabel(label)
    .accessibilityValue(live ? "" : "at the end")
    .accessibilityIdentifier(id)
  }

  /// The strip says the mix in words: a video cell is double bordered and
  /// a PDF is not a picture.
  private func filmstrip(set: ViewerSet) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 6) {
        ForEach(Array(set.items.enumerated()), id: \.element.id) { index, item in
          MediaThumb(item: item, palette: palette, width: 64, height: 48)
            .overlay(
              RoundedRectangle(cornerRadius: 8)
                .strokeBorder(index == set.index ? Tokens.color(Tokens.tint) : Color.clear, lineWidth: 2))
        }
      }
      .accessibilityElement(children: .contain)
      .accessibilityLabel("Filmstrip")
      Text(set.kinds)
        .font(.system(size: 11))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .accessibilityIdentifier(ShellID.mediaViewerKinds)
    }
  }

  private var actions: some View {
    HStack(spacing: 8) {
      SettingsButton(title: "Save to Downloads  \u{2318}S", palette: palette, id: ShellID.mediaViewerSave) { model.save() }
        .keyboardShortcut("s", modifiers: .command)
      SettingsButton(title: "Reveal in Finder  \u{2325}\u{2318}R", palette: palette, id: ShellID.mediaViewerReveal) {
        model.revealSaved()
      }
      .keyboardShortcut("r", modifiers: [.command, .option])
      SettingsButton(title: "Copy  \u{2318}C", palette: palette, id: ShellID.mediaViewerCopy) { model.copyCurrent() }
        .keyboardShortcut("c", modifiers: .command)
      Spacer()
    }
  }
}
