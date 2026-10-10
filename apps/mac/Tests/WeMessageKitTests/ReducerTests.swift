import Foundation
import Testing
@testable import WeMessageKit

/// R8: the pure reducer, ported from the v1 desktop renderer's optimistic store
/// (deleted in v2 S6c). Drafts come from
/// responses/drafts.list.pending.json; events come from fixtures/events, aimed
/// at those drafts by rewriting their draftId.
@Suite("AppReducer")
struct ReducerTests {
  static let first = "id-0001"
  static let second = "id-0002"

  /// fixtures/events/<name>.json, its top-level draftId (if it has one)
  /// pointed at `draftId`.
  static func event(_ name: String, draftId: String? = nil) throws -> GatewayEvent {
    var payload = try Fixtures.event(name)
    if let draftId, payload["draftId"] != nil {
      payload = payload.replacing("draftId", with: .string(draftId))
    }
    return try GatewayEvent.decode(name: name, data: payload.canonicalData())
  }

  static func synced() throws -> AppState {
    let drafts = try EventStreamTests.pendingDrafts()
    let (state, effects) = AppReducer.reduce(AppState(), .frame(.snapshot(seq: 1, at: "t1", missed: 0, drafts: drafts)))
    #expect(effects.isEmpty)
    #expect(state.order == [first, second])
    return state
  }

  static func apply(_ state: AppState, _ event: GatewayEvent, seq: Int = 2) -> (AppState, [Effect]) {
    AppReducer.reduce(state, .frame(.event(seq: seq, event: event)))
  }

  @Test("reduce is pure: the same state and action always give the same state and effects")
  func purity() throws {
    let start = try Self.synced()
    let copy = start
    var actions: [AppAction] = [
      .status(.connected), .status(.reconnecting(attempt: 3)), .status(.down(reason: "token-rejected")),
      .frame(.snapshot(seq: 7, at: "t7", missed: 2, drafts: [])),
      .response(.drafts(try EventStreamTests.pendingDrafts())),
      .frame(.event(seq: 2, event: .unknown(name: "draft.teleported"))),
    ]
    for name in EventName.allCases.map(\.rawValue) {
      actions.append(.frame(.event(seq: 2, event: try Self.event(name, draftId: Self.first))))
      actions.append(.frame(.event(seq: 2, event: try Self.event(name, draftId: "id-9999"))))
    }
    for action in actions {
      let once = AppReducer.reduce(start, action)
      let twice = AppReducer.reduce(start, action)
      #expect(once.0 == twice.0, "\(action)")
      #expect(once.1 == twice.1, "\(action)")
    }
    #expect(start == copy, "reduce changed its input")
  }

  @Test(
    "draft events move a known draft: approved, rejected, recalled, sent, failed, expired, requeued -> pending, superseded; never sending"
  )
  func transitions() throws {
    let start = try Self.synced()
    let table: [(String, DraftState)] = [
      ("draft.approved", .approved), ("draft.rejected", .rejected), ("draft.recalled", .recalled),
      ("draft.sent", .sent), ("draft.failed", .failed), ("draft.expired", .expired),
      ("draft.requeued", .pending), ("draft.superseded", .superseded),
    ]
    var reached: Set<DraftState> = []
    for (name, want) in table {
      var from = start
      if want == .pending { from.drafts[Self.first]?.state = .approved }
      let (next, _) = Self.apply(from, try Self.event(name, draftId: Self.first))
      let draft = try #require(next.drafts[Self.first], "\(name) dropped the draft")
      #expect(draft.state == want, "\(name)")
      #expect(next.drafts[Self.second] == from.drafts[Self.second], "\(name) touched another draft")
      #expect(next.order == from.order, "\(name) reordered the queue")
      #expect(next.lastSeq == 2, "\(name)")
      reached.insert(draft.state)
    }
    #expect(reached == [.approved, .rejected, .recalled, .sent, .failed, .expired, .pending, .superseded])
    #expect(!reached.contains(.sending), "no frame announces sending, so the store never invents it")
    let wire = Set(try #require(Fixtures.wire()["draftStates"]?.arrayValue).compactMap(\.stringValue))
    #expect(Set(reached.map(\.rawValue)).isSubset(of: wire))

    for name in ["draft.approved", "draft.rejected", "draft.recalled", "draft.sent", "draft.failed", "draft.expired"] {
      let (next, effects) = Self.apply(start, try Self.event(name, draftId: Self.first))
      #expect(effects.isEmpty, "\(name)")
      #expect(!next.stale, "\(name)")
    }

    let sent = Self.apply(start, try Self.event("draft.sent", draftId: Self.first)).0.drafts[Self.first]
    #expect(sent?.sentMessageGuid == (try Fixtures.event("draft.sent"))["sentMessageGuid"]?.stringValue)
    let failed = Self.apply(start, try Self.event("draft.failed", draftId: Self.first)).0.drafts[Self.first]
    let error = try #require((try Fixtures.event("draft.failed"))["error"])
    #expect(try JSONValue.parse(JSONEncoder().encode(failed?.error)) == error)
  }

  @Test("a state change for a draft the store does not hold marks it stale and asks for the list once")
  func unknownDraft() throws {
    let start = try Self.synced()
    let (next, effects) = Self.apply(start, try Self.event("draft.approved", draftId: "id-9999"))
    #expect(next.stale)
    #expect(effects == [.listDrafts])
    #expect(next.drafts == start.drafts)
    let (again, more) = Self.apply(next, try Self.event("draft.sent", draftId: "id-9998"), seq: 3)
    #expect(again.stale)
    #expect(more.isEmpty, "already stale: a second refetch is not asked for")
    #expect(again.lastSeq == 3)
  }

  @Test("draft.created and draft.superseded mark the queue stale; draft.redrafted drops the old card too")
  func staleEvents() throws {
    let start = try Self.synced()
    let (created, createdEffects) = Self.apply(start, try Self.event("draft.created"))
    #expect(created.stale)
    #expect(createdEffects == [.listDrafts])
    #expect(created.drafts == start.drafts, "the frame carries a summary, not a DraftPayload: the list is refetched")

    let (redrafted, redraftEffects) = Self.apply(start, try Self.event("draft.redrafted", draftId: Self.first))
    #expect(redrafted.drafts[Self.first] == nil)
    #expect(redrafted.order == [Self.second])
    #expect(redrafted.queue.map(\.id) == [Self.second])
    #expect(redrafted.stale)
    #expect(redraftEffects == [.listDrafts])

    let (superseded, supersededEffects) = Self.apply(start, try Self.event("draft.superseded", draftId: Self.first))
    #expect(superseded.drafts[Self.first]?.state == .superseded)
    #expect(superseded.stale)
    #expect(supersededEffects == [.listDrafts])
  }

  @Test("a snapshot replaces the map, sets missed and syncedAt, and clears stale")
  func snapshot() throws {
    let drafts = try EventStreamTests.pendingDrafts()
    let start = Self.apply(try Self.synced(), try Self.event("draft.approved", draftId: "id-9999")).0
    #expect(start.stale)
    let only = [drafts[1]]
    let (next, effects) = AppReducer.reduce(start, .frame(.snapshot(seq: 9, at: "t9", missed: 4, drafts: only)))
    #expect(effects.isEmpty)
    #expect(next.drafts == [Self.second: drafts[1]], "replaced, not merged")
    #expect(next.order == [Self.second])
    #expect(next.queue == only)
    #expect(next.missed == 4)
    #expect(next.syncedAt == "t9")
    #expect(next.lastSeq == 9)
    #expect(!next.stale)
  }

  @Test("an unknown event is dropped with a log effect and leaves the queue alone")
  func unknownEvent() throws {
    let start = try Self.synced()
    let (next, effects) = Self.apply(start, .unknown(name: "draft.teleported"), seq: 5)
    #expect(effects == [.log(.droppedEvent(name: "draft.teleported"))])
    #expect(next.drafts == start.drafts)
    #expect(next.order == start.order)
    #expect(!next.stale)
    #expect(next.lastSeq == 5)
  }

  @Test("events that are not a draft's state change leave the queue alone and ask for nothing")
  func passiveEvents() throws {
    let start = try Self.synced()
    let passive = [
      "adapter.health", "arming.changed", "connection.state", "draft.delta", "gate.denied", "gateway.disconnected",
      "message.edited", "message.received", "message.unsent", "rule.matched", "thread.state", "toggle.changed",
    ]
    for name in passive {
      let (next, effects) = Self.apply(start, try Self.event(name, draftId: Self.first))
      #expect(effects.isEmpty, "\(name)")
      #expect(next.drafts == start.drafts, "\(name)")
      #expect(next.order == start.order, "\(name)")
      #expect(!next.stale, "\(name)")
    }
    let active: Set<String> = [
      "draft.approved", "draft.rejected", "draft.recalled", "draft.sent", "draft.failed", "draft.expired",
      "draft.requeued", "draft.superseded", "draft.redrafted", "draft.created",
    ]
    #expect(Set(passive).union(active) == Set(EventName.allCases.map(\.rawValue)), "every wire event has a row")
  }

  @Test("status actions record the stream status; a drafts response replaces the map and clears stale")
  func statusAndResponse() throws {
    let drafts = try EventStreamTests.pendingDrafts()
    var state = AppState()
    #expect(state.stream == nil)
    for status: StreamStatus in [.connected, .reconnecting(attempt: 2), .down(reason: "token-rejected")] {
      let (next, effects) = AppReducer.reduce(state, .status(status))
      #expect(next.stream == status)
      #expect(effects.isEmpty)
      state = next
    }

    let stale = Self.apply(try Self.synced(), try Self.event("draft.created")).0
    #expect(stale.stale)
    let (next, effects) = AppReducer.reduce(stale, .response(.drafts(Array(drafts.reversed()))))
    #expect(effects.isEmpty)
    #expect(!next.stale)
    #expect(next.order == [Self.second, Self.first])
    #expect(next.syncedAt == stale.syncedAt, "a refetch is not a snapshot: syncedAt stays the stream's")
  }
}
