import Foundation

/// The checkout root, found by walking up from this file until
/// fixtures/contract/manifest.json appears. A minimal copy of
/// Tests/WeMessageKitTests/Support/RepoRoot.swift: a test target cannot depend
/// on another test target, and the host's hygiene rows need only file text and
/// file listings, not the kit's JSON reader.
enum Repo {
  struct Missing: Error, CustomStringConvertible {
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
    throw Missing(path: "fixtures/contract/manifest.json")
  }

  static func url(_ rel: String) throws -> URL {
    try root().appendingPathComponent(rel)
  }

  static func text(_ rel: String) throws -> String {
    guard let data = FileManager.default.contents(atPath: try url(rel).path),
      let text = String(data: data, encoding: .utf8)
    else { throw Missing(path: rel) }
    return text
  }

  /// Every regular file under `rel`, relative to it and sorted. Directories
  /// named in `skipping` are not descended into (SwiftPM's build output).
  /// Dotfiles are skipped: no source file is hidden.
  static func files(under rel: String, skipping skip: Set<String> = []) throws -> [String] {
    let base = try url(rel)
    let fm = FileManager.default
    guard let walker = fm.enumerator(atPath: base.path) else { throw Missing(path: rel) }
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
