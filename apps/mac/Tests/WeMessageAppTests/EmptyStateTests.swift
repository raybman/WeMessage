import Foundation
import Testing
import WeMessageKit

@testable import WeMessageApp

/// v2 S4h, board 10.B: six distinct empties, each stating its cause and
/// offering exactly one next action. The common bug is one generic
/// "Nothing here" for all of them, which conflates finished with broken.
@Suite("EmptyState")
struct EmptyStateTests {
  static let utc = TimeZone(identifier: "UTC")!

  static func at(_ wire: String) throws -> Date { try #require(WireDate.parse(wire)) }

  /// The 10.B sheet's facts (D-UI-63), dated in the fixtures' day.
  static func facts() throws -> EmptyFacts {
    EmptyFacts(
      channel: "iMessage", cleared: 23, arrived: 23, snoozed: 4, waitingOn: "Priya", asOf: try at("2026-09-01T18:07:41.000Z"),
      syncedAt: try at("2026-09-01T18:07:29.000Z"), lastArrival: try at("2026-09-01T08:14:00.000Z"), query: "quarterly",
      searched: 527_147, channels: 1, searchMillis: 240, indexAsOf: try at("2026-09-01T18:07:38.000Z"),
      unconnectedChannel: "LinkedIn", newThreadWith: "Priya Raman")
  }

  static func all() throws -> [EmptyStateCopy] {
    let f = try facts()
    return EmptyStateCase.allCases.map { EmptyStates.copy($0, f, zone: utc) }
  }

  /// Headlines a generic empty would use: none of the six may be one.
  static let generic = ["nothing here", "no items", "empty", "nothing to show", "no results", "all done"]

  @Test("six cases, six distinct headlines, glyphs, details and actions; none generic")
  func sixDistinct() throws {
    let copies = try Self.all()
    #expect(copies.count == 6)
    #expect(Set(copies.map(\.kind)).count == 6)
    #expect(Set(copies.map(\.headline)).count == 6, "two empties share a headline: \(copies.map(\.headline))")
    #expect(Set(copies.map(\.glyph)).count == 6, "two empties share a glyph")
    #expect(Set(copies.map(\.detail)).count == 6, "two empties share a detail")
    #expect(Set(copies.flatMap(\.actions).map(\.slug)).count == 6, "two empties share an action")
    for copy in copies {
      let headline = copy.headline.lowercased()
      #expect(!Self.generic.contains(headline), "\(copy.kind): a generic headline \(copy.headline)")
      #expect(!copy.headline.isEmpty && !copy.detail.isEmpty, "\(copy.kind): says no cause")
      #expect(copy.detail.hasSuffix("."), "\(copy.kind): the cause is not a sentence: \(copy.detail)")
    }
  }

  @Test("each empty offers exactly one action, and it is labelled")
  func exactlyOneAction() throws {
    for copy in try Self.all() {
      #expect(copy.actions.count == 1, "\(copy.kind) offers \(copy.actions.count) actions")
      #expect(copy.actions.allSatisfy { !$0.label.isEmpty }, "\(copy.kind): an unlabelled action")
    }
  }

  @Test("the earned zero states the work done and dates its numbers; the quiet day rules out a sync problem")
  func zeroAndQuiet() throws {
    let f = try Self.facts()
    let zero = EmptyStates.copy(.inboxZero, f, zone: Self.utc)
    #expect(zero.headline == "iMessage is clear")
    #expect(zero.detail.contains("You cleared 23 of the 23"))
    #expect(zero.dated == "Clear as of 18:07:41", "the zero's numbers carry no clock: \(String(describing: zero.dated))")
    // No digit on the button: a count belongs on the dated line (10.B).
    #expect(zero.actions.allSatisfy { $0.label.rangeOfCharacter(from: .decimalDigits) == nil })
    let quiet = EmptyStates.copy(.nothingArrived, f, zone: Self.utc)
    #expect(quiet.detail.hasPrefix("Synced 12 seconds ago. Nothing has arrived since 08:14."))
    #expect(quiet.detail.contains("This is not a sync problem."))
  }

  @Test("the not-connected empty says not connected and shows no number at all")
  func notConnectedNoNumber() throws {
    let copy = EmptyStates.copy(.notConnected, try Self.facts(), zone: Self.utc)
    #expect(copy.headline == "LinkedIn is not connected")
    for text in [copy.glyph, copy.headline, copy.detail] + copy.actions.map(\.label) {
      #expect(text.rangeOfCharacter(from: .decimalDigits) == nil, "a number on the not-connected empty: \(text)")
    }
    #expect(copy.dated == nil)
  }

  @Test("search names the query, what was searched and the index clock")
  func searchDated() throws {
    let copy = EmptyStates.copy(.noSearchResults, try Self.facts(), zone: Self.utc)
    #expect(copy.headline == "Nothing for \u{201C}quarterly\u{201D}")
    #expect(copy.detail == "Searched 527,147 messages across 1 channel in 240ms. Index as of 18:07:38.")
  }

  @Test("ages are spans between two passed dates")
  func ages() throws {
    let base = try Self.at("2026-09-01T03:29:00.000Z")
    #expect(EmptyStates.age(from: base, to: base.addingTimeInterval(1)) == "1 second")
    #expect(EmptyStates.age(from: base, to: base.addingTimeInterval(360)) == "6 minutes")
    #expect(EmptyStates.age(from: base, to: base.addingTimeInterval(6 * 3600 + 12 * 60)) == "6h 12m")
    #expect(EmptyStates.age(from: base, to: base.addingTimeInterval(-5)) == "0 seconds")
  }
}

/// v2 S4h, boards 10.A, 10.C, 10.D: the trust line, Full Disk Access and
/// pacing, folded from the fake daemon's scenarios.
@Suite("States")
@MainActor
struct StatesTests {
  static let utc = TimeZone(identifier: "UTC")!

  static func status(_ name: String) throws -> StatusPayload {
    try JSONDecoder().decode(StatusPayload.self, from: try Reply.scenario(name, "status.json").body)
  }

  static func board(_ name: String) throws -> (ShellBoard, StatusPayload) {
    let status = try status(name)
    return (ShellBoard.fold(status: status, threads: nil, drafts: [], window: QueueWindow()), status)
  }

  @Test("degraded: iMessage is STALE since its last scan, the other three say not connected with no number, the foot says CANNOT SAY")
  func degradedRows() throws {
    let (board, status) = try Self.board("degraded")
    let rows = Freshness.rows(board: board, status: status)
    #expect(rows.map(\.scope) == [.imessage, .whatsapp, .linkedin, .email])
    #expect(rows[0].age(zone: Self.utc) == "STALE \u{00B7} since 12:00:42")
    #expect(rows[0].count == "14 today")
    for row in rows.dropFirst() {
      #expect(row.state == .notConnected)
      #expect(row.age(zone: Self.utc) == "not connected")
      let sentence = row.sentence(zone: Self.utc)
      #expect(sentence.rangeOfCharacter(from: .decimalDigits) == nil, "\(row.scope) shows a number: \(sentence)")
    }
    #expect(Freshness.footer(rows, zone: Self.utc) == "CANNOT SAY iMessage stale since 12:00:42")
  }

  @Test("an unconnected channel never shows a 0, even when status serves today's count as 0")
  func unconnectedNeverZero() throws {
    let (board, status) = try Self.board("fda-denied")
    #expect(status.counts.messagesToday == 0)
    let rows = Freshness.rows(board: board, status: status)
    for row in rows {
      #expect(row.state == .notConnected, "\(row.scope) is \(row.state) while the daemon is disconnected")
      #expect(!row.sentence(zone: Self.utc).contains("0"), "\(row.scope): \(row.sentence(zone: Self.utc))")
      #expect(row.count.isEmpty)
    }
    #expect(Freshness.footer(rows, zone: Self.utc) == nil, "a foot with nothing connected")
    #expect(TrustBanner.line(board: board, zone: Self.utc) == nil)
  }

  @Test("rich: iMessage is live as of its last scan and the foot is the clock it was computed at")
  func healthyRows() throws {
    let (board, status) = try Self.board("rich")
    let rows = Freshness.rows(board: board, status: status)
    guard case .live = rows[0].state else {
      Issue.record("rich iMessage is \(rows[0].state)")
      return
    }
    #expect(rows[0].age(zone: Self.utc).hasPrefix("live \u{00B7} as of "))
    #expect(Freshness.footer(rows, zone: Self.utc)?.hasPrefix("Mirrored as of ") == true)
    #expect(TrustBanner.line(board: board, zone: Self.utc) == nil, "a banner while every connected tile is fresh")
  }

  @Test("the trust banner names the channel and since when, in words")
  func trustBanner() throws {
    let (board, _) = try Self.board("degraded")
    #expect(
      TrustBanner.line(board: board, zone: Self.utc)
        == "iMessage has not synced since 12:00:42. You may be missing messages.")
  }

  @Test("FDA: the daemon's source-unavailable is first run with no scan seen, revoked with one, granted otherwise")
  func fdaFold() throws {
    let seen = try #require(WireDate.parse("2026-09-01T12:00:42.000Z"))
    #expect(FDAState.fold(sourceUnavailable: false, lastReadable: seen) == .granted)
    #expect(FDAState.fold(sourceUnavailable: true, lastReadable: nil) == .firstRun)
    #expect(FDAState.fold(sourceUnavailable: true, lastReadable: seen) == .revoked(lastReadable: seen))
    let fixture = FixtureFullDiskAccess()
    fixture.openSettings()
    #expect(fixture.asked == 1)
    #expect(FDACopy.headings == ["What it grants", "Why we need it", "What we do with it", "What we never do"])
    #expect(FDACopy.bodies.count == FDACopy.headings.count)
    #expect(
      FDACopy.revokedDetail(seen, zone: Self.utc)
        == "iMessage history is still readable from the local mirror up to 12:00:42. Nothing new will arrive until access is restored.")
  }

  @Test("pacing: iMessage's two rows; an unserved count says so rather than 0")
  func pacing() throws {
    let rows = Pacing.rows(sendsToday: nil)
    #expect(rows.map(\.action) == ["read", "send"])
    #expect(rows[1].today == ProvisionalUI.auditResultUnserved)
    #expect(Pacing.rows(sendsToday: 14)[1].today == "14")
    #expect(Pacing.footer(asOf: nil) == "Pacing is a hard stop, not a warning.")
  }
}
