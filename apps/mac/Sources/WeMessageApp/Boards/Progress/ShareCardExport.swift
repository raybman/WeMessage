import AppKit
import SwiftUI
import WeMessageKit

/// How the card leaves the app (17.E): rendered locally to a 640 by 400
/// PNG, then put on a pasteboard, written to a file, or handed to the
/// system share sheet. Nothing here talks to a service.
///
/// Under the UI-test flag (D-UI-131) Copy writes to a named test
/// pasteboard, never the general one, and Save writes into a temporary
/// folder with no panel, never Downloads or the Desktop.
@MainActor
enum ShareCardExport {
  /// The card as PNG bytes at 1x, or nil if the render failed.
  static func png(_ card: ShareCard) -> Data? {
    let renderer = ImageRenderer(content: ShareCardView(card: card))
    renderer.scale = 1
    renderer.proposedSize = ProposedViewSize(width: ShareCardView.width, height: ShareCardView.height)
    guard let image = renderer.cgImage else { return nil }
    return NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
  }

  /// The pasteboard Copy writes to: the test one under the flag.
  static func pasteboardName(uiTest: Bool) -> NSPasteboard.Name {
    uiTest ? NSPasteboard.Name(ProvisionalUI.cardTestPasteboard) : .general
  }

  /// Puts the PNG on the pasteboard and returns its name.
  @discardableResult
  static func copy(_ data: Data, uiTest: Bool) -> NSPasteboard.Name {
    let name = pasteboardName(uiTest: uiTest)
    let board = NSPasteboard(name: name)
    board.clearContents()
    board.setData(data, forType: .png)
    return name
  }

  /// Where Save writes under the flag: a folder of this process's own in
  /// the temporary directory.
  static func testFolder() -> URL {
    FileManager.default.temporaryDirectory
      .appendingPathComponent(
        ProvisionalUI.cardTestExportFolder + "-" + String(ProcessInfo.processInfo.processIdentifier), isDirectory: true)
  }

  /// True for a place the test build must never write: Downloads or the
  /// Desktop, anywhere in the path.
  static func refused(_ url: URL) -> Bool {
    let path = url.standardizedFileURL.path + "/"
    return path.contains("/Downloads/") || path.contains("/Desktop/")
  }

  /// Writes the PNG: under the flag into `testFolder()` with no panel;
  /// otherwise where the user picks in the save panel. Returns where it
  /// went, or nil if nothing was written.
  static func save(_ data: Data, uiTest: Bool) -> URL? {
    if uiTest {
      let folder = testFolder()
      guard !refused(folder) else { return nil }
      try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      let url = folder.appendingPathComponent("card.png")
      guard (try? data.write(to: url, options: .atomic)) != nil else { return nil }
      return url
    }
    let panel = NSSavePanel()
    panel.nameFieldStringValue = "WeMessage card.png"
    panel.canCreateDirectories = true
    guard panel.runModal() == .OK, let url = panel.url else { return nil }
    guard (try? data.write(to: url, options: .atomic)) != nil else { return nil }
    return url
  }

  /// The image the share sheet is handed.
  static func image(_ data: Data) -> Image? {
    NSImage(data: data).map { Image(nsImage: $0) }
  }
}
