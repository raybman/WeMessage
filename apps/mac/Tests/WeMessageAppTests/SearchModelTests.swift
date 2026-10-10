import Foundation
import Testing
import WeMessageKit

@testable import WeMessageApp

// v2 S4i, board 11, on the daemon's index since v2 F2: results drawn from
// GET /v1/search pages (order, groups, coverage, chips, snippets), the
// model's debounce, cancellation and stale guard, the daemon source (GETs
// only), the quick switcher, find in thread and the year scrubber over
// GET /v1/threads/:guid/years.

/// A scenario as the fake daemon (tools/swift/fake-daemon.mjs) serves it:
/// the thread list, every transcript in the extends chain, the years, and
/// search. A canned search page answers the query its own coverage.tokens
/// echo (instants compared as instants); any other query is an empty page
/// with that coverage, imessage not-requested when the channels leave it
/// out. A canned years page answers its chat in any zone.
struct ScenarioDaemon {
  let transport: FakeTransport

  static func chain(_ name: String) throws -> [String] {
    var out: [String] = []
    var at: String? = name
    while let scenario = at {
      out.append(scenario)
      let meta = try Data(contentsOf: try Repo.url("fixtures/scenarios/\(scenario)/scenario.json"))
      at = (try JSONSerialization.jsonObject(with: meta) as? [String: Any])?["extends"] as? String
    }
    return out
  }

  /// Every response body in `scenario` whose file name starts with `prefix`.
  static func bodies(_ scenario: String, _ prefix: String) throws -> [(String, [String: Any])] {
    try Repo.files(under: "fixtures/scenarios/\(scenario)/responses").filter { $0.hasPrefix(prefix) }.map { file in
      let data = try Data(contentsOf: try Repo.url("fixtures/scenarios/\(scenario)/responses/\(file)"))
      let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
      return (file, object?["body"] as? [String: Any] ?? [:])
    }
  }

  static func json(_ body: Any, status: Int = 200) throws -> Reply {
    Reply(
      status: status, body: try JSONSerialization.data(withJSONObject: body, options: [.fragmentsAllowed]),
      headers: ["Content-Type": "application/json"])
  }

  /// core's compileSearch echo of a query, as op=value lines.
  static func echo(_ items: [URLQueryItem]) -> [[String: String]] {
    let all = { (name: String) in items.filter { $0.name == name }.compactMap(\.value) }
    var out: [[String: String]] = []
    let terms = all("term")
    let long = terms.contains { $0.count >= 3 }
    for t in terms {
      out.append(
        t.count >= 3 || long
          ? ["op": "term", "value": t, "applied": "applied"]
          : ["op": "term", "value": t, "applied": "partial", "reason": "short-term"])
    }
    if let from = all("from").first {
      out.append(
        from == "me"
          ? ["op": "from", "value": "me", "applied": "applied"]
          : ["op": "from", "value": from, "applied": "partial", "reason": "handles-and-saved-names"])
    }
    if let inThread = all("in").first { out.append(["op": "in", "value": inThread, "applied": "applied"]) }
    for c in all("channel") {
      out.append(
        c == "imessage"
          ? ["op": "channel", "value": c, "applied": "applied"]
          : ["op": "channel", "value": c, "applied": "not-applied", "reason": "no-source"])
    }
    for h in all("has") { out.append(["op": "has", "value": h, "applied": "applied"]) }
    for key in ["before", "after"] {
      if let v = all(key).first { out.append(["op": key, "value": v, "applied": "applied"]) }
    }
    return out
  }

  static func key(_ tokens: [[String: Any]]) -> [String] {
    tokens.map { t in
      let op = t["op"] as? String ?? ""
      let value = t["value"] as? String ?? ""
      if op == "before" || op == "after", let at = WireDate.parse(value) {
        return "\(op)=\(at.timeIntervalSince1970)"
      }
      return "\(op)=\(value)"
    }
  }

  init(_ name: String = "search", messages: (@Sendable (String, [URLQueryItem]) throws -> Reply?)? = nil) throws {
    let threads = try Reply.scenario(name, "threads.list.json")
    let chain = try Self.chain(name)
    var transcripts: [String: Reply] = [:]
    var years: [String: Reply] = [:]
    for scenario in chain.reversed() + ["rich"] where (try? Repo.url("fixtures/scenarios/\(scenario)/responses")) != nil {
      for file in try Repo.files(under: "fixtures/scenarios/\(scenario)/responses") {
        if file.hasPrefix("threads.messages."), transcripts.isEmpty || scenario != "rich" {
          let reply = try Reply.scenario(scenario, file)
          let page = try JSONDecoder().decode(ThreadMessagesPage.self, from: reply.body)
          if transcripts[page.chatGuid] == nil || scenario != "rich" { transcripts[page.chatGuid] = reply }
        }
        if file.hasPrefix("threads.years.") {
          let reply = try Reply.scenario(scenario, file)
          let page = try JSONDecoder().decode(ThreadYears.self, from: reply.body)
          years[page.chatGuid] = reply
        }
      }
    }
    var pages: [[String: Any]] = []
    for scenario in chain {
      pages = try Self.bodies(scenario, "search.").map(\.1)
      if !pages.isEmpty { break }
    }
    let byGuid = transcripts
    let yearsByGuid = years
    let canned = pages.map { (Self.key($0["coverage"].flatMap { ($0 as? [String: Any])?["tokens"] as? [[String: Any]] } ?? []), $0) }
    let cannedPages = canned.map { ($0.0, try? Self.json($0.1)) }
    let base = pages.first ?? [:]
    let baseCoverage = base["coverage"] as? [String: Any] ?? [:]
    let baseChannels = Untyped(baseCoverage["channels"] as? [[String: Any]] ?? [])
    let baseAsOf = base["asOf"] as? String ?? "2026-09-01T12:00:43.000Z"
    transport = FakeTransport { request in
      guard let url = request.url, let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
        throw Unreachable()
      }
      let items = parts.queryItems ?? []
      let path = parts.percentEncodedPath
      if path.hasSuffix("/v1/search") {
        let echo = Self.echo(items)
        let key = Self.key(echo)
        if !items.contains(where: { $0.name == "cursor" }), let hit = cannedPages.first(where: { $0.0 == key })?.1 {
          return hit
        }
        let channels = items.filter { $0.name == "channel" }.compactMap(\.value)
        let asked = channels.isEmpty || channels.contains("imessage")
        let covered: [[String: Any]] = baseChannels.value.map { c in
          (c["channel"] as? String) == "imessage" && !asked
            ? ["channel": "imessage", "state": "not-searched", "reason": "not-requested"] : c
        }
        let body: [String: Any] = [
          "hits": [], "total": 0, "nextCursor": NSNull(), "asOf": baseAsOf,
          "facets": ["years": [], "channels": [], "senders": []],
          "coverage": [
            "channels": covered, "tokens": echo, "capped": false, "deletedHidden": 0, "deletionsChecked": true,
          ],
        ]
        return try Self.json(body)
      }
      guard let at = path.range(of: "/v1/threads") else { throw Unreachable() }
      let route = String(path[at.lowerBound...])
      if route == "/v1/threads" { return threads }
      let prefix = "/v1/threads/"
      guard route.hasPrefix(prefix) else { throw Unreachable() }
      let rest = route.dropFirst(prefix.count)
      guard let slash = rest.lastIndex(of: "/") else { throw Unreachable() }
      let raw = String(rest[..<slash])
      let leaf = String(rest[rest.index(after: slash)...])
      guard let guid = raw.removingPercentEncoding else { return Reply(status: 404) }
      switch leaf {
      case "messages":
        if let messages, let reply = try messages(guid, items) { return reply }
        return byGuid[guid] ?? Reply(status: 404)
      case "years":
        return yearsByGuid[guid] ?? Reply(status: 404)
      default:
        throw Unreachable()
      }
    }
  }

  var client: GatewayClient { testClient(transport) }
  var searches: [URLRequest] { transport.requests.filter { $0.url?.path.hasSuffix("/v1/search") == true } }
}

/// Parsed JSON held by a fake transport's closure: read only, never mutated.
struct Untyped: @unchecked Sendable {
  let value: [[String: Any]]
  init(_ value: [[String: Any]]) { self.value = value }
}

/// The debounce and the slow wait, as one yield: a cancelled search never
/// reaches the source.
struct YieldSleeper: Sleeper {
  func sleep(milliseconds: Int) async throws {
    await Task.yield()
    try Task.checkCancellation()
  }
}

/// A page from JSON text: the wire's own shape, strictly decoded.
func page(_ json: String) throws -> SearchPage {
  try JSONDecoder().decode(SearchPage.self, from: Data(json.utf8))
}

/// A page of `guids`, newest first, with `extra` coverage fields.
func page(
  _ guids: [String], total: Int? = nil, cursor: String? = nil, indexed: Int = 45, eligible: Int = 45,
  tokens: String = "[]", capped: Bool = false, deletedHidden: Int = 0, deletionsChecked: Bool = true
) throws -> SearchPage {
  let hits = guids.enumerated().map { i, g in
    """
    {"guid":"\(g)","chatGuid":"iMessage;-;+15550100001","title":"Maya Okafor","isGroup":false,"channel":"imessage",\
    "from":"them","handle":"+15550100001","text":"the cabin \(g)","sentAt":"2025-05-\(String(format: "%02d", 20 - i))T13:00:00.000Z",\
    "hasAttachment":false}
    """
  }
  let next = cursor.map { "\"\($0)\"" } ?? "null"
  return try page(
    """
    {"hits":[\(hits.joined(separator: ","))],"total":\(total ?? guids.count),"nextCursor":\(next),\
    "asOf":"2026-09-01T12:00:43.000Z","facets":{"years":[],"channels":[],"senders":[]},\
    "coverage":{"channels":[{"channel":"imessage","state":"searched","indexed":\(indexed),"eligible":\(eligible),\
    "indexedThroughRowid":\(indexed),"mirrorAsOf":"2026-09-01T12:00:43.000Z"},\
    {"channel":"whatsapp","state":"not-searched","reason":"no-source"},\
    {"channel":"linkedin","state":"not-searched","reason":"no-source"},\
    {"channel":"email","state":"not-searched","reason":"no-source"}],\
    "tokens":\(tokens),"capped":\(capped),"deletedHidden":\(deletedHidden),"deletionsChecked":\(deletionsChecked)}}
    """)
}

/// Counts every search, answers each from `answer`.
final class CountingSource: SearchSource, @unchecked Sendable {
  private let lock = NSLock()
  private var seen: [(String, String?)] = []
  let answer: @Sendable (SearchQuery, String?) throws -> SearchPage

  init(_ answer: @escaping @Sendable (SearchQuery, String?) throws -> SearchPage) { self.answer = answer }

  var calls: [(String, String?)] { lock.withLock { seen } }

  func search(_ query: SearchQuery, zone: TimeZone, cursor: String?) async throws -> SearchPage {
    lock.withLock { seen.append((query.raw, cursor)) }
    return try answer(query, cursor)
  }
}

/// Holds the first search until released; every later one answers at once.
actor SearchGate {
  private var held: CheckedContinuation<Void, Never>?
  private var entered: CheckedContinuation<Void, Never>?
  private var isIn = false
  private var calls = 0

  func pass() async -> Bool {
    calls += 1
    guard calls == 1 else { return false }
    isIn = true
    entered?.resume()
    entered = nil
    await withCheckedContinuation { held = $0 }
    return true
  }

  func waitIn() async {
    if isIn { return }
    await withCheckedContinuation { entered = $0 }
  }

  func release() {
    held?.resume()
    held = nil
  }
}

struct GatedSource: SearchSource {
  let gate: SearchGate
  let first: SearchPage
  let later: SearchPage

  func search(_ query: SearchQuery, zone: TimeZone, cursor: String?) async throws -> SearchPage {
    await gate.pass() ? first : later
  }
}

struct RefusingSource: SearchSource {
  func search(_ query: SearchQuery, zone: TimeZone, cursor: String?) async throws -> SearchPage {
    throw SearchRefused(refusal: .sourceUnavailable)
  }
}

@Suite("SearchResults")
struct SearchResultsTests {
  static let utc = TimeZone(identifier: "UTC")!

  static func q(_ raw: String) -> SearchQuery {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = utc
    return SearchQuery.parse(raw, calendar: c)
  }

  static func results(_ raw: String, scenario: String = "search") async throws -> SearchResults {
    let page = try await DaemonSearchSource(client: try ScenarioDaemon(scenario).client)
      .search(q(raw), zone: utc, cursor: nil)
    return SearchResults(page: page, query: q(raw), zone: utc)
  }

  static func doc(_ guid: String, _ at: String, channel: String = "imessage", text: String = "cabin") throws -> SearchDoc {
    SearchDoc(
      guid: guid, threadGuid: "t", threadTitle: "T", isGroup: false, channel: channel, outbound: false, sender: "T",
      handle: nil, text: text, sentAt: try #require(WireDate.parse(at)))
  }

  @Test func daemonSourceReadsOnlyThroughGets() async throws {
    let daemon = try ScenarioDaemon()
    let source = DaemonSearchSource(client: daemon.client)
    let got = try await source.search(Self.q("from:me cabin after:2024-06-01"), zone: Self.utc, cursor: nil)
    #expect(got.hits.map(\.guid) == ["msg-0510", "msg-0505"])
    #expect(daemon.transport.requests.count == 1)
    let request = try #require(daemon.transport.requests.first)
    #expect((request.httpMethod ?? "GET") == "GET")
    #expect(request.url?.path.hasSuffix("/v1/search") == true)
    let items = URLComponents(url: try #require(request.url), resolvingAgainstBaseURL: false)?.queryItems ?? []
    #expect(items.map(\.name) == ["term", "from", "after", "tz", "limit"])
    #expect(items.first { $0.name == "limit" }?.value == String(ProvisionalUI.searchPageSize))
    #expect(items.first { $0.name == "tz" }?.value == Self.utc.identifier)
  }

  @Test func cabinOrdersBySentTimeNewestFirst() async throws {
    let results = try await Self.results("cabin")
    #expect(results.hits.map(\.id) == ["msg-0510", "msg-0505", "msg-0504", "msg-0502"])
    #expect(results.groups.map(\.channel) == [.imessage])
    #expect(results.groups[0].header(zone: Self.utc) == "4 · newest May 20, 2025")
  }

  @Test func tiesBreakOnId() throws {
    let docs = [
      try Self.doc("b", "2025-01-01T00:00:00.000Z"), try Self.doc("a", "2025-01-01T00:00:00.000Z"),
      try Self.doc("c", "2026-01-01T00:00:00.000Z"),
    ]
    #expect(SearchEngine.order(docs).map(\.guid) == ["c", "a", "b"])
    #expect(SearchEngine.order(docs.reversed()).map(\.guid) == ["c", "a", "b"])
  }

  @Test func groupsFollowRailOrder() throws {
    let json = """
      {"hits":[\
      {"guid":"e","chatGuid":"e1","title":"E","isGroup":false,"channel":"email","from":"them","handle":"e@example.com","text":"cabin","sentAt":"2026-01-01T00:00:00.000Z","hasAttachment":false},\
      {"guid":"w","chatGuid":"w1","title":"W","isGroup":false,"channel":"whatsapp","from":"them","handle":"+15550100002","text":"cabin","sentAt":"2025-01-01T00:00:00.000Z","hasAttachment":false},\
      {"guid":"i","chatGuid":"i1","title":"I","isGroup":false,"channel":"imessage","from":"them","handle":"+15550100003","text":"cabin","sentAt":"2024-01-01T00:00:00.000Z","hasAttachment":false}],\
      "total":3,"nextCursor":null,"asOf":"2026-09-01T12:00:43.000Z","facets":{"years":[],"channels":[],"senders":[]},\
      "coverage":{"channels":[],"tokens":[],"capped":false,"deletedHidden":0,"deletionsChecked":true}}
      """
    let results = SearchResults(page: try page(json), query: Self.q("cabin"), zone: Self.utc)
    #expect(results.groups.map(\.channel) == [.imessage, .whatsapp, .email])
    #expect(results.hits.map(\.id) == ["e", "w", "i"])
  }

  /// D-UI-203: the line names the count, how far the index reaches, and
  /// every channel not searched.
  @Test func coverageLineNamesIndexedThrough() async throws {
    let results = try await Self.results("cabin")
    #expect(results.coverage(zone: Self.utc) == "4 results in 1 of 4 channels, as of 12:00")
    #expect(
      results.searchedLine
        == "Searched 45 iMessage messages, indexed through Sep 1, 2026 · 12:00 PM. Not searched: WhatsApp, LinkedIn, Email.")
    #expect(results.indexingLine == nil)
    #expect(results.coverageLines == [results.searchedLine])
    #expect(results.fieldSummary == "4 results · 45 messages · 1 of 4 channels searched")
  }

  /// D-UI-204: a still-building index says how far, rounded down.
  @Test func indexingLineSaysHowFar() async throws {
    let results = try await Self.results("cabin", scenario: "search-indexing")
    #expect(results.hits.count == 3)
    #expect(results.indexingPercent == 41)
    #expect(results.indexingLine == "Indexing iMessage: 41% (217,300 of 530,000). Older messages are not searched yet.")
    #expect(results.searchedLine.hasPrefix("Searched 217,300 iMessage messages, indexed through "))
    #expect(results.coverageLines.count == 2)
  }

  /// D-UI-206, 208, 209: what the daemon left out, each in its own words.
  @Test func notesNameWhatWasLeftOut() throws {
    let tokens = #"[{"op":"term","value":"ab","applied":"partial","reason":"short-term"}]"#
    let p = try page(["m1"], tokens: tokens, capped: true, deletedHidden: 2, deletionsChecked: false)
    let results = SearchResults(page: p, query: Self.q("ab"), zone: Self.utc)
    #expect(
      results.notes == [
        ProvisionalUI.searchCappedLine, ProvisionalUI.searchShortTermLine, "2 matches deleted in Messages are not shown.",
        ProvisionalUI.searchDeletionsUnchecked,
      ])
    let one = SearchResults(page: try page(["m1"], deletedHidden: 1), query: Self.q("cabin"), zone: Self.utc)
    #expect(one.notes == [ProvisionalUI.searchDeletedOne])
  }

  /// D-UI-207: a token honoured in part keeps a solid chip and says why.
  @Test func partialChipSaysWhy() async throws {
    let results = try await Self.results("from:maya cabin", scenario: "search-indexing")
    #expect(results.hits.map(\.id) == ["msg-0504"])
    let chips = results.query.chips
    let from = try #require(chips.first { $0.op == "from:" })
    #expect(from.parsed)
    let note = try #require(results.applied(from))
    #expect(note.word == "handles only")
    #expect(note.reason == "matched on handles and saved contact names only")
    let cabin = try #require(chips.first { $0.op == nil })
    #expect(results.applied(cabin) == nil)
  }

  @Test func aChannelNoSourceServesIsNotApplied() async throws {
    let results = try await Self.results("channel:whatsapp cabin")
    let chip = try #require(results.query.chips.first { $0.op == "channel:" })
    let note = try #require(results.applied(chip))
    #expect(note.word == ProvisionalUI.searchChipNotApplied)
    #expect(note.reason == "no source serves this yet")
    #expect(results.channelsSearched.isEmpty)
  }

  @Test func facetsCountChannelsPeopleAndYears() async throws {
    let results = try await Self.results("cabin")
    #expect(results.channelFacets == [SearchFacet(label: "iMessage", count: 4, token: "channel:imessage")])
    #expect(results.peopleFacets.map(\.label) == ["You", "Maya Okafor"])
    #expect(results.peopleFacets.first?.token == "from:me")
    #expect(results.yearFacets.map(\.label) == ["2025", "2024"])
    #expect(results.yearFacets.map(\.count) == [1, 3])
  }

  @Test func tokensReachTheDaemon() async throws {
    let mine = try await Self.results("from:me cabin after:2024-06-01")
    #expect(mine.hits.map(\.id) == ["msg-0510", "msg-0505"])
    let unparsed = try await Self.results("from:me cabin after:2024-06-01 before:last")
    #expect(unparsed.query.chips.map(\.parsed) == [true, true, true, false])
    #expect(unparsed.hits.isEmpty)
  }

  @Test func moreAppendsAndDedupes() throws {
    let first = SearchResults(page: try page(["a", "b"], total: 4, cursor: "c1"), query: Self.q("cabin"), zone: Self.utc)
    #expect(first.moreCount == 2)
    let next = first.appending(try page(["b", "c", "d"], total: 4))
    #expect(next.hits.count == 4)
    #expect(Set(next.hits.map(\.id)) == ["a", "b", "c", "d"])
    #expect(next.moreCount == nil)
    let many = SearchResults(page: try page(["a"], total: 900, cursor: "c"), query: Self.q("cabin"), zone: Self.utc)
    #expect(many.moreCount == ProvisionalUI.searchPageSize)
  }

  @Test func rowsCarryAbsoluteDateAndDirection() throws {
    let at = try #require(WireDate.parse("2026-09-19T16:12:00.000Z"))
    #expect(SearchText.stamp(at, zone: Self.utc) == "Sep 19, 2026 · 4:12 PM")
    #expect(SearchText.direction(outbound: false) == "← to you")
    #expect(SearchText.direction(outbound: true) == "→ sent")
    #expect(SearchText.grouped(1_234_567) == "1,234,567")
    #expect(SearchText.grouped(45) == "45")
  }

  @Test func snippetIsTheSentenceWithTheMatchMarked() {
    let parts = SearchEngine.snippet("Morning. Did the invoice come through? Accounting asks.", terms: ["invoice"])
    #expect(parts.map(\.text).joined() == "Did the invoice come through?")
    #expect(parts.filter(\.match).map(\.text) == ["invoice"])
  }

  @Test func snippetMarksEveryMatchCaseInsensitively() {
    let parts = SearchEngine.snippet("Cabin, cabin, CABINS", terms: ["cabin"])
    #expect(parts.filter(\.match).map(\.text) == ["Cabin", "cabin", "CABIN"])
  }

  @Test func longSnippetIsCutAroundTheMatch() {
    let text = String(repeating: "word ", count: 60) + "cabin " + String(repeating: "tail ", count: 60)
    let parts = SearchEngine.snippet(text, terms: ["cabin"])
    let joined = parts.map(\.text).joined()
    #expect(joined.contains("cabin"))
    #expect(joined.count <= ProvisionalUI.snippetLimit + 2)
    #expect(joined.hasPrefix("…"))
  }
}

@Suite("SearchModel")
@MainActor
struct SearchModelTests {
  static let utc = TimeZone(identifier: "UTC")!

  static func model(_ scenario: String = "search") throws -> (SearchModel, ScenarioDaemon) {
    let daemon = try ScenarioDaemon(scenario)
    return (SearchModel(source: DaemonSearchSource(client: daemon.client), zone: utc, sleeper: YieldSleeper()), daemon)
  }

  @Test func opensEmptyAndSearchesAsYouType() async throws {
    let (m, _) = try Self.model()
    m.open()
    await m.settled()
    #expect(m.shown)
    #expect(m.results == nil)
    m.text = "cabin"
    await m.settled()
    #expect(m.results?.hits.count == 4)
    #expect(m.selection == "msg-0510")
    m.move(1)
    #expect(m.selection == "msg-0505")
    m.move(10)
    #expect(m.selection == "msg-0502")
    m.move(-10)
    #expect(m.selection == "msg-0510")
  }

  /// D-UI-205: typing a word is one request, not one a letter.
  @Test func typingIssuesOneRequestPerPause() async throws {
    let (m, daemon) = try Self.model()
    m.open()
    for typed in ["c", "ca", "cab", "cabi", "cabin"] { m.text = typed }
    await m.settled()
    #expect(daemon.searches.count == 1)
    #expect(m.results?.hits.count == 4)
    m.text = "cabin from:me after:2024-06-01"
    await m.settled()
    #expect(daemon.searches.count == 2)
    #expect(m.results?.hits.map(\.id) == ["msg-0510", "msg-0505"])
  }

  /// A response for an edit since replaced is never drawn.
  @Test func staleResponseNeverApplies() async throws {
    let gate = SearchGate()
    let stale = try page(["stale-1", "stale-2"])
    let fresh = try page(["fresh-1"])
    let m = SearchModel(source: GatedSource(gate: gate, first: stale, later: fresh), zone: Self.utc, sleeper: YieldSleeper())
    m.open()
    m.text = "cabin"
    await gate.waitIn()
    m.text = "lake"
    await m.settled()
    #expect(m.results?.hits.map(\.id) == ["fresh-1"])
    await gate.release()
    for _ in 0..<200 { await Task.yield() }
    #expect(m.results?.hits.map(\.id) == ["fresh-1"])
    #expect(m.text == "lake")
    #expect(!m.searching)
  }

  /// D-UI-212: an unreachable daemon searches nothing, and says so.
  @Test func daemonDownSaysNothingSearched() async throws {
    let transport = FakeTransport { _ in throw Unreachable() }
    let m = SearchModel(source: DaemonSearchSource(client: testClient(transport)), zone: Self.utc, sleeper: YieldSleeper())
    m.open()
    m.text = "cabin"
    await m.settled()
    #expect(m.results == nil)
    #expect(m.failure == .daemonDown)
    #expect(m.failure?.line == ProvisionalUI.searchDaemonDown)
    #expect(m.empty == nil)
    let refused = SearchModel(source: RefusingSource(), zone: Self.utc, sleeper: YieldSleeper())
    refused.open()
    refused.text = "cabin"
    await refused.settled()
    #expect(refused.failure == .notRun)
    refused.text = ""
    #expect(refused.failure == nil)
  }

  /// D-UI-211: the next page lands under the ones read.
  @Test func moreReadsTheNextPage() async throws {
    let source = CountingSource { _, cursor in
      cursor == nil ? try page(["a", "b"], total: 3, cursor: "c1") : try page(["c"], total: 3)
    }
    let m = SearchModel(source: source, zone: Self.utc, sleeper: YieldSleeper())
    m.open()
    m.text = "cabin"
    await m.settled()
    #expect(m.results?.moreCount == 1)
    m.more()
    #expect(m.loadingMore)
    await m.settled()
    #expect(!m.loadingMore)
    #expect(m.results?.hits.count == 3)
    #expect(m.results?.moreCount == nil)
    #expect(source.calls.map(\.1) == [nil, "c1"])
    m.more()
    await m.settled()
    #expect(source.calls.count == 2, "no cursor, no read")
  }

  @Test func reopeningResetsTheField() async throws {
    let (m, _) = try Self.model()
    m.open()
    m.text = "cabin"
    await m.settled()
    m.close()
    m.open()
    await m.settled()
    #expect(m.text == "")
    #expect(m.results == nil)
  }

  @Test func zeroResultsUseBoardTensEmpty() async throws {
    let (m, _) = try Self.model()
    m.open()
    m.text = "zeppelin"
    await m.settled()
    #expect(m.empty == .noSearchResults)
    let at = try #require(WireDate.parse("2026-09-01T12:00:43.000Z"))
    let copy = EmptyStates.copy(.noSearchResults, m.emptyFacts(asOf: at), zone: Self.utc)
    #expect(copy.headline == "Nothing for \u{201C}zeppelin\u{201D}")
    #expect(copy.detail.contains("across 1 channel"))
  }

  @Test func anUnsearchedChannelIsNotConnectedNotNothing() async throws {
    let (m, _) = try Self.model()
    m.open()
    m.text = "channel:whatsapp cabin"
    await m.settled()
    #expect(m.empty == .notConnected)
    #expect(m.unsearchedChannel == .whatsapp)
  }

  @Test func facetsAndChipsEditTheField() async throws {
    let (m, daemon) = try Self.model()
    m.open()
    m.text = "cabin"
    await m.settled()
    m.add(try #require(m.results?.peopleFacets.first))
    #expect(m.text == "cabin from:me")
    await m.settled()
    let last = try #require(daemon.searches.last?.url)
    let items = URLComponents(url: last, resolvingAgainstBaseURL: false)?.queryItems ?? []
    #expect(items.contains(URLQueryItem(name: "from", value: "me")))
    m.remove(m.query.chips[1])
    #expect(m.text == "cabin")
  }

  @Test func openingAHitStepsAsideAndEscComesBack() async throws {
    let (m, _) = try Self.model()
    m.open()
    m.text = "cabin"
    await m.settled()
    m.move(1)
    let hit = try #require(m.selectedHit)
    m.opened(hit)
    #expect(!m.shown)
    m.back()
    #expect(m.shown)
    #expect(m.selection == hit.id)
    #expect(m.text == "cabin")
  }

  @Test func unparsedTokenIsSurfacedInTheModel() async throws {
    let (m, _) = try Self.model()
    m.open()
    m.text = "from:me cabin after:2024-06-01 before:last"
    await m.settled()
    #expect(m.query.chips.map(\.parsed) == [true, true, true, false])
    #expect(m.results?.hits.isEmpty == true)
  }
}

@Suite("QuickSwitcherModel")
@MainActor
struct QuickSwitcherModelTests {
  static func threads() throws -> [ThreadSummary] {
    try JSONDecoder().decode(ThreadsPage.self, from: Reply.scenario("search", "threads.list.json").body).threads
  }

  /// S4i tooth 2: cmd-K never opens with the last query's results.
  @Test func reopensEmptyNeverStale() throws {
    let m = QuickSwitcherModel()
    m.open(threads: try Self.threads(), draftsWaiting: [])
    m.text = "theo"
    #expect(m.rows.map(\.title) == ["Theo Lindqvist"])
    m.close()
    m.open(threads: try Self.threads(), draftsWaiting: [])
    #expect(m.text == "")
    #expect(m.rows.isEmpty)
    #expect(m.selection == nil)
  }

  @Test func matchesNamesAndHandlesOnly() throws {
    let m = QuickSwitcherModel()
    m.open(threads: try Self.threads(), draftsWaiting: [])
    m.text = "cabin"
    #expect(m.rows.isEmpty)
    m.text = "+15550100008"
    #expect(m.rows.map(\.title) == ["Ines Moreau"])
    m.text = "lindqvist@example"
    #expect(m.rows.map(\.title) == ["Theo Lindqvist"])
  }

  @Test func channelRowsAndDraftHint() throws {
    let m = QuickSwitcherModel()
    m.open(threads: try Self.threads(), draftsWaiting: ["iMessage;-;+15550100001"])
    m.text = "ma"
    let maya = try #require(m.rows.first { $0.title == "Maya Okafor" })
    #expect(maya.draftWaiting)
    #expect(maya.detail == "iMessage · +15550100001")
    m.text = "whats"
    #expect(m.rows.first?.target == .channel(.whatsapp))
  }

  @Test func arrowsMoveWithinRows() throws {
    let m = QuickSwitcherModel()
    m.open(threads: try Self.threads(), draftsWaiting: [])
    m.text = "a"
    let first = m.selection
    m.move(1)
    #expect(m.selection != first)
    m.move(-5)
    #expect(m.selection == first)
  }

  @Test func samePersonOnTwoChannelsIsTwoRows() throws {
    var list = try Self.threads()
    let maya = try #require(list.first)
    var wa = maya
    wa.chatGuid = "WhatsApp;-;+15550100001"
    wa.channel = "whatsapp"
    list.append(wa)
    let m = QuickSwitcherModel()
    m.open(threads: list, draftsWaiting: [])
    m.text = "maya"
    #expect(m.rows.map(\.detail) == ["iMessage · +15550100001", "WhatsApp · +15550100001"])
  }
}

@Suite("FindBarModel")
@MainActor
struct FindBarModelTests {
  nonisolated static func maya() throws -> [MessageTurn] {
    MessageTurn.turns(
      try JSONDecoder().decode(ThreadMessagesPage.self, from: Reply.scenario("search", "threads.messages.maya.json").body))
  }

  @Test func findsInTheOpenThreadNewestFirst() throws {
    let m = FindBarModel()
    m.open(turns: try Self.maya())
    #expect(m.counter == "")
    m.text = "cabin"
    #expect(m.matches == ["msg-0502", "msg-0504", "msg-0505", "msg-0510"])
    #expect(m.currentGuid == "msg-0510")
    #expect(m.counter == "1 of 4")
    m.step(1)
    #expect(m.currentGuid == "msg-0505")
    #expect(m.counter == "2 of 4")
    m.step(-2)
    #expect(m.currentGuid == "msg-0502")
    #expect(m.counter == "4 of 4")
  }

  @Test func noMatchesSaysWhatWasSearched() throws {
    let m = FindBarModel()
    m.open(turns: try Self.maya())
    m.text = "zeppelin"
    #expect(m.counter == "no matches in 17 loaded")
    #expect(m.currentGuid == nil)
  }

  @Test func closeClears() throws {
    let m = FindBarModel()
    m.open(turns: try Self.maya())
    m.text = "cabin"
    m.close()
    #expect(!m.shown)
    #expect(m.matches.isEmpty)
    m.open(turns: try Self.maya())
    #expect(m.text == "")
  }
}

@Suite("YearScrubber")
struct YearScrubberTests {
  static let utc = TimeZone(identifier: "UTC")!

  static func years() throws -> ThreadYears {
    try JSONDecoder().decode(ThreadYears.self, from: Reply.scenario("search", "threads.years.maya.json").body)
  }

  @Test func yearsNewestFirstWithEmptyYearsKept() throws {
    let s = YearScrubber(turns: try FindBarModelTests.maya(), zone: Self.utc)
    #expect(s.years.map(\.year) == [2026, 2025, 2024, 2023, 2022])
    #expect(s.years.map(\.count) == [6, 5, 5, 0, 1])
    #expect(s.years.first { $0.year == 2023 }?.isEmpty == true)
  }

  @Test func aYearLandsOnItsFirstMessage() throws {
    let s = YearScrubber(turns: try FindBarModelTests.maya(), zone: Self.utc)
    #expect(s.anchor(for: 2024) == "msg-0501")
    #expect(s.anchor(for: 2026) == "msg-0001")
  }

  @Test func anEmptyYearLandsOnTheNearestMessage() throws {
    let s = YearScrubber(turns: try FindBarModelTests.maya(), zone: Self.utc)
    // Jan 1 2023 is 140 days after Aug 14 2022 and 365 before Jan 1 2024.
    #expect(s.anchor(for: 2023) == "msg-0500")
  }

  @Test func theLineSaysWhereYouAre() throws {
    let s = YearScrubber(turns: try FindBarModelTests.maya(), zone: Self.utc)
    #expect(s.line(viewing: 2024) == "viewing 2024 · 5 messages in 2024 · 1 older than this")
    #expect(s.line(viewing: 2023) == "viewing 2023 · 0 messages in 2023 · 1 older than this")
  }

  /// D-UI-210: the daemon's years for the whole thread, labelled, and
  /// counted even where no turn is loaded.
  @Test func theDaemonsYearsCountWhatIsNotLoaded() throws {
    let newest = Array(try FindBarModelTests.maya().suffix(6))
    let s = YearScrubber(years: try Self.years(), turns: newest)
    #expect(s.years.map(\.year) == [2026, 2025, 2024, 2023, 2022])
    #expect(s.years.map(\.label) == ["2026 · 6", "2025 · 5", "2024 · 5", "2023 · none", "2022 · 1"])
    #expect(s.line(viewing: 2024) == "viewing 2024 · 5 messages in 2024 · 1 older than this")
    #expect(!s.needsLoad(2026), "every 2026 turn is loaded")
    #expect(s.needsLoad(2024))
    #expect(!s.needsLoad(2023), "an empty year has nothing to load")
    let big = YearScrubber.Year(year: 2019, count: 12_930)
    #expect(big.label == "2019 · 12,930")
  }
}

/// The maya transcript in windows of six, as the daemon pages it: with no
/// `until`, the newest six; with one, the six ending at it.
func windowed(_ guid: String, _ items: [URLQueryItem]) throws -> Reply? {
  guard guid == "iMessage;-;+15550100001" else { return nil }
  let reply = try Reply.scenario("search", "threads.messages.maya.json")
  guard var body = try JSONSerialization.jsonObject(with: reply.body) as? [String: Any],
    let turns = body["turns"] as? [[String: Any]]
  else { return nil }
  let until = items.first { $0.name == "until" }?.value.flatMap(WireDate.parse)
  let kept = until.map { end in turns.filter { (WireDate.parse($0["at"] as? String ?? "") ?? .distantFuture) <= end } } ?? turns
  let window = Array(kept.suffix(6))
  body["turns"] = window
  body["nextBefore"] = kept.count > window.count ? (window.first?["at"] ?? NSNull()) : NSNull()
  return try ScenarioDaemon.json(body)
}

@Suite("ShellModel board 11")
@MainActor
struct ShellBoard11Tests {
  static let maya = "iMessage;-;+15550100001"

  /// A shell over the "search" scenario, its thread list in hand.
  static func shell(
    _ messages: (@Sendable (String, [URLQueryItem]) throws -> Reply?)? = nil
  ) throws -> (ShellModel, ScenarioDaemon) {
    let daemon = try ScenarioDaemon("search", messages: messages)
    let m = ShellModel(client: daemon.client)
    m.threads = try JSONDecoder().decode(ThreadsPage.self, from: Reply.scenario("search", "threads.list.json").body)
    return (m, daemon)
  }

  @Test func aHitOpensItsThreadAndEscapeClimbsBackOut() async throws {
    let (m, daemon) = try Self.shell()
    m.lens = .triage
    m.openSearch()
    await m.search.settled()
    #expect(m.searchUp)
    m.search.text = "cabin"
    await m.search.settled()
    m.search.move(2)
    let hit = try #require(m.search.selectedHit)
    #expect(hit.id == "msg-0504")
    m.open(hit)
    #expect(!m.search.shown)
    #expect(!m.searchUp)
    #expect(m.lens == .recent)
    #expect(m.selectedThread == Self.maya)
    #expect(m.jumpAnchor == "msg-0504")
    #expect(m.scrollTarget == "msg-0504")
    #expect(m.scrubberShown)
    #expect(m.scrubberYear == 2024)
    await m.loadSelectedThread()
    #expect(m.thread.turns.count == 17)
    #expect(m.thread.windowEnd == nil, "the newest page held the hit")

    // Find over the jump: its match leads, then the jump again.
    m.openFind()
    m.find.text = "cabin"
    #expect(m.find.counter == "1 of 4")
    #expect(m.scrollTarget == "msg-0510")
    m.escape(fromComposer: true)
    #expect(!m.find.shown)
    #expect(m.scrollTarget == "msg-0504")

    // 11.D: the next Escape goes back to the same results and selection.
    #expect(m.escapeIsBoard11)
    m.escape(fromComposer: true)
    #expect(m.search.shown)
    #expect(m.search.selection == "msg-0504")
    #expect(m.search.text == "cabin")
    #expect(m.jumpAnchor == nil)
    #expect(!m.scrubberShown)
    // And the one after that closes search; Escape is the list's again.
    m.escape(fromComposer: true)
    #expect(!m.search.shown)
    #expect(!m.escapeIsBoard11)
    #expect(daemon.transport.requests.allSatisfy { ($0.httpMethod ?? "GET") == "GET" })
  }

  /// A hit older than the newest page reads the window that ends at it.
  @Test func aHitTheNewestPageLacksIsRevealed() async throws {
    let (m, daemon) = try Self.shell(windowed)
    m.openSearch()
    m.search.text = "cabin"
    await m.search.settled()
    m.search.move(2)
    let hit = try #require(m.search.selectedHit)
    #expect(hit.id == "msg-0504")
    m.open(hit)
    await m.loadSelectedThread()
    #expect(m.thread.turns.map(\.guid).contains("msg-0504"))
    #expect(m.thread.windowEnd == "2024-06-16T20:05:00.000Z")
    #expect(m.jumpAnchor == "msg-0504")
    let reads = daemon.transport.requests.filter { $0.url?.path.hasSuffix("/messages") == true }
    #expect(reads.count == 2)
    let until = reads.last.flatMap { URLComponents(url: $0.url!, resolvingAgainstBaseURL: false)?.queryItems }?
      .first { $0.name == "until" }?.value
    #expect(until == "2024-06-16T20:05:00.000Z")
  }

  /// D-UI-210: the scrubber counts the daemon's years, and a year none of
  /// the loaded turns holds loads before it lands.
  @Test func aYearNotLoadedIsReadThenLandedOn() async throws {
    let (m, daemon) = try Self.shell(windowed)
    m.open(Self.maya)
    await m.loadSelectedThread()
    #expect(m.thread.turns.count == 6)
    m.toggleScrubber()
    await m.yearsTask?.value
    #expect(m.threadYears?.chatGuid == Self.maya)
    #expect(m.scrubber.years.map(\.count) == [6, 5, 5, 0, 1])
    #expect(daemon.transport.requests.contains { $0.url?.path.hasSuffix("/years") == true })
    m.jump(toYear: 2024)
    await m.revealTask?.value
    #expect(m.jumpAnchor == "msg-0501")
    #expect(m.thread.windowEnd == "2024-06-16T20:11:00.000Z")
  }

  @Test func theScrubberStepsAYearAndClamps() async throws {
    let (m, _) = try Self.shell()
    m.toggleScrubber()
    #expect(!m.scrubberShown, "a scrubber with no thread open")
    m.open(Self.maya)
    await m.loadSelectedThread()
    m.toggleScrubber()
    await m.yearsTask?.value
    #expect(m.scrubberShown)
    let years = m.scrubber.years.map { $0.year }
    #expect(years.first == 2026)
    #expect(years.last == 2022)
    m.stepYear(1)
    #expect(m.scrubberYear == years[0], "the first step lands on the newest year")
    m.stepYear(1)
    #expect(m.scrubberYear == years[1], "down is a year older")
    #expect(m.jumpAnchor == m.scrubber.anchor(for: years[1]))
    m.stepYear(-1)
    #expect(m.scrubberYear == years[0], "up is a year newer")
    m.stepYear(99)
    #expect(m.scrubberYear == years.last)
    #expect(m.jumpAnchor == "msg-0500")
    m.escape(fromComposer: true)
    #expect(!m.scrubberShown)
    #expect(m.jumpAnchor == nil)
    m.stepYear(-1)
    #expect(m.scrubberYear == years.last, "a hidden scrubber stepped")
  }

  @Test func cmdKOpensEmptyEveryTime() throws {
    let (m, _) = try Self.shell()
    m.openSearch()
    m.openSwitcher()
    #expect(!m.search.shown, "search left up under the switcher")
    m.switcher.text = "theo"
    #expect(!m.switcher.rows.isEmpty)
    m.escape(fromComposer: false)
    #expect(!m.switcher.shown)
    m.openSwitcher()
    #expect(m.switcher.text == "")
    #expect(m.switcher.rows.isEmpty)
    #expect(m.switcher.selection == nil)
    m.switcher.text = "maya"
    let row = try #require(m.switcher.selectedRow)
    #expect(row.id == "thread:" + Self.maya)
    m.open(row)
    #expect(!m.switcher.shown)
    #expect(m.selectedThread == Self.maya)
    #expect(m.jumpAnchor == nil)
    #expect(!m.scrubberShown)
  }

  @Test func findNeedsAThreadAndNoPanel() throws {
    let (m, _) = try Self.shell()
    m.openFind()
    #expect(!m.find.shown, "find with no thread open")
    m.open(Self.maya)
    m.openSearch()
    m.openFind()
    #expect(!m.find.shown, "find under the search pane")
    m.escape(fromComposer: false)
    m.openFind()
    #expect(m.find.shown)
    m.lens = .triage
    let before = m.triageClaim
    m.closeFind()
    #expect(!m.find.shown)
    #expect(m.triageClaim == before + 1, "closing find outside Recent left the keyboard nowhere")
  }

  @Test func aFieldHearsBoardElevensChordsAndNothingElse() throws {
    let (m, _) = try Self.shell()
    #expect(!Board11Keys.route("k", "k", [], model: m), "a bare k")
    #expect(!Board11Keys.route("j", "j", [.command], model: m))
    #expect(!Board11Keys.route("k", "k", [.command, .control], model: m))
    #expect(Board11Keys.route("k", "k", [.command], model: m))
    #expect(m.switcher.shown)
    #expect(Board11Keys.route("f", "F", [.command, .shift], model: m))
    #expect(m.search.shown && !m.switcher.shown)
    m.escape(fromComposer: false)
    m.open(Self.maya)
    #expect(!Board11Keys.route(.downArrow, "", [.command, .option], model: m), "a step with no scrubber")
    #expect(Board11Keys.route("g", "\u{00A9}", [.command, .option], model: m))
    #expect(m.scrubberShown)
    #expect(Board11Keys.route("f", "f", [.command], model: m))
    #expect(m.find.shown)
  }

  /// D-UI-211: cmd-Down in search reads the next page; elsewhere it is
  /// not board 11's.
  @Test func cmdDownReadsTheNextPage() async throws {
    let (m, _) = try Self.shell()
    #expect(!Board11Keys.route(.downArrow, "", [.command], model: m), "cmd-Down with search closed")
    m.openSearch()
    #expect(Board11Keys.route(.downArrow, "", [.command], model: m))
    #expect(!Board11Keys.route(.downArrow, "", [.command, .shift], model: m))
  }
}
