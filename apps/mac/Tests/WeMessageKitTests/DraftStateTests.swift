import Foundation
import Testing

@testable import WeMessageKit

/// S4f: board 09.B's five draft states, projected from the wire draft plus
/// the app's local approval and hold, and the meta line each one prints.
@Suite("DraftState")
struct DraftStateTests {
  static let now = Date(timeIntervalSince1970: 1_788_264_042)  // 2026-09-01T12:00:42Z

  static func draft(
    _ state: DraftState, created: String = "2026-09-01T11:58:20.000Z", changed: String = "2026-09-01T11:58:20.000Z",
    expires: String = "2026-09-01T15:58:20.000Z", sendNotBefore: String? = nil
  ) -> DraftPayload {
    DraftPayload(
      id: "drf-0101", inboundGuid: "msg-0006", chatGuid: "iMessage;-;+15550100001", ruleId: "rul-0201",
      adapterId: "echo", idempotencyKey: "k", body: "b", originalBody: "b", proactiveReason: nil, state: state,
      stateChangedAt: changed, sendNotBefore: sendNotBefore, expiresAt: expires, createdAt: created, error: nil)
  }

  static func at(_ raw: String) -> Date { WireDate.parse(raw)! }

  static let utc: TimeZone = TimeZone(identifier: "UTC")!
  static func clock(_ d: Date) -> String {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = utc
    let c = cal.dateComponents([.hour, .minute], from: d)
    return "\(c.hour!):" + String(format: "%02d", c.minute!)
  }
  static func longClock(_ d: Date) -> String {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = utc
    let c = cal.dateComponents([.second], from: d)
    return clock(d) + ":" + String(format: "%02d", c.second!)
  }
  static func meta(_ phase: DraftPhase, long: Bool = false) -> String {
    phase.meta(adapter: "Sol", clock: clock, longClock: longClock, long: long) { expires in
      expires.map { "expires \(clock($0))" } ?? "will not expire"
    }
  }

  @Test("awaiting: pending, not expired, not held, no local approval")
  func awaiting() throws {
    let phase = try #require(DraftPhase.project(Self.draft(.pending), now: Self.now, killSwitch: false))
    #expect(phase == .awaiting(proposedAt: Self.at("2026-09-01T11:58:20Z"), expiresAt: Self.at("2026-09-01T15:58:20Z")))
    #expect(phase.carriesVerbs && !phase.readsAbsent && !phase.isFilled)
    #expect(Self.meta(phase) == "DRAFT · Sol 11:58 · expires 15:58")
    #expect(Self.meta(phase, long: true) == "DRAFT · proposed by Sol 11:58 · not sent · expires 15:58")
  }

  @Test("approved in undo: a local approval inside its window, then awaiting again once the window closes unsent")
  func approvedInUndo() throws {
    let approvedAt = Self.now - 4
    let phase = try #require(
      DraftPhase.project(Self.draft(.pending), now: Self.now, approvedAt: approvedAt, undoSeconds: 10, killSwitch: false))
    #expect(phase == .approvedInUndo(approvedAt: approvedAt, sendsAt: approvedAt + 10))
    #expect(!phase.carriesVerbs && !phase.isFilled && !phase.readsAbsent)
    #expect(Self.meta(phase) == "APPROVED by you 12:00:38 · sends at 12:00:48")
    let later = DraftPhase.project(
      Self.draft(.pending), now: Self.now + 7, approvedAt: approvedAt, undoSeconds: 10, killSwitch: false)
    #expect(later == .awaiting(proposedAt: Self.at("2026-09-01T11:58:20Z"), expiresAt: Self.at("2026-09-01T15:58:20Z")))
  }

  @Test("approved on the wire: its send time is sendNotBefore")
  func approvedWire() {
    let phase = DraftPhase.project(
      Self.draft(.approved, changed: "2026-09-01T12:00:38.000Z", sendNotBefore: "2026-09-01T12:00:48.000Z"),
      now: Self.now, killSwitch: false)
    #expect(
      phase == .approvedInUndo(approvedAt: Self.at("2026-09-01T12:00:38Z"), sendsAt: Self.at("2026-09-01T12:00:48Z")))
  }

  @Test("sent: filled, approved by you")
  func sent() throws {
    let phase = try #require(
      DraftPhase.project(Self.draft(.sent, changed: "2026-09-01T12:00:49.000Z"), now: Self.now, killSwitch: false))
    #expect(phase == .sent(at: Self.at("2026-09-01T12:00:49Z")))
    #expect(phase.isFilled && !phase.carriesVerbs)
    #expect(Self.meta(phase) == "Sent 12:00 · approved by you")
  }

  @Test("expired: on the wire, or pending past its expiry; muted and verbless")
  func expired() throws {
    let wire = try #require(DraftPhase.project(Self.draft(.expired), now: Self.now, killSwitch: false))
    #expect(wire == .expired(at: Self.at("2026-09-01T15:58:20Z")))
    let lapsed = try #require(
      DraftPhase.project(Self.draft(.pending, expires: "2026-09-01T12:00:00.000Z"), now: Self.now, killSwitch: true))
    #expect(lapsed == .expired(at: Self.at("2026-09-01T12:00:00Z")))
    #expect(lapsed.readsAbsent && !lapsed.carriesVerbs)
    #expect(Self.meta(lapsed) == "EXPIRED 12:00 · not sent · Sol may propose again")
  }

  @Test("held: by you, or by the kill switch, which wins; both verbless")
  func held() throws {
    let heldAt = Self.now - 30
    let mine = try #require(
      DraftPhase.project(Self.draft(.pending), now: Self.now, heldAt: heldAt, killSwitch: false))
    #expect(mine == .held(.you(at: heldAt), expiresAt: Self.at("2026-09-01T15:58:20Z")))
    #expect(mine.readsAbsent && !mine.carriesVerbs)
    #expect(Self.meta(mine) == "HELD by you 12:00 · not sent · expires 15:58")
    let killed = try #require(
      DraftPhase.project(
        Self.draft(.pending), now: Self.now, approvedAt: Self.now - 1, heldAt: heldAt, killSwitch: true))
    #expect(killed == .held(.killSwitch, expiresAt: Self.at("2026-09-01T15:58:20Z")))
    #expect(Self.meta(killed) == "HELD by kill switch · not sent · returns to awaiting when disengaged")
    // Unknown kill state is not drawn as held by the switch; the verbs are
    // removed by CompletionRules instead.
    let unknown = DraftPhase.project(Self.draft(.pending), now: Self.now, killSwitch: nil)
    #expect(unknown?.carriesVerbs == true)
    #expect(CompletionRules.permit(.approve, VerbGates(killSwitch: nil, bodyRendered: true, hasDraft: true)) == .killSwitch)
  }

  @Test(
    "rejected, superseded, recalled and failed drafts are not drawn",
    arguments: [DraftState.rejected, .superseded, .recalled, .failed])
  func notDrawn(_ state: DraftState) {
    #expect(DraftPhase.project(Self.draft(state), now: Self.now, killSwitch: false) == nil)
  }

  @Test("an audit row: actor kind uppercased, event type as verb, draft as target, 4-character hash prefixes")
  func auditLine() {
    let agent = AuditLine(
      AuditRowPayload(
        seq: 107, at: "2026-09-01T11:58:20.000Z", eventJson: #"{"type":"draft.created","draftId":"drf-0101"}"#,
        actorJson: #"{"kind":"agent","adapterId":"echo"}"#, prevHash: "3b7e9a", hash: "c9104f"))
    #expect(agent.seq == 107)
    #expect(agent.actor == "AGENT" && agent.actorName == "echo")
    #expect(agent.verb == "draft.created" && agent.target == "drf-0101")
    #expect(agent.prev == "3b7e…" && agent.hash == "c910…")
    #expect(agent.result == nil)
    let human = AuditLine(
      AuditRowPayload(
        seq: 1, at: "x", eventJson: "not json", actorJson: #"{"kind":"human","via":"api"}"#, prevHash: "", hash: "ab"))
    #expect(human.actor == "HUMAN" && human.verb == "unknown" && human.target == "" && human.at == nil)
    #expect(human.prev == "…" && human.hash == "ab…")
    let system = AuditLine(
      AuditRowPayload(seq: 2, at: "x", eventJson: "{}", actorJson: #"{"kind":"daemon"}"#, prevHash: "", hash: ""))
    #expect(system.actor == "SYSTEM")
  }
}
