import Foundation

/// The wire version this kit speaks (fixtures/contract/wire.json `wireVersion`).
public enum WireVersion {
  public static let current = 1
}

/// Every event the daemon publishes, in wire.json `eventNames` order. The raw
/// value is the SSE `event:` field and the JSON `event` member.
public enum EventName: String, CaseIterable, Codable, Hashable, Sendable {
  case adapterHealth = "adapter.health"
  case armingChanged = "arming.changed"
  case connectionState = "connection.state"
  case draftApproved = "draft.approved"
  case draftCreated = "draft.created"
  case draftDelta = "draft.delta"
  case draftExpired = "draft.expired"
  case draftFailed = "draft.failed"
  case draftRecalled = "draft.recalled"
  case draftRedrafted = "draft.redrafted"
  case draftRejected = "draft.rejected"
  case draftRequeued = "draft.requeued"
  case draftSent = "draft.sent"
  case draftSuperseded = "draft.superseded"
  case gateDenied = "gate.denied"
  case gatewayDisconnected = "gateway.disconnected"
  case messageEdited = "message.edited"
  case messageReceived = "message.received"
  case messageUnsent = "message.unsent"
  case ruleMatched = "rule.matched"
  /// v2 F3: a conversation's Done, Snooze or Mute record changed.
  case threadState = "thread.state"
  case toggleChanged = "toggle.changed"
}

/// A draft's lifecycle state, in wire.json `draftStates` order.
public enum DraftState: String, CaseIterable, Codable, Hashable, Sendable {
  case pending
  case approved
  case sending
  case sent
  case rejected
  case expired
  case superseded
  case recalled
  case failed
}

/// wire.json `sse` and `defaults`.
public enum Defaults {
  /// The daemon's loopback port when WEMESSAGE_PORT is unset or unusable.
  public static let port = 47100
  /// The bearer token's file name inside the config directory.
  public static let tokenFile = "daemon.token"
  /// The server-sent events route.
  public static let ssePath = "/v1/events/sse"
  /// How often the daemon writes an SSE comment to keep the stream open.
  public static let keepaliveMs = 15000
}
