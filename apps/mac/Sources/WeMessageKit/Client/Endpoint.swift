import Foundation

/// Every daemon route the kit calls, with its method, its percent-encoded
/// path, its query and its JSON body. `route` is the S0 fixture spelling
/// ("GET /v1/threads/:guid/messages"), so the contract tests can pair an
/// endpoint with the error and request fixtures recorded for it.
public enum Endpoint: Sendable {
  case health
  case status
  case connect
  case doctor
  case resume
  case verifyAudit
  case listAdapters
  case listContacts
  case settings
  case listRules
  case listSchedules
  case listAudit(AuditQuery)
  case listDrafts(DraftFilter)
  case dryRunRule(id: String, limit: Int?)
  case readThread(guid: String, limit: Int?, before: String?, until: String?)
  case listThreads(limit: Int?, cursor: String?)
  /// v2 F5: the conversation a typed handle would land in, if any.
  case resolveHandle(String)
  /// v2 F3: write one conversation's Done, Snooze or Mute record.
  case setThreadState(guid: String, ThreadStateInput)
  /// v2 F3: every stored conversation record.
  case listThreadStates
  /// v2 F2: one page of matches over the daemon's index.
  case search(SearchParams)
  /// v2 F2: one conversation's turns counted by year in the zone `tz`.
  case threadYears(guid: String, tz: String)
  /// v2 F6c: one attachment's bytes by its chat.db id, all of them or one
  /// inclusive byte range. The answer is the file, not JSON.
  case attachmentBytes(id: String, range: ClosedRange<Int>?)
  case updateAdapter(id: String, AdapterPatch)
  case updateRule(id: String, RulePatch)
  case updateSchedule(id: String, SchedulePatch)
  case setSettings([String: SettingPatchValue])
  case createAdapter(AdapterInput)
  case disconnect(purge: Bool)
  case bulkDrafts(BulkAction, BulkSelector)
  case approveDraft(id: String, editedBody: String?)
  case rejectDraft(id: String, reason: String?)
  case createDraft(DraftCreateInput)
  case testRule(id: String, RuleTestInput)
  case createRule(RuleInput)
  case createSchedule(ScheduleInput)
  case send(to: String, body: String)
  /// v2 F6d: the operator's own file send, by the stage id the daemon minted
  /// (the sha256 of the bytes). Off (409) until `send.attachments`.
  case sendFile(to: String, stageId: String)
  case setGlobalMode(GlobalMode)
  case setKillSwitch(on: Bool, circuit: Bool?)
  case pause(until: String)
  case setContactPolicy(handle: String, mode: ContactMode, displayName: String?)
  case deleteContactPolicy(handle: String)
  case events(filter: [EventName]?)
  case getDraft(id: String)
  case recallDraft(id: String)
  case retryDraft(id: String)
  case redraftDraft(id: String)
  case rotateAdapterToken(id: String)
  case deleteAdapter(id: String)
  case getAdapter(id: String)
  case deleteRule(id: String)
  case getRule(id: String)
  case deleteSchedule(id: String)
  case getSchedule(id: String)
  case batchReport(id: String)

  /// The S0 fixture spelling: method, a space, the path template.
  public var route: String {
    method + " " + template
  }

  public var method: String {
    switch self {
    case .health, .status, .doctor, .verifyAudit, .listAdapters, .listContacts, .settings, .listRules,
      .listSchedules, .listAudit, .listDrafts, .dryRunRule, .readThread, .listThreads, .events, .getDraft,
      .getAdapter, .getRule, .getSchedule, .batchReport, .resolveHandle, .listThreadStates, .search, .threadYears,
      .attachmentBytes:
      return "GET"
    case .updateAdapter, .updateRule, .updateSchedule, .setSettings:
      return "PATCH"
    case .setContactPolicy, .setThreadState:
      return "PUT"
    case .deleteContactPolicy, .deleteAdapter, .deleteRule, .deleteSchedule:
      return "DELETE"
    case .connect, .resume, .createAdapter, .disconnect, .bulkDrafts, .approveDraft, .rejectDraft, .createDraft,
      .testRule, .createRule, .createSchedule, .send, .sendFile, .setGlobalMode, .setKillSwitch, .pause, .recallDraft,
      .retryDraft, .redraftDraft, .rotateAdapterToken:
      return "POST"
    }
  }

  /// The path with ":name" placeholders, as the daemon's router spells it.
  var template: String {
    switch self {
    case .health: return "/v1/health"
    case .status: return "/v1/status"
    case .connect: return "/v1/connect"
    case .doctor: return "/v1/doctor"
    case .resume, .pause: return "/v1/toggles/pause"
    case .verifyAudit: return "/v1/audit/verify"
    case .listAudit: return "/v1/audit"
    case .listAdapters, .createAdapter: return "/v1/adapters"
    case .getAdapter, .updateAdapter, .deleteAdapter: return "/v1/adapters/:id"
    case .rotateAdapterToken: return "/v1/adapters/:id/token"
    case .listContacts: return "/v1/contacts"
    case .setContactPolicy, .deleteContactPolicy: return "/v1/contacts/:handle"
    case .settings, .setSettings: return "/v1/settings"
    case .listRules, .createRule: return "/v1/rules"
    case .getRule, .updateRule, .deleteRule: return "/v1/rules/:id"
    case .dryRunRule: return "/v1/rules/:id/dry-run"
    case .testRule: return "/v1/rules/:id/test"
    case .listSchedules, .createSchedule: return "/v1/schedules"
    case .getSchedule, .updateSchedule, .deleteSchedule: return "/v1/schedules/:id"
    case .listDrafts, .createDraft: return "/v1/drafts"
    case .bulkDrafts: return "/v1/drafts/bulk"
    case .getDraft: return "/v1/drafts/:id"
    case .approveDraft: return "/v1/drafts/:id/approve"
    case .rejectDraft: return "/v1/drafts/:id/reject"
    case .recallDraft: return "/v1/drafts/:id/recall"
    case .retryDraft: return "/v1/drafts/:id/retry"
    case .redraftDraft: return "/v1/drafts/:id/redraft"
    case .batchReport: return "/v1/batches/:id"
    case .listThreads: return "/v1/threads"
    case .readThread: return "/v1/threads/:guid/messages"
    case .resolveHandle: return "/v1/threads/by-handle/:handle"
    case .setThreadState: return "/v1/threads/:guid/state"
    case .listThreadStates: return "/v1/threads/state"
    case .threadYears: return "/v1/threads/:guid/years"
    case .search: return "/v1/search"
    case .attachmentBytes: return "/v1/attachments/:id"
    case .disconnect: return "/v1/disconnect"
    case .send, .sendFile: return "/v1/send"
    case .setGlobalMode: return "/v1/toggles/global-mode"
    case .setKillSwitch: return "/v1/toggles/kill-switch"
    case .events: return Defaults.ssePath
    }
  }

  /// The one path parameter, raw (not yet encoded).
  private var parameter: String? {
    switch self {
    case .dryRunRule(let id, _), .updateAdapter(let id, _), .updateRule(let id, _), .updateSchedule(let id, _),
      .approveDraft(let id, _), .rejectDraft(let id, _), .testRule(let id, _), .getDraft(let id),
      .recallDraft(let id), .retryDraft(let id), .redraftDraft(let id), .rotateAdapterToken(let id),
      .deleteAdapter(let id), .getAdapter(let id), .deleteRule(let id), .getRule(let id), .deleteSchedule(let id),
      .getSchedule(let id), .batchReport(let id), .attachmentBytes(let id, _):
      return id
    case .readThread(let guid, _, _, _), .setThreadState(let guid, _), .threadYears(let guid, _):
      return guid
    case .setContactPolicy(let handle, _, _), .deleteContactPolicy(let handle), .resolveHandle(let handle):
      return handle
    default:
      return nil
    }
  }

  /// The template with its placeholder replaced by the encodeURIComponent
  /// form of the parameter.
  public var path: String {
    guard let parameter else { return template }
    let encoded = Self.encodeComponent(parameter)
    return template.split(separator: "/", omittingEmptySubsequences: false)
      .map { $0.hasPrefix(":") ? encoded : String($0) }
      .joined(separator: "/")
  }

  /// The query, in the order the TS client appends it. Values are raw; the
  /// URL builder encodes them.
  public var queryItems: [URLQueryItem] {
    var items: [URLQueryItem] = []
    func add(_ name: String, _ value: String?) {
      if let value { items.append(URLQueryItem(name: name, value: value)) }
    }
    switch self {
    case .listAudit(let query):
      add("since", query.since)
      add("event", query.event)
      add("limit", query.limit.map(String.init))
    case .listDrafts(let filter):
      add("state", filter.state?.rawValue)
      add("ruleId", filter.ruleId)
      add("contact", filter.contact)
      add("batchId", filter.batchId)
    case .dryRunRule(_, let limit):
      add("limit", limit.map(String.init))
    case .readThread(_, let limit, let before, let until):
      add("limit", limit.map(String.init))
      add("before", before)
      add("until", until)
    case .listThreads(let limit, let cursor):
      add("limit", limit.map(String.init))
      add("cursor", cursor)
    case .search(let params):
      items = params.queryItems
    case .threadYears(_, let tz):
      add("tz", tz)
    case .events(let filter):
      if let filter, !filter.isEmpty {
        add("events", filter.map(\.rawValue).joined(separator: ","))
      }
    default:
      break
    }
    return items
  }

  /// The query string without its "?": the URLSearchParams form, except the
  /// event filter, whose commas stay literal as the desktop client sends them.
  var queryString: String {
    queryItems.map { item in
      let value = item.value ?? ""
      let encodedValue: String
      if case .events = self {
        encodedValue = value.split(separator: ",", omittingEmptySubsequences: false)
          .map { Self.encodeForm(String($0)) }
          .joined(separator: ",")
      } else {
        encodedValue = Self.encodeForm(value)
      }
      return Self.encodeForm(item.name) + "=" + encodedValue
    }
    .joined(separator: "&")
  }

  /// The JSON body, canonical (sorted keys), or nil for a body-less route.
  public func body() throws -> Data? {
    guard let json = bodyJSON else { return nil }
    return try json.canonicalData()
  }

  var bodyJSON: JSONValue? {
    switch self {
    case .resume:
      return .object(["until": .null])
    case .pause(let until):
      return .object(["until": .string(until)])
    case .updateAdapter(_, let patch):
      return patch.json
    case .updateRule(_, let patch):
      return patch.json
    case .updateSchedule(_, let patch):
      return patch.json
    case .setSettings(let values):
      return .object(values.mapValues(\.json))
    case .createAdapter(let input):
      return input.json
    case .disconnect(let purge):
      return .object(["purge": .bool(purge)])
    case .bulkDrafts(let action, let selector):
      var fields: [String: JSONValue] = ["action": .string(action.rawValue)]
      switch selector {
      case .ids(let ids): fields["ids"] = .array(ids.map(JSONValue.string))
      case .filter(let filter): fields["filter"] = filter.json
      }
      return .object(fields)
    case .approveDraft(_, let editedBody):
      return .object(editedBody.map { ["editedBody": .string($0)] } ?? [:])
    case .rejectDraft(_, let reason):
      return .object(reason.map { ["reason": .string($0)] } ?? [:])
    case .createDraft(let input):
      return input.json
    case .testRule(_, let input):
      return input.json
    case .createRule(let input):
      return input.json
    case .createSchedule(let input):
      return input.json
    case .send(let to, let body):
      return .object(["chatGuid": .string("iMessage;-;" + to), "body": .string(body)])
    case .sendFile(let to, let stageId):
      return .object(["chatGuid": .string("iMessage;-;" + to), "file": .string(stageId)])
    case .setGlobalMode(let mode):
      return .object(["mode": .string(mode.rawValue)])
    case .setKillSwitch(let on, let circuit):
      var fields: [String: JSONValue] = ["on": .bool(on)]
      if let circuit { fields["circuit"] = .bool(circuit) }
      return .object(fields)
    case .setThreadState(_, let input):
      return input.json
    case .setContactPolicy(_, let mode, let displayName):
      var fields: [String: JSONValue] = ["mode": .string(mode.rawValue)]
      if let displayName { fields["displayName"] = .string(displayName) }
      return .object(fields)
    default:
      return nil
    }
  }

  /// The request for this endpoint against `baseURL`. Content-Type only
  /// with a body; Authorization only with a token; the event stream asks
  /// for text/event-stream and never a cached answer.
  public func urlRequest(baseURL: URL, token: BearerToken?) throws -> URLRequest {
    var base = baseURL.absoluteString
    while base.hasSuffix("/") { base.removeLast() }
    var text = base + path
    let query = queryString
    if !query.isEmpty { text += "?" + query }
    guard let url = URL(string: text) else { throw GatewayError.transport(URLError(.badURL)) }
    var request = URLRequest(url: url)
    request.httpMethod = method
    if let body = try body() {
      request.httpBody = body
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    if let token {
      request.setValue(token.headerValue, forHTTPHeaderField: "Authorization")
    }
    if case .events = self {
      request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
      request.cachePolicy = .reloadIgnoringLocalCacheData
    }
    if case .attachmentBytes(_, let range) = self {
      // v2 F6c (D-F6-8): bytes are never cached on disk; one range or all.
      request.cachePolicy = .reloadIgnoringLocalCacheData
      if let range {
        request.setValue("bytes=\(range.lowerBound)-\(range.upperBound)", forHTTPHeaderField: "Range")
      }
    }
    return request
  }

  // MARK: percent-encoding

  private static let hexDigits = Array("0123456789ABCDEF".utf8)

  /// encodeURIComponent: keeps A-Z a-z 0-9 and - _ . ! ~ * ' ( ).
  static func encodeComponent(_ text: String) -> String {
    percentEncode(text, spaceAsPlus: false) { byte in
      isAlphanumeric(byte) || Array("-_.!~*'()".utf8).contains(byte)
    }
  }

  /// The URLSearchParams serializer: keeps A-Z a-z 0-9 and * - . _, and
  /// writes a space as "+".
  static func encodeForm(_ text: String) -> String {
    percentEncode(text, spaceAsPlus: true) { byte in
      isAlphanumeric(byte) || Array("*-._".utf8).contains(byte)
    }
  }

  private static func isAlphanumeric(_ byte: UInt8) -> Bool {
    (0x30...0x39).contains(byte) || (0x41...0x5A).contains(byte) || (0x61...0x7A).contains(byte)
  }

  private static func percentEncode(_ text: String, spaceAsPlus: Bool, keep: (UInt8) -> Bool) -> String {
    var out: [UInt8] = []
    for byte in text.utf8 {
      if keep(byte) {
        out.append(byte)
      } else if spaceAsPlus && byte == 0x20 {
        out.append(0x2B)
      } else {
        out.append(0x25)
        out.append(hexDigits[Int(byte >> 4)])
        out.append(hexDigits[Int(byte & 0x0F)])
      }
    }
    return String(decoding: out, as: UTF8.self)
  }
}
