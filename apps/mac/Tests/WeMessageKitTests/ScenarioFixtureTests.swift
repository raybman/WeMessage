import Foundation
import Testing
@testable import WeMessageKit

/// v2 S4b: every fake daemon scenario under fixtures/scenarios decodes through
/// the same strict DTOs as the S0 goldens it overlays, and re-encodes to the
/// same JSON, so a scenario can never show the window a shape the real daemon
/// would not send. Each response file is mapped to the S0 golden that owns its
/// route; the stream frames go through SSEDecoder and GatewayEvent.
@Suite("Scenario fixtures")
struct ScenarioFixtureTests {
  static let root = "fixtures/scenarios/"

  /// The S0 golden name whose DTO decodes a scenario file on `route`.
  static func goldenName(route: String, status: Int) -> String? {
    guard status < 400 else { return nil }
    switch route {
    case "GET /v1/status": return "status"
    case "GET /v1/threads": return "threads.list"
    case "GET /v1/threads/:guid/messages": return "threads.messages"
    case "GET /v1/threads/by-handle/:handle": return "threads.by-handle.found"
    case "GET /v1/drafts": return "drafts.list.pending"
    case "GET /v1/contacts": return "contacts.list"
    case "GET /v1/adapters": return "adapters.list"
    case "GET /v1/audit": return "audit.list"
    case "GET /v1/doctor": return "doctor"
    case "GET /v1/settings": return "settings.list"
    case "PATCH /v1/settings": return "settings.patch"
    default: return nil
    }
  }

  static func responseFiles() throws -> [String] {
    try Repo.files(under: root).filter { $0.contains("/responses/") && $0.hasSuffix(".json") }
  }

  static func frameFiles() throws -> [String] {
    try Repo.files(under: root).filter { $0.contains("/sse/") && $0.hasSuffix(".txt") }
  }

  static func load(_ rel: String) throws -> ContractFixture {
    let json = try Repo.json(root + rel)
    guard let route = json["route"]?.stringValue, let status = json["status"]?.intValue,
      let body = json["body"]
    else { throw Fixtures.Malformed(detail: "\(rel): want {route, status, body}") }
    return ContractFixture(name: rel, route: route, status: status, body: body)
  }

  @Test("every scenario response decodes strictly and re-encodes to the same JSON")
  func responsesRoundTrip() throws {
    let files = try Self.responseFiles()
    #expect(files.count >= 30, "scenario responses on disk: \(files.count)")
    var compared = 0
    for rel in files {
      let fixture = try Self.load(rel)
      guard fixture.status < 400 else { continue }
      guard let name = Self.goldenName(route: fixture.route, status: fixture.status) else {
        Issue.record("\(rel): no S0 golden is mapped for \(fixture.route)")
        continue
      }
      do {
        let encoded = try #require(try Fixtures.roundTrip(name, fixture.bodyData))
        let again = try JSONValue.parse(encoded)
        let want = String(decoding: try fixture.body.canonicalData(), as: UTF8.self)
        let got = String(decoding: try again.canonicalData(), as: UTF8.self)
        #expect(again == fixture.body, "\(rel):\n want \(want)\n got  \(got)")
        compared += 1
      } catch {
        Issue.record("\(rel) does not decode as \(name): \(error)")
      }
    }
    #expect(compared >= 30, "scenario responses compared: \(compared)")
  }

  @Test("status.adapters entries decode as adapters")
  func statusAdapters() throws {
    var seen = 0
    for rel in try Self.responseFiles() {
      let fixture = try Self.load(rel)
      guard fixture.route == "GET /v1/status", fixture.status == 200 else { continue }
      for adapter in fixture.body["adapters"]?.arrayValue ?? [] {
        do {
          _ = try JSONDecoder().decode(AdapterPayload.self, from: try adapter.canonicalData())
          seen += 1
        } catch {
          Issue.record("\(rel): a status adapter does not decode: \(error)")
        }
      }
    }
    #expect(seen >= 3, "status adapters decoded: \(seen)")
  }

  @Test("error responses carry an S0 error body exactly")
  func errorsMatchS0() throws {
    let s0 = try Fixtures.errorNames().map { try Fixtures.error($0) }
    var seen = 0
    for rel in try Self.responseFiles() {
      let fixture = try Self.load(rel)
      guard fixture.status >= 400 else { continue }
      seen += 1
      #expect(
        s0.contains { $0.status == fixture.status && $0.body == fixture.body },
        "\(rel): \(fixture.status) is not an S0 error body")
    }
    #expect(seen >= 1, "scenario error responses: \(seen)")
  }

  @Test("every stream frame decodes to a known event, ids rising from 2")
  func framesDecode() throws {
    let files = try Self.frameFiles()
    #expect(files.count >= 10, "scenario frames on disk: \(files.count)")
    var ids: [String: [Int]] = [:]
    for rel in files {
      let scenario = String(rel.split(separator: "/")[0])
      var decoder = SSEDecoder()
      let frames = decoder.feed(try Repo.data(Self.root + rel))
      guard frames.count == 1, let frame = frames.first else {
        Issue.record("\(rel): want exactly one frame, got \(frames.count)")
        continue
      }
      let id = try #require(frame.id, "\(rel): no id")
      ids[scenario, default: []].append(id)
      do {
        let event = try GatewayEvent(frame: frame)
        #expect(event.eventName?.rawValue == frame.event, "\(rel): decoded as \(event)")
      } catch {
        Issue.record("\(rel) does not decode: \(error)")
      }
    }
    #expect(!ids.isEmpty)
    for (scenario, seen) in ids {
      #expect(seen == Array(2..<(2 + seen.count)), "\(scenario): ids \(seen)")
    }
  }
}
