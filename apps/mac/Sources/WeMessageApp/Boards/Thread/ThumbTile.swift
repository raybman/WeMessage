import AppKit
import SwiftUI
import WeMessageKit

// v2 F6c (D-UI-219..222): a transcript file the daemon can serve. An image
// draws its thumbnail in the D-UI-201 tile; a refusal draws the tile in
// words; a video keeps its poster. Activating any of them opens the
// viewer sheet, which reads the whole file and offers Save.

private struct AttachmentThumbnailsKey: EnvironmentKey {
  static let defaultValue: AttachmentThumbnails? = nil
}

extension EnvironmentValues {
  /// The thread's thumbnailer. Nil on board 08 and in the atlas, which
  /// draw specimens and fetch nothing. (A key by hand: SwiftPM builds
  /// without the SwiftUI macro plugin, so no @Entry.)
  var attachmentThumbnails: AttachmentThumbnails? {
    get { self[AttachmentThumbnailsKey.self] }
    set { self[AttachmentThumbnailsKey.self] = newValue }
  }
}

struct ThumbTile: View {
  let item: MessageTurn.Attachment
  let id: String
  let palette: Tokens.Palette
  let thumbnails: AttachmentThumbnails
  @State private var state: ThumbState?
  @State private var viewing = false

  private var video: Bool { (item.mime ?? "").hasPrefix("video/") }

  var body: some View {
    Button {
      viewing = true
    } label: {
      face
    }
    .buttonStyle(.plain)
    .disabled(!opens)
    .accessibilityElement(children: .ignore)
    .accessibilityAddTraits(.isButton)
    .accessibilityLabel(Self.words(item, state: state))
    .accessibilityIdentifier(ShellID.attachmentTilePrefix + id)
    .task(id: id) {
      if !video { state = await thumbnails.thumbnail(for: item) }
    }
    .sheet(isPresented: $viewing) {
      AttachmentViewer(item: item, id: id, thumbnails: thumbnails, palette: palette)
    }
  }

  /// A refusal the daemon gave with a reason does not open: it would only
  /// be asked again. No answer at all opens, and the viewer asks again.
  private var opens: Bool {
    if case .missing = state { return false }
    return true
  }

  @ViewBuilder private var face: some View {
    let width = ProvisionalUI.mediaTileWidth
    let height = width / ProvisionalUI.mediaTileAspect
    if video {
      VideoPoster(seconds: item.seconds, palette: palette)
    } else if case .image(let image) = state {
      Image(decorative: image, scale: 1)
        .resizable()
        .scaledToFill()
        .frame(width: width, height: height)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
    } else if case .missing(.notOnThisMac) = state {
      // D-UI-220: dashed, in words, with nothing turning.
      ZStack {
        RoundedRectangle(cornerRadius: 6).fill(Tokens.color(palette.layer1))
        RoundedRectangle(cornerRadius: 6)
          .strokeBorder(Tokens.color(palette.ink), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
        Text(Self.words(item, state: state))
          .font(.system(size: 9))
          .foregroundStyle(Tokens.color(palette.inkDim))
          .multilineTextAlignment(.center)
          .padding(.horizontal, 8)
      }
      .frame(width: width, height: height)
    } else {
      MediaCell(label: Self.words(item, state: state), width: width, height: height, palette: palette)
    }
  }

  /// What the tile says, on screen and to a screen reader.
  static func words(_ item: MessageTurn.Attachment, state: ThumbState?) -> String {
    let named = SpecimenText.mediaTile(item)
    if (item.mime ?? "").hasPrefix("video/") { return named + " \u{00B7} " + ProvisionalUI.viewerSaveToPlay }
    switch state {
    case nil, .image, .notImage: return named
    case .tooLarge: return named + " \u{00B7} " + ProvisionalUI.thumbnailOpenToLoad
    case .missing(.notOnThisMac): return ProvisionalUI.thumbnailNotOnThisMac
    case .missing(.sourceUnavailable): return ProvisionalUI.thumbnailUnreadable
    case .missing(let failure): return ProvisionalUI.thumbnailCannotShow(failure.rawValue)
    case .unreachable: return ProvisionalUI.thumbnailCannotShow(nil)
    }
  }
}

/// 08.D's video cell: a grey poster, a play disc and the duration.
struct VideoPoster: View {
  let seconds: Int?
  let palette: Tokens.Palette

  var body: some View {
    ZStack(alignment: .bottomTrailing) {
      MediaCell(label: "", width: 184, height: 128, palette: palette)
        .overlay {
          Circle()
            .fill(Tokens.color(palette.layer1))
            .overlay(Circle().strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
            .overlay(
              Image(systemName: "play.fill").font(.system(size: 9)).foregroundStyle(Tokens.color(palette.ink))
            )
            .frame(width: 26, height: 26)
        }
      Text(SpecimenText.duration(seconds ?? 0))
        .font(.system(size: 9, design: .monospaced))
        .foregroundStyle(Tokens.color(palette.ink))
        .padding(.horizontal, 3)
        .background(Tokens.color(palette.layer1))
        .padding(6)
    }
  }
}

/// D-UI-222: the whole file, read when the sheet opens and never kept. An
/// image shows full size; anything else shows its tile. Save (cmd-S) writes
/// a copy into Downloads; Done (Esc) closes.
struct AttachmentViewer: View {
  let item: MessageTurn.Attachment
  let id: String
  let thumbnails: AttachmentThumbnails
  let palette: Tokens.Palette
  @Environment(\.dismiss) private var dismiss
  @State private var bytes: AttachmentBytes?
  @State private var image: NSImage?
  @State private var line = ""

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      if let image {
        Image(nsImage: image)
          .resizable()
          .scaledToFit()
          .frame(maxWidth: 720, maxHeight: 540)
          .accessibilityHidden(true)
      } else {
        MediaCell(
          label: ThumbTile.words(item, state: nil), width: 320, height: 240, palette: palette)
      }
      Text(line)
        .font(.system(size: 11))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .accessibilityLabel(line)
        .accessibilityIdentifier(ShellID.attachmentViewerLine)
      HStack(spacing: 8) {
        SettingsButton(title: ProvisionalUI.viewerSave, palette: palette, id: ShellID.attachmentViewerSave) { save() }
          .keyboardShortcut("s", modifiers: .command)
          .disabled(bytes == nil)
        SettingsButton(title: ProvisionalUI.viewerDone, palette: palette, id: ShellID.attachmentViewerDone) { dismiss() }
      }
    }
    .padding(16)
    .background(Tokens.color(palette.layer1))
    .accessibilityElement(children: .contain)
    .accessibilityLabel(SpecimenText.mediaTile(item))
    .accessibilityIdentifier(ShellID.attachmentViewer)
    .task(id: id) { await load() }
    // Esc closes, as a key press on the sheet, never an app-wide shortcut.
    .onExitCommand { dismiss() }
  }

  private func load() async {
    do {
      let got = try await thumbnails.full(id)
      bytes = got
      image = got.mime.hasPrefix("image/") ? NSImage(data: got.data) : nil
      line = ""
    } catch let failure as AttachmentFailure {
      line = failure == .sourceUnavailable
        ? ProvisionalUI.thumbnailUnreadable : ProvisionalUI.thumbnailCannotShow(failure.rawValue)
    } catch {
      line = ProvisionalUI.thumbnailCannotShow(nil)
    }
  }

  private func save() {
    guard let bytes else { return }
    let folder = TestHooks.isUITest ? TestHooks.mediaDownloads : Self.downloads
    do {
      let url = try Self.saveCopy(bytes.data, name: item.name, id: id, into: folder)
      line = "Saved to Downloads as " + url.lastPathComponent
    } catch {
      line = "Not saved: " + error.localizedDescription
    }
  }

  static var downloads: URL {
    FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
      ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Downloads", isDirectory: true)
  }

  /// The file's own name, made safe (its last path part, no leading dot,
  /// no control characters), else the id; never over an existing file:
  /// "name 2.ext", "name 3.ext" and so on.
  static func safeName(_ name: String?, id: String) -> String {
    let base = (name ?? "").split(separator: "/").last.map(String.init) ?? ""
    let cleaned = String(base.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) && $0 != ":" })
      .trimmingCharacters(in: CharacterSet(charactersIn: ". ").union(.whitespaces))
    return cleaned.isEmpty ? id : cleaned
  }

  static func saveCopy(_ data: Data, name: String?, id: String, into folder: URL) throws -> URL {
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let safe = safeName(name, id: id)
    let stem = (safe as NSString).deletingPathExtension
    let ext = (safe as NSString).pathExtension
    var n = 1
    while true {
      let candidate = n == 1 ? safe : stem + " \(n)" + (ext.isEmpty ? "" : "." + ext)
      let url = folder.appendingPathComponent(candidate, isDirectory: false)
      do {
        try data.write(to: url, options: .withoutOverwriting)
        return url
      } catch CocoaError.fileWriteFileExists {
        n += 1
      }
    }
  }
}
