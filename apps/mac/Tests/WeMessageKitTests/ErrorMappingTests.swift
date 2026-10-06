import Foundation
import Testing
@testable import WeMessageKit

/// R2: one row per line of the plan's 3.3 error table. Where the kit is richer
/// than the TS client's request() the row name says so, in the same words as
/// the divergence block at the top of Client/GatewayError.swift.
@Suite("ErrorMapping")
struct ErrorMappingTests {
  static let chat = "iMessage;-;+15551234567"

  static func classify(_ status: Int, _ body: String, _ endpoint: Endpoint = .status) -> HTTPOutcome {
    GatewayError.classify(status: status, body: Data(body.utf8), endpoint: endpoint)
  }

  @Test("204 with an empty body -> success(nil); any other 2xx -> success(body)")
  func success() {
    #expect(Self.classify(204, "", .deleteRule(id: "rule-1")) == .success(nil))
    #expect(Self.classify(200, #"{"status":"ok"}"#, .health) == .success(Data(#"{"status":"ok"}"#.utf8)))
    #expect(Self.classify(201, #"{"draft":1}"#) == .success(Data(#"{"draft":1}"#.utf8)))
  }

  @Test("401 any body -> unauthorized [diverges from TS: request() throws DaemonAuthError]")
  func unauthorized() {
    #expect(Self.classify(401, #"{"error":"unauthorized"}"#) == .failure(.unauthorized))
    #expect(Self.classify(401, "") == .failure(.unauthorized))
    #expect(Self.classify(401, "nope", .events(filter: nil)) == .failure(.unauthorized))
  }

  @Test("403 gate-denied with a string reason -> gateDenied(reason)")
  func gateDenied() {
    let body = #"{"error":"gate-denied","reason":"kill-switch"}"#
    #expect(Self.classify(403, body, .send(to: "+15551234567", body: "hi")) == .failure(.gateDenied(reason: "kill-switch")))
  }

  @Test(
    "403 other, or gate-denied without a string reason -> forbidden(body) [diverges from TS: request() throws DaemonAuthError]"
  )
  func forbidden() {
    #expect(Self.classify(403, #"{"error":"bad-origin"}"#) == .failure(.forbidden(body: ["error": "bad-origin"])))
    #expect(Self.classify(403, #"{"error":"gate-denied"}"#) == .failure(.forbidden(body: ["error": "gate-denied"])))
    #expect(
      Self.classify(403, #"{"error":"gate-denied","reason":7}"#)
        == .failure(.forbidden(body: ["error": "gate-denied", "reason": 7])))
    #expect(Self.classify(403, "") == .failure(.forbidden(body: .null)))
  }

  @Test("404 unknown-chat -> unknownChat on readThread only, request(404) anywhere else")
  func unknownChat() {
    let body = #"{"error":"unknown-chat"}"#
    let read = Endpoint.readThread(guid: Self.chat, limit: nil, before: nil, until: nil)
    #expect(Self.classify(404, body, read) == .failure(.unknownChat))
    #expect(Self.classify(404, body, .getDraft(id: "id-0001")) == .failure(.request(status: 404, body: ["error": "unknown-chat"])))
    #expect(Self.classify(404, body, .listThreads(limit: nil, cursor: nil)) == .failure(.request(status: 404, body: ["error": "unknown-chat"])))
  }

  @Test("404 not-found -> notFound [diverges from TS: request() throws a plain DaemonRequestError(404)]")
  func notFound() {
    #expect(Self.classify(404, #"{"error":"not-found"}"#, .getDraft(id: "id-0001")) == .failure(.notFound))
    #expect(Self.classify(404, #"{"error":"not-found"}"#, .getRule(id: "rule-1")) == .failure(.notFound))
    #expect(Self.classify(404, #"{"error":"elsewhere"}"#) == .failure(.request(status: 404, body: ["error": "elsewhere"])))
  }

  @Test("409 string error -> conflict(detail) with from/requested and the other fields forwarded")
  func conflict() {
    let recall = Endpoint.recallDraft(id: "id-0001")
    #expect(
      Self.classify(409, #"{"error":"illegal-transition","from":"pending","requested":"recall"}"#, recall)
        == .failure(.conflict(ConflictDetail(error: "illegal-transition", from: "pending", requested: "recall"))))
    #expect(
      Self.classify(409, #"{"error":"already-sent","sentMessageGuid":"guid-outbound-0001"}"#, .retryDraft(id: "id-0001"))
        == .failure(.conflict(ConflictDetail(error: "already-sent", sentMessageGuid: "guid-outbound-0001"))))
    #expect(
      Self.classify(409, #"{"error":"schedule-in-use","ruleIds":["rule-1"]}"#, .deleteSchedule(id: "sched-1"))
        == .failure(.conflict(ConflictDetail(error: "schedule-in-use", ruleIds: ["rule-1"]))))
    #expect(
      Self.classify(409, #"{"error":"adapter-exists","id":"echo"}"#)
        == .failure(.conflict(ConflictDetail(error: "adapter-exists", id: "echo"))))
    #expect(
      Self.classify(409, #"{"error":"busy","attempts":3}"#)
        == .failure(.conflict(ConflictDetail(error: "busy", attempts: 3))))
    #expect(Self.classify(409, #"{"error":"not-armed"}"#) == .failure(.conflict(ConflictDetail(error: "not-armed"))))
  }

  @Test("409 without a string error -> request(409, body)")
  func conflictOther() {
    #expect(Self.classify(409, #"{"error":5}"#) == .failure(.request(status: 409, body: ["error": 5])))
    #expect(Self.classify(409, "") == .failure(.request(status: 409, body: .null)))
    #expect(Self.classify(409, "busy") == .failure(.request(status: 409, body: "busy")))
  }

  @Test("503 source-unavailable -> sourceUnavailable")
  func sourceUnavailable() {
    #expect(Self.classify(503, #"{"error":"source-unavailable"}"#, .listThreads(limit: nil, cursor: nil)) == .failure(.sourceUnavailable))
  }

  @Test("503 no-auth-token -> noAuthToken [diverges from TS: request() throws DaemonAuthError(503)]")
  func noAuthToken() {
    #expect(Self.classify(503, #"{"error":"no-auth-token"}"#) == .failure(.noAuthToken))
  }

  @Test("503 other -> request(503, body) [diverges from TS: request() throws DaemonAuthError(503)]")
  func unavailableOther() {
    #expect(Self.classify(503, #"{"error":"warming-up"}"#) == .failure(.request(status: 503, body: ["error": "warming-up"])))
    #expect(Self.classify(503, "") == .failure(.request(status: 503, body: .null)))
  }

  @Test("400 on PATCH /v1/settings -> settingsRefused for each of the five typed refusals")
  func settingsRefused() {
    let patch = Endpoint.setSettings(["send.autoGraceSeconds": .int(1)])
    #expect(Self.classify(400, #"{"error":"unknown-key","key":"nope"}"#, patch) == .failure(.settingsRefused(.unknownKey(key: "nope"))))
    #expect(
      Self.classify(400, #"{"error":"read-only-key","key":"arming.pauseUntil","use":"POST /v1/toggles/pause"}"#, patch)
        == .failure(.settingsRefused(.readOnlyKey(key: "arming.pauseUntil", use: "POST /v1/toggles/pause"))))
    #expect(
      Self.classify(400, #"{"error":"wrong-type","key":"send.autoGraceSeconds","expected":"int"}"#, patch)
        == .failure(.settingsRefused(.wrongType(key: "send.autoGraceSeconds", expected: "int"))))
    #expect(
      Self.classify(400, #"{"error":"below-floor","key":"send.autoGraceSeconds","floor":5}"#, patch)
        == .failure(.settingsRefused(.belowFloor(key: "send.autoGraceSeconds", floor: 5))))
    #expect(
      Self.classify(400, #"{"error":"above-ceiling","key":"send.autoGraceSeconds","ceiling":600}"#, patch)
        == .failure(.settingsRefused(.aboveCeiling(key: "send.autoGraceSeconds", ceiling: 600))))
  }

  @Test(
    "400 settings refusal without its typed companion field -> request(400) [diverges from TS: setSettings casts the body unchecked]"
  )
  func settingsRefusedIncomplete() {
    let patch = Endpoint.setSettings(["send.autoGraceSeconds": .int(1)])
    for body in [
      #"{"error":"unknown-key"}"#,
      #"{"error":"read-only-key","key":"arming.pauseUntil"}"#,
      #"{"error":"wrong-type","key":"send.autoGraceSeconds","expected":"float"}"#,
      #"{"error":"below-floor","key":"send.autoGraceSeconds","floor":"5"}"#,
      #"{"error":"above-ceiling","key":"send.autoGraceSeconds"}"#,
      #"{"error":"invalid-settings"}"#,
    ] {
      let parsed = (try? JSONValue.parse(Data(body.utf8))) ?? .null
      #expect(Self.classify(400, body, patch) == .failure(.request(status: 400, body: parsed)), "\(body)")
    }
    let elsewhere = Self.classify(400, #"{"error":"unknown-key","key":"nope"}"#, .createDraft(DraftCreateInput(chatGuid: Self.chat, body: "x")))
    #expect(elsewhere == .failure(.request(status: 400, body: ["error": "unknown-key", "key": "nope"])))
  }

  @Test(
    "400 unknown-event on GET /v1/events/sse -> streamRefused(name) [diverges from TS: the WS transport closes with 4400]"
  )
  func streamRefused() {
    let body = #"{"error":"unknown-event","name":"nope"}"#
    #expect(Self.classify(400, body, .events(filter: nil)) == .failure(.streamRefused(name: "nope")))
    #expect(Self.classify(400, body, .status) == .failure(.request(status: 400, body: ["error": "unknown-event", "name": "nope"])))
  }

  @Test("any other non-2xx -> request(status, body); a body that is not JSON is kept as a string")
  func otherStatus() {
    #expect(Self.classify(500, #"{"error":"boom"}"#) == .failure(.request(status: 500, body: ["error": "boom"])))
    #expect(Self.classify(502, "Bad Gateway") == .failure(.request(status: 502, body: "Bad Gateway")))
    #expect(Self.classify(418, "") == .failure(.request(status: 418, body: .null)))
    #expect(Self.classify(302, "") == .failure(.request(status: 302, body: .null)))
  }

  @Test("an unreachable daemon -> transport(URLError) [diverges from TS: request() throws DaemonUnreachableError]")
  func unreachable() async {
    let transport = FakeTransport { _, _ in throw URLError(.cannotConnectToHost) }
    let client = GatewayClient.testing(transport)
    do {
      _ = try await client.status()
      Issue.record("an unreachable daemon returned a status")
    } catch let error as GatewayError {
      guard case .transport(let underlying) = error else {
        Issue.record("want transport, got \(error)")
        return
      }
      #expect(underlying.code == .cannotConnectToHost)
    } catch {
      Issue.record("not a GatewayError: \(error)")
    }
  }

  @Test("only conflict, gateDenied, sourceUnavailable and unknownChat are refusals")
  func refusals() {
    #expect(
      GatewayError.conflict(ConflictDetail(error: "illegal-transition", from: "pending", requested: "recall")).refusal
        == .conflict(code: "illegal-transition", from: "pending", requested: "recall"))
    #expect(GatewayError.gateDenied(reason: "kill-switch").refusal == .denied(reason: "kill-switch"))
    #expect(GatewayError.sourceUnavailable.refusal == .sourceUnavailable)
    #expect(GatewayError.unknownChat.refusal == .unknownChat)
    let others: [GatewayError] = [
      .unauthorized, .noAuthToken, .notFound, .forbidden(body: .null), .request(status: 500, body: .null),
      .streamRefused(name: "nope"), .settingsRefused(.unknownKey(key: "nope")),
      .decoding(path: "draft.id", underlying: "missing"), .transport(URLError(.timedOut)),
    ]
    for error in others {
      #expect(error.refusal == nil, "\(error)")
    }
  }
}
