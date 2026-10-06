import Foundation

/// Where the host finds node and main.mjs: beside its own executable in the
/// app bundle, <App>.app/Contents/Resources/daemon/{node,main.mjs}.
public struct HostLayout: Equatable, Sendable {
  public let node: URL
  public let main: URL
  /// "sh.wemessage.gateway"
  public let bundleIdentifier: String

  static let identifier = "sh.wemessage.gateway"

  /// executable = Bundle.main.executableURL; node = ../../Resources/daemon/node;
  /// main = ../../Resources/daemon/main.mjs, both relative to Contents/MacOS.
  /// A debug build run as a bare executable (not under Contents/MacOS) may
  /// name either path in its environment instead, so the tests can point the
  /// real host at a stub without a bundle; see `override`. Whatever is chosen
  /// must exist: node is checked first, then main.mjs.
  public static func resolve(
    executable: URL, environment: [String: String],
    exists: (URL) -> Bool
  ) -> Result<HostLayout, HostLayoutError> {
    let resources = daemonResources(of: executable)
    guard
      let nodePath = override(node: true, environment: environment, resources: resources)
        ?? resources.map({ $0 + "/node" }),
      let mainPath = override(node: false, environment: environment, resources: resources)
        ?? resources.map({ $0 + "/main.mjs" })
    else { return .failure(.notInsideBundle(executable)) }
    let node = URL(fileURLWithPath: nodePath, isDirectory: false)
    let main = URL(fileURLWithPath: mainPath, isDirectory: false)
    guard exists(node) else { return .failure(.missing(node)) }
    guard exists(main) else { return .failure(.missing(main)) }
    return .success(HostLayout(node: node, main: main, bundleIdentifier: identifier))
  }

  /// The environment's choice of node (or of main.mjs), or nil. Always nil in
  /// a release build, which contains no code that reads either key: whether
  /// the exe sits in a bundle is read from a path, and a copied or linked exe
  /// changes that path, so a runtime check alone cannot keep a signed build
  /// from running what its environment names. In a debug build, nil unless
  /// the exe is bare; an absolute path only, and each key replaces its own half.
  private static func override(node: Bool, environment: [String: String], resources: String?) -> String? {
    #if WEMESSAGE_HOST_OVERRIDES
      if resources == nil {
        return absolute(environment[node ? "WEMESSAGE_HOST_NODE" : "WEMESSAGE_HOST_MAIN"])
      }
    #endif
    return nil
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
  /// The executable is not under Contents/MacOS (and, in a debug build, its
  /// environment does not name both paths).
  case notInsideBundle(URL)
}
