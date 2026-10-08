import Foundation

// v2 S4j, board 13.F: the keyboard map as a settings table. Three things
// are the user's to move: the five verb letters, the movement pair and the
// hold-to-talk chord. Everything else is fixed, and each fixed row carries
// its reason. A binding the user cannot see the reason for is a binding they
// will rebind.

/// The keys a user may move, and the fixed rows they may not.
public struct Keymap: Equatable, Sendable {
  /// The five verbs a user may move, in the table's order.
  public static let editableVerbs: [Verb] = [.reply, .approve, .done, .snooze, .mute]

  /// The settings key the map round-trips through (a JSON string; the
  /// daemon does not serve it yet, so a missing key reads as the default).
  public static let settingKey = "keymap.bindings"

  /// Next and previous thread. The arrows always work besides; they are not
  /// a binding and cannot be removed.
  public struct Pair: Equatable, Sendable {
    public var next: Character
    public var previous: Character

    public init(next: Character, previous: Character) {
      self.next = next
      self.previous = previous
    }
  }

  public enum Modifier: String, Codable, CaseIterable, Comparable, Sendable {
    case control, option, shift, command, function

    public static func < (a: Modifier, b: Modifier) -> Bool {
      allCases.firstIndex(of: a)! < allCases.firstIndex(of: b)!
    }

    var glyph: String {
      switch self {
      case .control: "\u{2303}"
      case .option: "\u{2325}"
      case .shift: "\u{21E7}"
      case .command: "\u{2318}"
      case .function: "Fn"
      }
    }
  }

  /// A held chord: a key (empty for Fn alone) and its modifiers.
  public struct Chord: Codable, Equatable, Sendable {
    public var key: String
    public var modifiers: [Modifier]

    public init(key: String, modifiers: [Modifier]) {
      self.key = key.lowercased()
      self.modifiers = Array(Set(modifiers)).sorted()
    }

    /// The chord as macOS prints it: modifiers in their fixed order, then
    /// the key upper-cased.
    public var printed: String {
      let key: String
      switch self.key {
      case "\r", "\n": key = "\u{21A9}"
      case ",": key = ","
      default: key = self.key.uppercased()
      }
      return modifiers.map(\.glyph).joined() + key
    }
  }

  public var verbs: [Verb: Character]
  public var movement: [Pair]
  /// nil: hold to talk is off.
  public var holdToTalk: Chord?

  public init(verbs: [Verb: Character], movement: [Pair], holdToTalk: Chord?) {
    self.verbs = verbs
    self.movement = movement
    self.holdToTalk = holdToTalk
  }

  /// The defaults the triage keys are written against (01.D, 06.D).
  public static let `default` = Keymap(
    verbs: [.reply: "r", .approve: "a", .done: "e", .snooze: "h", .mute: "m"],
    movement: [Pair(next: "j", previous: "k")],
    holdToTalk: Chord(key: "v", modifiers: [.shift, .command]))

  /// How many verbs differ from the default.
  public var reboundCount: Int {
    Self.editableVerbs.filter { verbs[$0] != Self.default.verbs[$0] }.count
  }

  // MARK: the fixed rows

  /// A row the user cannot change, and why.
  public struct Fixed: Equatable, Sendable {
    public let id: String
    public let action: String
    public let chord: String
    public let reason: String
  }

  /// cmd-Return, bare Return, Z and the kill chord: fixed, each with its
  /// reason (13.F).
  public static func fixed() -> [Fixed] {
    [
      Fixed(
        id: "send", action: "Send / Approve", chord: sendChord.printed,
        reason: "One gesture for the one act that reaches the network, app-wide. Rebinding it makes every printed hint wrong about the most consequential key."),
      Fixed(
        id: "return", action: "Bare Return never sends", chord: "\u{21A9}",
        reason: "Not a binding, an invariant: Return opens or adds a line. There is no switch for this."),
      Fixed(
        id: "undo", action: "Undo last triage act", chord: "Z",
        reason: "Every destructive key has a paired undo. Rebinding Done and losing undo makes the app less safe."),
      Fixed(
        id: "kill", action: "Kill switch", chord: killChord.printed,
        reason: "Printed on its chip in the title bar, so nobody has to look it up under stress."),
    ]
  }

  public static let sendChord = Chord(key: "\r", modifiers: [.command])
  public static let killChord = Chord(key: "k", modifiers: [.shift, .command])
  public static let settingsChord = Chord(key: ",", modifiers: [.command])
  /// The bare letters other rows hold: undo and add to selection.
  static let reservedLetters: Set<Character> = ["z", "x"]
  /// The chords no editable row may take.
  static let reservedChords = [sendChord, killChord, settingsChord, Chord(key: "\r", modifiers: [])]

  // MARK: validation

  public enum Problem: Equatable, Sendable {
    /// A verb missing from the map, or one that is not editable.
    case missing(Verb)
    case notEditable(Verb)
    /// A verb or movement key that is not one letter a to z.
    case notALetter(String)
    /// S is held for Star, which the product does not have (plan S4j).
    case star(String)
    /// Return bound without cmd.
    case bareReturn
    /// The key or chord belongs to a fixed row.
    case reserved(String)
    /// Two rows on one key.
    case duplicate(String)
  }

  /// Every reason this map cannot be saved; empty when it can.
  public func validate() -> [Problem] {
    var problems: [Problem] = []
    for verb in Self.editableVerbs where verbs[verb] == nil { problems.append(.missing(verb)) }
    for verb in Verb.allCases where verbs[verb] != nil && !Self.editableVerbs.contains(verb) {
      problems.append(.notEditable(verb))
    }
    var letters: [Character] = Self.editableVerbs.compactMap { verbs[$0] }
    for pair in movement { letters += [pair.next, pair.previous] }
    var seen: Set<Character> = []
    for key in letters {
      let text = String(key)
      if key == "\r" || key == "\n" || key == "\r\n" {
        problems.append(.bareReturn)
        continue
      }
      guard key.isASCII, key.isLetter, key.isLowercase else {
        problems.append(.notALetter(text))
        continue
      }
      if key == "s" { problems.append(.star(text)) }
      if Self.reservedLetters.contains(key) { problems.append(.reserved(text)) }
      if !seen.insert(key).inserted { problems.append(.duplicate(text)) }
    }
    if let chord = holdToTalk {
      if chord.key == "\r" && !chord.modifiers.contains(.command) {
        problems.append(.bareReturn)
      } else if Self.reservedChords.contains(chord) {
        problems.append(.reserved(chord.printed))
      } else if chord.modifiers.isEmpty, let only = chord.key.first, chord.key.count == 1 {
        // A bare-letter hold would type into every list.
        problems.append(seen.contains(only) ? .duplicate(chord.key) : .reserved(chord.key))
      }
    }
    return problems
  }

  // MARK: settings

  /// The map as the settings patch writes it.
  public func settingValue() throws -> SettingPatchValue {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let data = try encoder.encode(self)
    return .string(String(decoding: data, as: UTF8.self))
  }

  /// The map a settings read holds: the stored one when it decodes and
  /// validates, else the default.
  public static func from(_ settings: [String: SettingEntry]) -> Keymap {
    guard case .string(let text)? = settings[settingKey]?.value,
      let map = try? JSONDecoder().decode(Keymap.self, from: Data(text.utf8)),
      map.validate().isEmpty
    else { return .default }
    return map
  }
}

extension Keymap: Codable {
  enum CodingKeys: String, CodingKey {
    case verbs, movement, holdToTalk
  }

  private struct WirePair: Codable {
    var next: String
    var previous: String
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let raw = try c.decode([String: String].self, forKey: .verbs)
    var verbs: [Verb: Character] = [:]
    for (name, key) in raw {
      guard let verb = Verb(rawValue: name), key.count == 1, let char = key.first else {
        throw DecodingError.dataCorruptedError(forKey: .verbs, in: c, debugDescription: "bad binding \(name)=\(key)")
      }
      verbs[verb] = char
    }
    let pairs = try c.decode([WirePair].self, forKey: .movement)
    let movement = try pairs.map { pair -> Pair in
      guard pair.next.count == 1, pair.previous.count == 1, let n = pair.next.first, let p = pair.previous.first else {
        throw DecodingError.dataCorruptedError(forKey: .movement, in: c, debugDescription: "bad pair")
      }
      return Pair(next: n, previous: p)
    }
    let hold = try c.decodeIfPresent(Chord.self, forKey: .holdToTalk)
    self.init(verbs: verbs, movement: movement, holdToTalk: hold)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    var raw: [String: String] = [:]
    for (verb, key) in verbs { raw[verb.rawValue] = String(key) }
    try c.encode(raw, forKey: .verbs)
    try c.encode(movement.map { WirePair(next: String($0.next), previous: String($0.previous)) }, forKey: .movement)
    try c.encode(holdToTalk, forKey: .holdToTalk)
  }
}
