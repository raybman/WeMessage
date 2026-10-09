import Foundation
import Testing
import WeMessageKit

@testable import WeMessageApp

/// v2 B1, board 03 (WhatsApp over fixtures): the thread and turn meta read
/// into typed values with safe defaults, the device panel per state, the
/// history horizon's place, reactions one per person, the voice note's
/// seconds, the per-row tag rule and the board's colours.
@Suite("Board03Model")
struct Board03ModelTests {
  static var utc: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    return calendar
  }

  static let asOf = WireDate.parse("2026-09-01T12:00:43.000Z")!

  static func meta(_ json: String) throws -> [String: JSONValue] {
    try JSONDecoder().decode([String: JSONValue].self, from: Data(json.utf8))
  }

  static func turn(
    _ guid: String, _ at: String, from: String = "them", kind: String = "text", text: String? = "Hello",
    attachments: Int = 0, meta: [String: JSONValue]? = nil
  ) -> ThreadTurn {
    // The Kit's memberwise init is internal: build the wire JSON and decode it.
    var wire: [String: JSONValue] = [
      "guid": .string(guid), "from": .string(from), "kind": .string(kind), "text": text.map(JSONValue.string) ?? .null,
      "at": .string(at), "attachments": .number(Double(attachments)),
    ]
    if from == "them" { wire["handle"] = "+15550142001" }
    if let meta { wire["meta"] = .object(meta) }
    let data = try! JSONValue.object(wire).canonicalData()
    return try! JSONDecoder().decode(ThreadTurn.self, from: data)
  }

  // MARK: thread meta

  @Test("B1 03: the thread meta reads each linked device, phone and horizon")
  func threadMeta() throws {
    let m = WhatsAppThreadMeta.parse(
      try Self.meta(
        """
        {"linkedDevice":"expired","historyHorizon":"2026-08-14T00:00:00.000Z","phonePanel":"offline",
         "linkedAt":"2026-08-14T09:00:00.000Z","members":7,"admins":2,"adminOnly":true}
        """))
    #expect(m.linkedDevice == .expired)
    #expect(m.historyHorizon == WireDate.parse("2026-08-14T00:00:00.000Z"))
    #expect(m.phonePanel == .offline)
    #expect(m.linkedAt == WireDate.parse("2026-08-14T09:00:00.000Z"))
    #expect(m.members == 7 && m.admins == 2 && m.adminOnly)
    for state in ["linked", "expired", "relinking"] {
      #expect(WhatsAppThreadMeta.parse(["linkedDevice": .string(state)]).linkedDevice.rawValue == state)
    }
    for state in ["online", "offline"] {
      #expect(WhatsAppThreadMeta.parse(["phonePanel": .string(state)]).phonePanel.rawValue == state)
    }
  }

  @Test("B1 03: missing, mistyped or unknown thread meta reads as the cautious default, never a crash")
  func threadMetaDefaults() throws {
    #expect(WhatsAppThreadMeta.parse(nil) == WhatsAppThreadMeta())
    #expect(WhatsAppThreadMeta.parse([:]) == WhatsAppThreadMeta())
    let odd = WhatsAppThreadMeta.parse(
      try Self.meta(
        """
        {"linkedDevice":"paired","historyHorizon":"last week","phonePanel":7,"linkedAt":null,
         "members":-3,"admins":"two","adminOnly":"yes"}
        """))
    #expect(odd == WhatsAppThreadMeta())
    #expect(odd.linkedDevice == .unknown && odd.phonePanel == .unknown && odd.historyHorizon == nil)
    // "unknown" on the wire is not a state the fixture may assert.
    #expect(WhatsAppThreadMeta.parse(["linkedDevice": "unknown"]).linkedDevice == .unknown)
    #expect(WhatsAppThreadMeta.parse(["linkedDevice": .array([])]).linkedDevice == .unknown)
  }

  // MARK: turn meta

  @Test("B1 03: the turn meta reads reactions, a voice note and the media state")
  func turnMeta() throws {
    let m = WhatsAppTurnMeta.parse(
      try Self.meta(
        """
        {"reactions":[{"emoji":"\u{2764}","from":"+15550142001"},{"emoji":"\u{1F44D}","from":"+15550142002"}],
         "voiceNote":{"durationMs":14600,"transcript":"Running late, see you at eight."},
         "mediaState":"available","mediaKind":"video","mediaBytes":1250000,"notShown":"poll"}
        """))
    #expect(m.reactions.map(\.emoji) == ["\u{2764}", "\u{1F44D}"])
    #expect(m.voiceNote == WhatsAppVoiceNote(seconds: 15, transcript: "Running late, see you at eight."))
    #expect(m.mediaState == .available)
    #expect(m.mediaKind == .video)
    #expect(m.mediaBytes == 1_250_000)
    #expect(m.notShown == .poll)
  }

  @Test("B1 03: missing or unknown turn meta reads as no reactions, media on demand, nothing hidden")
  func turnMetaDefaults() throws {
    #expect(WhatsAppTurnMeta.parse(nil) == WhatsAppTurnMeta())
    let odd = WhatsAppTurnMeta.parse(
      try Self.meta(
        """
        {"reactions":"lots","voiceNote":{"durationMs":-1,"transcript":""},"mediaState":"cached",
         "mediaKind":"sticker","mediaBytes":"big","notShown":"sticker"}
        """))
    #expect(odd.reactions.isEmpty)
    #expect(odd.voiceNote == WhatsAppVoiceNote(seconds: nil, transcript: nil))
    #expect(odd.mediaState == .onDemand, "an unknown media state must promise less, not more")
    #expect(odd.mediaKind == .photo)
    #expect(odd.mediaBytes == nil)
    #expect(odd.notShown == nil)
  }

  @Test("B1 03: one reaction per person, the later replacing theirs; grouped by emoji in first-seen order with counts")
  func reactionsOnePerPerson() throws {
    let reactions = WhatsAppTurnMeta.reactions(
      try JSONDecoder().decode(
        [JSONValue].self,
        from: Data(
          """
          [{"emoji":"\u{2764}","from":"a"},{"emoji":"\u{1F44F}","from":"b"},{"emoji":"\u{2764}","from":"c"},
           {"emoji":"\u{1F602}","from":"a"},{"from":"d"},{"emoji":"","from":"e"},{"emoji":"\u{1F44F}"},7]
          """.utf8)))
    // a moved from heart to laughing; d and e had no emoji; the last clap has
    // no sender and counts alone.
    #expect(reactions.map(\.emoji) == ["\u{1F44F}", "\u{2764}", "\u{1F602}"])
    #expect(reactions.map(\.count) == [2, 1, 1])
    #expect(reactions.first { $0.emoji == "\u{2764}" }?.from == ["c"])
  }

  @Test("B1 03: a voice note's seconds round from its milliseconds")
  func voiceSeconds() {
    func seconds(_ ms: Double) -> Int? {
      WhatsAppTurnMeta.parse(["voiceNote": .object(["durationMs": .number(ms)])]).voiceNote?.seconds
    }
    #expect(seconds(0) == 0)
    #expect(seconds(1499) == 1)
    #expect(seconds(1500) == 2)
    #expect(seconds(62_000) == 62)
    #expect(WhatsAppTurnMeta.parse(["voiceNote": .object([:])]).voiceNote == WhatsAppVoiceNote(seconds: nil, transcript: nil))
  }

  // MARK: turns

  @Test("B1 03: an audio turn carries its transcript and seconds into the bubble; media and hidden kinds say how to draw")
  func turnDisplay() throws {
    let voice = WhatsAppTurn(
      turn: Self.turn(
        "v", "2026-09-01T09:00:00.000Z", kind: "audio", text: nil,
        meta: ["voiceNote": .object(["durationMs": 14_600, "transcript": "On my way."])]))
    #expect(voice?.turn.kind == .voice(transcript: "On my way.", seconds: 15))
    #expect(voice?.display == .bubble)
    let bare = WhatsAppTurn(turn: Self.turn("b", "2026-09-01T09:00:00.000Z", kind: "audio", text: nil))
    #expect(bare?.turn.kind == .voice(transcript: nil))
    let media = WhatsAppTurn(
      turn: Self.turn(
        "m", "2026-09-01T09:00:00.000Z", kind: "attachment-only", text: nil, attachments: 1,
        meta: ["mediaState": "onDemand", "mediaBytes": 1_200_000]))
    #expect(media?.display == .onDemand(.photo, bytes: 1_200_000))
    let here = WhatsAppTurn(
      turn: Self.turn(
        "h", "2026-09-01T09:00:00.000Z", kind: "attachment-only", text: nil, attachments: 1,
        meta: ["mediaState": "available"]))
    #expect(here?.display == .bubble)
    // No meta at all: a media turn is on demand, never fetched.
    let silent = WhatsAppTurn(
      turn: Self.turn("s", "2026-09-01T09:00:00.000Z", kind: "attachment-only", text: nil, attachments: 1))
    #expect(silent?.display == .onDemand(.photo, bytes: nil))
    for hidden in WhatsAppNotShown.allCases {
      let t = WhatsAppTurn(
        turn: Self.turn("n", "2026-09-01T09:00:00.000Z", text: nil, meta: ["notShown": .string(hidden.rawValue)]))
      #expect(t?.display == .notShown(hidden))
      #expect(hidden.title.isEmpty == false && hidden.detail.isEmpty == false)
    }
    #expect(WhatsAppTurn(turn: Self.turn("x", "2026-09-01T09:00:00.000Z", kind: "sticker")) == nil)
    #expect(WhatsAppTurn(turn: Self.turn("x", "yesterday")) == nil)
  }

  // MARK: device panel (tooth 1)

  @Test("B1 03 tooth 1: expired and re-linking replace the transcript with the re-link card; only linked draws the linked line")
  func devicePanel() {
    func panel(_ state: String?, linkedAt: String? = nil) -> WhatsAppDevicePanel {
      var meta: [String: JSONValue] = [:]
      if let state { meta["linkedDevice"] = .string(state) }
      if let linkedAt { meta["linkedAt"] = .string(linkedAt) }
      return WhatsAppDevicePanel.make(WhatsAppThreadMeta.parse(meta), asOf: Self.asOf)
    }
    #expect(panel("expired") == .relink(.expired))
    #expect(panel("relinking") == .relink(.relinking))
    #expect(panel("expired").replacesTranscript)
    #expect(panel("relinking").replacesTranscript)
    #expect(panel("linked").replacesTranscript == false)
    #expect(panel("linked") == .linked(days: nil, warnDaysLeft: nil))
    #expect(panel(nil) == .unknown)
    #expect(panel("paired") == .unknown)
    #expect(panel(nil).replacesTranscript == false)
    // Day 3: no warning. Day 18 of 20: two days left.
    #expect(panel("linked", linkedAt: "2026-08-29T12:00:00.000Z") == .linked(days: 3, warnDaysLeft: nil))
    #expect(panel("linked", linkedAt: "2026-08-14T09:00:00.000Z") == .linked(days: 18, warnDaysLeft: 2))
    #expect(panel("linked", linkedAt: "2026-08-16T12:00:00.000Z") == .linked(days: 16, warnDaysLeft: nil))
    #expect(panel("linked", linkedAt: "2026-08-15T12:00:00.000Z") == .linked(days: 17, warnDaysLeft: 3))
    #expect(panel("linked", linkedAt: "2026-07-01T12:00:00.000Z") == .linked(days: 62, warnDaysLeft: 0))
    // A link in the future is not a count.
    #expect(panel("linked", linkedAt: "2026-09-02T12:00:00.000Z") == .linked(days: nil, warnDaysLeft: nil))
  }

  // MARK: horizon

  @Test("B1 03: the horizon sits above the first turn at or after it, before that turn's day separator")
  func horizon() throws {
    let turns = [
      Self.turn("a", "2026-08-13T10:00:00.000Z"),
      Self.turn("b", "2026-08-14T10:00:00.000Z", from: "me"),
      Self.turn("c", "2026-08-14T11:00:00.000Z"),
      Self.turn("d", "2026-09-01T09:00:00.000Z", from: "me"),
    ].compactMap(WhatsAppTurn.init(turn:))
    let horizon = WireDate.parse("2026-08-14T00:00:00.000Z")!
    #expect(WhatsAppThreadLayout.horizonIndex(turns, horizon: horizon) == 1)
    #expect(WhatsAppThreadLayout.horizonIndex(turns, horizon: nil) == nil)
    #expect(WhatsAppThreadLayout.horizonIndex(turns, horizon: WireDate.parse("2026-01-01T00:00:00.000Z")) == 0)
    #expect(WhatsAppThreadLayout.horizonIndex(turns, horizon: WireDate.parse("2026-12-01T00:00:00.000Z")) == 4)

    let rows = WhatsAppThreadLayout.rows(turns, horizon: horizon, asOf: Self.asOf, calendar: Self.utc, isGroup: false)
    #expect(
      rows.map(\.id) == [
        "encrypted", "day.2026-08-13", "bubble.a", "horizon", "day.2026-08-14", "bubble.b", "bubble.c",
        "day.2026-09-01", "bubble.d",
      ])
    #expect(rows[3] == .horizon("History before Aug 14 is on your phone."))

    // Mid-day: the horizon goes between two turns of one day, no separator moved.
    let midday = WireDate.parse("2026-08-14T10:30:00.000Z")!
    let mid = WhatsAppThreadLayout.rows(turns, horizon: midday, asOf: Self.asOf, calendar: Self.utc, isGroup: false)
    #expect(mid.map(\.id)[4...6] == ["bubble.b", "horizon", "bubble.c"])

    // Every turn after it: at the top, under the end-to-end line.
    let early = WhatsAppThreadLayout.rows(
      turns, horizon: WireDate.parse("2026-01-01T00:00:00.000Z"), asOf: Self.asOf, calendar: Self.utc, isGroup: false)
    #expect(early.map(\.id).prefix(3) == ["encrypted", "horizon", "day.2026-08-13"])

    // No horizon: no line; no turns: the two lines alone.
    let none = WhatsAppThreadLayout.rows(turns, horizon: nil, asOf: Self.asOf, calendar: Self.utc, isGroup: false)
    #expect(none.contains { $0.id == "horizon" } == false)
    #expect(
      WhatsAppThreadLayout.rows([], horizon: horizon, asOf: Self.asOf, calendar: Self.utc, isGroup: false).map(\.id)
        == ["encrypted", "horizon"])
  }

  // MARK: head

  @Test("B1 03: the head's line for one to one, for a group, and an unnamed member by number")
  func headLines() {
    let one = WhatsAppThreadLayout.subline(
      isGroup: false, meta: WhatsAppThreadMeta(), handle: "+15550142001", clock: "12:00")
    #expect(one == "WhatsApp \u{00B7} +15550142001 \u{00B7} opened here 12:00 \u{00B7} no receipt sent, still unread on your phone")
    let group = WhatsAppThreadLayout.subline(
      isGroup: true, meta: WhatsAppThreadMeta(members: 6, admins: 2, adminOnly: true), handle: nil, clock: "12:00")
    #expect(group == "WhatsApp group \u{00B7} 6 members \u{00B7} only admins can send")
    #expect(WhatsAppThreadLayout.subline(isGroup: true, meta: WhatsAppThreadMeta(), handle: nil, clock: nil) == "WhatsApp")
    #expect(WhatsAppThreadLayout.memberName("+15550142903", resolved: nil) == "+15550142903 \u{00B7} no name yet")
    #expect(WhatsAppThreadLayout.memberName("+15550142903", resolved: "Rosa Quill") == "Rosa Quill")
    #expect(ProvisionalUI.whatsAppAdminOnlyLine(admins: 2) == "Only admins can send messages in this group. 2 admins.")
  }

  // MARK: tooth 2

  @Test("B1 03 tooth 2: no per-row channel tag in a single channel's scope; All keeps it")
  func noPerRowTag() {
    for scope in ShellModel.Scope.allCases where scope != .all {
      #expect(WhatsAppThreadLayout.showsChannelTag(scope) == false, "\(scope) draws a per-row tag")
    }
    #expect(WhatsAppThreadLayout.showsChannelTag(.all))
  }

  // MARK: tooth 3

  @Test("B1 03 tooth 3: board 03's colours are never green, the reaction fill is the tint")
  func noGreen() {
    #expect(WhatsAppLook.all.isEmpty == false)
    for rgb in WhatsAppLook.all {
      #expect(!TokensTests.isGreen(rgb), "green \(rgb) hue \(rgb.hue) saturation \(rgb.saturation)")
    }
    #expect(WhatsAppLook.reactionFill.rgb == Tokens.tint)
    #expect(WhatsAppLook.reactionFill.alpha == 0.12)
  }
}
