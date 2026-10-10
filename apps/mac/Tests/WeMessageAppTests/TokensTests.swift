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

  /// Every value S4a adds: frost tints, hairlines, their opaque stand-ins,
  /// the CI backdrop's gradient stops and its stripe pair.
  static var s4aTokens: [Tokens.RGB] {
    [
      Tokens.Frost.tintLight, Tokens.Frost.tintDark,
      Tokens.Hairline.light.rgb, Tokens.Hairline.dark.rgb,
      Tokens.Hairline.opaqueLight, Tokens.Hairline.opaqueDark,
      Tokens.Backdrop.lightTop, Tokens.Backdrop.lightBottom, Tokens.Backdrop.darkTop, Tokens.Backdrop.darkBottom,
      Tokens.Backdrop.stripeDark, Tokens.Backdrop.stripeLight,
    ]
  }

  @Test("T1: no token is green (hue 75...165 with saturation over 0.10), S4a's frost, hairline and backdrop values included")
  func noGreen() {
    #expect(Tokens.all.count >= 24, "tokens swept: \(Tokens.all.count)")
    for rgb in Self.s4aTokens {
      #expect(Tokens.all.contains(rgb), "\(rgb) is not in the sweep")
    }
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

  @Test("T6 frostBandArithmetic: the D-UI-7 tint over the CI backdrop's mean lands inside the snapshot luminance bands with 0.05 to spare")
  func frostBandArithmetic() {
    // Plan 2.5: alpha times tint plus (1 minus alpha) times the backdrop's
    // mean colour; a light window stays above 0.65 and a dark one below 0.35.
    let light = Tokens.Frost.composite(dark: false, over: Tokens.Backdrop.mean(dark: false))
    let dark = Tokens.Frost.composite(dark: true, over: Tokens.Backdrop.mean(dark: true))
    #expect(light.luminance >= Tokens.Bands.lightFloor + Tokens.Bands.margin, "light frost \(light) L \(light.luminance)")
    #expect(dark.luminance <= Tokens.Bands.darkCeiling - Tokens.Bands.margin, "dark frost \(dark) L \(dark.luminance)")
    #expect(Tokens.Bands.lightFloor == 0.65)
    #expect(Tokens.Bands.darkCeiling == 0.35)
    #expect(Tokens.Bands.margin == 0.05)
    // The alpha is D-UI-7's default, read, never restated.
    #expect(Tokens.Frost.alpha(dark: false) == ProvisionalUI.frostTintStrength.alpha(dark: false))
    #expect(Tokens.Frost.alpha(dark: true) == ProvisionalUI.frostTintStrength.alpha(dark: true))
    // The backdrop runs light to dark top to bottom in both appearances, so
    // FrostEvidence's transmission (top minus bottom) is positive.
    for dark in [false, true] {
      let (top, bottom) = Tokens.Backdrop.stops(dark: dark)
      #expect(top.luminance > bottom.luminance, "dark=\(dark) backdrop does not darken downwards")
    }
    // The maths: compositing is per channel, rounded, and order matters.
    let half = Tokens.composite(Tokens.RGB(0xFF, 0xFF, 0xFF), alpha: 0.5, over: Tokens.RGB(0x00, 0x00, 0x00))
    #expect(half == Tokens.RGB(0x80, 0x80, 0x80))
    #expect(Tokens.composite(Tokens.tint, alpha: 1, over: Tokens.danger) == Tokens.tint)
    #expect(Tokens.composite(Tokens.tint, alpha: 0, over: Tokens.danger) == Tokens.danger)
    // Non-vacuity: a much lighter tint strength would push the dark frost
    // out of its band, so the row can fail.
    let washed = Tokens.composite(Tokens.Frost.tintLight, alpha: 0.9, over: Tokens.Backdrop.mean(dark: true))
    #expect(washed.luminance > Tokens.Bands.darkCeiling - Tokens.Bands.margin)
  }

  @Test("T7 frostContrast: inkDim reads at 7:1 or better over the composite frost, light and dark, at both backdrop stops and at the runner's measured frost")
  func frostContrast() {
    for dark in [false, true] {
      let inkDim = Tokens.palette(dark: dark).inkDim
      let (top, bottom) = Tokens.Backdrop.stops(dark: dark)
      for under in [top, bottom, Tokens.Backdrop.mean(dark: dark)] {
        let frost = Tokens.Frost.composite(dark: dark, over: under)
        #expect(Tokens.contrast(inkDim, frost) >= 7, "dark=\(dark) inkDim on frost \(frost) over \(under)")
      }
    }
    // What the runner really drew (.regularMaterial over this backdrop, S4a.0
    // spike run 37568873983): flat greys whose means ran 216.32 to 223.06
    // light and 33.98 to 39.30 dark. The worst of each still clears 7:1.
    let measuredLight = Tokens.RGB(216, 216, 216)
    let measuredDark = Tokens.RGB(40, 40, 40)
    #expect(Tokens.contrast(Tokens.Light.inkDim, measuredLight) >= 7)
    #expect(Tokens.contrast(Tokens.Dark.inkDim, measuredDark) >= 7)
    // Hairlines: the opaque stand-in is the translucent hairline composited
    // over layer0, within one step per channel.
    for dark in [false, true] {
      let hairline = dark ? Tokens.Hairline.dark : Tokens.Hairline.light
      let opaque = dark ? Tokens.Hairline.opaqueDark : Tokens.Hairline.opaqueLight
      let composed = Tokens.composite(hairline.rgb, alpha: hairline.alpha, over: Tokens.palette(dark: dark).layer0)
      for (a, b) in [(opaque.r, composed.r), (opaque.g, composed.g), (opaque.b, composed.b)] {
        #expect(abs(Int(a) - Int(b)) <= 1, "dark=\(dark) hairlineOpaque \(opaque) vs \(composed)")
      }
    }
    #expect(Tokens.Hairline.light.alpha == 0.08)
    #expect(Tokens.Hairline.dark.alpha == 0.09)
  }

  /// v2 S7b: the UI test target cannot compile Tokens.swift (it needs
  /// WeMessageKit), so BoardSweep.swift restates the two opaque hairline
  /// values. This row reads them back from the file and holds them to the
  /// tokens, so the sweep can never probe for a colour the app stopped
  /// drawing.
  @Test("the sweep's hairline probe reads the opaque hairline tokens")
  func sweepProbePinned() throws {
    let text = try Repo.text("apps/mac/UITests/WeMessageUITests/Support/BoardSweep.swift")
    func restated(_ name: String) throws -> Tokens.RGB? {
      let pattern = "static let \(name): Pixel = \\(0x([0-9A-F]{2}), 0x([0-9A-F]{2}), 0x([0-9A-F]{2})\\)"
      let regex = try NSRegularExpression(pattern: pattern)
      let matches = regex.matches(in: text, range: NSRange(text.startIndex..., in: text))
      guard matches.count == 1, let m = matches.first else { return nil }
      let parts = (1...3).compactMap { i in Range(m.range(at: i), in: text).flatMap { UInt8(text[$0], radix: 16) } }
      guard parts.count == 3 else { return nil }
      return Tokens.RGB(parts[0], parts[1], parts[2])
    }
    #expect(try restated("opaqueLight") == Tokens.Hairline.opaqueLight)
    #expect(try restated("opaqueDark") == Tokens.Hairline.opaqueDark)
    // Non-vacuity: the two tokens differ, so one cannot stand for both.
    #expect(Tokens.Hairline.opaqueLight != Tokens.Hairline.opaqueDark)
  }
}
