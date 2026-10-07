import Foundation
import Testing
import WeMessageKit

/// R0 and R9: the toolchain proof, then the kit's import and logging hygiene.
/// The test-framework name this file hunts for is assembled at runtime, so the
/// file never spells the import it forbids.
@Suite("KitHygiene")
struct KitHygieneTests {
  @Test("package compiles and swift test runs one trivial test")
  func trivial() {
    #expect(WireVersion.current == 1)
  }

  static let forbiddenFramework = "XC" + "Test"

  /// Every module `text` imports, with attributes (@testable, @preconcurrency)
  /// and import kinds (struct, func, ...) stripped.
  static func imports(_ text: String) throws -> [String] {
    let pattern =
      #"^[ \t]*(?:@\w+\s+)*import\s+(?:(?:typealias|struct|class|enum|protocol|let|var|func)\s+)?([A-Za-z_]\w*)"#
    let regex = try NSRegularExpression(pattern: pattern, options: [.anchorsMatchLines])
    let range = NSRange(text.startIndex..., in: text)
    return regex.matches(in: text, range: range).compactMap { match in
      Range(match.range(at: 1), in: text).map { String(text[$0]) }
    }
  }

  static func swiftFiles(under rel: String) throws -> [String] {
    try Repo.files(under: rel, skipping: [".build", ".swiftpm"]).filter { $0.hasSuffix(".swift") }
  }

  @Test("every file under Sources/WeMessageKit imports Foundation and nothing else")
  func sourceImports() throws {
    let files = try Self.swiftFiles(under: "apps/mac/Sources/WeMessageKit")
    #expect(files.count >= 10, "kit sources found: \(files.count)")
    for file in files {
      let modules = try Self.imports(try Repo.text("apps/mac/Sources/WeMessageKit/" + file))
      #expect(modules.allSatisfy { $0 == "Foundation" }, "\(file) imports \(modules)")
    }
  }

  @Test("no print, NSLog or debugPrint in the kit's sources")
  func noLogging() throws {
    let regex = try NSRegularExpression(pattern: #"\b(?:print|NSLog|debugPrint)\("#)
    for file in try Self.swiftFiles(under: "apps/mac/Sources/WeMessageKit") {
      let text = try Repo.text("apps/mac/Sources/WeMessageKit/" + file)
      let hits = regex.numberOfMatches(in: text, range: NSRange(text.startIndex..., in: text))
      #expect(hits == 0, "\(file) writes to stdout or the system log \(hits) time(s)")
    }
  }

  @Test("tests import only Foundation, Testing and the target under test, and no file under apps/mac/Sources or apps/mac/Tests imports the XCTest framework")
  func testImports() throws {
    let tests = try Self.swiftFiles(under: "apps/mac/Tests")
    #expect(tests.count >= 8, "test files found: \(tests.count)")
    for file in tests {
      // Tests/<Target>Tests/...: each test target may import its own target only.
      let suite = String(file.split(separator: "/")[0])
      #expect(suite.hasSuffix("Tests"), "\(file) sits outside a <Target>Tests directory")
      var allowed: Set<String> = ["Foundation", "Testing", String(suite.dropLast("Tests".count))]
      // v2 S3: the app's model speaks the kit's types, so its tests may too.
      if suite == "WeMessageAppTests" { allowed.insert("WeMessageKit") }
      let modules = Set(try Self.imports(try Repo.text("apps/mac/Tests/" + file)))
      #expect(modules.isSubset(of: allowed), "\(file) imports \(modules.subtracting(allowed).sorted())")
    }
    // v2 S3: the XCUITest bundle under apps/mac/UITests is the one place the
    // framework is legal (test/arch.spec.ts holds that side); the SwiftPM
    // tree, Sources and Tests, never imports it.
    var swept = 0
    for root in ["apps/mac/Sources", "apps/mac/Tests"] {
      for file in try Self.swiftFiles(under: root) {
        swept += 1
        let modules = try Self.imports(try Repo.text(root + "/" + file))
        #expect(!modules.contains(Self.forbiddenFramework), "\(root)/\(file) imports \(Self.forbiddenFramework)")
      }
    }
    #expect(swept >= 40, "SwiftPM files swept: \(swept)")
  }
}
