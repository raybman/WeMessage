import AppKit
import Foundation
import XCTest

/// Measures the contrast an element actually renders, from its screenshot.
///
/// Why this exists: on the ci-swift runner (Xcode 26.6, 17F113, 1x display)
/// the audit's `.contrast` check flags the shell's three small inkDim labels
/// (runs 37557960836 and 37558534074), while their own pixels measure 9.6:1
/// to 10.1:1 against the surface: dark glyph cores of rgb(60,60,67) on
/// rgb(240,240,245) and rgb(245,245,247). Tokens.swift already proves the
/// token pair, and TokensTests holds it at 7:1. A contrast issue is set aside
/// only when this measurement clears the WCAG AA text bar; anything darker
/// on darker, or lighter on lighter, still fails the run.
enum PixelContrast {
  /// WCAG AA for body text.
  static let floor = 4.5

  /// Fewest pixels that must reach the measured ink colour, so one stray
  /// pixel on a border cannot vouch for a whole label.
  static let minInkPixels = 4

  struct Measurement: CustomStringConvertible {
    let background: (UInt8, UInt8, UInt8)
    let ink: (UInt8, UInt8, UInt8)
    let ratio: Double
    let inkPixels: Int
    var passes: Bool { ratio >= PixelContrast.floor && inkPixels >= PixelContrast.minInkPixels }
    var description: String {
      String(
        format: "bg=rgb(%d,%d,%d) ink=rgb(%d,%d,%d) ratio=%.2f inkPixels=%d", background.0, background.1,
        background.2, ink.0, ink.1, ink.2, ratio, inkPixels)
    }
  }

  /// Relative luminance of an sRGB colour (WCAG 2).
  static func luminance(_ r: UInt8, _ g: UInt8, _ b: UInt8) -> Double {
    func lin(_ v: UInt8) -> Double {
      let c = Double(v) / 255
      return c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  }

  static func ratio(_ a: Double, _ b: Double) -> Double {
    (max(a, b) + 0.05) / (min(a, b) + 0.05)
  }

  /// Background is the most common colour; ink is the colour farthest from
  /// it in luminance. inkPixels counts pixels within 1% of the ink's ratio.
  static func measure(_ image: CGImage) -> Measurement? {
    let width = image.width
    let height = image.height
    guard width > 0, height > 0, let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
    var bytes = [UInt8](repeating: 0, count: width * height * 4)
    var drawn = false
    bytes.withUnsafeMutableBytes { raw in
      guard
        let ctx = CGContext(
          data: raw.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
          space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
      else { return }
      ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
      drawn = true
    }
    guard drawn else { return nil }

    var counts: [UInt32: Int] = [:]
    for i in stride(from: 0, to: bytes.count, by: 4) {
      let key = UInt32(bytes[i]) << 16 | UInt32(bytes[i + 1]) << 8 | UInt32(bytes[i + 2])
      counts[key, default: 0] += 1
    }
    guard let bgKey = counts.max(by: { $0.value < $1.value })?.key else { return nil }
    func split(_ k: UInt32) -> (UInt8, UInt8, UInt8) {
      (UInt8(k >> 16 & 0xFF), UInt8(k >> 8 & 0xFF), UInt8(k & 0xFF))
    }
    let bg = split(bgKey)
    let bgL = luminance(bg.0, bg.1, bg.2)

    var best = (key: bgKey, ratio: 1.0)
    var ratios: [UInt32: Double] = [:]
    for key in counts.keys {
      let c = split(key)
      let r = ratio(bgL, luminance(c.0, c.1, c.2))
      ratios[key] = r
      if r > best.ratio { best = (key, r) }
    }
    let inkPixels = ratios.filter { $0.value >= best.ratio * 0.99 }.reduce(0) { $0 + counts[$1.key, default: 0] }
    return Measurement(background: bg, ink: split(best.key), ratio: best.ratio, inkPixels: inkPixels)
  }
}
