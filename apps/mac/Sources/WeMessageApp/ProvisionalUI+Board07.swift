import Foundation

// PROVISIONAL pending Eric's D-UI-138 and 170..179 decisions (v2 B4, board
// 07, the voice dock drawn over fixtures: plan row 108 renumbered +30 to
// D-UI-138, and the defaults the board 07 wireframe leaves open numbered
// from D-UI-170). Every value below is the plan's default, chosen only so
// the dock can be built and tested before the design questions are
// answered. They live in this one file on purpose, beside ProvisionalUI.swift
// and in the same enum: when the decisions land, this file is the whole
// edit, and VoiceDockHygieneTests fails if any of these values is copied as
// a literal into another app or UI test source. Foundation only: the UI test
// bundle compiles this file too.
extension ProvisionalUI {
  // D-UI-138: the dock is anchored bottom-centre over the reader (the
  // transcript), 12 pt above its bottom edge, in three widths: idle 320,
  // speaking 420 and confirm 520 pt. One anchor for all three; only the
  // width and the height change.
  public static let voiceDockGap: Double = 12
  public static let voiceDockWidthIdle: Double = 320
  public static let voiceDockWidthSpeaking: Double = 420
  public static let voiceDockWidthConfirm: Double = 520

  // D-UI-170: the nine chips, one visible at a time, each a glyph and a
  // word. State is carried by shape, weight and label, never by colour.
  public static let voiceChipIdle = "\u{25CB} Idle"
  public static let voiceChipListening = "\u{25C9} Listening"
  public static let voiceChipSpeaking = "\u{266A} Speaking"
  public static let voiceChipThinking = "\u{2026} Thinking"
  public static let voiceChipDriving = "\u{2197} Driving"
  public static let voiceChipInterrupted = "\u{2716} Interrupted"
  public static let voiceChipUnheard = "\u{25EF} Did not catch that"
  public static let voiceChipConfirm = "\u{26A0} Confirm"
  public static let voiceChipMuted = "\u{270B} Muted by you"

  // D-UI-171: the chips' shapes. A 1 pt ink outline by default; Confirm a
  // 3 pt outline; Did not catch that a dashed 1 pt outline; Muted by you
  // inverted (ink fill, layer1 word). The active chips (Listening,
  // Speaking, Driving, Confirm) set their word bold, the rest regular.
  public static let voiceChipBorder: Double = 1
  public static let voiceChipConfirmBorder: Double = 3
  public static let voiceChipDash: [Double] = [3, 2]
  public static let voiceChipFontSize: Double = 11

  // D-UI-172: the caption is always drawn, in every state, with no switch
  // to hide it: 13 pt ink, at most three lines, truncated at the tail. A
  // state that brings no words of its own reads its chip's word instead.
  public static let voiceCaptionSize: Double = 13
  public static let voiceCaptionLines = 3

  // D-UI-173: the confirm card. A spoken approve only arms it; it names
  // the recipient, the channel, the readback token it matched and the
  // draft verbatim, and its one way forward is cmd-Return (or a click on
  // Send), through the same approve path and undo window as A. Cancel
  // disarms this card and leaves the draft where it was. The words To and
  // Cancel are the app's own (Compose, Queue, Settings), not new choices.
  public static let voiceCardOn = "On"
  public static let voiceCardToken = "Readback token"
  public static let voiceCardMatched = "matched"
  public static let voiceCardArmedLine = "Armed by voice. Only \u{2318}\u{21A9} sends it."
  public static let voiceCardDisarmedLine = "Disarmed. The draft stays in the queue."
  public static let voiceCardSend = "Send \u{2318}\u{21A9}"

  // D-UI-174: the six failure lines (07.F), one under the caption while
  // the fixture names a failure. Names are the fixture people's.
  public static let voiceFailureUnheard = "Nothing heard. Nothing was done."
  public static func voiceFailureMisheard(opened: String, heard: String, meant: String) -> String {
    "Opened \(opened). Heard \u{201C}\(heard)\u{201D}. Meant \(meant)? \u{2318}["
  }
  public static let voiceFailureSelfHeard = "\u{201C}approve\u{201D} arrived during playout, discarded."
  public static let voiceFailureInterrupted = "Stopped mid-word. The view does not snap back."
  public static let voiceFailureTransport =
    "Voice link expired while this was armed. Card disarmed. Draft kept, nothing was sent."
  public static let voiceFailureMuted = "Readback suppressed. Drafts are shown, never spoken."

  // D-UI-175: the mic indicator says what the fixture says, in words, as
  // a glyph and a value: muted or open. This version has no microphone;
  // the indicator never asks for one.
  public static let voiceMicMuted = "Mic muted"
  public static let voiceMicOpen = "Mic open"

  // D-UI-176: the dock's surface is opaque layer1 with a 1 pt inkDim rule
  // and a 14 pt corner, the Reduce Transparency safe form. Glass over the
  // reader is deferred until the dock has a real engine behind it.
  public static let voiceDockCorner: Double = 14
  public static let voiceDockRule: Double = 1

  // D-UI-177: Cancel is a click, never Escape: Escape keeps its ladder
  // (composer, selection, thread, Triage), so a dock that armed by voice
  // cannot change what Escape does.
  public enum VoiceCancelKey: Sendable {
    case clickOnly
  }
  public static let voiceCancelKey: VoiceCancelKey = .clickOnly

  // D-UI-178: the dock is drawn for the open thread only, over the
  // transcript and never over the channel banner or the composer, and
  // only while the fixture gate is open. Without a voice state there is
  // no dock at all, not an empty one.
  public enum VoiceDockScope: Sendable {
    case openThreadTranscript
  }
  public static let voiceDockScope: VoiceDockScope = .openThreadTranscript

  // D-UI-179: the reader insets from the dock's measured rect: its bottom
  // padding is the dock's overlap with the reader plus the gap, so the
  // last line always sits above the dock in every size. Measured, never a
  // fixed height.
  public enum VoiceReaderInset: Sendable {
    case measuredOverlapPlusGap
  }
  public static let voiceReaderInset: VoiceReaderInset = .measuredOverlapPlusGap
}
