import Foundation
import WeMessageKit

/// v2 B4, board 07: the voice dock's words and shape, read from
/// status.meta.voice. Pure: the same voice state, thread and queue always
/// give the same dock. There is no speech engine in this version: the state
/// comes from the fake daemon's fixtures, and nothing here listens, speaks
/// or sends. A spoken approve only ever arms the confirm card; the one way
/// forward is cmd-Return, through ShellModel.voiceCommit and the approve
/// path A uses.
struct VoiceDockModel: Equatable, Sendable {
  /// The three sizes (D-UI-138), one anchor.
  enum Size: String, CaseIterable, Sendable {
    case idle, speaking, confirm

    var width: Double {
      switch self {
      case .idle: ProvisionalUI.voiceDockWidthIdle
      case .speaking: ProvisionalUI.voiceDockWidthSpeaking
      case .confirm: ProvisionalUI.voiceDockWidthConfirm
      }
    }
  }

  /// The nine chips (D-UI-170, D-UI-171). One is drawn at a time; each is
  /// told apart by its glyph, word, outline and weight, never a colour.
  enum Chip: String, CaseIterable, Sendable {
    case idle, listening, speaking, thinking, driving, interrupted, unheard, confirm, muted

    var label: String {
      switch self {
      case .idle: ProvisionalUI.voiceChipIdle
      case .listening: ProvisionalUI.voiceChipListening
      case .speaking: ProvisionalUI.voiceChipSpeaking
      case .thinking: ProvisionalUI.voiceChipThinking
      case .driving: ProvisionalUI.voiceChipDriving
      case .interrupted: ProvisionalUI.voiceChipInterrupted
      case .unheard: ProvisionalUI.voiceChipUnheard
      case .confirm: ProvisionalUI.voiceChipConfirm
      case .muted: ProvisionalUI.voiceChipMuted
      }
    }

    /// The word alone, after the glyph and its space.
    var word: String { String(label.drop { $0 != " " }.dropFirst()) }

    var border: Double { self == .confirm ? ProvisionalUI.voiceChipConfirmBorder : ProvisionalUI.voiceChipBorder }
    var dashed: Bool { self == .unheard }
    var inverted: Bool { self == .muted }
    var bold: Bool { [.listening, .speaking, .driving, .confirm].contains(self) }

    /// What the chip looks like, as one comparable value: no two chips
    /// share it, so the nine are told apart without colour.
    var shape: String { "\(label)|\(border)|\(dashed)|\(inverted)|\(bold)" }
  }

  /// The six failure modes (07.F, D-UI-174).
  enum Failure: String, CaseIterable, Sendable {
    case unheard, misheard, selfheard, interrupted, transport, muted
  }

  let size: Size
  let chip: Chip
  /// Always non-empty (D-UI-172): there is no way to hide it.
  let caption: String
  let micMuted: Bool
  let readbackToken: String?
  let failure: Failure?
  let failureLine: String?
  /// The draft the confirm card is for, when the state names one.
  let draftId: String?
  /// True only when a spoken approve armed the card for the thread's
  /// pending draft and nothing since disarmed it (selfheard never arms;
  /// a dead transport disarms).
  let armed: Bool

  var micLine: String { micMuted ? ProvisionalUI.voiceMicMuted : ProvisionalUI.voiceMicOpen }

  /// The dock for `voice` (status.meta.voice) over the open thread, or nil
  /// when there is no voice state or it does not name a size: no state
  /// means no dock, never an empty one (D-UI-178).
  static func make(_ voice: JSONValue?, threadTitle: String, pendingDraftId: String?) -> VoiceDockModel? {
    guard case .object(let v)? = voice, let size = v.string("dockState").flatMap(Size.init(rawValue:)) else {
      return nil
    }
    let failure = v.string("failure").flatMap(Failure.init(rawValue:))
    let chip = v.string("chip").flatMap(Chip.init(rawValue:)) ?? defaultChip(size: size, failure: failure)
    let caption = v.string("caption").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) } ?? ""
    let draftId = v.string("draftId")
    let spokenArm = v.bool("armed") == true
    let armed =
      spokenArm && size == .confirm && failure == nil && draftId != nil && draftId == pendingDraftId
    return VoiceDockModel(
      size: size, chip: chip, caption: caption.isEmpty ? chip.word : caption, micMuted: v.bool("micMuted") == true,
      readbackToken: v.string("readbackToken"), failure: failure,
      failureLine: failure.map {
        line($0, opened: threadTitle, heard: v.string("heard") ?? "", meant: v.string("meant") ?? "")
      },
      draftId: draftId, armed: armed)
  }

  static func defaultChip(size: Size, failure: Failure?) -> Chip {
    switch failure {
    case .unheard: return .unheard
    case .interrupted: return .interrupted
    case .muted: return .muted
    case .misheard: return .driving
    case .selfheard, .transport, nil: break
    }
    switch size {
    case .idle: return .idle
    case .speaking: return .speaking
    case .confirm: return .confirm
    }
  }

  static func line(_ failure: Failure, opened: String, heard: String, meant: String) -> String {
    switch failure {
    case .unheard: ProvisionalUI.voiceFailureUnheard
    case .misheard: ProvisionalUI.voiceFailureMisheard(opened: opened, heard: heard, meant: meant)
    case .selfheard: ProvisionalUI.voiceFailureSelfHeard
    case .interrupted: ProvisionalUI.voiceFailureInterrupted
    case .transport: ProvisionalUI.voiceFailureTransport
    case .muted: ProvisionalUI.voiceFailureMuted
    }
  }
}

/// D-UI-138 and D-UI-179: where the dock sits and how far the reader
/// insets from it. Pure, so the no-overlap rule is a unit row.
enum VoiceDockLayout {
  /// The reader's bottom padding: how far the dock reaches up into a
  /// reader `readerHeight` tall (the dock's measured top edge, in the
  /// reader's own space), plus the gap. Zero without a dock.
  static func readerInset(readerHeight: Double, dockMinY: Double?, gap: Double = ProvisionalUI.voiceDockGap) -> Double {
    guard let dockMinY else { return 0 }
    return max(0, readerHeight - dockMinY) + gap
  }

  /// True when content ending `inset` above the reader's bottom clears a
  /// dock whose top edge is at `dockMinY`.
  static func clears(readerHeight: Double, dockMinY: Double, inset: Double) -> Bool {
    readerHeight - inset <= dockMinY
  }
}

extension [String: JSONValue] {
  fileprivate func string(_ key: String) -> String? {
    if case .string(let s)? = self[key] { return s }
    return nil
  }

  fileprivate func bool(_ key: String) -> Bool? {
    if case .bool(let b)? = self[key] { return b }
    return nil
  }
}
