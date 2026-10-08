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
}
