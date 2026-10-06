import Foundation

public enum SettingType: String, Codable, CaseIterable, Equatable, Sendable {
  case int
  case bool
  case iso
  case `enum`
}

/// One setting. The settings map itself is open (its keys are setting names,
/// which are data); each entry is closed and decodes strictly.
public struct SettingEntry: Codable, Equatable, Sendable {
  /// A number, a boolean, a string or null.
  public var value: JSONValue
  public var `default`: JSONValue
  /// -1 means never written: the value shown is the default.
  public var version: Int
  public var type: SettingType
  public var readOnly: Bool
  public var floor: Double?
  public var ceiling: Double?
  /// Present on a read-only key: the route that owns it.
  public var use: String?

  enum CodingKeys: String, CodingKey, CaseIterable {
    case value, `default`, version, type, readOnly, floor, ceiling, use
  }
}

extension SettingEntry {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    value = try c.decode(JSONValue.self, forKey: .value)
    self.default = try c.decode(JSONValue.self, forKey: .default)
    version = try c.decode(Int.self, forKey: .version)
    type = try c.decode(SettingType.self, forKey: .type)
    readOnly = try c.decode(Bool.self, forKey: .readOnly)
    floor = try c.decodeIfPresent(Double.self, forKey: .floor)
    ceiling = try c.decodeIfPresent(Double.self, forKey: .ceiling)
    use = try c.decodeIfPresent(String.self, forKey: .use)
  }
}

public struct SettingsEnvelope: Codable, Equatable, Sendable {
  public var settings: [String: SettingEntry]

  enum CodingKeys: String, CodingKey, CaseIterable {
    case settings
  }
}

extension SettingsEnvelope {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    settings = try c.decode([String: SettingEntry].self, forKey: .settings)
  }
}

public struct SettingsPatchResult: Codable, Equatable, Sendable {
  public var settings: [String: SettingEntry]
  /// Only the keys whose value moved; a no-op patch returns [].
  public var changed: [String]

  enum CodingKeys: String, CodingKey, CaseIterable {
    case settings, changed
  }
}

extension SettingsPatchResult {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    settings = try c.decode([String: SettingEntry].self, forKey: .settings)
    changed = try c.decode([String].self, forKey: .changed)
  }
}

/// What a caller may write. Null is not writable on any key.
public enum SettingPatchValue: Equatable, Sendable {
  case int(Int)
  case bool(Bool)
  case string(String)

  var json: JSONValue {
    switch self {
    case .int(let value): return .number(Double(value))
    case .bool(let value): return .bool(value)
    case .string(let value): return .string(value)
    }
  }
}
