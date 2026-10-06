import Foundation

/// How DaemonHost.run is tuned. The defaults are the shipping values; the tests
/// shorten the grace period and collect the lines.
public struct DaemonHostOptions: Sendable {
  /// How long node has to exit after the first forwarded SIGTERM before the
  /// host sends SIGKILL. 15 s sits inside launchd's default 20 s exit timeout,
  /// which the plist does not change.
  public var gracePeriod: DispatchTimeInterval = .seconds(15)
  /// Receives each line the host reports, already prefixed "wemessage-host: ".
  /// The default writes the line and a newline to fd 2.
  public var stderr: @Sendable (String) -> Void = { DaemonHostOptions.writeToStandardError($0) }

  public init() {}

  /// write(2) on fd 2: nothing buffered, and no exception path if fd 2 is gone.
  static func writeToStandardError(_ line: String) {
    let bytes = Array((line + "\n").utf8)
    bytes.withUnsafeBytes { buffer in
      guard let base = buffer.baseAddress else { return }
      var offset = 0
      while offset < buffer.count {
        let written = write(STDERR_FILENO, base + offset, buffer.count - offset)
        if written > 0 {
          offset += written
        } else if written == -1 && errno == EINTR {
          continue
        } else {
          return
        }
      }
    }
  }
}

/// `WeMessage --daemon`: launchd runs the host, the host runs node as its child.
public enum DaemonHost {
  static let usage = "usage: WeMessage --daemon"

  /// Composes the above. Returns the process exit code; never calls exit() itself.
  ///
  /// 1. HostArguments.parse: the usage form or a bad argv is one line and 64.
  /// 2. HostLayout.resolve: a missing node or main.mjs is one line and 78.
  /// 3. SignalForwarder.install: from here TERM, INT and HUP reach node.
  /// 4. Spawner.spawn node with [main.mjs]: a failure is one line and 70.
  /// 5. Wait for node to exit, then reap it and return n, or 128 + its signal.
  ///
  /// The first SIGTERM also starts the grace period; if node is still running
  /// at its end the host sends SIGKILL and says so on one line. A signal that
  /// arrives before node exists is held and sent as soon as it does.
  public static func run(
    argv: [String], environment: [String: String], executable: URL,
    options: DaemonHostOptions = .init()
  ) -> Int32 {
    let stderr = options.stderr
    let say: @Sendable (String) -> Void = { stderr("wemessage-host: " + $0) }

    do {
      guard try HostArguments.parse(argv).mode == .daemon else {
        say(usage)
        return ExitStatus.usage
      }
    } catch HostArgumentsError.unknownFlag(let flag) {
      say("unknown argument \(flag); \(usage)")
      return ExitStatus.usage
    } catch HostArgumentsError.trailingArguments(let extra) {
      say("unexpected arguments: \(extra.joined(separator: " ")); \(usage)")
      return ExitStatus.usage
    } catch {
      say("\(error); \(usage)")
      return ExitStatus.usage
    }

    let layout: HostLayout
    switch HostLayout.resolve(
      executable: executable, environment: environment,
      exists: { FileManager.default.fileExists(atPath: $0.path) })
    {
    case .success(let found):
      layout = found
    case .failure(.missing(let url)):
      say("cannot start node: \(url.path) does not exist")
      return ExitStatus.config
    case .failure(.notInsideBundle(let url)):
      say("cannot find node: \(url.path) is not in an app bundle's Contents/MacOS")
      return ExitStatus.config
    }

    let queue = DispatchQueue(label: "sh.wemessage.gateway.host.signals")
    let slot = ChildSlot()
    let firstTerm = Latch()
    let grace = options.gracePeriod
    let escalation = Escalation {
      if slot.forward(SIGKILL) {
        say("node did not exit within the grace period after SIGTERM; sent SIGKILL")
      }
    }
    let forwarder = SignalForwarder(queue: queue)
    defer {
      forwarder.cancel()
      escalation.cancel()
    }
    forwarder.install { sig in
      slot.forward(sig)
      if sig == SIGTERM && firstTerm.fire() {
        escalation.schedule(on: queue, after: grace)
      }
    }

    let request = SpawnRequest(
      executable: layout.node, arguments: [layout.main.path],
      environment: HostEnvironment.forChild(parent: environment, pid: getpid(), version: HostVersion.current()))
    var failure: SpawnError?
    let started = slot.attach {
      switch Spawner.spawn(request) {
      case .success(let pid):
        return pid
      case .failure(let error):
        failure = error
        return nil
      }
    }
    guard let pid = started else {
      say("could not start \(layout.node.path): \(describe(failure))")
      return ExitStatus.software
    }

    Spawner.awaitExit(pid: pid)
    slot.detach()
    return ExitStatus.decode(Spawner.wait(pid: pid)).processExitCode
  }

  static func describe(_ failure: SpawnError?) -> String {
    switch failure {
    case .posixSpawn(let code)?: return "posix_spawn: " + String(cString: strerror(code))
    case .attributes(let code)?: return "spawn attributes: " + String(cString: strerror(code))
    case nil: return "no child pid"
    }
  }
}

/// The one child the host may signal. A signal that arrives before the child
/// exists is held and sent once it does; after detach() nothing is sent at
/// all. Every send goes to the one positive pid posix_spawn returned, never to
/// 0, -1 or a process group. `send` is injectable so a test can record instead.
final class ChildSlot: @unchecked Sendable {
  private let lock = NSLock()
  private let send: @Sendable (pid_t, Int32) -> Int32
  private var pid: pid_t = 0
  private var closed = false
  private var pending: [Int32] = []

  init(send: @escaping @Sendable (pid_t, Int32) -> Int32 = { pid, sig in pid > 0 ? kill(pid, sig) : -1 }) {
    self.send = send
  }

  /// Sends `sig` to the child and reports whether it went out. With no child
  /// yet it is held (once per signal); after detach() it is dropped.
  @discardableResult
  func forward(_ sig: Int32) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if closed { return false }
    guard pid > 0 else {
      if !pending.contains(sig) { pending.append(sig) }
      return false
    }
    return send(pid, sig) == 0
  }

  /// Runs `start` under the lock, so no signal can fall between the spawn and
  /// the pid being recorded, then sends whatever was held. Returns the child's
  /// pid, or nil when the slot is taken or closed, or start gave no positive pid.
  func attach(_ start: () -> pid_t?) -> pid_t? {
    lock.lock()
    defer { lock.unlock() }
    guard !closed, pid == 0, let child = start(), child > 0 else { return nil }
    pid = child
    for sig in pending { _ = send(child, sig) }
    pending = []
    return child
  }

  /// The child has exited: from now on nothing is sent or held.
  func detach() {
    lock.lock()
    defer { lock.unlock() }
    pid = 0
    closed = true
    pending = []
  }
}

/// fire() is true exactly once.
final class Latch: @unchecked Sendable {
  private let lock = NSLock()
  private var fired = false

  func fire() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if fired { return false }
    fired = true
    return true
  }
}

/// The grace period's SIGKILL: scheduled at most once, cancelled when run returns.
final class Escalation: @unchecked Sendable {
  private let item: DispatchWorkItem

  init(_ body: @escaping @Sendable () -> Void) {
    item = DispatchWorkItem(block: body)
  }

  func schedule(on queue: DispatchQueue, after delay: DispatchTimeInterval) {
    queue.asyncAfter(deadline: .now() + delay, execute: item)
  }

  func cancel() { item.cancel() }
}
