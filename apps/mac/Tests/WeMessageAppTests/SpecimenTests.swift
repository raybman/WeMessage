import Foundation
import Testing
import WeMessageKit

@testable import WeMessageApp

/// Board 08 (plan S4e), pure: the specimen sheet's content is the atlas
/// golden, each specimen's fill and rule are what the UI probes measure,
/// and the sheet's words are fixed. The rule and fill rows are the local
/// teeth for the CI-only pixel probes: an SMS bubble is never dashed, an
/// inbound bubble is never filled, a sent outbound bubble is ink.
@Suite("Specimen")
struct SpecimenTests {
  static func content() throws -> SpecimenContent { try FixtureCatalogue.specimens() }

  static func turn(_ guid: String) throws -> MessageTurn {
    let turn = try content().turn(guid)
    #expect(turn != nil, "\(guid) is not in the golden")
    return try #require(turn)
  }

  static func look(_ guid: String) throws -> BubbleLook {
    BubbleLook(turn: try turn(guid), sms: false, style: .specimen)
  }

  @Test("the catalogue's embedded golden decodes equal to fixtures/atlas, section for section")
  func catalogueMatchesGolden() throws {
    let onDisk = try JSONDecoder().decode(
      AtlasGolden.self, from: Data(try Repo.text("fixtures/atlas/threads.messages.atlas.json").utf8))
    let content = try Self.content()
    #expect(content.golden == onDisk)
    #expect(
      content.golden.sections.map(\.slug) == [
        "anatomy", "text", "reactions", "media", "voice", "payloads", "delivery", "draft", "native", "coverage",
      ])
    #expect(content.draft.inboundGuid == "atlas-h1")
    #expect(content.thread.chatGuid == content.draft.chatGuid)
  }

  @Test("D-UI-39: every SMS specimen is an inset rail, never dashed, and a sent one is filled")
  func smsNeverDashed() throws {
    var seen = 0
    for section in try Self.content().golden.sections {
      for turn in section.turns where turn.service == .sms {
        seen += 1
        let look = BubbleLook(turn: turn, sms: false, style: .specimen)
        #expect(look.rule == .smsInsetRail, "\(turn.guid): \(look.rule)")
        #expect(look.rule != .dashed)
      }
    }
    #expect(seen >= 1)
    let i1 = try Self.look("atlas-i1")
    #expect(i1.filled && i1.fill == .ink)
  }

  @Test("D-UI-27 and D-UI-41: a sent outbound bubble is ink; an inbound one is paper with an ink outline")
  func fills() throws {
    let a4 = try Self.look("atlas-a4")
    #expect(a4.filled && a4.fill == .ink && a4.rule == .none)
    for guid in ["atlas-a1", "atlas-a2", "atlas-b1", "atlas-c1", "atlas-h1"] {
      let look = try Self.look(guid)
      #expect(!look.filled && look.fill == .layer1 && look.rule == .outline, "\(guid): \(look)")
    }
  }

  @Test("08.F and 08.G: expired, unsupported and unsent are placeholders, not delivered is dotted, an effect is a double rule")
  func rules() throws {
    for guid in ["atlas-f3", "atlas-f8", "atlas-b8"] {
      #expect(try Self.look(guid).rule == .placeholder, "\(guid)")
    }
    let g9 = try Self.look("atlas-g9")
    #expect(g9.rule == .dotted && !g9.filled)
    #expect(try Self.look("atlas-i2").rule == .effect)
    // The thread keeps its own rules: an outbound turn in an SMS chat.
    let thread = BubbleLook(turn: try Self.turn("atlas-a4"), sms: true, style: .thread)
    #expect(thread.rule == .dashed || thread.rule == .smsTrailingRail)
  }

  @Test("08.A note 3: the delivery state rides the last outbound turn only")
  func statusOnLastOutbound() throws {
    let turns = try #require(try Self.content().section("anatomy")).turns
    let shown = SpecimenText.statusOnLastOutbound(turns)
    #expect(shown.count == turns.count)
    #expect(shown.first { $0.guid == "atlas-a3" }?.delivery == nil)
    #expect(shown.first { $0.guid == "atlas-a4" }?.delivery == .delivered)
    #expect(shown.map(\.guid) == turns.map(\.guid))
  }

  @Test("the sheet's words: sizes, progress, durations, the transcript collapse and delivery lines")
  func words() throws {
    #expect(SpecimenText.size(2_400_000) == "2.4 MB")
    #expect(SpecimenText.size(64_000_000) == "64 MB")
    #expect(SpecimenText.size(420_000) == "420 KB")
    #expect(SpecimenText.progress(received: 18_200_000, of: 64_000_000) == "18.2 of 64 MB")
    #expect(SpecimenText.duration(19) == "0:19")
    #expect(SpecimenText.duration(83) == "1:23")
    let short = SpecimenText.collapse("Friday is fine, see you there.")
    #expect(short.shown == "Friday is fine, see you there." && !short.collapsed)
    let long = String(repeating: "word ", count: 80)
    let cut = SpecimenText.collapse(long)
    #expect(cut.collapsed && cut.shown.hasSuffix("\u{2026}") && cut.shown.count <= 4 * 52)
    #expect(SpecimenText.delivery(.notDelivered(reason: "Not registered with iMessage"), zone: SpecimenContent.zone)
      == "Not delivered: Not registered with iMessage")
    #expect(SpecimenText.delivery(.delivered, zone: SpecimenContent.zone) == "Delivered")
    #expect(SpecimenText.delivery(.sent(at: nil), zone: SpecimenContent.zone) == "Sent")
  }

  @Test("the title band leaves the frost evidence's top patch bare: the title is capped left of it")
  func bandPatchBare() throws {
    let patch = FrostProbe.atlasBandPatch
    #expect(patch.x >= FrostProbe.atlasTitleMaxX)
    #expect(patch.y >= 0 && patch.y + patch.height <= Double(ShellView.titleBand))
    #expect(patch.x >= FrostProbe.stripeBand.x + FrostProbe.stripeBand.width + 60)
    let sheet = try Repo.text("apps/mac/Sources/WeMessageApp/Boards/Atlas/SpecimenSheet.swift")
    #expect(sheet.contains(".frame(maxWidth: FrostProbe.atlasTitleMaxX - (TitleBar.lightsReserve + 8), alignment: .leading)"))
    #expect(sheet.contains(".padding(.leading, TitleBar.lightsReserve + 8)"))
  }

  @Test("D-UI-40: emoji draw in text presentation, never colour")
  func monochromeEmoji() {
    let shown = SpecimenText.textPresentation("Landed \u{2708}\u{FE0F}")
    #expect(!shown.unicodeScalars.contains { $0.value == 0xFE0F })
    #expect(shown.unicodeScalars.map(\.value).suffix(2) == [0x2708, 0xFE0E])
    #expect(SpecimenText.textPresentation("plain") == "plain")
  }
}
