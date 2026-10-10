import Foundation
import Testing
import WeMessageKit

@testable import WeMessageApp

// v2 F2d: a typed query to the daemon's structured query. What the operator
// sees drawn is what the daemon is asked; nothing typed is dropped.

@Suite("SearchWire")
struct SearchWireTests {
  static let la = TimeZone(identifier: "America/Los_Angeles")!

  static func calendar(_ zone: TimeZone) -> Calendar {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = zone
    return c
  }

  static func wire(_ raw: String, zone: TimeZone = la) -> SearchParams {
    SearchWire.params(SearchQuery.parse(raw, calendar: calendar(zone)), zone: zone)
  }

  static func instant(_ date: Date?) -> String? {
    guard let date else { return nil }
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.string(from: date)
  }

  @Test("unparsedSentAsTerm: a chunk that did not parse is still sent, as text, in the order typed")
  func unparsedSentAsTerm() {
    let p = Self.wire(#"cabin foo:bar before:last channel:sms "open quote"#)
    #expect(p.terms == ["cabin", "foo:bar", "before:last", "channel:sms", #""open quote"#])
    #expect(p.before == nil)
    #expect(p.channels.isEmpty)
  }

  @Test("fromMeIsFlag: from:me is the flag, never a name; a name is a name; the first from: wins")
  func fromMeIsFlag() {
    let me = Self.wire("from:me dinner")
    #expect(me.fromMe)
    #expect(me.fromName == nil)
    #expect(me.terms == ["dinner"])

    let sam = Self.wire("from:Sam from:me")
    #expect(!sam.fromMe)
    #expect(sam.fromName == "Sam")
    #expect(Endpoint.search(sam).queryItems.filter { $0.name == "from" }.map(\.value) == ["Sam"])
  }

  @Test("datesAreCalendarInstants: a day or a year is its start in the parsing zone, sent as UTC")
  func datesAreCalendarInstants() {
    let p = Self.wire("after:2024-01-01 before:2025")
    #expect(Self.instant(p.after) == "2024-01-01T08:00:00.000Z")
    #expect(Self.instant(p.before) == "2025-01-01T08:00:00.000Z")
    #expect(p.tz == "America/Los_Angeles")

    let utc = Self.wire("after:2024-01-01", zone: TimeZone(identifier: "UTC")!)
    #expect(Self.instant(utc.after) == "2024-01-01T00:00:00.000Z")
    // Foundation names UTC "GMT"; the zone's own identifier is sent, and the
    // daemon's IANA check (Intl.DateTimeFormat) takes both.
    #expect(utc.tz == TimeZone(identifier: "UTC")!.identifier)

    // Several bounds narrow: the earliest before and the latest after.
    let narrowed = Self.wire("before:2025 before:2024-06-01 after:2020 after:2022-03-04")
    #expect(Self.instant(narrowed.before) == "2024-06-01T07:00:00.000Z")
    #expect(Self.instant(narrowed.after) == "2022-03-04T08:00:00.000Z")
  }

  @Test("channelsRepeat: each channel and kind is its own repeated key, deduped in the order typed")
  func channelsRepeat() {
    let p = Self.wire("channel:email channel:imessage channel:email has:link has:voice has:link in:Family")
    #expect(p.channels == ["email", "imessage"])
    #expect(p.has == ["link", "voice"])
    #expect(p.inThread == "Family")
    let items = Endpoint.search(p).queryItems
    #expect(items.filter { $0.name == "channel" }.map(\.value) == ["email", "imessage"])
    #expect(items.filter { $0.name == "has" }.map(\.value) == ["link", "voice"])
  }
}
