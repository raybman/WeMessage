import AppKit
import Foundation
import XCTest

/// The no-green sweep over a window snapshot (plan §4.10, §5.4).
///
/// Zero green in the UI, blue only. The one green the window may show is the
/// system zoom button, so the traffic-light band at the top-leading corner is
/// masked; everything else is swept. Coordinates are top-leading pixels, the
/// way a PNG is stored.
enum NoGreen {
  /// The tint, written here and in Tokens.swift; arch R-A14 holds the two
  /// triples equal.
  static let tintRGB: (UInt8, UInt8, UInt8) = (0x0A, 0x84, 0xFF)
  static let tintHue = hue(tintRGB.0, tintRGB.1, tintRGB.2)

  /// What counts as green: a hue in this range with this much saturation.
  static let greenHues: ClosedRange<Double> = 75...165
  static let minGreenSaturation = 0.10
  /// Below this channel spread a pixel is grey whatever its hue says
  /// (a near-black rgb(10,12,10) has HSV saturation 0.17 and hue 120).
  static let minChroma = 6

  /// The traffic-light band, in pixels: 78 by 52 points scaled by the
  /// snapshot's own pixels per point.
  static func trafficLightBand(pngSize: CGSize, windowWidthPoints: CGFloat) -> CGRect {
    let k = windowWidthPoints > 0 ? pngSize.width / windowWidthPoints : 1
    return CGRect(x: 0, y: 0, width: 78 * k, height: 52 * k)
  }

  struct Sweep {
    var offenders = 0
    var swept = 0
    var total = 0
  }

  /// Green pixels outside `band`, and how many pixels were looked at.
  static func sweep(_ png: Data, excluding band: CGRect) -> Sweep? {
    guard let px = Pixels(png) else { return nil }
    var result = Sweep(total: px.width * px.height)
    for y in 0..<px.height {
      for x in 0..<px.width {
        if band.contains(CGPoint(x: Double(x) + 0.5, y: Double(y) + 0.5)) { continue }
        result.swept += 1
        let (r, g, b, a) = px[x, y]
        if a > 0 && isGreen(r, g, b) { result.offenders += 1 }
      }
    }
    return result
  }

  /// Green pixels outside `band`; -1 when the PNG does not decode.
  static func offenders(_ png: Data, excluding band: CGRect) -> Int {
    sweep(png, excluding: band)?.offenders ?? -1
  }

  /// Pixels within `tolerance` degrees of `hue` and at least `minSaturation`.
  static func tinted(_ png: Data, hue target: Double, tolerance: Double, minSaturation: Double) -> Int {
    guard let px = Pixels(png) else { return -1 }
    var n = 0
    for y in 0..<px.height {
      for x in 0..<px.width {
        let (r, g, b, a) = px[x, y]
        guard a > 0, saturation(r, g, b) >= minSaturation else { continue }
        let d = abs(hue(r, g, b) - target)
        if min(d, 360 - d) <= tolerance { n += 1 }
      }
    }
    return n
  }

  /// True when one colour covers 99.5% of the image or it does not decode.
  static func isBlank(_ png: Data) -> Bool {
    let px = Pixels(png)
    let total = (px?.width ?? 0) * (px?.height ?? 0)
    guard let px, total > 0 else { return total == 0 }
    var counts: [UInt32: Int] = [:]
    for y in 0..<px.height {
      for x in 0..<px.width {
        let (r, g, b, _) = px[x, y]
        counts[UInt32(r) << 16 | UInt32(g) << 8 | UInt32(b), default: 0] += 1
      }
    }
    let top = counts.values.max() ?? 0
    return Double(top) >= 0.995 * Double(total)
  }

  /// Mean WCAG relative luminance, 0 (black) to 1 (white).
  static func meanLuminance(_ png: Data) -> Double {
    guard let px = Pixels(png), px.width * px.height > 0 else { return -1 }
    var sum = 0.0
    for y in 0..<px.height {
      for x in 0..<px.width {
        let (r, g, b, _) = px[x, y]
        sum += PixelContrast.luminance(r, g, b)
      }
    }
    return sum / Double(px.width * px.height)
  }

  /// The pixel size of a PNG.
  static func size(_ png: Data) -> CGSize? {
    Pixels(png).map { CGSize(width: $0.width, height: $0.height) }
  }

  /// A synthetic opaque PNG: mid grey, with each (x, y, 0xRRGGBB) painted,
  /// x and y top-leading. The sweep's non-vacuity probes.
  static func probe(width: Int, height: Int, pixels: [(Int, Int, UInt32)]) -> Data {
    var bytes = [UInt8](repeating: 0, count: width * height * 4)
    for i in stride(from: 0, to: bytes.count, by: 4) {
      bytes[i] = 0x80
      bytes[i + 1] = 0x80
      bytes[i + 2] = 0x80
      bytes[i + 3] = 0xFF
    }
    for (x, y, rgb) in pixels {
      let i = (y * width + x) * 4
      bytes[i] = UInt8(rgb >> 16 & 0xFF)
      bytes[i + 1] = UInt8(rgb >> 8 & 0xFF)
      bytes[i + 2] = UInt8(rgb & 0xFF)
    }
    guard
      let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4,
        hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: width * 4, bitsPerPixel: 32),
      let data = rep.bitmapData
    else { return Data() }
    data.update(from: bytes, count: bytes.count)
    return rep.representation(using: .png, properties: [:]) ?? Data()
  }

  // MARK: colour

  static func isGreen(_ r: UInt8, _ g: UInt8, _ b: UInt8) -> Bool {
    let hi = max(r, g, b)
    let lo = min(r, g, b)
    guard Int(hi) - Int(lo) >= minChroma else { return false }
    return greenHues.contains(hue(r, g, b)) && saturation(r, g, b) > minGreenSaturation
  }

  /// HSV hue in degrees, 0..<360; 0 for a grey.
  static func hue(_ r: UInt8, _ g: UInt8, _ b: UInt8) -> Double {
    let (r, g, b) = (Double(r) / 255, Double(g) / 255, Double(b) / 255)
    let hi = max(r, g, b)
    let c = hi - min(r, g, b)
    guard c > 0 else { return 0 }
    var h: Double
    if hi == r {
      h = ((g - b) / c).truncatingRemainder(dividingBy: 6)
    } else if hi == g {
      h = (b - r) / c + 2
    } else {
      h = (r - g) / c + 4
    }
    h *= 60
    return h < 0 ? h + 360 : h
  }

  /// HSV saturation, 0 to 1.
  static func saturation(_ r: UInt8, _ g: UInt8, _ b: UInt8) -> Double {
    let hi = Double(max(r, g, b))
    return hi == 0 ? 0 : (hi - Double(min(r, g, b))) / hi
  }

  /// A PNG decoded to sRGB RGBA bytes, row 0 at the top.
  struct Pixels {
    let width: Int
    let height: Int
    let bytes: [UInt8]

    init?(_ png: Data) {
      guard
        let image = NSBitmapImageRep(data: png)?.cgImage,
        let space = CGColorSpace(name: CGColorSpace.sRGB)
      else { return nil }
      width = image.width
      height = image.height
      guard width > 0, height > 0 else { return nil }
      var buffer = [UInt8](repeating: 0, count: width * height * 4)
      var drawn = false
      buffer.withUnsafeMutableBytes { raw in
        guard
          let ctx = CGContext(
            data: raw.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8,
            bytesPerRow: image.width * 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return }
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        drawn = true
      }
      guard drawn else { return nil }
      bytes = buffer
    }

    subscript(x: Int, y: Int) -> (UInt8, UInt8, UInt8, UInt8) {
      let i = (y * width + x) * 4
      return (bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3])
    }
  }
}
