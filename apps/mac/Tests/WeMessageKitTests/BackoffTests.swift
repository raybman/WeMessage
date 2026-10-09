import Foundation
import Testing
@testable import WeMessageKit

/// R4: the reconnect ladder, ported from the v1 desktop app's backoffFor
/// (deleted in v2 S6c) and pinned to wire.json.
@Suite("Backoff")
struct BackoffTests {
  @Test("delay(attempt:roll:) == wire.json steps with jitter 0.2 at roll 0, 0.5, 1 for attempts 0...7")
  func ladder() throws {
    let backoff = try #require(Fixtures.wire()["backoff"])
    let steps = try #require(backoff["steps"]?.arrayValue).compactMap(\.intValue)
    let jitter = try #require(backoff["jitter"]?.doubleValue)
    #expect(steps.count == 5)
    #expect(jitter == 0.2)
    for attempt in 0...7 {
      let base = Double(steps[min(max(attempt, 1), steps.count) - 1])
      for roll in [0.0, 0.5, 1.0] {
        let want = Int((base * (1 + jitter * (2 * roll - 1)) + 0.5).rounded(.down))
        #expect(Backoff.delay(attempt: attempt, roll: roll) == want, "attempt \(attempt) roll \(roll)")
      }
    }
    // Literal anchors, so a wrong wire.json cannot pass by agreeing with itself.
    #expect(Backoff.delay(attempt: 1, roll: 0) == 400)
    #expect(Backoff.delay(attempt: 3, roll: 0.5) == 2000)
    #expect(Backoff.delay(attempt: 5, roll: 1) == 9600)
    #expect(Backoff.delay(attempt: 0, roll: 0.5) == 500)
  }

  @Test("attempt beyond the ladder clamps to the last rung")
  func clamp() {
    for attempt in [5, 6, 50, 1_000_000] {
      #expect(Backoff.delay(attempt: attempt, roll: 0.5) == 8000, "attempt \(attempt)")
    }
    #expect(Backoff.delay(attempt: 6, roll: 0) == 6400)
    #expect(Backoff.delay(attempt: Int.max, roll: 1) == 9600)
    #expect(Backoff.delay(attempt: -3, roll: 0.5) == 500)
  }
}
