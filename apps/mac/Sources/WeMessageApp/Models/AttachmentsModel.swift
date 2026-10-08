import Foundation
import Observation
import WeMessageKit

// v2 S4k, board 15: sending media. Three doors (attach, drop, paste) land
// in one object, the staging tray, and none of them sends (15.A). The drop
// target is the kit's DropMachine; the walls are the kit's dated config
// (15.B); the tray prints its conversions and the recipient's grid (15.C);
// a video carries its duration everywhere (15.D); the record slot on
// iMessage is absent with its reason (15.E); the viewer keeps your place
// (15.F); the refusal panel has four parts (15.H). This model holds no
// client: the one way anything leaves is `sendTray()`, which hands the sink
// a set built from the tray and nothing else (H-S4-11).

/// One message in board 15's thread: words, or one of the thread's
/// attachments by its index in the viewer's set.
struct MediaMessage: Equatable, Sendable, Identifiable {
  let id: String
  let fromMe: Bool
  let text: String?
  let attachment: Int?
  let time: String
}

/// What board 15 draws: one iMessage thread and the files its doors bring.
struct MediaContent: Sendable {
  let recipient: String
  let handle: String
  let messages: [MediaMessage]
  /// The thread's attachments in thread order: the viewer's set.
  let attachments: [StagedFile]
  /// The attach door's four images (15.C).
  let attached: [StagedFile]
  /// The drop door's three files, one a video over iMessage's wall (15.A).
  let dropped: [StagedFile]
  /// The paste door's clipboard image, which arrives with no name.
  let pasted: (bytes: Int64, width: Int, height: Int, at: Date)
  /// The refusal panel's fourth part: words that work without a recording.
  let draftedWords: String
}

/// A set ready for the wire. It can be built only from a tray that can
/// send: no file reaches the sink without passing through the tray first
/// (15.H acceptance 2).
struct OutboundAttachments: Equatable, Sendable {
  let channel: MediaChannel
  let files: [StagedFile]
  let wireNames: [String]
  let caption: String

  init?(tray: StagingTray) {
    guard tray.canSend else { return nil }
    channel = tray.channel
    files = tray.items
    wireNames = tray.items.map(\.wireName)
    caption = tray.caption
  }
}

@MainActor
@Observable
final class AttachmentsModel {
  enum Page: String, CaseIterable, Sendable {
    case thread, walls, refusal

    var title: String {
      switch self {
      case .thread: "Thread"
      case .walls: "Walls"
      case .refusal: "Refusals"
      }
    }
  }

  var page: Page = .thread
  let content: MediaContent
  let walls: SizeWallTable
  private(set) var drop: DropMachine
  private(set) var tray: StagingTray
  /// What the last door or Send said, for the composer's status line.
  private(set) var note: String?

  // 15.F: the viewer and the place it keeps.
  private(set) var viewer: ViewerSet?
  /// The thread's live scroll offset, reported by the view.
  var scrollY: Double = 0
  /// The offset pinned when the viewer opened.
  private(set) var pinned: Double?
  /// The message the viewer was opened from.
  private(set) var origin: String?
  /// The offset the view must restore, set by close and cleared by the view.
  private(set) var restore: Double?
  /// The message outlined after close, for D-UI-109's seconds.
  private(set) var outlined: String?
  /// The viewer's header line: cached, saved, revealed, copied.
  private(set) var viewerLine: String = AttachmentsModel.cachedLine
  /// Saved copies by attachment id.
  private(set) var saved: [String: URL] = [:]

  /// The refusal panel's fourth part, once moved: the composer's words.
  var composerWords = ""

  static let cachedLine = "Cached by WeMessage. Not yet saved anywhere you chose."

  private let send: (OutboundAttachments) -> String
  private let saveCopy: (StagedFile) throws -> URL
  private let reveal: (URL) -> Void
  private let copy: (StagedFile) -> Void
  private let outlineSeconds: Int
  private var dwell: Task<Void, Never>?
  private var fade: Task<Void, Never>?

  /// - Parameters:
  ///   - send: the outbound sink. Called from `sendTray()` only, with a set
  ///     built from the tray; it returns the line to show.
  ///   - save: writes the converted copy and returns where it went.
  init(
    content: MediaContent, walls: SizeWallTable = .standard, outlineSeconds: Int = ProvisionalUI.viewerOutlineSeconds,
    send: @escaping (OutboundAttachments) -> String, save: @escaping (StagedFile) throws -> URL,
    reveal: @escaping (URL) -> Void, copy: @escaping (StagedFile) -> Void
  ) {
    self.content = content
    self.walls = walls
    self.outlineSeconds = outlineSeconds
    self.send = send
    self.saveCopy = save
    self.reveal = reveal
    self.copy = copy
    drop = DropMachine(channel: .imessage, recipient: content.recipient, walls: walls)
    tray = StagingTray(channel: .imessage, walls: walls)
  }

  var record: RecordControl { RecordControl.on(tray.channel) }
  var wall: SizeWall? { walls.wall(for: tray.channel) }

  // MARK: 15.A, the three doors. None of them sends.

  /// A drag is over `zone`. Over a list row the thread opens after the
  /// dwell, then the field is drawn.
  func hover(_ zone: DropZone, files: [StagedFile]) {
    dwell?.cancel()
    drop.enter(zone, files: files)
    guard case .dwelling = drop.state else { return }
    dwell = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(DropMachine.dwellMilliseconds))
      guard !Task.isCancelled else { return }
      self?.dwellElapsed()
    }
  }

  func dwellElapsed() {
    drop.dwellElapsed()
  }

  /// The drag left without dropping.
  func leave() {
    dwell?.cancel()
    drop.exit()
  }

  /// The drop itself: the files stage, or the refusal is printed.
  @discardableResult
  func release(_ files: [StagedFile]) -> DropOutcome {
    dwell?.cancel()
    let outcome = drop.drop(files)
    switch outcome {
    case .staged(let staged):
      tray.stage(staged)
      note = nil
    case .refused(let why):
      note = why
    }
    return outcome
  }

  /// Door 1: the attach button's pick.
  func attach(_ files: [StagedFile]) {
    tray.stage(files)
    note = nil
  }

  /// Door 3: a clipboard image, named here and shown before the send.
  func paste(bytes: Int64, width: Int, height: Int, at: Date) {
    tray.stage([StagedFile.pasted(bytes: bytes, width: width, height: height, at: at)])
    note = nil
  }

  func remove(_ id: String) {
    tray.remove(id)
  }

  func clearTray() {
    tray.clear()
    note = nil
  }

  var caption: String {
    get { tray.caption }
    set { tray.caption = newValue }
  }

  /// The tray's Send: the only call to the sink. Over the wall it does
  /// nothing (there is no send anyway); otherwise the sink gets the set.
  func sendTray() {
    guard let set = OutboundAttachments(tray: tray) else { return }
    note = send(set)
  }

  // MARK: 15.F, the viewer.

  /// Opens the viewer on attachment `index`, from message `from`, pinning
  /// the scroll offset first.
  func open(_ index: Int, from message: String) {
    fade?.cancel()
    pinned = scrollY
    origin = message
    outlined = nil
    restore = nil
    viewerLine = Self.line(for: content.attachments, index: index, saved: saved)
    viewer = ViewerSet(items: content.attachments, index: index)
  }

  func next() {
    viewer?.next()
    refreshLine()
  }

  func previous() {
    viewer?.previous()
    refreshLine()
  }

  /// Esc: back to the pinned offset, with the originating message outlined
  /// for D-UI-109's seconds, not the one the arrows wandered to.
  func close() {
    guard viewer != nil else { return }
    viewer = nil
    restore = pinned
    outlined = origin
    fade?.cancel()
    let seconds = outlineSeconds
    fade = Task { [weak self] in
      try? await Task.sleep(for: .seconds(seconds))
      guard !Task.isCancelled else { return }
      self?.outlined = nil
    }
  }

  /// The view restored the offset.
  func restored() {
    restore = nil
  }

  /// cmd-S: a converted copy into Downloads, named.
  func save() {
    guard let item = viewer?.current else { return }
    do {
      let url = try saveCopy(item)
      saved[item.id] = url
      viewerLine = "Saved to Downloads as " + url.lastPathComponent
    } catch {
      viewerLine = "Not saved: " + error.localizedDescription
    }
  }

  /// opt-cmd-R: the saved copy, never the cache. Before a save it offers
  /// the save instead.
  func revealSaved() {
    guard let item = viewer?.current else { return }
    guard let url = saved[item.id] else {
      viewerLine = "Nothing saved yet. Save a copy first, then Reveal selects the file you own."
      return
    }
    reveal(url)
    viewerLine = "Revealed " + url.lastPathComponent + " in Finder"
  }

  /// cmd-C: the current item onto the clipboard.
  func copyCurrent() {
    guard let item = viewer?.current else { return }
    copy(item)
    viewerLine = "Copied " + item.wireName
  }

  private func refreshLine() {
    guard let viewer else { return }
    viewerLine = Self.line(for: viewer.items, index: viewer.index, saved: saved)
  }

  private static func line(for items: [StagedFile], index: Int, saved: [String: URL]) -> String {
    guard items.indices.contains(index), let url = saved[items[index].id] else { return cachedLine }
    return "Saved to Downloads as " + url.lastPathComponent
  }

  // MARK: 15.H, the refusal panel's fourth part.

  /// Moves the drafted words into the composer. Nothing sends (D-UI-106).
  func takeDraftedWords() {
    composerWords = content.draftedWords
  }
}
