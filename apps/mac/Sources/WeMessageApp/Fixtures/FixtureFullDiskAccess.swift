import Foundation

// v2 S4h, boards 10.C and 12.B: the Full Disk Access seam under the UI-test
// flag. Nothing here opens System Settings; an ask is a count the window
// publishes, so the UI test can prove the button reached the seam. The
// onboarding poll's probe is fixture-driven: it grants on the
// grantAfter-th probe, and never before Open System Settings was asked.

/// The fixture seam: the fake daemon's scenario is the probe for 10.C, a
/// count is the probe for 12.B, and the ask is a count.
@MainActor
public final class FixtureFullDiskAccess: FullDiskAccessSeam {
  public private(set) var asked = 0
  public private(set) var probes = 0
  /// The probe that grants, counted from 1.
  public let grantAfter: Int

  public init(grantAfter: Int = 2) { self.grantAfter = grantAfter }

  public func state(sourceUnavailable: Bool, lastReadable: Date?) -> FDAState {
    FDAState.fold(sourceUnavailable: sourceUnavailable, lastReadable: lastReadable)
  }
  public func openSettings() { asked += 1 }

  public func probe() async -> Bool {
    probes += 1
    return asked > 0 && probes >= grantAfter
  }

  /// 12.B's count, the wireframe's figures.
  public func sizing() async -> CopySizing? {
    CopySizing(messages: 527_147, chats: 3_953, megabytes: 178, historyFrom: "2017-02-24")
  }

  /// 12.B's CopyProgress, dated 2026-09-01 19:31:04 in the runner's zone.
  public func copyProgress() async -> CopyProgressFacts? {
    CopyProgressFacts(left: 214_239, copied: 312_908, asOf: Date(timeIntervalSince1970: 1_756_755_064))
  }
}
