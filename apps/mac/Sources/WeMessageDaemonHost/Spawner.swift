import Foundation

/// What to start: an absolute executable, its arguments and its whole environment.
public struct SpawnRequest: Equatable, Sendable {
  public var executable: URL
  /// argv[1...]; argv[0] is executable.path
  public var arguments: [String]
  /// Exactly the child's environment: nothing is inherited from the host.
  public var environment: [String: String]

  public init(executable: URL, arguments: [String], environment: [String: String]) {
    self.executable = executable
    self.arguments = arguments
    self.environment = environment
  }
}

/// Why a spawn failed. Each carries the errno the failing call returned.
public enum SpawnError: Error, Equatable, Sendable {
  /// posix_spawn itself failed (ENOENT for a missing executable, EACCES, ...).
  case posixSpawn(errno: Int32)
  /// Building the spawn attributes or file actions failed.
  case attributes(errno: Int32)
}

/// Starts node the way Chromium's launch_mac.cc starts a child, and reaps it.
///
/// Attributes: POSIX_SPAWN_SETSIGMASK with an empty mask, POSIX_SPAWN_SETSIGDEF
/// with every signal, and POSIX_SPAWN_CLOEXEC_DEFAULT. The host ignores TERM,
/// INT and HUP so its dispatch sources see them, and an ignored disposition
/// survives exec: without SETSIGDEF node would ignore the SIGTERM launchd sends
/// to stop it. CLOEXEC_DEFAULT keeps every descriptor the host holds out of
/// node except the three the file actions name.
///
/// File actions: fd 0 is opened on /dev/null, and fd 1 and fd 2 are inherited,
/// so node's output goes wherever launchd sent the host's. There is no close
/// action ahead of the open: the open replaces whatever fd 0 was, and a close
/// action on a descriptor that is not open fails the whole spawn with EBADF.
///
/// Nothing else is set: node does not replace the host, node stays in the
/// host's process group and session, and the host stays its responsible
/// process, which is what lets the app's Full Disk Access grant cover node.
public enum Spawner {
  /// posix_spawn with SETSIGMASK (empty) | SETSIGDEF (all) | CLOEXEC_DEFAULT;
  /// fd 0 <- /dev/null, fd 1 and 2 inherited. Returns the child's pid.
  public static func spawn(_ request: SpawnRequest) -> Result<pid_t, SpawnError> {
    var attributes: posix_spawnattr_t?
    var rc = posix_spawnattr_init(&attributes)
    guard rc == 0 else { return .failure(.attributes(errno: rc)) }
    defer { posix_spawnattr_destroy(&attributes) }

    var none = sigset_t()
    sigemptyset(&none)
    var every = sigset_t()
    sigfillset(&every)
    rc = posix_spawnattr_setsigmask(&attributes, &none)
    if rc == 0 { rc = posix_spawnattr_setsigdefault(&attributes, &every) }
    if rc == 0 {
      rc = posix_spawnattr_setflags(
        &attributes, Int16(POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_CLOEXEC_DEFAULT))
    }
    guard rc == 0 else { return .failure(.attributes(errno: rc)) }

    var actions: posix_spawn_file_actions_t?
    rc = posix_spawn_file_actions_init(&actions)
    guard rc == 0 else { return .failure(.attributes(errno: rc)) }
    defer { posix_spawn_file_actions_destroy(&actions) }
    rc = posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
    if rc == 0 { rc = posix_spawn_file_actions_addinherit_np(&actions, 1) }
    if rc == 0 { rc = posix_spawn_file_actions_addinherit_np(&actions, 2) }
    guard rc == 0 else { return .failure(.attributes(errno: rc)) }

    let path = request.executable.path
    var owned: [UnsafeMutablePointer<CChar>] = []
    defer { for pointer in owned { free(pointer) } }
    func cStrings(_ strings: [String]) -> [UnsafeMutablePointer<CChar>?]? {
      var out: [UnsafeMutablePointer<CChar>?] = []
      for string in strings {
        guard let copy = strdup(string) else { return nil }
        owned.append(copy)
        out.append(copy)
      }
      return out + [nil]
    }
    guard
      let argv = cStrings([path] + request.arguments),
      let envp = cStrings(HostEnvironment.envp(request.environment))
    else { return .failure(.posixSpawn(errno: ENOMEM)) }

    var pid: pid_t = 0
    rc = posix_spawn(&pid, path, &actions, &attributes, argv, envp)
    guard rc == 0 else { return .failure(.posixSpawn(errno: rc)) }
    return .success(pid)
  }

  /// waitpid loop that retries on EINTR; returns the raw status. Only a positive
  /// pid is waited for (0 and negative pids name process groups); anything else,
  /// and any wait error, reads as a plain exit with ExitStatus.software (70).
  public static func wait(pid: pid_t) -> Int32 {
    guard pid > 0 else { return ExitStatus.software << 8 }
    var status: Int32 = 0
    while true {
      let rc = waitpid(pid, &status, 0)
      if rc == pid { return status }
      if rc == -1 && errno == EINTR { continue }
      return ExitStatus.software << 8
    }
  }

  /// Blocks until the child `pid` has exited, without reaping it. The unreaped
  /// child keeps its pid reserved, so a signal the host sends meanwhile cannot
  /// reach another process that reused the number. wait(pid:) reaps it after.
  static func awaitExit(pid: pid_t) {
    guard pid > 0 else { return }
    var info = siginfo_t()
    while waitid(P_PID, id_t(pid), &info, WEXITED | WNOWAIT) == -1 && errno == EINTR {}
  }
}
