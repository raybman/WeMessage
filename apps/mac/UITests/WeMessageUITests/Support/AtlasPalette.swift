import Foundation

/// The token triples board 08's pixel probes compare against: Tokens.Light
/// and Tokens.Dark's ink, layer1 and layer2, written here too because the
/// UI test bundle cannot import the app. AppHygieneTests H-S4-4c holds
/// every triple equal to Tokens.swift.
enum AtlasPalette {
  typealias RGB = (UInt8, UInt8, UInt8)

  static let inkLight: RGB = (0x1C, 0x1C, 0x1E)
  static let inkDark: RGB = (0xF5, 0xF5, 0xF7)
  static let layer1Light: RGB = (0xFF, 0xFF, 0xFF)
  static let layer1Dark: RGB = (0x2C, 0x2C, 0x2E)
  static let layer2Light: RGB = (0xF0, 0xF0, 0xF5)
  static let layer2Dark: RGB = (0x3A, 0x3A, 0x3C)

  static func ink(dark: Bool) -> RGB { dark ? inkDark : inkLight }
  static func layer1(dark: Bool) -> RGB { dark ? layer1Dark : layer1Light }
  static func layer2(dark: Bool) -> RGB { dark ? layer2Dark : layer2Light }

  /// Every channel within `tolerance` of the token.
  static func near(_ a: RGB, _ b: RGB, tolerance: Int = 6) -> Bool {
    abs(Int(a.0) - Int(b.0)) <= tolerance && abs(Int(a.1) - Int(b.1)) <= tolerance
      && abs(Int(a.2) - Int(b.2)) <= tolerance
  }

  /// The commonest colour inside `rect` (pixels), each channel quantised to
  /// 4 so antialiasing does not split a flat fill.
  static func mode(_ px: NoGreen.Pixels, _ rect: CGRect) -> RGB? {
    let r = rect.intersection(CGRect(x: 0, y: 0, width: px.width, height: px.height))
    guard !r.isNull, r.width >= 1, r.height >= 1 else { return nil }
    var counts: [UInt32: Int] = [:]
    var sums: [UInt32: (Int, Int, Int)] = [:]
    for y in Int(r.minY)..<Int(r.maxY) {
      for x in Int(r.minX)..<Int(r.maxX) {
        let p = px[x, y]
        let key = UInt32(p.0 >> 2) << 16 | UInt32(p.1 >> 2) << 8 | UInt32(p.2 >> 2)
        counts[key, default: 0] += 1
        let s = sums[key] ?? (0, 0, 0)
        sums[key] = (s.0 + Int(p.0), s.1 + Int(p.1), s.2 + Int(p.2))
      }
    }
    guard let top = counts.max(by: { $0.value < $1.value }), let s = sums[top.key] else { return nil }
    let n = top.value
    return (UInt8(s.0 / n), UInt8(s.1 / n), UInt8(s.2 / n))
  }

  /// How many times a row of pixels from `x0` to `x1` at `y` enters a run
  /// that `inside` holds for.
  static func runs(_ px: NoGreen.Pixels, y: Int, from x0: Int, to x1: Int, _ inside: (RGB) -> Bool) -> Int {
    guard y >= 0, y < px.height else { return 0 }
    var count = 0
    var was = false
    for x in max(0, x0)..<min(px.width, x1) {
      let p = px[x, y]
      let now = inside((p.0, p.1, p.2))
      if now && !was { count += 1 }
      was = now
    }
    return count
  }

  /// The tint, by hue and saturation, as NoGreen counts it.
  static func isTint(_ p: RGB) -> Bool {
    NoGreen.saturation(p.0, p.1, p.2) >= 0.5 && abs(NoGreen.hue(p.0, p.1, p.2) - NoGreen.tintHue) <= 15
  }
}
