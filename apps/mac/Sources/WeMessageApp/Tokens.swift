import Foundation
import SwiftUI

/// The shell's colours: the only file under Sources/WeMessageApp allowed to
/// hold a colour literal (AppHygieneTests H-A3). Blue is the one accent.
/// Nothing here is green, and TokensTests T1 sweeps every value for it,
/// because green is what "sent" looks like and an agent never sends.
///
/// Layer 1 and 2 are the opaque reduced-transparency values: S3 draws no
/// frost, the alpha variants arrive with the vibrancy pass.
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

  /// S4a.0 spike only (build/s4-spike, never merged): the backdrop window's
  /// two-stop grey-blue gradient, top then bottom, per plan section 2.5.
  public enum SpikeBackdrop {
    public static let lightTop = RGB(0xD9, 0xDC, 0xE6)
    public static let lightBottom = RGB(0xB9, 0xBE, 0xC9)
    public static let darkTop = RGB(0x2A, 0x2C, 0x33)
    public static let darkBottom = RGB(0x15, 0x16, 0x1B)
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

  static func color(_ rgb: RGB) -> Color {
    Color(.sRGB, red: Double(rgb.r) / 255, green: Double(rgb.g) / 255, blue: Double(rgb.b) / 255, opacity: 1)
  }
}
