import Foundation
import Observation
import WeMessageKit

/// Boards 06 and 09's queue state: the completion acts (Done, Snooze,
/// Mute) on threads, the Triage selection, and the one-step undo history.
/// v2 F3 (G-06a): the daemon keeps the acts (`PUT /v1/threads/:guid/state`)
/// and this store is a cache over that record. An act is drawn at once and
/// written through behind it, one write at a time; a refused or failed
/// write rolls the act back and says D-UI-191, a 409 (another window acted
/// first) re-reads the record that won and says D-UI-193, and success says
/// nothing (D-UI-192). Reading a thread is never an act (06.A: no seen, no
/// mark-read), so nothing here writes on a read.
@MainActor
@Observable
public final class QueueStateStore {
  public enum Kind: Equatable, Sendable {
    case done
    case snooze
    case mute
  }

  /// Why the last write did not land, while its line is up.
  public enum Failure: Equatable, Sendable {
    case refused
    case conflict
  }

  /// The newest act on each thread, by chatGuid.
  public private(set) var acts: [String: ThreadAct] = [:]
  /// The attention the daemon stores for a thread; absent is the derived
  /// default. Read only: F3 draws no picker (D-F3-4).
  public private(set) var modes: [String: ThreadMode] = [:]
  /// The threads X has selected for a bulk act (06.F).
  public var selection: Set<String> = []
  /// The queue's size when Triage began: the burn-down's denominator.
  public private(set) var triageStart: Int?
  /// The last write that did not land, cleared after D-UI-191's seconds.
  public private(set) var failure: Failure?

  /// One step per gesture: a bulk act is one step, and Z takes it all back.
  private var history: [[String: ThreadAct?]] = []
  private let sync: any ThreadStateSync
  /// The daemon's updatedAt for each stored record, sent back as ifUpdatedAt.
  private var stamps: [String: String] = [:]
  /// What the daemon last confirmed, from any source: a refusal rolls back
  /// to this.
  private var confirmed: [String: ThreadAct] = [:]
  /// What the daemon held that this window did not do (hydrate, another
  /// window's frame, a conflict's winner): the receipt does not count it.
  private var baseline: [String: ThreadAct] = [:]
  /// Writes queued or running, by chatGuid: a frame for one of these waits.
  private var inFlight: [String: Int] = [:]
  /// Bumped on a rollback or conflict, so writes queued on an act that
  /// never landed are dropped.
  private var generation: [String: Int] = [:]
  private var tail: Task<Void, Never>?
  private var failureSerial = 0

  public init(sync: any ThreadStateSync = InMemoryThreadStateSync()) {
    self.sync = sync
  }

  public var canUndo: Bool { !history.isEmpty }

  /// The acts this window made and the daemon has not since replaced: the
  /// zero screen's receipt counts these, never a hydrated act (06.E).
  public var sessionActs: [String: ThreadAct] {
    acts.filter { baseline[$0.key] != $0.value }
  }

  /// D-UI-191 or D-UI-193 while a failure is up, else nil (D-UI-192).
  public var failureLine: String? {
    switch failure {
    case .refused: ProvisionalUI.threadStateRefusedLine
    case .conflict: ProvisionalUI.threadStateConflictLine
    case nil: nil
    }
  }

  /// Records `kind` on every thread in `guids` at `now`, as one undo step,
  /// and writes each through.
  public func act(_ kind: Kind, on guids: [String], at now: Date, calendar: Calendar = .current) {
    guard !guids.isEmpty else { return }
    var prior: [String: ThreadAct?] = [:]
    for guid in guids {
      prior.updateValue(acts[guid], forKey: guid)
      let act: ThreadAct
      switch kind {
      case .done: act = .done(at: now)
      case .snooze: act = .snoozed(at: now, until: Self.snoozeUntil(after: now, calendar: calendar))
      case .mute: act = .muted(at: now)
      }
      acts[guid] = act
      enqueue(guid, act, restore: false)
    }
    history.append(prior)
    selection.subtract(guids)
  }

  /// Takes back the newest step, and writes the prior record back with its
  /// own instant (or clears a first act). False when there is none.
  @discardableResult
  public func undo() -> Bool {
    guard let prior = history.popLast() else { return false }
    for (guid, act) in prior.sorted(by: { $0.key < $1.key }) {
      acts[guid] = act
      enqueue(guid, act, restore: true)
    }
    return true
  }

  /// Waits for every queued write to finish.
  public func settle() async {
    while let current = tail {
      await current.value
      if tail == current { return }
    }
  }

  /// Replaces the cache with the daemon's record (on connect, reconnect and
  /// refresh). A thread with a write in flight keeps its own act; a record
  /// whose stamp this window already holds is its own write. A read that
  /// fails changes nothing and draws nothing.
  public func hydrate() async {
    guard let records = try? await sync.load() else { return }
    for (guid, state) in records where inFlight[guid] == nil && stamps[guid] != state.updatedAt {
      take(guid, state)
    }
    let known = Set(acts.keys).union(stamps.keys).union(confirmed.keys)
    for guid in known where records[guid] == nil && inFlight[guid] == nil {
      take(guid, nil)
    }
  }

  /// A `thread.state` frame: another window's act, or the echo of this one's.
  /// Ignored while this window has a write in flight for the thread, and
  /// when it is not newer than the record this window holds.
  public func apply(_ record: ThreadStateRecord?, guid: String) {
    guard inFlight[guid] == nil else { return }
    guard let record else {
      take(guid, nil)
      return
    }
    if let held = stamps[guid], !Self.newer(record.updatedAt, than: held) { return }
    take(guid, record.synced)
  }

  /// Sets everything this window holds for `guid` to the daemon's record.
  private func take(_ guid: String, _ state: SyncedThreadState?) {
    acts[guid] = state?.act
    confirmed[guid] = state?.act
    baseline[guid] = state?.act
    stamps[guid] = state?.updatedAt
    modes[guid] = state?.mode
  }

  private static func newer(_ a: String, than b: String) -> Bool {
    guard let x = WireDate.parse(a), let y = WireDate.parse(b) else { return a > b }
    return x > y
  }

  private func enqueue(_ guid: String, _ act: ThreadAct?, restore: Bool) {
    inFlight[guid, default: 0] += 1
    let gen = generation[guid, default: 0]
    let previous = tail
    tail = Task { [weak self] in
      await previous?.value
      await self?.perform(guid, act, restore: restore, generation: gen)
    }
  }

  private func perform(_ guid: String, _ act: ThreadAct?, restore: Bool, generation gen: Int) async {
    defer { finish(guid) }
    // A rollback or conflict since this write was queued: its act is gone.
    guard generation[guid, default: 0] == gen else { return }
    do {
      switch try await sync.write(guid, act: act, expected: stamps[guid], restore: restore) {
      case .ok(let stamp):
        stamps[guid] = stamp
        confirmed[guid] = act
        if stamp == nil { modes[guid] = nil }
      case .refused(.conflict):
        generation[guid, default: 0] += 1
        if let records = try? await sync.load() {
          take(guid, records[guid])
        } else {
          acts[guid] = confirmed[guid]
        }
        fail(.conflict)
      case .refused:
        rollBack(guid)
      }
    } catch {
      rollBack(guid)
    }
  }

  private func rollBack(_ guid: String) {
    generation[guid, default: 0] += 1
    acts[guid] = confirmed[guid]
    fail(.refused)
  }

  private func finish(_ guid: String) {
    let left = (inFlight[guid] ?? 1) - 1
    inFlight[guid] = left > 0 ? left : nil
  }

  private func fail(_ kind: Failure) {
    failure = kind
    failureSerial += 1
    let serial = failureSerial
    Task { [weak self] in
      try? await Task.sleep(for: .seconds(ProvisionalUI.threadStateFailureSeconds))
      guard let self, self.failureSerial == serial else { return }
      self.failure = nil
    }
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
