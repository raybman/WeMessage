import Foundation

/// What the WeMessage executable was asked to do.
public enum HostMode: Equatable, Sendable {
  /// Host the bundled node as a child process, under launchd.
  case daemon
  /// Print the usage line. The window arrives in S3.
  case usage
}

/// Why argv is not one the host accepts.
public enum HostArgumentsError: Error, Equatable, Sendable {
  /// argv[1] is neither `--daemon` nor the legacy Electron vector.
  case unknownFlag(String)
  /// Whatever follows `--daemon` (or the legacy vector).
  case trailingArguments([String])
}

/// argv as launchd hands it to the host.
public struct HostArguments: Equatable, Sendable {
  public let mode: HostMode

  static let flag = "--daemon"
  /// What a 'bundle' plist written for the Electron app passes as argv[1].
  static let legacySuffix = "/Contents/Resources/daemon/main.mjs"

  /// argv[0] is dropped. `--daemon` alone -> .daemon. Empty -> .usage.
  /// A legacy Electron vector (argv[1] ends with "/Contents/Resources/daemon/main.mjs")
  /// -> .daemon as well, so a not-yet-migrated 'bundle' plist still starts the host.
  public static func parse(_ argv: [String]) throws -> HostArguments {
    let rest = argv.dropFirst()
    guard let first = rest.first else { return HostArguments(mode: .usage) }
    guard asksForDaemon(first) else { throw HostArgumentsError.unknownFlag(first) }
    let trailing = Array(rest.dropFirst())
    guard trailing.isEmpty else { throw HostArgumentsError.trailingArguments(trailing) }
    return HostArguments(mode: .daemon)
  }

  /// True when argv[1] asks for the daemon. It reads argv[1] and nothing else,
  /// so main.swift can ask before it does anything else; `parse` still refuses
  /// trailing arguments, and DaemonHost.run calls it first.
  public static func isDaemon(_ argv: [String]) -> Bool {
    argv.count >= 2 && asksForDaemon(argv[1])
  }

  static func asksForDaemon(_ argument: String) -> Bool {
    argument == flag || argument.hasSuffix(legacySuffix)
  }
}
