import Foundation
import Testing

@testable import WeMessageKit

/// v2 Phase B: the per-board `meta` carrier on threads and turns. The fake
/// daemon's preview-* scenarios send it; the real daemon never does, so
/// absent must decode to nil and encode to no key at all.
@Suite struct ThreadMetaTests {
  static let thread = """
    {"chatGuid":"wa;-;+15550001001","channel":"whatsapp","title":"Test User",
     "isGroup":false,"lastLine":"hi","lastFromMe":false,
     "lastAt":"2026-09-01T10:00:00.000Z"
    """
  static let turn = """
    {"guid":"G1","from":"them","kind":"audio","text":null,
     "at":"2026-09-01T10:00:00.000Z","attachments":1
    """

  static func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
  }

  static func keys<T: Encodable>(_ value: T) throws -> Set<String> {
    let data = try JSONEncoder().encode(value)
    let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    return Set(object?.keys.map { $0 } ?? [])
  }

  @Test func absentMetaDecodesNilAndEncodesNoKey() throws {
    let t = try Self.decode(ThreadSummary.self, Self.thread + "}")
    #expect(t.meta == nil)
    #expect(try !Self.keys(t).contains("meta"))
    let u = try Self.decode(ThreadTurn.self, Self.turn + "}")
    #expect(u.meta == nil)
    #expect(try !Self.keys(u).contains("meta"))
  }

  @Test func threadMetaRoundTrips() throws {
    let json = Self.thread
      + #","meta":{"linkedDevice":"expired","historyHorizon":"2026-08-01","phonePanel":{"online":false}}}"#
    let t = try Self.decode(ThreadSummary.self, json)
    #expect(t.meta?["linkedDevice"] == .string("expired"))
    #expect(t.meta?["phonePanel"] == .object(["online": .bool(false)]))
    let again = try Self.decode(ThreadSummary.self, String(decoding: try JSONEncoder().encode(t), as: UTF8.self))
    #expect(again == t)
  }

  @Test func turnMetaRoundTrips() throws {
    let json = Self.turn
      + #","meta":{"voiceNote":{"durationMs":4200,"transcript":"on my way"},"reactions":[{"emoji":"+1","from":"me"}]}}"#
    let u = try Self.decode(ThreadTurn.self, json)
    #expect(u.meta?["voiceNote"] == .object(["durationMs": .number(4200), "transcript": .string("on my way")]))
    let again = try Self.decode(ThreadTurn.self, String(decoding: try JSONEncoder().encode(u), as: UTF8.self))
    #expect(again == u)
  }

  @Test func strictDecodingStillRejectsOtherUnknownKeys() {
    #expect(throws: (any Error).self) {
      try Self.decode(ThreadSummary.self, Self.thread + #","metadata":{}}"#)
    }
    #expect(throws: (any Error).self) {
      try Self.decode(ThreadTurn.self, Self.turn + #","rowid":42}"#)
    }
  }

  @Test func metaMustBeAnObject() {
    #expect(throws: (any Error).self) {
      try Self.decode(ThreadSummary.self, Self.thread + #","meta":"linked"}"#)
    }
  }
}
