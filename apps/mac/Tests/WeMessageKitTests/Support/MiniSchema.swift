import Foundation
@testable import WeMessageKit

/// A JSON Schema checker for exactly the keywords the S0 request schemas use
/// (fixtures/contract/requests/*.schema.json). A keyword outside that set
/// THROWS instead of passing silently: a schema that grows a new rule fails the
/// contract row loudly until this checker learns the rule.
enum MiniSchema {
  struct Unsupported: Error, CustomStringConvertible {
    let detail: String
    var description: String { detail }
  }

  static let keywords: Set<String> = [
    "$schema", "additionalProperties", "anyOf", "const", "default", "enum",
    "exclusiveMinimum", "format", "items", "maxLength", "maximum", "minItems",
    "minLength", "minimum", "pattern", "properties", "propertyNames", "required", "type",
  ]

  /// Walks the whole schema, nested schemas included, and throws on the first
  /// keyword (or format) this checker does not implement.
  static func audit(_ schema: JSONValue, at path: String = "$") throws {
    switch schema {
    case .bool:
      return
    case .object(let fields):
      for key in fields.keys.sorted() {
        guard keywords.contains(key) else {
          throw Unsupported(detail: "\(path): keyword \(key) is not implemented by MiniSchema")
        }
        let value = fields[key]!
        switch key {
        case "properties":
          guard let props = value.objectValue else {
            throw Unsupported(detail: "\(path).properties: not an object")
          }
          for name in props.keys.sorted() {
            try audit(props[name]!, at: "\(path).properties.\(name)")
          }
        case "additionalProperties", "items", "propertyNames":
          try audit(value, at: "\(path).\(key)")
        case "anyOf":
          guard let options = value.arrayValue else {
            throw Unsupported(detail: "\(path).anyOf: not an array")
          }
          for (index, option) in options.enumerated() {
            try audit(option, at: "\(path).anyOf[\(index)]")
          }
        case "format":
          guard value.stringValue == "date-time" else {
            throw Unsupported(detail: "\(path): format \(value) is not implemented by MiniSchema")
          }
        default:
          break
        }
      }
    default:
      throw Unsupported(detail: "\(path): a schema is an object or a boolean")
    }
  }

  /// Every way `instance` breaks `schema`, as readable lines; empty means valid.
  static func violations(of instance: JSONValue, against schema: JSONValue, at path: String = "$") throws -> [String] {
    let rules: [String: JSONValue]
    switch schema {
    case .bool(let accepts):
      return accepts ? [] : ["\(path): refused by a false schema"]
    case .object(let fields):
      rules = fields
    default:
      throw Unsupported(detail: "\(path): a schema is an object or a boolean")
    }
    for key in rules.keys.sorted() where !keywords.contains(key) {
      throw Unsupported(detail: "\(path): keyword \(key) is not implemented by MiniSchema")
    }

    var out: [String] = []

    if let type = rules["type"] {
      let names = type.stringValue.map { [$0] } ?? (type.arrayValue ?? []).compactMap(\.stringValue)
      if !names.contains(where: { matches(instance, type: $0) }) {
        out.append("\(path): want type \(names.joined(separator: "|")), got \(kind(of: instance))")
      }
    }
    if let options = rules["enum"]?.arrayValue, !options.contains(instance) {
      out.append("\(path): \(instance) is not one of \(options)")
    }
    if let constant = rules["const"], constant != instance {
      out.append("\(path): want the constant \(constant), got \(instance)")
    }

    if case .string(let text) = instance {
      let length = text.unicodeScalars.count
      if let min = rules["minLength"]?.intValue, length < min {
        out.append("\(path): length \(length) below minLength \(min)")
      }
      if let max = rules["maxLength"]?.intValue, length > max {
        out.append("\(path): length \(length) above maxLength \(max)")
      }
      if let pattern = rules["pattern"]?.stringValue {
        let regex = try NSRegularExpression(pattern: pattern)
        let range = NSRange(text.startIndex..., in: text)
        if regex.firstMatch(in: text, range: range) == nil {
          out.append("\(path): \(text) does not match the pattern")
        }
      }
      if rules["format"]?.stringValue == "date-time", !isDateTime(text) {
        out.append("\(path): \(text) is not a date-time")
      }
    }

    if case .number(let number) = instance {
      if let min = rules["minimum"]?.doubleValue, number < min {
        out.append("\(path): \(number) below minimum \(min)")
      }
      if let max = rules["maximum"]?.doubleValue, number > max {
        out.append("\(path): \(number) above maximum \(max)")
      }
      if let floor = rules["exclusiveMinimum"]?.doubleValue, number <= floor {
        out.append("\(path): \(number) not above exclusiveMinimum \(floor)")
      }
    }

    if case .object(let fields) = instance {
      let props = rules["properties"]?.objectValue ?? [:]
      for name in (rules["required"]?.arrayValue ?? []).compactMap(\.stringValue) where fields[name] == nil {
        out.append("\(path): missing required key \(name)")
      }
      for name in fields.keys.sorted() {
        let value = fields[name]!
        if let names = rules["propertyNames"] {
          out += try violations(of: .string(name), against: names, at: "\(path) key \(name)")
        }
        if let sub = props[name] {
          out += try violations(of: value, against: sub, at: "\(path).\(name)")
        } else if let extra = rules["additionalProperties"] {
          if extra == .bool(false) {
            out.append("\(path): key \(name) is not in the schema")
          } else {
            out += try violations(of: value, against: extra, at: "\(path).\(name)")
          }
        }
      }
    }

    if case .array(let items) = instance {
      if let min = rules["minItems"]?.intValue, items.count < min {
        out.append("\(path): \(items.count) items below minItems \(min)")
      }
      if let itemSchema = rules["items"] {
        for (index, item) in items.enumerated() {
          out += try violations(of: item, against: itemSchema, at: "\(path)[\(index)]")
        }
      }
    }

    if let options = rules["anyOf"]?.arrayValue {
      var matched = false
      for option in options where try violations(of: instance, against: option, at: path).isEmpty {
        matched = true
        break
      }
      if !matched { out.append("\(path): matches no anyOf branch") }
    }

    return out
  }

  /// A query string as the daemon's validator sees it: an object of strings,
  /// except that a property the schema types as integer or number is coerced
  /// (zod's z.coerce), so `limit=50` checks as 50, not "50".
  static func queryInstance(_ items: [URLQueryItem], schema: JSONValue) -> JSONValue {
    let props = schema["properties"]?.objectValue ?? [:]
    var fields: [String: JSONValue] = [:]
    for item in items {
      let raw = item.value ?? ""
      let type = props[item.name]?["type"]?.stringValue
      if type == "integer" || type == "number", let number = Double(raw) {
        fields[item.name] = .number(number)
      } else {
        fields[item.name] = .string(raw)
      }
    }
    return .object(fields)
  }

  static func matches(_ value: JSONValue, type: String) -> Bool {
    switch (type, value) {
    case ("string", .string), ("boolean", .bool), ("null", .null), ("object", .object),
      ("array", .array), ("number", .number):
      return true
    case ("integer", .number(let number)):
      return number.isFinite && number.rounded() == number
    default:
      return false
    }
  }

  static func kind(of value: JSONValue) -> String {
    switch value {
    case .null: return "null"
    case .bool: return "boolean"
    case .number: return "number"
    case .string: return "string"
    case .array: return "array"
    case .object: return "object"
    }
  }

  private static func isDateTime(_ text: String) -> Bool {
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return plain.date(from: text) != nil || fractional.date(from: text) != nil
  }
}
