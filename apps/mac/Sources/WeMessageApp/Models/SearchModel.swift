import Foundation
import Observation
import WeMessageKit

// v2 S4i, board 11: search everything, find in thread, the quick switcher
// and the year scrubber. Every date shown or compared is sent time (11.C);
// results order by sent time, newest first, ties broken on id. Every count
// says what it counted (11.G). Nothing here writes. Since v2 F2 search runs
// on the daemon's index (GET /v1/search): the app sends the typed tokens and
// draws what comes back, with the daemon's own account of what it covered.
// D-UI-79's client-side corpus is retired; it never touches chat.db.

// MARK: - the source

/// Where a page of results comes from. The app's is the daemon (D-F2-7:
/// no client-side fallback); tests hand one in.
public protocol SearchSource: Sendable {
  func search(_ query: SearchQuery, zone: TimeZone, cursor: String?) async throws -> SearchPage
}

/// The daemon answered, and would not run the search.
public struct SearchRefused: Error, Equatable, Sendable {
  public let refusal: Refusal
}

/// GET /v1/search with the query's tokens (SearchWire), one page at a time.
/// Reads, never writes.
public struct DaemonSearchSource: SearchSource {
  let client: GatewayClient

  public init(client: GatewayClient) { self.client = client }

  public func search(_ query: SearchQuery, zone: TimeZone, cursor: String?) async throws -> SearchPage {
    let params = SearchWire.params(query, zone: zone, limit: ProvisionalUI.searchPageSize, cursor: cursor)
    switch try await client.search(params) {
    case .ok(let page): return page
    case .refused(let refusal): throw SearchRefused(refusal: refusal)
    }
  }
}

/// The wait between a keystroke and its search, and before the searching word.
/// Tests hand in one that only yields.
public protocol Sleeper: Sendable {
  func sleep(milliseconds: Int) async throws
}

public struct TaskSleeper: Sleeper {
  public init() {}

  public func sleep(milliseconds: Int) async throws {
    try await Task.sleep(nanoseconds: UInt64(max(0, milliseconds)) * 1_000_000)
  }
}

// MARK: - results

/// A run of a snippet: matched runs are drawn bold and underlined, in ink.
public struct SnippetPart: Equatable, Sendable {
  public let text: String
  public let match: Bool
}

public struct SearchHit: Equatable, Sendable, Identifiable {
  public let doc: SearchDoc
  public let snippet: [SnippetPart]
  public var id: String { doc.guid }
}

/// One channel's results, with its own dated count (11.A: "241 · newest
/// Sep 19, 2026").
public struct SearchGroup: Equatable, Sendable, Identifiable {
  public let channel: SearchChannel
  public let hits: [SearchHit]
  public var id: String { channel.rawValue }
  public var newest: Date? { hits.first?.doc.sentAt }

  public func header(zone: TimeZone = .current) -> String {
    guard let newest else { return "0" }
    return "\(hits.count) · newest \(SearchText.day(newest, zone: zone))"
  }
}

/// A facet row: what it filters to, how many results it holds, and the
/// token clicking it adds.
public struct SearchFacet: Equatable, Sendable, Identifiable {
  public let label: String
  public let count: Int
  public let token: String
  public var id: String { token }
}

/// What a page (or pages) of the daemon's results draws: the hits, their
/// groups and facets, and the coverage the daemon reported.
public struct SearchResults: Equatable, Sendable {
  public let query: SearchQuery
  /// Every hit read so far, newest sent first, ties on id.
  public let hits: [SearchHit]
  public let groups: [SearchGroup]
  /// Every match the daemon counted, not only the ones read so far.
  public let total: Int
  public let nextCursor: String?
  public let asOf: Date?
  public let coverage: SearchCoverageDTO
  public let channelFacets: [SearchFacet]
  public let peopleFacets: [SearchFacet]
  public let yearFacets: [SearchFacet]
  let zone: TimeZone
  let wireHits: [SearchHitDTO]

  /// The first page.
  public init(page: SearchPage, query: SearchQuery, zone: TimeZone = .current) {
    self.init(wireHits: page.hits, page: page, query: query, zone: zone)
  }

  /// The next page under the ones already read.
  public func appending(_ page: SearchPage) -> SearchResults {
    let seen = Set(wireHits.map(\.guid))
    return SearchResults(
      wireHits: wireHits + page.hits.filter { !seen.contains($0.guid) }, page: page, query: query, zone: zone)
  }

  private init(wireHits: [SearchHitDTO], page: SearchPage, query: SearchQuery, zone: TimeZone) {
    self.query = query
    self.zone = zone
    self.wireHits = wireHits
    self.total = page.total
    self.nextCursor = page.nextCursor
    self.asOf = WireDate.parse(page.asOf)
    self.coverage = page.coverage
    let docs = SearchEngine.order(wireHits.map(Self.doc))
    let hits = docs.map { SearchHit(doc: $0, snippet: SearchEngine.snippet($0.text, terms: query.highlightTerms)) }
    self.hits = hits
    var groups: [SearchGroup] = []
    for channel in SearchChannel.allCases {
      let inChannel = hits.filter { $0.doc.channel == channel.rawValue }
      if !inChannel.isEmpty { groups.append(SearchGroup(channel: channel, hits: inChannel)) }
    }
    self.groups = groups
    let rail = SearchChannel.allCases.map(\.rawValue)
    self.channelFacets = page.facets.channels
      .sorted { (rail.firstIndex(of: $0.channel) ?? rail.count) < (rail.firstIndex(of: $1.channel) ?? rail.count) }
      .map { SearchFacet(label: SearchChannel(rawValue: $0.channel)?.label ?? $0.channel, count: $0.count, token: "channel:" + $0.channel) }
    self.peopleFacets = page.facets.senders.map { sender in
      if sender.handle == "me" { return SearchFacet(label: "You", count: sender.count, token: "from:me") }
      let named = wireHits.first { !$0.isGroup && $0.from != "me" && $0.handle == sender.handle }?.title
      return SearchFacet(label: named ?? sender.handle, count: sender.count, token: "from:" + sender.handle)
    }
    self.yearFacets = page.facets.years.map {
      SearchFacet(label: String($0.year), count: $0.count, token: "after:\($0.year) before:\($0.year + 1)")
    }
  }

  /// One wire hit as the row draws it. A group's sender is its handle; a
  /// one-to-one sender is the conversation's title.
  static func doc(_ hit: SearchHitDTO) -> SearchDoc {
    let outbound = hit.from == "me"
    let title = hit.title ?? hit.handle ?? QuickSwitcherModel.handle(hit.chatGuid)
    let sender = outbound ? "You" : (hit.isGroup ? (hit.handle ?? title) : title)
    let text = hit.text ?? ""
    return SearchDoc(
      guid: hit.guid, threadGuid: hit.chatGuid, threadTitle: title, isGroup: hit.isGroup, channel: hit.channel,
      outbound: outbound, sender: sender, handle: outbound ? nil : hit.handle, text: text,
      sentAt: WireDate.parse(hit.sentAt) ?? .distantPast, hasAttachment: hit.hasAttachment,
      hasLink: text.contains("http://") || text.contains("https://"))
  }

  /// The channels the daemon searched, in rail order.
  public var channelsSearched: [SearchChannel] {
    let searched = Set(coverage.channels.compactMap { if case .searched = $0 { return $0.channel } else { return nil } })
    return SearchChannel.allCases.filter { searched.contains($0.rawValue) }
  }

  /// Every channel that was not searched, in rail order: named, never
  /// silently absent.
  public var notSearched: [SearchChannel] {
    let searched = Set(channelsSearched)
    return SearchChannel.allCases.filter { !searched.contains($0) }
  }

  public var channelsWithHits: Int { groups.count }

  /// iMessage's index: how many messages it holds of how many it will.
  public var indexed: Int { iMessage?.indexed ?? 0 }
  public var eligible: Int { iMessage?.eligible ?? 0 }
  /// The mirror's as-of: how far the index reaches.
  public var indexedThrough: Date? { (iMessage?.mirrorAsOf).flatMap(WireDate.parse) ?? asOf }

  private var iMessage: (indexed: Int, eligible: Int, mirrorAsOf: String?)? {
    for channel in coverage.channels {
      if case .searched(let indexed, let eligible, _, let mirrorAsOf) = channel { return (indexed, eligible, mirrorAsOf) }
    }
    return nil
  }

  /// 11.A and 11.G: the count with its coverage, in one line.
  /// "4 results in 1 of 4 channels, as of 12:00".
  public func coverage(zone: TimeZone = .current) -> String {
    let noun = total == 1 ? "result" : "results"
    let at = asOf.map { ", as of " + ShellText.shortClock($0, zone: zone) } ?? ""
    return "\(total) \(noun) in \(channelsWithHits) of \(SearchChannel.allCases.count) channels\(at)"
  }

  /// D-UI-203: "Searched 41,210 iMessage messages, indexed through Sep 19,
  /// 2026 · 4:12 PM. Not searched: WhatsApp, LinkedIn, Email."
  public var searchedLine: String {
    let through = indexedThrough.map { SearchText.stamp($0, zone: zone) } ?? ""
    var line = String(format: ProvisionalUI.searchedLineFormat, SearchText.grouped(indexed), through)
    let missing = notSearched.map(\.label)
    if !missing.isEmpty {
      line += String(format: ProvisionalUI.searchNotSearchedFormat, missing.joined(separator: ProvisionalUI.searchNotSearchedJoin))
    }
    return line
  }

  /// D-UI-204: how far a still-building index is, or nil once it is whole.
  public var indexingLine: String? {
    guard eligible > 0, indexed < eligible else { return nil }
    return String(
      format: ProvisionalUI.searchIndexingFormat, indexingPercent, SearchText.grouped(indexed),
      SearchText.grouped(eligible))
  }

  /// Rounded down: 99.9% indexed is never drawn as 100%.
  public var indexingPercent: Int { eligible > 0 ? indexed * 100 / eligible : 100 }

  /// D-UI-206, 208 and 209: what the daemon left out, each in its own words.
  public var notes: [String] {
    var out: [String] = []
    if coverage.capped { out.append(ProvisionalUI.searchCappedLine) }
    if coverage.tokens.contains(where: { $0.reason == "short-term" && $0.applied != "applied" }) {
      out.append(ProvisionalUI.searchShortTermLine)
    }
    if coverage.deletedHidden == 1 {
      out.append(ProvisionalUI.searchDeletedOne)
    } else if coverage.deletedHidden > 1 {
      out.append(String(format: ProvisionalUI.searchDeletedFormat, coverage.deletedHidden))
    }
    if !coverage.deletionsChecked { out.append(ProvisionalUI.searchDeletionsUnchecked) }
    return out
  }

  /// Every coverage line, in drawn order: what was searched first.
  public var coverageLines: [String] { [searchedLine] + (indexingLine.map { [$0] } ?? []) + notes }

  /// The field's trailing summary: "4 results · 45 messages · 1 of 4
  /// channels searched".
  public var fieldSummary: String {
    "\(total) results · \(SearchText.grouped(indexed)) messages · \(channelsSearched.count) of \(SearchChannel.allCases.count) channels searched"
  }

  /// D-UI-211: how many the next page can hold, or nil with no next page.
  public var moreCount: Int? {
    guard nextCursor != nil else { return nil }
    return max(0, min(ProvisionalUI.searchPageSize, total - hits.count))
  }

  /// D-UI-207: what the daemon said about a chip it honoured only in part,
  /// or not at all: the trailing word, and the reason read out.
  public func applied(_ chip: TokenChip) -> (word: String, reason: String)? {
    guard chip.id < query.tokens.count, let wire = Self.wire(query.tokens[chip.id]) else { return nil }
    guard
      let token = coverage.tokens.first(where: { $0.op == wire.op && Self.same($0, wire) && $0.applied != "applied" })
    else { return nil }
    let reason = token.reason.flatMap { ProvisionalUI.searchChipReasons[$0] } ?? ""
    if token.applied == "not-applied" { return (ProvisionalUI.searchChipNotApplied, reason) }
    let word = token.reason.flatMap { ProvisionalUI.searchChipWords[$0] } ?? ProvisionalUI.searchChipPartly
    return (word, reason)
  }

  /// A token as the daemon's coverage names it.
  static func wire(_ token: SearchToken) -> (op: String, value: String, at: Date?)? {
    switch token {
    case .term(let word): ("term", word, nil)
    case .unparsed(let raw, _): ("term", raw, nil)
    case .from(.me): ("from", "me", nil)
    case .from(.name(let name)): ("from", name, nil)
    case .inThread(let thread): ("in", thread, nil)
    case .channel(let channel): ("channel", channel.rawValue, nil)
    case .has(let kind): ("has", kind.rawValue, nil)
    case .before(let date): ("before", "", date.start)
    case .after(let date): ("after", "", date.start)
    }
  }

  static func same(_ token: TokenAppliedDTO, _ wire: (op: String, value: String, at: Date?)) -> Bool {
    if let at = wire.at { return WireDate.parse(token.value) == at }
    return token.value.compare(wire.value, options: SearchQuery.fold) == .orderedSame
  }
}

public enum SearchText {
  /// "Sep 19, 2026".
  public static func day(_ date: Date, zone: TimeZone = .current) -> String {
    ShellText.format(date, "MMM d, yyyy", zone)
  }

  /// "Sep 19, 2026 · 4:12 PM": every row carries an absolute date (11.A).
  public static func stamp(_ date: Date, zone: TimeZone = .current) -> String {
    ShellText.format(date, "MMM d, yyyy · h:mm a", zone)
  }

  /// The direction, as a glyph and a word: "← to you", "→ sent" (11.D).
  public static func direction(outbound: Bool) -> String {
    outbound ? "→ sent" : "← to you"
  }

  /// "530,000": grouped by thousands with commas, whatever the locale.
  public static func grouped(_ n: Int) -> String {
    let digits = String(abs(n))
    var out = ""
    for (i, c) in digits.enumerated() {
      if i > 0 && (digits.count - i) % 3 == 0 { out.append(",") }
      out.append(c)
    }
    return (n < 0 ? "-" : "") + out
  }
}

public enum SearchEngine {
  /// 11.C: sent time, newest first; a tie breaks on id, so a jump never
  /// lands one row off.
  public static func order(_ docs: [SearchDoc]) -> [SearchDoc] {
    docs.sorted { $0.sentAt == $1.sentAt ? $0.guid < $1.guid : $0.sentAt > $1.sentAt }
  }

  /// D-UI-87: the sentence holding the first match, cut around it, with
  /// every match of every term marked.
  public static func snippet(_ text: String, terms: [String]) -> [SnippetPart] {
    let sentence = Self.sentence(text, terms: terms)
    return mark(sentence, terms: terms)
  }

  static func sentence(_ text: String, terms: [String]) -> String {
    let first = terms.compactMap { text.range(of: $0, options: SearchQuery.fold) }.min { $0.lowerBound < $1.lowerBound }
    var start = text.startIndex
    var end = text.endIndex
    if let first {
      var i = first.lowerBound
      while i > text.startIndex {
        let before = text.index(before: i)
        if ".!?\n".contains(text[before]) && i < text.endIndex && text[i].isWhitespace {
          start = i
          break
        }
        i = before
      }
      var j = first.upperBound
      while j < text.endIndex {
        if ".!?\n".contains(text[j]) {
          end = text.index(after: j)
          break
        }
        j = text.index(after: j)
      }
    }
    var out = String(text[start..<end]).trimmingCharacters(in: .whitespacesAndNewlines)
    let limit = ProvisionalUI.snippetLimit
    if out.count > limit {
      let cutAt = first.flatMap { r in out.range(of: String(text[r]), options: SearchQuery.fold) }
      let offset = cutAt.map { out.distance(from: out.startIndex, to: $0.lowerBound) } ?? 0
      let lead = max(0, min(offset - limit / 3, out.count - limit))
      let a = out.index(out.startIndex, offsetBy: lead)
      let b = out.index(a, offsetBy: limit)
      out = (lead > 0 ? "…" : "") + String(out[a..<b]) + (b < out.endIndex ? "…" : "")
    }
    return out
  }

  static func mark(_ text: String, terms: [String]) -> [SnippetPart] {
    var ranges: [Range<String.Index>] = []
    for term in terms where !term.isEmpty {
      var from = text.startIndex
      while from < text.endIndex, let r = text.range(of: term, options: SearchQuery.fold, range: from..<text.endIndex) {
        ranges.append(r)
        from = r.upperBound
      }
    }
    ranges.sort { $0.lowerBound < $1.lowerBound }
    var merged: [Range<String.Index>] = []
    for r in ranges {
      if let last = merged.last, r.lowerBound <= last.upperBound {
        merged[merged.count - 1] = last.lowerBound..<max(last.upperBound, r.upperBound)
      } else {
        merged.append(r)
      }
    }
    var parts: [SnippetPart] = []
    var cursor = text.startIndex
    for r in merged {
      if cursor < r.lowerBound { parts.append(SnippetPart(text: String(text[cursor..<r.lowerBound]), match: false)) }
      parts.append(SnippetPart(text: String(text[r]), match: true))
      cursor = r.upperBound
    }
    if cursor < text.endIndex { parts.append(SnippetPart(text: String(text[cursor...]), match: false)) }
    return parts
  }
}

// MARK: - search everything (shift-cmd-F)

/// Why nothing was searched (D-UI-212).
public enum SearchFailure: Equatable, Sendable {
  /// The daemon could not be reached.
  case daemonDown
  /// The daemon answered and did not run the search.
  case notRun

  public var line: String {
    switch self {
    case .daemonDown: ProvisionalUI.searchDaemonDown
    case .notRun: ProvisionalUI.searchNotRun
    }
  }
}

@MainActor
@Observable
public final class SearchModel {
  public internal(set) var shown = false
  /// The raw field. Every change re-parses at once and searches after a
  /// pause (D-UI-205).
  public var text = "" {
    didSet { if text != oldValue { rerun() } }
  }
  public internal(set) var query = SearchQuery.parse("")
  public internal(set) var results: SearchResults?
  /// True once a search has been out for longer than D-UI-205's wait.
  public internal(set) var searching = false
  /// Nothing was searched, and why. Never drawn beside stale results.
  public internal(set) var failure: SearchFailure?
  /// True while the next page is on its way.
  public internal(set) var loadingMore = false
  /// How long the last search took, round trip, for the empty state.
  public internal(set) var lastMillis = 0
  /// The highlighted result's guid.
  public var selection: String?
  /// The result a jump opened: Esc comes back to it.
  public internal(set) var jumpedFrom: String?
  let source: any SearchSource
  let zone: TimeZone
  let sleeper: any Sleeper
  private var searchTask: Task<Void, Never>?
  private var slowTask: Task<Void, Never>?
  private var moreTask: Task<Void, Never>?
  /// Bumped by every edit: a response for an older one is never applied.
  private var generation = 0

  public init(source: any SearchSource, zone: TimeZone = .current, sleeper: any Sleeper = TaskSleeper()) {
    self.source = source
    self.zone = zone
    self.sleeper = sleeper
  }

  /// Shift-cmd-F: open with an empty field.
  public func open() {
    shown = true
    text = ""
    selection = nil
    query = SearchQuery.parse("", calendar: calendar)
    results = nil
    failure = nil
  }

  /// Wait for the search in flight and the page in flight (tests).
  func settled() async {
    await searchTask?.value
    await moreTask?.value
  }

  public func close() {
    shown = false
  }

  var calendar: Calendar {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = zone
    return c
  }

  /// Re-parse now; search after the pause. Every edit cancels the search
  /// it replaces, so typing a word is one request, not one a letter.
  func rerun() {
    query = SearchQuery.parse(text, calendar: calendar)
    searchTask?.cancel()
    slowTask?.cancel()
    moreTask?.cancel()
    moreTask = nil
    loadingMore = false
    searching = false
    generation += 1
    guard !query.isEmpty else {
      results = nil
      failure = nil
      selection = nil
      return
    }
    let gen = generation
    let query = self.query
    let zone = self.zone
    let source = self.source
    let sleeper = self.sleeper
    searchTask = Task { [weak self] in
      do { try await sleeper.sleep(milliseconds: ProvisionalUI.searchDebounceMillis) } catch { return }
      self?.slowTask = Task { [weak self] in
        do { try await sleeper.sleep(milliseconds: ProvisionalUI.searchSlowMillis) } catch { return }
        guard let self, !Task.isCancelled, self.generation == gen else { return }
        self.searching = true
      }
      let began = Date()
      let outcome: Result<SearchPage, any Error>
      do {
        outcome = .success(try await source.search(query, zone: zone, cursor: nil))
      } catch {
        outcome = .failure(error)
      }
      // A response for an edit since replaced is never drawn.
      guard let self, self.generation == gen else { return }
      self.slowTask?.cancel()
      self.searching = false
      self.lastMillis = Int(Date().timeIntervalSince(began) * 1000)
      self.apply(outcome, query: query)
    }
  }

  private func apply(_ outcome: Result<SearchPage, any Error>, query: SearchQuery) {
    switch outcome {
    case .success(let page):
      failure = nil
      let next = SearchResults(page: page, query: query, zone: zone)
      results = next
      if let selection, next.hits.contains(where: { $0.id == selection }) { return }
      selection = next.hits.first?.id
    case .failure(let error):
      // D-UI-212: nothing stale stays on screen.
      results = nil
      selection = nil
      failure = Self.isDown(error) ? .daemonDown : .notRun
    }
  }

  static func isDown(_ error: any Error) -> Bool {
    if case GatewayError.transport? = error as? GatewayError { return true }
    return error is URLError
  }

  /// D-UI-211: the next page, under the ones read. cmd-Down or the footer.
  public func more() {
    guard let current = results, current.nextCursor != nil, moreTask == nil else { return }
    let cursor = current.nextCursor
    let gen = generation
    let zone = self.zone
    let source = self.source
    loadingMore = true
    moreTask = Task { [weak self] in
      let page = try? await source.search(current.query, zone: zone, cursor: cursor)
      guard let self, self.generation == gen else { return }
      self.loadingMore = false
      self.moreTask = nil
      // A page that failed leaves the results read so far, and the footer.
      if let page, self.results == current { self.results = current.appending(page) }
    }
  }

  /// Up and down arrows: the next or previous result, in drawn order.
  public func move(_ delta: Int) {
    guard let hits = results?.hits, !hits.isEmpty else { return }
    guard let selection, let at = hits.firstIndex(where: { $0.id == selection }) else {
      self.selection = hits.first?.id
      return
    }
    self.selection = hits[min(max(at + delta, 0), hits.count - 1)].id
  }

  public var selectedHit: SearchHit? {
    guard let selection else { return nil }
    return results?.hits.first { $0.id == selection }
  }

  /// A facet adds its token to the field.
  public func add(_ facet: SearchFacet) {
    text = text.isEmpty ? facet.token : text + " " + facet.token
  }

  /// A chip's x: its text leaves the field.
  public func remove(_ chip: TokenChip) {
    text = query.removing(chip)
  }

  /// Opening a hit: search steps aside and remembers where it was.
  public func opened(_ hit: SearchHit) {
    jumpedFrom = hit.id
    selection = hit.id
    shown = false
  }

  /// Esc from a jumped-to thread: back to the same results and selection.
  public func back() {
    guard jumpedFrom != nil else { return }
    shown = true
  }

  /// Esc in search: back to the thread a jump came from, else close.
  public func escape() {
    close()
  }

  /// The empty state's facts (board 10's "Nothing for ..."): what was
  /// searched, so zero results are not a silent nothing.
  public func emptyFacts(asOf: Date) -> EmptyFacts {
    let index = results?.indexedThrough ?? asOf
    return EmptyFacts(
      channel: "", cleared: 0, arrived: 0, snoozed: 0, waitingOn: "", asOf: asOf, syncedAt: index, lastArrival: index,
      query: text, searched: results?.indexed ?? 0, channels: results?.channelsSearched.count ?? 0,
      searchMillis: lastMillis, indexAsOf: index, unconnectedChannel: unsearchedChannel?.label ?? "", newThreadWith: "")
  }

  /// The third empty (11.G): every channel the query names is one the
  /// daemon did not search. "channel:whatsapp" is not "nothing found", it
  /// is "not searched".
  public var unsearchedChannel: SearchChannel? {
    let named = query.tokens.compactMap { token -> SearchChannel? in
      if case .channel(let c) = token { return c } else { return nil }
    }
    let searched = results?.channelsSearched ?? []
    guard !named.isEmpty, named.allSatisfy({ !searched.contains($0) }) else { return nil }
    return named.first
  }

  /// Which of board 10's empties the pane draws, if any.
  public var empty: EmptyStateCase? {
    guard results != nil, results?.hits.isEmpty == true else { return nil }
    return unsearchedChannel == nil ? .noSearchResults : .notConnected
  }
}

// MARK: - the quick switcher (cmd-K)

@MainActor
@Observable
public final class QuickSwitcherModel {
  public struct Row: Equatable, Sendable, Identifiable {
    public enum Target: Equatable, Sendable {
      case thread(String)
      case channel(ShellModel.Scope)
    }
    public let target: Target
    public let title: String
    /// "iMessage · +15550100001", or "channel".
    public let detail: String
    public let draftWaiting: Bool
    public var id: String {
      switch target {
      case .thread(let guid): "thread:" + guid
      case .channel(let scope): "channel:" + scope.rawValue
      }
    }
  }

  public internal(set) var shown = false
  public var text = "" {
    didSet { if text != oldValue { rerun() } }
  }
  public internal(set) var rows: [Row] = []
  public var selection: String?
  var threads: [ThreadSummary] = []
  var drafts: Set<String> = []

  public init() {}

  /// cmd-K: open empty, every time. Nothing from the last query survives:
  /// a stale row under a fresh cursor is the switcher lying (S4i tooth 2).
  public func open(threads: [ThreadSummary], draftsWaiting: Set<String>) {
    self.threads = threads
    self.drafts = draftsWaiting
    text = ""
    rows = []
    selection = nil
    shown = true
  }

  public func close() {
    shown = false
  }

  func rerun() {
    let needle = text.trimmingCharacters(in: .whitespaces)
    guard !needle.isEmpty else {
      rows = []
      selection = nil
      return
    }
    var out: [Row] = []
    for scope in ShellModel.Scope.allCases where scope != .all {
      if SearchQuery.contains(scope.fullLabel, needle) {
        out.append(Row(target: .channel(scope), title: scope.fullLabel, detail: "channel", draftWaiting: false))
      }
    }
    for thread in threads {
      let handle = Self.handle(thread.chatGuid)
      guard SearchQuery.contains(thread.title, needle) || SearchQuery.contains(handle, needle) else { continue }
      let channel = SearchChannel(rawValue: thread.channel)?.label ?? thread.channel
      out.append(
        Row(
          target: .thread(thread.chatGuid), title: thread.title,
          detail: thread.isGroup ? channel + " · group" : channel + " · " + handle,
          draftWaiting: drafts.contains(thread.chatGuid)))
    }
    rows = Array(out.prefix(ProvisionalUI.switcherRowCap))
    selection = rows.first?.id
  }

  /// The handle in a chat guid: "iMessage;-;+15550100001" is +15550100001.
  nonisolated static func handle(_ chatGuid: String) -> String {
    chatGuid.split(separator: ";", omittingEmptySubsequences: false).last.map(String.init) ?? chatGuid
  }

  public func move(_ delta: Int) {
    guard !rows.isEmpty else { return }
    guard let selection, let at = rows.firstIndex(where: { $0.id == selection }) else {
      self.selection = rows.first?.id
      return
    }
    self.selection = rows[min(max(at + delta, 0), rows.count - 1)].id
  }

  public var selectedRow: Row? { rows.first { $0.id == selection } }
}

// MARK: - find in thread (cmd-F)

@MainActor
@Observable
public final class FindBarModel {
  public internal(set) var shown = false
  public var text = "" {
    didSet { if text != oldValue { rerun() } }
  }
  /// Matching turn guids, oldest first, as the transcript draws them.
  public internal(set) var matches: [String] = []
  /// The current match's index into `matches`.
  public internal(set) var current: Int?
  var turns: [MessageTurn] = []

  public init() {}

  /// cmd-F: find in the open thread's loaded turns.
  public func open(turns: [MessageTurn]) {
    self.turns = turns
    text = ""
    matches = []
    current = nil
    shown = true
  }

  public func close() {
    shown = false
    text = ""
    matches = []
    current = nil
  }

  /// The thread's turns changed under an open bar.
  public func update(turns: [MessageTurn]) {
    self.turns = turns
    rerun()
  }

  func rerun() {
    let needle = text.trimmingCharacters(in: .whitespaces)
    guard !needle.isEmpty else {
      matches = []
      current = nil
      return
    }
    matches = turns.filter { SearchQuery.contains($0.text ?? "", needle) }.map(\.guid)
    // D-UI-85: the newest match first.
    current = matches.isEmpty ? nil : matches.count - 1
  }

  /// Down steps to an older match, up to a newer one, wrapping.
  public func step(_ delta: Int) {
    guard let current, !matches.isEmpty else { return }
    let n = matches.count
    self.current = ((current - delta) % n + n) % n
  }

  public var currentGuid: String? { current.map { matches[$0] } }

  /// "2 of 4", counted newest first; "no matches" when there are none.
  public var counter: String {
    guard !text.trimmingCharacters(in: .whitespaces).isEmpty else { return "" }
    guard let current, !matches.isEmpty else { return "no matches in \(turns.count) loaded" }
    return "\(matches.count - current) of \(matches.count)"
  }
}

// MARK: - the year scrubber (opt-cmd-G)

public struct YearScrubber: Equatable, Sendable {
  public struct Year: Equatable, Sendable, Identifiable {
    public let year: Int
    public let count: Int
    /// The year's newest message, when the daemon named it: where a year
    /// none of the loaded turns hold is loaded until (D-UI-210).
    public let last: String?
    public var id: Int { year }
    public var isEmpty: Bool { count == 0 }

    public init(year: Int, count: Int, last: String? = nil) {
      self.year = year
      self.count = count
      self.last = last
    }

    /// D-UI-210: the year and its grouped count; an empty year says so.
    public var label: String {
      String(
        format: ProvisionalUI.scrubberRowFormat, year,
        isEmpty ? ProvisionalUI.scrubberEmptyCount : SearchText.grouped(count))
    }
  }

  /// Newest first; a year with nothing in it stays, muted.
  public let years: [Year]
  struct Mark: Equatable, Sendable {
    let guid: String
    let sentAt: Date
  }
  let turns: [Mark]
  let calendar: Calendar

  /// Over the loaded turns only: before the daemon's years arrive.
  public init(turns: [MessageTurn], zone: TimeZone = .current) {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = zone
    self.calendar = calendar
    let sorted = Self.marks(turns)
    self.turns = sorted
    var counts: [Int: Int] = [:]
    for turn in sorted { counts[calendar.component(.year, from: turn.sentAt), default: 0] += 1 }
    guard let low = counts.keys.min(), let high = counts.keys.max() else {
      years = []
      return
    }
    years = (low...high).reversed().map { Year(year: $0, count: counts[$0] ?? 0) }
  }

  /// v2 F2: the daemon's years for the whole thread, counted in its zone,
  /// over the turns loaded so far for the anchors.
  public init(years: ThreadYears, turns: [MessageTurn]) {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: years.tz) ?? .current
    self.calendar = calendar
    self.turns = Self.marks(turns)
    self.years = years.years.sorted { $0.year > $1.year }.map { Year(year: $0.year, count: $0.count, last: $0.last) }
  }

  private static func marks(_ turns: [MessageTurn]) -> [Mark] {
    turns.map { Mark(guid: $0.guid, sentAt: $0.sentAt) }.sorted { (a: Mark, b: Mark) -> Bool in
      a.sentAt == b.sentAt ? a.guid < b.guid : a.sentAt < b.sentAt
    }
  }

  /// True when `year` has messages and none of the loaded turns is one.
  public func needsLoad(_ year: Int) -> Bool {
    guard let row = years.first(where: { $0.year == year }), row.count > 0, row.last != nil else { return false }
    guard let (start, end) = bounds(year) else { return false }
    return !turns.contains { $0.sentAt >= start && $0.sentAt < end }
  }

  private func bounds(_ year: Int) -> (Date, Date)? {
    guard let start = calendar.date(from: DateComponents(year: year, month: 1, day: 1)),
      let end = calendar.date(from: DateComponents(year: year + 1, month: 1, day: 1))
    else { return nil }
    return (start, end)
  }

  /// Where choosing `year` lands: its first loaded message, or, for a
  /// year none is in, the loaded message nearest its first instant (an
  /// earlier one on a tie).
  public func anchor(for year: Int) -> String? {
    guard let (start, end) = bounds(year) else { return nil }
    if let first = turns.first(where: { $0.sentAt >= start && $0.sentAt < end }) { return first.guid }
    let before = turns.last { $0.sentAt < start }
    let after = turns.first { $0.sentAt >= start }
    switch (before, after) {
    case (nil, nil): return nil
    case (let b?, nil): return b.guid
    case (nil, let a?): return a.guid
    case (let b?, let a?):
      return start.timeIntervalSince(b.sentAt) <= a.sentAt.timeIntervalSince(start) ? b.guid : a.guid
    }
  }

  /// "viewing 2024 · 5 messages in 2024 · 1 older than this": counted
  /// over the years, so older messages not yet loaded are counted too.
  public func line(viewing year: Int) -> String {
    let count = years.first { $0.year == year }?.count ?? 0
    let older = years.filter { $0.year < year }.reduce(0) { $0 + $1.count }
    let noun = count == 1 ? "message" : "messages"
    return "viewing \(year) · \(SearchText.grouped(count)) \(noun) in \(year) · \(SearchText.grouped(older)) older than this"
  }
}
