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

  @Test("row 16: Sources/WeMessageDaemonHost/*.swift and Sources/WeMessage/main.swift import Foundation only; no AppKit, SwiftUI, Combine or XCTest anywhere under apps/mac")
  func importRule() throws {
    let host = try Self.swiftFiles(under: Self.hostDir)
    #expect(host.count >= 8, "host sources found: \(host.count)")
    for file in host {
      let modules = try Self.imports(try Repo.text(Self.hostDir + "/" + file))
      #expect(modules.allSatisfy { $0 == "Foundation" }, "\(file) imports \(modules)")
    }
    #expect(try Self.swiftFiles(under: Self.exeDir) == ["main.swift"])
    let main = Set(try Self.imports(try Repo.text(Self.exeDir + "/main.swift")))
    #expect(main == ["Foundation", "WeMessageDaemonHost"])

    let everything = try Self.swiftFiles(under: "apps/mac")
    #expect(everything.contains("Package.swift"))
    for file in everything {
      let modules = Set(try Self.imports(try Repo.text("apps/mac/" + file)))
      #expect(modules.isDisjoint(with: Self.forbiddenFrameworks), "\(file) imports \(modules.intersection(Self.forbiddenFrameworks).sorted())")
    }
    // Non-vacuity: the reader sees the import forms it is there to deny.
    #expect(try Self.imports("import \(Self.forbiddenFrameworks[0])\n@preconcurrency import \(Self.forbiddenFrameworks[2])") == [
      Self.forbiddenFrameworks[0], Self.forbiddenFrameworks[2],
    ])
  }

  @Test("row 17: no file under Sources/WeMessageDaemonHost or Sources/WeMessage contains 'POSIX_SPAWN_SETEXEC', 'POSIX_SPAWN_SETPGROUP', 'setsid', 'setpgid', 'daemon(' or 'responsibility_spawnattrs'")
  func neverDaemonises() throws {
    var swept = 0
    for dir in [Self.hostDir, Self.exeDir] {
      for file in try Self.swiftFiles(under: dir) {
        swept += 1
        let text = try Repo.text(dir + "/" + file)
        for token in Self.neverInHost {
          #expect(!text.contains(token), "\(dir)/\(file) contains \(token)")
        }
      }
    }
    #expect(swept >= 9, "host files swept: \(swept)")
    // Non-vacuity: the spawner the sweep protects is the one that sets the
    // attributes the host does need.
    let spawner = try Repo.text(Self.hostDir + "/Spawner.swift")
    #expect(spawner.contains("POSIX_SPAWN_SETSIGDEF"))
    #expect(spawner.contains("POSIX_SPAWN_CLOEXEC_DEFAULT"))
  }
}
