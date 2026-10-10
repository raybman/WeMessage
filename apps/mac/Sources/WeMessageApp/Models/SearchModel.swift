import Foundation
import Observation
import WeMessageKit

// v2 S4i, board 11: search everything, find in thread, the quick switcher
// and the year scrubber. Every date shown or compared is sent time (11.C);
// results order by sent time, newest first, ties broken on id. Every count
// says what it counted (11.G). Nothing here writes: search reads through the
// daemon's GETs (D-UI-79) and never touches the Messages database.

// MARK: - the corpus

/// What search searched: every doc, and how much of the inbox that is.
public struct SearchCorpus: Equatable, Sendable {
  public var docs: [SearchDoc]
  /// Every listed thread, searched or not: the switcher's rows.
  public var threads: [ThreadSummary]
  /// Threads whose transcript was read.
  public var searchedThreads: Int
  /// The channels a transcript was read from (SearchChannel raw values).
  public var channelsSearched: Set<String>
  /// The daemon's "as of" for the list.
  public var asOf: Date?

  public init(
    docs: [SearchDoc], threads: [ThreadSummary], searchedThreads: Int, channelsSearched: Set<String>, asOf: Date?
  ) {
    self.docs = docs
    self.threads = threads
    self.searchedThreads = searchedThreads
    self.channelsSearched = channelsSearched
    self.asOf = asOf
  }

  public static let empty = SearchCorpus(docs: [], threads: [], searchedThreads: 0, channelsSearched: [], asOf: nil)

  /// One thread's turns as docs.
  public static func docs(_ turns: [MessageTurn], thread: ThreadSummary) -> [SearchDoc] {
    turns.map { turn in
      let outbound = turn.direction == .outbound
      let sender = outbound ? "You" : (thread.isGroup ? (turn.handle ?? thread.title) : thread.title)
      let text = turn.text ?? ""
      var voice = false
      var link = text.contains("http://") || text.contains("https://")
      switch turn.kind {
      case .voice: voice = true
      case .link: link = true
      default: break
      }
      return SearchDoc(
        guid: turn.guid, threadGuid: thread.chatGuid, threadTitle: thread.title, isGroup: thread.isGroup,
        channel: thread.channel, outbound: outbound, sender: sender, handle: outbound ? nil : turn.handle, text: text,
        sentAt: turn.sentAt, hasAttachment: turn.attachments > 0, hasLink: link, hasVoice: voice)
    }
  }
}

/// Where the corpus comes from. The app's is the daemon (D-UI-79); tests
/// hand one in.
public protocol SearchSource: Sendable {
  func load() async -> SearchCorpus
}

/// D-UI-79: GET /v1/threads, then GET /v1/threads/:guid/messages for each
/// listed thread, newest window only. Reads, never writes.
public struct DaemonSearchSource: SearchSource {
  let client: GatewayClient

  public init(client: GatewayClient) { self.client = client }

  public func load() async -> SearchCorpus {
    guard case .ok(let page)? = try? await client.listThreads() else { return .empty }
    var docs: [SearchDoc] = []
    var searched = 0
    var channels = Set<String>()
    for thread in page.threads.prefix(ProvisionalUI.searchThreadCap) {
      guard case .ok(let messages)? = try? await client.readThread(thread.chatGuid, limit: ProvisionalUI.searchWindow)
      else { continue }
      searched += 1
      channels.insert(thread.channel)
      docs += SearchCorpus.docs(MessageTurn.turns(messages, glyphs: .provisional), thread: thread)
    }
    return SearchCorpus(
      docs: docs, threads: page.threads, searchedThreads: searched, channelsSearched: channels,
      asOf: WireDate.parse(page.asOf))
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

public struct SearchResults: Equatable, Sendable {
  public let query: SearchQuery
  /// Every hit, newest sent first, ties on id.
  public let hits: [SearchHit]
  public let groups: [SearchGroup]
  public let searchedMessages: Int
  public let searchedThreads: Int
  public let channelsSearched: [SearchChannel]
  public let asOf: Date?
  public let channelFacets: [SearchFacet]
  public let peopleFacets: [SearchFacet]
  public let yearFacets: [SearchFacet]

  public var channelsWithHits: Int { groups.count }
  public var notSearched: [SearchChannel] { SearchChannel.allCases.filter { !channelsSearched.contains($0) } }

  /// 11.A and 11.G: the count with its coverage, in one line.
  /// "4 results in 1 of 4 channels, as of 12:00".
  public func coverage(zone: TimeZone = .current) -> String {
    let noun = hits.count == 1 ? "result" : "results"
    let at = asOf.map { ", as of " + ShellText.shortClock($0, zone: zone) } ?? ""
    return "\(hits.count) \(noun) in \(channelsWithHits) of \(SearchChannel.allCases.count) channels\(at)"
  }

  /// What was searched, and what was not: "Searched 31 messages in 10
  /// threads on iMessage. Not searched: WhatsApp, LinkedIn, Email."
  public var searchedLine: String {
    let on = channelsSearched.map(\.label).joined(separator: ", ")
    var line = "Searched \(searchedMessages) messages in \(searchedThreads) threads"
    line += on.isEmpty ? "." : " on \(on)."
    let missing = notSearched.map(\.label)
    if !missing.isEmpty { line += " Not searched: " + missing.joined(separator: ", ") + "." }
    return line
  }

  /// The field's trailing summary: "4 results · 31 messages · 1 of 4
  /// channels searched".
  public var fieldSummary: String {
    "\(hits.count) results · \(searchedMessages) messages · \(channelsSearched.count) of \(SearchChannel.allCases.count) channels searched"
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
}

public enum SearchEngine {
  /// 11.C: sent time, newest first; a tie breaks on id, so a jump never
  /// lands one row off.
  public static func order(_ docs: [SearchDoc]) -> [SearchDoc] {
    docs.sorted { $0.sentAt == $1.sentAt ? $0.guid < $1.guid : $0.sentAt > $1.sentAt }
  }

  public static func run(_ query: SearchQuery, in corpus: SearchCorpus, zone: TimeZone = .current) -> SearchResults {
    let matched = query.isEmpty ? [] : order(corpus.docs.filter(query.matches))
    let hits = matched.map { SearchHit(doc: $0, snippet: snippet($0.text, terms: query.highlightTerms)) }
    var groups: [SearchGroup] = []
    for channel in SearchChannel.allCases {
      let inChannel = hits.filter { $0.doc.channel == channel.rawValue }
      if !inChannel.isEmpty { groups.append(SearchGroup(channel: channel, hits: inChannel)) }
    }
    let channelFacets = groups.map {
      SearchFacet(label: $0.channel.label, count: $0.hits.count, token: "channel:" + $0.channel.rawValue)
    }
    var people: [String: Int] = [:]
    for hit in hits { people[hit.doc.sender, default: 0] += 1 }
    let peopleFacets = people.sorted { $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value }.map {
      SearchFacet(label: $0.key, count: $0.value, token: $0.key == "You" ? "from:me" : "from:\"\($0.key)\"")
    }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = zone
    var years: [Int: Int] = [:]
    for hit in hits { years[calendar.component(.year, from: hit.doc.sentAt), default: 0] += 1 }
    let yearFacets = years.keys.sorted(by: >).map { year in
      SearchFacet(label: String(year), count: years[year] ?? 0, token: "after:\(year) before:\(year + 1)")
    }
    return SearchResults(
      query: query, hits: hits, groups: groups, searchedMessages: corpus.docs.count,
      searchedThreads: corpus.searchedThreads,
      channelsSearched: SearchChannel.allCases.filter { corpus.channelsSearched.contains($0.rawValue) },
      asOf: corpus.asOf, channelFacets: channelFacets, peopleFacets: peopleFacets, yearFacets: yearFacets)
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

@MainActor
@Observable
public final class SearchModel {
  public internal(set) var shown = false
  /// The raw field. Every change re-runs the query.
  public var text = "" {
    didSet { if text != oldValue { rerun() } }
  }
  public internal(set) var query = SearchQuery.parse("")
  public internal(set) var results: SearchResults?
  public internal(set) var corpus = SearchCorpus.empty
  public internal(set) var loading = false
  /// How long the last run took, for the empty state's detail.
  public internal(set) var lastMillis = 0
  /// The highlighted result's guid.
  public var selection: String?
  /// The result a jump opened: Esc comes back to it.
  public internal(set) var jumpedFrom: String?
  let source: any SearchSource
  let zone: TimeZone
  private var loadTask: Task<Void, Never>?

  public init(source: any SearchSource, zone: TimeZone = .current) {
    self.source = source
    self.zone = zone
  }

  /// Shift-cmd-F: open with an empty field, and read the corpus fresh.
  public func open() {
    shown = true
    text = ""
    selection = nil
    query = SearchQuery.parse("", calendar: calendar)
    results = nil
    loading = true
    loadTask?.cancel()
    loadTask = Task { [weak self] in
      guard let self else { return }
      let corpus = await self.source.load()
      self.corpus = corpus
      self.loading = false
      self.rerun()
    }
  }

  /// Wait for the corpus (tests).
  func settled() async { await loadTask?.value }

  public func close() {
    shown = false
    loadTask?.cancel()
  }

  var calendar: Calendar {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = zone
    return c
  }

  func rerun() {
    query = SearchQuery.parse(text, calendar: calendar)
    guard !loading else { return }
    let began = Date()
    let next = SearchEngine.run(query, in: corpus, zone: zone)
    lastMillis = Int(Date().timeIntervalSince(began) * 1000)
    results = query.isEmpty ? nil : next
    if let selection, next.hits.contains(where: { $0.id == selection }) { return }
    selection = next.hits.first?.id
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
    let index = corpus.asOf ?? asOf
    return EmptyFacts(
      channel: "", cleared: 0, arrived: 0, snoozed: 0, waitingOn: "", asOf: asOf, syncedAt: index, lastArrival: index,
      query: text, searched: corpus.docs.count, channels: corpus.channelsSearched.count, searchMillis: lastMillis,
      indexAsOf: index, unconnectedChannel: unsearchedChannel?.label ?? "", newThreadWith: "")
  }

  /// The third empty (11.G): every channel the query names is one no
  /// transcript was read from. "channel:whatsapp" is not "nothing found",
  /// it is "not searched".
  public var unsearchedChannel: SearchChannel? {
    let named = query.tokens.compactMap { token -> SearchChannel? in
      if case .channel(let c) = token { return c } else { return nil }
    }
    guard !named.isEmpty, named.allSatisfy({ !corpus.channelsSearched.contains($0.rawValue) }) else { return nil }
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
  static func handle(_ chatGuid: String) -> String {
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
    public var id: Int { year }
    public var isEmpty: Bool { count == 0 }
  }

  /// Newest first; a year with nothing in it stays, muted.
  public let years: [Year]
  struct Mark: Equatable, Sendable {
    let guid: String
    let sentAt: Date
  }
  let turns: [Mark]
  let calendar: Calendar

  public init(turns: [MessageTurn], zone: TimeZone = .current) {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = zone
    self.calendar = calendar
    let marks: [Mark] = turns.map { Mark(guid: $0.guid, sentAt: $0.sentAt) }
    let sorted = marks.sorted { (a: Mark, b: Mark) -> Bool in
      a.sentAt == b.sentAt ? a.guid < b.guid : a.sentAt < b.sentAt
    }
    self.turns = sorted
    var counts: [Int: Int] = [:]
    for turn in sorted { counts[calendar.component(.year, from: turn.sentAt), default: 0] += 1 }
    guard let low = counts.keys.min(), let high = counts.keys.max() else {
      years = []
      return
    }
    years = (low...high).reversed().map { Year(year: $0, count: counts[$0] ?? 0) }
  }

  /// Where choosing `year` lands: its first message, or, for an empty
  /// year, the message nearest its first instant (an earlier one on a tie).
  public func anchor(for year: Int) -> String? {
    guard let start = calendar.date(from: DateComponents(year: year, month: 1, day: 1)),
      let end = calendar.date(from: DateComponents(year: year + 1, month: 1, day: 1))
    else { return nil }
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

  /// "viewing 2024 · 5 messages in 2024 · 1 older than this".
  public func line(viewing year: Int) -> String {
    let count = years.first { $0.year == year }?.count ?? 0
    let start = calendar.date(from: DateComponents(year: year, month: 1, day: 1)) ?? .distantPast
    let older = turns.filter { $0.sentAt < start }.count
    let noun = count == 1 ? "message" : "messages"
    return "viewing \(year) · \(count) \(noun) in \(year) · \(older) older than this"
  }
}
