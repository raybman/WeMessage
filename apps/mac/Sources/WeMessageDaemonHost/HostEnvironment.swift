import Foundation

/// The environment node starts with. It is an allowlist, never the host's own
/// environment minus a few keys: whatever launches the host (a LaunchAgent
/// plist, a shell) chooses the host's environment, and none of that choice may
/// decide what node loads or which tools it finds by bare name.
public enum HostEnvironment {
  /// Value "swift".
  public static let hostKey = "WEMESSAGE_HOST"
  /// The host's pid: the process launchd tracks for the job.
  public static let pidKey = "WEMESSAGE_HOST_PID"
  /// The host's CFBundleShortVersionString (HostVersion).
  public static let versionKey = "WEMESSAGE_HOST_VERSION"

  /// The keys forwarded verbatim, and only when the parent has them. Each one
  /// has a reader: the daemon's Env.parse (the five WEMESSAGE_* keys),
  /// homedir() (HOME), sqlite and osascript temp files (TMPDIR), schedule math
  /// (TZ) and adapter children (USER, LOGNAME). Everything else is dropped,
  /// NODE_OPTIONS, NODE_PATH, DYLD_* and ELECTRON_RUN_AS_NODE included.
  public static let forwardedKeys: Set<String> = [
    "WEMESSAGE_DIR", "WEMESSAGE_PORT", "WEMESSAGE_CHATDB", "WEMESSAGE_SUPERVISOR",
    "WEMESSAGE_LAUNCHD_LABEL", "HOME", "TMPDIR", "TZ", "USER", "LOGNAME",
  ]

  /// The system default PATH, which is also what launchd gives a job. The
  /// daemon runs osascript, open and launchctl by bare name, so a PATH chosen
  /// by whoever launched the host would choose those programs too.
  public static let childPath = "/usr/bin:/bin:/usr/sbin:/sbin"

  /// Set by the host whatever the parent says: the pinned PATH, and the two
  /// keys that keep ws on its pure-JS path (the bundle already compiles its
  /// optional native requires out; this is the second lock).
  public static let pinned: [String: String] = [
    "PATH": childPath,
    "WS_NO_BUFFER_UTIL": "1",
    "WS_NO_UTF_8_VALIDATE": "1",
  ]

  /// Returns the forwarded keys present in parent, plus pinned, plus the three
  /// host keys. Pure.
  public static func forChild(parent: [String: String], pid: pid_t, version: String) -> [String: String] {
    var env = parent.filter { forwardedKeys.contains($0.key) }
    env.merge(pinned) { _, host in host }
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
