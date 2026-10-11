import Foundation
import Testing

@testable import WeMessageKit

/// v2 F4 (rich turns): the daemon's service, delivery, reactions and file
/// metadata map onto MessageTurn, claimed only as far as the wire says.
@Suite("MessageTurn rich turns (v2 F4)")
struct MessageTurnRichTests {
  static let richPath = "fixtures/contract/responses/threads.messages.rich.json"

  /// The rich contract golden's page, decoded strictly.
  static func richPage() throws -> ThreadMessagesPage {
    let raw = try JSONSerialization.jsonObject(with: try Repo.data(richPath)) as? [String: Any]
    let body = try JSONSerialization.data(withJSONObject: try #require(raw?["body"]))
    return try JSONDecoder().decode(ThreadMessagesPage.self, from: body)
  }

  static func turn(_ extra: String, from: String = "me", kind: String = "text", attachments: Int = 0) throws
    -> ThreadTurn
  {
    let json = #"{"guid":"msg-1","from":""# + from + #"","kind":""# + kind
      + #"","text":null,"at":"2026-09-01T09:05:00.000Z","attachments":"# + String(attachments)
      + (extra.isEmpty ? "" : "," + extra) + "}"
    return try JSONDecoder().decode(ThreadTurn.self, from: Data(json.utf8))
  }

  static func mapped(_ extra: String, from: String = "me", kind: String = "text", attachments: Int = 0) throws
    -> MessageTurn
  {
    try #require(MessageTurn(turn: try turn(extra, from: from, kind: kind, attachments: attachments)))
  }

  static func file(_ name: String?, _ mime: String?, hidden: Bool = false) -> String {
    let n = name.map { "\"\($0)\"" } ?? "null"
    let m = mime.map { "\"\($0)\"" } ?? "null"
    return #"{"name":"# + n + #","mime":"# + m + #","uti":null,"bytes":null,"sticker":false,"hidden":"#
      + (hidden ? "true" : "false") + "}"
  }

  @Test("testWireServiceMapsAllFour: imessage, sms, rcs and unknown each map to their own case")
  func wireServiceMapsAllFour() throws {
    for (wire, service) in [
      ("imessage", MessageTurn.Service.imessage), ("sms", .sms), ("rcs", .rcs), ("unknown", .unknown),
    ] {
      #expect(try Self.mapped(#""service":""# + wire + #"""#).service == service, "\(wire)")
    }
  }

  @Test("testAbsentServiceIsUnknownNotIMessage: a turn whose source did not say is never assumed iMessage")
  func absentServiceIsUnknownNotIMessage() throws {
    #expect(try Self.mapped("").service == .unknown)
    #expect(try Self.mapped(#""service":"carrier-pigeon""#).service == .unknown)
    #expect(MessageTurn.service(nil) == .unknown)
  }

  @Test("testDeliveryReadWithoutAtIsDelivered: a read with no time is claimed only as delivered")
  func deliveryReadWithoutAtIsDelivered() throws {
    #expect(try Self.mapped(#""delivery":{"state":"read","at":null}"#).delivery == .delivered)
    let read = try Self.mapped(#""delivery":{"state":"read","at":"2026-09-01T09:57:00.000Z"}"#)
    #expect(read.delivery == .read(at: try #require(WireDate.parse("2026-09-01T09:57:00.000Z"))))
    #expect(try Self.mapped(#""delivery":{"state":"delivered","at":null}"#).delivery == .delivered)
    #expect(try Self.mapped(#""delivery":{"state":"sent","at":null}"#).delivery == .sent(at: nil))
    // Null is no rung proven, absent is a source that did not say: both draw nothing.
    #expect(try Self.mapped(#""delivery":null"#).delivery == nil)
    #expect(try Self.mapped("").delivery == nil)
    // A state this build does not know draws nothing rather than a guess.
    #expect(try Self.mapped(#""delivery":{"state":"sending","at":null}"#).delivery == nil)
    // Inbound never carries one, whatever the wire says.
    let inbound = try Self.mapped(#""delivery":{"state":"sent","at":null}"#, from: "them")
    #expect(inbound.delivery == nil)
  }

  @Test("testFailedNamesCode: a failure names its Messages error code")
  func failedNamesCode() throws {
    let failed = try Self.mapped(#""delivery":{"state":"failed","at":null,"errorCode":22}"#)
    #expect(failed.delivery == .notDelivered(reason: "Messages error 22"))
    #expect(failed.delivery?.isFailure == true)
  }

  @Test("testReactionsGroupByKindCountAndMine: one chip per kind, counted, marked when one is mine")
  func reactionsGroupByKindCountAndMine() throws {
    let glyphs = ReactionGlyphs(glyphs: ["love": "L", "other": "O"], names: ["love": "Loved", "other": "Reacted"])
    let wire = [
      WireReaction(kind: "love", from: "them", handle: "+15550100001"),
      WireReaction(kind: "like", from: "them", handle: "+15550100002"),
      WireReaction(kind: "love", from: "me"),
      WireReaction(kind: "love", from: "them", handle: "+15550100003"),
    ]
    let chips = MessageTurn.reactions(wire, glyphs: glyphs)
    #expect(chips.map(\.glyph) == ["L", "O"])
    #expect(chips.map(\.count) == [3, 1])
    #expect(chips.map(\.name) == ["Loved", "Reacted"])
    #expect(chips.map(\.isMine) == [true, false])
    // Without a table, the kind is its own glyph and name.
    #expect(MessageTurn.reactions(wire).map(\.glyph) == ["love", "like"])
    #expect(MessageTurn.reactions([]).isEmpty)
  }

  @Test("testImageFilesAreMedia: visible files that are all images or video are media")
  func imageFilesAreMedia() throws {
    let files = "[" + Self.file("IMG_0412.heic", "image/heic") + "," + Self.file("clip.mov", "video/quicktime") + "]"
    let turn = try Self.mapped(#""files":"# + files, kind: "attachment-only", attachments: 2)
    guard case .media(let items) = turn.kind else {
      Issue.record("not media: \(turn.kind)")
      return
    }
    #expect(items.map(\.name) == ["IMG_0412.heic", "clip.mov"])
    #expect(items.first?.mime == "image/heic")
  }

  @Test("testOneFileIsFile: one visible file that is not media is a file, nameless or not")
  func oneFileIsFile() throws {
    let pdf = try Self.mapped(
      #""files":["# + Self.file("itinerary.pdf", "application/pdf") + "]", kind: "attachment-only", attachments: 1)
    #expect(pdf.kind == .file(.init(name: "itinerary.pdf", mime: "application/pdf")))
    let nameless = try Self.mapped(#""files":["# + Self.file(nil, nil) + "]", kind: "attachment-only", attachments: 1)
    #expect(nameless.kind == .file(.init(name: nil, mime: nil)))
    // Two files that are not all media stay a count.
    let mixed = "[" + Self.file("a.pdf", "application/pdf") + "," + Self.file("b.png", "image/png") + "]"
    #expect(try Self.mapped(#""files":"# + mixed, kind: "attachment-only", attachments: 2).kind
      == .attachments(count: 2))
    // No file list at all: the count, as before F4.
    #expect(try Self.mapped("", kind: "attachment-only", attachments: 3).kind == .attachments(count: 3))
  }

  @Test("testHiddenNotDrawn: a hidden file is never drawn, and the count stays true")
  func hiddenNotDrawn() throws {
    let files = "[" + Self.file("itinerary.pdf", "application/pdf") + "," + Self.file(nil, nil, hidden: true) + "]"
    let turn = try Self.mapped(#""files":"# + files, kind: "attachment-only", attachments: 2)
    #expect(turn.kind == .file(.init(name: "itinerary.pdf", mime: "application/pdf")))
    #expect(turn.attachments == 2)
    let allHidden = try Self.mapped(
      #""files":["# + Self.file(nil, nil, hidden: true) + "]", kind: "attachment-only", attachments: 1)
    #expect(allHidden.kind == .attachments(count: 1))
  }

  @Test("testWireTurnsMatchAtlasSpecimens: the rich golden maps to 08.C's reactions, 08.G's rungs and 08.I's rail")
  func wireTurnsMatchAtlasSpecimens() throws {
    let turns = MessageTurn.turns(try Self.richPage())
    #expect(turns.count == 9)
    let atlas = try MessageTurnTests.atlas().sections
    func section(_ slug: String) -> [MessageTurn] { atlas.first { $0.slug == slug }?.turns ?? [] }

    // 08.G: every rung the atlas draws, less "sending", which chat.db cannot
    // tell apart from stuck. The failure names its cause, as 08.G's does.
    let atlasRungs = Set(section("delivery").compactMap { $0.delivery.map { $0.rung ?? -1 } })
    let wireRungs = Set(turns.compactMap { $0.delivery.map { $0.rung ?? -1 } })
    #expect(wireRungs == atlasRungs.subtracting([0]))
    #expect(turns.contains { $0.delivery == .notDelivered(reason: "Messages error 22") })
    #expect(turns.filter { $0.delivery != nil }.allSatisfy { $0.direction == .outbound })

    // 08.C: chips with a glyph and a count, on a turn someone else sent.
    let atlasChips = section("reactions").flatMap(\.reactions)
    #expect(!atlasChips.isEmpty)
    let chipped = turns.filter { !$0.reactions.isEmpty }
    #expect(chipped.contains { $0.direction == .inbound })
    for chip in chipped.flatMap(\.reactions) {
      #expect(!chip.glyph.isEmpty)
      #expect(chip.count >= 1)
    }
    #expect(chipped.flatMap(\.reactions).contains { $0.isMine })

    // 08.I: the SMS fallback the atlas draws, plus RCS and unknown.
    #expect(section("native").contains { $0.service == .sms })
    #expect(Set(turns.map(\.service)) == [.imessage, .sms, .rcs, .unknown])

    // Files: the photo is media, the PDF with a hidden companion is a file.
    let photo = try #require(turns.first { $0.guid == "msg-0102" })
    #expect(photo.kind == .media([.init(name: "IMG_0412.heic", mime: "image/heic", uti: "public.heic", bytes: 2_400_000, id: "AT-0102-1")]))
    let pdf = try #require(turns.first { $0.guid == "msg-0106" })
    #expect(pdf.kind == .file(.init(name: "itinerary.pdf", mime: "application/pdf", uti: "com.adobe.pdf", bytes: 88_000, id: "AT-0106-1")))
  }

  @Test("the wire DTOs are strict, and delivery keeps absent apart from null")
  func dtoStrict() throws {
    let absent = try Self.turn("")
    #expect(absent.delivery == nil)
    let null = try Self.turn(#""delivery":null"#)
    #expect(null.delivery == .some(nil))
    for turn in [absent, null, try Self.turn(#""delivery":{"state":"failed","at":null,"errorCode":22}"#)] {
      #expect(try JSONDecoder().decode(ThreadTurn.self, from: JSONEncoder().encode(turn)) == turn)
    }
    #expect(throws: DecodingError.self) { try Self.turn(#""delivery":{"state":"sent","at":null,"via":"x"}"#) }
    #expect(throws: DecodingError.self) { try Self.turn(#""reactions":[{"kind":"love","from":"me","glyph":"x"}]"#) }
    #expect(throws: DecodingError.self) {
      try Self.turn(#""files":[{"name":null,"mime":null,"uti":null,"bytes":null,"sticker":false,"hidden":false,"path":"x"}]"#)
    }
    // Every member of a file is required: a missing one is not a default.
    #expect(throws: DecodingError.self) {
      try Self.turn(#""files":[{"name":null,"mime":null,"bytes":null,"sticker":false,"hidden":false}]"#)
    }
  }
}
