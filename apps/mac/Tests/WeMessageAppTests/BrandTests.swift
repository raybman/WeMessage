import Foundation
import Testing

@testable import WeMessageApp

/// v2 F11, header B: the title bar's brand. The mark is the canonical
/// asset's geometry, the brand adds no new blue and no green, the wordmark
/// clears large-text contrast over the wash, and the search field is a door
/// to the existing search, not a second key binding.
@Suite("Brand")
struct BrandTests {
  static let svgPath = "site/logo/mark.svg"

  /// Every number in an SVG attribute or path string, in order.
  static func numbers(_ s: some StringProtocol) -> [Double] {
    let regex = try! NSRegularExpression(pattern: #"-?\d+(?:\.\d+)?"#)
    let text = String(s)
    return regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap {
      Range($0.range, in: text).flatMap { Double(text[$0]) }
    }
  }

  static func attribute(_ name: String, in tag: Substring) -> String? {
    guard let start = tag.range(of: " \(name)=\"") else { return nil }
    let rest = tag[start.upperBound...]
    guard let end = rest.firstIndex(of: "\"") else { return nil }
    return String(rest[..<end])
  }

  static func tags(_ name: String, in svg: String) -> [Substring] {
    svg.components(separatedBy: "<\(name) ").dropFirst().map { Substring(" " + $0.prefix { $0 != ">" }) }
  }

  @Test("T10a: BrandMark's geometry is site/logo/mark.svg's, number for number")
  func markMatchesCanonicalAsset() throws {
    let svg = try Repo.text(Self.svgPath)
    #expect(svg.contains("Canonical asset"))
    #expect(svg.contains(#"viewBox="0 0 96 96""#))
    typealias G = BrandMark.Geometry
    #expect(G.viewBox == 96)

    let rect = try #require(Self.tags("rect", in: svg).first)
    let rectValues = ["x", "y", "width", "height", "rx"].compactMap { Self.attribute($0, in: rect).flatMap(Double.init) }
    #expect(rectValues == [G.bubble.minX, G.bubble.minY, G.bubble.width, G.bubble.height, G.bubbleRadius].map(Double.init))

    let paths = Self.tags("path", in: svg).compactMap { Self.attribute("d", in: $0) }
    #expect(paths.count == 3, "mark.svg has \(paths.count) paths")
    let flat: ([CGPoint]) -> [Double] = { $0.flatMap { [Double($0.x), Double($0.y)] } }
    #expect(Self.numbers(paths[0]) == flat(G.tail), "the tail drifted from mark.svg")
    #expect(Self.numbers(paths[1]) == flat(G.strokes[0]), "the W drifted from mark.svg")
    #expect(Self.numbers(paths[2]) == flat(G.strokes[1]), "the M drifted from mark.svg")

    let widths = svg.components(separatedBy: #"stroke-width=""#).dropFirst().compactMap { Double($0.prefix { $0 != "\"" }) }
    #expect(widths == [Double(G.strokeWidth), Double(G.strokeWidth)])
    #expect(svg.contains(##"fill="#0A84FF""##))
    #expect(svg.contains("rgba(255,255,255,.96)"))
    #expect(Tokens.Brand.markStroke == Tokens.Wash(rgb: Tokens.onTint, alpha: 0.96))
  }

  @Test("T10b: the brand adds no new blue and no green")
  func noNewBlue() {
    #expect(Tokens.Brand.mark == Tokens.tint)
    #expect(Tokens.Brand.washLight.rgb == Tokens.tint)
    #expect(Tokens.Brand.washDark.rgb == Tokens.tint)
    for dark in [false, true] {
      #expect([Tokens.tint, Tokens.outboundShaded].contains(Tokens.Brand.we(dark: dark)))
      #expect(!TokensTests.isGreen(Tokens.Brand.we(dark: dark)))
    }
    #expect(Tokens.Brand.washLight.alpha == 0.14)
    #expect(Tokens.Brand.washDark.alpha == 0.22)
    #expect(Tokens.Brand.washEnd == 0.55)
  }

  /// The wash at full strength (the bar's leading edge, where the lockup
  /// sits) over the modelled frost.
  static func washed(dark: Bool) -> Tokens.RGB {
    let wash = Tokens.Brand.wash(dark: dark)
    return Tokens.composite(wash.rgb, alpha: wash.alpha, over: Tokens.Frost.tint(dark: dark))
  }

  @Test("T10c: over the wash the wordmark's 'We' clears 3:1 (15 pt bold) and the bar's words keep 7:1")
  func wordmarkContrast() {
    for dark in [false, true] {
      let under = Self.washed(dark: dark)
      let palette = Tokens.palette(dark: dark)
      let we = Tokens.contrast(Tokens.Brand.we(dark: dark), under)
      #expect(we >= 3.0, "'We' at \(we):1 over the \(dark ? "dark" : "light") wash")
      #expect(Tokens.contrast(palette.ink, under) >= 7, "ink over the wash")
      #expect(Tokens.contrast(palette.inkDim, under) >= 7, "inkDim over the wash")
    }
    // Non-vacuity: the bare tint is the one that fails in light; the shade
    // is the one that fails in dark. The pick is not arbitrary.
    #expect(Tokens.contrast(Tokens.tint, Self.washed(dark: false)) < 3.0)
    #expect(Tokens.contrast(Tokens.outboundShaded, Self.washed(dark: true)) < 3.0)
  }

  @Test("T10d: the Needs You badge is white on the shaded tint, 4.5:1 or better")
  func badgeContrast() throws {
    #expect(Tokens.contrast(Tokens.onTint, Tokens.outboundShaded) >= 4.5)
    let titleBar = try Repo.text(AppHygieneTests.appDir + "/Boards/Shell/TitleBar.swift")
    #expect(titleBar.contains("Capsule().fill(Tokens.color(Tokens.outboundShaded))"))
    #expect(titleBar.contains("if let badge, badge > 0"), "a zero count draws a badge")
  }

  @Test("T10e: the title bar places the lockup and the search field; the field opens search and binds no key")
  func titleBarPlacement() throws {
    let brand = try Repo.text(AppHygieneTests.appDir + "/Boards/Shell/BrandMark.swift")
    let field = AppHygieneTests.block("TitleSearchField", in: brand)
    #expect(field.contains("model.openSearch()"))
    #expect(!field.contains(".keyboardShortcut("), "shift-cmd-F is Board11Keys'; a second binding would fire twice")
    #expect(field.contains(".accessibilityIdentifier(ShellID.titleSearch)"))
    #expect(field.contains("ViewThatFits"), "the field does not shrink on a narrow window")
    let lockup = AppHygieneTests.block("BrandLockup", in: brand)
    #expect(lockup.contains(#".accessibilityLabel("WeMessage")"#))
    #expect(lockup.contains(".accessibilityIdentifier(ShellID.titleBrand)"))
    let bar = AppHygieneTests.block("TitleBar", in: try Repo.text(AppHygieneTests.appDir + "/Boards/Shell/TitleBar.swift"))
    #expect(bar.contains("BrandLockup(palette:"))
    #expect(bar.contains("TitleSearchField(model: model"))
    let shell = try Repo.text(AppHygieneTests.appDir + "/ShellView.swift")
    #expect(shell.contains(".background(TitleWash(mirror: mirror, dark: dark))"))
  }

  @Test("T10f: Reduce Transparency draws no wash")
  @MainActor
  func washFollowsReduceTransparency() throws {
    let brand = try Repo.text(AppHygieneTests.appDir + "/Boards/Shell/BrandMark.swift")
    let wash = AppHygieneTests.block("TitleWash", in: brand)
    #expect(wash.contains("!mirror.reduceTransparency"))
    #expect(wash.contains("if Self.shown(mirror)"))
  }
}
