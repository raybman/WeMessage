import AppKit
import Foundation
import XCTest

/// v2 S7b: one sweep over every board (SweptBoard.allCases), in four legs
/// (each run as two halves):
/// light and dark, each with the frost on and with Reduce Transparency
/// forced on. For every board and leg the window is captured, attached as a
/// .keepAlways PNG, swept for green outside the traffic lights, checked not
/// blank, and held to its luminance band; one `SWEEP|` line per shot goes
/// to the log. The light frost leg also walks every window's accessibility
/// tree for interactive elements with nothing to speak (rubric 5.4), and the
/// opaque legs probe the shell's two hairlines for Tokens.Hairline.opaque*
/// (rubric 8.3). The board tests own each board's behaviour; this class owns
/// the properties every board shares. CI only (ui shard c).
final class BoardSweepTests: XCTestCase {
  override func setUp() async throws {
    try await FakeDaemon.reset()
  }

  // Each leg runs in two halves (01-09, 10-17): one test holds at most nine
  // launches, well inside the job's 300 s per-test allowance.

  @MainActor func testSweepLightFrostFirst() async throws { try await sweep("light", false, .first) }
  @MainActor func testSweepLightFrostSecond() async throws { try await sweep("light", false, .second) }
  @MainActor func testSweepDarkFrostFirst() async throws { try await sweep("dark", false, .first) }
  @MainActor func testSweepDarkFrostSecond() async throws { try await sweep("dark", false, .second) }
  @MainActor func testSweepLightOpaqueFirst() async throws { try await sweep("light", true, .first) }
  @MainActor func testSweepLightOpaqueSecond() async throws { try await sweep("light", true, .second) }
  @MainActor func testSweepDarkOpaqueFirst() async throws { try await sweep("dark", true, .first) }
  @MainActor func testSweepDarkOpaqueSecond() async throws { try await sweep("dark", true, .second) }

  // MARK: Non-vacuity, on synthetic images and trees

  /// The hairline probe finds the token drawn whole (2x) and half
  /// composited (1x), in both appearances, and finds nothing on a bare
  /// pane or on the translucent frost hairline that Reduce Transparency
  /// replaces.
  func testHairlineProbeSeesTheToken() throws {
    let grey: HairlineProbe.Pixel = (0x80, 0x80, 0x80)
    func image(row: HairlineProbe.Pixel?, column: HairlineProbe.Pixel?) throws -> NoGreen.Pixels {
      let png = FrostEvidence.synthetic(width: 60, height: 40) { x, y in
        if let row, y == 20 { return row }
        if let column, x == 30 { return column }
        return grey
      }
      return try XCTUnwrap(NoGreen.Pixels(png))
    }
    let xs = Array(stride(from: 2, to: 58, by: 4))
    let ys = Array(stride(from: 2, to: 38, by: 3))
    for dark in [false, true] {
      let t = HairlineProbe.token(dark: dark)
      let half: HairlineProbe.Pixel = (
        UInt8((Int(t.0) + 0x80) / 2), UInt8((Int(t.1) + 0x80) / 2), UInt8((Int(t.2) + 0x80) / 2)
      )
      for drawn in [t, half] {
        let px = try image(row: drawn, column: drawn)
        let across = HairlineProbe.across(px, y: 21, xs: xs, search: 2, token: t)
        let down = HairlineProbe.down(px, x: 29, ys: ys, search: 2, token: t)
        XCTAssertTrue(HairlineProbe.passes(across), "dark \(dark): \(drawn) across \(across)")
        XCTAssertTrue(HairlineProbe.passes(down), "dark \(dark): \(drawn) down \(down)")
      }
      let bare = try image(row: nil, column: nil)
      XCTAssertEqual(HairlineProbe.across(bare, y: 20, xs: xs, search: 2, token: t).hits, 0, "dark \(dark): bare pane")
      XCTAssertEqual(HairlineProbe.down(bare, x: 30, ys: ys, search: 2, token: t).hits, 0, "dark \(dark): bare pane")
      // The frost hairline: black at 8% (light) or white at 9% (dark) over the pane.
      let frost: HairlineProbe.Pixel = dark ? (0x8C, 0x8C, 0x8C) : (0x76, 0x76, 0x76)
      let translucent = try image(row: frost, column: frost)
      XCTAssertEqual(HairlineProbe.across(translucent, y: 20, xs: xs, search: 2, token: t).hits, 0, "dark \(dark): frost line")
      XCTAssertEqual(HairlineProbe.down(translucent, x: 30, ys: ys, search: 2, token: t).hits, 0, "dark \(dark): frost line")
    }
    // A probe that looks in the wrong place finds nothing.
    let px = try image(row: HairlineProbe.token(dark: false), column: nil)
    XCTAssertFalse(HairlineProbe.passes(HairlineProbe.across(px, y: 30, xs: xs, search: 2, token: HairlineProbe.token(dark: false))))
    XCTAssertFalse(HairlineProbe.passes((hits: 0, samples: 0)), "no samples is not a pass")
  }

  /// The unlabeled classifier flags exactly the controls with nothing to
  /// speak.
  func testUnlabeledSeesASilentButton() {
    let box = CGRect(x: 0, y: 0, width: 20, height: 20)
    func node(_ type: XCUIElement.ElementType, id: String = "x", label: String = "", title: String = "",
              placeholder: String = "", value: String = "", frame: CGRect = box) -> Unlabeled.Node {
      Unlabeled.Node(type: type, identifier: id, label: label, title: title, placeholder: placeholder, value: value, frame: frame)
    }
    let nodes = [
      node(.button, id: "labelled", label: "Approve"),
      node(.button, id: "titled", title: "Approve"),
      node(.button, id: "worded", value: "Approve"),
      node(.button, id: "silent"),
      node(.button, id: "blank", label: "  "),
      node(.button, id: "_XCUI:CloseWindow"),
      node(.button, id: "hidden", frame: .zero),
      node(.textField, id: "hinted", placeholder: "Search"),
      node(.textField, id: "typed", value: "hello"),
      node(.checkBox, id: "valued", value: "1"),
      node(.staticText, id: "text"),
      node(.group, id: "group"),
    ]
    let offenders = Unlabeled.offenders(nodes)
    XCTAssertEqual(offenders.count, 4, offenders.joined(separator: "\n"))
    for id in ["silent", "blank", "typed", "valued"] {
      XCTAssertTrue(offenders.contains { $0.contains("id '\(id)'") }, "\(id) not flagged: \(offenders)")
    }
  }

  /// The board list matches the board tests on disk: one case per board,
  /// in order, and every shell board has an anchor of its own.
  func testEveryBoardIsSwept() {
    XCTAssertEqual(SweptBoard.allCases.map(\.rawValue), (1...17).map { String(format: "%02d", $0) })
    XCTAssertEqual(SweptBoard.allCases.filter(\.isShell).count, 10)
    XCTAssertEqual(Set(SweptBoard.allCases.map(\.anchor)).count, SweptBoard.allCases.count, "two boards share an anchor")
    // The two halves partition the boards: every board in exactly one.
    XCTAssertEqual(SweptBoard.Half.first.boards + SweptBoard.Half.second.boards, SweptBoard.allCases)
    XCTAssertFalse(SweptBoard.Half.first.boards.isEmpty)
    XCTAssertFalse(SweptBoard.Half.second.boards.isEmpty)
  }

  // MARK: The sweep

  @MainActor
  private func sweep(_ appearance: String, _ reduceTransparency: Bool, _ half: SweptBoard.Half) async throws {
    let leg = "\(appearance)-\(reduceTransparency ? "opaque" : "frost")"
    let dark = appearance == "dark"
    var shots = 0
    for board in half.boards {
      guard let app = try await board.open(appearance: appearance, reduceTransparency: reduceTransparency) else {
        continue
      }
      QueueUI.settle()
      let window = app.windows.firstMatch
      let png = window.screenshot().pngRepresentation
      let name = "sweep-\(board.rawValue)-\(leg).png"
      let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
      attachment.name = name
      attachment.lifetime = .keepAlways
      add(attachment)
      guard let size = NoGreen.size(png), let px = NoGreen.Pixels(png) else {
        XCTFail("\(name): no decodable PNG")
        app.terminate()
        continue
      }
      shots += 1
      let band = NoGreen.trafficLightBand(pngSize: size, windowWidthPoints: window.frame.width)
      let green = NoGreen.offenders(png, excluding: band)
      let mean = NoGreen.meanLuminance(png)
      print("SWEEP|\(board.rawValue)|\(leg)|lum \(String(format: "%.3f", mean))|green \(green)")
      XCTAssertEqual(green, 0, "\(name): green pixels outside the traffic lights")
      XCTAssertFalse(NoGreen.isBlank(png), "\(name): a blank snapshot")
      if dark {
        XCTAssertLessThan(mean, board.band.dark, "\(name): a dark board renders light: mean luminance \(mean)")
      } else {
        XCTAssertGreaterThan(mean, board.band.light, "\(name): a light board renders dark: mean luminance \(mean)")
      }

      if !dark && !reduceTransparency {
        let silent = try unlabeled(app)
        print("UNLABELED|\(board.rawValue)|\(silent.count)")
        XCTAssertEqual(silent, [], "board \(board.rawValue): interactive elements with nothing to speak")
      }
      if reduceTransparency && board.isShell {
        hairlines(app, window: window, pixels: px, board: board, leg: leg, dark: dark)
      }
      app.terminate()
    }
    XCTAssertEqual(shots, half.boards.count, "\(leg) \(half): a board went unswept")
  }

  /// Every window's tree, flattened and classified.
  @MainActor
  private func unlabeled(_ app: XCUIApplication) throws -> [String] {
    var out: [String] = []
    for window in app.windows.allElementsBoundByIndex where window.exists {
      out += Unlabeled.offenders(Unlabeled.flatten(try window.snapshot()))
    }
    return out
  }

  /// The title band's line across, under the band, sampled over the
  /// sidebar; the rail's line down, at its trailing edge, sampled over its
  /// height. Both read from the rail's frame, so a collapsed or expanded
  /// rail moves the probe with it.
  @MainActor
  private func hairlines(
    _ app: XCUIApplication, window: XCUIElement, pixels px: NoGreen.Pixels, board: SweptBoard, leg: String, dark: Bool
  ) {
    let rail = QueueUI.element(app, ID.rail)
    guard rail.exists else {
      XCTFail("board \(board.rawValue) \(leg): no rail to probe the hairlines from")
      return
    }
    let w = window.frame
    let r = rail.frame
    let scale = Double(px.width) / Double(w.width)
    let token = HairlineProbe.token(dark: dark)
    let search = max(2, Int((2 * scale).rounded()))

    let yLine = Int(((r.minY - w.minY - 0.5) * scale).rounded(.down))
    let xFrom = (r.maxX - w.minX + 12) * scale
    let xTo = min(r.maxX - w.minX + 288, w.width - 12) * scale
    let xs = stride(from: xFrom, to: xTo, by: max(1, (xTo - xFrom) / 32)).map { Int($0) }
    let across = HairlineProbe.across(px, y: yLine, xs: xs, search: search, token: token)

    let xLine = Int(((r.maxX - w.minX) * scale).rounded(.down))
    let yFrom = (r.minY - w.minY + 24) * scale
    let yTo = (r.maxY - w.minY - 24) * scale
    let ys = stride(from: yFrom, to: yTo, by: max(1, (yTo - yFrom) / 32)).map { Int($0) }
    let down = HairlineProbe.down(px, x: xLine, ys: ys, search: search, token: token)

    let line =
      "HAIRLINE|\(board.rawValue)|\(leg)|scale \(scale)|token \(token)|across y=\(yLine) \(across.hits)/\(across.samples)"
      + "|down x=\(xLine) \(down.hits)/\(down.samples)"
    print(line)
    XCTAssertTrue(HairlineProbe.passes(across), "board \(board.rawValue) \(leg): the title hairline is not the opaque token: \(line)")
    XCTAssertTrue(HairlineProbe.passes(down), "board \(board.rawValue) \(leg): the rail hairline is not the opaque token: \(line)")
  }
}
