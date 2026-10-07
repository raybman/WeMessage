import Foundation
import SwiftUI

/// The shell's colours: the only file under Sources/WeMessageApp allowed to
/// hold a colour literal (AppHygieneTests H-A3). Blue is the one accent.
/// Nothing here is green, and TokensTests T1 sweeps every value for it,
/// because green is what "sent" looks like and an agent never sends.
///
/// Layer 1 and 2 are the opaque surfaces (bubbles, cards, inputs). Since
/// S4a the panes are transparent over one window frost (plan 2.4); with
/// Reduce Transparency the app paints layer0 under them itself.
public enum Tokens {
  public static let tint = RGB(0x0A, 0x84, 0xFF)
  public static let danger = RGB(0xFF, 0x45, 0x3A)

  public enum Dark {
    public static let ink = RGB(0xF5, 0xF5, 0xF7)
    public static let inkDim = RGB(0xD1, 0xD1, 0xD6)
    public static let layer0 = RGB(0x1C, 0x1C, 0x1E)
    public static let layer1 = RGB(0x2C, 0x2C, 0x2E)
    public static let layer2 = RGB(0x3A, 0x3A, 0x3C)
  }

  public enum Light {
    public static let ink = RGB(0x1C, 0x1C, 0x1E)
    public static let inkDim = RGB(0x3C, 0x3C, 0x43)
    public static let layer0 = RGB(0xF5, 0xF5, 0xF7)
    public static let layer1 = RGB(0xFF, 0xFF, 0xFF)
    public static let layer2 = RGB(0xF0, 0xF0, 0xF5)
  }

  /// The window frost the D-UI-7 tint models (plan 2.4). The app draws the
  /// D-UI-21 material, not this tint: the arithmetic below is what the
  /// luminance bands and the contrast rule are checked against.
  public enum Frost {
    public static let tintLight = RGB(0xEE, 0xEE, 0xF4)
    public static let tintDark = RGB(0x1C, 0x1C, 0x22)

    public static func tint(dark: Bool) -> RGB { dark ? tintDark : tintLight }
    /// D-UI-7's default strength, read from ProvisionalUI.
    public static func alpha(dark: Bool) -> Double { ProvisionalUI.frostTintStrength.alpha(dark: dark) }
    /// The tint at its alpha over `under`.
    public static func composite(dark: Bool, over under: RGB) -> RGB {
      Tokens.composite(tint(dark: dark), alpha: alpha(dark: dark), over: under)
    }
  }

  /// A colour drawn at an alpha.
  public struct Wash: Equatable, Sendable {
    public let rgb: RGB
    public let alpha: Double
  }

  /// The 0.5 pt pane dividers: translucent over frost, and their composite
  /// over layer0 when Reduce Transparency paints the window opaque.
  public enum Hairline {
    public static let light = Wash(rgb: RGB(0x00, 0x00, 0x00), alpha: 0.08)
    public static let dark = Wash(rgb: RGB(0xFF, 0xFF, 0xFF), alpha: 0.09)
    public static let opaqueLight = RGB(0xE1, 0xE1, 0xE3)
    public static let opaqueDark = RGB(0x30, 0x30, 0x32)
  }

  /// The CI-only backdrop window (plan 2.5, D-UI-12): a two-stop grey-blue
  /// gradient, top then bottom, and the black and white stripe band the
  /// frost evidence samples.
  public enum Backdrop {
    public static let lightTop = RGB(0xD9, 0xDC, 0xE6)
    public static let lightBottom = RGB(0xB9, 0xBE, 0xC9)
    public static let darkTop = RGB(0x2A, 0x2C, 0x33)
    public static let darkBottom = RGB(0x15, 0x16, 0x1B)
    public static let stripeDark = RGB(0x00, 0x00, 0x00)
    public static let stripeLight = RGB(0xFF, 0xFF, 0xFF)

    public static func stops(dark: Bool) -> (top: RGB, bottom: RGB) {
      dark ? (darkTop, darkBottom) : (lightTop, lightBottom)
    }

    /// The gradient's mean colour.
    public static func mean(dark: Bool) -> RGB {
      let (top, bottom) = stops(dark: dark)
      return composite(top, alpha: 0.5, over: bottom)
    }
  }

  /// The snapshot luminance bands (SnapshotTests): a light shell's mean
  /// luminance stays above the floor and a dark one below the ceiling; the
  /// frost arithmetic keeps the margin clear of both.
  public enum Bands {
    public static let lightFloor = 0.65
    public static let darkCeiling = 0.35
    public static let margin = 0.05
  }

  /// `top` at `alpha` over `under`, per sRGB channel, rounded. Pure.
  public static func composite(_ top: RGB, alpha: Double, over under: RGB) -> RGB {
    func mix(_ a: UInt8, _ b: UInt8) -> UInt8 {
      UInt8((alpha * Double(a) + (1 - alpha) * Double(b)).rounded().clamped(to: 0...255))
    }
    return RGB(mix(top.r, under.r), mix(top.g, under.g), mix(top.b, under.b))
  }

  /// One appearance's neutrals.
  public struct Palette: Equatable, Sendable {
    public let ink, inkDim, layer0, layer1, layer2: RGB
  }

  public static func palette(dark: Bool) -> Palette {
    dark
      ? Palette(ink: Dark.ink, inkDim: Dark.inkDim, layer0: Dark.layer0, layer1: Dark.layer1, layer2: Dark.layer2)
      : Palette(ink: Light.ink, inkDim: Light.inkDim, layer0: Light.layer0, layer1: Light.layer1, layer2: Light.layer2)
  }

  /// Every value above, for the no-green unit row.
  public static var all: [RGB] {
    let dark = palette(dark: true)
    let light = palette(dark: false)
    return [tint, danger]
      + [dark.ink, dark.inkDim, dark.layer0, dark.layer1, dark.layer2]
      + [light.ink, light.inkDim, light.layer0, light.layer1, light.layer2]
      + [Frost.tintLight, Frost.tintDark]
      + [Hairline.light.rgb, Hairline.dark.rgb, Hairline.opaqueLight, Hairline.opaqueDark]
      + [Backdrop.lightTop, Backdrop.lightBottom, Backdrop.darkTop, Backdrop.darkBottom]
      + [Backdrop.stripeDark, Backdrop.stripeLight]
  }

  /// WCAG 2 contrast ratio between two opaque sRGB colours, 1...21, order
  /// free. Pure. The shell holds every text colour at 7:1 or better on
  /// every layer (TokensTests T5): the system accessibility audit failed
  /// inkDim at 5.58:1 on layer 2 (S3c, ci-swift run 37555284794).
  public static func contrast(_ a: RGB, _ b: RGB) -> Double {
    let la = a.luminance
    let lb = b.luminance
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
  }

  /// An sRGB triple with the HSB maths the green sweep needs. Pure.
  public struct RGB: Equatable, Sendable, CustomStringConvertible {
    public let r, g, b: UInt8

    public init(_ r: UInt8, _ g: UInt8, _ b: UInt8) {
      self.r = r
      self.g = g
      self.b = b
    }

    private var unit: (Double, Double, Double) { (Double(r) / 255, Double(g) / 255, Double(b) / 255) }

    /// Hue in degrees, 0..<360; 0 for a grey.
    public var hue: Double {
      let (r, g, b) = unit
      let hi = max(r, g, b)
      let delta = hi - min(r, g, b)
      if delta == 0 { return 0 }
      var h: Double
      if hi == r {
        h = (g - b) / delta
      } else if hi == g {
        h = 2 + (b - r) / delta
      } else {
        h = 4 + (r - g) / delta
      }
      h *= 60
      return h < 0 ? h + 360 : h
    }

    /// HSB saturation, 0...1; 0 for black and for a grey.
    public var saturation: Double {
      let (r, g, b) = unit
      let hi = max(r, g, b)
      return hi == 0 ? 0 : (hi - min(r, g, b)) / hi
    }

    /// WCAG 2 relative luminance, 0...1.
    public var luminance: Double {
      func linear(_ c: Double) -> Double { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
      let (r, g, b) = unit
      return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
    }

    public var description: String { "RGB(\(r), \(g), \(b))" }
  }

  static func color(_ rgb: RGB, opacity: Double = 1) -> Color {
    Color(.sRGB, red: Double(rgb.r) / 255, green: Double(rgb.g) / 255, blue: Double(rgb.b) / 255, opacity: opacity)
  }

  static func color(_ wash: Wash) -> Color { color(wash.rgb, opacity: wash.alpha) }
}

extension Double {
  fileprivate func clamped(to range: ClosedRange<Double>) -> Double { Swift.min(Swift.max(self, range.lowerBound), range.upperBound) }
}
