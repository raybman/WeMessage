import Foundation
import Testing
import WeMessageKit

@testable import WeMessageApp

/// A clock the test turns by hand: each `sleep` waits until `tick()`.
/// Cancelling the sleeping task ends its sleep with CancellationError.
final class ManualSleep: @unchecked Sendable {
  private let lock = NSLock()
  private var waiting: [UUID: CheckedContinuation<Void, any Error>] = [:]

  var sleepers: Int { lock.withLock { waiting.count } }

  func sleep(_: Duration) async throws {
    let id = UUID()
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
        let cancelled = lock.withLock { () -> Bool in
          if Task.isCancelled { return true }
          waiting[id] = continuation
          return false
        }
        if cancelled { continuation.resume(throwing: CancellationError()) }
      }
    } onCancel: {
      let continuation = lock.withLock { waiting.removeValue(forKey: id) }
      continuation?.resume(throwing: CancellationError())
    }
  }

  /// Wakes every sleeper.
  func tick() {
    let all = lock.withLock { () -> [CheckedContinuation<Void, any Error>] in
      defer { waiting.removeAll() }
      return Array(waiting.values)
    }
    for continuation in all { continuation.resume() }
  }
}

/// Polls `condition` on the main actor for up to two seconds.
@MainActor
func eventually(_ condition: () -> Bool) async -> Bool {
  for _ in 0..<400 {
    if condition() { return true }
    try? await Task.sleep(for: .milliseconds(5))
  }
  return condition()
}

/// Plan 2.2 and 14.F: the one send funnel. Nothing reaches the daemon
/// without a gesture that is not bare Return, an undo window that ran out,
/// and a kill switch that is off both when the human acts and when the
/// request would go.
@Suite("Outbound")
@MainActor
struct OutboundTests {
  final class Kill: @unchecked Sendable {
    var on: Bool? = false
  }

  static let daniel = Outbound.Intent.send(chatGuid: "iMessage;-;+15550100002", handle: "+15550100002", body: "on my way")

  static func sends(_ transport: FakeTransport) -> [URLRequest] {
    transport.requests.filter { $0.url?.path == "/v1/send" }
  }

  static func make(_ reply: @escaping @Sendable (URLRequest) throws -> Reply, kill: Kill = Kill())
    -> (Outbound, FakeTransport, ManualSleep)
  {
    let transport = FakeTransport(reply)
    let clock = ManualSleep()
    let outbound = Outbound(client: testClient(transport), killSwitch: { kill.on }, sleep: { try await clock.sleep($0) })
    return (outbound, transport, clock)
  }

  /// Advances the window one second and waits for the funnel to see it.
  static func second(_ clock: ManualSleep) async {
    _ = await eventually { clock.sleepers == 1 }
    clock.tick()
  }

  @Test("S4 02.I: cmd-Return writes the undo entry at once and sends nothing for 4 s; then one POST /v1/send, and the 409 shows as parked")
  func nothingInsideTheWindow() async throws {
    let (outbound, transport, clock) = Self.make { _ in try Reply.golden("errors/409.parked.json") }
    #expect(outbound.perform(Self.daniel, gesture: .commandReturn) == nil)
    // The entry exists before any request could.
    #expect(outbound.entries.map(\.phase) == [.counting(remaining: 4)])
    #expect(transport.requests.isEmpty)
    for remaining in [3, 2, 1] {
      await Self.second(clock)
      #expect(await eventually { outbound.entries.last?.phase == .counting(remaining: remaining) })
      #expect(transport.requests.isEmpty, "a request left inside the window")
    }
    await Self.second(clock)
    #expect(await eventually { outbound.entries.last?.phase == .parked })
    let sends = Self.sends(transport)
    #expect(sends.count == 1)
    #expect(sends.first?.httpMethod == "POST")
  }

  @Test("S4 14.F: cmd-Z inside the window takes the send back and nothing is ever requested")
  func undoInsideTheWindow() async throws {
    let (outbound, transport, clock) = Self.make { _ in try Reply.golden("responses/send.json") }
    #expect(outbound.perform(Self.daniel, gesture: .sendButton) == nil)
    await Self.second(clock)
    await Self.second(clock)
    #expect(await eventually { outbound.entries.last?.phase == .counting(remaining: 2) })
    #expect(outbound.undo())
    #expect(outbound.entries.last?.phase == .undone)
    clock.tick()
    try await Task.sleep(for: .milliseconds(50))
    #expect(transport.requests.isEmpty)
    #expect(outbound.entries.last?.phase == .undone)
    // Nothing left to undo.
    #expect(!outbound.undo())
  }

  @Test("S4 02.I: a send the daemon accepts reads sent only after the window")
  func sentAfterTheWindow() async throws {
    let (outbound, transport, clock) = Self.make { _ in try Reply.golden("responses/send.json") }
    outbound.perform(Self.daniel, gesture: .commandReturn)
    for _ in 0..<4 { await Self.second(clock) }
    #expect(await eventually { outbound.entries.last?.phase == .sent })
    #expect(Self.sends(transport).count == 1)
    #expect(!outbound.undo(), "a sent message offered an undo")
  }

  @Test("S4 02.I(d): with the kill switch on, or unknown, nothing is queued and no entry is written")
  func killRefuses() {
    for state in [true, nil] as [Bool?] {
      let kill = Kill()
      kill.on = state
      let (outbound, transport, _) = Self.make({ _ in try Reply.golden("responses/send.json") }, kill: kill)
      #expect(outbound.perform(Self.daniel, gesture: .commandReturn) == .killSwitch)
      #expect(outbound.entries.isEmpty)
      #expect(transport.requests.isEmpty)
    }
  }

  @Test("S4 09.F: a kill switch engaged inside the window refuses the send at the minute it would go")
  func killAtTheMinute() async throws {
    let kill = Kill()
    let (outbound, transport, clock) = Self.make({ _ in try Reply.golden("responses/send.json") }, kill: kill)
    outbound.perform(Self.daniel, gesture: .commandReturn)
    await Self.second(clock)
    kill.on = true
    for _ in 0..<3 { await Self.second(clock) }
    #expect(await eventually { outbound.entries.last?.phase == .refused("kill switch on") })
    #expect(transport.requests.isEmpty)
  }

  @Test("S4 plan 2.2: an empty body and a gesture that is not the intent's are refused")
  func gestures() {
    let (outbound, transport, _) = Self.make { _ in try Reply.golden("responses/send.json") }
    let blank = Outbound.Intent.send(chatGuid: "iMessage;-;+15550100002", handle: "+15550100002", body: " \n ")
    #expect(outbound.perform(blank, gesture: .commandReturn) == .empty)
    #expect(outbound.perform(Self.daniel, gesture: .approveButton) == .wrongGesture)
    let approve = Outbound.Intent.approve(draftId: "drf-0102", chatGuid: "SMS;-;+15550100004", editedBody: nil)
    outbound.markRendered("drf-0102")
    #expect(outbound.perform(approve, gesture: .commandReturn) == .wrongGesture)
    #expect(outbound.perform(approve, gesture: .sendButton) == .wrongGesture)
    #expect(outbound.entries.isEmpty)
    #expect(transport.requests.isEmpty)
  }

  @Test("S4 09.D: an approval needs the body drawn this session, then counts 10 s and approves; it never posts a send")
  func approveNeedsRendered() async throws {
    let (outbound, transport, clock) = Self.make { _ in try Reply.golden("responses/drafts.approve.json") }
    let approve = Outbound.Intent.approve(draftId: "drf-0102", chatGuid: "SMS;-;+15550100004", editedBody: nil)
    #expect(outbound.perform(approve, gesture: .approveButton) == .notRendered)
    outbound.markRendered("drf-0102")
    #expect(outbound.perform(approve, gesture: .approveButton) == nil)
    #expect(outbound.entries.last?.phase == .counting(remaining: 10))
    for _ in 0..<9 { await Self.second(clock) }
    #expect(await eventually { outbound.entries.last?.phase == .counting(remaining: 1) })
    #expect(transport.requests.isEmpty)
    await Self.second(clock)
    #expect(await eventually { outbound.entries.last?.phase == .approved })
    #expect(transport.requests.map { $0.url?.path } == ["/v1/drafts/drf-0102/approve"])
    #expect(Self.sends(transport).isEmpty)
  }

  @Test("S4 plan 2.2: a refusal maps to words, and only parked reads parked")
  func refusalPhases() {
    #expect(Outbound.phase(for: .conflict(code: "parked", from: nil, requested: nil)) == .parked)
    #expect(Outbound.phase(for: .conflict(code: "not-armed", from: nil, requested: nil)) == .refused("not-armed"))
    #expect(Outbound.phase(for: .denied(reason: "kill-switch")) == .refused("kill-switch"))
  }
}
