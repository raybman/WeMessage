import Foundation
import Testing
import WeMessageKit

@testable import WeMessageApp

// v2 S4i, board 11.B: the search grammar. Every operator, every way to get
// one wrong, and the rule that a chunk which does not parse is surfaced as
// an unparsed token (drawn dashed) and still matched as text, never dropped.

@Suite("SearchQuery")
struct SearchQueryTests {
  static let utc = TimeZone(identifier: "UTC")!
  static var calendar: Calendar {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = utc
    return c
  }

  static func at(_ wire: String) throws -> Date { try #require(WireDate.parse(wire)) }

  static func q(_ raw: String) -> SearchQuery { SearchQuery.parse(raw, calendar: calendar) }

  static func doc(
    _ text: String, outbound: Bool = false, sender: String = "Maya Okafor", handle: String? = "+15550100001",
    title: String = "Maya Okafor", channel: String = "imessage", sentAt: String = "2025-03-02T10:00:00.000Z",
    attachment: Bool = false, link: Bool = false, voice: Bool = false
  ) throws -> SearchDoc {
    SearchDoc(
      guid: "g-\(text.count)", threadGuid: "iMessage;-;+15550100001", threadTitle: title, isGroup: false, channel: channel,
      outbound: outbound, sender: outbound ? "You" : sender, handle: handle, text: text, sentAt: try at(sentAt),
      hasAttachment: attachment, hasLink: link, hasVoice: voice)
  }

  // MARK: tokens

  @Test func bareWordsAreTerms() {
    let query = Self.q("lake  trip")
    #expect(query.tokens == [.term("lake"), .term("trip")])
    #expect(query.chips.map(\.text) == ["lake", "trip"])
    #expect(query.chips.allSatisfy { $0.parsed })
  }

  @Test func emptyAndWhitespaceIsEmpty() {
    #expect(Self.q("").isEmpty)
    #expect(Self.q("   ").isEmpty)
  }

  @Test func quotedPhraseIsOneTerm() {
    #expect(Self.q("\"lake trip\" cabin").tokens == [.term("lake trip"), .term("cabin")])
  }

  @Test func fromMeIsTheUser() {
    #expect(Self.q("from:me").tokens == [.from(.me)])
    #expect(Self.q("FROM:ME").tokens == [.from(.me)])
  }

  @Test func fromNameKeepsTheName() {
    #expect(Self.q("from:jordan").tokens == [.from(.name("jordan"))])
    #expect(Self.q("from:\"Maya Okafor\"").tokens == [.from(.name("Maya Okafor"))])
  }

  @Test func spaceAfterColonTakesTheNextChunk() {
    let query = Self.q("from: jordan invoice")
    #expect(query.tokens == [.from(.name("jordan")), .term("invoice")])
    #expect(query.chips.map(\.text) == ["from: jordan", "invoice"])
    #expect(query.chips[0].source == "from: jordan")
  }

  @Test func spaceAfterColonDoesNotSwallowAnotherOperator() {
    let query = Self.q("from: in:Family")
    #expect(query.tokens == [.unparsed(raw: "from:", reason: .emptyValue), .inThread("Family")])
  }

  @Test func inTakesAQuotedTitle() {
    #expect(Self.q("in:\"Family (6)\"").tokens == [.inThread("Family (6)")])
  }

  @Test func everyChannel() {
    for channel in SearchChannel.allCases {
      #expect(Self.q("channel:\(channel.rawValue)").tokens == [.channel(channel)])
    }
    #expect(Self.q("channel:iMessage").tokens == [.channel(.imessage)])
  }

  @Test func everyHas() {
    for kind in SearchHas.allCases {
      #expect(Self.q("has:\(kind.rawValue)").tokens == [.has(kind)])
    }
  }

  @Test func isoDayAndYearParse() throws {
    let day = Self.q("after:2024-01-01")
    #expect(day.tokens == [.after(SearchDate(start: try Self.at("2024-01-01T00:00:00.000Z"), grain: .day, text: "2024-01-01"))])
    let year = Self.q("before:2025")
    #expect(year.tokens == [.before(SearchDate(start: try Self.at("2025-01-01T00:00:00.000Z"), grain: .year, text: "2025"))])
  }

  // MARK: unparsed: surfaced, never dropped (S4i tooth 1)

  @Test func unknownOperatorIsSurfacedNotDropped() {
    let query = Self.q("cabin foo:bar")
    #expect(query.tokens == [.term("cabin"), .unparsed(raw: "foo:bar", reason: .unknownOperator)])
    #expect(query.chips.count == 2)
    #expect(query.chips[1].parsed == false)
    #expect(query.chips[1].text == "foo: bar")
    #expect(query.unparsed.count == 1)
  }

  @Test func malformedDateStaysUnparsed() {
    #expect(Self.q("before:last").tokens == [.unparsed(raw: "before:last", reason: .badDate)])
    #expect(Self.q("after:2024-02-30").tokens == [.unparsed(raw: "after:2024-02-30", reason: .badDate)])
    #expect(Self.q("after:2024-1-1").tokens == [.unparsed(raw: "after:2024-1-1", reason: .badDate)])
    #expect(Self.q("after:24").tokens == [.unparsed(raw: "after:24", reason: .badDate)])
    #expect(Self.q("before:2024-13-01").tokens == [.unparsed(raw: "before:2024-13-01", reason: .badDate)])
  }

  @Test func badChannelAndBadHasStayUnparsed() {
    #expect(Self.q("channel:sms").tokens == [.unparsed(raw: "channel:sms", reason: .badChannel)])
    #expect(Self.q("has:gif").tokens == [.unparsed(raw: "has:gif", reason: .badHas)])
  }

  @Test func emptyValueStaysUnparsed() {
    #expect(Self.q("from:").tokens == [.unparsed(raw: "from:", reason: .emptyValue)])
  }

  @Test func unclosedQuoteStaysUnparsed() {
    #expect(Self.q("in:\"Family (6)").tokens == [.unparsed(raw: "in:\"Family (6)", reason: .unclosedQuote)])
    #expect(Self.q("\"lake trip").tokens == [.unparsed(raw: "\"lake trip", reason: .unclosedQuote)])
  }

  @Test func unparsedTokenStillConstrainsAsText() throws {
    let query = Self.q("cabin before:last")
    #expect(query.terms == ["cabin", "before:last"])
    #expect(query.highlightTerms == ["cabin"])
    #expect(!query.matches(try Self.doc("the cabin was great")))
    #expect(query.matches(try Self.doc("the cabin before:last time")))
  }

  @Test func clockTimesAreTextNotOperators() {
    #expect(Self.q("10:30").tokens == [.term("10:30")])
  }

  @Test func everyChipCarriesItsSourceForRemoval() {
    let query = Self.q("from:me cabin after:2024-06-01 before:last")
    #expect(query.chips.map(\.source) == ["from:me", "cabin", "after:2024-06-01", "before:last"])
    #expect(query.chips.map(\.parsed) == [true, true, true, false])
    #expect(query.removing(query.chips[3]) == "from:me cabin after:2024-06-01")
    #expect(query.removing(query.chips[0]) == "cabin after:2024-06-01 before:last")
  }

  // MARK: matching

  @Test func termsMatchCaseAndDiacriticInsensitively() throws {
    #expect(Self.q("CABIN").matches(try Self.doc("booked the cabin")))
    #expect(Self.q("cafe").matches(try Self.doc("meet at the café")))
    #expect(!Self.q("canoe").matches(try Self.doc("booked the cabin")))
  }

  @Test func allTermsMustHold() throws {
    #expect(Self.q("cabin june").matches(try Self.doc("yes, booked the cabin for june")))
    #expect(!Self.q("cabin july").matches(try Self.doc("yes, booked the cabin for june")))
  }

  @Test func fromMeMatchesOutboundOnly() throws {
    #expect(Self.q("from:me cabin").matches(try Self.doc("booked the cabin", outbound: true)))
    #expect(!Self.q("from:me cabin").matches(try Self.doc("booked the cabin", outbound: false)))
  }

  @Test func fromNameMatchesSenderOrHandle() throws {
    #expect(Self.q("from:maya").matches(try Self.doc("hi")))
    #expect(Self.q("from:+15550100001").matches(try Self.doc("hi")))
    #expect(!Self.q("from:theo").matches(try Self.doc("hi")))
    #expect(!Self.q("from:maya").matches(try Self.doc("hi", outbound: true)))
  }

  @Test func inMatchesTheThreadTitle() throws {
    #expect(Self.q("in:maya").matches(try Self.doc("hi")))
    #expect(!Self.q("in:\"Flat 4B\"").matches(try Self.doc("hi")))
  }

  @Test func channelTokensOrTogether() throws {
    let both = Self.q("channel:whatsapp channel:imessage")
    #expect(both.matches(try Self.doc("hi", channel: "imessage")))
    #expect(both.matches(try Self.doc("hi", channel: "whatsapp")))
    #expect(!both.matches(try Self.doc("hi", channel: "email")))
    #expect(!Self.q("channel:email").matches(try Self.doc("hi", channel: "imessage")))
  }

  @Test func hasTokensAndTogether() throws {
    #expect(Self.q("has:attachment").matches(try Self.doc("x", attachment: true)))
    #expect(!Self.q("has:attachment").matches(try Self.doc("x")))
    #expect(Self.q("has:link").matches(try Self.doc("x", link: true)))
    #expect(Self.q("has:voice").matches(try Self.doc("x", voice: true)))
    #expect(!Self.q("has:attachment has:link").matches(try Self.doc("x", attachment: true)))
  }

  @Test func isoDatesCompareAgainstSentAt() throws {
    let after = Self.q("after:2024-06-01")
    #expect(after.matches(try Self.doc("x", sentAt: "2024-06-01T00:00:00.000Z")))
    #expect(!after.matches(try Self.doc("x", sentAt: "2024-05-31T23:59:59.000Z")))
    let before = Self.q("before:2024-06-01")
    #expect(before.matches(try Self.doc("x", sentAt: "2024-05-31T23:59:59.000Z")))
    #expect(!before.matches(try Self.doc("x", sentAt: "2024-06-01T00:00:00.000Z")))
    let year = Self.q("after:2025 before:2026")
    #expect(year.matches(try Self.doc("x", sentAt: "2025-12-31T23:00:00.000Z")))
    #expect(!year.matches(try Self.doc("x", sentAt: "2024-12-31T23:00:00.000Z")))
  }

  @Test func operatorsOnlyQueryMatchesWithoutTerms() throws {
    #expect(Self.q("from:me").matches(try Self.doc("anything", outbound: true)))
  }
}
