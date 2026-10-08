import Foundation

// v2 S4k, board 15: sending media, the pure half. A file gets in by the
// attach button, a drop, or a paste, and all three land in one staging
// tray; nothing here can send. The walls are read from a dated config
// (SizeWallConfig.swift), every video carries its duration, and recording is
// absent on iMessage with a printed reason rather than greyed.

/// The four channels board 15 draws a wall for.
public enum MediaChannel: String, Codable, CaseIterable, Sendable {
  case imessage, whatsapp, linkedin, email

  public var title: String {
    switch self {
    case .imessage: "iMessage"
    case .whatsapp: "WhatsApp"
    case .linkedin: "LinkedIn"
    case .email: "Email"
    }
  }
}

/// How a staged file fits a wall. TIGHT fits an assumed cap near its edge:
/// dotted, because the cap itself is not verified.
public enum WallFit: String, Sendable {
  case yes, tight, no

  public var token: String {
    switch self {
    case .yes: "YES"
    case .tight: "TIGHT"
    case .no: "NO"
    }
  }
}

/// One channel's wall, with the day it was last checked.
public struct SizeWall: Codable, Equatable, Sendable {
  public enum Basis: String, Codable, Sendable {
    case perItem, perMessage
  }

  public let channel: MediaChannel
  public let bytes: Int64
  public let basis: Basis
  /// Not queryable: the number is an assumption and is labelled as one.
  public let assumed: Bool
  /// The day the number was last checked, yyyy-MM-dd. Required.
  public let asOf: String
  public let source: String
  /// The wire factor: 1 on a chat channel, about 1.37 (base64) on email.
  public let encodingOverhead: Double

  /// "about 100 MB per attachment".
  public var printed: String {
    let size = SizeText.megabytes(bytes)
    let unit = basis == .perItem ? "per attachment" : "per message"
    return (assumed ? "about " : "") + size + " " + unit
  }

  /// The wall and its date, as the hover says it.
  public var dated: String { printed + ", as of " + asOf }

  /// How `bytes` on disk fit this wall once encoded for the wire.
  public func fit(_ bytes: Int64) -> WallFit {
    let wire = Double(bytes) * encodingOverhead
    if wire > Double(self.bytes) { return .no }
    if assumed && wire > Double(self.bytes) * 0.9 { return .tight }
    return .yes
  }
}

/// The dated walls, one per channel.
public struct SizeWallTable: Codable, Equatable, Sendable {
  public let walls: [SizeWall]

  public init(walls: [SizeWall]) { self.walls = walls }

  public static func decode(_ data: Data) throws -> SizeWallTable {
    let table = try JSONDecoder().decode(SizeWallTable.self, from: data)
    for wall in table.walls where !Self.isDay(wall.asOf) {
      throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "\(wall.channel) is not dated"))
    }
    return table
  }

  /// The config as shipped. A config that does not decode leaves no wall,
  /// and no wall means no Send (StagingTray.canSend).
  public static let standard: SizeWallTable =
    (try? decode(Data(config.utf8))) ?? SizeWallTable(walls: [])

  public func wall(for channel: MediaChannel) -> SizeWall? {
    walls.first { $0.channel == channel }
  }

  static func isDay(_ text: String) -> Bool {
    text.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil
  }
}

/// Sizes the way the board prints them: decimal megabytes, one place under
/// 100, none at or above.
public enum SizeText {
  public static func megabytes(_ bytes: Int64) -> String {
    let mb = Double(bytes) / 1_000_000
    if mb >= 100 { return String(Int(mb.rounded())) + " MB" }
    return String(format: "%.1f MB", mb)
  }
}

/// A file in the tray. A video's duration is part of its kind, so there is
/// no way to stage a video without one.
public struct StagedFile: Equatable, Identifiable, Sendable {
  public enum ImageFormat: String, Sendable {
    case heic = "HEIC"
    case jpeg = "JPG"
    case png = "PNG"
  }

  public enum Kind: Equatable, Sendable {
    case image(ImageFormat)
    case video(seconds: Int)
    /// Any other file, by its upper-cased extension (PDF).
    case document(String)
  }

  public let id: String
  public let name: String
  public let kind: Kind
  public let bytes: Int64
  public let width: Int?
  public let height: Int?
  /// Carries location metadata, which is stripped on the way out.
  public let hasLocation: Bool

  public init(id: String, name: String, kind: Kind, bytes: Int64, width: Int? = nil, height: Int? = nil, hasLocation: Bool = false) {
    self.id = id
    self.name = name
    self.kind = kind
    self.bytes = bytes
    self.width = width
    self.height = height
    self.hasLocation = hasLocation
  }

  /// A clipboard image has no filename: one is invented and shown before
  /// the send, because the recipient keeps it forever.
  public static func pasted(bytes: Int64, width: Int, height: Int, at: Date, timeZone: TimeZone = .current) -> StagedFile {
    let format = DateFormatter()
    format.locale = Locale(identifier: "en_US_POSIX")
    format.timeZone = timeZone
    format.dateFormat = "yyyy-MM-dd-HHmm"
    let name = "pasted-" + format.string(from: at) + ".png"
    return StagedFile(id: name, name: name, kind: .image(.png), bytes: bytes, width: width, height: height)
  }

  public var isVideo: Bool {
    if case .video = kind { return true }
    return false
  }

  public var isImage: Bool {
    if case .image = kind { return true }
    return false
  }

  public var isHEIC: Bool { kind == .image(.heic) }

  /// The name on the wire: HEIC leaves as JPEG.
  public var wireName: String {
    guard isHEIC else { return name }
    let stem = (name as NSString).deletingPathExtension
    return stem + ".jpg"
  }

  /// The tray thumbnail's chip. A video's is its duration, always.
  public var chip: String {
    switch kind {
    case .image(let format): format.rawValue
    case .video(let seconds): "\u{25B6} " + CompressionTable.duration(seconds)
    case .document(let ext): ext
    }
  }

  /// The tray's line under the chip: frame, size, and a video's duration.
  public var meta: String {
    var parts: [String] = []
    if let width, let height { parts.append("\(width)\u{00D7}\(height)") }
    parts.append(SizeText.megabytes(bytes))
    if case .video(let seconds) = kind { parts.append(CompressionTable.duration(seconds)) }
    return parts.joined(separator: " \u{00B7} ")
  }
}

/// 08.D's geometry, which the tray previews: two are a 2-up 88 pt grid,
/// three to five a 3-up 64 pt grid, more than five show five and a +N cell.
public struct RecipientGrid: Equatable, Sendable {
  public let columns: Int
  public let cell: Int
  public let shown: Int
  public let overflow: Int

  public init(columns: Int, cell: Int, shown: Int, overflow: Int) {
    self.columns = columns
    self.cell = cell
    self.shown = shown
    self.overflow = overflow
  }

  public static func `for`(_ count: Int) -> RecipientGrid {
    switch count {
    case ...0: RecipientGrid(columns: 0, cell: 0, shown: 0, overflow: 0)
    case 1: RecipientGrid(columns: 1, cell: 176, shown: 1, overflow: 0)
    case 2: RecipientGrid(columns: 2, cell: 88, shown: 2, overflow: 0)
    case 3...5: RecipientGrid(columns: 3, cell: 64, shown: count, overflow: 0)
    default: RecipientGrid(columns: 3, cell: 64, shown: 5, overflow: count - 5)
    }
  }
}

/// The staging tray: the one place a file waits, and the only thing a send
/// can be built from (Outbound's attachment intent takes a tray).
public struct StagingTray: Equatable, Sendable {
  public let channel: MediaChannel
  public private(set) var items: [StagedFile] = []
  public var caption = ""
  private let wall: SizeWall?

  public init(channel: MediaChannel, walls: SizeWallTable) {
    self.channel = channel
    self.wall = walls.wall(for: channel)
  }

  public var isEmpty: Bool { items.isEmpty }

  public mutating func stage(_ files: [StagedFile]) {
    for file in files where !items.contains(where: { $0.id == file.id }) { items.append(file) }
  }

  public mutating func remove(_ id: String) { items.removeAll { $0.id == id } }

  public mutating func clear() {
    items = []
    caption = ""
  }

  /// Files over the wall as they stand. A staged file over it stops the
  /// send; nothing offers to send anyway.
  public var overWall: [StagedFile] {
    guard let wall else { return items }
    return items.filter { wall.fit($0.bytes) == .no }
  }

  /// Send is live only with something staged, a known wall, and nothing
  /// over it.
  public var canSend: Bool { !items.isEmpty && wall != nil && overWall.isEmpty }

  public var header: String {
    if items.isEmpty { return "Nothing staged" }
    let n = items.count
    if items.allSatisfy(\.isImage) { return "Staged \u{00B7} \(n) image" + (n == 1 ? "" : "s") }
    return "Staged \u{00B7} \(n) item" + (n == 1 ? "" : "s")
  }

  public var totals: String {
    let total = items.reduce(Int64(0)) { $0 + $1.bytes }
    let largest = items.map(\.bytes).max() ?? 0
    return SizeText.megabytes(total) + " \u{00B7} largest " + SizeText.megabytes(largest)
  }

  public var conversionLine: String? {
    let n = items.filter(\.isHEIC).count
    guard n > 0 else { return nil }
    return "\(n) HEIC will be sent as JPEG. Quality 0.9, dimensions unchanged, originals untouched on disk."
  }

  public var locationLine: String? {
    let images = items.filter(\.isImage)
    let n = images.filter(\.hasLocation).count
    guard n > 0 else { return nil }
    return "Location metadata removed from \(n) of \(images.count). Orientation, date and dimensions are kept."
  }

  /// The wall, on screen from the first file.
  public var counter: String {
    guard let wall else { return "No wall is known for " + channel.title + ", so nothing can send." }
    let over = overWall.count
    if over > 0 {
      return "\(over) item" + (over == 1 ? " is" : "s are") + " over " + channel.title + "'s wall of " + wall.printed
        + ". Remove it, or look at the smaller copies below."
    }
    let largest = items.map(\.bytes).max() ?? 0
    return SizeText.megabytes(max(0, wall.bytes - largest)) + " left under " + channel.title + "'s wall of " + wall.printed
      + ". Largest staged item " + SizeText.megabytes(largest) + "."
  }

  public var grid: RecipientGrid { RecipientGrid.for(items.count) }
}

/// The compression decision for one staged video: one row per target, the
/// wall drawn into every row, and the duration in every row.
public enum CompressionTable {
  public struct Row: Equatable, Sendable {
    public let target: String
    public let frame: String
    public let size: String
    public let duration: String
    public let fit: WallFit

    /// The row read aloud: target, size, duration and fit.
    public var line: String { target + ", " + size + ", " + duration + ", " + fit.token }
  }

  /// H.264 targets and the bitrates their estimates come from, in kbps.
  static let targets: [(name: String, width: Int, height: Int, kbps: Int)] = [
    ("1080p H.264", 1920, 1080, 3050),
    ("720p H.264", 1280, 720, 1333),
    ("540p H.264", 960, 540, 413),
  ]

  public static func rows(for file: StagedFile, wall: SizeWall) -> [Row] {
    guard case .video(let seconds) = file.kind else { return [] }
    let time = duration(seconds)
    var rows = [
      Row(
        target: "Original", frame: frame(file.width, file.height),
        size: SizeText.megabytes(file.bytes) + " exact", duration: time, fit: wall.fit(file.bytes))
    ]
    for t in targets where t.height < (file.height ?? Int.max) {
      let mb = Int((Double(t.kbps) * Double(seconds) / 8000).rounded())
      rows.append(
        Row(
          target: t.name, frame: frame(t.width, t.height), size: "\(mb) MB estimate", duration: time,
          fit: wall.fit(Int64(mb) * 1_000_000)))
    }
    return rows
  }

  /// 4:12, 0:48, 1:02:03.
  public static func duration(_ seconds: Int) -> String {
    let s = max(0, seconds)
    if s >= 3600 { return String(format: "%d:%02d:%02d", s / 3600, (s % 3600) / 60, s % 60) }
    return String(format: "%d:%02d", s / 60, s % 60)
  }

  static func frame(_ width: Int?, _ height: Int?) -> String {
    guard let width, let height else { return "" }
    return "\(width)\u{00D7}\(height)"
  }
}

/// Where a drag is.
public enum DropZone: Equatable, Sendable {
  case thread
  case listRow(String)
  case rail
  case blockedChat
}

/// What the drop card says while the hand is still on the mouse.
public struct DropSummary: Equatable, Sendable {
  public let count: Int
  public let images: Int
  public let videos: Int
  public let line: String
  public let detail: String
  public let overWall: Int
  public let wallLine: String?

  public var title: String { "Drop to stage" }
  public var promise: String { "Nothing sends. They stage as a draft and you press Send." }
}

/// The three properties a target changes at once (15.A): an inset dashed
/// field, a white scrim, and the thread behind it dimmed. Hatched is the
/// refused look.
public struct DropLook: Equatable, Sendable {
  public let field: Bool
  public let inset: Double
  public let dash: Double
  public let scrim: Double
  public let threadOpacity: Double
  public let hatched: Bool

  public static let resting = DropLook(field: false, inset: 0, dash: 0, scrim: 0, threadOpacity: 1, hatched: false)
  public static let targeted = DropLook(field: true, inset: 7, dash: 3, scrim: 0.72, threadOpacity: 0.35, hatched: false)
  public static let refused = DropLook(field: false, inset: 7, dash: 0, scrim: 0, threadOpacity: 1, hatched: true)
}

public enum DropState: Equatable, Sendable {
  case resting
  case targeted(DropSummary)
  /// Over a list row, waiting for its thread to open.
  case dwelling(row: String)
  case refused(String)

  public var look: DropLook {
    switch self {
    case .resting, .dwelling: .resting
    case .targeted: .targeted
    case .refused: .refused
    }
  }

  /// A short name for the accessibility value.
  public var name: String {
    switch self {
    case .resting: "resting"
    case .targeted: "targeted"
    case .dwelling: "dwelling"
    case .refused: "refused"
    }
  }
}

/// What a drop did. There is no send case.
public enum DropOutcome: Equatable, Sendable {
  case staged([StagedFile])
  case refused(String)
}

/// The drop target's state machine. It stages or refuses; it never sends.
public struct DropMachine: Equatable, Sendable {
  public static let dwellMilliseconds = 600
  public static let railReason = "A scope rail is not a recipient. Drop onto a thread."
  public static let blockedReason = "This chat is not shown or indexed here, so it cannot take a file either."
  public static let unseenReason = "The thread had not opened yet. Hold over the row until it does."

  public private(set) var state: DropState = .resting
  /// The list row whose thread the dwell opened.
  public private(set) var openedRow: String?
  public let channel: MediaChannel
  public let recipient: String
  private let walls: SizeWallTable
  private var files: [StagedFile] = []

  public init(channel: MediaChannel, recipient: String, walls: SizeWallTable) {
    self.channel = channel
    self.recipient = recipient
    self.walls = walls
  }

  public mutating func enter(_ zone: DropZone, files: [StagedFile]) {
    self.files = files
    switch zone {
    case .thread: state = .targeted(summary(files))
    case .listRow(let row): state = .dwelling(row: row)
    case .rail: state = .refused(Self.railReason)
    case .blockedChat: state = .refused(Self.blockedReason)
    }
  }

  /// The 600 ms dwell over a row has passed: its thread opens, then the
  /// field appears there.
  public mutating func dwellElapsed() {
    guard case .dwelling(let row) = state else { return }
    openedRow = row
    state = .targeted(summary(files))
  }

  public mutating func exit() {
    state = .resting
    files = []
  }

  /// The drop itself: the files to stage, or the reason they were refused.
  public mutating func drop(_ files: [StagedFile]) -> DropOutcome {
    let outcome: DropOutcome
    switch state {
    case .targeted: outcome = .staged(files)
    case .refused(let why): outcome = .refused(why)
    case .dwelling: outcome = .refused(Self.unseenReason)
    case .resting: outcome = .refused(Self.unseenReason)
    }
    state = .resting
    self.files = []
    return outcome
  }

  func summary(_ files: [StagedFile]) -> DropSummary {
    let images = files.filter(\.isImage).count
    let videos = files.filter(\.isVideo).count
    var kinds: [String] = []
    if images > 0 { kinds.append("\(images) image" + (images == 1 ? "" : "s")) }
    if videos > 0 { kinds.append("\(videos) video" + (videos == 1 ? "" : "s")) }
    let others = files.count - images - videos
    if others > 0 { kinds.append("\(others) file" + (others == 1 ? "" : "s")) }
    let total = files.reduce(Int64(0)) { $0 + $1.bytes }
    let wall = walls.wall(for: channel)
    let over = wall.map { w in files.filter { w.fit($0.bytes) == .no }.count } ?? files.count
    let wallLine: String? =
      over == 0
      ? nil
      : "\(over) item" + (over == 1 ? " is" : "s are") + " over " + channel.title + "'s "
        + (wall?.printed ?? "unknown") + " wall. You will be asked what to do with it before anything goes."
    return DropSummary(
      count: files.count, images: images, videos: videos,
      line: "\(files.count) file" + (files.count == 1 ? "" : "s") + " onto " + recipient + " \u{00B7} " + channel.title,
      detail: kinds.joined(separator: ", ") + " \u{00B7} " + SizeText.megabytes(total) + " total",
      overWall: over, wallLine: wallLine)
  }
}

/// Recording a voice note, per channel. Absent is not disabled: there is no
/// greyed case, because a greyed control promises a condition the user can
/// meet.
public enum RecordControl: Equatable, Sendable {
  case available
  case absent(String)
  /// The platform records only in its own mobile app.
  case phone(String)

  public static func on(_ channel: MediaChannel) -> RecordControl {
    switch channel {
    case .whatsapp: .available
    case .imessage:
      .absent(
        "No voice note from here. iMessage would get an audio file, not a voice message with a waveform and expiry. "
          + "Record an audio file instead, or say it in words.")
    case .linkedin: .phone("LinkedIn records a voice message only in its own mobile app.")
    case .email: .absent("Email has no voice note.")
    }
  }

  /// Whether any record control is drawn at all.
  public var drawsControl: Bool { self == .available }

  public var reason: String? {
    switch self {
    case .available: nil
    case .absent(let why), .phone(let why): why
    }
  }
}

/// The viewer's set: this thread's attachments in thread order, nothing
/// else. Navigation stops at both ends; it never wraps or crosses threads.
public struct ViewerSet: Equatable, Sendable {
  public let items: [StagedFile]
  public private(set) var index: Int

  public init(items: [StagedFile], index: Int) {
    self.items = items
    self.index = min(max(0, index), max(0, items.count - 1))
  }

  public var current: StagedFile? { items.indices.contains(index) ? items[index] : nil }
  public var position: String { "\(index + 1) / \(items.count)" }
  public var canGoBack: Bool { index > 0 }
  public var canGoForward: Bool { index + 1 < items.count }

  public mutating func next() { if canGoForward { index += 1 } }
  public mutating func previous() { if canGoBack { index -= 1 } }

  /// "4 images, 2 videos, 1 PDF": the mix said in words.
  public var kinds: String {
    var counts: [(String, Int)] = []
    let images = items.filter(\.isImage).count
    let videos = items.filter(\.isVideo).count
    if images > 0 { counts.append((images == 1 ? "image" : "images", images)) }
    if videos > 0 { counts.append((videos == 1 ? "video" : "videos", videos)) }
    var docs: [String: Int] = [:]
    var order: [String] = []
    for item in items {
      if case .document(let ext) = item.kind {
        if docs[ext] == nil { order.append(ext) }
        docs[ext, default: 0] += 1
      }
    }
    for ext in order { counts.append((ext, docs[ext] ?? 0)) }
    return counts.map { "\($0.1) \($0.0)" }.joined(separator: ", ")
  }
}
