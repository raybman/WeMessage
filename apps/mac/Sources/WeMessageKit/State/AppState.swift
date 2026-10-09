import Foundation

/// What the app knows: the drafts queue in the daemon's order, the stream's
/// status, how fresh the queue is, and which channels it may read.
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
  /// What the app may do with each channel, derived from the last status
  /// read (v2 B0). Every channel is not connected until a status says
  /// otherwise.
  public var channels: [Channel: ChannelAvailability] = ChannelAvailability.table(nil, gate: .closed)
  /// The door to the fixture state: closed unless the app opened it under
  /// its UI-test flag.
  public let previewGate: PreviewGate

  public init(previewGate: PreviewGate = .closed) {
    self.previewGate = previewGate
  }

  /// One channel's availability.
  public func availability(_ channel: Channel) -> ChannelAvailability {
    channels[channel] ?? .notConnected(reason: .notInThisVersion)
  }

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
