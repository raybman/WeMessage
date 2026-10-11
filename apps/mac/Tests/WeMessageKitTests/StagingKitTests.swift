import Foundation
import Testing

@testable import WeMessageKit

/// v2 F6f: the operator's file send, kit half. Staging posts the file's own
/// bytes (never JSON, never a path) with the declared type and the name
/// percent-encoded; the send names the stage id. Every body is generated
/// here or is a contract golden; nothing reads a real file.
@Suite("Staging kit (v2 F6f)")
struct StagingKitTests {
  static let a = TestTokens.make("a")
  static let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13])
  static let stageId = String(repeating: "0", count: 64)

  @Test("stage POSTs the raw bytes with their type and the encoded name, uncached, with the bearer")
  func stageRequestIsRawBytes() async throws {
    let transport = FakeTransport { _, _ in try Reply.response("attachments.staged") }
    let got = try await GatewayClient.testing(transport).stageAttachment(name: "grey é.png", mime: "image/png", bytes: Self.png)
    #expect(got == StagedAttachment(stageId: Self.stageId, name: "grey.png", mime: "image/png", bytes: 71))
    let request = try #require(transport.requests.first)
    #expect(request.httpMethod == "POST")
    #expect(request.url?.path == "/v1/attachments/staged")
    #expect(request.httpBody == Self.png)
    #expect(request.value(forHTTPHeaderField: "Content-Type") == "image/png")
    #expect(request.value(forHTTPHeaderField: "X-WeMessage-Name") == "grey%20%C3%A9.png")
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer " + Self.a)
    #expect(request.cachePolicy == .reloadIgnoringLocalCacheData)
    // Not a JSON route: no JSON body for the schema checks to see.
    #expect(try Endpoint.stageAttachment(name: "a.png", mime: "image/png", bytes: Self.png).body() == nil)
  }

  @Test("off is a refusal the caller can read; over the cap and a wrong type are thrown with their bodies")
  func stageRefusals() async throws {
    let off = FakeTransport { _, _ in try Reply.error("409.attachments-unproven") }
    do {
      _ = try await GatewayClient.testing(off).stageAttachment(name: "a.png", mime: "image/png", bytes: Self.png)
      Issue.record("an off daemon staged a file")
    } catch let error as GatewayError {
      #expect(error.refusal == .conflict(code: "attachments-unproven", from: nil, requested: nil))
    }
    for (name, status) in [("413.attachment-too-large", 413), ("415.attachment-type-mismatch", 415)] {
      let transport = FakeTransport { _, _ in try Reply.error(name) }
      do {
        _ = try await GatewayClient.testing(transport).stageAttachment(name: "a.png", mime: "image/png", bytes: Self.png)
        Issue.record("\(name) staged")
      } catch GatewayError.request(let got, let body) {
        #expect(got == status)
        #expect(body["error"]?.stringValue == String(name.dropFirst(4)))
      }
    }
  }

  @Test("sendFile POSTs the chat and the stage id, never a path, and reads the golden")
  func sendFileBody() async throws {
    let transport = FakeTransport { _, _ in try Reply.response("send.file") }
    let got = try await GatewayClient.testing(transport).sendFile(to: "+15551234567", stageId: Self.stageId)
    #expect(got.outcome == "sent")
    let request = try #require(transport.requests.first)
    #expect(request.url?.path == "/v1/send")
    let body = try JSONValue.parse(try #require(request.httpBody))
    #expect(body == .object(["chatGuid": .string("iMessage;-;+15551234567"), "file": .string(Self.stageId)]))
  }
}
