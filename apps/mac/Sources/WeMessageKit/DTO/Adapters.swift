import Foundation

public enum AdapterKind: String, Codable, CaseIterable, Equatable, Sendable {
  case sol, hermes, luna, openclaw, echo, generic
}

public enum AdapterHealth: String, Codable, CaseIterable, Equatable, Sendable {
  case unknown, connected, disconnected, unhealthy
}

/// One registered adapter. Never carries token material: `hasToken` is a
/// boolean by design on the daemon side.
public struct AdapterPayload: Codable, Equatable, Sendable {
  public var id: String
  public var kind: AdapterKind
  public var displayName: String
  public var enabled: Bool
  public var hasToken: Bool
  public var health: AdapterHealth
  public var lastSeenAt: String?
  /// Free-form, adapter-defined: an open JSON object.
  public var config: [String: JSONValue]

  enum CodingKeys: String, CodingKey, CaseIterable {
    case id, kind, displayName, enabled, hasToken, health, lastSeenAt, config
  }
}

extension AdapterPayload {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    kind = try c.decode(AdapterKind.self, forKey: .kind)
    displayName = try c.decode(String.self, forKey: .displayName)
    enabled = try c.decode(Bool.self, forKey: .enabled)
    hasToken = try c.decode(Bool.self, forKey: .hasToken)
    health = try c.decode(AdapterHealth.self, forKey: .health)
    lastSeenAt = try c.decodeIfPresent(String.self, forKey: .lastSeenAt)
    config = try c.decode([String: JSONValue].self, forKey: .config)
  }
}

public struct AdapterEnvelope: Codable, Equatable, Sendable {
  public var adapter: AdapterPayload

  enum CodingKeys: String, CodingKey, CaseIterable {
    case adapter
  }
}

extension AdapterEnvelope {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    adapter = try c.decode(AdapterPayload.self, forKey: .adapter)
  }
}

public struct AdaptersEnvelope: Codable, Equatable, Sendable {
  public var adapters: [AdapterPayload]

  enum CodingKeys: String, CodingKey, CaseIterable {
    case adapters
  }
}

extension AdaptersEnvelope {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    adapters = try c.decode([AdapterPayload].self, forKey: .adapters)
  }
}

/// The one response that carries plaintext token material (create and
/// rotate). The token is kept so the caller can show it once, and encodes
/// raw because it is the daemon's own payload; every description and the
/// reflection mirror redact it, including where `connectCmd` embeds it.
public struct AdapterCredential: Codable, Equatable, Sendable {
  public var adapter: AdapterPayload
  public var token: String
  public var connectCmd: String

  enum CodingKeys: String, CodingKey, CaseIterable {
    case adapter, token, connectCmd
  }

  /// `connectCmd` with the token replaced by the redaction marker.
  public var redactedConnectCmd: String {
    token.isEmpty ? connectCmd : connectCmd.replacingOccurrences(of: token, with: BearerToken.redacted)
  }
}

extension AdapterCredential {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    adapter = try c.decode(AdapterPayload.self, forKey: .adapter)
    token = try c.decode(String.self, forKey: .token)
    connectCmd = try c.decode(String.self, forKey: .connectCmd)
  }
}

extension AdapterCredential: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String {
    "AdapterCredential(adapter: \(adapter.id), token: \(BearerToken.redacted), connectCmd: \(redactedConnectCmd))"
  }

  public var debugDescription: String { description }

  public var customMirror: Mirror {
    Mirror(
      self,
      children: [
        "adapter": adapter.id as Any, "token": BearerToken.redacted as Any, "connectCmd": redactedConnectCmd as Any,
      ],
      displayStyle: .struct)
  }
}

// MARK: requests

/// `POST /v1/adapters`.
public struct AdapterInput: Equatable, Sendable {
  public var id: String
  public var kind: AdapterKind
  public var displayName: String
  public var config: [String: JSONValue]?

  public init(id: String, kind: AdapterKind, displayName: String, config: [String: JSONValue]? = nil) {
    self.id = id
    self.kind = kind
    self.displayName = displayName
    self.config = config
  }

  var json: JSONValue {
    var fields: [String: JSONValue] = [
      "id": .string(id), "kind": .string(kind.rawValue), "displayName": .string(displayName),
    ]
    if let config { fields["config"] = .object(config) }
    return .object(fields)
  }
}

/// `PATCH /v1/adapters/:id`. Nil leaves a field alone.
public struct AdapterPatch: Equatable, Sendable {
  public var enabled: Bool?
  public var displayName: String?
  public var config: [String: JSONValue]?

  public init(enabled: Bool? = nil, displayName: String? = nil, config: [String: JSONValue]? = nil) {
    self.enabled = enabled
    self.displayName = displayName
    self.config = config
  }

  var json: JSONValue {
    var fields: [String: JSONValue] = [:]
    if let enabled { fields["enabled"] = .bool(enabled) }
    if let displayName { fields["displayName"] = .string(displayName) }
    if let config { fields["config"] = .object(config) }
    return .object(fields)
  }
}
