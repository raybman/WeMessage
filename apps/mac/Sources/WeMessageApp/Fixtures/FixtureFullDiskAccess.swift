import Foundation

// v2 S4h, board 10.C: the Full Disk Access seam under the UI-test flag.
// Nothing here opens System Settings; an ask is a count the window
// publishes, so the UI test can prove the button reached the seam.

/// The fixture seam: the fake daemon's scenario is the probe, and the ask
/// is a count.
@MainActor
public final class FixtureFullDiskAccess: FullDiskAccessSeam {
  public private(set) var asked = 0
  public init() {}
  public func state(sourceUnavailable: Bool, lastReadable: Date?) -> FDAState {
    FDAState.fold(sourceUnavailable: sourceUnavailable, lastReadable: lastReadable)
  }
  public func openSettings() { asked += 1 }
}
