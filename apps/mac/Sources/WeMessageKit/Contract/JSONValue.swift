import Foundation

/// Any JSON value. Used where the daemon defines an open shape (an adapter's
/// `config`, a setting's `value`, an error body) and by the contract tests,
/// which compare fixtures structurally rather than byte for byte.
public enum JSONValue: Equatable, Sendable, Codable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  public init(from decoder: any Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([JSONValue].self) {
      self = .array(value)
    } else {
      self = .object(try container.decode([String: JSONValue].self))
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .null:
      try container.encodeNil()
    case .bool(let value):
      try container.encode(value)
    case .number(let value):
      if let integral = Self.integral(value) {
        try container.encode(integral)
      } else {
        try container.encode(value)
      }
    case .string(let value):
      try container.encode(value)
    case .array(let value):
      try container.encode(value)
    case .object(let value):
      try container.encode(value)
    }
  }

  /// `value` as an Int64 when it is a whole number that fits, so integers
  /// round-trip as `10` and never as `10.0`.
  static func integral(_ value: Double) -> Int64? {
    guard value.isFinite, value.rounded(.towardZero) == value else { return nil }
    guard value >= -9.0e18, value <= 9.0e18 else { return nil }
    return Int64(value)
  }

  /// Parses any JSON text, top-level scalars included.
  public static func parse(_ data: Data) throws -> JSONValue {
    try JSONDecoder().decode(JSONValue.self, from: data)
  }

  /// Sorted keys, unescaped slashes, whole numbers without a fraction: two
  /// equal values always produce the same bytes.
  public func canonicalData() throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return try encoder.encode(self)
  }

  /// The member `key` of an object; nil for a missing key or a non-object.
  public subscript(key: String) -> JSONValue? {
    guard case .object(let fields) = self else { return nil }
    return fields[key]
  }

  public var stringValue: String? {
    guard case .string(let value) = self else { return nil }
    return value
  }

  /// The number as an Int, only when it is a whole number in range.
  public var intValue: Int? {
    guard case .number(let value) = self, value.isFinite, value.rounded(.towardZero) == value else {
      return nil
    }
    guard value >= -9.0e18, value <= 9.0e18 else { return nil }
    return Int(value)
  }

  public var doubleValue: Double? {
    guard case .number(let value) = self else { return nil }
    return value
  }

  public var boolValue: Bool? {
    guard case .bool(let value) = self else { return nil }
    return value
  }

  public var arrayValue: [JSONValue]? {
    guard case .array(let value) = self else { return nil }
    return value
  }

  public var objectValue: [String: JSONValue]? {
    guard case .object(let value) = self else { return nil }
    return value
  }
}

extension JSONValue: CustomStringConvertible {
  /// The canonical JSON text, for readable test failures and logs.
  public var description: String {
    guard let data = try? canonicalData() else { return "<unencodable JSON>" }
    return String(decoding: data, as: UTF8.self)
  }
}

extension JSONValue: ExpressibleByNilLiteral {
  public init(nilLiteral: ()) {
    self = .null
  }
}

extension JSONValue: ExpressibleByBooleanLiteral {
  public init(booleanLiteral value: Bool) {
    self = .bool(value)
  }
}

extension JSONValue: ExpressibleByIntegerLiteral {
  public init(integerLiteral value: Int) {
    self = .number(Double(value))
  }
}

extension JSONValue: ExpressibleByFloatLiteral {
  public init(floatLiteral value: Double) {
    self = .number(value)
  }
}

extension JSONValue: ExpressibleByStringLiteral {
  public init(stringLiteral value: String) {
    self = .string(value)
  }
}

extension JSONValue: ExpressibleByArrayLiteral {
  public init(arrayLiteral elements: JSONValue...) {
    self = .array(elements)
  }
}

extension JSONValue: ExpressibleByDictionaryLiteral {
  public init(dictionaryLiteral elements: (String, JSONValue)...) {
    self = .object(Dictionary(elements, uniquingKeysWith: { _, last in last }))
  }
}
