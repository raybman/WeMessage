import Foundation
import Testing
import WeMessageKit

/// S7a (G2): the limit table is pinned here, so raising a limit in a UI test
/// without raising it in the table goes red; and the reducer keeps its p95
/// step under the limit over a thousand synthetic events.
@Suite("G2 perf")
struct G2PerfTests {
  @Test("G2-1: the limit table is the plan's numbers")
  func limits() {
    #expect(G2Limits.firstPaintMs == 300)
    #expect(G2Limits.mountedTranscriptRows == 120)
    #expect(G2Limits.reduceP95Ms == 50)
    #expect(G2Limits.reduceEvents == 1_000)
  }

  @Test("G2-2: a report line is six pipe fields, a soft row without a limit says -")
  func lineFormat() {
    #expect(G2Limits.line(metric: "first-paint", value: 212, unit: "ms", limit: 300, kind: .hard)
      == "G2|first-paint|212.00|ms|300|hard")
    #expect(G2Limits.line(metric: "rss", value: 88.25, unit: "MB", limit: nil, kind: .soft)
      == "G2|rss|88.25|MB|-|soft")
  }

  @Test("G2-3: the percentile is nearest-rank")
  func percentile() {
    let sample = (1...100).map(Double.init)
    #expect(G2Limits.percentile(sample, 95) == 95)
    #expect(G2Limits.percentile(sample, 100) == 100)
    #expect(G2Limits.percentile([7], 95) == 7)
    #expect(G2Limits.percentile([], 95) == 0)
  }

  /// Draft ids the synthetic queue holds.
  static let queueSize = 400

  static func queue() throws -> [DraftPayload] {
    let body = try Fixtures.response("drafts.list.pending").body
    guard case .array(let rows)? = body["drafts"], let first = rows.first else {
      Issue.record("drafts.list.pending has no drafts")
      return []
    }
    return try (0..<queueSize).map { n in
      let row = first.replacing("id", with: .string("g2-" + String(n)))
      return try JSONDecoder().decode(DraftPayload.self, from: row.canonicalData())
    }
  }

  /// A thousand events over the queue: every draft's state change the
  /// reducer moves a card for, plus inbound and connection frames it leaves
  /// alone. Decoded before the clock starts.
  static func events() throws -> [GatewayEvent] {
    let names = [
      "draft.approved", "draft.requeued", "message.received", "draft.rejected", "draft.requeued",
      "draft.sent", "connection.state", "draft.failed", "draft.requeued", "draft.expired",
    ]
    return try (0..<G2Limits.reduceEvents).map { n in
      try ReducerTests.event(names[n % names.count], draftId: "g2-" + String(n % queueSize))
    }
  }

  @Test("G2-4: 1,000 synthetic events reduce with a p95 step within the limit")
  func reduceP95() throws {
    let drafts = try Self.queue()
    #expect(drafts.count == Self.queueSize)
    let events = try Self.events()
    var (state, _) = AppReducer.reduce(AppState(), .frame(.snapshot(seq: 1, at: "t", missed: 0, drafts: drafts)))
    let clock = ContinuousClock()
    var steps: [Double] = []
    steps.reserveCapacity(events.count)
    for (n, event) in events.enumerated() {
      let start = clock.now
      let (next, _) = AppReducer.reduce(state, .frame(.event(seq: n + 2, event: event)))
      let took = clock.now - start
      steps.append(Double(took.components.seconds) * 1_000 + Double(took.components.attoseconds) / 1e15)
      state = next
    }
    #expect(steps.count == G2Limits.reduceEvents)
    #expect(state.lastSeq == G2Limits.reduceEvents + 1)
    let p95 = G2Limits.percentile(steps, 95)
    print(G2Limits.line(metric: "reduce-p95", value: p95, unit: "ms", limit: G2Limits.reduceP95Ms, kind: .hard))
    #expect(p95 <= Double(G2Limits.reduceP95Ms))
  }
}
