import Foundation
import Testing
import WeMessageDaemonHost

/// Rows 7, 8 and 10, plus the spawn contract around them. Row 9 changes a
/// signal disposition, so it lives in the serialized DaemonHost suite. Every
/// child here is /bin/sh running a stub this test wrote into its own Scratch
/// directory, and every child is reaped before the test returns.
@Suite("Spawner")
struct SpawnerTests {
  static let env = ["PATH": "/usr/bin:/bin"]

  static func request(_ stub: URL, _ arguments: [String] = [], env: [String: String] = env) -> SpawnRequest {
    SpawnRequest(executable: stub, arguments: arguments, environment: env)
  }

  @Test("row 7: spawn a stub that runs 'exit 7' -> wait decodes .exited(7)")
  func exitStatus() throws {
    let scratch = try Scratch()
    defer { scratch.remove() }
    let stub = try scratch.stub("exit7", "exit 7")
    let pid = try Spawner.spawn(Self.request(stub)).get()
    #expect(pid > 0)
    #expect(ExitStatus.decode(Spawner.wait(pid: pid)) == .exited(7))
  }

  @Test("row 8: the child's fd 0 is /dev/null, so a stub running 'read x && exit 3; exit 0' exits 0 at once")
  func stdinIsDevNull() throws {
    let scratch = try Scratch()
    defer { scratch.remove() }
    // The first line makes the row independent of this process's own fd 0:
    // a closed or inherited stdin fails it even when that stdin is empty.
    let stub = try scratch.stub("stdin", """
      test /dev/fd/0 -ef /dev/null || exit 4
      read x && exit 3
      exit 0
      """)
    let pid = try Spawner.spawn(Self.request(stub)).get()
    let status = try #require(Reap.child(pid))
    #expect(ExitStatus.decode(status) == .exited(0))
  }

  @Test("row 10: a stray fd the test opened is not inherited (a stub running 'test -e /dev/fd/<n>' exits 1)")
  func strayFdNotInherited() throws {
    let scratch = try Scratch()
    defer { scratch.remove() }
    let raw = open("/dev/null", O_RDONLY)
    try #require(raw >= 0)
    defer { close(raw) }
    // Moved to 64 or above so none of the shell's own descriptors can land
    // on the same number. F_DUPFD leaves FD_CLOEXEC clear, so only the spawn
    // attributes can keep this descriptor out of the child.
    let stray = fcntl(raw, F_DUPFD, 64)
    try #require(stray >= 64)
    defer { close(stray) }
    try #require(fcntl(stray, F_GETFD) & FD_CLOEXEC == 0)
    let stub = try scratch.stub("stray", "test -e /dev/fd/\(stray)")
    let pid = try Spawner.spawn(Self.request(stub)).get()
    let status = try #require(Reap.child(pid))
    #expect(ExitStatus.decode(status) == .exited(1))
  }

  @Test("the child runs the requested executable with the request's arguments in order and exactly the request's environment")
  func argumentsAndEnvironment() throws {
    let scratch = try Scratch()
    defer { scratch.remove() }
    let out = scratch.path("out")
    let stub = try scratch.stub("probe", """
      printf '%s\\n' "$0" "$@" "${HOME-unset}" "${WEMESSAGE_PROBE-unset}" > '\(out)'
      """)
    let env = ["PATH": "/usr/bin:/bin", "WEMESSAGE_PROBE": "a b=c"]
    let pid = try Spawner.spawn(Self.request(stub, ["first arg", "--second"], env: env)).get()
    let status = try #require(Reap.child(pid))
    #expect(ExitStatus.decode(status) == .exited(0))
    // HOME is set in this process and absent from the request, so "unset"
    // proves the child's environment is the request's and not inherited.
    #expect(scratch.read("out") == [stub.path, "first arg", "--second", "unset", "a b=c"].map { $0 + "\n" }.joined())
  }

  @Test("a missing executable is .posixSpawn(errno: ENOENT)")
  func missingExecutable() throws {
    let scratch = try Scratch()
    defer { scratch.remove() }
    let result = Spawner.spawn(Self.request(scratch.url("absent")))
    if case .success(let pid) = result { _ = Reap.child(pid) }
    #expect(result == .failure(.posixSpawn(errno: ENOENT)))
  }

  @Test("wait refuses pid 0 and negative pids (no wait on a group), reading as exit 70")
  func waitRefusesGroups() {
    #expect(ExitStatus.decode(Spawner.wait(pid: 0)) == .exited(70))
    #expect(ExitStatus.decode(Spawner.wait(pid: -1)) == .exited(70))
  }
}
