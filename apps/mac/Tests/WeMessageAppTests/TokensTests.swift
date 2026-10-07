import Foundation
import Testing

@testable import WeMessageApp

/// T1 to T4: the shell's colours. Blue is the only accent; green never
/// appears, because green is what "sent" looks like and an agent never sends.
@Suite("Tokens")
struct TokensTests {
  /// The H49 rule, ported: a colour is green when its hue sits in 75...165
  /// degrees and it is saturated enough to read as a colour at all.
  static func isGreen(_ rgb: Tokens.RGB) -> Bool {
    (75.0...165.0).contains(rgb.hue) && rgb.saturation > 0.10
  }

  @Test("T1: no token is green (hue 75...165 with saturation over 0.10)")
  func noGreen() {
    #expect(Tokens.all.count >= 12, "tokens swept: \(Tokens.all.count)")
    for rgb in Tokens.all {
      #expect(!Self.isGreen(rgb), "green token \(rgb) hue \(rgb.hue) saturation \(rgb.saturation)")
    }
  }

  @Test("T2: the tint is the system blue")
  func tint() {
    #expect(Tokens.tint == Tokens.RGB(0x0A, 0x84, 0xFF))
    #expect(Tokens.all.contains(Tokens.tint))
    #expect(Tokens.all.contains(Tokens.danger))
  }

  @Test("T3: the layer-0 anchors of both appearances")
  func anchors() {
    #expect(Tokens.Dark.layer0 == Tokens.RGB(0x1C, 0x1C, 0x1E))
    #expect(Tokens.Light.layer0 == Tokens.RGB(0xF5, 0xF5, 0xF7))
    #expect(Tokens.palette(dark: true).layer0 == Tokens.Dark.layer0)
    #expect(Tokens.palette(dark: false).layer0 == Tokens.Light.layer0)
  }

  @Test("T4: non-vacuity, the sweep's own maths calls system green green and the tint not")
  func sweepSeesGreen() {
    let green = Tokens.RGB(0x34, 0xC7, 0x59)
    #expect((75.0...165.0).contains(green.hue))
    #expect(green.saturation > 0.10)
    #expect(Self.isGreen(green))
    #expect(!Self.isGreen(Tokens.tint))
    #expect(abs(Tokens.tint.hue - 210) < 1, "tint hue \(Tokens.tint.hue)")
    #expect(Tokens.RGB(0x80, 0x80, 0x80).saturation == 0)
  }
}
