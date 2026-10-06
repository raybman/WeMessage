import Foundation
import Testing
@testable import WeMessageDaemonHost

/// Row 9, rows 11-15, the no-child row and the install row: everything that
/// changes a process-wide signal disposition or relies on one. swift-testing
/// runs suites in parallel, so they share ONE serialized suite, and every test
/// saves the TERM, INT and HUP dispositions first and restores them in a defer.
///
/// Children are /bin/sh running a stub from the test's own Scratch directory,
/// or the /bin/sleep such a stub starts, never for longer than 5 s. run() reaps
/// its own child; the tests that spawn directly reap with Reap. Signals go only
/// to this process (getpid()) and, through the host, to the host's own child.
///
/// A test that signals itself sets SIGTERM to SIG_IGN first, then arms a
/// SelfSignal whose stop() is deferred AFTER the restore, so it runs BEFORE it:
/// no self-sent SIGTERM can take the default action or outlive the test.
@Suite("DaemonHost (process-global, serialized)", .serialized)
struct DaemonHostTests {
  static let path = "/usr/bin:/bin"
  /// The dispositions a test here may change, saved from this list and not
  /// from the code under test, so a broken forwarder cannot skip a restore.
  static let touched: [Int32] = [SIGTERM, SIGINT, SIGHUP]
  static let bare = URL(fileURLWithPath: "/usr/local/bin/WeMessage", isDirectory: false)
  static let daemonDir = "WeMessage.app/Contents/Resources/daemon/"

  /// <scratch>/WeMessage.app with Resources/daemon/main.mjs and, when given,
  /// a node stub. Returns Contents/MacOS/WeMessage, which is never created:
  /// resolve reads only its path.
  static func fakeBundle(_ scratch: Scratch, node: String?) throws -> URL {
    try scratch.write(daemonDir + "main.mjs", "")
    if let node { try scratch.stub(daemonDir + "node", node) }
    return scratch.url("WeMessage.app/Contents/MacOS/WeMessage")
  }

  static func options(_ lines: Lines, grace: DispatchTimeInterval = .seconds(5)) -> DaemonHostOptions {
    var options = DaemonHostOptions()
    options.gracePeriod = grace
    options.stderr = { lines.add($0) }
    return options
  }

  @Test("row 9: the child's inherited SIG_IGN is reset: with SIGTERM ignored here, a stub running 'kill -TERM $$' is signaled(15)")
  func resetsIgnoredSignals() throws {
    let scratch = try Scratch()
    defer { scratch.remove() }
    let saved = Dispositions(Self.touched)
    defer { saved.restore() }
    signal(SIGTERM, SIG_IGN)
    try #require(Dispositions.isIgnored(SIGTERM))
    let stub = try scratch.stub("self-term", """
      kill -TERM $$
      exit 0
      """)
    let request = SpawnRequest(executable: stub, arguments: [], environment: ["PATH": Self.path])
    let pid = try Spawner.spawn(request).get()
    let status = try #require(Reap.child(pid))
    #expect(ExitStatus.decode(status) == .signaled(SIGTERM))
  }

  @Test("row 11: run with a stub node that records its env and exits 0 returns 0, and the env has WEMESSAGE_HOST=swift, no ELECTRON_RUN_AS_NODE, no NODE_OPTIONS, the pinned system PATH and WS_NO_BUFFER_UTIL=1")
  func environmentContract() throws {
    let scratch = try Scratch()
    defer { scratch.remove() }
    let saved = Dispositions(Self.touched)
    defer { saved.restore() }
    let env = scratch.path("env")
    let argv = scratch.path("argv")
    let exe = try Self.fakeBundle(scratch, node: #"""
      printf '%s\n' "${WEMESSAGE_HOST-unset}" "${ELECTRON_RUN_AS_NODE-unset}" "${WEMESSAGE_HOST_PID-unset}" "${WEMESSAGE_HOST_VERSION-unset}" "${HOME-unset}" "${PATH-unset}" "${NODE_OPTIONS-unset}" "${WS_NO_BUFFER_UTIL-unset}" > '\#(env)'
      printf '%s\n' "$0" "$@" > '\#(argv)'
      exit 0
      """#)
    // v2 S2c.1: a hostile PATH and NODE_OPTIONS in the host's environment
    // never reach node.
    let parent = [
      "PATH": "/tmp/evil:" + Self.path,
      "HOME": "/nonexistent-home",
      "ELECTRON_RUN_AS_NODE": "1",
      "WEMESSAGE_HOST": "electron",
      "NODE_OPTIONS": "--require /tmp/evil.js",
    ]
    let lines = Lines()
    let code = DaemonHost.run(argv: ["x", "--daemon"], environment: parent, executable: exe, options: Self.options(lines))
    #expect(code == 0)
    let version = HostVersion.current()
    #expect(!version.isEmpty)
    let expected = [
      "swift", "unset", String(getpid()), version, "/nonexistent-home", "/usr/bin:/bin:/usr/sbin:/sbin", "unset", "1",
    ]
    #expect(scratch.read("env") == expected.map { $0 + "\n" }.joined())
    let node = scratch.path(Self.daemonDir + "node")
    let main = scratch.path(Self.daemonDir + "main.mjs")
    #expect(scratch.read("argv") == node + "\n" + main + "\n")
    #expect(lines.all == [])
  }

  @Test("row 11b: a bundle exe with WEMESSAGE_HOST_NODE and WEMESSAGE_HOST_MAIN pointing at a second stub runs the bundled node, never the override")
  func bundleIgnoresOverrides() throws {
    let scratch = try Scratch()
    defer { scratch.remove() }
    let saved = Dispositions(Self.touched)
    defer { saved.restore() }
    let ran = scratch.path("ran")
    let exe = try Self.fakeBundle(scratch, node: #"""
      printf '%s\n' bundled "$1" > '\#(ran)'
      exit 0
      """#)
    let override = try scratch.stub("override/node", #"""
      printf '%s\n' override "$1" > '\#(ran)'
      exit 5
      """#)
    let overrideMain = try scratch.write("override/main.mjs", "")
    let env = ["PATH": Self.path, "WEMESSAGE_HOST_NODE": override.path, "WEMESSAGE_HOST_MAIN": overrideMain.path]
    let lines = Lines()
    #expect(DaemonHost.run(argv: ["x", "--daemon"], environment: env, executable: exe, options: Self.options(lines)) == 0)
    #expect(scratch.read("ran") == "bundled\n" + scratch.path(Self.daemonDir + "main.mjs") + "\n")
    #expect(lines.all == [])
  }

  @Test("row 12: a stub node that exits 7 -> run returns 7")
  func mirrorsExitCode() throws {
    let scratch = try Scratch()
    defer { scratch.remove() }
    let saved = Dispositions(Self.touched)
    defer { saved.restore() }
    let node = try scratch.stub("node", "exit 7")
    let main = try scratch.write("main.mjs", "")
    let env = ["PATH": Self.path, "WEMESSAGE_HOST_NODE": node.path, "WEMESSAGE_HOST_MAIN": main.path]
    let lines = Lines()
    #expect(DaemonHost.run(argv: ["x", "--daemon"], environment: env, executable: Self.bare, options: Self.options(lines)) == 7)
    #expect(lines.all == [])
  }

  @Test("row 13: SIGTERM to the host while the stub sleeps -> the stub gets SIGTERM (its trap writes a marker, resets, re-raises) and run returns 143")
  func forwardsTerm() throws {
    let scratch = try Scratch()
    defer { scratch.remove() }
    let saved = Dispositions(Self.touched)
    defer { saved.restore() }
    signal(SIGTERM, SIG_IGN)
    try #require(Dispositions.isIgnored(SIGTERM))
    let trigger = SelfSignal()
    defer { trigger.stop() }
    let ready = scratch.path("ready")
    let gotTerm = scratch.path("got-term")
    // The forwarder is installed inside run() before node is spawned, and
    // the trigger fires only once node has written `ready`, so the host's
    // forwarder is in place before the test signals itself.
    let exe = try Self.fakeBundle(scratch, node: #"""
      on_term() {
        : > '\#(gotTerm)'
        kill "$sleeper"
        wait "$sleeper"
        trap - TERM
        kill -TERM $$
      }
      trap on_term TERM
      /bin/sleep 5 &
      sleeper=$!
      : > '\#(ready)'
      wait "$sleeper"
      exit 0
      """#)
    trigger.arm(when: ready)
    let lines = Lines()
    let code = DaemonHost.run(argv: ["x", "--daemon"], environment: ["PATH": Self.path], executable: exe, options: Self.options(lines))
    #expect(trigger.stop())
    #expect(code == 143)
    #expect(scratch.exists("got-term"))
    #expect(lines.all == [])
  }

  @Test("row 14: a stub that ignores SIGTERM is killed after the grace period (0.2 s here) and run returns 137")
  func escalatesToKill() throws {
    let scratch = try Scratch()
    defer { scratch.remove() }
    let saved = Dispositions(Self.touched)
    defer { saved.restore() }
    signal(SIGTERM, SIG_IGN)
    try #require(Dispositions.isIgnored(SIGTERM))
    let trigger = SelfSignal()
    defer { trigger.stop() }
    let ready = scratch.path("ready")
    // `trap '' TERM` survives the exec, so /bin/sleep ignores the forwarded
    // TERM and only the grace period's SIGKILL ends it.
    let exe = try Self.fakeBundle(scratch, node: #"""
      trap '' TERM
      : > '\#(ready)'
      exec /bin/sleep 5
      """#)
    trigger.arm(when: ready)
    let lines = Lines()
    let started = Date()
    let code = DaemonHost.run(
      argv: ["x", "--daemon"], environment: ["PATH": Self.path], executable: exe,
      options: Self.options(lines, grace: .milliseconds(200)))
    let elapsed = Date().timeIntervalSince(started)
    #expect(trigger.stop())
    #expect(code == 137)
    #expect(elapsed < 4, "run took \(elapsed) s; the stub alone sleeps 5 s")
    #expect(lines.all.count == 1)
    let line = try #require(lines.all.first)
    #expect(line.hasPrefix("wemessage-host: "))
    #expect(line.contains("SIGKILL"))
  }

  @Test("row 15: missing node -> 78 and one stderr line beginning 'wemessage-host:'; bad argv -> 64")
  func failures() throws {
    let scratch = try Scratch()
    defer { scratch.remove() }
    let saved = Dispositions(Self.touched)
    defer { saved.restore() }
    let exe = try Self.fakeBundle(scratch, node: nil)
    let env = ["PATH": Self.path]

    let missing = Lines()
    #expect(DaemonHost.run(argv: ["x", "--daemon"], environment: env, executable: exe, options: Self.options(missing)) == 78)
    #expect(missing.all.count == 1)
    #expect(missing.all.first?.hasPrefix("wemessage-host: ") == true)
    #expect(missing.all.first?.contains(scratch.path(Self.daemonDir + "node")) == true)

    let unbundled = Lines()
    #expect(DaemonHost.run(argv: ["x", "--daemon"], environment: env, executable: Self.bare, options: Self.options(unbundled)) == 78)
    #expect(unbundled.all.count == 1)
    #expect(unbundled.all.first?.hasPrefix("wemessage-host: ") == true)

    for argv in [["x", "--daemon", "extra"], ["x", "--window"], ["x"]] {
      let lines = Lines()
      #expect(DaemonHost.run(argv: argv, environment: env, executable: exe, options: Self.options(lines)) == 64, "\(argv)")
      #expect(lines.all.count == 1, "\(argv)")
      #expect(lines.all.first?.hasPrefix("wemessage-host: ") == true, "\(argv)")
    }
  }

  @Test("the forwarder sends nothing while no child is running: a TERM before spawn is held, never sent to pid 0, -1 or a group, reaches the child once it exists, and nothing is sent after the child is reaped")
  func noChildNoSignal() throws {
    let saved = Dispositions(Self.touched)
    defer { saved.restore() }
    let log = SignalLog()
    // Records instead of sending: no real signal leaves this test.
    let slot = ChildSlot(send: { pid, sig in
      log.add(pid, sig)
      return 0
    })
    let delivered = DispatchSemaphore(value: 0)
    let forwarder = SignalForwarder()
    forwarder.install { sig in
      slot.forward(sig)
      delivered.signal()
    }
    defer { forwarder.cancel() }
    try #require(Dispositions.isIgnored(SIGTERM))
    #expect(kill(getpid(), SIGTERM) == 0)
    #expect(delivered.wait(timeout: .now() + 5) == .success)
    #expect(log.all == [])

    #expect(slot.attach { 0 } == nil)
    #expect(slot.attach { -1 } == nil)
    #expect(slot.attach { nil } == nil)
    #expect(log.all == [])

    #expect(slot.attach { 4242 } == 4242)
    #expect(log.all == [SignalLog.Entry(pid: 4242, signal: SIGTERM)])

    slot.detach()
    #expect(!slot.forward(SIGTERM))
    #expect(!slot.forward(SIGKILL))
    #expect(log.all == [SignalLog.Entry(pid: 4242, signal: SIGTERM)])
  }

  @Test("install ignores TERM, INT and HUP, so the dispatch sources see them instead of the default action")
  func installIgnores() {
    let saved = Dispositions(Self.touched)
    defer { saved.restore() }
    #expect(SignalForwarder.forwarded == Self.touched)
    for sig in Self.touched { signal(sig, SIG_DFL) }
    let forwarder = SignalForwarder()
    forwarder.install { _ in }
    defer { forwarder.cancel() }
    for sig in Self.touched {
      #expect(Dispositions.isIgnored(sig), "signal \(sig)")
    }
  }
}
