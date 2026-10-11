import Foundation
import Testing
@testable import WeMessageKit

/// R1: the kit against the S0 contract in fixtures/contract. Every row reads
/// the fixtures from the tree; nothing here restates a fixture's content.
@Suite("Contract")
struct ContractTests {
  // MARK: manifest and wire

  @Test("manifest lists every fixture on disk and nothing else")
  func manifest() throws {
    let manifest = try Repo.json("fixtures/contract/manifest.json")
    let listed = try #require(manifest["files"]?.arrayValue).compactMap(\.stringValue)
    let onDisk = try Repo.files(under: "fixtures/contract").filter { $0 != "manifest.json" }
    #expect(listed.count == Set(listed).count, "the manifest lists a file twice")
    let missing = Set(onDisk).subtracting(listed).sorted()
    let phantom = Set(listed).subtracting(onDisk).sorted()
    #expect(missing.isEmpty, "on disk but not in the manifest: \(missing)")
    #expect(phantom.isEmpty, "in the manifest but not on disk: \(phantom)")
    #expect(listed.count > 100, "the manifest is suspiciously short: \(listed.count)")
  }

  @Test("wire.json: 22 EventName cases, 9 DraftState cases, version 1")
  func wire() throws {
    let wire = try Fixtures.wire()
    #expect(WireVersion.current == 1)
    #expect(wire["wireVersion"]?.intValue == WireVersion.current)

    let names = try #require(wire["eventNames"]?.arrayValue).compactMap(\.stringValue)
    #expect(names.count == 22)
    #expect(EventName.allCases.count == 22)
    #expect(EventName.allCases.map(\.rawValue) == names)

    let states = try #require(wire["draftStates"]?.arrayValue).compactMap(\.stringValue)
    #expect(states.count == 9)
    #expect(DraftState.allCases.count == 9)
    #expect(DraftState.allCases.map(\.rawValue) == states)

    let backoff = try #require(wire["backoff"])
    #expect(backoff["steps"]?.arrayValue?.compactMap(\.intValue) == Backoff.steps)
    #expect(backoff["jitter"]?.doubleValue == Backoff.jitter)
    #expect(backoff["auditGapLimit"]?.intValue == Backoff.auditGapLimit)

    #expect(wire["sse"]?["path"]?.stringValue == Defaults.ssePath)
    #expect(wire["sse"]?["keepaliveMs"]?.intValue == Defaults.keepaliveMs)
    #expect(wire["defaults"]?["port"]?.intValue == Defaults.port)
    #expect(wire["defaults"]?["tokenFile"]?.stringValue == Defaults.tokenFile)

    let keys = Set((wire.objectValue ?? [:]).keys)
    #expect(keys == ["wireVersion", "eventNames", "draftStates", "backoff", "sse", "defaults"])
  }

  // MARK: responses

  @Test("every responses/*.json decodes strictly into its DTO")
  func responsesDecode() throws {
    let names = try Fixtures.responseNames()
    #expect(names.count == 57, "responses on disk: \(names.count)")
    for name in names {
      let fixture = try Fixtures.response(name)
      do {
        let encoded = try Fixtures.roundTrip(name, fixture.bodyData)
        if fixture.status == 204 {
          #expect(fixture.body == .null, "\(name): a 204 carries no body")
          #expect(encoded == nil, "\(name): a 204 decodes to nothing")
        } else {
          #expect(encoded != nil, "\(name): a \(fixture.status) decodes to a DTO")
        }
      } catch {
        Issue.record("responses/\(name).json does not decode: \(error)")
      }
    }
  }

  @Test("every responses/*.json re-encodes to the same canonical JSON")
  func responsesReencode() throws {
    var compared = 0
    for name in try Fixtures.responseNames() {
      let fixture = try Fixtures.response(name)
      guard let encoded = try Fixtures.roundTrip(name, fixture.bodyData) else { continue }
      let again = try JSONValue.parse(encoded)
      let want = String(decoding: try fixture.body.canonicalData(), as: UTF8.self)
      let got = String(decoding: try again.canonicalData(), as: UTF8.self)
      #expect(again == fixture.body, "\(name):\n want \(want)\n got  \(got)")
      compared += 1
    }
    #expect(compared == 54, "non-204 responses compared: \(compared)")
  }

  @Test(
    "strict decoding refuses an unknown key injected into every object of every responses fixture (open JSON objects exempt)"
  )
  func strictInjection() throws {
    var injected = 0
    for name in try Fixtures.responseNames() {
      let fixture = try Fixtures.response(name)
      guard fixture.body != .null else { continue }
      let paths = fixture.body.objectPaths().filter { !Self.isOpenObject($0) }
      #expect(!paths.isEmpty, "\(name): no closed object to inject into")
      for path in paths {
        let mutated = fixture.body.injecting("zzUnknown", 1, at: path)
        let data = try mutated.canonicalData()
        do {
          _ = try Fixtures.roundTrip(name, data)
          Issue.record("\(name) \(path.rendered): an unknown key decoded without complaint")
        } catch DecodingError.dataCorrupted(let context) {
          #expect(
            context.debugDescription.contains("zzUnknown"),
            "\(name) \(path.rendered): refused, but not for the unknown key: \(context.debugDescription)"
          )
        } catch {
          Issue.record("\(name) \(path.rendered): refused with the wrong error: \(error)")
        }
        injected += 1
      }
    }
    #expect(injected > 48, "injections attempted: \(injected)")
  }

  /// Objects the daemon defines as open maps: an adapter's free-form `config`,
  /// and the settings map keyed by dotted setting names (its entries are closed).
  static func isOpenObject(_ path: [PathStep]) -> Bool {
    path.last == .key("config") || path == [.key("settings")]
  }

  // MARK: errors

  @Test("every errors/*.json maps to the expected GatewayError")
  func errors() throws {
    let names = try Fixtures.errorNames()
    #expect(names.count == 22, "errors on disk: \(names.count)")
    for name in names {
      let fixture = try Fixtures.error(name)
      guard let (endpoint, expected) = Self.expectation(for: fixture) else {
        Issue.record("no expectation written for errors/\(name).json")
        continue
      }
      #expect(endpoint.route == fixture.route, "\(name): the sample endpoint is not the fixture's route")
      let got = GatewayError.classify(status: fixture.status, body: fixture.wireBody, endpoint: endpoint)
      #expect(got == .failure(expected), "\(name)")
    }
  }

  static func expectation(for fixture: ContractFixture) -> (Endpoint, GatewayError)? {
    let chat = "iMessage;-;+15551234567"
    switch fixture.name {
    case "400.invalid-body":
      return (.createDraft(DraftCreateInput(chatGuid: chat, body: "hi")), .request(status: 400, body: fixture.body))
    case "400.invalid-cursor":
      return (.listThreads(limit: nil, cursor: "nope"), .request(status: 400, body: fixture.body))
    case "400.invalid-handle":
      return (.resolveHandle("+15550100001;x"), .request(status: 400, body: fixture.body))
    case "400.invalid-thread-state":
      return (.setThreadState(guid: chat, ThreadStateInput(act: "snoozed")), .request(status: 400, body: fixture.body))
    case "400.empty-search", "400.invalid-search":
      // A query the daemon will not run is the caller's bug: thrown, never a refusal.
      return (.search(SearchParams(tz: "UTC")), .request(status: 400, body: fixture.body))
    case "400.settings-refusal":
      return (.setSettings(["unknownKey": .int(1)]), .settingsRefused(.unknownKey(key: "unknownKey")))
    case "400.unknown-event":
      return (.events(filter: nil), .streamRefused(name: "nope"))
    case "401.missing", "401.unauthorized":
      return (.status, .unauthorized)
    case "403.gate-denied":
      return (.send(to: "+15551234567", body: "hi"), .gateDenied(reason: "kill-switch"))
    case "404.not-found":
      return (.getDraft(id: "id-0001"), .notFound)
    case "404.attachment-not-local":
      // v2 F6c: classify alone keeps the body; attachmentBytes maps the reason.
      return (.attachmentBytes(id: "AT-0001", range: nil), .request(status: 404, body: fixture.body))
    case "416.range":
      return (.attachmentBytes(id: "AT-0001", range: 100_000...100_001), .request(status: 416, body: fixture.body))
    case "404.unknown-chat":
      return (.readThread(guid: chat, limit: nil, before: nil, until: nil), .unknownChat)
    case "409.grace-elapsed":
      return (.recallDraft(id: "id-0001"), .conflict(ConflictDetail(error: "grace-elapsed", from: "approved", requested: "recall")))
    case "409.illegal-transition":
      return (.recallDraft(id: "id-0001"), .conflict(ConflictDetail(error: "illegal-transition", from: "pending", requested: "recall")))
    case "409.not-armed":
      return (.pause(until: "2026-01-02T03:04:05.000Z"), .conflict(ConflictDetail(error: "not-armed")))
    case "409.thread-state-conflict":
      return (
        .setThreadState(guid: chat, ThreadStateInput(act: "done", ifUpdatedAt: .null)),
        .conflict(ConflictDetail(error: "conflict", detail: fixture.body["detail"]))
      )
    case "409.parked":
      let input = ScheduleInput(name: "Work", timezone: "America/Los_Angeles", windows: [ScheduleWindow(days: [.mon], start: "09:00", end: "17:00")])
      return (.createSchedule(input), .conflict(ConflictDetail(error: "parked", detail: fixture.body["detail"])))
    case "503.no-auth-token":
      return (.status, .noAuthToken)
    case "503.source-unavailable":
      return (.listThreads(limit: nil, cursor: nil), .sourceUnavailable)
    default:
      return nil
    }
  }

  // MARK: requests

  @Test(
    "every requests/*.schema.json: the Swift request type encodes only keys the schema names, and all required keys"
  )
  func requestSchemas() throws {
    let names = Set(try Fixtures.schemaNames())
    #expect(names.count == 30, "request schemas on disk: \(names.count)")
    for name in names.sorted() { try MiniSchema.audit(try Fixtures.schema(name), at: name) }

    var seenKeys: [String: Set<String>] = [:]
    var firstInstance: [String: JSONValue] = [:]
    for endpoint in Self.requestSamples {
      for (schemaName, instance) in try Self.instances(for: endpoint, schemaNames: names) {
        guard names.contains(schemaName) else {
          Issue.record("\(endpoint.route) sends \(instance) but S0 recorded no \(schemaName).schema.json")
          continue
        }
        let problems = try MiniSchema.violations(of: instance, against: try Fixtures.schema(schemaName))
        #expect(problems.isEmpty, "\(schemaName): \(instance) breaks the schema: \(problems)")
        seenKeys[schemaName, default: []].formUnion((instance.objectValue ?? [:]).keys)
        if firstInstance[schemaName] == nil { firstInstance[schemaName] = instance }
      }
    }

    for name in names.sorted() {
      let schema = try Fixtures.schema(name)
      guard let seen = seenKeys[name] else {
        Issue.record("\(name): no Swift request type is exercised against it")
        continue
      }
      if let props = schema["properties"]?.objectValue {
        #expect(seen == Set(props.keys), "\(name): the samples encode \(seen.sorted()), the schema names \(props.keys.sorted())")
      }
    }

    // The checker has teeth: an unknown key and a missing required key are refused.
    for (name, instance) in firstInstance.sorted(by: { $0.key < $1.key }) {
      let schema = try Fixtures.schema(name)
      if schema["additionalProperties"] == .bool(false) {
        let extra = try MiniSchema.violations(of: instance.replacing("zzUnknown", with: 1), against: schema)
        #expect(!extra.isEmpty, "\(name): MiniSchema let an unknown key through")
      }
      for key in (schema["required"]?.arrayValue ?? []).compactMap(\.stringValue) {
        guard case .object(var fields) = instance else { continue }
        fields[key] = nil
        let missing = try MiniSchema.violations(of: .object(fields), against: schema)
        #expect(!missing.isEmpty, "\(name): MiniSchema missed the required key \(key)")
      }
    }
  }

  /// "POST /v1/drafts/:id/approve" names post.v1.drafts.id.approve.
  static func schemaBase(_ route: String) -> String {
    let parts = route.split(separator: " ")
    let path = parts[1].replacingOccurrences(of: ":", with: "").split(separator: "/").joined(separator: ".")
    return parts[0].lowercased() + "." + path
  }

  /// What the daemon's validators see for `endpoint`: the JSON body, or the
  /// query as an object for a GET, plus the path parameters where S0 recorded
  /// a params schema.
  static func instances(for endpoint: Endpoint, schemaNames: Set<String>) throws -> [(String, JSONValue)] {
    let base = schemaBase(endpoint.route)
    var out: [(String, JSONValue)] = []
    if let body = try endpoint.body() {
      out.append((base, try JSONValue.parse(body)))
    } else if endpoint.method == "GET", schemaNames.contains(base) {
      out.append((base, MiniSchema.queryInstance(endpoint.queryItems, schema: try Fixtures.schema(base))))
    } else if !endpoint.queryItems.isEmpty {
      out.append((base, MiniSchema.queryInstance(endpoint.queryItems, schema: .null)))
    }
    if schemaNames.contains(base + ".params") {
      out.append((base + ".params", pathParameters(endpoint)))
    }
    return out
  }

  static func pathParameters(_ endpoint: Endpoint) -> JSONValue {
    let template = endpoint.route.split(separator: " ")[1].split(separator: "/")
    let actual = endpoint.path.split(separator: "/")
    var fields: [String: JSONValue] = [:]
    for (want, got) in zip(template, actual) where want.hasPrefix(":") {
      fields[String(want.dropFirst())] = .string(String(got).removingPercentEncoding ?? String(got))
    }
    return .object(fields)
  }

  static let chat = "iMessage;-;+15551234567"
  static let iso = "2026-01-02T03:04:05.000Z"
  static let window = ScheduleWindow(days: [.mon, .fri], start: "09:00", end: "17:00")

  /// One or more samples per request schema; together they set every key the
  /// schema names (the coverage half of the row above).
  static var requestSamples: [Endpoint] {
    [
      .listAudit(AuditQuery(since: iso, event: "draft.sent", limit: 100)),
      .listAudit(AuditQuery()),
      .listDrafts(DraftFilter(state: .pending, ruleId: "rule-1", contact: "+15551234567", batchId: "batch-1")),
      .listDrafts(DraftFilter()),
      .dryRunRule(id: "rule-1", limit: 50),
      .readThread(guid: chat, limit: 50, before: "guid-1", until: nil),
      .readThread(guid: chat, limit: nil, before: nil, until: iso),
      .listThreads(limit: 25, cursor: "cursor-1"),
      .listThreads(limit: nil, cursor: nil),
      .resolveHandle("+15551234567"),
      .search(
        SearchParams(
          terms: ["dinner", "friday"], fromName: "Sam", inThread: chat, channels: ["imessage", "email"],
          has: ["attachment", "link"], before: Date(timeIntervalSince1970: 1_767_323_045),
          after: Date(timeIntervalSince1970: 1_704_096_000), tz: "America/Los_Angeles", limit: 25,
          cursor: "cursor-1")),
      .search(SearchParams(terms: ["dinner"], fromMe: true, tz: "UTC")),
      .threadYears(guid: chat, tz: "America/Los_Angeles"),
      .updateAdapter(id: "echo", AdapterPatch(enabled: false, displayName: "Echo", config: ["url": "http://127.0.0.1:9"])),
      .updateRule(
        id: "rule-1",
        RulePatch(
          name: "Running late", matcher: .keyword(["late"]), adapterId: "echo", respondMode: .draftOnly,
          scheduleId: .value("sched-1"), outsideWindow: .draftOnly, allowGroupDrafts: false,
          matchAttachmentOnly: false, draftTtlMinutes: 30, priority: 1, enabled: true)),
      .updateRule(id: "rule-1", RulePatch(scheduleId: .null)),
      .updateSchedule(
        id: "sched-1", SchedulePatch(name: "Work", timezone: "America/Los_Angeles", windows: [window], enabled: true)),
      .setSettings(["send.autoGraceSeconds": .int(30), "send.example": .bool(true), "ui.example": .string("x")]),
      .createAdapter(AdapterInput(id: "echo-2", kind: .echo, displayName: "Echo two", config: ["k": 1])),
      .createAdapter(AdapterInput(id: "echo-3", kind: .generic, displayName: "Generic")),
      .disconnect(purge: true),
      .disconnect(purge: false),
      .bulkDrafts(.approve, .ids(["id-0001", "id-0002"])),
      .bulkDrafts(.reject, .filter(BulkFilter(all: true, rule: "rule-1", contact: "+15551234567"))),
      .approveDraft(id: "id-0001", editedBody: "edited"),
      .approveDraft(id: "id-0001", editedBody: nil),
      .rejectDraft(id: "id-0001", reason: "not now"),
      .rejectDraft(id: "id-0001", reason: nil),
      .createDraft(DraftCreateInput(chatGuid: chat, body: "hello", ttlMinutes: 30)),
      .testRule(id: "rule-1", RuleTestInput(text: "are you coming?", handle: "+15551234567", isGroup: false, kind: .text)),
      .testRule(id: "rule-1", RuleTestInput(text: nil)),
      .createRule(
        RuleInput(
          name: "Running late", matcher: .anyOf([.keyword(["late"], mode: .all), .regex("^on my way")]),
          adapterId: "echo", respondMode: .auto, scheduleId: "sched-1", outsideWindow: .ignore,
          allowGroupDrafts: true, matchAttachmentOnly: false, draftTtlMinutes: 60, priority: -5, enabled: false)),
      .createRule(RuleInput(name: "Minimal", matcher: .contact(["+15551234567"]), adapterId: "echo")),
      .createSchedule(ScheduleInput(name: "Work", timezone: "America/Los_Angeles", windows: [window], enabled: true)),
      .send(to: "+15551234567", body: "on my way"),
      .sendFile(to: "+15551234567", stageId: String(repeating: "a", count: 64)),
      .setGlobalMode(.draftOnly),
      .setKillSwitch(on: true, circuit: true),
      .setKillSwitch(on: false, circuit: nil),
      .pause(until: iso),
      .resume,
      .setContactPolicy(handle: "+15551234567", mode: .draftOnly, displayName: "Sam"),
      .setContactPolicy(handle: "+15551234567", mode: .deny, displayName: nil),
      .setThreadState(
        guid: chat,
        ThreadStateInput(
          act: "snoozed", actAt: iso, snoozedUntil: "2026-01-02T09:00:00.000Z", attention: .value("stream"),
          ifUpdatedAt: .value(iso))),
      .setThreadState(guid: chat, ThreadStateInput(act: nil, attention: .null, ifUpdatedAt: .null)),
    ]
  }

  @Test("bulk request refuses ids+filter and neither (manifest note)")
  func bulkSelector() throws {
    let notes = try #require(Repo.json("fixtures/contract/manifest.json")["notes"]?.arrayValue)
      .compactMap(\.stringValue)
    #expect(notes.contains("POST /v1/drafts/bulk: exactly one of ids or filter (both, or neither, is 400)."))

    let filter = BulkFilter(all: true)
    #expect(BulkSelector(ids: ["id-0001"], filter: filter) == nil, "both")
    #expect(BulkSelector(ids: nil, filter: nil) == nil, "neither")
    #expect(BulkSelector(ids: [], filter: nil) == nil, "an empty id list selects nothing")
    #expect(BulkSelector(ids: ["id-0001"], filter: nil) == .ids(["id-0001"]))
    #expect(BulkSelector(ids: nil, filter: filter) == .filter(filter))

    let idsBody = try Endpoint.bulkDrafts(.approve, .ids(["id-0001"])).body()
    let byIds = try JSONValue.parse(try #require(idsBody))
    let wantIds: JSONValue = ["action": "approve", "ids": ["id-0001"]]
    #expect(byIds == wantIds)
    let filterBody = try Endpoint.bulkDrafts(.reject, .filter(filter)).body()
    let byFilter = try JSONValue.parse(try #require(filterBody))
    let wantFilter: JSONValue = ["action": "reject", "filter": ["all": true]]
    #expect(byFilter == wantFilter)
  }
}

extension Fixtures {
  /// Decodes responses/<name>.json's body strictly into the type the client
  /// decodes it as, then re-encodes it. Nil for a 204, which has no body.
  static func roundTrip(_ name: String, _ data: Data) throws -> Data? {
    func trip<T: Codable>(_: T.Type) throws -> Data {
      try JSONEncoder().encode(try JSONDecoder().decode(T.self, from: data))
    }
    switch name {
    case "adapters.create", "adapters.token": return try trip(AdapterCredential.self)
    case "adapters.get", "adapters.patch": return try trip(AdapterEnvelope.self)
    case "adapters.list": return try trip(AdaptersEnvelope.self)
    case "adapters.delete", "rules.delete", "schedules.delete": return nil
    case "audit.list": return try trip([AuditRowPayload].self)
    case "audit.verify": return try trip(AuditVerifyResult.self)
    case "batches.get": return try trip(BatchReport.self)
    case "connect", "doctor": return try trip(DoctorReportPayload.self)
    case "contacts.delete": return try trip(Deleted.self)
    case "contacts.list": return try trip(ContactsEnvelope.self)
    case "contacts.put": return try trip(ContactEnvelope.self)
    case "disconnect": return try trip(DisconnectReportPayload.self)
    case "drafts.approve", "drafts.approve.edited", "drafts.recall", "drafts.reject", "drafts.retry":
      return try trip(DraftActionResult.self)
    case "drafts.bulk.approve": return try trip(BulkResult.self)
    case "drafts.create": return try trip(DraftEnvelope.self)
    case "drafts.get": return try trip(DraftDetail.self)
    case "drafts.list.empty", "drafts.list.pending": return try trip(DraftsEnvelope.self)
    case "drafts.redraft": return try trip(RedraftResult.self)
    case "health": return try trip(HealthPayload.self)
    case "rules.create", "rules.patch": return try trip(RuleWriteResult.self)
    case "rules.list": return try trip([RulePayload].self)
    case "rules.dryrun": return try trip(DryRunResult.self)
    case "rules.test": return try trip(RuleTestResult.self)
    case "schedules.create", "schedules.patch": return try trip(ScheduleEnvelope.self)
    case "schedules.list": return try trip([SchedulePayload].self)
    case "send": return try trip(SendResult.self)
    case "settings.list": return try trip(SettingsEnvelope.self)
    case "settings.patch": return try trip(SettingsPatchResult.self)
    case "status": return try trip(StatusPayload.self)
    case "search", "search.partial": return try trip(SearchPage.self)
    case "threads.years": return try trip(ThreadYears.self)
    case "threads.list": return try trip(ThreadsPage.self)
    case "threads.messages", "threads.messages.rich": return try trip(ThreadMessagesPage.self)
    case "threads.by-handle.found", "threads.by-handle.none": return try trip(HandleResolution.self)
    case "threads.state.list": return try trip(ThreadStatesPage.self)
    case "threads.state.put.cleared", "threads.state.put.snoozed": return try trip(ThreadStateEnvelope.self)
    case "toggles.globalmode": return try trip(GlobalModeResult.self)
    case "toggles.killswitch", "toggles.killswitch.off": return try trip(KillSwitchResult.self)
    case "toggles.pause", "toggles.resume": return try trip(PauseResult.self)
    default: throw Malformed(detail: "no DTO is mapped for responses/\(name).json")
    }
  }
}
