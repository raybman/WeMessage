import Foundation
import Testing
@testable import WeMessageKit

/// A scripted daemon for EventStream. Each connect takes the next step; an
/// exhausted script answers 401, so every run ends with down(token-rejected)
/// instead of hanging.
final class StreamScript: @unchecked Sendable {
  enum Ending: Sendable {
    case finish
    case fail(GatewayError)
    case stayOpen
  }

  enum Step: Sendable {
    case fail(GatewayError)
    /// A stream that yields `events` at once, then `duringResync` while the
    /// resync is in flight, then ends as `then` says.
    case events([GatewayEvent], duringResync: [GatewayEvent] = [], then: Ending = .finish)
  }

  typealias Continuation = AsyncThrowingStream<GatewayEvent, Error>.Continuation

  private let steps: LockedBox<[Step]>
  private let resyncFailures: LockedBox<[GatewayError]>
  private let pending = LockedBox<(Continuation, [GatewayEvent], Ending)?>(nil)
  private let open = LockedBox<[Continuation]>([])
  private let ticks = LockedBox(0)
  let sleeps = LockedBox<[Int]>([])
  let resyncs = LockedBox<[String?]>([])
  let connects = LockedBox(0)
  let cancelled = LockedBox(0)
  let drafts: [DraftPayload]

  init(_ steps: [Step], resyncFailures: [GatewayError] = []) throws {
    self.steps = LockedBox(steps)
    self.resyncFailures = LockedBox(resyncFailures)
    drafts = try EventStreamTests.pendingDrafts()
  }

  var dependencies: EventStream.Dependencies {
    EventStream.Dependencies(
      connect: { try self.connect() },
      resync: { since in try self.resync(since) },
      sleep: { ms in
        try Task.checkCancellation()
        self.sleeps.update { $0.append(ms) }
      },
      random: { 0.5 },
      now: { self.ticks.update { tick in tick += 1; return "t\(tick)" } }
    )
  }

  private func end(_ continuation: Continuation, _ ending: Ending) {
    switch ending {
    case .finish: continuation.finish()
    case .fail(let error): continuation.finish(throwing: error)
    case .stayOpen: open.update { $0.append(continuation) }
    }
  }

  private func connect() throws -> AsyncThrowingStream<GatewayEvent, Error> {
    connects.update { $0 += 1 }
    let next = steps.update { $0.isEmpty ? nil : $0.removeFirst() }
    guard let next else { throw GatewayError.unauthorized }
    switch next {
    case .fail(let error):
      throw error
    case .events(let events, let during, let ending):
      let (stream, continuation) = AsyncThrowingStream<GatewayEvent, Error>.makeStream()
      let cancelled = self.cancelled
      continuation.onTermination = { termination in
        if case .cancelled = termination { cancelled.update { $0 += 1 } }
      }
      for event in events { continuation.yield(event) }
      if during.isEmpty {
        end(continuation, ending)
      } else {
        pending.set((continuation, during, ending))
      }
      return stream
    }
  }

  private func resync(_ since: String?) throws -> Resync.Snapshot {
    resyncs.update { $0.append(since) }
    if let (continuation, during, ending) = pending.get() {
      pending.set(nil)
      for event in during { continuation.yield(event) }
      end(continuation, ending)
    }
    if let failure = resyncFailures.update({ $0.isEmpty ? nil : $0.removeFirst() }) { throw failure }
    return Resync.Snapshot(missed: since == nil ? 0 : 3, drafts: drafts)
  }
}

/// R7: the reconnect ladder and resync, ported from the Electron main
/// process's createEventStream (apps/desktop/src/main/event-stream.ts).
@Suite("EventStream", .timeLimit(.minutes(1)))
struct EventStreamTests {
  static let greeting = GatewayEvent.connectionState(ConnectionStateEvent(state: "fully-connected"))

  static func event(_ name: String) throws -> GatewayEvent {
    try GatewayEvent.decode(name: name, data: Fixtures.event(name).canonicalData())
  }

  static func pendingDrafts() throws -> [DraftPayload] {
    let body = try Fixtures.response("drafts.list.pending").body
    let list = try #require(body["drafts"])
    return try JSONDecoder().decode([DraftPayload].self, from: list.canonicalData())
  }

  static func collect(_ stream: EventStream) async -> [AppAction] {
    var out: [AppAction] = []
    for await action in stream.run() { out.append(action) }
    return out
  }

  static func statuses(_ actions: [AppAction]) -> [StreamStatus] {
    actions.compactMap { action in
      if case .status(let status) = action { return status }
      return nil
    }
  }

  static func frames(_ actions: [AppAction]) -> [StreamFrame] {
    actions.compactMap { action in
      if case .frame(let frame) = action { return frame }
      return nil
    }
  }

  /// Polls `condition` for up to two seconds.
  static func eventually(_ condition: () -> Bool) async -> Bool {
    for _ in 0..<200 {
      if condition() { return true }
      try? await Task.sleep(nanoseconds: 10_000_000)
    }
    return condition()
  }

  @Test("first frame connection.state is consumed, not forwarded")
  func greetingConsumed() async throws {
    let sent = try Self.event("draft.sent")
    let script = try StreamScript([.events([Self.greeting, sent, Self.greeting])])
    let actions = await Self.collect(EventStream(script.dependencies))
    #expect(
      actions == [
        .status(.connected),
        .frame(.snapshot(seq: 1, at: "t1", missed: 0, drafts: script.drafts)),
        .frame(.event(seq: 2, event: sent)),
        .frame(.event(seq: 3, event: Self.greeting)),
        .status(.reconnecting(attempt: 1)),
        .status(.down(reason: "token-rejected")),
      ], "only the FIRST connection.state is the greeting; a later one is a fact about Messages")
  }

  @Test("frames buffer until the snapshot, then flush in order")
  func bufferThenFlush() async throws {
    let approved = try Self.event("draft.approved")
    let sent = try Self.event("draft.sent")
    let expired = try Self.event("draft.expired")
    let requeued = try Self.event("draft.requeued")

    // A first event that is not the greeting is buffered, never dropped, and
    // events that land while the resync is in flight wait behind the snapshot.
    let script = try StreamScript([.events([approved, sent], duringResync: [expired, requeued])])
    let frames = Self.frames(await Self.collect(EventStream(script.dependencies)))
    #expect(
      frames == [
        .snapshot(seq: 1, at: "t1", missed: 0, drafts: script.drafts),
        .event(seq: 2, event: approved),
        .event(seq: 3, event: sent),
        .event(seq: 4, event: expired),
        .event(seq: 5, event: requeued),
      ])

    let greeted = try StreamScript([.events([Self.greeting, approved], duringResync: [sent])])
    let greetedFrames = Self.frames(await Self.collect(EventStream(greeted.dependencies)))
    #expect(greetedFrames.map(\.seq) == [1, 2, 3])
    #expect(greetedFrames.first == .snapshot(seq: 1, at: "t1", missed: 0, drafts: greeted.drafts))
  }

  @Test("resync = listAudit(since, limit 1000) then listDrafts, missed = count, since nil -> missed 0")
  func resync() async throws {
    #expect(Resync.plan(since: nil) == [.listDrafts])
    #expect(Resync.plan(since: "t2") == [.listAudit(since: "t2", limit: 1000), .listDrafts])
    #expect(Backoff.auditGapLimit == 1000)

    let rows = try #require(Fixtures.response("audit.list").body.arrayValue).count
    #expect(rows > 0)
    let transport = FakeTransport { request, _ in
      request.url?.path == "/v1/audit" ? try Reply.response("audit.list") : try Reply.response("drafts.list.pending")
    }
    let client = GatewayClient.testing(transport)

    let first = try await Resync.run(since: nil, client: client)
    #expect(first == Resync.Snapshot(missed: 0, drafts: try Self.pendingDrafts()))
    #expect(transport.requests.map { $0.url?.path } == ["/v1/drafts"], "since nil reads no audit rows")

    let since = "2026-09-01T12:00:00.000Z"
    let gap = try await Resync.run(since: since, client: client)
    #expect(gap.missed == rows)
    let urls = transport.requests.dropFirst().map { $0.url?.absoluteString ?? "" }
    #expect(
      urls == [
        "http://127.0.0.1:47100/v1/audit?since=2026-09-01T12%3A00%3A00.000Z&limit=1000",
        "http://127.0.0.1:47100/v1/drafts",
      ], "the gap is closed before the snapshot is taken")

    // The stream asks with the DROP instant: nil first, then the clock tick
    // taken when the previous socket ended.
    let script = try StreamScript([.events([Self.greeting]), .events([Self.greeting])])
    let frames = Self.frames(await Self.collect(EventStream(script.dependencies)))
    #expect(script.resyncs.get() == [nil, "t2"])
    #expect(
      frames == [
        .snapshot(seq: 1, at: "t1", missed: 0, drafts: script.drafts),
        .snapshot(seq: 2, at: "t3", missed: 3, drafts: script.drafts),
      ])
  }

  @Test("tokenRejected and streamRefused stop the ladder; anything else retries with Backoff")
  func verdicts() async throws {
    let stops: [(GatewayError, String)] = [
      (.unauthorized, "token-rejected"),
      (.noAuthToken, "token-rejected"),
      (.forbidden(body: ["error": "bad-origin"]), "token-rejected"),
      (.streamRefused(name: "nope"), "stream-refused"),
    ]
    for (error, reason) in stops {
      #expect(EventStream.verdict(for: error) == .stop(reason: reason), "\(error)")
    }
    let retries: [(any Error)?] = [
      nil,
      GatewayError.transport(URLError(.networkConnectionLost)),
      GatewayError.request(status: 500, body: .null),
      GatewayError.decoding(path: "content-type", underlying: "application/json"),
      GatewayError.notFound,
      GatewayError.sourceUnavailable,
      URLError(.timedOut),
    ]
    for error in retries {
      #expect(EventStream.verdict(for: error) == .retry, "\(String(describing: error))")
    }

    let refused = try StreamScript([.fail(.streamRefused(name: "nope"))])
    #expect(await Self.collect(EventStream(refused.dependencies)) == [.status(.down(reason: "stream-refused"))])
    #expect(refused.sleeps.get().isEmpty)
    #expect(refused.connects.get() == 1)

    let flaky = try StreamScript([
      .fail(.transport(URLError(.cannotConnectToHost))),
      .fail(.request(status: 500, body: .null)),
      .fail(.decoding(path: "content-type", underlying: "application/json")),
      .fail(.notFound),
      .fail(.request(status: 502, body: "Bad Gateway")),
      .fail(.transport(URLError(.networkConnectionLost))),
    ])
    let actions = await Self.collect(EventStream(flaky.dependencies))
    #expect(Self.statuses(actions) == (1...6).map { .reconnecting(attempt: $0) } + [.down(reason: "token-rejected")])
    #expect(flaky.sleeps.get() == (1...6).map { Backoff.delay(attempt: $0, roll: 0.5) })
    #expect(flaky.sleeps.get() == [500, 1000, 2000, 4000, 8000, 8000])
  }

  @Test(
    "a 503 no-auth-token stops as token-rejected, any other 503 retries [diverges from TS: DaemonAuthError(503) stops on every 503 but source-unavailable]"
  )
  func unavailable() async throws {
    #expect(EventStream.verdict(for: GatewayError.noAuthToken) == .stop(reason: "token-rejected"))
    #expect(EventStream.verdict(for: GatewayError.request(status: 503, body: ["error": "warming-up"])) == .retry)
    let script = try StreamScript([.fail(.request(status: 503, body: ["error": "warming-up"])), .fail(.noAuthToken)])
    let actions = await Self.collect(EventStream(script.dependencies))
    #expect(actions == [.status(.reconnecting(attempt: 1)), .status(.down(reason: "token-rejected"))])
    #expect(script.sleeps.get() == [500])
  }

  @Test("status sequence connected -> reconnecting(attempt) -> down(reason)")
  func statusSequence() async throws {
    let script = try StreamScript([
      .events([Self.greeting]),
      .fail(.transport(URLError(.networkConnectionLost))),
      .fail(.transport(URLError(.cannotConnectToHost))),
      .fail(.unauthorized),
    ])
    let actions = await Self.collect(EventStream(script.dependencies))
    #expect(
      Self.statuses(actions) == [
        .connected, .reconnecting(attempt: 1), .reconnecting(attempt: 2), .reconnecting(attempt: 3),
        .down(reason: "token-rejected"),
      ])
    #expect(script.sleeps.get() == [500, 1000, 2000])

    // A snapshot resets the ladder: the next drop starts again at rung one.
    let reset = try StreamScript([
      .events([Self.greeting]),
      .fail(.transport(URLError(.networkConnectionLost))),
      .events([Self.greeting], then: .fail(.transport(URLError(.networkConnectionLost)))),
    ])
    let again = await Self.collect(EventStream(reset.dependencies))
    #expect(
      Self.statuses(again) == [
        .connected, .reconnecting(attempt: 1), .reconnecting(attempt: 2), .connected, .reconnecting(attempt: 1),
        .down(reason: "token-rejected"),
      ])
    #expect(reset.sleeps.get() == [500, 1000, 500])
  }

  @Test("a resync that fails is a failed attempt: no snapshot, nothing forwarded, the socket is dropped")
  func resyncFailure() async throws {
    let sent = try Self.event("draft.sent")
    let script = try StreamScript(
      [.events([Self.greeting, sent], then: .stayOpen)],
      resyncFailures: [.transport(URLError(.timedOut))])
    let actions = await Self.collect(EventStream(script.dependencies))
    #expect(actions == [.status(.connected), .status(.reconnecting(attempt: 1)), .status(.down(reason: "token-rejected"))])
    #expect(await Self.eventually { script.cancelled.get() == 1 }, "the half-open stream was never released")
  }

  @Test("cancelling the consumer cancels the underlying stream task (onTermination)")
  func cancellation() async throws {
    let script = try StreamScript([.events([Self.greeting], then: .stayOpen)])
    let stream = EventStream(script.dependencies)
    let seen = LockedBox<[AppAction]>([])
    let consumer = Task {
      for await action in stream.run() { seen.update { $0.append(action) } }
    }
    #expect(await Self.eventually { seen.get().count == 2 }, "connected and the snapshot never arrived")
    consumer.cancel()
    #expect(await Self.eventually { script.cancelled.get() == 1 }, "the daemon stream outlived its consumer")
    await consumer.value
    #expect(script.connects.get() == 1, "a cancelled consumer must not reconnect")
    #expect(script.sleeps.get().isEmpty)
  }

  @Test("live(client:) drives GatewayClient.gatewayEvents and Resync.run over one transport")
  func live() async throws {
    let body = try Fixtures.sse("greeting") + Fixtures.sse("draft.sent")
    let transport = FakeTransport { request, _ in
      switch request.url?.path {
      case "/v1/events/sse": return Reply.sse(body)
      case "/v1/drafts": return try Reply.response("drafts.list.pending")
      default: return try Reply.error("401.unauthorized")
      }
    }
    let stream = EventStream.live(client: GatewayClient.testing(transport), sleep: { _ in })
    var actions: [AppAction] = []
    for await action in stream.run() {
      actions.append(action)
      if actions.count == 3 { break }
    }
    #expect(actions.first == .status(.connected))
    guard actions.count == 3, case .frame(.snapshot(1, _, 0, let drafts)) = actions[1] else {
      Issue.record("want connected, snapshot, event: \(actions)")
      return
    }
    #expect(drafts == (try Self.pendingDrafts()))
    #expect(actions[2] == .frame(.event(seq: 2, event: try Self.event("draft.sent"))))
  }
}

extension StreamFrame {
  var seq: Int {
    switch self {
    case .event(let seq, _), .snapshot(let seq, _, _, _): return seq
    }
  }
}
