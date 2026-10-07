import AppKit
import Foundation
import XCTest

/// v2 S4e: board 08, the message atlas. The specimen sheet opens only with
/// WEMESSAGE_UI_BOARD=08 under the UI-test flag (H-S4-4). One launch per
/// appearance: each page is a click on its page dot, never a relaunch. Each
/// is shot with the frost on as board-08-<slug>-<appearance>.png, swept for
/// green and held to the frost evidence at the atlas layout's patches.
///
/// The pixel probes read what the app draws: the outbound bubble's centre
/// is ink (D-UI-27), the inbound bubble's is layer1 (D-UI-41, outlined),
/// the agent draft's top rule alternates tint and paper (dashed), and the
/// SMS specimen is filled with no dashed rule and no green (D-UI-39).
///
/// The teeth: a dashed rule on an SMS bubble, a filled inbound, a react
/// affordance identifier on an iMessage bubble, and a typing indicator.
/// CI only.
final class Board08Tests: XCTestCase {
  override func setUp() async throws {
    try await FakeDaemon.reset()
  }

  /// The golden's sections, in page order (08.A..08.J).
  static let slugs = [
    "anatomy", "text", "reactions", "media", "voice", "payloads", "delivery", "draft", "native", "coverage",
  ]

  @MainActor
  func testBoard08Light() throws {
    board08(appearance: "light") { mean in
      XCTAssertGreaterThan(mean, 0.6, "a light atlas renders dark: mean luminance \(mean)")
    }
  }

  @MainActor
  func testBoard08Dark() throws {
    board08(appearance: "dark") { mean in
      XCTAssertLessThan(mean, 0.4, "a dark atlas renders light: mean luminance \(mean)")
    }
  }

  @MainActor
  private func board08(appearance: String, luminance: (Double) -> Void) {
    let app = UITestApp.make(appearance: appearance, reduceTransparency: false, board: "08")
    app.launch()
    defer { app.terminate() }
    XCTAssertTrue(
      app.descendants(matching: .any)[ID.atlas].waitForExistence(timeout: UITestApp.timeout), "the atlas never appeared")
    XCTAssertFalse(UITestApp.shellElement(app).exists, "the shell is drawn beside the atlas")
    let geometry = settledGeometry(app)
    let started = Date()
    let dark = appearance == "dark"

    for (index, slug) in Self.slugs.enumerated() {
      let letter = String(UnicodeScalar(UInt8(65 + index)))
      let dot = app.buttons.matching(NSPredicate(format: "label == %@", "Specimen page 08." + letter)).firstMatch
      XCTAssertTrue(dot.waitForExistence(timeout: UITestApp.timeout), "08.\(letter): no page dot")
      dot.click()
      XCTAssertTrue(
        element(app, ID.atlasPagePrefix + slug).waitForExistence(timeout: UITestApp.timeout),
        "08.\(letter): page \(slug) never drew")
      settle()
      // Nothing on any page is a typing indicator or a react affordance.
      XCTAssertFalse(element(app, ID.typing).exists, "08.\(letter): a typing indicator is drawn")
      XCTAssertEqual(
        app.descendants(matching: .any).matching(
          NSPredicate(format: "identifier BEGINSWITH %@", ID.reactAffordancePrefix)
        ).count, 0, "08.\(letter): a react affordance is drawn")
      probe(app, slug: slug, dark: dark)
      capture(
        app, geometry: geometry, appearance: appearance, frost: true, name: "board-08-\(slug)-\(appearance).png",
        layout: .atlas, luminance: luminance)
    }
    print("BOARD08| \(appearance) pages=\(Self.slugs.count) seconds=\(Int(Date().timeIntervalSince(started)))")
  }

  /// The page's own assertions, identifiers first, then pixels.
  @MainActor
  private func probe(_ app: XCUIApplication, slug: String, dark: Bool) {
    switch slug {
    case "anatomy":
      // 08.A note 3: the status rides the last outbound turn only.
      XCTAssertTrue(label(app, ID.bubblePrefix + "atlas-a4").hasPrefix("Sent, "), "a4: \(label(app, ID.bubblePrefix + "atlas-a4"))")
      XCTAssertTrue(element(app, ID.deliveryPrefix + "atlas-a4").exists, "a4: no delivery state")
      XCTAssertFalse(element(app, ID.deliveryPrefix + "atlas-a3").exists, "a3: a second delivery row")
      let outbound = ProvisionalUI.outboundFill == .ink ? AtlasPalette.ink(dark: dark) : NoGreen.tintRGB
      assertMode(app, ID.bubblePrefix + "atlas-a4", is: outbound, "outbound centre")
      let inbound =
        ProvisionalUI.inboundFill == .layer1Outlined ? AtlasPalette.layer1(dark: dark) : AtlasPalette.layer2(dark: dark)
      assertMode(app, ID.bubblePrefix + "atlas-a1", is: inbound, "inbound centre")
    case "reactions":
      for n in 0..<3 {
        XCTAssertTrue(element(app, ID.reactionPrefix + "atlas-c1.\(n)").exists, "c1: reaction \(n) is missing")
      }
      XCTAssertTrue(element(app, ID.reactionPrefix + "atlas-c2.1").exists, "c2: reaction 1 is missing")
      XCTAssertEqual(
        app.descendants(matching: .any).matching(
          NSPredicate(format: "identifier BEGINSWITH %@", ID.reactionPrefix + "atlas-c3")
        ).count, 0, "c3: a reaction on a bubble nobody reacted to")
    case "payloads":
      XCTAssertTrue(element(app, ID.unsupportedPrefix + "atlas-f8").exists, "f8: no unsupported fallback")
    case "delivery":
      for guid in ["atlas-g5", "atlas-g6", "atlas-g7", "atlas-g8", "atlas-g9"] {
        XCTAssertTrue(element(app, ID.deliveryPrefix + guid).exists, "\(guid): no delivery state")
      }
      XCTAssertTrue(
        label(app, ID.deliveryPrefix + "atlas-g9").contains("Not registered"), "g9: \(label(app, ID.deliveryPrefix + "atlas-g9"))")
    case "draft":
      assertDashedTint(app, ID.draftSpecimenPrefix + "draft-atlas-h1")
    case "native":
      XCTAssertTrue(element(app, ID.effectPrefix + "atlas-i2").exists, "i2: no effect specimen")
      assertSMSPlain(app, ID.smsPrefix + "atlas-i1", dark: dark)
    default:
      break
    }
  }

  // MARK: Pixels

  /// The window's PNG, decoded, and an element's frame in its pixels.
  @MainActor
  private func pixels(_ app: XCUIApplication, _ id: String) -> (NoGreen.Pixels, CGRect)? {
    let window = app.windows.firstMatch
    let e = element(app, id)
    guard e.exists, let px = NoGreen.Pixels(window.screenshot().pngRepresentation) else { return nil }
    let k = CGFloat(px.width) / window.frame.width
    let f = e.frame
    let rect = CGRect(
      x: (f.minX - window.frame.minX) * k, y: (f.minY - window.frame.minY) * k, width: f.width * k, height: f.height * k)
    return (px, rect.integral)
  }

  @MainActor
  private func assertMode(_ app: XCUIApplication, _ id: String, is token: AtlasPalette.RGB, _ what: String) {
    guard let hit = pixels(app, id), let mode = AtlasPalette.mode(hit.0, hit.1.insetBy(dx: 2, dy: 2)) else {
      return XCTFail("\(what): \(id) has no pixels")
    }
    XCTAssertTrue(AtlasPalette.near(mode, token), "\(what): \(id) is \(mode), not \(token)")
  }

  /// A 2 pt dashed tint rule: some row of the bubble's top edge enters the
  /// tint at least four times.
  @MainActor
  private func assertDashedTint(_ app: XCUIApplication, _ id: String) {
    guard let hit = pixels(app, id) else { return XCTFail("draft: \(id) has no pixels") }
    let (px, rect) = hit
    let rows = (0..<4).map { dy in
      AtlasPalette.runs(px, y: Int(rect.minY) + dy, from: Int(rect.minX), to: Int(rect.maxX), AtlasPalette.isTint)
    }
    XCTAssertGreaterThanOrEqual(rows.max() ?? 0, 4, "draft: the top rule is not dashed tint, runs per row \(rows)")
  }

  /// D-UI-39: the SMS specimen is sent, so it is filled; its rule is never
  /// dashed (a dashed rule on paper enters ink again and again along the
  /// top edge); and nothing in it is green.
  @MainActor
  private func assertSMSPlain(_ app: XCUIApplication, _ id: String, dark: Bool) {
    guard let hit = pixels(app, id) else { return XCTFail("sms: \(id) has no pixels") }
    let (px, rect) = hit
    let ink = AtlasPalette.ink(dark: dark)
    if let mode = AtlasPalette.mode(px, rect.insetBy(dx: 2, dy: 2)) {
      XCTAssertTrue(AtlasPalette.near(mode, ink), "sms: \(id) is \(mode), not filled ink")
    }
    let inset = 20 * CGFloat(px.width) / app.windows.firstMatch.frame.width
    let rows = (0..<4).map { dy in
      AtlasPalette.runs(px, y: Int(rect.minY) + dy, from: Int(rect.minX + inset), to: Int(rect.maxX - inset)) {
        AtlasPalette.near($0, ink, tolerance: 24)
      }
    }
    XCTAssertLessThan(rows.max() ?? 0, 2, "sms: the top rule is dashed, ink runs per row \(rows)")
    var green = 0
    for y in max(0, Int(rect.minY))..<min(px.height, Int(rect.maxY)) {
      for x in max(0, Int(rect.minX))..<min(px.width, Int(rect.maxX)) {
        let p = px[x, y]
        if NoGreen.isGreen(p.0, p.1, p.2) { green += 1 }
      }
    }
    XCTAssertEqual(green, 0, "sms: green pixels in \(id)")
  }

  // MARK: Helpers

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: id).firstMatch
  }

  @MainActor
  private func label(_ app: XCUIApplication, _ id: String) -> String {
    let e = element(app, id)
    return e.exists ? e.label : "(missing)"
  }

  /// One more frame after the page draws, before the probes and the shot.
  @MainActor
  private func settle() { Thread.sleep(forTimeInterval: 0.3) }
}
