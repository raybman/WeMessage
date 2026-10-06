import Foundation
import Testing
import WeMessageDaemonHost

/// Row 5: the environment node starts with, plus the version string the host
/// reports in it.
@Suite("HostEnvironment")
struct HostEnvironmentTests {
  /// The ten keys forwarded verbatim (v2 S2c.1, P0-1). Each has a reader in
  /// the daemon or its adapter children; anything else in the parent is
  /// dropped.
  static let forwarded: Set<String> = [
    "WEMESSAGE_DIR", "WEMESSAGE_PORT", "WEMESSAGE_CHATDB", "WEMESSAGE_SUPERVISOR",
    "WEMESSAGE_LAUNCHD_LABEL", "HOME", "TMPDIR", "TZ", "USER", "LOGNAME",
  ]
  static let systemPath = "/usr/bin:/bin:/usr/sbin:/sbin"

  @Test("row 5: forChild is an allowlist: the ten forwarded keys pass verbatim, PATH is pinned, WEMESSAGE_HOST/PID/VERSION and the two WS_NO_* keys are set, everything else (NODE_OPTIONS, DYLD_*, overrides) is dropped; envp is sorted KEY=VALUE")
  func forChild() {
    #expect(HostEnvironment.hostKey == "WEMESSAGE_HOST")
    #expect(HostEnvironment.pidKey == "WEMESSAGE_HOST_PID")
    #expect(HostEnvironment.versionKey == "WEMESSAGE_HOST_VERSION")
    #expect(HostEnvironment.forwardedKeys == Self.forwarded)
    #expect(HostEnvironment.childPath == Self.systemPath)
    #expect(HostEnvironment.pinned == [
      "PATH": Self.systemPath, "WS_NO_BUFFER_UTIL": "1", "WS_NO_UTF_8_VALIDATE": "1",
    ])

    var parent: [String: String] = [:]
    for key in Self.forwarded { parent[key] = "v-" + key.lowercased() }
    let hostile = [
      "NODE_OPTIONS": "--require /tmp/evil.js",
      "NODE_PATH": "/tmp/evil",
      "NODE_REPL_EXTERNAL_MODULE": "/tmp/evil.js",
      "NODE_EXTRA_CA_CERTS": "/tmp/evil.pem",
      "DYLD_INSERT_LIBRARIES": "/tmp/evil.dylib",
      "ELECTRON_RUN_AS_NODE": "1",
      "WEMESSAGE_HOST_NODE": "/tmp/evil/node",
      "WEMESSAGE_HOST_MAIN": "/tmp/evil/main.mjs",
      "SSH_AUTH_SOCK": "/tmp/agent.sock",
      "SHELL": "/bin/zsh",
      "LANG": "C",
      "LC_ALL": "C",
      "PATH": "/tmp/evil:/usr/bin",
      "WEMESSAGE_HOST": "electron",
      "WEMESSAGE_HOST_PID": "1",
      "WEMESSAGE_HOST_VERSION": "evil",
      "WS_NO_BUFFER_UTIL": "",
      "WS_NO_UTF_8_VALIDATE": "0",
    ]
    parent.merge(hostile) { _, new in new }
    let env = HostEnvironment.forChild(parent: parent, pid: 4321, version: "1.2.3")

    // The exact key set, not a count.
    let host: Set<String> = [
      "PATH", "WEMESSAGE_HOST", "WEMESSAGE_HOST_PID", "WEMESSAGE_HOST_VERSION",
      "WS_NO_BUFFER_UTIL", "WS_NO_UTF_8_VALIDATE",
    ]
    #expect(Set(env.keys) == Self.forwarded.union(host))
    for key in Self.forwarded {
      #expect(env[key] == "v-" + key.lowercased(), "\(key)")
    }
    for key in hostile.keys where !host.contains(key) {
      #expect(env[key] == nil, "\(key) reached the child")
    }
    #expect(env["PATH"] == Self.systemPath)
    #expect(env["WEMESSAGE_HOST"] == "swift")
    #expect(env["WEMESSAGE_HOST_PID"] == "4321")
    #expect(env["WEMESSAGE_HOST_VERSION"] == "1.2.3")
    #expect(env["WS_NO_BUFFER_UTIL"] == "1")
    #expect(env["WS_NO_UTF_8_VALIDATE"] == "1")
    // Forwarded only when present: an empty parent yields the host's keys alone.
    #expect(HostEnvironment.forChild(parent: [:], pid: 7, version: "0") == [
      "PATH": Self.systemPath, "WEMESSAGE_HOST": "swift", "WEMESSAGE_HOST_PID": "7",
      "WEMESSAGE_HOST_VERSION": "0", "WS_NO_BUFFER_UTIL": "1", "WS_NO_UTF_8_VALIDATE": "1",
    ])
    // Pure: the parent is not consulted again and not changed.
    #expect(parent["NODE_OPTIONS"] == "--require /tmp/evil.js")
    #expect(parent["PATH"] == "/tmp/evil:/usr/bin")

    let envp = HostEnvironment.envp(HostEnvironment.forChild(parent: ["HOME": "/nonexistent-home", "LANG": "C"], pid: 4321, version: "1.2.3"))
    #expect(envp == [
      "HOME=/nonexistent-home", "PATH=" + Self.systemPath,
      "WEMESSAGE_HOST=swift", "WEMESSAGE_HOST_PID=4321", "WEMESSAGE_HOST_VERSION=1.2.3",
      "WS_NO_BUFFER_UTIL=1", "WS_NO_UTF_8_VALIDATE=1",
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
