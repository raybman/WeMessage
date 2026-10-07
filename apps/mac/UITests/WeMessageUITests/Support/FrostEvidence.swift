import AppKit
import Foundation
import XCTest

/// Proof that the window frost is a real blur and the opaque rendering is
/// really layer0 (plan 2.5, advisor item 2, S4a.0 spike thresholds).
///
/// The CI backdrop draws a 2 pt black and white stripe band under
/// FrostProbe.stripeBand and a grey-blue gradient everywhere else. In a
/// window snapshot, with frost on:
/// - the stripe patch is smooth (a blur, not the stripes seen through);
/// - its mean is pulled away from the frosted gradient beside it (the frost
///   transmits what is behind it, so it is not a flat fill);
/// - the gradient survives the frost, lighter at the top than at the bottom;
/// - at least one gradient patch varies at all (a flat fill does not).
/// With Reduce Transparency forced, every patch equals layer0.
///
/// Statistics are in 0...255 sRGB units: the mean is the average of the
/// three channel means, the std the largest channel standard deviation.
enum FrostEvidence {
  /// Tokens.Light.layer0 and Tokens.Dark.layer0, written here too because the
  /// UI test bundle cannot import the app; AppHygieneTests H-S4-3b holds the
  /// triples equal.
  static let layer0Light: (UInt8, UInt8, UInt8) = (0xF5, 0xF5, 0xF7)
  static let layer0Dark: (UInt8, UInt8, UInt8) = (0x1C, 0x1C, 0x1E)

  static func layer0(dark: Bool) -> (UInt8, UInt8, UInt8) { dark ? layer0Dark : layer0Light }

  /// The S4a.0 spike's thresholds (run 37568873983 measured stripe std under
  /// 0.6, pull about 26, transmission 5.3 to 6.7, gradient std about 0.5).
  static let maxStripeStd = 3.0
  static let minPull = 12.0
  static let minTransmission = 3.0
  static let opaqueTolerance = 2.0
  static let minGradientStd = 0.1

  struct Stats: Equatable {
    var r, g, b: Double
    var std: Double
    var n: Int
    var mean: Double { (r + g + b) / 3 }
  }

  /// The three patches of one snapshot and what follows from them.
  struct Reading {
    var stripe, gradientTop, gradientBottom: Stats
    /// Patch centres, window points from the top.
    var stripeY, topY, bottomY: Double

    /// The frosted gradient at the stripe patch's height, interpolated
    /// between the two gradient patches.
    var gradientAtStripe: Double {
      let span = bottomY - topY
      guard span != 0 else { return gradientTop.mean }
      let t = (stripeY - topY) / span
      return gradientTop.mean + t * (gradientBottom.mean - gradientTop.mean)
    }

    var pull: Double { abs(stripe.mean - gradientAtStripe) }
    var transmission: Double { gradientTop.mean - gradientBottom.mean }

    var line: String {
      func f(_ v: Double) -> String { String(format: "%.2f", v) }
      return "stripe mean=\(f(stripe.mean)) std=\(f(stripe.std))"
        + " | gradTop mean=\(f(gradientTop.mean)) std=\(f(gradientTop.std))"
        + " | gradBottom mean=\(f(gradientBottom.mean)) std=\(f(gradientBottom.std))"
        + " | pull=\(f(pull)) transmission=\(f(transmission))"
    }
  }

  /// Samples the FrostProbe patches of a window snapshot whose window is
  /// `window` points in size. Nil when the PNG does not decode or a patch
  /// falls outside it.
  static func read(_ png: Data, window: CGSize) -> Reading? {
    guard let px = NoGreen.Pixels(png), window.width > 0 else { return nil }
    let k = Double(px.width) / window.width
    let stripe = FrostProbe.stripePatch
    let top = FrostProbe.gradientTop(windowWidth: window.width)
    let bottom = FrostProbe.gradientBottom(windowWidth: window.width, windowHeight: window.height)
    guard let s = stats(px, stripe, scale: k), let t = stats(px, top, scale: k), let b = stats(px, bottom, scale: k)
    else { return nil }
    return Reading(
      stripe: s, gradientTop: t, gradientBottom: b, stripeY: stripe.midY, topY: top.midY, bottomY: bottom.midY)
  }

  /// Every way `reading` fails to show a real blur; empty when it does.
  static func frostFailures(_ reading: Reading) -> [String] {
    var out: [String] = []
    if !(reading.stripe.std < maxStripeStd) {
      out.append("stripe std \(reading.stripe.std) is not under \(maxStripeStd): the stripes are not blurred")
    }
    if !(reading.pull >= minPull) {
      out.append("pull \(reading.pull) is under \(minPull): the frost does not transmit the stripe band")
    }
    if !(reading.transmission >= minTransmission) {
      out.append("transmission \(reading.transmission) is under \(minTransmission): the backdrop gradient does not show")
    }
    if !(max(reading.gradientTop.std, reading.gradientBottom.std) > minGradientStd) {
      out.append("no gradient patch varies by more than \(minGradientStd): a flat fill")
    }
    return out
  }

  /// Every patch whose mean is not `layer0` within the tolerance, or that
  /// is not flat; empty when the window is plain layer0.
  static func opaqueFailures(_ reading: Reading, layer0: (UInt8, UInt8, UInt8)) -> [String] {
    var out: [String] = []
    for (name, s) in [("stripe", reading.stripe), ("gradTop", reading.gradientTop), ("gradBottom", reading.gradientBottom)] {
      let d = max(abs(s.r - Double(layer0.0)), abs(s.g - Double(layer0.1)), abs(s.b - Double(layer0.2)))
      if !(d <= opaqueTolerance) { out.append("\(name) is \(d) from layer0") }
      if !(s.std <= opaqueTolerance) { out.append("\(name) std \(s.std) is not flat") }
    }
    return out
  }

  /// The statistics of `rect` (points) at `scale` pixels per point.
  static func stats(_ px: NoGreen.Pixels, _ rect: FrostProbe.Rect, scale k: Double) -> Stats? {
    let x0 = Int((rect.x * k).rounded())
    let y0 = Int((rect.y * k).rounded())
    let x1 = Int(((rect.x + rect.width) * k).rounded())
    let y1 = Int(((rect.y + rect.height) * k).rounded())
    guard x0 >= 0, y0 >= 0, x1 <= px.width, y1 <= px.height, x1 > x0, y1 > y0 else { return nil }
    var sum = [0.0, 0.0, 0.0]
    var sq = [0.0, 0.0, 0.0]
    var n = 0
    for y in y0..<y1 {
      for x in x0..<x1 {
        let (r, g, b, _) = px[x, y]
        let v = [Double(r), Double(g), Double(b)]
        for i in 0..<3 {
          sum[i] += v[i]
          sq[i] += v[i] * v[i]
        }
        n += 1
      }
    }
    let m = sum.map { $0 / Double(n) }
    let sd = (0..<3).map { max(0, sq[$0] / Double(n) - m[$0] * m[$0]).squareRoot() }
    return Stats(r: m[0], g: m[1], b: m[2], std: max(sd[0], sd[1], sd[2]), n: n)
  }

  /// A synthetic opaque sRGB PNG, `width` by `height` pixels, each pixel
  /// from `paint(x, y)` (top-leading). Tagged sRGB, the space Pixels decodes
  /// to, so the bytes come back unchanged. The teeth's test images.
  static func synthetic(width: Int, height: Int, paint: (Int, Int) -> (UInt8, UInt8, UInt8)) -> Data {
    var bytes = [UInt8](repeating: 0xFF, count: width * height * 4)
    for y in 0..<height {
      for x in 0..<width {
        let (r, g, b) = paint(x, y)
        let i = (y * width + x) * 4
        bytes[i] = r
        bytes[i + 1] = g
        bytes[i + 2] = b
      }
    }
    guard
      let space = CGColorSpace(name: CGColorSpace.sRGB),
      let provider = CGDataProvider(data: Data(bytes) as CFData),
      let image = CGImage(
        width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4, space: space,
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue), provider: provider,
        decode: nil, shouldInterpolate: false, intent: .defaultIntent)
    else { return Data() }
    return NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) ?? Data()
  }
}
