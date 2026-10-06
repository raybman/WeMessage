import Foundation

/// Where the host finds node and main.mjs: beside its own executable in the
/// app bundle, <App>.app/Contents/Resources/daemon/{node,main.mjs}.
public struct HostLayout: Equatable, Sendable {
  public let node: URL
  public let main: URL
  /// "sh.wemessage.gateway"
  public let bundleIdentifier: String

  static let identifier = "sh.wemessage.gateway"
  static let nodeKey = "WEMESSAGE_HOST_NODE"
  static let mainKey = "WEMESSAGE_HOST_MAIN"

  /// executable = Bundle.main.executableURL; node = ../../Resources/daemon/node;
  /// main = ../../Resources/daemon/main.mjs, both relative to Contents/MacOS.
  /// Overrides: env["WEMESSAGE_HOST_NODE"], env["WEMESSAGE_HOST_MAIN"]. Each
  /// counts only when it is an absolute path, and each replaces its own half,
  /// so the CI smoke and the tests can run a bare executable by setting both.
  /// Whatever is chosen must exist: node is checked first, then main.mjs.
  public static func resolve(
    executable: URL, environment: [String: String],
    exists: (URL) -> Bool
  ) -> Result<HostLayout, HostLayoutError> {
    let resources = daemonResources(of: executable)
    guard
      let nodePath = absolute(environment[nodeKey]) ?? resources.map({ $0 + "/node" }),
      let mainPath = absolute(environment[mainKey]) ?? resources.map({ $0 + "/main.mjs" })
    else { return .failure(.notInsideBundle(executable)) }
    let node = URL(fileURLWithPath: nodePath, isDirectory: false)
    let main = URL(fileURLWithPath: mainPath, isDirectory: false)
    guard exists(node) else { return .failure(.missing(node)) }
    guard exists(main) else { return .failure(.missing(main)) }
    return .success(HostLayout(node: node, main: main, bundleIdentifier: identifier))
  }

  /// "<App>.app/Contents/Resources/daemon" when `executable` sits at
  /// <App>.app/Contents/MacOS/<name>, else nil. Reads the path only.
  static func daemonResources(of executable: URL) -> String? {
    let parts = executable.path.split(separator: "/")
    let count = parts.count
    guard count >= 3, parts[count - 2] == "MacOS", parts[count - 3] == "Contents" else { return nil }
    return "/" + parts.dropLast(2).joined(separator: "/") + "/Resources/daemon"
  }

  static func absolute(_ value: String?) -> String? {
    guard let value, value.hasPrefix("/") else { return nil }
    return value
  }
}

/// Why the host cannot start node.
public enum HostLayoutError: Error, Equatable, Sendable {
  /// The path the host would run or load does not exist.
  case missing(URL)
  /// The executable is not under Contents/MacOS, and the environment does
  /// not name both paths.
  case notInsideBundle(URL)
}
