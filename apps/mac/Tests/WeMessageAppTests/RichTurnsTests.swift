import Foundation
import Testing
import WeMessageKit

@testable import WeMessageApp

/// v2 F4d, pure: the "rich-turns" scenario's Maya transcript as the thread
/// draws it. Receipts ride the last outbound turn but a failure stays where
/// it happened; a reaction chip says its word and whether it counts mine;
/// a failure is dotted and SMS or RCS is railed in the thread as on board
/// 08; media with no dimensions is a named 4:3 tile.
@Suite("RichTurns")
struct RichTurnsTests {
  static let utc = TimeZone(identifier: "UTC")!

  static func turns() throws -> [MessageTurn] {
    let page = try JSONDecoder().decode(
      ThreadMessagesPage.self, from: Reply.scenario("rich-turns", "threads.messages.maya.json").body)
    return MessageTurn.turns(page, glyphs: .provisional)
  }

  static func turn(_ guid: String, in turns: [MessageTurn]) throws -> MessageTurn {
    try #require(turns.first { $0.guid == guid }, "\(guid) is not in the scenario")
  }

  @Test("the scenario maps every turn: services, kinds and the hidden file left out")
  func maps() throws {
    let turns = try Self.turns()
    #expect(turns.map(\.guid) == (0...8).map { "r-0\($0)" })
    #expect(try Self.turn("r-05", in: turns).service == .sms)
    #expect(try Self.turn("r-06", in: turns).service == .rcs)
    guard case .file(let pdf) = try Self.turn("r-03", in: turns).kind else {
      Issue.record("r-03 is not a file")
      return
    }
    #expect(pdf.name == "itinerary.pdf" && pdf.bytes == 88_000)
    guard case .media(let items) = try Self.turn("r-04", in: turns).kind else {
      Issue.record("r-04 is not media")
      return
    }
    #expect(items.count == 1, "the hidden file is drawn: \(items)")
  }

  @Test("08.A note 3 in the thread: receipts on the last outbound turn, a failure where it happened")
  func statusOnLastOutbound() throws {
    let shown = SpecimenText.statusOnLastOutbound(try Self.turns())
    let delivery = Dictionary(uniqueKeysWithValues: shown.map { ($0.guid, $0.delivery) })
    #expect(delivery["r-07"] == .notDelivered(reason: "Messages error 22"))
    guard case .read = delivery["r-08"] ?? nil else {
      Issue.record("r-08 lost its read: \(String(describing: delivery["r-08"]))")
      return
    }
    for guid in ["r-00", "r-02", "r-03", "r-05"] {
      #expect(delivery[guid] == .some(nil), "\(guid) keeps a receipt")
    }
  }

  @Test("D-UI-197 and D-UI-198: the delivery words, and nothing for a null delivery")
  func deliveryWords() throws {
    let turns = try Self.turns()
    let read = try #require(try Self.turn("r-08", in: turns).delivery)
    #expect(SpecimenText.delivery(read, zone: Self.utc) == "Read 09:57")
    let failed = try #require(try Self.turn("r-07", in: turns).delivery)
    #expect(SpecimenText.delivery(failed, zone: Self.utc) == "Not delivered: Messages error 22")
    #expect(try Self.turn("r-00", in: turns).delivery == nil)
    #expect(ProvisionalUI.nullDelivery == .nothing)
    #expect(try Self.turn("r-02", in: turns).delivery == .sent(at: nil))
    #expect(try Self.turn("r-03", in: turns).delivery == .delivered)
  }

  @Test("D-UI-195 and D-UI-196: a chip says its word, its count, and whether it counts mine")
  func reactionLabels() throws {
    let turns = try Self.turns()
    let names = ProvisionalUI.reactionNames
    let loved = try #require(try Self.turn("r-06", in: turns).reactions.first)
    #expect(loved.isMine && loved.glyph == ProvisionalUI.reactionGlyphs["love"])
    #expect(SpecimenText.reactionLabel(loved) == "Loved, 1, including you")
    #expect(SpecimenText.reactionLabel(loved) == names["love"]! + ", 1" + ProvisionalUI.reactionMineSuffix)
    let laugh = try #require(try Self.turn("r-05", in: turns).reactions.first)
    #expect(!laugh.isMine && SpecimenText.reactionLabel(laugh) == names["laugh"]! + ", 1")
    let emphasize = try #require(try Self.turn("r-08", in: turns).reactions.first)
    #expect(SpecimenText.reactionLabel(emphasize) == names["emphasize"]! + ", 1")
    // Every wire kind has a glyph and a word; an unknown kind is `other`.
    for kind in ReactionGlyphs.kinds {
      #expect(ProvisionalUI.reactionGlyphs[kind] != nil && ProvisionalUI.reactionNames[kind] != nil, "\(kind)")
    }
    #expect(ReactionGlyphs.provisional.name("sparkle") == names["other"])
    // A chip with no word (WhatsApp's emoji) keeps the glyph label.
    #expect(SpecimenText.reactionLabel(.init(glyph: "x", count: 2)) == "Reaction x, 2")
  }

  @Test("D-UI-197 and D-UI-199: in the thread a failure is dotted, SMS and RCS are railed")
  func threadLooks() throws {
    let turns = try Self.turns()
    func look(_ guid: String, sms: Bool = false) throws -> BubbleLook {
      BubbleLook(turn: try Self.turn(guid, in: turns), sms: sms, style: .thread)
    }
    let failed = try look("r-07")
    #expect(failed.rule == .dotted && !failed.filled)
    #expect(try look("r-05").rule == .smsInsetRail)
    #expect(try look("r-06").rule == .smsInsetRail)
    #expect(try look("r-08").rule == .none && look("r-08").filled)
    #expect(try look("r-01").rule != .smsInsetRail)
    // In an SMS chat the stamp says the transport: no turn is railed there.
    #expect(!BubbleLook.railed(try Self.turn("r-05", in: turns), sms: true))
    #expect(BubbleLook(turn: try Self.turn("r-06", in: turns), sms: false, style: .specimen).rule == .smsInsetRail)
  }

  @Test("D-UI-200, D-UI-201 and D-UI-202: file lines and the 4:3 tile")
  func fileWords() throws {
    let turns = try Self.turns()
    guard case .media(let items) = try Self.turn("r-04", in: turns).kind, let image = items.first else {
      Issue.record("r-04 is not media")
      return
    }
    #expect(image.width == nil && image.height == nil)
    #expect(SpecimenText.mediaTile(image) == "IMG_0412.heic \u{00B7} 2.4 MB")
    #expect(ProvisionalUI.mediaTileAspect == 4.0 / 3.0)
    let nameless = MessageTurn.Attachment(name: nil, mime: "image/png")
    #expect(SpecimenText.mediaTile(nameless) == ProvisionalUI.untitledFile)
    let sticker = MessageTurn.Attachment(name: "sticker.heic", mime: "image/heic", sticker: true)
    #expect(SpecimenText.fileName(sticker) == ProvisionalUI.stickerLine)
    #expect(ProvisionalUI.resendInMessages.hasSuffix("Messages"))
  }
}
