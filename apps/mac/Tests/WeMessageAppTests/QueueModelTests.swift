import Foundation
import Testing
import WeMessageKit

@testable import WeMessageApp

/// S4f: boards 06 and 09's local queue state and the bulk approve plan.
/// Bulk approve includes only drafts whose body was drawn this session
/// (06.F, 09.D); every excluded draft carries its reason; one bulk act is
/// one undo step; nothing here reaches a route.
@Suite("QueueModel")
@MainActor
struct QueueModelTests {
  static let utc = TimeZone(identifier: "UTC")!
  static var calendar: Calendar {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = utc
    return c
  }

  static func pendingDrafts() throws -> [DraftPayload] {
    let reply = try Reply.scenario("pending", "drafts.list.json")
    return try JSONDecoder().decode(DraftsEnvelope.self, from: reply.body).drafts.filter { $0.state == .pending }
  }

  static func at(_ wire: String) throws -> Date { try #require(WireDate.parse(wire)) }

  @Test("bulk plan: only rendered drafts are included; every excluded row carries its reason, an unsaved edit before unopened")
  func bulkExcludesUnrendered() throws {
    let drafts = try Self.pendingDrafts()
    #expect(drafts.count == 6)
    let plan = QueueStateStore.bulkPlan(
      drafts: drafts, killSwitch: false, rendered: ["drf-0101", "drf-0106", "drf-0102"],
      unsavedEdit: ["SMS;-;+15550100004"])
    #expect(plan.included.map(\.id) == ["drf-0101", "drf-0106"])
    #expect(plan.excluded.map(\.draftId) == ["drf-0102", "drf-0103", "drf-0104", "drf-0107"])
    #expect(plan.excluded.first?.reason == .unsavedEdit)
    #expect(plan.excluded.dropFirst().allSatisfy { $0.reason == .notRendered })
    #expect(plan.unopened == 3)
    #expect(plan.included.count + plan.excluded.count == drafts.count, "a draft vanished from the plan")
    #expect(QueueStateStore.reasonText(.unsavedEdit) == "EXCLUDED \u{00B7} you have an unsaved edit in this thread")
    #expect(QueueStateStore.reasonText(.notRendered) == "Draft not yet shown to you. Not included.")
  }

  @Test("bulk plan: under the kill switch, on or unknown, nothing is included")
  func bulkUnderKill() throws {
    let drafts = try Self.pendingDrafts()
    let all = Set(drafts.map(\.id))
    for kill in [true, nil] as [Bool?] {
      let plan = QueueStateStore.bulkPlan(drafts: drafts, killSwitch: kill, rendered: all, unsavedEdit: [])
      #expect(plan.included.isEmpty)
      #expect(plan.excluded.allSatisfy { $0.reason == .killSwitch })
    }
  }

  @Test("acts: a bulk Done is one undo step, Z takes all of it back, and the selection empties")
  func oneUndoPerBulk() throws {
    let store = QueueStateStore()
    let now = try Self.at("2026-09-01T12:01:34.000Z")
    store.selection = ["a", "b", "c"]
    store.act(.done, on: ["a", "b", "c"], at: now)
    #expect(store.acts.count == 3)
    #expect(store.selection.isEmpty)
    store.act(.mute, on: ["d"], at: now)
    #expect(store.undo())
    #expect(store.acts["d"] == nil)
    #expect(store.acts.count == 3)
    #expect(store.undo())
    #expect(store.acts.isEmpty)
    #expect(!store.undo())
  }

  @Test("acts: an undo restores the act a thread had before, not nothing")
  func undoRestoresPrior() throws {
    let store = QueueStateStore()
    let now = try Self.at("2026-09-01T12:01:34.000Z")
    store.act(.snooze, on: ["a"], at: now, calendar: Self.calendar)
    let snoozed = store.acts["a"]
    store.act(.done, on: ["a"], at: now)
    #expect(store.acts["a"] == .done(at: now))
    store.undo()
    #expect(store.acts["a"] == snoozed)
  }

  @Test("D-UI-46: a snooze runs to the next 9:00 strictly after now, labelled with the weekday")
  func snooze() throws {
    let tuesdayNoon = try Self.at("2026-09-01T12:01:34.000Z")
    let until = QueueStateStore.snoozeUntil(after: tuesdayNoon, calendar: Self.calendar)
    #expect(until == (try Self.at("2026-09-02T09:00:00.000Z")))
    #expect(QueueStateStore.snoozeLabel(until, zone: Self.utc) == "Wednesday 9:00")
    let early = try Self.at("2026-09-01T08:00:00.000Z")
    #expect(QueueStateStore.snoozeUntil(after: early, calendar: Self.calendar) == (try Self.at("2026-09-01T09:00:00.000Z")))
    let store = QueueStateStore()
    store.act(.snooze, on: ["a"], at: tuesdayNoon, calendar: Self.calendar)
    #expect(store.nextSnooze(after: tuesdayNoon) == until)
    #expect(store.nextSnooze(after: until) == nil)
  }

  @Test("triage burn-down: the start is fixed on entry and cleared on leaving")
  func triageStart() {
    let store = QueueStateStore()
    store.beginTriage(count: 5)
    store.beginTriage(count: 3)
    #expect(store.triageStart == 5)
    store.selection = ["a"]
    store.endTriage()
    #expect(store.triageStart == nil)
    #expect(store.selection.isEmpty)
  }

  @Test("receipt (06.E): replies, approvals and failures from the funnel; done and snoozed from the acts")
  func receipt() throws {
    let now = try Self.at("2026-09-01T12:01:34.000Z")
    let send = Outbound.Intent.send(chatGuid: "c1", handle: "+15550100001", body: "x")
    let approve = Outbound.Intent.approve(draftId: "d1", chatGuid: "c2", editedBody: nil)
    let entries: [Outbound.Entry] = [
      Outbound.Entry(id: 1, intent: send, phase: .sent, window: 4, batch: nil, startedAt: now),
      Outbound.Entry(id: 2, intent: approve, phase: .approved, window: 4, batch: nil, startedAt: now),
      Outbound.Entry(id: 3, intent: approve, phase: .parked, window: 4, batch: nil, startedAt: now),
      Outbound.Entry(id: 4, intent: send, phase: .undone, window: 4, batch: nil, startedAt: now),
    ]
    let acts: [String: ThreadAct] = [
      "a": .done(at: now), "b": .snoozed(at: now, until: now.addingTimeInterval(60)), "c": .muted(at: now),
    ]
    let r = QueueStateStore.receipt(entries: entries, acts: acts)
    #expect(r.line == "1 replied \u{00B7} 1 done \u{00B7} 1 snoozed \u{00B7} 1 approved \u{00B7} 1 failed")
  }

  // MARK: v2 F3d (G-06a): the store is a cache over the daemon's record

  static let a = "iMessage;-;+15550100001"
  static let b = "iMessage;-;+15550100002"

  static func synced(_ act: ThreadAct?, _ updatedAt: String) -> SyncedThreadState {
    SyncedThreadState(act: act, mode: nil, updatedAt: updatedAt)
  }

  @Test("an act writes through: one PUT per thread, a fresh act lets the daemon stamp it, the next sends the stamp back")
  func testActWritesThrough() async throws {
    let sync = InMemoryThreadStateSync()
    let store = QueueStateStore(sync: sync)
    let now = try Self.at("2026-09-01T12:01:34.000Z")
    store.act(.done, on: [Self.a, Self.b], at: now)
    #expect(store.acts[Self.a] == .done(at: now), "the act is applied at once, before the daemon answers")
    await store.settle()
    let writes = await sync.writes
    #expect(
      writes == [
        .init(guid: Self.a, act: .done(at: now), expected: nil, restore: false),
        .init(guid: Self.b, act: .done(at: now), expected: nil, restore: false),
      ])
    let stamp = try #require(await sync.records[Self.a]?.updatedAt)
    store.act(.mute, on: [Self.a], at: now)
    await store.settle()
    #expect(await sync.writes.last == .init(guid: Self.a, act: .muted(at: now), expected: stamp, restore: false))
    #expect(store.failure == nil, "D-UI-192: success says nothing")
    #expect(await sync.records[Self.a]?.act == .muted(at: now))
  }

  @Test("a refused or failed write rolls the act back and says D-UI-191 once")
  func testRefusalRollsBackAndSetsFailure() async throws {
    let sync = InMemoryThreadStateSync()
    let store = QueueStateStore(sync: sync)
    let now = try Self.at("2026-09-01T12:01:34.000Z")
    await sync.refuseNext(.denied(reason: "test"))
    store.act(.done, on: [Self.a], at: now)
    await store.settle()
    #expect(store.acts[Self.a] == nil, "a refused act is rolled back")
    #expect(store.failure == .refused)
    #expect(store.failureLine == ProvisionalUI.threadStateRefusedLine)

    await sync.failNext()
    store.act(.snooze, on: [Self.b], at: now, calendar: Self.calendar)
    await store.settle()
    #expect(store.acts[Self.b] == nil, "an unreachable daemon rolls back too")
    #expect(store.failure == .refused)
    #expect(await sync.records.isEmpty)
  }

  @Test("undo PUTs the prior record exactly: a restore with its own instant, or a clear for a first act")
  func testUndoRestoresPriorRecord() async throws {
    let earlier = try Self.at("2026-09-01T11:00:00.000Z")
    let until = try Self.at("2026-09-02T09:00:00.000Z")
    let sync = InMemoryThreadStateSync(records: [Self.a: Self.synced(.snoozed(at: earlier, until: until), "2026-09-01T11:00:00.000Z")])
    let store = QueueStateStore(sync: sync)
    await store.hydrate()
    let now = try Self.at("2026-09-01T12:01:34.000Z")
    store.act(.done, on: [Self.a, Self.b], at: now)
    await store.settle()
    #expect(store.undo())
    #expect(store.acts[Self.a] == .snoozed(at: earlier, until: until))
    #expect(store.acts[Self.b] == nil)
    await store.settle()
    let writes = await sync.writes
    #expect(writes.count == 4)
    let undone = writes.suffix(2).sorted { $0.guid < $1.guid }
    #expect(undone.map(\.restore) == [true, true])
    #expect(undone.map(\.act) == [.snoozed(at: earlier, until: until), nil])
    #expect(await sync.records[Self.a]?.act == .snoozed(at: earlier, until: until))
    #expect(await sync.records[Self.b] == nil, "undoing a first act clears the record")
    #expect(store.failure == nil)
  }

  @Test("a conflict (another window acted first) shows the record that won and says so")
  func testConflictRehydrates() async throws {
    let sync = InMemoryThreadStateSync(records: [Self.a: Self.synced(.done(at: try Self.at("2026-09-01T11:00:00.000Z")), "2026-09-01T11:00:00.000Z")])
    let store = QueueStateStore(sync: sync)
    await store.hydrate()
    let theirs = try Self.at("2026-09-01T12:00:00.000Z")
    await sync.set(Self.a, Self.synced(.muted(at: theirs), "2026-09-01T12:00:00.000Z"))
    store.act(.snooze, on: [Self.a], at: try Self.at("2026-09-01T12:01:34.000Z"), calendar: Self.calendar)
    await store.settle()
    #expect(store.acts[Self.a] == .muted(at: theirs), "the window shows the latest, not its own lost act")
    #expect(store.failure == .conflict)
    #expect(store.failureLine == ProvisionalUI.threadStateConflictLine)
    #expect(await sync.loads == 2, "one hydrate, one re-read after the 409")
    // The next act carries the winner's stamp and lands.
    store.act(.done, on: [Self.a], at: theirs)
    await store.settle()
    #expect(await sync.writes.last?.expected == "2026-09-01T12:00:00.000Z")
    #expect(await sync.records[Self.a]?.act == .done(at: theirs))
  }

  @Test("hydrate on connect: the daemon's record replaces the cache, and a failed read keeps it")
  func testHydrateOnConnect() async throws {
    let at = try Self.at("2026-09-01T11:00:00.000Z")
    let until = try Self.at("2026-09-02T09:00:00.000Z")
    let sync = InMemoryThreadStateSync(records: [Self.b: Self.synced(.snoozed(at: at, until: until), "2026-09-01T11:00:00.000Z")])
    let store = QueueStateStore(sync: sync)
    #expect(store.acts.isEmpty)
    await store.hydrate()
    #expect(store.acts == [Self.b: .snoozed(at: at, until: until)])
    #expect(store.sessionActs.isEmpty, "a hydrated act is not this session's work (06.E receipt)")
    await sync.failNextLoad()
    await store.hydrate()
    #expect(store.acts == [Self.b: .snoozed(at: at, until: until)], "an unreachable read changes nothing")
    await sync.set(Self.b, nil)
    await store.hydrate()
    #expect(store.acts.isEmpty, "a record cleared elsewhere clears here")
    #expect(store.failure == nil, "a read never draws D-UI-191")
  }

  @Test("a thread.state frame from another window applies; an older or in-flight one does not")
  func testEventFromOtherWindowApplies() async throws {
    let store = QueueStateStore(sync: InMemoryThreadStateSync())
    func record(_ act: String?, _ at: String, until: String? = nil) -> ThreadStateRecord {
      ThreadStateRecord(
        chatGuid: Self.b, act: act, actAt: act == nil ? nil : at, snoozedUntil: until, attention: nil,
        updatedAt: at, awake: false)
    }
    store.apply(record("muted", "2026-09-01T12:00:00.000Z"), guid: Self.b)
    #expect(store.acts[Self.b] == .muted(at: try Self.at("2026-09-01T12:00:00.000Z")))
    store.apply(record("done", "2026-09-01T11:00:00.000Z"), guid: Self.b)
    #expect(store.acts[Self.b] == .muted(at: try Self.at("2026-09-01T12:00:00.000Z")), "an older frame is stale")
    store.apply(nil, guid: Self.b)
    #expect(store.acts[Self.b] == nil, "a cleared record clears the row")
    #expect(store.sessionActs.isEmpty, "another window's act is not this session's")

    // A frame for a thread with a write in flight waits for the write.
    let now = try Self.at("2026-09-01T12:01:34.000Z")
    store.act(.done, on: [Self.a], at: now)
    store.apply(nil, guid: Self.a)
    #expect(store.acts[Self.a] == .done(at: now))
    await store.settle()
    #expect(store.sessionActs == [Self.a: .done(at: now)])
  }

  @Test("D-UI-190/194: the reason line names the rule, cuts the agent's words at 60, else says the draft is ready")
  func reasonLines() {
    #expect(QueueReason.ruleFired("Weekday hours").line == "Rule: Weekday hours")
    #expect(QueueReason.ruleFired(nil).line == "Rule: a rule")
    #expect(QueueReason.agentFlag("Follow up").line == "Agent flagged: Follow up")
    let long = String(repeating: "x", count: 61)
    #expect(QueueReason.agentFlag(long).line == "Agent flagged: " + String(repeating: "x", count: 60) + "\u{2026}")
    #expect(QueueReason.agentFlag(String(repeating: "y", count: 60)).line.hasSuffix("y"))
    #expect(QueueReason.pendingDraft.line == ProvisionalUI.draftReady)
  }
}
