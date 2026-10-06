import Foundation
import Testing
import WeMessageDaemonHost

/// Row 5: the environment node starts with, plus the version string the host
/// reports in it.
@Suite("HostEnvironment")
struct HostEnvironmentTests {
  @Test("row 5: forChild adds WEMESSAGE_HOST=swift, PID, VERSION; strips ELECTRON_RUN_AS_NODE; preserves PATH and HOME; envp is sorted KEY=VALUE")
  func forChild() {
    #expect(HostEnvironment.hostKey == "WEMESSAGE_HOST")
    #expect(HostEnvironment.pidKey == "WEMESSAGE_HOST_PID")
    #expect(HostEnvironment.versionKey == "WEMESSAGE_HOST_VERSION")
    #expect(HostEnvironment.strippedKeys == ["ELECTRON_RUN_AS_NODE"])

    let parent = [
      "PATH": "/usr/bin:/bin",
      "HOME": "/nonexistent-home",
      "LANG": "C",
      "ELECTRON_RUN_AS_NODE": "1",
      "WEMESSAGE_HOST": "electron",
    ]
    let env = HostEnvironment.forChild(parent: parent, pid: 4321, version: "1.2.3")
    #expect(env["WEMESSAGE_HOST"] == "swift")
    #expect(env["WEMESSAGE_HOST_PID"] == "4321")
    #expect(env["WEMESSAGE_HOST_VERSION"] == "1.2.3")
    #expect(env["ELECTRON_RUN_AS_NODE"] == nil)
    #expect(env["PATH"] == "/usr/bin:/bin")
    #expect(env["HOME"] == "/nonexistent-home")
    #expect(env["LANG"] == "C")
    #expect(env.count == 6)
    // Pure: the parent is not consulted again and not changed.
    #expect(parent["ELECTRON_RUN_AS_NODE"] == "1")

    let envp = HostEnvironment.envp(env)
    #expect(envp == [
      "HOME=/nonexistent-home", "LANG=C", "PATH=/usr/bin:/bin",
      "WEMESSAGE_HOST=swift", "WEMESSAGE_HOST_PID=4321", "WEMESSAGE_HOST_VERSION=1.2.3",
    ])
    // Sorted by key (A before A1 even though "1" sorts before "="); a value may hold "=".
    #expect(HostEnvironment.envp(["B": "2", "A1": "z", "A": "x=y", "C": ""]) == ["A=x=y", "A1=z", "B=2", "C="])
    #expect(HostEnvironment.envp([:]) == [])
  }

  @Test("HostVersion.current reads CFBundleShortVersionString, else 0.0.0-dev")
  func version() throws {
    let scratch = try Scratch()
    defer { scratch.remove() }
    func bundle(_ name: String, _ info: [String: String]) throws -> Bundle {
      let plist = try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
      try scratch.write(name + "/Contents/Info.plist", String(decoding: plist, as: UTF8.self))
      return try #require(Bundle(url: scratch.url(name)))
    }
    let versioned = try bundle("Versioned.bundle", [
      "CFBundleIdentifier": "sh.wemessage.gateway.tests.versioned",
      "CFBundleShortVersionString": "9.8.7",
    ])
    #expect(HostVersion.current(bundle: versioned) == "9.8.7")
    let bare = try bundle("Bare.bundle", ["CFBundleIdentifier": "sh.wemessage.gateway.tests.bare"])
    #expect(HostVersion.current(bundle: bare) == "0.0.0-dev")
  }
}
