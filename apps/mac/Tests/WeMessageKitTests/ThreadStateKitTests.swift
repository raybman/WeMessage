import Foundation
import Testing
@testable import WeMessageKit

/// v2 F3c (G-06a): the Kit's half of thread state. The two endpoints, the five
/// contract fixtures, the record's reading as a ThreadAct, and the sync seam
/// the app's QueueStateStore writes through.
@Suite("ThreadStateKit")
struct ThreadStateKitTests {
  static let chat = "iMessage;-;+15551234567"
  static let base = URL(string: "http://127.0.0.1:47100")!

  static func body(_ request: URLRequest?) throws -> JSONValue {
    guard let data = request?.httpBody else { return "<no body>" }
    return try JSONValue.parse(data)
  }

  // MARK: endpoints

  @Test("golden paths: PUT /v1/threads/:guid/state (guid encoded) and GET /v1/threads/state")
  func goldenPaths() throws {
    let put = Endpoint.setThreadState(guid: Self.chat, ThreadStateInput(act: "done"))
    #expect(put.path == "/v1/threads/iMessage%3B-%3B%2B15551234567/state")
    let putRequest = try put.urlRequest(baseURL: Self.base, token: nil)
    #expect(putRequest.httpMethod == "PUT")
    #expect(putRequest.value(forHTTPHeaderField: "Content-Type") == "application/json")
    #expect(putRequest.url?.absoluteString == "http://127.0.0.1:47100/v1/threads/iMessage%3B-%3B%2B15551234567/state")

    let list = Endpoint.listThreadStates
    #expect(list.path == "/v1/threads/state")
    let listRequest = try list.urlRequest(baseURL: Self.base, token: nil)
    #expect(listRequest.httpMethod == "GET")
    #expect(try list.body() == nil)
  }

  @Test("the PUT body: act is always sent, nil fields stay off the wire, .null is sent as null")
  func putBodies() throws {
    func body(_ input: ThreadStateInput) throws -> JSONValue {
      try JSONValue.parse(try #require(try Endpoint.setThreadState(guid: Self.chat, input).body()))
    }
    #expect(try body(ThreadStateInput(act: nil)) == ["act": nil])
    #expect(try body(ThreadStateInput(act: "done", ifUpdatedAt: .null)) == ["act": "done", "ifUpdatedAt": nil])
    #expect(
      try body(ThreadStateInput(act: "snoozed", snoozedUntil: "2026-09-01T23:00:00.000Z", ifUpdatedAt: .value("2026-09-01T12:00:43.000Z")))
        == ["act": "snoozed", "snoozedUntil": "2026-09-01T23:00:00.000Z", "ifUpdatedAt": "2026-09-01T12:00:43.000Z"])
    #expect(try body(ThreadStateInput(act: "muted", actAt: "2026-09-01T12:00:00.000Z")) == ["act": "muted", "actAt": "2026-09-01T12:00:00.000Z"])
    #expect(try body(ThreadStateInput(act: nil, attention: .value("stream"))) == ["act": nil, "attention": "stream"])
  }

  // MARK: the five fixtures

  @Test("all five thread-state fixtures decode through the client")
  func fixturesDecode() async throws {
    let list = try await GatewayClient.testing(FakeTransport { _, _ in try Reply.response("threads.state.list") })
      .listThreadStates()
    let page = try #require(list.value)
    #expect(page.asOf == "2026-09-01T12:00:43.000Z")
    #expect(page.states.count == 1)
    #expect(page.states.first?.act == "snoozed")
    #expect(page.states.first?.awake == false)

    let snoozed = try await GatewayClient.testing(FakeTransport { _, _ in try Reply.response("threads.state.put.snoozed") })
      .setThreadState(Self.chat, ThreadStateInput(act: "snoozed", snoozedUntil: "2026-09-01T23:00:00.000Z"))
    #expect(snoozed.value?.state?.snoozedUntil == "2026-09-01T23:00:00.000Z")

    let cleared = try await GatewayClient.testing(FakeTransport { _, _ in try Reply.response("threads.state.put.cleared") })
      .setThreadState(Self.chat, ThreadStateInput(act: nil))
    #expect(cleared == .ok(ThreadStateEnvelope(state: nil)))

    let invalid = GatewayClient.testing(FakeTransport { _, _ in try Reply.error("400.invalid-thread-state") })
    await #expect(throws: GatewayError.self) {
      try await invalid.setThreadState(Self.chat, ThreadStateInput(act: "snoozed"))
    }
    do {
      _ = try await invalid.setThreadState(Self.chat, ThreadStateInput(act: "snoozed"))
    } catch let error as GatewayError {
      guard case .request(let status, let body) = error else {
        Issue.record("want request(400), got \(error)")
        return
      }
      #expect(status == 400)
      #expect(body["error"]?.stringValue == "invalid-thread-state")
    }

    let conflict = try await GatewayClient.testing(FakeTransport { _, _ in try Reply.error("409.thread-state-conflict") })
      .setThreadState(Self.chat, ThreadStateInput(act: "done", ifUpdatedAt: .null))
    #expect(conflict == .refused(.conflict(code: "conflict", from: nil, requested: nil)))
  }

  // MARK: the record as an act

  static func record(
    act: String?, actAt: String? = "2026-09-01T12:00:43.000Z", until: String? = nil, attention: String? = nil
  ) -> ThreadStateRecord {
    ThreadStateRecord(
      chatGuid: chat, act: act, actAt: actAt, snoozedUntil: until, attention: attention,
      updatedAt: "2026-09-01T12:00:43.000Z", awake: false)
  }

  @Test("threadAct reads done, snoozed and muted with their instants; unknown or unparseable reads as none")
  func threadAct() {
    let at = WireDate.parse("2026-09-01T12:00:43.000Z")!
    let until = WireDate.parse("2026-09-01T23:00:00.000Z")!
    #expect(Self.record(act: "done").threadAct == .done(at: at))
    #expect(Self.record(act: "muted").threadAct == .muted(at: at))
    #expect(Self.record(act: "snoozed", until: "2026-09-01T23:00:00.000Z").threadAct == .snoozed(at: at, until: until))
    #expect(Self.record(act: "snoozed", until: nil).threadAct == nil, "a snooze with no end proves nothing")
    #expect(Self.record(act: "archived").threadAct == nil, "a vocabulary the daemon widened reads as none")
    #expect(Self.record(act: "done", actAt: "yesterday").threadAct == nil)
    #expect(Self.record(act: nil, actAt: nil).threadAct == nil)
  }

  @Test("threadMode reads queue, stream and muted; null and unknown read as the derived default")
  func threadMode() {
    #expect(Self.record(act: nil, attention: "queue").threadMode == .queue)
    #expect(Self.record(act: nil, attention: "stream").threadMode == .stream)
    #expect(Self.record(act: nil, attention: "muted").threadMode == .muted)
    #expect(Self.record(act: nil, attention: nil).threadMode == nil)
    #expect(Self.record(act: nil, attention: "loud").threadMode == nil)
  }

  @Test("a ThreadAct becomes a PUT body: a fresh act lets the daemon stamp actAt, a restore sends its own")
  func inputFromAct() {
    let at = WireDate.parse("2026-09-01T12:00:00.000Z")!
    let until = WireDate.parse("2026-09-02T09:00:00.000Z")!
    #expect(
      ThreadStateInput.writing(.done(at: at), expected: nil, restore: false)
        == ThreadStateInput(act: "done", ifUpdatedAt: .null))
    #expect(
      ThreadStateInput.writing(.snoozed(at: at, until: until), expected: "2026-09-01T12:00:43.000Z", restore: false)
        == ThreadStateInput(
          act: "snoozed", snoozedUntil: "2026-09-02T09:00:00.000Z", ifUpdatedAt: .value("2026-09-01T12:00:43.000Z")))
    #expect(
      ThreadStateInput.writing(.muted(at: at), expected: "x", restore: true)
        == ThreadStateInput(act: "muted", actAt: "2026-09-01T12:00:00.000Z", ifUpdatedAt: .value("x")))
    #expect(ThreadStateInput.writing(nil, expected: "x", restore: true) == ThreadStateInput(act: nil, ifUpdatedAt: .value("x")))
  }

  // MARK: GatewayThreadStateSync

  @Test("load maps every record by chatGuid, keeping updatedAt even when the act is unknown")
  func gatewayLoad() async throws {
    let sync = GatewayThreadStateSync(client: GatewayClient.testing(FakeTransport { _, _ in try Reply.response("threads.state.list") }))
    let loaded = try await sync.load()
    let at = WireDate.parse("2026-09-01T12:00:43.000Z")!
    let until = WireDate.parse("2026-09-01T23:00:00.000Z")!
    #expect(loaded == [Self.chat: SyncedThreadState(act: .snoozed(at: at, until: until), mode: nil, updatedAt: "2026-09-01T12:00:43.000Z")])
  }

  @Test("write PUTs the act with ifUpdatedAt and answers the new updatedAt, nil when cleared")
  func gatewayWrite() async throws {
    let transport = FakeTransport { _, index in
      try Reply.response(index == 0 ? "threads.state.put.snoozed" : "threads.state.put.cleared")
    }
    let sync = GatewayThreadStateSync(client: GatewayClient.testing(transport))
    let at = WireDate.parse("2026-09-01T12:00:00.000Z")!
    let until = WireDate.parse("2026-09-01T23:00:00.000Z")!
    let first = try await sync.write(Self.chat, act: .snoozed(at: at, until: until), expected: nil)
    #expect(first == .ok("2026-09-01T12:00:43.000Z"))
    let second = try await sync.write(Self.chat, act: nil, expected: "2026-09-01T12:00:43.000Z", restore: true)
    #expect(second == .ok(nil))

    let requests = transport.requests
    #expect(requests.count == 2)
    #expect(requests.allSatisfy { $0.httpMethod == "PUT" && $0.url?.path.hasSuffix("/state") == true })
    #expect(
      try Self.body(requests[0])
        == ["act": "snoozed", "snoozedUntil": "2026-09-01T23:00:00.000Z", "ifUpdatedAt": nil])
    #expect(try Self.body(requests[1]) == ["act": nil, "ifUpdatedAt": "2026-09-01T12:00:43.000Z"])
  }

  @Test("a 409 is a refusal, not a throw")
  func gatewayConflict() async throws {
    let sync = GatewayThreadStateSync(
      client: GatewayClient.testing(FakeTransport { _, _ in try Reply.error("409.thread-state-conflict") }))
    let result = try await sync.write(Self.chat, act: .done(at: Date(timeIntervalSince1970: 0)), expected: nil)
    #expect(result == .refused(.conflict(code: "conflict", from: nil, requested: nil)))
  }

  // MARK: InMemoryThreadStateSync

  @Test("the in-memory sync stamps, checks ifUpdatedAt like the daemon, and deletes a cleared record")
  func inMemory() async throws {
    let sync = InMemoryThreadStateSync()
    let at = Date(timeIntervalSince1970: 1_788_264_042)
    let first = try await sync.write(Self.chat, act: .done(at: at), expected: nil)
    guard case .ok(let stamp?) = first else {
      Issue.record("want a stamp, got \(first)")
      return
    }
    #expect(try await sync.load()[Self.chat]?.act == .done(at: at))

    let stale = try await sync.write(Self.chat, act: .muted(at: at), expected: nil)
    #expect(stale == .refused(.conflict(code: "conflict", from: nil, requested: nil)))
    #expect(try await sync.load()[Self.chat]?.act == .done(at: at), "a refused write changes nothing")

    let cleared = try await sync.write(Self.chat, act: nil, expected: stamp)
    #expect(cleared == .ok(nil))
    #expect(try await sync.load().isEmpty)
    #expect(await sync.writes.count == 3)
  }

  @Test("the in-memory sync can be told to refuse or fail the next write")
  func inMemoryScripted() async throws {
    let sync = InMemoryThreadStateSync()
    await sync.refuseNext(.denied(reason: "test"))
    let refused = try await sync.write(Self.chat, act: .done(at: Date()), expected: nil)
    #expect(refused == .refused(.denied(reason: "test")))
    await sync.failNext()
    await #expect(throws: (any Error).self) {
      try await sync.write(Self.chat, act: .done(at: Date()), expected: nil)
    }
    #expect(try await sync.load().isEmpty)
  }
}
