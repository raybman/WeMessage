import Foundation
import Testing
import WeMessageKit

@testable import WeMessageApp

// v2 S4i, board 11: the engine (order, groups, coverage, snippets), the
// daemon source (GETs only, over the "search" scenario), search everything,
// the quick switcher, find in thread and the year scrubber.

/// The "search" scenario as the fake daemon serves it: its own transcripts
/// first, then the ones it inherits from "rich".
struct ScenarioDaemon {
  let transport: FakeTransport

  init(_ name: String = "search") throws {
    let threads = try Reply.scenario(name, "threads.list.json")
    var transcripts: [String: Reply] = [:]
    for scenario in ["rich", name] {
      let dir = "fixtures/scenarios/\(scenario)/responses"
      for file in try Repo.files(under: dir) where file.hasPrefix("threads.messages.") {
        let reply = try Reply.scenario(scenario, file)
        let page = try JSONDecoder().decode(ThreadMessagesPage.self, from: reply.body)
        transcripts[page.chatGuid] = reply
      }
    }
    let byGuid = transcripts
    transport = FakeTransport { request in
      let url = request.url?.absoluteString ?? ""
      guard let at = url.range(of: "/v1/threads") else { throw Unreachable() }
      var path = String(url[at.lowerBound...])
      if let q = path.firstIndex(of: "?") { path = String(path[..<q]) }
      if path == "/v1/threads" { return threads }
      let prefix = "/v1/threads/"
      let suffix = "/messages"
      guard path.hasPrefix(prefix), path.hasSuffix(suffix) else { throw Unreachable() }
      let raw = String(path.dropFirst(prefix.count).dropLast(suffix.count))
      guard let guid = raw.removingPercentEncoding, let reply = byGuid[guid] else { return Reply(status: 404) }
      return reply
    }
  }

  var client: GatewayClient { testClient(transport) }
}

/// A corpus handed straight in.
struct FixedSource: SearchSource {
  let corpus: SearchCorpus
  func load() async -> SearchCorpus { corpus }
}

@Suite("SearchEngine")
struct SearchEngineTests {
  static let utc = TimeZone(identifier: "UTC")!

  static func corpus() async throws -> SearchCorpus {
    await DaemonSearchSource(client: try ScenarioDaemon().client).load()
  }

  static func q(_ raw: String) -> SearchQuery {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = utc
    return SearchQuery.parse(raw, calendar: c)
  }

  static func doc(_ guid: String, _ at: String, channel: String = "imessage", text: String = "cabin") throws -> SearchDoc {
    SearchDoc(
      guid: guid, threadGuid: "t", threadTitle: "T", isGroup: false, channel: channel, outbound: false, sender: "T",
      handle: nil, text: text, sentAt: try #require(WireDate.parse(at)))
  }

  @Test func daemonSourceReadsOnlyThroughGets() async throws {
    let daemon = try ScenarioDaemon()
    let corpus = await DaemonSearchSource(client: daemon.client).load()
    #expect(corpus.threads.count == 10)
    #expect(corpus.searchedThreads == 10)
    #expect(corpus.channelsSearched == ["imessage"])
    #expect(corpus.docs.contains { $0.guid == "msg-0502" })
    let methods = Set(daemon.transport.requests.map { $0.httpMethod ?? "GET" })
    #expect(methods == ["GET"])
    #expect(!daemon.transport.requests.contains { ($0.url?.absoluteString ?? "").contains("/v1/send") })
  }

  @Test func cabinOrdersBySentTimeNewestFirst() async throws {
    let results = SearchEngine.run(Self.q("cabin"), in: try await Self.corpus(), zone: Self.utc)
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
    let corpus = SearchCorpus(
      docs: [
        try Self.doc("e", "2026-01-01T00:00:00.000Z", channel: "email"),
        try Self.doc("w", "2025-01-01T00:00:00.000Z", channel: "whatsapp"),
        try Self.doc("i", "2024-01-01T00:00:00.000Z"),
      ], threads: [], searchedThreads: 3, channelsSearched: ["email", "whatsapp", "imessage"], asOf: nil)
    let results = SearchEngine.run(Self.q("cabin"), in: corpus, zone: Self.utc)
    #expect(results.groups.map(\.channel) == [.imessage, .whatsapp, .email])
    #expect(results.hits.map(\.id) == ["e", "w", "i"])
  }

  @Test func theCountCarriesItsCoverage() async throws {
    let results = SearchEngine.run(Self.q("cabin"), in: try await Self.corpus(), zone: Self.utc)
    #expect(results.coverage(zone: Self.utc) == "4 results in 1 of 4 channels, as of 12:00")
    #expect(results.searchedLine.hasPrefix("Searched "))
    #expect(results.searchedLine.contains("in 10 threads on iMessage."))
    #expect(results.searchedLine.hasSuffix("Not searched: WhatsApp, LinkedIn, Email."))
    #expect(results.fieldSummary.hasSuffix("1 of 4 channels searched"))
  }

  @Test func facetsCountChannelsPeopleAndYears() async throws {
    let results = SearchEngine.run(Self.q("cabin"), in: try await Self.corpus(), zone: Self.utc)
    #expect(results.channelFacets == [SearchFacet(label: "iMessage", count: 4, token: "channel:imessage")])
    #expect(results.peopleFacets.map(\.label) == ["You", "Maya Okafor"])
    #expect(results.peopleFacets.first?.token == "from:me")
    #expect(results.yearFacets.map(\.label) == ["2025", "2024"])
    #expect(results.yearFacets.map(\.count) == [1, 3])
  }

  @Test func tokensNarrowTheResults() async throws {
    let corpus = try await Self.corpus()
    let mine = SearchEngine.run(Self.q("from:me cabin after:2024-06-01"), in: corpus, zone: Self.utc)
    #expect(mine.hits.map(\.id) == ["msg-0510", "msg-0505"])
    let theo = SearchEngine.run(Self.q("in:theo has:attachment"), in: corpus, zone: Self.utc)
    #expect(theo.hits.map(\.id) == ["msg-0515"])
  }

  @Test func rowsCarryAbsoluteDateAndDirection() throws {
    let at = try #require(WireDate.parse("2026-09-19T16:12:00.000Z"))
    #expect(SearchText.stamp(at, zone: Self.utc) == "Sep 19, 2026 · 4:12 PM")
    #expect(SearchText.direction(outbound: false) == "← to you")
    #expect(SearchText.direction(outbound: true) == "→ sent")
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

  static func model() throws -> SearchModel {
    SearchModel(source: DaemonSearchSource(client: try ScenarioDaemon().client), zone: utc)
  }

  @Test func opensEmptyAndSearchesAsYouType() async throws {
    let m = try Self.model()
    m.open()
    await m.settled()
    #expect(m.shown)
    #expect(m.results == nil)
    m.text = "cabin"
    #expect(m.results?.hits.count == 4)
    #expect(m.selection == "msg-0510")
    m.move(1)
    #expect(m.selection == "msg-0505")
    m.move(10)
    #expect(m.selection == "msg-0502")
    m.move(-10)
    #expect(m.selection == "msg-0510")
  }

  @Test func reopeningResetsTheField() async throws {
    let m = try Self.model()
    m.open()
    await m.settled()
    m.text = "cabin"
    m.close()
    m.open()
    await m.settled()
    #expect(m.text == "")
    #expect(m.results == nil)
  }

  @Test func zeroResultsUseBoardTensEmpty() async throws {
    let m = try Self.model()
    m.open()
    await m.settled()
    m.text = "zeppelin"
    #expect(m.empty == .noSearchResults)
    let at = try #require(WireDate.parse("2026-09-01T12:00:43.000Z"))
    let copy = EmptyStates.copy(.noSearchResults, m.emptyFacts(asOf: at), zone: Self.utc)
    #expect(copy.headline == "Nothing for \u{201C}zeppelin\u{201D}")
    #expect(copy.detail.contains("across 1 channel"))
  }

  @Test func anUnsearchedChannelIsNotConnectedNotNothing() async throws {
    let m = try Self.model()
    m.open()
    await m.settled()
    m.text = "channel:whatsapp cabin"
    #expect(m.empty == .notConnected)
    #expect(m.unsearchedChannel == .whatsapp)
  }

  @Test func facetsAndChipsEditTheField() async throws {
    let m = try Self.model()
    m.open()
    await m.settled()
    m.text = "cabin"
    m.add(try #require(m.results?.peopleFacets.first))
    #expect(m.text == "cabin from:me")
    #expect(m.results?.hits.count == 3)
    m.remove(m.query.chips[1])
    #expect(m.text == "cabin")
  }

  @Test func openingAHitStepsAsideAndEscComesBack() async throws {
    let m = try Self.model()
    m.open()
    await m.settled()
    m.text = "cabin"
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
    let m = try Self.model()
    m.open()
    await m.settled()
    m.text = "from:me cabin after:2024-06-01 before:last"
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
}

@Suite("ShellModel board 11")
@MainActor
struct ShellBoard11Tests {
  static let maya = "iMessage;-;+15550100001"

  /// A shell over the "search" scenario, its thread list in hand.
  static func shell() throws -> (ShellModel, ScenarioDaemon) {
    let daemon = try ScenarioDaemon()
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
    await m.thread.open(m.selectedThread)
    #expect(m.thread.turns.count == 17)

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
    #expect(daemon.transport.requests.allSatisfy { $0.httpMethod == "GET" })
  }

  @Test func theScrubberStepsAYearAndClamps() async throws {
    let (m, _) = try Self.shell()
    m.toggleScrubber()
    #expect(!m.scrubberShown, "a scrubber with no thread open")
    m.open(Self.maya)
    await m.thread.open(m.selectedThread)
    m.toggleScrubber()
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
}
