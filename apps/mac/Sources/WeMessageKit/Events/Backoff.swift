import Foundation

/// The reconnect ladder, ported from the Electron main process
/// (apps/desktop/src/main/event-stream.ts) and pinned by
/// fixtures/contract/wire.json: 500, 1000, 2000, 4000, then 8000 ms for every
/// later attempt, each scaled by up to 20 percent either way and rounded half
/// up, the way Math.round does.
public enum Backoff {
  public static let steps: [Int] = [500, 1000, 2000, 4000, 8000]
  public static let jitter: Double = 0.2
  /// The most audit rows a resync reads to count what a gap missed.
  public static let auditGapLimit = 1000

  /// The wait before reconnect attempt `attempt`, in milliseconds. `roll` is
  /// a uniform draw from 0..<1: 0.5 is the bare rung, 0 the shortest wait,
  /// 1 the longest. Attempts below 1 wait like the first; attempts past the
  /// ladder wait like the last.
  public static func delay(attempt: Int, roll: Double) -> Int {
    let rung = min(max(attempt, 1), steps.count)
    let base = Double(steps[rung - 1])
    let scaled = base * (1 + jitter * (2 * roll - 1))
    return Int((scaled + 0.5).rounded(.down))
  }
}
