import Foundation
import Testing

@testable import WeMessageKit

/// S4d (plan 3.1): the daemon's three turn kinds map to MessageTurn, and
/// anything else maps to nil rather than being drawn as something it is not.
@Suite("MessageTurn")
struct MessageTurnTests {
  static func turn(
    from: String = "them", kind: String = "text", text: String? = "hello", at: String = "2026-09-01T09:05:00.000Z",
    edited: String? = nil, unsent: String? = nil, attachments: Int = 0
  ) throws -> ThreadTurn {
    var object: [String: Any] = [
      "guid": "msg-1", "from": from, "kind": kind, "text": text ?? NSNull(), "at": at, "attachments": attachments,
    ]
    if from == "them" { object["handle"] = "+15550100004" }
    if let edited { object["editedAt"] = edited }
    if let unsent { object["unsentAt"] = unsent }
    let data = try JSONSerialization.data(withJSONObject: object)
    return try JSONDecoder().decode(ThreadTurn.self, from: data)
  }

  @Test("the three daemon kinds map: text, attachment-only with its count, audio with no transcript")
  func threeKinds() throws {
    let text = try #require(MessageTurn(turn: try Self.turn()))
    #expect(text.kind == .text)
    #expect(text.text == "hello")
    #expect(text.direction == .inbound)
    #expect(text.handle == "+15550100004")
    let files = try #require(MessageTurn(turn: try Self.turn(kind: "attachment-only", text: nil, attachments: 3)))
    #expect(files.kind == .attachments(count: 3))
    #expect(files.text == nil)
    let audio = try #require(MessageTurn(turn: try Self.turn(kind: "audio", text: nil, attachments: 1)))
    #expect(audio.kind == .voice(transcript: nil))
  }

  @Test("everything else maps to nil: an unknown kind, an unknown side, a time that does not parse")
  func othersNil() throws {
    for kind in ["sticker", "poll", "", "TEXT", "system"] {
      #expect(MessageTurn(turn: try Self.turn(kind: kind)) == nil, "kind \(kind) mapped")
    }
    for from in ["you", "", "ME"] {
      #expect(MessageTurn(turn: try Self.turn(from: from)) == nil, "from \(from) mapped")
    }
    #expect(MessageTurn(turn: try Self.turn(at: "yesterday")) == nil)
  }

  @Test("me is outbound; an edit is flagged; an unsent turn never keeps its words")
  func flags() throws {
    let mine = try #require(MessageTurn(turn: try Self.turn(from: "me")))
    #expect(mine.direction == .outbound)
    #expect(mine.handle == nil)
    let edited = try #require(MessageTurn(turn: try Self.turn(edited: "2026-09-01T09:06:00.000Z")))
    #expect(edited.isEdited)
    #expect(!edited.isUnsent)
    // The fixture for sam carries the unsent words; the turn must drop them.
    let unsent = try #require(
      MessageTurn(turn: try Self.turn(from: "me", text: "wrong file, ignore that", unsent: "2026-08-31T18:06:00.000Z")))
    #expect(unsent.isUnsent)
    #expect(unsent.text == nil)
  }

  @Test("every turn of every rich-scenario thread maps, oldest first")
  func richThreadsMap() throws {
    let dir = "fixtures/scenarios/rich/responses/"
    let names = try Repo.files(under: "fixtures/scenarios/rich/responses")
      .filter { $0.hasPrefix("threads.messages.") }
    #expect(names.count >= 8)
    for name in names {
      let raw = try JSONSerialization.jsonObject(with: try Repo.data(dir + name)) as? [String: Any]
      let body = try JSONSerialization.data(withJSONObject: try #require(raw?["body"]))
      let page = try JSONDecoder().decode(ThreadMessagesPage.self, from: body)
      let turns = MessageTurn.turns(page)
      #expect(turns.count == page.turns.count, "\(name) dropped a turn")
      #expect(turns.map(\.sentAt) == turns.map(\.sentAt).sorted(), "\(name) is not oldest first")
    }
  }

  // v2 S4e, board 08: the richer kinds and per-message facts.

  static let atlasPath = "fixtures/atlas/threads.messages.atlas.json"

  static func atlas() throws -> AtlasGolden {
    try JSONDecoder().decode(AtlasGolden.self, from: try Repo.data(atlasPath))
  }

  @Test("every kind round-trips through its wire form")
  func kindsRoundTrip() throws {
    let file = MessageTurn.Attachment(name: "a.pdf", mime: "application/pdf", bytes: 10)
    let kinds: [MessageTurn.Kind] = [
      .text, .emojiOnly, .attachments(count: 2), .media([file]), .voice(transcript: "hi", seconds: 3),
      .voice(transcript: nil, seconds: nil), .file(file), .link(.init(title: "t", host: "example.com")),
      .location("1 Main St"), .contactCard(.init(name: "A", handle: "+15550100001")),
      .poll(.init(question: "q", options: [.init(title: "o", votes: 1)])), .system, .unsupported("View-once photo"),
    ]
    for kind in kinds {
      let data = try JSONEncoder().encode(kind)
      #expect(try JSONDecoder().decode(MessageTurn.Kind.self, from: data) == kind)
    }
    #expect(throws: DecodingError.self) {
      try JSONDecoder().decode(MessageTurn.Kind.self, from: Data(#"{"type":"sticker"}"#.utf8))
    }
  }

  @Test("a turn round-trips with its service, delivery, reactions, effect, quote and forward flag")
  func turnRoundTrip() throws {
    let turn = MessageTurn(
      guid: "g", direction: .outbound, kind: .text, text: "hi", sentAt: DeliveryTests.at, service: .sms,
      delivery: .read(at: DeliveryTests.at), reactions: [.init(glyph: "\u{2665}\u{FE0E}", count: 2)],
      effect: "Fireworks", quote: "earlier", isForwarded: true)
    let back = try JSONDecoder().decode(MessageTurn.self, from: try JSONEncoder().encode(turn))
    #expect(back == turn)
  }

  @Test("delivery is an outbound fact: an inbound turn drops it, and a wire turn carrying it does not decode")
  func inboundDelivery() throws {
    let turn = MessageTurn(
      guid: "g", direction: .inbound, kind: .text, text: "hi", sentAt: DeliveryTests.at, delivery: .delivered)
    #expect(turn.delivery == nil)
    let wire = #"{"guid":"g","direction":"inbound","kind":{"type":"text"},"text":"hi","#
      + #""sentAt":"2026-09-01T09:53:00.000Z","delivery":{"state":"delivered"}}"#
    #expect(throws: DecodingError.self) { try JSONDecoder().decode(MessageTurn.self, from: Data(wire.utf8)) }
  }

  @Test("the atlas golden decodes: ten sections, 08.A to 08.J, every kind and every delivery rung present")
  func atlasDecodes() throws {
    let golden = try Self.atlas()
    #expect(
      golden.sections.map(\.slug) == [
        "anatomy", "text", "reactions", "media", "voice", "payloads", "delivery", "draft", "native", "coverage",
      ])
    let turns = golden.sections.flatMap(\.turns)
    #expect(Set(turns.map(\.guid)).count == turns.count, "a guid repeats")
    func has(_ match: (MessageTurn.Kind) -> Bool) -> Bool { turns.contains { match($0.kind) } }
    #expect(has { if case .emojiOnly = $0 { true } else { false } })
    #expect(has { if case .media = $0 { true } else { false } })
    #expect(has { if case .voice(let t, _) = $0 { t != nil } else { false } })
    #expect(has { if case .file = $0 { true } else { false } })
    #expect(has { if case .link = $0 { true } else { false } })
    #expect(has { if case .location = $0 { true } else { false } })
    #expect(has { if case .contactCard = $0 { true } else { false } })
    #expect(has { if case .poll = $0 { true } else { false } })
    #expect(has { if case .system = $0 { true } else { false } })
    #expect(has { if case .unsupported = $0 { true } else { false } })
    let rungs = Set(turns.compactMap { $0.delivery.map { $0.rung ?? -1 } })
    #expect(rungs == [-1, 0, 1, 2, 3])
    #expect(turns.contains { $0.service == .sms })
    #expect(turns.contains { $0.effect != nil })
    #expect(turns.contains { !$0.reactions.isEmpty })
    // Reactions are read where someone else left them: inbound only (08.C).
    #expect(turns.filter { !$0.reactions.isEmpty }.allSatisfy { $0.direction == .inbound })
  }

  @Test("the atlas golden is synthetic: 555 numbers, example.com, no em dash")
  func atlasSynthetic() throws {
    let raw = try Repo.text(Self.atlasPath)
    #expect(!raw.contains("\u{2014}"))
    let turns = try Self.atlas().sections.flatMap(\.turns)
    for handle in turns.compactMap(\.handle) { #expect(handle.hasPrefix("+1555"), "\(handle)") }
    for turn in turns {
      if case .contactCard(let card) = turn.kind { #expect(card.handle.hasPrefix("+1555")) }
      if case .link(let link) = turn.kind { #expect(link.host == "example.com") }
    }
    #expect(raw.range(of: #"@[a-z0-9-]+\.(com|ai|net|org)"#, options: .regularExpression) == nil)
  }
}
