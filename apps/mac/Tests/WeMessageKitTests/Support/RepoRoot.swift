import Foundation
@testable import WeMessageKit

/// The checkout root, found by walking up from this file until
/// fixtures/contract/manifest.json appears. The kit's tests read the S0
/// contract straight from the tree, never from a copied resource bundle, so a
/// fixture edit is seen by the very next run with no build step in between.
enum Repo {
  struct FixtureMissing: Error, CustomStringConvertible {
    let path: String
    var description: String { "missing under the repository root: \(path)" }
  }

  private static let anchor: String = #filePath

  static func root() throws -> URL {
    var dir = URL(fileURLWithPath: anchor).deletingLastPathComponent()
    for _ in 0..<8 {
      let probe = dir.appendingPathComponent("fixtures/contract/manifest.json")
      if FileManager.default.fileExists(atPath: probe.path) { return dir }
      dir = dir.deletingLastPathComponent()
    }
    throw FixtureMissing(path: "fixtures/contract/manifest.json")
  }

  static func url(_ rel: String) throws -> URL {
    try root().appendingPathComponent(rel)
  }

  static func data(_ rel: String) throws -> Data {
    guard let data = FileManager.default.contents(atPath: try url(rel).path) else {
      throw FixtureMissing(path: rel)
    }
    return data
  }

  static func text(_ rel: String) throws -> String {
    guard let text = String(data: try data(rel), encoding: .utf8) else {
      throw FixtureMissing(path: rel)
    }
    return text
  }

  static func json(_ rel: String) throws -> JSONValue {
    try JSONValue.parse(try data(rel))
  }

  /// Every regular file under `rel`, relative to it and sorted. Directories
  /// named in `skipping` are not descended into (SwiftPM's build output).
  /// Dotfiles are skipped: no fixture or source file is hidden.
  static func files(under rel: String, skipping skip: Set<String> = []) throws -> [String] {
    let base = try url(rel)
    let fm = FileManager.default
    guard let walker = fm.enumerator(atPath: base.path) else { throw FixtureMissing(path: rel) }
    var out: [String] = []
    while let sub = walker.nextObject() as? String {
      let name = (sub as NSString).lastPathComponent
      var isDir: ObjCBool = false
      _ = fm.fileExists(atPath: base.appendingPathComponent(sub).path, isDirectory: &isDir)
      if isDir.boolValue {
        if skip.contains(name) || name.hasPrefix(".") { walker.skipDescendants() }
        continue
      }
      if name.hasPrefix(".") { continue }
      out.append(sub)
    }
    return out.sorted()
  }
}

/// One fixtures/contract/{responses,errors}/<name>.json file.
struct ContractFixture: Sendable {
  let name: String
  let route: String
  let status: Int
  let body: JSONValue

  /// The body as the daemon would put it on the wire: empty for a 204.
  var wireBody: Data {
    body == .null ? Data() : ((try? body.canonicalData()) ?? Data())
  }

  /// The body as JSON text, `null` included, for the strict decoders.
  var bodyData: Data { (try? body.canonicalData()) ?? Data("null".utf8) }

  var method: String { String(route.split(separator: " ")[0]) }
  var pathTemplate: String { String(route.split(separator: " ")[1]) }
}

enum Fixtures {
  struct Malformed: Error, CustomStringConvertible {
    let detail: String
    var description: String { detail }
  }

  static func names(in dir: String, suffix: String) throws -> [String] {
    try Repo.files(under: "fixtures/contract/" + dir)
      .filter { $0.hasSuffix(suffix) && !$0.contains("/") }
      .map { String($0.dropLast(suffix.count)) }
  }

  static func responseNames() throws -> [String] { try names(in: "responses", suffix: ".json") }
  static func errorNames() throws -> [String] { try names(in: "errors", suffix: ".json") }
  static func schemaNames() throws -> [String] { try names(in: "requests", suffix: ".schema.json") }

  static func response(_ name: String) throws -> ContractFixture {
    try load("responses/\(name).json", name: name)
  }

  static func error(_ name: String) throws -> ContractFixture {
    try load("errors/\(name).json", name: name)
  }

  static func schema(_ name: String) throws -> JSONValue {
    try Repo.json("fixtures/contract/requests/\(name).schema.json")
  }

  static func sse(_ name: String) throws -> Data {
    try Repo.data("fixtures/contract/sse/\(name).txt")
  }

  /// fixtures/events/<name>.json: the payload every transport carries.
  static func event(_ name: String) throws -> JSONValue {
    try Repo.json("fixtures/events/\(name).json")
  }

  static func wire() throws -> JSONValue {
    try Repo.json("fixtures/contract/wire.json")
  }

  private static func load(_ rel: String, name: String) throws -> ContractFixture {
    let json = try Repo.json("fixtures/contract/" + rel)
    guard let route = json["route"]?.stringValue, let status = json["status"]?.intValue,
      let body = json["body"]
    else { throw Malformed(detail: "\(rel): want {route, status, body}") }
    return ContractFixture(name: name, route: route, status: status, body: body)
  }
}

/// A step from the root of a JSON document to one of its values.
enum PathStep: Hashable, Sendable, CustomStringConvertible {
  case key(String)
  case index(Int)

  var description: String {
    switch self {
    case .key(let key): return "[\"\(key)\"]"
    case .index(let index): return "[\(index)]"
    }
  }
}

extension Array where Element == PathStep {
  var rendered: String { "$" + map(\.description).joined() }
}

extension JSONValue {
  /// The path of every object in this document, the root included.
  func objectPaths(_ prefix: [PathStep] = []) -> [[PathStep]] {
    switch self {
    case .object(let fields):
      var out = [prefix]
      for key in fields.keys.sorted() {
        out += fields[key]!.objectPaths(prefix + [.key(key)])
      }
      return out
    case .array(let items):
      return items.enumerated().flatMap { $0.element.objectPaths(prefix + [.index($0.offset)]) }
    default:
      return []
    }
  }

  /// A copy with `key: value` added to the object at `path`.
  func injecting(_ key: String, _ value: JSONValue, at path: [PathStep]) -> JSONValue {
    guard let step = path.first else {
      guard case .object(var fields) = self else { return self }
      fields[key] = value
      return .object(fields)
    }
    let rest = Array(path.dropFirst())
    switch (self, step) {
    case (.object(var fields), .key(let name)):
      fields[name] = fields[name]?.injecting(key, value, at: rest)
      return .object(fields)
    case (.array(var items), .index(let index)):
      items[index] = items[index].injecting(key, value, at: rest)
      return .array(items)
    default:
      return self
    }
  }

  /// A copy with the top-level `key` replaced.
  func replacing(_ key: String, with value: JSONValue) -> JSONValue {
    guard case .object(var fields) = self else { return self }
    fields[key] = value
    return .object(fields)
  }
}
