import AppKit
import Foundation
import XCTest

/// Light and dark snapshots of the shell (plan §5.4), each with the frost on
/// and with Reduce Transparency forced (S4 plan 2.5). Each PNG leaves the
/// runner only as a .keepAlways attachment that the job exports from the
/// result bundle; nothing is written to disk and nothing is diffed against a
/// stored golden. Each is swept for green, outside the traffic-light band,
/// must show the tint, and must carry the frost evidence for its leg: a real
/// blur over the CI backdrop, or plain layer0. CI only.
final class SnapshotTests: XCTestCase {
  /// v2 S4b: every UI test starts from the S0 goldens and an empty journal.
  override func setUp() async throws {
    try await FakeDaemon.reset()
  }

  @MainActor
  func testShellLightFrost() {
    shoot(appearance: "light", frost: true, name: "board-01-shell-light.png") { mean in
      XCTAssertGreaterThan(mean, 0.65, "a light shell renders dark: mean luminance \(mean)")
    }
  }

  @MainActor
  func testShellDarkFrost() {
    shoot(appearance: "dark", frost: true, name: "board-01-shell-dark.png") { mean in
      XCTAssertLessThan(mean, 0.35, "a dark shell renders light: mean luminance \(mean)")
    }
  }

  @MainActor
  func testShellLightOpaque() {
    shoot(appearance: "light", frost: false, name: "board-01-shell-opaque-light.png") { mean in
      XCTAssertGreaterThan(mean, 0.65, "a light shell renders dark: mean luminance \(mean)")
    }
  }

  @MainActor
  func testShellDarkOpaque() {
    shoot(appearance: "dark", frost: false, name: "board-01-shell-opaque-dark.png") { mean in
      XCTAssertLessThan(mean, 0.35, "a dark shell renders light: mean luminance \(mean)")
    }
  }

  /// Non-vacuity of the frost evidence, on synthetic window-sized PNGs: a
  /// flat layer0 fill and the stripes seen through clear glass both fail the
  /// frost check, a modelled blur passes it, and only the flat fill passes
  /// the opaque check.
  func testFrostEvidenceSeesFlatFill() {
    let window = CGSize(width: 1024, height: 678)
    let w = Int(window.width)
    let h = Int(window.height)
    let band = FrostProbe.stripeBand
    func inBand(_ x: Int, _ y: Int) -> Bool {
      Double(x) >= band.x && Double(x) < band.x + band.width && Double(y) >= band.y && Double(y) < band.y + band.height
    }
    // A gradient falling from 230 at the top to 200 at the bottom, steep
    // enough that a 40 point patch spans more than one grey level.
    func gradient(_ y: Int) -> UInt8 { UInt8((230 - 30 * Double(y) / Double(h - 1)).rounded()) }

    let flat = FrostEvidence.synthetic(width: w, height: h) { _, _ in FrostEvidence.layer0Light }
    guard let flatReading = FrostEvidence.read(flat, window: window) else { return XCTFail("flat fill did not read") }
    XCTAssertFalse(FrostEvidence.frostFailures(flatReading).isEmpty, "a flat fill passes as frost")
    XCTAssertEqual(FrostEvidence.opaqueFailures(flatReading, layer0: FrostEvidence.layer0Light), [])
    let darkFlat = FrostEvidence.synthetic(width: w, height: h) { _, _ in FrostEvidence.layer0Dark }
    guard let darkReading = FrostEvidence.read(darkFlat, window: window) else { return XCTFail("dark fill did not read") }
    XCTAssertFalse(
      FrostEvidence.opaqueFailures(darkReading, layer0: FrostEvidence.layer0Light).isEmpty, "the wrong layer0 passes")

    let clear = FrostEvidence.synthetic(width: w, height: h) { x, y in
      guard inBand(x, y) else { let v = gradient(y); return (v, v, v) }
      return (x / Int(FrostProbe.stripeWidth)) % 2 == 0 ? (0, 0, 0) : (255, 255, 255)
    }
    guard let clearReading = FrostEvidence.read(clear, window: window) else { return XCTFail("clear glass did not read") }
    XCTAssertTrue(
      FrostEvidence.frostFailures(clearReading).contains { $0.hasPrefix("stripe std") }, "unblurred stripes pass")

    let blurred = FrostEvidence.synthetic(width: w, height: h) { x, y in
      let v = inBand(x, y) ? 194 : gradient(y)
      return (v, v, v)
    }
    guard let frostReading = FrostEvidence.read(blurred, window: window) else { return XCTFail("the blur did not read") }
    XCTAssertEqual(FrostEvidence.frostFailures(frostReading), [], frostReading.line)
    XCTAssertFalse(
      FrostEvidence.opaqueFailures(frostReading, layer0: FrostEvidence.layer0Light).isEmpty, "frost passes as layer0")

    // v2 S4d: the thread layout's patches read the same synthetic images
    // the same way, and sit where they say (head, rail, above the stripe).
    guard let threadFlat = FrostEvidence.read(flat, window: window, layout: .thread),
      let threadClear = FrostEvidence.read(clear, window: window, layout: .thread),
      let threadFrost = FrostEvidence.read(blurred, window: window, layout: .thread)
    else { return XCTFail("the thread layout's patches did not read") }
    XCTAssertFalse(FrostEvidence.frostFailures(threadFlat).isEmpty, "a flat fill passes as frost (thread)")
    XCTAssertTrue(
      FrostEvidence.frostFailures(threadClear).contains { $0.hasPrefix("stripe std") }, "unblurred stripes pass (thread)")
    XCTAssertEqual(FrostEvidence.frostFailures(threadFrost), [], threadFrost.line)
    let top = FrostProbe.gradientTop(windowWidth: window.width, layout: .thread)
    let bottom = FrostProbe.gradientBottom(windowWidth: window.width, windowHeight: window.height, layout: .thread)
    XCTAssertGreaterThanOrEqual(top.y, 52.5, "the thread's top patch is under the title band")
    XCTAssertLessThanOrEqual(top.y + top.height, 105, "the thread's top patch crosses the head's hairline")
    XCTAssertLessThanOrEqual(bottom.x + bottom.width, 58, "the thread's bottom patch leaves the rail")
    XCTAssertLessThan(top.midY, FrostProbe.stripePatch.midY)
    XCTAssertLessThan(FrostProbe.stripePatch.midY, bottom.midY)

    // v2 S4e: the atlas layout's patches read the same way. The stripe and
    // bottom patches sit in the specimen sheet's bare gutter; the top one
    // sits in the title band, right of the capped title and clear of the
    // stripe band's blur.
    guard let atlasFlat = FrostEvidence.read(flat, window: window, layout: .atlas),
      let atlasClear = FrostEvidence.read(clear, window: window, layout: .atlas),
      let atlasFrost = FrostEvidence.read(blurred, window: window, layout: .atlas)
    else { return XCTFail("the atlas layout's patches did not read") }
    XCTAssertFalse(FrostEvidence.frostFailures(atlasFlat).isEmpty, "a flat fill passes as frost (atlas)")
    XCTAssertTrue(
      FrostEvidence.frostFailures(atlasClear).contains { $0.hasPrefix("stripe std") }, "unblurred stripes pass (atlas)")
    XCTAssertEqual(FrostEvidence.frostFailures(atlasFrost), [], atlasFrost.line)
    let gutter = FrostProbe.atlasGutter
    let atlasTop = FrostProbe.gradientTop(windowWidth: window.width, layout: .atlas)
    let atlasBottom = FrostProbe.gradientBottom(windowWidth: window.width, windowHeight: window.height, layout: .atlas)
    XCTAssertLessThanOrEqual(atlasTop.y + atlasTop.height, 52, "the atlas's top patch leaves the title band")
    XCTAssertGreaterThanOrEqual(atlasTop.x, FrostProbe.atlasTitleMaxX, "the atlas's top patch crosses the title")
    XCTAssertGreaterThanOrEqual(
      atlasTop.x, FrostProbe.stripeBand.x + FrostProbe.stripeBand.width + 60, "the atlas's top patch is in the stripe's blur")
    for patch in [FrostProbe.stripePatch, atlasBottom] {
      XCTAssertGreaterThanOrEqual(patch.x, gutter.x, "an atlas patch leaves the gutter: \(patch)")
      XCTAssertLessThanOrEqual(patch.x + patch.width, gutter.x + gutter.width, "an atlas patch leaves the gutter: \(patch)")
    }
    XCTAssertLessThan(atlasTop.midY, FrostProbe.stripePatch.midY)
    XCTAssertLessThan(FrostProbe.stripePatch.midY, atlasBottom.midY)
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
  private func shoot(appearance: String, frost: Bool, name: String, luminance: (Double) -> Void) {
    // Frost legs force Reduce Transparency off and opaque legs force it on,
    // whatever the runner's own setting (the job also writes it off).
    let app = UITestApp.make(appearance: appearance, reduceTransparency: !frost)
    app.launch()
    defer { app.terminate() }
    XCTAssertTrue(UITestApp.shellElement(app).waitForExistence(timeout: UITestApp.timeout), "the shell never appeared")
    let geometry = settledGeometry(app)
    capture(app, geometry: geometry, appearance: appearance, frost: frost, name: name, luminance: luminance)
  }
}

/// The shared half of every board snapshot (v2 S4c): wait for the app's
/// pinned geometry, then capture, attach, sweep and measure one PNG.
extension XCTestCase {
  /// Waits for the app's pinned geometry and lets one frame settle
  /// (animations are off under the test flag, H-S1).
  @MainActor
  func settledGeometry(_ app: XCUIApplication) -> (frame: CGSize, visible: CGSize)? {
    let window = app.windows.firstMatch
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
    return geometry
  }

  /// One snapshot: attached as `name`, swept for green outside the traffic
  /// lights, required to show the tint, measured for luminance, and held to
  /// the frost evidence for its leg.
  @MainActor
  func capture(
    _ app: XCUIApplication, geometry: (frame: CGSize, visible: CGSize)?, appearance: String, frost: Bool, name: String,
    layout: FrostProbe.Layout = .shell, luminance: (Double) -> Void
  ) {
    let window = app.windows.firstMatch
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
    evidence(png, window: window.frame.size, appearance: appearance, frost: frost, name: name, layout: layout)
  }

  /// The frost evidence for one shot: printed as one FROST| line for the job
  /// log, attached as text, and asserted.
  func evidence(
    _ png: Data, window: CGSize, appearance: String, frost: Bool, name: String, layout: FrostProbe.Layout = .shell
  ) {
    guard let reading = FrostEvidence.read(png, window: window, layout: layout) else {
      XCTFail("\(name): the frost probe patches fall outside the snapshot (\(window))")
      return
    }
    let leg = frost ? "frost" : "opaque"
    let line = "FROST| \(name) \(appearance) \(leg) | \(reading.line)"
    print(line)
    let text = XCTAttachment(string: line)
    text.name = "\(name).frost.txt"
    text.lifetime = .keepAlways
    add(text)
    let failures =
      frost
      ? FrostEvidence.frostFailures(reading)
      : FrostEvidence.opaqueFailures(reading, layer0: FrostEvidence.layer0(dark: appearance == "dark"))
    XCTAssertEqual(failures, [], "\(name): \(line)")
  }
}
