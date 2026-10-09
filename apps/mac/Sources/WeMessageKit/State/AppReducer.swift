import Foundation

/// The pure reducer, ported from the v1 desktop renderer's optimistic store
/// (deleted in v2 S6c). It performs no work: what
/// it needs from the daemon it returns as effects.
///
/// A draft's state change moves the draft it names. An event the queue cannot
/// apply on its own (a new draft arrives as a summary, a redraft replaces a
/// card, a supersede brings a successor, a change names a draft the store
/// does not hold) marks the queue stale and asks for the drafts list, once,
/// until a snapshot or a drafts response clears it. Events that are not a
/// draft's state change leave the queue alone; an event the kit does not know
/// is dropped with a log effect.
public enum AppReducer {
  public static func reduce(_ state: AppState, _ action: AppAction) -> (AppState, [Effect]) {
    var next = state
    switch action {
    case .status(let status):
      next.stream = status
      return (next, [])
    case .response(.drafts(let list)):
      next.replaceDrafts(list)
      next.stale = false
      return (next, [])
    case .response(.status(let payload)):
      next.channels = ChannelAvailability.table(payload.channels, gate: next.previewGate)
      return (next, [])
    case .frame(.snapshot(let seq, let at, let missed, let drafts)):
      next.replaceDrafts(drafts)
      next.missed = missed
      next.syncedAt = at
      next.lastSeq = seq
      next.stale = false
      return (next, [])
    case .frame(.event(let seq, let event)):
      next.lastSeq = seq
      let effects = apply(event, to: &next)
      return (next, effects)
    }
  }

  private static func apply(_ event: GatewayEvent, to state: inout AppState) -> [Effect] {
    switch event {
    case .draftApproved(let change):
      return move(change.draftId, to: .approved, in: &state)
    case .draftRejected(let change):
      return move(change.draftId, to: .rejected, in: &state)
    case .draftRecalled(let change):
      return move(change.draftId, to: .recalled, in: &state)
    case .draftExpired(let change):
      return move(change.draftId, to: .expired, in: &state)
    case .draftRequeued(let change):
      return move(change.draftId, to: .pending, in: &state)
    case .draftSent(let change):
      return move(change.draftId, to: .sent, in: &state) { $0.sentMessageGuid = change.sentMessageGuid }
    case .draftFailed(let change):
      return move(change.draftId, to: .failed, in: &state) { $0.error = change.error }
    case .draftSuperseded(let change):
      state.drafts[change.draftId]?.state = .superseded
      return markStale(&state)
    case .draftRedrafted(let change):
      state.drafts[change.draftId] = nil
      state.order.removeAll { $0 == change.draftId }
      return markStale(&state)
    case .draftCreated:
      return markStale(&state)
    case .unknown(let name):
      return [.log(.droppedEvent(name: name))]
    case .adapterHealth, .armingChanged, .connectionState, .draftDelta, .gateDenied, .gatewayDisconnected,
      .messageEdited, .messageReceived, .messageUnsent, .ruleMatched, .toggleChanged:
      return []
    }
  }

  /// Moves a held draft to `target`; a draft the store does not hold marks
  /// the queue stale instead.
  private static func move(
    _ id: String,
    to target: DraftState,
    in state: inout AppState,
    also: (inout DraftPayload) -> Void = { _ in }
  ) -> [Effect] {
    guard var draft = state.drafts[id] else { return markStale(&state) }
    draft.state = target
    also(&draft)
    state.drafts[id] = draft
    return []
  }

  /// Asks for the drafts list on the first stale mark only.
  private static func markStale(_ state: inout AppState) -> [Effect] {
    if state.stale { return [] }
    state.stale = true
    return [.listDrafts]
  }
}
