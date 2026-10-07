import AppKit
import Foundation
import XCTest

/// S4a.0 MEASUREMENT SPIKE (branch build/s4-spike, never merged). Measures
/// nothing it asserts: every number goes to a `SPIKE|` line on stdout and to
/// a .keepAlways text attachment, every capture to a .keepAlways PNG.
final class SpikeTests: XCTestCase {
  /// Window-local patches, points, top-leading. Mirrors SpikeLayout in the
  /// app (stripe band 260,160 200x200; swatch 60,420 120x120); the info
  /// label carries the app's own numbers so a drift shows in the log.
  struct Patch {
    let name: String
    let rect: CGRect
  }

  static let patchSide: CGFloat = 40

  static func patches(windowHeight h: CGFloat) -> [Patch] {
    let s = patchSide
    return [
      // The centre of the stripe band (260 + 80, 160 + 80).
      Patch(name: "stripe", rect: CGRect(x: 340, y: 240, width: s, height: s)),
      Patch(name: "gradTop", rect: CGRect(x: 640, y: 80, width: s, height: s)),
      Patch(name: "gradBottom", rect: CGRect(x: 640, y: h - 120, width: s, height: s)),
      // The centre of the opaque layer0 swatch (60 + 40, 420 + 40).
      Patch(name: "layer0", rect: CGRect(x: 100, y: 460, width: s, height: s)),
    ]
  }

  private var lines: [String] = []

  private func emit(_ line: String) {
    let full = "SPIKE|" + line
    print(full)
    lines.append(full)
  }

  private func attachLines(_ name: String) {
    let a = XCTAttachment(string: lines.joined(separator: "\n") + "\n")
    a.name = name + ".txt"
    a.lifetime = .keepAlways
    add(a)
  }

  private func attachPNG(_ data: Data, name: String) {
    let a = XCTAttachment(data: data, uniformTypeIdentifier: "public.png")
    a.name = name
    a.lifetime = .keepAlways
    add(a)
  }

  // MARK: frost variants

  @MainActor func testFrostLightOpaque() { frost("opaque", "light") }
  @MainActor func testFrostLightClear() { frost("clear", "light") }
  @MainActor func testFrostLightUnderWindow() { frost("underWindow", "light") }
  @MainActor func testFrostLightHud() { frost("hud", "light") }
  @MainActor func testFrostLightGlass() { frost("glass", "light") }
  @MainActor func testFrostLightContainer() { frost("container", "light") }
  @MainActor func testFrostDarkOpaque() { frost("opaque", "dark") }
  @MainActor func testFrostDarkClear() { frost("clear", "dark") }
  @MainActor func testFrostDarkUnderWindow() { frost("underWindow", "dark") }
  @MainActor func testFrostDarkHud() { frost("hud", "dark") }
  @MainActor func testFrostDarkGlass() { frost("glass", "dark") }
  @MainActor func testFrostDarkContainer() { frost("container", "dark") }

  @MainActor
  private func frost(_ variant: String, _ appearance: String) {
    let tag = "\(appearance)|\(variant)"
    defer { attachLines("spike-\(appearance)-\(variant)") }
    let app = UITestApp.make(appearance: appearance)
    app.launchEnvironment["WEMESSAGE_SPIKE_FROST"] = variant
    let started = Date()
    app.launch()
    defer { app.terminate() }
    let info = app.descendants(matching: .any)["wemessage.spike.info"]
    guard info.waitForExistence(timeout: UITestApp.timeout) else {
      emit("error|\(tag)|spike view never appeared")
      return
    }
    let window = app.windows.containing(.any, identifier: "wemessage.spike").firstMatch
    // Wait for the app's pinned geometry on the window's value.
    var published = ""
    let deadline = Date().addingTimeInterval(UITestApp.timeout)
    while Date() < deadline {
      published = (window.value as? String) ?? ""
      if let size = Self.frameSize(published), abs(window.frame.width - size.width) <= 1,
        abs(window.frame.height - size.height) <= 1
      {
        break
      }
      Thread.sleep(forTimeInterval: 0.25)
    }
    // Let the material settle: the blur is composited asynchronously.
    Thread.sleep(forTimeInterval: 1.5)
    let screenPoints = NSScreen.main?.frame.size ?? .zero
    let scale = NSScreen.main?.backingScaleFactor ?? 0
    emit(
      "meta|\(tag)|launch=\(String(format: "%.1f", Date().timeIntervalSince(started)))s|windows=\(app.windows.count)"
        + "|frame=\(Self.fmt(window.frame))|published=\(published)|screen=\(Int(screenPoints.width))x\(Int(screenPoints.height))@\(scale)"
        + "|info=\(info.label)|infoValue=\((info.value as? String) ?? "")")

    let windowPNG = window.screenshot().pngRepresentation
    let screenPNG = XCUIScreen.main.screenshot().pngRepresentation
    attachPNG(windowPNG, name: "spike-\(appearance)-\(variant)-window.png")
    attachPNG(screenPNG, name: "spike-\(appearance)-\(variant)-screen-full.png")

    // The screen capture cropped to the window frame (top-leading points).
    var cropPNG = Data()
    if let image = NSBitmapImageRep(data: screenPNG)?.cgImage, screenPoints.width > 0 {
      let k = CGFloat(image.width) / screenPoints.width
      let f = window.frame
      let r = CGRect(x: f.minX * k, y: f.minY * k, width: f.width * k, height: f.height * k).integral
      if let cropped = image.cropping(to: r) {
        cropPNG = NSBitmapImageRep(cgImage: cropped).representation(using: .png, properties: [:]) ?? Data()
      }
      emit("meta|\(tag)|screenPNG=\(image.width)x\(image.height)|k=\(k)|crop=\(Self.fmt(r))")
    }
    attachPNG(cropPNG, name: "spike-\(appearance)-\(variant)-screen.png")

    let patches = Self.patches(windowHeight: window.frame.height)
    for (path, png) in [("window", windowPNG), ("screen", cropPNG)] {
      guard let px = NoGreen.Pixels(png) else {
        emit("error|\(tag)|\(path)|undecodable png (\(png.count) bytes)")
        continue
      }
      let k = window.frame.width > 0 ? CGFloat(px.width) / window.frame.width : 1
      emit("meta|\(tag)|\(path)|png=\(px.width)x\(px.height)|k=\(String(format: "%.4f", k))")
      for patch in patches {
        let r = CGRect(
          x: patch.rect.minX * k, y: patch.rect.minY * k, width: patch.rect.width * k, height: patch.rect.height * k
        ).integral
        guard let s = Self.stats(px, r) else {
          emit("error|\(tag)|\(path)|\(patch.name)|out of bounds \(Self.fmt(r))")
          continue
        }
        emit(
          "patch|\(appearance)|\(variant)|\(path)|\(patch.name)|mean=\(Self.f(s.mean))|std=\(Self.f(s.std))"
            + "|rgb=\(Self.f(s.r)),\(Self.f(s.g)),\(Self.f(s.b))|stdLum=\(Self.f(s.stdLum))|n=\(s.n)")
      }
    }
  }

  // MARK: loopback and reduce transparency

  @MainActor
  func testLoopbackFromRunner() async {
    defer { attachLines("spike-loopback") }
    let env = ProcessInfo.processInfo.environment
    let port = env["WEMESSAGE_PORT"] ?? "47191"
    emit("meta|loopback|portSource=\(env["WEMESSAGE_PORT"] == nil ? "default" : "env")")
    for host in ["127.0.0.1", "localhost"] {
      guard let url = URL(string: "http://\(host):\(port)/v1/health") else { continue }
      var request = URLRequest(url: url)
      request.timeoutInterval = 10
      do {
        let (data, response) = try await URLSession.shared.data(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? -1
        let body = String(decoding: data.prefix(160), as: UTF8.self).replacingOccurrences(of: "\n", with: " ")
        emit("loopback|\(host)|status=\(code)|body=\(body)")
      } catch {
        let ns = error as NSError
        emit("loopback|\(host)|error|domain=\(ns.domain)|code=\(ns.code)|desc=\(ns.localizedDescription)")
      }
    }
  }

  @MainActor
  func testReduceTransparencyInRunner() {
    defer { attachLines("spike-reduce-transparency") }
    let value = NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency
    emit("reduceTransparency|runner|\(value ? 1 : 0)")
  }

  // MARK: maths

  struct Stats {
    let mean, std, r, g, b, stdLum: Double
    let n: Int
  }

  /// Mean of the three channel means; std is the largest channel std; all
  /// in 0...255 sRGB units. stdLum is the std of Rec. 709 luma.
  static func stats(_ px: NoGreen.Pixels, _ rect: CGRect) -> Stats? {
    let x0 = Int(rect.minX)
    let y0 = Int(rect.minY)
    let x1 = Int(rect.maxX)
    let y1 = Int(rect.maxY)
    guard x0 >= 0, y0 >= 0, x1 <= px.width, y1 <= px.height, x1 > x0, y1 > y0 else { return nil }
    var sum = [0.0, 0.0, 0.0, 0.0]
    var sq = [0.0, 0.0, 0.0, 0.0]
    var n = 0
    for y in y0..<y1 {
      for x in x0..<x1 {
        let (r, g, b, _) = px[x, y]
        let v = [Double(r), Double(g), Double(b), 0.2126 * Double(r) + 0.7152 * Double(g) + 0.0722 * Double(b)]
        for i in 0..<4 {
          sum[i] += v[i]
          sq[i] += v[i] * v[i]
        }
        n += 1
      }
    }
    let m = sum.map { $0 / Double(n) }
    let sd = (0..<4).map { (max(0, sq[$0] / Double(n) - m[$0] * m[$0])).squareRoot() }
    return Stats(
      mean: (m[0] + m[1] + m[2]) / 3, std: max(sd[0], sd[1], sd[2]), r: m[0], g: m[1], b: m[2], stdLum: sd[3], n: n)
  }

  static func frameSize(_ published: String) -> CGSize? {
    for field in published.split(separator: " ") where field.hasPrefix("frame=") {
      let dims = field.dropFirst("frame=".count).split(separator: "x")
      if dims.count == 2, let w = Double(dims[0]), let h = Double(dims[1]) { return CGSize(width: w, height: h) }
    }
    return nil
  }

  static func f(_ v: Double) -> String { String(format: "%.2f", v) }

  static func fmt(_ r: CGRect) -> String {
    "\(Int(r.minX)),\(Int(r.minY)),\(Int(r.width))x\(Int(r.height))"
  }
}
