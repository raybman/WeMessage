import Foundation
import Testing
import WeMessageDaemonHost

/// Row 6: a raw wait status becomes the host's own exit code, by the shell's
/// convention, so launchd's LastExitStatus reads like node's.
@Suite("ExitStatus")
struct ExitStatusTests {
  @Test("row 6: decode(0x0700) == .exited(7); decode(15) == .signaled(15); .signaled(15).processExitCode == 143")
  func decode() {
    #expect(ExitStatus.decode(0x0700) == .exited(7))
    #expect(ExitStatus.decode(15) == .signaled(15))
    #expect(ExitStatus.signaled(15).processExitCode == 143)

    #expect(ExitStatus.decode(0) == .exited(0))
    #expect(ExitStatus.decode(0xff00) == .exited(255))
    #expect(ExitStatus.decode(9) == .signaled(9))
    #expect(ExitStatus.decode(9).processExitCode == 137)
    // The core-dump bit (0x80) does not change the signal.
    #expect(ExitStatus.decode(0x80 | 6) == .signaled(6))
    #expect(ExitStatus.exited(7).processExitCode == 7)
    #expect(ExitStatus.exited(0).processExitCode == 0)
  }

  @Test("the host's own exit codes are sysexits: usage 64, software 70, config 78")
  func sysexits() {
    #expect(ExitStatus.usage == 64)
    #expect(ExitStatus.software == 70)
    #expect(ExitStatus.config == 78)
  }
}
