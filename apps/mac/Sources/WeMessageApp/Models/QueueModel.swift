import Foundation
import Observation
import WeMessageKit

/// Boards 06 and 09's local queue state: the completion acts (Done, Snooze,
/// Mute) the user made on threads, the Triage selection, and the one-step
/// undo history. In memory only (D-UI-51): the daemon has no Done, Snooze
/// or Mute route, so nothing here is written anywhere, and reading a thread
/// is never an act (06.A: no seen, no mark-read).
@MainActor
@Observable
public final class QueueStateStore {
  public enum Kind: Equatable, Sendable {
    case done
    case snooze
    case mute
  }

  /// The newest act on each thread, by chatGuid.
  public private(set) var acts: [String: ThreadAct] = [:]
  /// The threads X has selected for a bulk act (06.F).
  public var selection: Set<String> = []
  /// The queue's size when Triage began: the burn-down's denominator.
  public private(set) var triageStart: Int?
  /// One step per gesture: a bulk act is one step, and Z takes it all back.
  private var history: [[String: ThreadAct?]] = []

  public init() {}

  public var canUndo: Bool { !history.isEmpty }

  /// Records `kind` on every thread in `guids` at `now`, as one undo step.
  public func act(_ kind: Kind, on guids: [String], at now: Date, calendar: Calendar = .current) {
    guard !guids.isEmpty else { return }
    var prior: [String: ThreadAct?] = [:]
    for guid in guids {
      prior.updateValue(acts[guid], forKey: guid)
      switch kind {
      case .done: acts[guid] = .done(at: now)
      case .snooze: acts[guid] = .snoozed(at: now, until: Self.snoozeUntil(after: now, calendar: calendar))
      case .mute: acts[guid] = .muted(at: now)
      }
    }
    history.append(prior)
    selection.subtract(guids)
  }

  /// Takes back the newest step. False when there is none.
  @discardableResult
  public func undo() -> Bool {
    guard let prior = history.popLast() else { return false }
    for (guid, act) in prior { acts[guid] = act }
    return true
  }

  public func beginTriage(count: Int) {
    if triageStart == nil { triageStart = count }
  }

  public func endTriage() {
    triageStart = nil
    selection = []
  }

  /// The earliest snooze still to return after `now`, if any.
  public func nextSnooze(after now: Date) -> Date? {
    acts.values.compactMap { act -> Date? in
      if case .snoozed(_, let until) = act, until > now { return until }
      return nil
    }.min()
  }

  /// D-UI-46: a snooze runs to the next ProvisionalUI.snoozeHour:00,
  /// strictly after `now`.
  public nonisolated static func snoozeUntil(after now: Date, calendar: Calendar = .current) -> Date {
    calendar.nextDate(
      after: now, matching: DateComponents(hour: ProvisionalUI.snoozeHour, minute: 0, second: 0),
      matchingPolicy: .nextTime) ?? now.addingTimeInterval(86_400)
  }

  /// "Monday 9:00" (06.C, 06.E).
  public nonisolated static func snoozeLabel(_ date: Date, zone: TimeZone = .current) -> String {
    ShellText.format(date, ProvisionalUI.snoozeLabelPattern, zone)
  }

  /// The zero screen's receipt (06.E): what this session did.
  public struct Receipt: Equatable, Sendable {
    public var replied = 0
    public var done = 0
    public var snoozed = 0
    public var approved = 0
    public var failed = 0

    /// "6 replied · 3 done · 1 snoozed · 2 approved · 0 failed".
    public var line: String {
      [
        "\(replied) replied", "\(done) done", "\(snoozed) snoozed", "\(approved) approved", "\(failed) failed",
      ].joined(separator: " \u{00B7} ")
    }
  }

  public nonisolated static func receipt(entries: [Outbound.Entry], acts: [String: ThreadAct]) -> Receipt {
    var r = Receipt()
    for entry in entries {
      switch (entry.intent, entry.phase) {
      case (.send, .sent): r.replied += 1
      case (.approve, .approved), (.approve, .sent): r.approved += 1
      case (_, .refused), (_, .failed), (_, .parked): r.failed += 1
      default: break
      }
    }
    for act in acts.values {
      switch act {
      case .done: r.done += 1
      case .snoozed: r.snoozed += 1
      case .muted: break
      }
    }
    return r
  }

  /// One draft the bulk confirm leaves out, and why (06.F, 09.D).
  public struct Exclusion: Equatable, Sendable {
    public var draftId: String
    public var chatGuid: String
    public var reason: VerbRefusal
  }

  /// What one bulk approve would include and leave out.
  public struct BulkPlan: Equatable, Sendable {
    public var included: [DraftPayload]
    public var excluded: [Exclusion]

    public var unopened: Int { excluded.filter { $0.reason == .notRendered }.count }
  }

  /// The bulk plan over `drafts` (one per thread in the queue): each is
  /// included only when 09.F's approve gate passes for it, so a draft whose
  /// id is not in `rendered` (never drawn), or whose thread is in
  /// `unsavedEdit`, carries its reason instead. Under the kill switch
  /// nothing is included.
  public nonisolated static func bulkPlan(
    drafts: [DraftPayload], killSwitch: Bool?, rendered: Set<String>, unsavedEdit: Set<String>
  ) -> BulkPlan {
    var plan = BulkPlan(included: [], excluded: [])
    for draft in drafts {
      let gates = VerbGates(
        killSwitch: killSwitch, bodyRendered: rendered.contains(draft.id), hasDraft: true,
        unsavedEdit: unsavedEdit.contains(draft.chatGuid))
      if let reason = CompletionRules.permit(.approve, gates) {
        plan.excluded.append(Exclusion(draftId: draft.id, chatGuid: draft.chatGuid, reason: reason))
      } else {
        plan.included.append(draft)
      }
    }
    return plan
  }

  /// The words an exclusion prints (09.D).
  public nonisolated static func reasonText(_ reason: VerbRefusal) -> String {
    switch reason {
    case .unsavedEdit: "EXCLUDED \u{00B7} you have an unsaved edit in this thread"
    case .notRendered: "Draft not yet shown to you. Not included."
    case .killSwitch: "Not included: the kill switch is on."
    case .paused: "Not included: the channel is paused."
    case .sourceStale: "Not included: the source is stale."
    case .noDraft: "Not included: no draft."
    case .streamMode: "Not included."
    }
  }
}
