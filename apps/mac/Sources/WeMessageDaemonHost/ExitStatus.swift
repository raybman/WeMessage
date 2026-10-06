import Foundation

/// How node ended, and the code the host exits with, by the shell's
/// convention, so launchd's LastExitStatus for the host reads like node's.
public enum ExitStatus: Equatable, Sendable {
  case exited(Int32)
  case signaled(Int32)

  /// EX_USAGE: argv is not one the host accepts.
  public static let usage: Int32 = 64
  /// EX_SOFTWARE: node could not be started.
  public static let software: Int32 = 70
  /// EX_CONFIG: node or main.mjs is missing.
  public static let config: Int32 = 78

  /// WIFEXITED -> .exited(WEXITSTATUS); WIFSIGNALED -> .signaled(WTERMSIG).
  /// The core-dump bit is ignored. The host never asks to see a stopped
  /// child, so a stop status, should one arrive, reads as its stop signal.
  public static func decode(_ rawWaitStatus: Int32) -> ExitStatus {
    let low = rawWaitStatus & 0x7f
    if low == 0 { return .exited((rawWaitStatus >> 8) & 0xff) }
    if low != 0x7f { return .signaled(low) }
    return .signaled((rawWaitStatus >> 8) & 0xff)
  }

  /// .exited(n) -> n; .signaled(s) -> 128 + s
  public var processExitCode: Int32 {
    switch self {
    case .exited(let code): return code
    case .signaled(let signal): return 128 + signal
    }
  }
}
