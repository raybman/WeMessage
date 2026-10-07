import Foundation
import Testing

/// Rows 16 and 17: the host targets' import rule and their never-daemonise
/// sweep, mirrored by the "v2 S1: the Swift tree" rows of test/arch.spec.ts.
/// UI framework and test framework names are assembled at runtime, so this
/// file never spells an import it forbids.
@Suite("HostHygiene")
struct HostHygieneTests {
  static let hostDir = "apps/mac/Sources/WeMessageDaemonHost"
  static let exeDir = "apps/mac/Sources/WeMessage"
  /// v2 S3: the window target and the XCUITest bundle. They link the UI
  /// frameworks by design, so row 16's ban is narrowed to the daemon's side
  /// of the tree, and row 17's never-daemonise sweep is widened to them.
  static let appDir = "apps/mac/Sources/WeMessageApp"
  static let uiTestsDir = "apps/mac/UITests/WeMessageUITests"
  /// The directories whose code can run on the launchd path, or test it.
  static let headlessDirs = [
    "apps/mac/Sources/WeMessageKit", hostDir, exeDir,
    "apps/mac/Tests/WeMessageKitTests", "apps/mac/Tests/WeMessageDaemonHostTests",
  ]
  static let forbiddenFrameworks = ["App" + "Kit", "Swift" + "UI", "Com" + "bine", "XC" + "Test"]

  /// The six spellings of "leave the host's process tree or its
  /// responsibility": exec away the host, start a new process group or
  /// session, daemonise, or disclaim. None may appear in a host source, not
  /// even in a comment.
  static let neverInHost = [
    "POSIX_SPAWN_SETEXEC", "POSIX_SPAWN_SETPGROUP", "setsid", "setpgid", "daemon(",
    "responsibility_spawnattrs",
  ]

  /// Every module `text` imports; the same reader as KitHygieneTests.
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

  @Test("row 16: Sources/WeMessageDaemonHost/*.swift import Foundation only and main.swift adds the host and the app; no AppKit, SwiftUI, Combine or XCTest in the kit, the host, the exe or their tests; the app never imports Combine")
  func importRule() throws {
    let host = try Self.swiftFiles(under: Self.hostDir)
    #expect(host.count >= 8, "host sources found: \(host.count)")
    for file in host {
      let modules = try Self.imports(try Repo.text(Self.hostDir + "/" + file))
      #expect(modules.allSatisfy { $0 == "Foundation" }, "\(file) imports \(modules)")
    }
    #expect(try Self.swiftFiles(under: Self.exeDir) == ["main.swift"])
    let main = Set(try Self.imports(try Repo.text(Self.exeDir + "/main.swift")))
    #expect(main == ["Foundation", "WeMessageDaemonHost", "WeMessageApp"])

    var swept = 0
    for dir in Self.headlessDirs {
      for file in try Self.swiftFiles(under: dir) {
        swept += 1
        let modules = Set(try Self.imports(try Repo.text(dir + "/" + file)))
        #expect(modules.isDisjoint(with: Self.forbiddenFrameworks), "\(dir)/\(file) imports \(modules.intersection(Self.forbiddenFrameworks).sorted())")
      }
    }
    #expect(swept >= 40, "headless files swept: \(swept)")
    // The window target links the UI frameworks, never Combine.
    var appImportsSwiftUI = false
    for file in try Self.swiftFiles(under: Self.appDir) {
      let modules = Set(try Self.imports(try Repo.text(Self.appDir + "/" + file)))
      #expect(!modules.contains(Self.forbiddenFrameworks[2]), "\(file) imports \(Self.forbiddenFrameworks[2])")
      if modules.contains(Self.forbiddenFrameworks[1]) { appImportsSwiftUI = true }
    }
    // Non-vacuity of the narrowing: the app really is where the UI went.
    #expect(appImportsSwiftUI)
    // Non-vacuity: the reader sees the import forms it is there to deny.
    #expect(try Self.imports("import \(Self.forbiddenFrameworks[0])\n@preconcurrency import \(Self.forbiddenFrameworks[2])") == [
      Self.forbiddenFrameworks[0], Self.forbiddenFrameworks[2],
    ])
  }

  @Test("row 17: no file under Sources/WeMessageDaemonHost, Sources/WeMessage, Sources/WeMessageApp or UITests/WeMessageUITests contains 'POSIX_SPAWN_SETEXEC', 'POSIX_SPAWN_SETPGROUP', 'setsid', 'setpgid', 'daemon(' or 'responsibility_spawnattrs'")
  func neverDaemonises() throws {
    var swept = 0
    for dir in [Self.hostDir, Self.exeDir, Self.appDir, Self.uiTestsDir] {
      for file in try Self.swiftFiles(under: dir) {
        swept += 1
        let text = try Repo.text(dir + "/" + file)
        for token in Self.neverInHost {
          #expect(!text.contains(token), "\(dir)/\(file) contains \(token)")
        }
      }
    }
    #expect(swept >= 17, "host, app and UI test files swept: \(swept)")
    // Non-vacuity: the spawner the sweep protects is the one that sets the
    // attributes the host does need.
    let spawner = try Repo.text(Self.hostDir + "/Spawner.swift")
    #expect(spawner.contains("POSIX_SPAWN_SETSIGDEF"))
    #expect(spawner.contains("POSIX_SPAWN_CLOEXEC_DEFAULT"))
  }
}
