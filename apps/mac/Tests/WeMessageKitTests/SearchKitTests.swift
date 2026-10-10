import Foundation
import Testing
@testable import WeMessageKit

/// v2 F2d: the Kit's half of search. Two endpoints, three goldens, the query
/// spelled exactly as the TS client spells it, and the refusals the app sees.
@Suite("SearchKit")
struct SearchKitTests {
  static let chat = "iMessage;-;+15551234567"
  static let base = URL(string: "http://127.0.0.1:47100")!

  static func url(_ endpoint: Endpoint) throws -> String {
    try endpoint.urlRequest(baseURL: base, token: nil).url?.absoluteString ?? ""
  }

  // MARK: the query

  @Test("searchEncodesRepeatedKeys: every key, lists repeated, in the TS client's order, URLSearchParams-encoded")
  func searchEncodesRepeatedKeys() throws {
    let params = SearchParams(
      terms: ["see you", "cabin"], fromName: "Sam Q", inThread: Self.chat, channels: ["imessage", "email"],
      has: ["attachment", "link"], before: Date(timeIntervalSince1970: 1_767_323_045.5),
      after: Date(timeIntervalSince1970: 1_704_096_000), tz: "America/Los_Angeles", limit: 25, cursor: "c/1+")
    let search = Endpoint.search(params)
    #expect(search.route == "GET /v1/search")
    #expect(search.path == "/v1/search")
    #expect(try search.body() == nil)
    #expect(
      try Self.url(search)
        == "http://127.0.0.1:47100/v1/search?term=see+you&term=cabin&from=Sam+Q&in=iMessage%3B-%3B%2B15551234567"
        + "&channel=imessage&channel=email&has=attachment&has=link&before=2026-01-02T03%3A04%3A05.500Z"
        + "&after=2024-01-01T08%3A00%3A00.000Z&tz=America%2FLos_Angeles&limit=25&cursor=c%2F1%2B")
  }

  @Test("fromMe sends from=me and wins over a name; empty lists and nil fields stay off the wire")
  func fromMeAndOmissions() throws {
    let mine = SearchParams(terms: ["ok"], fromMe: true, fromName: "Sam", tz: "UTC")
    #expect(try Self.url(.search(mine)) == "http://127.0.0.1:47100/v1/search?term=ok&from=me&tz=UTC&limit=50")
    #expect(try Self.url(.search(SearchParams(tz: "UTC"))) == "http://127.0.0.1:47100/v1/search?tz=UTC&limit=50")
  }

  @Test("years: GET /v1/threads/:guid/years, guid encoded, tz the only key")
  func yearsPath() throws {
    let years = Endpoint.threadYears(guid: Self.chat, tz: "America/Los_Angeles")
    #expect(years.route == "GET /v1/threads/:guid/years")
    #expect(
      try Self.url(years)
        == "http://127.0.0.1:47100/v1/threads/iMessage%3B-%3B%2B15551234567/years?tz=America%2FLos_Angeles")
    #expect(try years.body() == nil)
  }

  @Test("the search schema, as the daemon sees the query: repeats collect into a list, and the list limits hold")
  func schemaLimits() throws {
    let schema = try Fixtures.schema("get.v1.search")
    func problems(_ p: SearchParams) throws -> [String] {
      try MiniSchema.violations(of: MiniSchema.queryInstance(Endpoint.search(p).queryItems, schema: schema), against: schema)
    }
    let two = MiniSchema.queryInstance(Endpoint.search(SearchParams(terms: ["a", "b"], tz: "UTC")).queryItems, schema: schema)
    #expect(two["term"] == ["a", "b"])
    #expect(try problems(SearchParams(terms: Array(repeating: "cabin", count: 8), tz: "UTC")).isEmpty)
    #expect(try !problems(SearchParams(terms: Array(repeating: "cabin", count: 9), tz: "UTC")).isEmpty, "maxItems 8")
    #expect(try !problems(SearchParams(has: ["link", "link", "link", "link"], tz: "UTC")).isEmpty, "maxItems 3")
    #expect(try !problems(SearchParams(channels: ["sms"], tz: "UTC")).isEmpty, "an item outside the enum")
  }

  // MARK: the goldens

  @Test("search.partial decodes: the short term is partial, other channels are not searched, and why")
  func partialGolden() async throws {
    let got = try await GatewayClient.testing(FakeTransport { _, _ in try Reply.response("search.partial") })
      .search(SearchParams(terms: ["ok"], fromMe: true, channels: ["imessage", "whatsapp"], tz: "UTC"))
    let page = try #require(got.value)
    #expect(page.total == 1)
    #expect(page.nextCursor == nil)
    #expect(page.hits.first?.from == "me")
    #expect(page.hits.first?.handle == nil)
    #expect(page.facets.senders == [SenderFacetDTO(handle: "me", count: 1)])
    #expect(page.coverage.channels.first == .searched(indexed: 7, eligible: 7, indexedThroughRowid: 7, mirrorAsOf: nil))
    #expect(page.coverage.channels.dropFirst().allSatisfy { $0 == .notSearched(channel: $0.channel, reason: "no-source") })
    #expect(page.coverage.channels.map(\.channel) == ["imessage", "whatsapp", "linkedin", "email"])
    #expect(page.coverage.tokens.first == TokenAppliedDTO(op: "term", value: "ok", applied: "partial", reason: "short-term"))
    #expect(page.coverage.tokens[1].reason == nil)
    #expect(page.coverage.deletionsChecked)
  }

  @Test("threads.years decodes through the client, newest year first")
  func yearsGolden() async throws {
    let got = try await GatewayClient.testing(FakeTransport { _, _ in try Reply.response("threads.years") })
      .threadYears(Self.chat, tz: "America/Los_Angeles")
    let years = try #require(got.value)
    #expect(years.tz == "America/Los_Angeles")
    #expect(years.years == [YearCountDTO(year: 2026, count: 5, first: "2026-09-01T12:00:11.000Z", last: "2026-09-01T12:00:43.000Z")])
  }

  @Test("a coverage row is strict per state: searched is only ever imessage, and an unknown state is refused")
  func coverageStrict() throws {
    func decode(_ text: String) throws -> ChannelCoverageDTO {
      try JSONDecoder().decode(ChannelCoverageDTO.self, from: Data(text.utf8))
    }
    #expect(throws: DecodingError.self) {
      try decode(#"{"channel":"whatsapp","state":"searched","indexed":1,"eligible":1,"indexedThroughRowid":1,"mirrorAsOf":null}"#)
    }
    #expect(throws: DecodingError.self) { try decode(#"{"channel":"email","state":"not-searched","reason":"no-source","indexed":1}"#) }
    #expect(throws: DecodingError.self) { try decode(#"{"channel":"email","state":"half-searched"}"#) }
    #expect(throws: DecodingError.self) {
      try decode(#"{"channel":"imessage","state":"searched","indexed":1,"eligible":1,"indexedThroughRowid":1}"#)
    }
    #expect(try decode(#"{"channel":"imessage","state":"not-searched","reason":"not-requested"}"#)
      == .notSearched(channel: "imessage", reason: "not-requested"))
  }

  // MARK: refusals

  @Test("a 400 search is thrown; an unreadable index is refused; an unknown chat's years are refused as .unknownChat")
  func refusals() async throws {
    for name in ["400.empty-search", "400.invalid-search"] {
      let fixture = try Fixtures.error(name)
      let bad = FakeTransport { _, _ in try Reply.error(name) }
      await #expect(throws: GatewayError.request(status: 400, body: fixture.body)) {
        try await GatewayClient.testing(bad).search(SearchParams(tz: "UTC"))
      }
    }
    let down = FakeTransport { _, _ in try Reply.error("503.source-unavailable") }
    #expect(try await GatewayClient.testing(down).search(SearchParams(terms: ["cabin"], tz: "UTC")).refusal == .sourceUnavailable)

    let gone = FakeTransport { _, _ in try Reply.error("404.unknown-chat") }
    let unknown = try await GatewayClient.testing(gone).threadYears("iMessage;-;+15550100009", tz: "UTC")
    #expect(unknown.refusal == .unknownChat)
    // Only the conversation routes read unknown-chat as a refusal; a search never names a chat that way.
    let stray = FakeTransport { _, _ in try Reply.error("404.unknown-chat") }
    await #expect(throws: GatewayError.self) {
      try await GatewayClient.testing(stray).search(SearchParams(terms: ["cabin"], tz: "UTC"))
    }
  }
}
