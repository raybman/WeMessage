import Foundation
import Testing
import WeMessageDaemonHost

/// Rows 1 and 2: what argv means to the host. argv[0] is dropped; `--daemon`
/// alone starts the daemon; so does the legacy Electron vector, so a plist that
/// still names .../Contents/Resources/daemon/main.mjs starts the host too.
@Suite("HostArguments")
struct HostArgumentsTests {
  static let legacy = "/A/WeMessage.app/Contents/Resources/daemon/main.mjs"

  @Test("row 1: ['x','--daemon'] -> .daemon; ['x'] -> .usage; ['x','--daemon','extra'] throws trailingArguments; ['x','--window'] throws unknownFlag")
  func modes() throws {
    #expect(try HostArguments.parse(["x", "--daemon"]).mode == .daemon)
    #expect(try HostArguments.parse(["x"]).mode == .usage)
    #expect(try HostArguments.parse([]).mode == .usage)
    #expect(throws: HostArgumentsError.trailingArguments(["extra"])) {
      try HostArguments.parse(["x", "--daemon", "extra"])
    }
    #expect(throws: HostArgumentsError.trailingArguments(["a", "b"])) {
      try HostArguments.parse(["x", "--daemon", "a", "b"])
    }
    #expect(throws: HostArgumentsError.unknownFlag("--window")) {
      try HostArguments.parse(["x", "--window"])
    }
    #expect(throws: HostArgumentsError.unknownFlag("-daemon")) {
      try HostArguments.parse(["x", "-daemon"])
    }
  }

  @Test("row 2: legacy vector ['x', '/A/WeMessage.app/Contents/Resources/daemon/main.mjs'] -> .daemon")
  func legacyVector() throws {
    #expect(try HostArguments.parse(["x", Self.legacy]).mode == .daemon)
    #expect(throws: HostArgumentsError.trailingArguments(["extra"])) {
      try HostArguments.parse(["x", Self.legacy, "extra"])
    }
    // Any other main.mjs is not the vector a bundle plist writes.
    #expect(throws: HostArgumentsError.unknownFlag("/A/main.mjs")) {
      try HostArguments.parse(["x", "/A/main.mjs"])
    }
  }

  @Test("isDaemon reads argv[1] only, so main.swift can test it before anything else; trailing arguments still reach run(), which refuses them")
  func isDaemon() {
    #expect(HostArguments.isDaemon(["x", "--daemon"]))
    #expect(HostArguments.isDaemon(["x", Self.legacy]))
    #expect(HostArguments.isDaemon(["x", "--daemon", "extra"]))
    #expect(!HostArguments.isDaemon([]))
    #expect(!HostArguments.isDaemon(["x"]))
    #expect(!HostArguments.isDaemon(["x", "--window"]))
    #expect(!HostArguments.isDaemon(["x", "extra", "--daemon"]))
  }
}
