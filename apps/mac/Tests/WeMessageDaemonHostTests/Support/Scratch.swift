import Foundation

/// One test's private directory under FileManager.default.temporaryDirectory.
/// Every child a test starts is /bin/sh running a stub script written here (or
/// /bin/sleep started by such a stub). Each test defers `remove()`.
struct Scratch {
  let dir: URL

  init() throws {
    dir = FileManager.default.temporaryDirectory.appendingPathComponent(
      "wemessage-host-tests-" + UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  }

  func path(_ rel: String) -> String { url(rel).path }

  func url(_ rel: String) -> URL { dir.appendingPathComponent(rel, isDirectory: false) }

  /// Writes `#!/bin/sh` and `body` to `rel`, mode 755. Stubs use shell
  /// builtins and /bin/sleep only, and never sleep longer than 5 s.
  @discardableResult
  func stub(_ rel: String, _ body: String) throws -> URL {
    let target = try write(rel, "#!/bin/sh\n" + body + "\n")
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: target.path)
    return target
  }

  @discardableResult
  func write(_ rel: String, _ text: String) throws -> URL {
    let target = url(rel)
    try FileManager.default.createDirectory(
      at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data(text.utf8).write(to: target)
    return target
  }

  func read(_ rel: String) -> String? {
    FileManager.default.contents(atPath: path(rel)).flatMap { String(data: $0, encoding: .utf8) }
  }

  func exists(_ rel: String) -> Bool { FileManager.default.fileExists(atPath: path(rel)) }

  func remove() { try? FileManager.default.removeItem(at: dir) }
}

/// Reaps a child the calling test spawned. Polls waitpid(pid, WNOHANG) for up
/// to `timeout` seconds; a child still running then gets SIGKILL, sent to that
/// one positive pid (never 0, -1 or a group), and is reaped. Returns the raw
/// wait status, or nil when the child had to be killed or was not ours.
enum Reap {
  static func child(_ pid: pid_t, timeout: TimeInterval = 5) -> Int32? {
    guard pid > 0 else { return nil }
    var status: Int32 = 0
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
      let rc = waitpid(pid, &status, WNOHANG)
      if rc == pid { return status }
      if rc == -1 && errno != EINTR { return nil }
      usleep(10_000)
    } while Date() < deadline
    if pid > 0 { _ = kill(pid, SIGKILL) }
    while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
    return nil
  }
}

/// The dispositions of `signals`, saved on init and put back by `restore()`.
/// Only the serialized DaemonHost suite changes a disposition, and each of its
/// tests defers a restore.
struct Dispositions {
  private let saved: [(Int32, sigaction)]

  init(_ signals: [Int32]) {
    saved = signals.map { sig in
      var old = sigaction()
      sigaction(sig, nil, &old)
      return (sig, old)
    }
  }

  func restore() {
    for (sig, old) in saved {
      var action = old
      sigaction(sig, &action, nil)
    }
  }

  static func isIgnored(_ sig: Int32) -> Bool {
    var action = sigaction()
    sigaction(sig, nil, &action)
    return unsafeBitCast(action.__sigaction_u.__sa_handler, to: Int.self)
      == unsafeBitCast(SIG_IGN, to: Int.self)
  }
}

/// Sends SIGTERM to this test process, once, after `marker` appears, from a
/// background queue. The marker is written by the host's child, so the host's
/// forwarder is installed by then and forwards the signal. The send happens
/// under a lock, only while SIGTERM is ignored and never after `stop()`, so a
/// self-sent SIGTERM can neither take the default action nor land after a
/// test has restored its dispositions.
final class SelfSignal: @unchecked Sendable {
  private let lock = NSLock()
  private let running = DispatchGroup()
  private var stopped = false
  private var sent = 0

  func arm(when marker: String, timeout: TimeInterval = 5) {
    running.enter()
    DispatchQueue.global().async {
      defer { self.running.leave() }
      let deadline = Date().addingTimeInterval(timeout)
      while Date() < deadline {
        if self.fire(after: marker) { return }
        usleep(10_000)
      }
    }
  }

  /// True when the poller is done: the signal went out, or it never may.
  private func fire(after marker: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if stopped { return true }
    guard FileManager.default.fileExists(atPath: marker) else { return false }
    guard Dispositions.isIgnored(SIGTERM) else { return true }
    if kill(getpid(), SIGTERM) == 0 { sent += 1 }
    return true
  }

  /// Disarms the poller, waits for it, and reports whether SIGTERM went out once.
  @discardableResult
  func stop() -> Bool {
    lock.lock()
    stopped = true
    lock.unlock()
    running.wait()
    lock.lock()
    defer { lock.unlock() }
    return sent == 1
  }
}

/// Lines a test collects from DaemonHostOptions.stderr, from any thread.
final class Lines: @unchecked Sendable {
  private let lock = NSLock()
  private var lines: [String] = []

  func add(_ line: String) {
    lock.lock()
    lines.append(line)
    lock.unlock()
  }

  var all: [String] {
    lock.lock()
    defer { lock.unlock() }
    return lines
  }
}

/// Every (pid, signal) a ChildSlot under test asked to send, recorded instead
/// of sent.
final class SignalLog: @unchecked Sendable {
  struct Entry: Equatable, CustomStringConvertible {
    let pid: pid_t
    let signal: Int32
    var description: String { "signal \(signal) to pid \(pid)" }
  }

  private let lock = NSLock()
  private var entries: [Entry] = []

  func add(_ pid: pid_t, _ signal: Int32) {
    lock.lock()
    entries.append(Entry(pid: pid, signal: signal))
    lock.unlock()
  }

  var all: [Entry] {
    lock.lock()
    defer { lock.unlock() }
    return entries
  }
}
