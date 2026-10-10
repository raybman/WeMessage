import AppKit
import Foundation
import XCTest

/// v2 S7b: every board the app draws, as one list the sweeps iterate. A board
/// is a scenario, an optional WEMESSAGE_UI_BOARD argument, the steps that
/// bring it on screen, and the element that proves it is there. A new board
/// is one case here, and the arch row "every BoardNNTests has a sweep case"
/// keeps the list whole (plan S7b: "the sweep iterates every board, so B
/// slices inherit it").
enum SweptBoard: String, CaseIterable {
  case b01 = "01", b02 = "02", b03 = "03", b04 = "04", b05 = "05", b06 = "06", b07 = "07", b08 = "08"
  case b09 = "09", b10 = "10", b11 = "11", b12 = "12", b13 = "13", b14 = "14", b15 = "15", b16 = "16"
  case b17 = "17"

  /// A sweep leg runs as two tests, so no one test holds seventeen launches.
  enum Half {
    case first, second
    var boards: [SweptBoard] {
      let cut = SweptBoard.allCases.firstIndex(of: .b10)!
      return self == .first ? Array(SweptBoard.allCases[..<cut]) : Array(SweptBoard.allCases[cut...])
    }
  }

  /// The fake daemon scenario; nil keeps the S0 golden from reset().
  var scenario: String? {
    switch self {
    case .b01, .b02, .b12, .b14, .b15, .b16, .b17: return "rich"
    case .b03: return "preview-whatsapp"
    case .b04: return "preview-linkedin"
    case .b05: return "preview-email"
    case .b06, .b09: return "pending"
    case .b07: return "preview-voice"
    case .b08: return nil
    case .b10: return "degraded"
    case .b11: return "search"
    case .b13: return "kill"
    }
  }

  /// WEMESSAGE_UI_BOARD for the specimen windows; nil for the shell.
  var boardArgument: String? {
    switch self {
    case .b08, .b12, .b13, .b14, .b15, .b16, .b17: return rawValue
    default: return nil
    }
  }

  /// The shell draws the rail, the title band and both hairlines.
  var isShell: Bool { boardArgument == nil }

  /// The element whose existence proves the board is on screen.
  var anchor: String {
    switch self {
    case .b01: return ID.shell
    case .b02: return ID.thread
    case .b03: return ID.whatsAppBoard
    case .b04: return ID.linkedInBoard
    case .b05: return ID.emailBoard
    case .b06: return ID.triageBar
    case .b07: return ID.voiceDockBoard07
    case .b08: return ID.atlas
    case .b09: return ID.bulkStrip
    case .b10: return ID.trustBanner
    case .b11: return ID.search
    case .b12: return ID.onboarding
    case .b13: return ID.settings
    case .b14: return ID.compose
    case .b15: return ID.media
    case .b16: return ID.osLayer
    case .b17: return ID.progress
    }
  }

  /// The luminance band its own board test holds: board 01 the plan's
  /// 0.65/0.35, every other board the 0.6/0.4 its BoardNNTests asserts.
  var band: (light: Double, dark: Double) {
    self == .b01 ? (0.65, 0.35) : (0.6, 0.4)
  }

  /// Launches the app on this board and waits for its anchor; nil (after
  /// an XCTFail) when the board never appeared.
  @MainActor
  func open(appearance: String, reduceTransparency: Bool) async throws -> XCUIApplication? {
    try await FakeDaemon.reset()
    if let scenario { try await FakeDaemon.scenario(scenario) }
    let app = UITestApp.make(appearance: appearance, reduceTransparency: reduceTransparency, board: boardArgument)
    app.launch()
    if isShell {
      guard UITestApp.shellElement(app).waitForExistence(timeout: UITestApp.timeout) else {
        XCTFail("board \(rawValue): the shell never appeared")
        return app
      }
    }
    switch self {
    case .b02, .b07:
      // Board 07's voice dock draws over Priya's thread (Board07Tests).
      QueueUI.open(app, QueueUI.priya)
    case .b03, .b04, .b05:
      app.typeKey(String(rawValue.suffix(1)), modifierFlags: .command)
    case .b06:
      app.typeKey("t", modifierFlags: .command)
    case .b09:
      let lens = QueueUI.element(app, ID.lensNeedsYou)
      if lens.waitForExistence(timeout: UITestApp.timeout) { lens.click() }
    case .b11:
      _ = QueueUI.element(app, ID.rowPrefix + QueueUI.maya).waitForExistence(timeout: UITestApp.timeout)
      app.typeKey("f", modifierFlags: [.command, .shift])
    default:
      break
    }
    let anchor = QueueUI.element(app, self.anchor)
    if !(QueueUI.waitUntil { anchor.exists }) {
      XCTFail("board \(rawValue): \(self.anchor) never appeared")
    }
    return app
  }
}

/// The opaque hairline probe (plan S7b): with Reduce Transparency on, the
/// pane dividers are Tokens.Hairline.opaqueLight / opaqueDark. A 0.5 pt line
/// is one whole pixel at 2x and half a pixel at 1x, so a sample matches when
/// it is the token, or the token half-composited over the pixel beside it.
enum HairlineProbe {
  typealias Pixel = (UInt8, UInt8, UInt8)

  static let tolerance = 4
  /// Of the sampled positions, the share that must find the line.
  static let minHitRate = 0.8

  /// Tokens.Hairline.opaqueLight and opaqueDark. Restated, because
  /// Tokens.swift needs WeMessageKit, which the UI test target does not
  /// link; TokensTests "the sweep's hairline probe reads the opaque
  /// hairline tokens" reads these two lines back and holds them equal.
  static let opaqueLight: Pixel = (0xE1, 0xE1, 0xE3)
  static let opaqueDark: Pixel = (0x30, 0x30, 0x32)

  static func token(dark: Bool) -> Pixel { dark ? opaqueDark : opaqueLight }

  static func distance(_ a: Pixel, _ b: Pixel) -> Int {
    max(abs(Int(a.0) - Int(b.0)), abs(Int(a.1) - Int(b.1)), abs(Int(a.2) - Int(b.2)))
  }

  /// True when `p` is `token`, or `token` composited 50% over a neighbour
  /// that `p` is visibly not (so a plain background never counts).
  static func matches(_ p: Pixel, token: Pixel, neighbours: [Pixel]) -> Bool {
    distance(p, token) <= tolerance
      || neighbours.contains { n in
      let half: Pixel = (
        UInt8((Int(token.0) + Int(n.0)) / 2), UInt8((Int(token.1) + Int(n.1)) / 2),
        UInt8((Int(token.2) + Int(n.2)) / 2)
      )
        return distance(p, half) <= tolerance && distance(p, n) >= 2
      }
  }

  private static func rgb(_ px: NoGreen.Pixels, _ x: Int, _ y: Int) -> Pixel {
    let p = px[x, y]
    return (p.0, p.1, p.2)
  }

  /// A line across at pixel row `y`: for each column in `xs`, does any row
  /// within `search` of `y` match? (hits, samples).
  static func across(_ px: NoGreen.Pixels, y: Int, xs: [Int], search: Int, token: Pixel) -> (hits: Int, samples: Int) {
    var hits = 0
    var samples = 0
    for x in xs where x >= 0 && x < px.width {
      samples += 1
      let rows = max(1, y - search)...min(px.height - 2, y + search)
      if rows.contains(where: { r in
        matches(rgb(px, x, r), token: token, neighbours: [rgb(px, x, r - 1), rgb(px, x, r + 1)])
      }) {
        hits += 1
      }
    }
    return (hits, samples)
  }

  /// A line down at pixel column `x`, sampled at the rows in `ys`.
  static func down(_ px: NoGreen.Pixels, x: Int, ys: [Int], search: Int, token: Pixel) -> (hits: Int, samples: Int) {
    var hits = 0
    var samples = 0
    for y in ys where y >= 0 && y < px.height {
      samples += 1
      let cols = max(1, x - search)...min(px.width - 2, x + search)
      if cols.contains(where: { c in
        matches(rgb(px, c, y), token: token, neighbours: [rgb(px, c - 1, y), rgb(px, c + 1, y)])
      }) {
        hits += 1
      }
    }
    return (hits, samples)
  }

  static func passes(_ result: (hits: Int, samples: Int)) -> Bool {
    result.samples > 0 && Double(result.hits) >= minHitRate * Double(result.samples)
  }
}

/// The "zero interactive elements without a label" sweep (plan S7b): every
/// control VoiceOver can land on speaks a label, a title or a placeholder.
enum Unlabeled {
  static let interactive: Set<XCUIElement.ElementType> = [
    .button, .checkBox, .radioButton, .popUpButton, .menuButton, .textField, .secureTextField, .searchField,
    .comboBox, .slider, .stepper, .toggle, .switch, .link, .disclosureTriangle, .tab, .colorWell, .textView,
  ]

  struct Node {
    let type: XCUIElement.ElementType
    let identifier: String
    let label: String
    let title: String
    let placeholder: String
    /// The value as a string; spoken for a button or link (a SwiftUI Text
    /// label can reach XCUI as the value), never for a field, whose value
    /// is what the user typed.
    let value: String
    let frame: CGRect
    /// Inside a scroll bar: AppKit's scroller and its page areas, which the
    /// app does not draw and cannot label.
    var inScrollBar = false
    /// The parent's element type, for the failure line.
    var parent: XCUIElement.ElementType? = nil
  }

  /// Controls whose value is user content, not a name.
  static let fields: Set<XCUIElement.ElementType> = [
    .textField, .secureTextField, .searchField, .comboBox, .textView, .slider, .stepper, .checkBox, .switch, .toggle,
    .radioButton, .popUpButton,
  ]

  static func flatten(
    _ snapshot: any XCUIElementSnapshot, inScrollBar: Bool = false, parent: XCUIElement.ElementType? = nil
  ) -> [Node] {
    let inside = inScrollBar || snapshot.elementType == .scrollBar
    var out: [Node] = [
      Node(
        type: snapshot.elementType, identifier: snapshot.identifier, label: snapshot.label, title: snapshot.title,
        placeholder: snapshot.placeholderValue ?? "", value: (snapshot.value as? String) ?? "", frame: snapshot.frame,
        inScrollBar: inside, parent: parent)
    ]
    for child in snapshot.children { out += flatten(child, inScrollBar: inside, parent: snapshot.elementType) }
    return out
  }

  /// One line per interactive node with nothing to speak. System window
  /// chrome (`_XCUI:` identifiers), a scroll bar's parts and zero-size nodes
  /// are not the app's to label.
  static func offenders(_ nodes: [Node]) -> [String] {
    nodes.compactMap { n in
      guard interactive.contains(n.type), !n.identifier.hasPrefix("_XCUI:"), !n.inScrollBar else { return nil }
      guard n.frame.width >= 1, n.frame.height >= 1 else { return nil }
      let names = [n.label, n.title, n.placeholder] + (fields.contains(n.type) ? [] : [n.value])
      let spoken = names.contains { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
      let under = n.parent.map { " in type \($0.rawValue)" } ?? ""
      return spoken ? nil : "type \(n.type.rawValue) id '\(n.identifier)' frame \(n.frame)\(under)"
    }
  }
}
