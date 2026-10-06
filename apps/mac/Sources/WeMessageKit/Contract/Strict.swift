import Foundation

/// Any string key: reads the raw member names of a JSON object.
struct AnyKey: CodingKey {
  var stringValue: String
  var intValue: Int?

  init(stringValue: String) {
    self.stringValue = stringValue
    self.intValue = nil
  }

  init?(intValue: Int) {
    self.stringValue = String(intValue)
    self.intValue = intValue
  }
}

extension Decoder {
  /// The one strict-decoding helper every DTO goes through: the keyed
  /// container for `Key`, after refusing any member the type does not name.
  /// A refusal is a `DecodingError.dataCorrupted` whose path ends at the
  /// unknown member and whose description quotes it.
  func strictContainer<Key: CodingKey & CaseIterable>(
    keyedBy type: Key.Type
  ) throws -> KeyedDecodingContainer<Key> {
    try strictContainer(keyedBy: type, allowing: Array(Key.allCases))
  }

  /// The same, for a type whose allowed members depend on a discriminator
  /// (a matcher's or an actor's `kind`).
  func strictContainer<Key: CodingKey>(
    keyedBy type: Key.Type,
    allowing allowed: [Key]
  ) throws -> KeyedDecodingContainer<Key> {
    let raw = try container(keyedBy: AnyKey.self)
    let known = Set(allowed.map(\.stringValue))
    for name in raw.allKeys.map(\.stringValue).sorted() where !known.contains(name) {
      throw DecodingError.dataCorrupted(
        DecodingError.Context(
          codingPath: codingPath + [AnyKey(stringValue: name)],
          debugDescription: "unknown key \"\(name)\""
        )
      )
    }
    return try container(keyedBy: type)
  }
}

/// A patch field that can be set to a value or explicitly cleared to null.
/// `nil` (the Swift optional around it) means "leave it alone".
public enum Nullable<Wrapped: Equatable & Sendable>: Equatable, Sendable {
  case value(Wrapped)
  case null
}

extension Nullable where Wrapped == String {
  var json: JSONValue {
    switch self {
    case .value(let value): return .string(value)
    case .null: return .null
    }
  }
}

extension DecodingError {
  /// Where decoding failed, as a dotted path ("draft.zzUnknown"). Array
  /// positions render as their index; a missing key is appended.
  var renderedPath: String {
    let path: [any CodingKey]
    switch self {
    case .keyNotFound(let key, let context):
      path = context.codingPath + [key]
    case .typeMismatch(_, let context), .valueNotFound(_, let context), .dataCorrupted(let context):
      path = context.codingPath
    @unknown default:
      path = []
    }
    return path.map { key in key.intValue.map(String.init) ?? key.stringValue }.joined(separator: ".")
  }

  /// The decoder's own explanation.
  var summary: String {
    switch self {
    case .keyNotFound(let key, _):
      return "missing key \"\(key.stringValue)\""
    case .typeMismatch(_, let context), .valueNotFound(_, let context), .dataCorrupted(let context):
      return context.debugDescription
    @unknown default:
      return String(describing: self)
    }
  }
}
