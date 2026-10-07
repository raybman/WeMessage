import Foundation
import Testing

@testable import WeMessageKit

/// S4f: wireframe 06.A's truth table and 09.F's kill table, one row per
/// board row, plus the undo-window clamp.
@Suite("CompletionRules")
struct CompletionRulesTests {
  static let now = Date(timeIntervalSince1970: 1_788_264_042)  // 2026-09-01T12:00:42Z
  static let hour: TimeInterval = 3_600
  static let day: TimeInterval = 86_400
  static func ago(_ s: TimeInterval) -> Date { now - s }

  struct Row: Sendable, CustomTestStringConvertible {
    var name: String
    var facts: ThreadFacts
    var always: Bool
    var untilActedOn: Bool
    var testDescription: String { name }
  }

  /// 06.A, top to bottom. `always` is the table read literally (a pending
  /// draft overrides everything); `untilActedOn` is D-UI-44's alternative.
  static let table: [Row] = [
    Row(name: "inbound, no act: in", facts: ThreadFacts(newestInboundAt: ago(60)), always: true, untilActedOn: true),
    Row(
      name: "inbound newer than the act: in",
      facts: ThreadFacts(newestInboundAt: ago(60), act: .done(at: ago(hour))), always: true, untilActedOn: true),
    Row(
      name: "act newer than the inbound: out",
      facts: ThreadFacts(newestInboundAt: ago(hour), act: .done(at: ago(60))), always: false, untilActedOn: false),
    Row(
      name: "outbound is newest: out", facts: ThreadFacts(newestInboundAt: ago(hour), newestOutboundAt: ago(60)),
      always: false, untilActedOn: false),
    Row(
      name: "outbound at the same instant as the inbound: out",
      facts: ThreadFacts(newestInboundAt: ago(60), newestOutboundAt: ago(60)), always: false, untilActedOn: false),
    Row(
      name: "snoozed, before T, no newer inbound: out",
      facts: ThreadFacts(newestInboundAt: ago(hour), act: .snoozed(at: ago(60), until: now + hour)), always: false,
      untilActedOn: false),
    Row(
      name: "snoozed, T has passed: in",
      facts: ThreadFacts(newestInboundAt: ago(2 * hour), act: .snoozed(at: ago(hour), until: ago(1))), always: true,
      untilActedOn: true),
    Row(
      name: "snoozed, a newer inbound arrived before T: in",
      facts: ThreadFacts(newestInboundAt: ago(60), act: .snoozed(at: ago(hour), until: now + day)), always: true,
      untilActedOn: true),
    Row(
      name: "muted act, newer inbound: out, never",
      facts: ThreadFacts(newestInboundAt: ago(60), act: .muted(at: ago(hour))), always: false, untilActedOn: false),
    Row(
      name: "muted mode: out, never", facts: ThreadFacts(newestInboundAt: ago(60), mode: .muted), always: false,
      untilActedOn: false),
    Row(
      name: "pending draft, no inbound: in", facts: ThreadFacts(pendingDraftAt: ago(60)), always: true,
      untilActedOn: true),
    Row(
      name: "pending draft on a muted thread: in",
      facts: ThreadFacts(newestInboundAt: ago(hour), pendingDraftAt: ago(60), mode: .muted), always: true,
      untilActedOn: true),
    Row(
      name: "pending draft, outbound newest: in",
      facts: ThreadFacts(newestInboundAt: ago(hour), newestOutboundAt: ago(60), pendingDraftAt: ago(2 * hour)),
      always: true, untilActedOn: true),
    Row(
      name: "pending draft older than a Done: literal in, until-acted-on out",
      facts: ThreadFacts(newestInboundAt: ago(2 * hour), pendingDraftAt: ago(hour), act: .done(at: ago(60))),
      always: true, untilActedOn: false),
    Row(
      name: "pending draft older than a Mute: literal in, until-acted-on out",
      facts: ThreadFacts(pendingDraftAt: ago(hour), act: .muted(at: ago(60))), always: true, untilActedOn: false),
    Row(
      name: "pending draft older than a Snooze, before T: literal in, until-acted-on out",
      facts: ThreadFacts(pendingDraftAt: ago(hour), act: .snoozed(at: ago(60), until: now + hour)), always: true,
      untilActedOn: false),
    Row(
      name: "pending draft older than a Snooze whose T has passed: in",
      facts: ThreadFacts(pendingDraftAt: ago(2 * hour), act: .snoozed(at: ago(hour), until: ago(1))), always: true,
      untilActedOn: true),
    Row(
      name: "a draft that lands after the Done re-queues",
      facts: ThreadFacts(newestInboundAt: ago(2 * hour), pendingDraftAt: ago(60), act: .done(at: ago(hour))),
      always: true, untilActedOn: true),
    Row(
      name: "a reaction is never an inbound: no inbound recorded, out",
      facts: ThreadFacts(newestOutboundAt: ago(hour)), always: false, untilActedOn: false),
    Row(
      name: "inbound older than the 14-day window: out",
      facts: ThreadFacts(newestInboundAt: ago(14 * day)), always: false, untilActedOn: false),
    Row(
      name: "inbound just inside the window: in", facts: ThreadFacts(newestInboundAt: ago(14 * day - 1)), always: true,
      untilActedOn: true),
    Row(
      name: "Stream, not addressed to you: out", facts: ThreadFacts(newestInboundAt: ago(60), mode: .stream),
      always: false, untilActedOn: false),
    Row(
      name: "Stream, a direct question: in",
      facts: ThreadFacts(newestInboundAt: ago(60), mode: .stream, directToYou: true), always: true, untilActedOn: true),
  ]

  @Test("06.A truth table", arguments: table)
  func truthTable(_ row: Row) {
    #expect(CompletionRules.inQueue(row.facts, now: Self.now, draftRule: .always) == row.always, "always")
    #expect(
      CompletionRules.inQueue(row.facts, now: Self.now, draftRule: .untilActedOn) == row.untilActedOn,
      "untilActedOn")
  }

  @Test("the default draft rule is the table read literally")
  func defaultRule() {
    let facts = ThreadFacts(pendingDraftAt: Self.ago(Self.hour), act: .done(at: Self.ago(60)))
    #expect(CompletionRules.inQueue(facts, now: Self.now))
  }

  @Test("reading is never an act: facts with no act keep an unanswered inbound in, whatever was read")
  func readingIsNotAnAct() {
    #expect(CompletionRules.inQueue(ThreadFacts(newestInboundAt: Self.ago(60)), now: Self.now))
  }

  struct KillRow: Sendable, CustomTestStringConvertible {
    var name: String
    var gates: VerbGates
    var drawn: [Verb]
    var testDescription: String { name }
  }

  static let all = Verb.allCases
  static let ready = VerbGates(killSwitch: false, bodyRendered: true, hasDraft: true)

  /// 09.F: every send verb is removed while the switch is on, and the reading
  /// and completion verbs stay. Unknown is treated as on.
  static let killTable: [KillRow] = [
    KillRow(name: "armed, a rendered draft: everything", gates: ready, drawn: all),
    KillRow(
      name: "on: approve, edit, hold and reply are removed",
      gates: VerbGates(killSwitch: true, bodyRendered: true, hasDraft: true),
      drawn: [.done, .snooze, .mute, .select, .undo]),
    KillRow(
      name: "unknown: the same as on", gates: VerbGates(killSwitch: nil, bodyRendered: true, hasDraft: true),
      drawn: [.done, .snooze, .mute, .select, .undo]),
    KillRow(
      name: "paused (429): approve and reply removed, edit and hold stay",
      gates: VerbGates(killSwitch: false, paused: true, bodyRendered: true, hasDraft: true),
      drawn: [.edit, .hold, .done, .snooze, .mute, .select, .undo]),
    KillRow(
      name: "source stale: Done, Snooze and Mute never succeed against it",
      gates: VerbGates(killSwitch: false, sourceStale: true, bodyRendered: true, hasDraft: true),
      drawn: [.reply, .approve, .edit, .hold, .select, .undo]),
    KillRow(
      name: "not rendered: no approve", gates: VerbGates(killSwitch: false, bodyRendered: false, hasDraft: true),
      drawn: [.reply, .edit, .hold, .done, .snooze, .mute, .select, .undo]),
    KillRow(
      name: "an unsaved edit: no approve",
      gates: VerbGates(killSwitch: false, bodyRendered: true, hasDraft: true, unsavedEdit: true),
      drawn: [.reply, .edit, .hold, .done, .snooze, .mute, .select, .undo]),
    KillRow(
      name: "no draft: no draft verbs", gates: VerbGates(killSwitch: false),
      drawn: [.reply, .done, .snooze, .mute, .select, .undo]),
    KillRow(
      name: "Stream: no Mute", gates: VerbGates(killSwitch: false, bodyRendered: true, hasDraft: true, mode: .stream),
      drawn: [.reply, .approve, .edit, .hold, .done, .snooze, .select, .undo]),
  ]

  @Test("09.F kill table", arguments: killTable)
  func killTableRows(_ row: KillRow) {
    #expect(CompletionRules.drawn(Self.all, row.gates) == row.drawn)
  }

  @Test("the kill switch is the reason named for every send verb it removes, ahead of any other")
  func killReason() {
    let gates = VerbGates(killSwitch: true, paused: true, sourceStale: true)
    for verb in [Verb.reply, .approve, .edit, .hold] {
      #expect(CompletionRules.permit(verb, gates) == .killSwitch, "\(verb)")
    }
    #expect(CompletionRules.permit(.done, gates) == .sourceStale)
    #expect(CompletionRules.permit(.approve, VerbGates(killSwitch: false, hasDraft: true)) == .notRendered)
    #expect(
      CompletionRules.permit(.approve, VerbGates(killSwitch: false, bodyRendered: true, hasDraft: true, unsavedEdit: true))
        == .unsavedEdit)
  }

  @Test(
    "the agent undo window is send.undoGraceSeconds clamped to 5...30, 10 when unset; typed is 4",
    arguments: [
      (JSONValue.number(10), 10), (.number(0), 5), (.number(4.4), 5), (.number(5), 5), (.number(30), 30),
      (.number(300), 30), (.number(12.6), 13), (.null, 10), (.string("10"), 10), (.bool(true), 10),
    ])
  func undoClamp(_ value: JSONValue, _ expected: Int) {
    #expect(UndoWindow.agent(fromSetting: value) == expected)
  }

  @Test("undo window defaults")
  func undoDefaults() {
    #expect(UndoWindow.agent(fromSetting: nil) == 10)
    #expect(UndoWindow.typed == 4)
    #expect(UndoWindow.agentRange == 5...30)
  }
}
