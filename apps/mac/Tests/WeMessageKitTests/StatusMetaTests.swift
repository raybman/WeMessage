import Foundation
import Testing

@testable import WeMessageKit

/// v2 B4: the open `meta` carrier on GET /v1/status. Board 07's voice dock
/// reads meta.voice from the fake daemon's preview-voice scenarios; the real
/// daemon never sends it, so absent must decode to nil and encode to no key,
/// and every other unknown key is still refused.
@Suite struct StatusMetaTests {
  static func golden() throws -> [String: Any] {
    let data = try Fixtures.response("status").bodyData
    return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  static func decode(_ object: [String: Any]) throws -> StatusPayload {
    try JSONDecoder().decode(StatusPayload.self, from: try JSONSerialization.data(withJSONObject: object))
  }

  static func keys(_ status: StatusPayload) throws -> Set<String> {
    let object = try JSONSerialization.jsonObject(with: try JSONEncoder().encode(status)) as? [String: Any]
    return Set(object?.keys.map { $0 } ?? [])
  }

  @Test("SM1: the S0 golden carries no meta: nil, and encoded without the key")
  func absent() throws {
    let status = try Self.decode(try Self.golden())
    #expect(status.meta == nil)
    #expect(try !Self.keys(status).contains("meta"))
  }

  @Test("SM2: meta.voice decodes as an open map and round-trips")
  func roundTrips() throws {
    var object = try Self.golden()
    object["meta"] = ["voice": ["dockState": "speaking", "caption": "I drafted it", "readbackToken": "Test", "micMuted": true]]
    let status = try Self.decode(object)
    let voice = status.meta?["voice"]
    #expect(voice == .object([
      "dockState": .string("speaking"), "caption": .string("I drafted it"), "readbackToken": .string("Test"),
      "micMuted": .bool(true),
    ]))
    let again = try JSONDecoder().decode(StatusPayload.self, from: try JSONEncoder().encode(status))
    #expect(again == status)
  }

  @Test("SM3: strict decoding still refuses every other unknown key")
  func strict() throws {
    var object = try Self.golden()
    object["metadata"] = [:] as [String: Any]
    #expect(throws: (any Error).self) { try Self.decode(object) }
  }

  @Test("SM4: meta must be an object")
  func object() throws {
    var object = try Self.golden()
    object["meta"] = "voice"
    #expect(throws: (any Error).self) { try Self.decode(object) }
  }
}
