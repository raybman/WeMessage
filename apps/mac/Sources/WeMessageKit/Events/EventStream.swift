import Foundation

/// The daemon's event stream as a sequence of AppActions, ported from the
/// Electron main process's createEventStream
/// (apps/desktop/src/main/event-stream.ts).
///
/// Each connection runs the same session: the first frame arrives (a
/// connection.state first frame is the daemon's greeting and is consumed;
/// any other first frame is held, never dropped), `.status(.connected)` is
/// sent, then a resync reads what the app may have missed and is sent as a
/// snapshot frame, then the held frame and every later one follow in order.
/// When a session ends, `verdict(for:)` decides: a rejected token or a
/// refused stream sends `.status(.down(reason:))` and stops; anything else
/// sends `.status(.reconnecting(attempt:))`, waits `Backoff.delay`, and
/// connects again. A snapshot resets the ladder to its first rung.
///
/// Sequence numbers count every frame of one `run()`, across reconnects.
public struct EventStream: Sendable {
  /// Everything the stream touches, injectable so the ladder can be driven
  /// without a daemon or a clock.
  public struct Dependencies: Sendable {
    public var connect: @Sendable () async throws -> AsyncThrowingStream<GatewayEvent, any Error>
    public var resync: @Sendable (String?) async throws -> Resync.Snapshot
    public var sleep: @Sendable (Int) async throws -> Void
    public var random: @Sendable () -> Double
    public var now: @Sendable () -> String

    public init(
      connect: @escaping @Sendable () async throws -> AsyncThrowingStream<GatewayEvent, any Error>,
      resync: @escaping @Sendable (String?) async throws -> Resync.Snapshot,
      sleep: @escaping @Sendable (Int) async throws -> Void,
      random: @escaping @Sendable () -> Double,
      now: @escaping @Sendable () -> String
    ) {
      self.connect = connect
      self.resync = resync
      self.sleep = sleep
      self.random = random
      self.now = now
    }
  }

  /// What happens after a session ends.
  public enum Verdict: Equatable, Sendable {
    case retry
    case stop(reason: String)
  }

  public let dependencies: Dependencies

  public init(_ dependencies: Dependencies) {
    self.dependencies = dependencies
  }

  /// A stream over a live daemon: events from `client.gatewayEvents`, resync
  /// through `Resync.run`, a real clock and a real random roll.
  public static func live(
    client: GatewayClient,
    filter: [EventName]? = nil,
    sleep: @escaping @Sendable (Int) async throws -> Void = { milliseconds in
      try await Task.sleep(for: .milliseconds(milliseconds))
    }
  ) -> EventStream {
    EventStream(
      Dependencies(
        connect: { client.gatewayEvents(filter: filter) },
        resync: { since in try await Resync.run(since: since, client: client) },
        sleep: sleep,
        random: { Double.random(in: 0..<1) },
        now: { Date().formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true)) }
      ))
  }

  /// A rejected or missing token stops as "token-rejected" and a refused
  /// stream as "stream-refused"; a clean end, any other GatewayError, and
  /// any error that is not a GatewayError retry.
  public static func verdict(for error: (any Error)?) -> Verdict {
    guard let error = error as? GatewayError else { return .retry }
    switch error {
    case .unauthorized, .noAuthToken, .forbidden:
      return .stop(reason: "token-rejected")
    case .streamRefused:
      return .stop(reason: "stream-refused")
    default:
      return .retry
    }
  }

  /// Runs the stream until a stop verdict or until the consumer goes away.
  /// Ending the iteration, or cancelling the task that iterates, cancels the
  /// task that drives the daemon stream.
  public func run() -> AsyncStream<AppAction> {
    let (actions, continuation) = AsyncStream<AppAction>.makeStream()
    let dependencies = self.dependencies
    let task = Task {
      await Self.drive(dependencies, continuation)
      continuation.finish()
    }
    continuation.onTermination = { _ in task.cancel() }
    return actions
  }

  private static func drive(_ deps: Dependencies, _ out: AsyncStream<AppAction>.Continuation) async {
    var since: String?
    var attempt = 0
    var seq = 0
    while true {
      var synced = false
      var failure: (any Error)?
      do {
        try await session(deps, out, since: since, seq: &seq, attempt: &attempt, synced: &synced)
      } catch {
        failure = error
      }
      // The gap the next resync closes starts when a synced socket drops.
      if synced { since = deps.now() }
      if Task.isCancelled { return }
      switch verdict(for: failure) {
      case .stop(let reason):
        out.yield(.status(.down(reason: reason)))
        return
      case .retry:
        attempt += 1
        out.yield(.status(.reconnecting(attempt: attempt)))
        do {
          try await deps.sleep(Backoff.delay(attempt: attempt, roll: deps.random()))
        } catch {
          return
        }
      }
    }
  }

  /// One connection. The daemon stream and its iterator live only here, so
  /// when a session ends, however it ends, the stream is released and its
  /// producer sees the termination.
  private static func session(
    _ deps: Dependencies,
    _ out: AsyncStream<AppAction>.Continuation,
    since: String?,
    seq: inout Int,
    attempt: inout Int,
    synced: inout Bool
  ) async throws {
    let events = try await deps.connect()
    var iterator = events.makeAsyncIterator()
    guard let first = try await iterator.next() else { return }
    var held: GatewayEvent? = first
    if case .connectionState = first { held = nil }
    out.yield(.status(.connected))
    let at = deps.now()
    let snapshot = try await deps.resync(since)
    if Task.isCancelled { return }
    seq += 1
    out.yield(.frame(.snapshot(seq: seq, at: at, missed: snapshot.missed, drafts: snapshot.drafts)))
    synced = true
    attempt = 0
    if let held {
      seq += 1
      out.yield(.frame(.event(seq: seq, event: held)))
    }
    while let event = try await iterator.next() {
      seq += 1
      out.yield(.frame(.event(seq: seq, event: event)))
    }
  }
}
