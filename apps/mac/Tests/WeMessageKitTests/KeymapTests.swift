import Foundation
import Testing

@testable import WeMessageKit

/// v2 S4j, board 13.F: the keymap. The five verbs, the movement pair and the
/// hold-to-talk chord are the user's; cmd-Return, bare Return, Z and the kill
/// chord are fixed. validate() refuses S (held for Star), bare Return and any
/// collision with a fixed row, and the map round-trips through settings.
@Suite("Keymap")
struct KeymapTests {
  static func with(_ verb: Verb, _ key: Character) -> Keymap {
    var map = Keymap.default
    map.verbs[verb] = key
    return map
  }

  @Test("the default map is valid and is the triage keys' letters: R A E H M, J and K, hold shift-cmd-V")
  func defaults() {
    let map = Keymap.default
    #expect(map.validate() == [])
    #expect(Keymap.editableVerbs.map { map.verbs[$0].map(String.init) } == ["r", "a", "e", "h", "m"])
    #expect(map.movement == [Keymap.Pair(next: "j", previous: "k")])
    #expect(map.holdToTalk?.printed == "\u{21E7}\u{2318}V")
    #expect(map.reboundCount == 0)
  }

  @Test("validate rejects S for any verb and for movement")
  func rejectsStar() {
    #expect(Self.with(.done, "s").validate() == [.star("s")])
    var moved = Keymap.default
    moved.movement = [Keymap.Pair(next: "s", previous: "k")]
    #expect(moved.validate() == [.star("s")])
  }

  @Test("validate rejects bare Return, as a verb or as the hold chord; cmd-Return is the send chord, so it is reserved")
  func rejectsBareReturn() {
    #expect(Self.with(.reply, "\r").validate() == [.bareReturn])
    var hold = Keymap.default
    hold.holdToTalk = Keymap.Chord(key: "\r", modifiers: [])
    #expect(hold.validate() == [.bareReturn])
    hold.holdToTalk = Keymap.Chord(key: "\r", modifiers: [.command])
    #expect(hold.validate() == [.reserved("\u{2318}\u{21A9}")])
  }

  @Test("validate rejects the reserved letters and chords: Z, X, shift-cmd-K, cmd-comma")
  func rejectsReserved() {
    #expect(Self.with(.mute, "z").validate() == [.reserved("z")])
    #expect(Self.with(.snooze, "x").validate() == [.reserved("x")])
    var hold = Keymap.default
    hold.holdToTalk = Keymap.Chord(key: "k", modifiers: [.command, .shift])
    #expect(hold.validate() == [.reserved("\u{21E7}\u{2318}K")])
    hold.holdToTalk = Keymap.Chord(key: ",", modifiers: [.command])
    #expect(hold.validate() == [.reserved("\u{2318},")])
    hold.holdToTalk = Keymap.Chord(key: "q", modifiers: [])
    #expect(hold.validate() == [.reserved("q")], "a bare-letter hold types into every list")
    hold.holdToTalk = nil
    #expect(hold.validate() == [], "hold to talk may be off")
    hold.holdToTalk = Keymap.Chord(key: "", modifiers: [.function])
    #expect(hold.validate() == [], "hold Fn is allowed")
  }

  @Test("validate rejects two rows on one key, a non-letter, a missing verb and a verb that is not editable")
  func rejectsCollisions() {
    #expect(Self.with(.done, "a").validate() == [.duplicate("a")])
    #expect(Self.with(.done, "j").validate() == [.duplicate("j")])
    #expect(Self.with(.done, "1").validate() == [.notALetter("1")])
    #expect(Self.with(.done, "E").validate() == [.notALetter("E")])
    var missing = Keymap.default
    missing.verbs[.mute] = nil
    #expect(missing.validate() == [.missing(.mute)])
    #expect(Self.with(.undo, "u").validate() == [.notEditable(.undo)])
  }

  @Test("a valid rebind counts as rebound; Done on D is fine")
  func rebound() {
    let map = Self.with(.done, "d")
    #expect(map.validate() == [])
    #expect(map.reboundCount == 1)
  }

  @Test("the fixed rows are exactly cmd-Return, bare Return, Z and the kill chord, each with a reason")
  func fixedRows() {
    let fixed = Keymap.fixed()
    #expect(fixed.map(\.id) == ["send", "return", "undo", "kill"])
    #expect(fixed.map(\.chord) == ["\u{2318}\u{21A9}", "\u{21A9}", "Z", "\u{21E7}\u{2318}K"])
    #expect(fixed.allSatisfy { !$0.reason.isEmpty && !$0.reason.contains("\u{2014}") })
  }

  /// A settings read holding `value` under keymap.bindings.
  static func settings(_ value: String?) throws -> [String: SettingEntry] {
    let entry: String
    if let value {
      let quoted = String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
      entry = #"{"value":\#(quoted),"default":null,"version":1,"type":"enum","readOnly":false}"#
    } else {
      entry = #"{"value":null,"default":null,"version":-1,"type":"enum","readOnly":false}"#
    }
    let json = #"{"settings":{"keymap.bindings":\#(entry)}}"#
    return try JSONDecoder().decode(SettingsEnvelope.self, from: Data(json.utf8)).settings
  }

  @Test("round trip through settings: a rebind is written as one string and read back equal; a missing, broken or invalid value reads as the default")
  func roundTrip() throws {
    let map = Self.with(.done, "d")
    guard case .string(let text) = try map.settingValue() else {
      Issue.record("the keymap is not written as a string")
      return
    }
    #expect(Keymap.from(try Self.settings(text)) == map)
    #expect(try Keymap.default.settingValue() == Keymap.default.settingValue(), "one map, one string")
    #expect(Keymap.from([:]) == .default)
    #expect(Keymap.from(try Self.settings(nil)) == .default)
    #expect(Keymap.from(try Self.settings("{not json")) == .default)
    guard case .string(let star) = try Self.with(.done, "s").settingValue() else { return }
    #expect(Keymap.from(try Self.settings(star)) == .default, "a stored map that fails validate is not used")
  }
}
