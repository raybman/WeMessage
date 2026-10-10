import Foundation
import Testing

/// v2 S7b (G2 rubric 8.3): every colour value in the mac app lives in one
/// file, WeMessageApp/Tokens.swift. The App target's H-A3 row already bans
/// the common spellings inside Sources/WeMessageApp; this row is wider on
/// both axes. It walks every module under apps/mac/Sources (the kit and the
/// daemon host too, so a colour cannot hide in a module the app imports) and
/// it knows the rarer initialisers: hex helpers, explicit colour spaces,
/// white/hue components, NSColor and CGColor component initialisers, colour
/// literals, 6-digit hex constants and Tokens' own RGB(0x..) spelling.
///
/// Named system neutrals (Color.white, Color.black) are not literals: they
/// carry no value a designer picks, and the share card draws its photo
/// scrim with them. They are left to the H-A3 family on purpose (plan, S7b
/// deviations).
@Suite("TokenHygiene")
struct TokenHygieneTests {
  static let sourcesRoot = "apps/mac/Sources"
  /// The one file allowed to spell a colour value.
  static let allowlist: Set<String> = ["WeMessageApp/Tokens.swift"]

  /// One alternation per family, so a failure names the spelling it caught.
  static let patterns: [(String, String)] = [
    ("SwiftUI Color components", #"\bColor\(\s*(red|white|hue|hex|\.sRGB|\.displayP3|\.linearSRGB)\s*[:,]"#),
    (
      "NSColor components",
      #"\bNSColor\(\s*(red|srgbRed|calibratedRed|deviceRed|displayP3Red|white|calibratedWhite|deviceWhite|genericGamma22White|hue|calibratedHue|deviceHue|hex)\s*:"#
    ),
    ("CGColor components", #"\bCGColor\(\s*(red|srgbRed|gray|genericGrayGamma2_2Gray|colorSpace)\s*:"#),
    ("colour literal", #"#colorLiteral"#),
    ("6-digit hex constant", #"\b0x[0-9A-Fa-f]{6}\b"#),
    ("Tokens RGB spelling", #"\bRGB\(\s*0x"#),
    ("hex string", ##""#[0-9A-Fa-f]{6}\b"##),
  ]

  /// (family, line) for every colour value `text` spells.
  static func hits(_ text: String) throws -> [(String, Int)] {
    var out: [(String, Int)] = []
    let range = NSRange(text.startIndex..., in: text)
    for (family, pattern) in patterns {
      let regex = try NSRegularExpression(pattern: pattern)
      for match in regex.matches(in: text, range: range) {
        let prefix = text[..<(Range(match.range, in: text)!.lowerBound)]
        out.append((family, prefix.reduce(1) { $1 == "\n" ? $0 + 1 : $0 }))
      }
    }
    return out
  }

  static func swiftFiles() throws -> [String] {
    try Repo.files(under: sourcesRoot, skipping: [".build", ".swiftpm"]).filter { $0.hasSuffix(".swift") }
  }

  @Test("no colour value outside Tokens.swift, in any module under apps/mac/Sources")
  func onlyTokensSpellsColour() throws {
    let files = try Self.swiftFiles()
    #expect(files.count >= 50, "sources found: \(files.count)")
    var offenders: [String] = []
    for file in files where !Self.allowlist.contains(file) {
      for (family, line) in try Self.hits(try Repo.text(Self.sourcesRoot + "/" + file)) {
        offenders.append("\(file):\(line) \(family)")
      }
    }
    #expect(offenders.isEmpty, "colour values outside Tokens.swift:\n\(offenders.joined(separator: "\n"))")
  }

  @Test("non-vacuity: the allowlist is one file and that file is full of colour")
  func tokensIsTheSource() throws {
    #expect(Self.allowlist.count == 1)
    let files = try Self.swiftFiles()
    for allowed in Self.allowlist { #expect(files.contains(allowed), "\(allowed) is gone") }
    let tokens = try Self.hits(try Repo.text(Self.sourcesRoot + "/WeMessageApp/Tokens.swift"))
    #expect(tokens.count >= 12, "Tokens.swift colour values: \(tokens.count)")
  }

  @Test("every family fires on its own spelling and stays quiet on a token reference")
  func familiesFire() throws {
    let samples: [(String, String)] = [
      ("SwiftUI Color components", "let c = Color(red: 0.1, green: 0.2, blue: 0.3)"),
      ("SwiftUI Color components", "let c = Color(hex: 0x0A84FF)"),
      ("SwiftUI Color components", "let c = Color(.sRGB, red: 1, green: 0, blue: 0)"),
      ("NSColor components", "let c = NSColor(calibratedWhite: 0.5, alpha: 1)"),
      ("CGColor components", "let c = CGColor(gray: 0.5, alpha: 1)"),
      ("colour literal", "let c = #colorLiteral(red: 1, green: 0, blue: 0, alpha: 1)"),
      ("6-digit hex constant", "let c = 0x0A84FF"),
      ("Tokens RGB spelling", "let c = RGB(0x0A, 0x84, 0xFF)"),
      ("hex string", ##"let c = "#0A84FF""##),
    ]
    for (family, line) in samples {
      #expect(try Self.hits(line).contains { $0.0 == family }, "\(family) missed: \(line)")
    }
    let quiet = [
      "let c = Tokens.color(palette.ink)",
      "let c = Color.white.opacity(0.6)",
      "let mask: UInt32 = 0xFF",
      "let id = 0x0A84FF12",
    ]
    for line in quiet { #expect(try Self.hits(line).isEmpty, "false hit: \(line)") }
    #expect(try Self.hits("a\nb\nlet c = 0x0A84FF").map(\.1) == [3])
  }
}
