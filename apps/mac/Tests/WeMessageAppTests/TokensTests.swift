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

  @Test("T5: ink and inkDim read at 7:1 or better on every layer of both appearances (the audit failed inkDim at 5.58:1)")
  func contrast() {
    for dark in [false, true] {
      let p = Tokens.palette(dark: dark)
      for layer in [p.layer0, p.layer1, p.layer2] {
        #expect(Tokens.contrast(p.ink, layer) >= 7, "dark=\(dark) ink on \(layer)")
        #expect(Tokens.contrast(p.inkDim, layer) >= 7, "dark=\(dark) inkDim on \(layer)")
      }
    }
    // The maths: black on white is 21:1, symmetric, and the S3c audit's
    // failing pair (run 37555284794) measures as it did.
    let black = Tokens.RGB(0, 0, 0)
    let white = Tokens.RGB(255, 255, 255)
    #expect(abs(Tokens.contrast(black, white) - 21) < 0.01)
    #expect(Tokens.contrast(white, black) == Tokens.contrast(black, white))
    let failed = Tokens.contrast(Tokens.RGB(95, 95, 102), Tokens.RGB(240, 240, 245))
    #expect(failed > 5.5 && failed < 5.7)
  }

  @Test("T5b: light inkDim clears 9.5:1 on every light layer (the audit samples antialiased pixels)")
  func lightInkDimMargin() {
    // The audit runs in light appearance and measures rendered pixels, so
    // small text reads below its nominal ratio: ci-swift run 37556851103
    // failed 4E4E54 at a nominal 7.27:1 on layer2 and called 7.59:1 on
    // layer0 "nearly passed".
    let p = Tokens.palette(dark: false)
    for layer in [p.layer0, p.layer1, p.layer2] {
      #expect(Tokens.contrast(p.inkDim, layer) >= 9.5, "light inkDim on \(layer)")
    }
    #expect(Tokens.contrast(Tokens.RGB(0x4E, 0x4E, 0x54), p.layer2) < 9.5)
  }
}
