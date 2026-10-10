import Foundation
import Testing
@testable import WeMessageKit

/// R6: the client over a fake transport. Every reply body is a fixture from
/// fixtures/contract; the fake records what the client put on the wire.
@Suite("GatewayClient")
struct GatewayClientTests {
  static let a = TestTokens.make("a")
  static let b = TestTokens.make("b")
  static let chat = "iMessage;-;+15551234567"
  static let window = ScheduleWindow(days: [.mon], start: "09:00", end: "17:00")

  static func authorization(_ request: URLRequest?) -> String? {
    request?.value(forHTTPHeaderField: "Authorization")
  }

  // MARK: base URL

  @Test("base URL is http://127.0.0.1:<WEMESSAGE_PORT or 47100>")
  func baseURL() async throws {
    func port(_ env: [String: String]) -> String { ClientConfig(environment: env).baseURL.absoluteString }
    #expect(port([:]) == "http://127.0.0.1:47100")
    #expect(port(["WEMESSAGE_PORT": "47123"]) == "http://127.0.0.1:47123")
    #expect(port(["WEMESSAGE_PORT": "47123abc"]) == "http://127.0.0.1:47123", "parseInt keeps the leading digits")
    #expect(port(["WEMESSAGE_PORT": " 47124"]) == "http://127.0.0.1:47124", "parseInt skips leading whitespace")
    #expect(port(["WEMESSAGE_PORT": "+47125"]) == "http://127.0.0.1:47125")
    for bad in ["abc", "0", "-1", "", " ", "-47123"] {
      #expect(port(["WEMESSAGE_PORT": bad]) == "http://127.0.0.1:47100", "WEMESSAGE_PORT=\(bad)")
    }

    let transport = FakeTransport { _, _ in try Reply.response("status") }
    _ = try await GatewayClient.testing(transport, env: ["WEMESSAGE_PORT": "47123"]).status()
    #expect(transport.requests.first?.url?.absoluteString == "http://127.0.0.1:47123/v1/status")
  }

  @Test("WEMESSAGE_PORT above 65535 falls back to 47100 [diverges from TS: desktop auth.ts takes any positive parseInt]")
  func portCeiling() {
    #expect(ClientConfig(environment: ["WEMESSAGE_PORT": "65535"]).baseURL.absoluteString == "http://127.0.0.1:65535")
    #expect(ClientConfig(environment: ["WEMESSAGE_PORT": "65536"]).baseURL.absoluteString == "http://127.0.0.1:47100")
    #expect(ClientConfig(environment: ["WEMESSAGE_PORT": "99999999999999999999"]).baseURL.absoluteString == "http://127.0.0.1:47100")
  }

  // MARK: routes

  @Test("every Endpoint hits the ROUTE_TABLE method+path (read from responses fixtures)")
  func routes() async throws {
    let names = try Fixtures.responseNames()
    #expect(names.count == 54)
    var exercised = 0
    for name in names {
      let fixture = try Fixtures.response(name)
      let reply = fixture.reply
      let transport = FakeTransport { _, _ in reply }
      do {
        try await Self.exercise(name, GatewayClient.testing(transport))
      } catch {
        Issue.record("\(name): the client refused its own fixture: \(error)")
        continue
      }
      let requests = transport.requests
      #expect(requests.count == 1, "\(name): \(requests.count) requests")
      guard let request = requests.first, let url = request.url else { continue }
      #expect(request.httpMethod == fixture.method, "\(name): method \(request.httpMethod ?? "nil")")
      let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? ""
      #expect(Self.matches(path, template: fixture.pathTemplate), "\(name): \(path) is not \(fixture.pathTemplate)")
      exercised += 1
    }
    #expect(exercised == 54, "fixtures exercised: \(exercised)")
  }

  static func matches(_ path: String, template: String) -> Bool {
    let body = template.replacingOccurrences(of: ":[A-Za-z]+", with: "[^/]+", options: .regularExpression)
    return path.range(of: "^" + body + "$", options: .regularExpression) != nil
  }

  /// A refused outcome is a failure wherever a fixture says the call succeeds.
  static func ok<Value>(_ outcome: Outcome<Value>) throws {
    if case .refused(let refusal) = outcome {
      throw Fixtures.Malformed(detail: "refused: \(refusal)")
    }
  }

  /// The client call whose response is responses/<name>.json.
  static func exercise(_ name: String, _ client: GatewayClient) async throws {
    switch name {
    case "adapters.create":
      _ = try await client.createAdapter(AdapterInput(id: "test-adapter", kind: .generic, displayName: "Test"))
    case "adapters.delete": _ = try await client.deleteAdapter("test-adapter")
    case "adapters.get": _ = try await client.getAdapter("test-adapter")
    case "adapters.list": _ = try await client.listAdapters()
    case "adapters.patch": _ = try await client.updateAdapter("test-adapter", AdapterPatch(enabled: false))
    case "adapters.token": _ = try await client.rotateAdapterToken("test-adapter")
    case "audit.list": _ = try await client.listAudit(limit: 5)
    case "audit.verify": _ = try await client.verifyAudit()
    case "batches.get": _ = try await client.batchReport("id-0001")
    case "connect": _ = try await client.connect()
    case "contacts.delete": _ = try await client.deleteContactPolicy("+15551234567")
    case "contacts.list": _ = try await client.listContacts()
    case "contacts.put": _ = try await client.setContactPolicy("+15551234567", mode: .draftOnly)
    case "disconnect": _ = try await client.disconnect()
    case "doctor": _ = try await client.doctor()
    case "drafts.approve": try await Self.ok(client.approveDraft("id-0001"))
    case "drafts.approve.edited": try await Self.ok(client.approveDraft("id-0001", editedBody: "edited"))
    case "drafts.bulk.approve": _ = try await client.bulkDrafts(.approve, .ids(["id-0001"]))
    case "drafts.create": _ = try await client.createDraft(DraftCreateInput(chatGuid: chat, body: "hello"))
    case "drafts.get": _ = try await client.getDraft("id-0001")
    case "drafts.list.empty", "drafts.list.pending": _ = try await client.listDrafts()
    case "drafts.recall": try await Self.ok(client.recallDraft("id-0001"))
    case "drafts.redraft": try await Self.ok(client.redraftDraft("id-0001"))
    case "drafts.reject": try await Self.ok(client.rejectDraft("id-0001"))
    case "drafts.retry": try await Self.ok(client.retryDraft("id-0001"))
    case "health": _ = try await client.health()
    case "rules.create":
      _ = try await client.createRule(RuleInput(name: "Greeting", matcher: .keyword(["hello"]), adapterId: "echo"))
    case "rules.delete": _ = try await client.deleteRule("id-0018")
    case "rules.dryrun": _ = try await client.dryRunRule("id-0018", limit: 10)
    case "rules.list": _ = try await client.listRules()
    case "rules.patch": _ = try await client.updateRule("id-0018", RulePatch(enabled: false))
    case "rules.test": _ = try await client.testRule("id-0018", RuleTestInput(text: "hello"))
    case "schedules.create":
      _ = try await client.createSchedule(ScheduleInput(name: "Work", timezone: "UTC", windows: [window]))
    case "schedules.delete": _ = try await client.deleteSchedule("id-0001")
    case "schedules.list": _ = try await client.listSchedules()
    case "schedules.patch": _ = try await client.updateSchedule("id-0001", SchedulePatch(enabled: false))
    case "send": _ = try await client.send(to: "+15551234567", body: "hi")
    case "settings.list": _ = try await client.settings()
    case "settings.patch": _ = try await client.setSettings(["send.autoGraceSeconds": .int(20)])
    case "status": _ = try await client.status()
    case "threads.list": try await Self.ok(client.listThreads())
    case "threads.messages": try await Self.ok(client.readThread(chat))
    case "threads.messages.rich": try await Self.ok(client.readThread("iMessage;-;+15550100001"))
    case "threads.by-handle.found", "threads.by-handle.none":
      try await Self.ok(client.resolveHandle("+15551234567"))
    case "threads.state.list": try await Self.ok(client.listThreadStates())
    case "threads.state.put.cleared":
      try await Self.ok(client.setThreadState(chat, ThreadStateInput(act: nil, ifUpdatedAt: .value("2026-09-01T12:00:43.000Z"))))
    case "threads.state.put.snoozed":
      try await Self.ok(client.setThreadState(chat, ThreadStateInput(act: "snoozed", snoozedUntil: "2026-09-01T23:00:00.000Z")))
    case "toggles.globalmode": _ = try await client.setGlobalMode(.draftOnly)
    case "toggles.killswitch": _ = try await client.setKillSwitch(true)
    case "toggles.killswitch.off": _ = try await client.setKillSwitch(false)
    case "toggles.pause": _ = try await client.pause(until: "2026-01-02T03:04:05.000Z")
    case "toggles.resume": _ = try await client.resume()
    default: throw Fixtures.Malformed(detail: "no client call is mapped for responses/\(name).json")
    }
  }

  @Test("getRule and getSchedule return the bare payload, no envelope")
  func bareGets() async throws {
    let rule = try #require(Fixtures.response("rules.list").body.arrayValue?.first)
    let ruleText = String(decoding: try rule.canonicalData(), as: UTF8.self)
    let rules = FakeTransport { _, _ in Reply.json(200, ruleText) }
    let gotRule = try await GatewayClient.testing(rules).getRule("id-0018")
    #expect(try JSONValue.parse(JSONEncoder().encode(gotRule)) == rule)
    #expect(rules.requests.first?.url?.path == "/v1/rules/id-0018")

    let schedule = try #require(Fixtures.response("schedules.list").body.arrayValue?.first)
    let scheduleText = String(decoding: try schedule.canonicalData(), as: UTF8.self)
    let schedules = FakeTransport { _, _ in Reply.json(200, scheduleText) }
    let gotSchedule = try await GatewayClient.testing(schedules).getSchedule("id-0001")
    #expect(try JSONValue.parse(JSONEncoder().encode(gotSchedule)) == schedule)
  }

  @Test("v2 F5: resolveHandle decodes both goldens, refuses an unreadable source, throws the 400")
  func resolveHandle() async throws {
    let found = FakeTransport { _, _ in try Reply.response("threads.by-handle.found") }
    let got = try await GatewayClient.testing(found).resolveHandle("+15551234567")
    let conversation = try #require(got.value?.conversation)
    #expect(conversation.chatGuid == "iMessage;-;+15551234567")
    #expect(conversation.service == "imessage")
    #expect(conversation.isGroup == false)
    let path = found.requests.first?.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }
    #expect(path?.percentEncodedPath == "/v1/threads/by-handle/%2B15551234567")

    let none = FakeTransport { _, _ in try Reply.response("threads.by-handle.none") }
    let empty = try await GatewayClient.testing(none).resolveHandle("+15550100099")
    #expect(empty.value?.handle == "+15550100099")
    #expect(empty.value != nil && empty.value?.conversation == nil)

    let email = FakeTransport { _, _ in try Reply.response("threads.by-handle.none") }
    _ = try await GatewayClient.testing(email).resolveHandle("sam@example.com")
    let emailPath = email.requests.first?.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }
    #expect(emailPath?.percentEncodedPath == "/v1/threads/by-handle/sam%40example.com")

    let bad = FakeTransport { _, _ in try Reply.error("400.invalid-handle") }
    let fixture = try Fixtures.error("400.invalid-handle")
    await #expect(throws: GatewayError.request(status: 400, body: fixture.body)) {
      try await GatewayClient.testing(bad).resolveHandle("+15550100001;x")
    }

    let down = FakeTransport { _, _ in try Reply.error("503.source-unavailable") }
    let refused = try await GatewayClient.testing(down).resolveHandle("+15551234567")
    #expect(refused.refusal == .sourceUnavailable)
  }

  // MARK: bearer

  @Test("Authorization: Bearer <token> on every request except health")
  func bearer() async throws {
    for name in try Fixtures.responseNames() {
      let reply = try Reply.response(name)
      let transport = FakeTransport { _, _ in reply }
      try await Self.exercise(name, GatewayClient.testing(transport))
      let header = Self.authorization(transport.requests.first)
      if name == "health" {
        #expect(header == nil, "health carried a bearer")
      } else {
        #expect(header == "Bearer " + Self.a, "\(name): \(header ?? "no Authorization")")
      }
    }
    let greeting = try Fixtures.sse("greeting")
    let sse = FakeTransport { _, _ in Reply.sse(greeting) }
    for try await _ in GatewayClient.testing(sse).events() {}
    #expect(Self.authorization(sse.requests.first) == "Bearer " + Self.a, "the event stream carried no bearer")
  }

  @Test("health carries no Authorization and reads no token [diverges from TS: createClient sends the bearer to /v1/health]")
  func healthWithoutAuth() async throws {
    let file = FakeTokenFile([Self.a])
    let transport = FakeTransport { _, _ in try Reply.response("health") }
    let health = try await GatewayClient.testing(transport, file: file).health()
    #expect(health.status == "ok")
    #expect(Self.authorization(transport.requests.first) == nil)
    #expect(file.reads == 0)
  }

  // MARK: 401

  @Test("one re-read of the token file on 401, then surface tokenRejected")
  func reread401() async throws {
    let file = FakeTokenFile([Self.a])
    let transport = FakeTransport { _, _ in try Reply.error("401.unauthorized") }
    let client = GatewayClient.testing(transport, file: file)
    await #expect(throws: GatewayError.unauthorized) { try await client.status() }
    #expect(file.reads == 2, "one read to start, one re-read on the 401")
    #expect(transport.requests.count == 2, "exactly one retry")
  }

  @Test("the 401 re-read is per call: a later call re-reads again")
  func perCall401() async throws {
    let file = FakeTokenFile([Self.a])
    let transport = FakeTransport { _, _ in try Reply.error("401.unauthorized") }
    let client = GatewayClient.testing(transport, file: file)
    await #expect(throws: GatewayError.unauthorized) { try await client.status() }
    await #expect(throws: GatewayError.unauthorized) { try await client.status() }
    #expect(file.reads == 3, "the second call re-read the file once more")
    #expect(transport.requests.count == 4, "each call made exactly one retry")
  }

  @Test("a 401 re-read that finds a rotated token retries with it and keeps it")
  func rotation() async throws {
    let file = FakeTokenFile([Self.a, Self.b])
    let fresh = "Bearer " + Self.b
    let transport = FakeTransport { request, _ in
      request.value(forHTTPHeaderField: "Authorization") == fresh
        ? try Reply.response("status") : try Reply.error("401.unauthorized")
    }
    let client = GatewayClient.testing(transport, file: file)
    _ = try await client.status()
    #expect(file.reads == 2)
    #expect(transport.requests.map(Self.authorization) == ["Bearer " + Self.a, fresh])
    _ = try await client.status()
    #expect(file.reads == 2, "the rotated token is kept")
    #expect(transport.requests.count == 3)
    #expect(Self.authorization(transport.requests.last) == fresh)
  }

  // MARK: refusals

  @Test("approve/reject/recall/retry/redraft return .refused(conflict) on 409 and .refused(denied) on 403, never throw")
  func refusals() async throws {
    let illegal = try Reply.error("409.illegal-transition")
    let gate = try Reply.error("403.gate-denied")
    let cases: [(Reply, Refusal)] = [
      (illegal, .conflict(code: "illegal-transition", from: "pending", requested: "recall")),
      (gate, .denied(reason: "kill-switch")),
    ]
    for (reply, want) in cases {
      let client = GatewayClient.testing(FakeTransport { _, _ in reply })
      let approve = try await client.approveDraft("id-0001")
      #expect(approve == .refused(want))
      let edited = try await client.approveDraft("id-0001", editedBody: "edited")
      #expect(edited == .refused(want))
      let reject = try await client.rejectDraft("id-0001", reason: "not now")
      #expect(reject == .refused(want))
      let recall = try await client.recallDraft("id-0001")
      #expect(recall == .refused(want))
      let retry = try await client.retryDraft("id-0001")
      #expect(retry == .refused(want))
      let redraft = try await client.redraftDraft("id-0001")
      #expect(redraft == .refused(want))
    }
    let elapsed = GatewayClient.testing(FakeTransport { _, _ in try Reply.error("409.grace-elapsed") })
    let late = try await elapsed.recallDraft("id-0001")
    #expect(late.refusal == .conflict(code: "grace-elapsed", from: "approved", requested: "recall"))
  }

  @Test("threads/transcript return .refused(sourceUnavailable|unknownChat)")
  func threads() async throws {
    let unavailable = GatewayClient.testing(FakeTransport { _, _ in try Reply.error("503.source-unavailable") })
    let list = try await unavailable.listThreads()
    #expect(list == .refused(.sourceUnavailable))
    let read = try await unavailable.readThread(Self.chat)
    #expect(read == .refused(.sourceUnavailable))

    let unknown = GatewayClient.testing(FakeTransport { _, _ in try Reply.error("404.unknown-chat") })
    let missing = try await unknown.readThread(Self.chat, limit: 20)
    #expect(missing == .refused(.unknownChat))
    await #expect(throws: GatewayError.request(status: 404, body: ["error": "unknown-chat"])) {
      try await unknown.getDraft("id-0001")
    }

    let locked = GatewayClient.testing(FakeTransport { _, _ in try Reply.error("503.no-auth-token") })
    await #expect(throws: GatewayError.noAuthToken) { try await locked.listThreads() }
  }

  @Test("DELETE 204 -> deleted(id)")
  func deletes() async throws {
    let client = GatewayClient.testing(FakeTransport { _, _ in Reply(status: 204) })
    let rule = try await client.deleteRule("rule-1")
    #expect(rule == Deleted(deleted: "rule-1"))
    let schedule = try await client.deleteSchedule("sched-1")
    #expect(schedule == Deleted(deleted: "sched-1"))
    let adapter = try await client.deleteAdapter("echo")
    #expect(adapter == Deleted(deleted: "echo"))

    let handle = try #require(Fixtures.response("contacts.delete").body["deleted"]?.stringValue)
    let contacts = GatewayClient.testing(FakeTransport { _, _ in try Reply.response("contacts.delete") })
    let contact = try await contacts.deleteContactPolicy(handle)
    #expect(contact == Deleted(deleted: handle))
  }

  @Test("a 2xx body that does not match its DTO is a decoding error naming the path")
  func decodingPath() async throws {
    let fixture = try Fixtures.response("drafts.get")
    let mutated = fixture.body.injecting("zzUnknown", 1, at: [.key("draft")])
    let text = String(decoding: try mutated.canonicalData(), as: UTF8.self)
    let client = GatewayClient.testing(FakeTransport { _, _ in Reply.json(200, text) })
    do {
      _ = try await client.getDraft("id-0001")
      Issue.record("an unknown key decoded")
    } catch let error as GatewayError {
      guard case .decoding(let path, _) = error else {
        Issue.record("want decoding, got \(error)")
        return
      }
      #expect(path == "draft.zzUnknown")
    }
  }

  // MARK: requests on the wire

  @Test("request bodies mirror createClient: send prefixes iMessage;-;, approve and reject always send JSON, resume sends until null")
  func bodies() throws {
    func body(_ endpoint: Endpoint) throws -> JSONValue {
      guard let data = try endpoint.body() else { return "<no body>" }
      return try JSONValue.parse(data)
    }
    #expect(try body(.send(to: "+15551234567", body: "hi")) == ["chatGuid": "iMessage;-;+15551234567", "body": "hi"])
    #expect(try body(.approveDraft(id: "d", editedBody: nil)) == [:])
    #expect(try body(.approveDraft(id: "d", editedBody: "x")) == ["editedBody": "x"])
    #expect(try body(.rejectDraft(id: "d", reason: nil)) == [:])
    #expect(try body(.disconnect(purge: false)) == ["purge": false])
    #expect(try body(.resume) == ["until": nil])
    #expect(try body(.pause(until: "2026-01-02T03:04:05.000Z")) == ["until": "2026-01-02T03:04:05.000Z"])
    #expect(try body(.setKillSwitch(on: true, circuit: nil)) == ["on": true])
    #expect(try body(.setContactPolicy(handle: "+15551234567", mode: .draftOnly, displayName: nil)) == ["mode": "draft-only"])
    #expect(try body(.updateRule(id: "r", RulePatch(scheduleId: .null))) == ["scheduleId": nil])
    #expect(try body(.testRule(id: "r", RuleTestInput(text: nil))) == ["text": nil])
    for endpoint: Endpoint in [.connect, .recallDraft(id: "d"), .retryDraft(id: "d"), .redraftDraft(id: "d"), .rotateAdapterToken(id: "echo"), .status] {
      #expect(try endpoint.body() == nil, "\(endpoint.route) sends a body")
    }

    let base = URL(string: "http://127.0.0.1:47100")!
    #expect(try Endpoint.connect.urlRequest(baseURL: base, token: nil).value(forHTTPHeaderField: "Content-Type") == nil)
    let approve = try Endpoint.approveDraft(id: "d", editedBody: nil).urlRequest(baseURL: base, token: nil)
    #expect(approve.value(forHTTPHeaderField: "Content-Type") == "application/json")
    #expect(approve.httpMethod == "POST")
  }

  @Test("paths and queries are encoded like the TS client (encodeURIComponent, URLSearchParams)")
  func encoding() throws {
    let base = URL(string: "http://127.0.0.1:47100")!
    func url(_ endpoint: Endpoint) throws -> String {
      try endpoint.urlRequest(baseURL: base, token: nil).url?.absoluteString ?? ""
    }
    let read = Endpoint.readThread(guid: Self.chat, limit: 50, before: nil, until: "2026-01-02T03:04:05.000Z")
    #expect(read.path == "/v1/threads/iMessage%3B-%3B%2B15551234567/messages")
    #expect(
      try url(read)
        == "http://127.0.0.1:47100/v1/threads/iMessage%3B-%3B%2B15551234567/messages?limit=50&until=2026-01-02T03%3A04%3A05.000Z")
    #expect(Endpoint.deleteContactPolicy(handle: "+15551234567").path == "/v1/contacts/%2B15551234567")
    #expect(Endpoint.getDraft(id: "a b/c").path == "/v1/drafts/a%20b%2Fc")
    #expect(Endpoint.getDraft(id: "it's-(ok)!~*_.").path == "/v1/drafts/it's-(ok)!~*_.")
    #expect(
      try url(.listAudit(AuditQuery(since: "2026-01-02T03:04:05.000Z", event: "draft.sent", limit: 10)))
        == "http://127.0.0.1:47100/v1/audit?since=2026-01-02T03%3A04%3A05.000Z&event=draft.sent&limit=10")
    #expect(try url(.listDrafts(DraftFilter(contact: "+15551234567 x"))) == "http://127.0.0.1:47100/v1/drafts?contact=%2B15551234567+x")
    #expect(try url(.listDrafts(DraftFilter())) == "http://127.0.0.1:47100/v1/drafts")
    #expect(
      try url(.events(filter: [.draftSent, .draftCreated]))
        == "http://127.0.0.1:47100/v1/events/sse?events=draft.sent,draft.created")
    #expect(try url(.events(filter: [])) == "http://127.0.0.1:47100/v1/events/sse")
    #expect(try url(.events(filter: nil)) == "http://127.0.0.1:47100/v1/events/sse")
  }

  // MARK: the event stream

  @Test("the SSE session config: no cache, Accept text/event-stream, timeout >= 60s")
  func sseConfiguration() async throws {
    let config = URLSessionTransport.sseConfiguration()
    #expect(config.requestCachePolicy == .reloadIgnoringLocalCacheData)
    #expect(config.urlCache == nil)
    #expect(config.httpAdditionalHeaders?["Accept"] as? String == "text/event-stream")
    #expect(config.timeoutIntervalForRequest >= 60)

    let live = URLSessionTransport().streamSession.configuration
    #expect(live.requestCachePolicy == .reloadIgnoringLocalCacheData)
    #expect(live.urlCache == nil)
    #expect(live.httpAdditionalHeaders?["Accept"] as? String == "text/event-stream")
    #expect(live.timeoutIntervalForRequest >= 60)

    let sse = FakeTransport { _, _ in Reply.sse(Data()) }
    for try await _ in GatewayClient.testing(sse).events() {}
    let request = try #require(sse.requests.first)
    #expect(request.value(forHTTPHeaderField: "Accept") == "text/event-stream")
    #expect(request.cachePolicy == .reloadIgnoringLocalCacheData)
    #expect(request.httpMethod == "GET")
  }

  @Test("the event stream re-reads the token once on 401, and a 400 unknown-event is streamRefused")
  func eventsErrors() async throws {
    let file = FakeTokenFile([Self.a, Self.b])
    let greeting = try Fixtures.sse("greeting")
    let fresh = "Bearer " + Self.b
    let transport = FakeTransport { request, _ in
      request.value(forHTTPHeaderField: "Authorization") == fresh ? Reply.sse(greeting) : try Reply.error("401.unauthorized")
    }
    var ids: [Int?] = []
    for try await frame in GatewayClient.testing(transport, file: file).events() { ids.append(frame.id) }
    #expect(ids == [1])
    #expect(file.reads == 2)
    #expect(transport.requests.count == 2)

    let refused = FakeTransport { _, _ in try Reply.error("400.unknown-event") }
    do {
      for try await _ in GatewayClient.testing(refused).events(filter: [.draftSent]) {}
      Issue.record("a refused filter streamed")
    } catch let error as GatewayError {
      #expect(error == .streamRefused(name: "nope"))
    }
  }

  @Test("gatewayEvents decodes each frame into a typed GatewayEvent")
  func typedEvents() async throws {
    let body = try Fixtures.sse("greeting") + Fixtures.sse("keepalive") + Fixtures.sse("draft.sent")
    let transport = FakeTransport { _, _ in Reply.sse(body) }
    var events: [GatewayEvent] = []
    for try await event in GatewayClient.testing(transport).gatewayEvents() { events.append(event) }
    let sent = try GatewayEvent.decode(name: "draft.sent", data: try Fixtures.event("draft.sent").canonicalData())
    #expect(events == [.connectionState(ConnectionStateEvent(state: "fully-connected")), sent])
  }
}
