import Foundation

/// One typed event from /v1/events/sse. Every name in wire.json has a case.
/// A name the kit does not know decodes to `.unknown(name:)` without its data
/// being read, so a newer daemon never breaks an older app; a known name
/// whose data does not match its shape throws.
public enum GatewayEvent: Equatable, Sendable, Encodable {
  case adapterHealth(AdapterHealthEvent)
  case armingChanged(ArmingChangedEvent)
  case connectionState(ConnectionStateEvent)
  case draftApproved(DraftActorEvent)
  case draftCreated(DraftCreatedEvent)
  case draftDelta(DraftDeltaEvent)
  case draftExpired(DraftIdEvent)
  case draftFailed(DraftFailedEvent)
  case draftRecalled(DraftActorEvent)
  case draftRedrafted(DraftRedraftedEvent)
  case draftRejected(DraftActorEvent)
  case draftRequeued(DraftIdEvent)
  case draftSent(DraftSentEvent)
  case draftSuperseded(DraftSupersededEvent)
  case gateDenied(GateDeniedEvent)
  case gatewayDisconnected(GatewayDisconnectedEvent)
  case messageEdited(MessageEditedEvent)
  case messageReceived(MessageReceivedEvent)
  case messageUnsent(MessageUnsentEvent)
  case ruleMatched(RuleMatchedEvent)
  case threadState(ThreadStateEvent)
  case toggleChanged(ToggleChangedEvent)
  case unknown(name: String)

  /// Decodes one SSE frame: its `event:` names the shape, its data is the
  /// JSON payload.
  public init(frame: SSEFrame) throws {
    self = try Self.decode(name: frame.event, data: Data(frame.data.utf8))
  }

  /// The wire name for a known event; nil for `.unknown`.
  public var eventName: EventName? {
    switch self {
    case .adapterHealth: return .adapterHealth
    case .armingChanged: return .armingChanged
    case .connectionState: return .connectionState
    case .draftApproved: return .draftApproved
    case .draftCreated: return .draftCreated
    case .draftDelta: return .draftDelta
    case .draftExpired: return .draftExpired
    case .draftFailed: return .draftFailed
    case .draftRecalled: return .draftRecalled
    case .draftRedrafted: return .draftRedrafted
    case .draftRejected: return .draftRejected
    case .draftRequeued: return .draftRequeued
    case .draftSent: return .draftSent
    case .draftSuperseded: return .draftSuperseded
    case .gateDenied: return .gateDenied
    case .gatewayDisconnected: return .gatewayDisconnected
    case .messageEdited: return .messageEdited
    case .messageReceived: return .messageReceived
    case .messageUnsent: return .messageUnsent
    case .ruleMatched: return .ruleMatched
    case .threadState: return .threadState
    case .toggleChanged: return .toggleChanged
    case .unknown: return nil
    }
  }

  /// The event's name as the frame spelled it.
  public var name: String {
    if case .unknown(let name) = self { return name }
    return eventName?.rawValue ?? ""
  }

  /// Decodes `data` as the event `name`. The payload's own `event` member
  /// must repeat the name; the rest decodes strictly into the name's shape.
  /// Every failure is a GatewayError.
  public static func decode(name: String, data: Data) throws -> GatewayEvent {
    guard let known = EventName(rawValue: name) else { return .unknown(name: name) }
    do {
      guard case .object(var fields) = try JSONValue.parse(data) else {
        throw GatewayError.decoding(path: "", underlying: "an event payload is a JSON object")
      }
      guard fields["event"] == .string(name) else {
        throw GatewayError.decoding(path: "event", underlying: "the payload's event member is not \"\(name)\"")
      }
      fields["event"] = nil
      return try typed(known, from: try JSONValue.object(fields).canonicalData())
    } catch {
      throw GatewayError.wrap(error)
    }
  }

  private static func typed(_ name: EventName, from data: Data) throws -> GatewayEvent {
    let decoder = JSONDecoder()
    func payload<T: Decodable>(_ type: T.Type) throws -> T {
      try decoder.decode(type, from: data)
    }
    switch name {
    case .adapterHealth: return .adapterHealth(try payload(AdapterHealthEvent.self))
    case .armingChanged: return .armingChanged(try payload(ArmingChangedEvent.self))
    case .connectionState: return .connectionState(try payload(ConnectionStateEvent.self))
    case .draftApproved: return .draftApproved(try payload(DraftActorEvent.self))
    case .draftCreated: return .draftCreated(try payload(DraftCreatedEvent.self))
    case .draftDelta: return .draftDelta(try payload(DraftDeltaEvent.self))
    case .draftExpired: return .draftExpired(try payload(DraftIdEvent.self))
    case .draftFailed: return .draftFailed(try payload(DraftFailedEvent.self))
    case .draftRecalled: return .draftRecalled(try payload(DraftActorEvent.self))
    case .draftRedrafted: return .draftRedrafted(try payload(DraftRedraftedEvent.self))
    case .draftRejected: return .draftRejected(try payload(DraftActorEvent.self))
    case .draftRequeued: return .draftRequeued(try payload(DraftIdEvent.self))
    case .draftSent: return .draftSent(try payload(DraftSentEvent.self))
    case .draftSuperseded: return .draftSuperseded(try payload(DraftSupersededEvent.self))
    case .gateDenied: return .gateDenied(try payload(GateDeniedEvent.self))
    case .gatewayDisconnected: return .gatewayDisconnected(try payload(GatewayDisconnectedEvent.self))
    case .messageEdited: return .messageEdited(try payload(MessageEditedEvent.self))
    case .messageReceived: return .messageReceived(try payload(MessageReceivedEvent.self))
    case .messageUnsent: return .messageUnsent(try payload(MessageUnsentEvent.self))
    case .ruleMatched: return .ruleMatched(try payload(RuleMatchedEvent.self))
    case .threadState: return .threadState(try payload(ThreadStateEvent.self))
    case .toggleChanged: return .toggleChanged(try payload(ToggleChangedEvent.self))
    }
  }

  /// The payload's members plus `event`, the shape the frame carried.
  public func encode(to encoder: any Encoder) throws {
    switch self {
    case .adapterHealth(let payload): try payload.encode(to: encoder)
    case .armingChanged(let payload): try payload.encode(to: encoder)
    case .connectionState(let payload): try payload.encode(to: encoder)
    case .draftApproved(let payload): try payload.encode(to: encoder)
    case .draftCreated(let payload): try payload.encode(to: encoder)
    case .draftDelta(let payload): try payload.encode(to: encoder)
    case .draftExpired(let payload): try payload.encode(to: encoder)
    case .draftFailed(let payload): try payload.encode(to: encoder)
    case .draftRecalled(let payload): try payload.encode(to: encoder)
    case .draftRedrafted(let payload): try payload.encode(to: encoder)
    case .draftRejected(let payload): try payload.encode(to: encoder)
    case .draftRequeued(let payload): try payload.encode(to: encoder)
    case .draftSent(let payload): try payload.encode(to: encoder)
    case .draftSuperseded(let payload): try payload.encode(to: encoder)
    case .gateDenied(let payload): try payload.encode(to: encoder)
    case .gatewayDisconnected(let payload): try payload.encode(to: encoder)
    case .messageEdited(let payload): try payload.encode(to: encoder)
    case .messageReceived(let payload): try payload.encode(to: encoder)
    case .messageUnsent(let payload): try payload.encode(to: encoder)
    case .ruleMatched(let payload): try payload.encode(to: encoder)
    case .threadState(let payload): try payload.encode(to: encoder)
    case .toggleChanged(let payload): try payload.encode(to: encoder)
    case .unknown: break
    }
    var container = encoder.container(keyedBy: AnyKey.self)
    try container.encode(name, forKey: AnyKey(stringValue: "event"))
  }
}
