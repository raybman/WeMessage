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
}
