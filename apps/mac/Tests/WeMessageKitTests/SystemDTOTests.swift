import Foundation
import Testing
@testable import WeMessageKit

/// v2 S2b row 14: the doctor's `runtime` is a tagged union on `kind`. Both
/// variants are read from fixtures/doctor-runtime, the same hand-written files
/// the daemon's and the client's tests read, so the three mirrors are held to
/// one set of bytes. Nothing here restates a fixture's values.
@Suite("System DTOs")
struct SystemDTOTests {
  static let variants = ["electron", "node"]

  static func fixture(_ name: String) throws -> JSONValue {
    try Repo.json("fixtures/doctor-runtime/\(name).json")
  }

  static func decode(_ value: JSONValue) throws -> DoctorRuntimePayload {
    try JSONDecoder().decode(DoctorRuntimePayload.self, from: try value.canonicalData())
  }

  @Test("DoctorRuntimePayload decodes both variants from fixtures/doctor-runtime")
  func decodesBothVariants() throws {
    let electron = try Self.fixture("electron")
    let electronVersion = try #require(electron["electron"]?.stringValue)
    let electronNode = try #require(electron["node"]?.stringValue)
    let electronAbi = try #require(electron["abi"]?.intValue)
    #expect(
      try Self.decode(electron)
        == .electron(electron: electronVersion, node: electronNode, abi: electronAbi))

    let node = try Self.fixture("node")
    let host = try #require(node["host"]?.stringValue)
    let nodeVersion = try #require(node["node"]?.stringValue)
    let nodeAbi = try #require(node["abi"]?.intValue)
    #expect(try Self.decode(node) == .node(host: host, node: nodeVersion, abi: nodeAbi))
  }

  @Test("each variant re-encodes to its fixture, kind included")
  func reencodes() throws {
    for name in Self.variants {
      let fixture = try Self.fixture(name)
      let again = try JSONValue.parse(try JSONEncoder().encode(try Self.decode(fixture)))
      #expect(again == fixture, "\(name): got \(again)")
    }
  }

  @Test("an unknown kind is refused, and the refusal names it")
  func unknownKind() throws {
    let deno = try Self.fixture("node").replacing("kind", with: "deno")
    do {
      _ = try Self.decode(deno)
      Issue.record("kind \"deno\" decoded without complaint")
    } catch DecodingError.dataCorrupted(let context) {
      #expect(context.debugDescription.contains("deno"), "\(context.debugDescription)")
    }
  }

  @Test("the flat shape from before the union, with no kind, is refused")
  func flatShapeRefused() throws {
    var fields = try #require(try Self.fixture("electron").objectValue)
    fields["kind"] = nil
    do {
      _ = try Self.decode(.object(fields))
      Issue.record("a runtime with no kind decoded without complaint")
    } catch DecodingError.keyNotFound(let key, _) {
      #expect(key.stringValue == "kind")
    }
  }

  @Test("each variant refuses the other variant's member and any unknown key")
  func strictPerKind() throws {
    let electron = try Self.fixture("electron")
    let node = try Self.fixture("node")
    let host = try #require(node["host"])
    let electronVersion = try #require(electron["electron"])
    let foreign: [(String, JSONValue, String, JSONValue)] = [
      ("electron", electron, "host", host),
      ("node", node, "electron", electronVersion),
      ("electron", electron, "zzUnknown", 1),
      ("node", node, "zzUnknown", 1),
    ]
    for (name, fixture, key, value) in foreign {
      do {
        _ = try Self.decode(fixture.replacing(key, with: value))
        Issue.record("\(name) with \(key): decoded without complaint")
      } catch DecodingError.dataCorrupted(let context) {
        #expect(
          context.debugDescription.contains("\"\(key)\""),
          "\(name) with \(key): refused, but not for that key: \(context.debugDescription)")
      }
    }
  }

  @Test("the doctor golden carries no runtime, and either variant spliced in round-trips")
  func reportWithRuntime() throws {
    let golden = try Fixtures.response("doctor").body
    let goldenFields = try #require(golden.objectValue)
    #expect(goldenFields["runtime"] == nil)
    let bare = try JSONDecoder().decode(
      DoctorReportPayload.self, from: try golden.canonicalData())
    #expect(bare.runtime == nil)

    for name in Self.variants {
      let fixture = try Self.fixture(name)
      let body = golden.replacing("runtime", with: fixture)
      let report = try JSONDecoder().decode(
        DoctorReportPayload.self, from: try body.canonicalData())
      let want = try Self.decode(fixture)
      #expect(report.runtime == want, "\(name)")
      let again = try JSONValue.parse(try JSONEncoder().encode(report))
      #expect(again == body, "\(name): got \(again)")
    }
  }
}
