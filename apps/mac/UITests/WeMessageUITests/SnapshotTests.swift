import AppKit
import Foundation
import XCTest

/// Light and dark snapshots of the shell (plan §5.4). Each PNG leaves the
/// runner only as a .keepAlways attachment that the job exports from the
/// result bundle; nothing is written to disk and nothing is diffed against a
/// stored golden. Each is swept for green, outside the traffic-light band,
/// and must show the tint. CI only.
final class SnapshotTests: XCTestCase {
  @MainActor
  func testShellLight() {
    shoot(appearance: "light", name: "shell-light") { mean in
      XCTAssertGreaterThan(mean, 0.65, "a light shell renders dark: mean luminance \(mean)")
    }
  }

  @MainActor
  func testShellDark() {
    shoot(appearance: "dark", name: "shell-dark") { mean in
      XCTAssertLessThan(mean, 0.35, "a dark shell renders light: mean luminance \(mean)")
    }
  }

  /// Non-vacuity of the sweep and of the tint count, on synthetic PNGs.
  func testNoGreenSweepSeesGreen() {
    let green: UInt32 = 0x34C759
    let tint = UInt32(NoGreen.tintRGB.0) << 16 | UInt32(NoGreen.tintRGB.1) << 8 | UInt32(NoGreen.tintRGB.2)
    let one = NoGreen.probe(width: 10, height: 10, pixels: [(8, 8, green)])
    XCTAssertEqual(NoGreen.offenders(one, excluding: .zero), 1)
    let band = CGRect(x: 0, y: 0, width: 3, height: 3)
    let masked = NoGreen.probe(width: 10, height: 10, pixels: [(1, 1, green)])
    XCTAssertEqual(NoGreen.offenders(masked, excluding: band), 0, "the band does not mask")
    XCTAssertEqual(NoGreen.offenders(masked, excluding: .zero), 1, "the sweep misses the top-leading corner")
    let both = NoGreen.probe(width: 10, height: 10, pixels: [(1, 1, green), (8, 8, green)])
    XCTAssertEqual(NoGreen.offenders(both, excluding: band), 1, "the band masks too much")
    let blue = NoGreen.probe(width: 10, height: 10, pixels: [(4, 4, tint)])
    XCTAssertEqual(NoGreen.tinted(blue, hue: NoGreen.tintHue, tolerance: 15, minSaturation: 0.5), 1)
    XCTAssertEqual(NoGreen.offenders(blue, excluding: .zero), 0, "the tint counts as green")
    let grey = NoGreen.probe(width: 10, height: 10, pixels: [])
    XCTAssertEqual(NoGreen.tinted(grey, hue: NoGreen.tintHue, tolerance: 15, minSaturation: 0.5), 0)
    XCTAssertTrue(NoGreen.isBlank(grey))
    XCTAssertFalse(NoGreen.isBlank(both))
  }

  @MainActor
  private func shoot(appearance: String, name: String, luminance: (Double) -> Void) {
    let app = UITestApp.make(appearance: appearance)
    app.launch()
    defer { app.terminate() }
    XCTAssertTrue(UITestApp.shellElement(app).waitForExistence(timeout: UITestApp.timeout), "the shell never appeared")
    let window = app.windows.firstMatch
    // Wait for the app's pinned geometry, then let one frame settle
    // (animations are off under the test flag, H-S1).
    var geometry = UITestApp.shellGeometry(app)
    let deadline = Date().addingTimeInterval(UITestApp.timeout)
    while Date() < deadline {
      geometry = UITestApp.shellGeometry(app)
      if let g = geometry, abs(window.frame.width - g.frame.width) <= 1, abs(window.frame.height - g.frame.height) <= 1 {
        break
      }
      Thread.sleep(forTimeInterval: 0.25)
    }
    Thread.sleep(forTimeInterval: 0.5)

    let png = window.screenshot().pngRepresentation
    let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)

    guard let size = NoGreen.size(png), let g = geometry else {
      XCTFail("\(name): no decodable PNG or no published geometry (\(String(describing: geometry)))")
      return
    }
    let band = NoGreen.trafficLightBand(pngSize: size, windowWidthPoints: window.frame.width)
    let area = size.width * size.height
    XCTAssertLessThan(band.width * band.height, 0.02 * area, "\(name): the mask is too large: \(band) of \(size)")
    guard let sweep = NoGreen.sweep(png, excluding: band) else {
      XCTFail("\(name): the sweep could not decode the PNG")
      return
    }
    XCTAssertEqual(NoGreen.offenders(png, excluding: band), 0, "\(name): green pixels outside the traffic lights")
    XCTAssertGreaterThan(Double(sweep.swept), 0.9 * Double(sweep.total), "\(name): the sweep saw too little")
    XCTAssertGreaterThan(
      NoGreen.tinted(png, hue: NoGreen.tintHue, tolerance: 15, minSaturation: 0.5), 0, "\(name): no tint on screen")
    XCTAssertFalse(NoGreen.isBlank(png), "\(name): a blank snapshot")
    // The snapshot covers the window the app pinned, at the screen's scale.
    let scale = NSScreen.main?.backingScaleFactor ?? 1
    XCTAssertGreaterThanOrEqual(size.width + 1, g.frame.width * scale, "\(name): \(size) vs \(g.frame) at \(scale)x")
    XCTAssertGreaterThanOrEqual(size.height + 1, g.frame.height * scale, "\(name): \(size) vs \(g.frame) at \(scale)x")
    luminance(NoGreen.meanLuminance(png))
  }
}
