import Foundation

/// What the app knows: the drafts queue in the daemon's order, the stream's
/// status, and how fresh the queue is.
public struct AppState: Equatable, Sendable {
  /// Drafts by id.
  public var drafts: [String: DraftPayload] = [:]
  /// Draft ids in the order the daemon listed them.
  public var order: [String] = []
  /// The event stream's status; nil until the stream reports one.
  public var stream: StreamStatus?
  /// Audit rows the last snapshot's gap covered.
  public var missed = 0
  /// The last frame's sequence number.
  public var lastSeq = 0
  /// When the last snapshot was taken.
  public var syncedAt: String?
  /// True when an event named something the queue does not reflect, until a
  /// snapshot or a drafts response replaces the queue.
  public var stale = false

  public init() {}

  /// The drafts in queue order.
  public var queue: [DraftPayload] {
    order.compactMap { drafts[$0] }
  }

  /// Replaces the queue with `list`, keeping its order. A repeated id keeps
  /// its first position and its last payload.
  mutating func replaceDrafts(_ list: [DraftPayload]) {
    var byId: [String: DraftPayload] = [:]
    var ids: [String] = []
    for draft in list {
      if byId.updateValue(draft, forKey: draft.id) == nil { ids.append(draft.id) }
    }
    drafts = byId
    order = ids
  }
}
