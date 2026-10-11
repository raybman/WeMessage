import Foundation
import Testing

@testable import WeMessageKit

/// v2 F6c: file ids on the wire, and the bytes call over a fake transport.
/// Every body is generated or a contract golden; nothing reads a real file.
@Suite("Attachments kit (v2 F6c)")
struct AttachmentKitTests {
  static let a = TestTokens.make("a")
  static let b = TestTokens.make("b")
  static let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0])

  static func notLocal(_ reason: String) -> Reply {
    Reply.json(404, #"{"error":"attachment-not-local","reason":""# + reason + #""}"#)
  }

  @Test("oldTurnsWithoutIdDecode: a file with no id decodes and re-encodes without one")
  func oldTurnsWithoutIdDecode() throws {
    let old = #"{"name":"a.png","mime":"image/png","uti":null,"bytes":4,"sticker":false,"hidden":false}"#
    let file = try JSONDecoder().decode(WireFile.self, from: Data(old.utf8))
    #expect(file.id == nil)
    let back = String(decoding: try JSONEncoder().encode(file), as: UTF8.self)
    #expect(!back.contains("\"id\""), "an absent id stays absent: \(back)")
    let new = #"{"id":"AT-0001","name":"a.png","mime":"image/png","uti":null,"bytes":4,"sticker":false,"hidden":false}"#
    let withId = try JSONDecoder().decode(WireFile.self, from: Data(new.utf8))
    #expect(withId.id == "AT-0001")
    #expect(MessageTurn.attachment(withId).id == "AT-0001")
    #expect(MessageTurn.attachment(file).id == nil)
    // Strict decoding still refuses a key it does not know.
    let extra = #"{"id":"AT-1","path":"x","name":null,"mime":null,"uti":null,"bytes":null,"sticker":false,"hidden":false}"#
    #expect(throws: (any Error).self) { try JSONDecoder().decode(WireFile.self, from: Data(extra.utf8)) }
  }

  @Test("the rich golden's files carry ids, never a path")
  func richGoldenCarriesIds() throws {
    let page = try MessageTurnRichTests.richPage()
    let ids = page.turns.flatMap { $0.files ?? [] }.compactMap(\.id)
    #expect(ids == ["AT-0102-1", "AT-0106-1", "AT-0106-2"])
    #expect(ids.allSatisfy { !$0.contains("/") && !$0.contains("~") })
  }

  @Test("attachmentBytes GETs /v1/attachments/:id with the bearer and no cache, and reads the headers")
  func bytesRequestAndHeaders() async throws {
    let transport = FakeTransport { _, _ in
      Reply(status: 200, body: Self.png, headers: ["Content-Type": "image/png", "ETag": "\"e1\""])
    }
    let got = try await GatewayClient.testing(transport).attachmentBytes("AT-0001")
    #expect(got == AttachmentBytes(data: Self.png, mime: "image/png", etag: "\"e1\"", total: Self.png.count))
    let request = try #require(transport.requests.first)
    #expect(request.httpMethod == "GET")
    #expect(request.url?.path == "/v1/attachments/AT-0001")
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer " + Self.a)
    #expect(request.value(forHTTPHeaderField: "Range") == nil)
    #expect(request.cachePolicy == .reloadIgnoringLocalCacheData)
  }

  @Test("a ranged call sends Range and reads the total from Content-Range")
  func rangedCall() async throws {
    let transport = FakeTransport { _, _ in
      Reply(status: 206, body: Data(Self.png.prefix(4)), headers: ["Content-Type": "image/png", "Content-Range": "bytes 0-3/12"])
    }
    let got = try await GatewayClient.testing(transport).attachmentBytes("AT-0001", range: 0...3)
    #expect(transport.requests.first?.value(forHTTPHeaderField: "Range") == "bytes=0-3")
    #expect(got.data.count == 4)
    #expect(got.total == 12)
  }

  @Test("every 404 reason maps to its AttachmentFailure; 503 is sourceUnavailable")
  func refusalsMap() async throws {
    for failure in AttachmentFailure.allCases where failure != .sourceUnavailable {
      let transport = FakeTransport { _, _ in Self.notLocal(failure.rawValue) }
      await #expect(throws: failure, "\(failure)") {
        try await GatewayClient.testing(transport).attachmentBytes("AT-0001")
      }
    }
    let golden = FakeTransport { _, _ in try Reply.error("404.attachment-not-local") }
    await #expect(throws: AttachmentFailure.unknownAttachment) {
      try await GatewayClient.testing(golden).attachmentBytes("AT-NOPE")
    }
    let down = FakeTransport { _, _ in try Reply.error("503.source-unavailable") }
    await #expect(throws: AttachmentFailure.sourceUnavailable) {
      try await GatewayClient.testing(down).attachmentBytes("AT-0001")
    }
  }

  @Test("a 416, or a reason this build does not know, throws as any call does")
  func otherErrorsStayGatewayErrors() async throws {
    let range = try Fixtures.error("416.range")
    let t416 = FakeTransport { _, _ in try Reply.error("416.range") }
    await #expect(throws: GatewayError.request(status: 416, body: range.body)) {
      try await GatewayClient.testing(t416).attachmentBytes("AT-0001", range: 100_000...100_001)
    }
    let odd = FakeTransport { _, _ in Self.notLocal("moon") }
    await #expect(throws: GatewayError.self) { try await GatewayClient.testing(odd).attachmentBytes("AT-0001") }
  }

  @Test("the bytes call re-reads the token once on 401, like every call")
  func bytes401() async throws {
    let file = FakeTokenFile([Self.a, Self.b])
    let fresh = "Bearer " + Self.b
    let transport = FakeTransport { request, _ in
      request.value(forHTTPHeaderField: "Authorization") == fresh
        ? Reply(status: 200, body: Self.png, headers: ["Content-Type": "image/png"])
        : try Reply.error("401.unauthorized")
    }
    let got = try await GatewayClient.testing(transport, file: file).attachmentBytes("AT-0001")
    #expect(got.data == Self.png)
    #expect(transport.requests.count == 2)
    #expect(file.reads == 2)
  }
}
