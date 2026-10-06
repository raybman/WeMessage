import Foundation

/// The environment node starts with: the host's own, minus what would make
/// node something other than the daemon, plus three keys that tell the
/// daemon it runs under the Swift host.
public enum HostEnvironment {
  /// Value "swift".
  public static let hostKey = "WEMESSAGE_HOST"
  /// The host's pid: the process launchd tracks for the job.
  public static let pidKey = "WEMESSAGE_HOST_PID"
  /// The host's CFBundleShortVersionString (HostVersion).
  public static let versionKey = "WEMESSAGE_HOST_VERSION"
  /// ELECTRON_RUN_AS_NODE belongs to the Electron host's way of running the
  /// daemon and never reaches the Swift host's child.
  public static let strippedKeys: Set<String> = ["ELECTRON_RUN_AS_NODE"]

  /// Returns parent + the three host keys, minus strippedKeys. Pure.
  public static func forChild(parent: [String: String], pid: pid_t, version: String) -> [String: String] {
    var env = parent.filter { !strippedKeys.contains($0.key) }
    env[hostKey] = "swift"
    env[pidKey] = String(pid)
    env[versionKey] = version
    return env
  }

  /// Encodes as "KEY=VALUE" sorted by key, for posix_spawn's envp.
  public static func envp(_ env: [String: String]) -> [String] {
    env.sorted { $0.key < $1.key }.map { $0.key + "=" + $0.value }
  }
}
