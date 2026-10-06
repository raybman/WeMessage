import Foundation
import Testing
import WeMessageDaemonHost

/// Rows 3 and 4: where node and main.mjs are. resolve sees the filesystem only
/// through `exists`, so these rows hand it a set of present paths and create
/// nothing; DaemonHostTests row 11 runs the same resolution against a real
/// fake bundle on disk.
@Suite("HostLayout")
struct HostLayoutTests {
  static let app = FileManager.default.temporaryDirectory.path + "/wemessage-host-layout/WeMessage.app"
  static let exe = file(app + "/Contents/MacOS/WeMessage")
  static let node = app + "/Contents/Resources/daemon/node"
  static let main = app + "/Contents/Resources/daemon/main.mjs"

  static func file(_ path: String) -> URL { URL(fileURLWithPath: path, isDirectory: false) }

  static func resolve(
    _ executable: URL, _ environment: [String: String] = [:], present: Set<String>
  ) -> Result<HostLayout, HostLayoutError> {
    HostLayout.resolve(executable: executable, environment: environment, exists: { present.contains($0.path) })
  }

  /// "node /path" or "main /path" on success, the error's case and path on failure.
  static func outcome(_ result: Result<HostLayout, HostLayoutError>) -> [String] {
    switch result {
    case .success(let layout): return ["node " + layout.node.path, "main " + layout.main.path]
    case .failure(.missing(let url)): return ["missing " + url.path]
    case .failure(.notInsideBundle(let url)): return ["notInsideBundle " + url.path]
    }
  }

  @Test("row 3: resolve from <tmp>/WeMessage.app/Contents/MacOS/WeMessage yields Resources/daemon/node and main.mjs when both exist; .missing(url) when node is absent; .notInsideBundle when the exe is not under Contents/MacOS")
  func bundleRelative() throws {
    let layout = try Self.resolve(Self.exe, present: [Self.node, Self.main]).get()
    #expect(layout.node.path == Self.node)
    #expect(layout.main.path == Self.main)
    #expect(layout.bundleIdentifier == "sh.wemessage.gateway")

    #expect(Self.outcome(Self.resolve(Self.exe, present: [Self.main])) == ["missing " + Self.node])
    #expect(Self.outcome(Self.resolve(Self.exe, present: [Self.node])) == ["missing " + Self.main])
    #expect(Self.outcome(Self.resolve(Self.exe, present: [])) == ["missing " + Self.node])

    let everything: Set<String> = [Self.node, Self.main]
    for stray in ["/usr/local/bin/WeMessage", Self.app + "/Contents/Resources/WeMessage", "/MacOS/WeMessage"] {
      #expect(Self.outcome(Self.resolve(Self.file(stray), present: everything)) == ["notInsideBundle " + stray])
    }
  }

  @Test("row 4: inside a bundle the overrides are ignored and the paths are bundle-relative; a bare exe (debug build) still honours WEMESSAGE_HOST_NODE and WEMESSAGE_HOST_MAIN and requires them to exist")
  func overrides() throws {
    let env = ["WEMESSAGE_HOST_NODE": "/opt/stub/node", "WEMESSAGE_HOST_MAIN": "/opt/stub/main.mjs"]
    let stubs: Set<String> = ["/opt/stub/node", "/opt/stub/main.mjs"]
    let all = stubs.union([Self.node, Self.main])
    let bundled = ["node " + Self.node, "main " + Self.main]

    // v2 S2c.1 (P0-2): a bundle exe never runs what its environment names.
    #expect(Self.outcome(Self.resolve(Self.exe, env, present: all)) == bundled)
    // Both overrides make a bundle unnecessary: a bare exe runs the stubs.
    let bare = Self.file("/usr/local/bin/WeMessage")
    #expect(Self.outcome(Self.resolve(bare, env, present: stubs)) == ["node /opt/stub/node", "main /opt/stub/main.mjs"])
    // Inside a bundle a missing override is not consulted, so it cannot fail the resolve.
    #expect(Self.outcome(Self.resolve(Self.exe, env, present: [Self.node, Self.main, "/opt/stub/main.mjs"])) == bundled)
    // A bare exe's overrides are still required to exist.
    #expect(Self.outcome(Self.resolve(bare, env, present: ["/opt/stub/node"])) == ["missing /opt/stub/main.mjs"])
    // One override: inside a bundle it is ignored too, and a bare exe has no bundle to fall back on.
    let nodeOnly = ["WEMESSAGE_HOST_NODE": "/opt/stub/node"]
    #expect(Self.outcome(Self.resolve(Self.exe, nodeOnly, present: all)) == bundled)
    #expect(Self.outcome(Self.resolve(bare, nodeOnly, present: all)) == ["notInsideBundle /usr/local/bin/WeMessage"])
  }

  @Test("an empty or relative override is ignored: overrides are absolute paths")
  func relativeOverrideIgnored() {
    let env = ["WEMESSAGE_HOST_NODE": "stub/node", "WEMESSAGE_HOST_MAIN": ""]
    let all: Set<String> = [Self.node, Self.main, "stub/node"]
    #expect(Self.outcome(Self.resolve(Self.exe, env, present: all)) == ["node " + Self.node, "main " + Self.main])
  }
}
