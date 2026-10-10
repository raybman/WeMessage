import Foundation
import Testing
@testable import WeMessageKit

/// v2 F3c (G-06b): a queue row says why it is there only when the draft
/// proves it. A rule id proves a fired rule, a proactive reason proves an
/// agent flag, and anything else is a draft that is ready. Nothing proves a
/// direct question or a mention, so neither exists.
@Suite("QueueReasons")
struct QueueReasonsTests {
  static func draft(ruleId: String? = nil, proactiveReason: String? = nil, adapterId: String = "echo") -> DraftPayload {
    DraftPayload(
      id: "drf-0101", inboundGuid: nil, chatGuid: "iMessage;-;+15550100001", ruleId: ruleId,
      adapterId: adapterId, idempotencyKey: "k", body: "b", originalBody: "b", proactiveReason: proactiveReason,
      state: .pending, stateChangedAt: "2026-09-01T11:58:20.000Z", sendNotBefore: nil,
      expiresAt: "2026-09-01T15:58:20.000Z", createdAt: "2026-09-01T11:58:20.000Z", error: nil)
  }

  @Test("a rule id gives rule fired, named when the shell knows the rule")
  func testRuleIdGivesRuleFired() {
    let reason = QueueReasons.derive(Self.draft(ruleId: "rul-0201")) { $0 == "rul-0201" ? "Weekday hours" : nil }
    #expect(reason == .ruleFired("Weekday hours"))
  }

  @Test("a rule the shell cannot name is still a fired rule, with no name (the app says \"a rule\")")
  func testRuleNameFallsBackToARule() {
    #expect(QueueReasons.derive(Self.draft(ruleId: "rul-0999")) { _ in nil } == .ruleFired(nil))
    #expect(QueueReasons.derive(Self.draft(ruleId: "rul-0999")) == .ruleFired(nil))
  }

  @Test("a rule outranks a proactive reason: the rule is what put it there")
  func ruleBeatsFlag() {
    #expect(QueueReasons.derive(Self.draft(ruleId: "rul-0201", proactiveReason: "check in")) == .ruleFired(nil))
  }

  @Test("a proactive reason gives an agent flag, carried as one sanitised line")
  func testProactiveReasonGivesAgentFlag() {
    #expect(QueueReasons.derive(Self.draft(proactiveReason: "Follow up on the lease")) == .agentFlag("Follow up on the lease"))
    #expect(
      QueueReasons.derive(Self.draft(proactiveReason: "  two\nlines\r\n\tand\u{202E}tabs  "))
        == .agentFlag("two lines and tabs"))
    #expect(QueueReasons.derive(Self.draft(proactiveReason: " \n\t ")) == .pendingDraft, "an empty flag proves nothing")
  }

  @Test("a plain draft is draft ready, whatever adapter made it")
  func testPlainDraftIsDraftReady() {
    #expect(QueueReasons.derive(Self.draft()) == .pendingDraft)
    #expect(QueueReasons.derive(Self.draft(adapterId: "hermes")) == .pendingDraft)
    #expect(QueueReasons.derive(Self.draft(adapterId: "sol")) == .pendingDraft)
  }

  @Test("QueueRules.items carries the derived reason")
  func itemsCarryReason() {
    let drafts = [Self.draft(ruleId: "rul-0201")]
    let items = QueueRules.items(drafts: drafts, threads: []) { _ in "Weekday hours" }
    #expect(items.map(\.reason) == [.ruleFired("Weekday hours")])
    #expect(QueueRules.items(drafts: [Self.draft()], threads: []).map(\.reason) == [.pendingDraft])
  }

  @Test("no reason is ever invented: no source names a direct question or a mention")
  func testNoReasonIsEverInvented() throws {
    let sources = try Repo.url("apps/mac/Sources")
    let files = try #require(FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil))
    var scanned = 0
    for case let url as URL in files where url.pathExtension == "swift" {
      let text = try String(contentsOf: url, encoding: .utf8)
      scanned += 1
      // A whole symbol, so `SpecimenText.mentions` (prose about a mention
      // the specimen draws) is not a reason.
      let symbol = try Regex(#"(\.|case\s+)(directQuestion|mention)\b"#)
      #expect(text.firstMatch(of: symbol) == nil, "\(url.lastPathComponent) names a reason nothing proves")
    }
    #expect(scanned > 50)
  }
}
