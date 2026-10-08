import Foundation
import Testing

@testable import WeMessageKit

/// v2 S4l, board 16: the extra's five states, the one shared count, and the
/// popover as words. The popover lists drafts first, then messages, each
/// oldest first, four at most; it prints "Cannot say" instead of a number
/// when a source is stale; under the kill switch it lists nothing.
@Suite("PopoverModel")
struct PopoverModelTests {
  static let t0 = Date(timeIntervalSince1970: 1_790_000_000)

  static func entry(_ id: String, _ kind: PopoverEntry.Kind, minutes: Int, stream: Bool = false, stale: Bool = false)
    -> PopoverEntry
  {
    PopoverEntry(
      id: id, threadGuid: "iMessage;-;+15555550\(id.count)", name: "Person \(id)", channel: "imessage",
      preview: "Inbound line \(id)", kind: kind, stream: stream, sourceStale: stale,
      arrivedAt: t0.addingTimeInterval(Double(minutes) * 60))
  }

  static let sources = [
    SourceLine(channel: "iMessage", live: true, age: "4s ago"),
    SourceLine(channel: "WhatsApp", live: true, age: "2m ago"),
    SourceLine(channel: "LinkedIn", live: true, age: "1m ago"),
    SourceLine(channel: "Email", live: true, age: "30s ago"),
  ]

  /// Nine waiting: three drafts and six messages, deliberately out of order.
  static let nine: [PopoverEntry] = [
    entry("m1", .message, minutes: 50), entry("d1", .draft, minutes: 40), entry("m2", .message, minutes: 5),
    entry("m3", .message, minutes: 30), entry("d2", .draft, minutes: 10), entry("m4", .message, minutes: 60),
    entry("d3", .draft, minutes: 20), entry("m5", .message, minutes: 1), entry("m6", .message, minutes: 2),
  ]

  static func input(_ snapshot: OSSnapshot, entries: [PopoverEntry] = nine, sources: [SourceLine] = sources)
    -> PopoverInput
  {
    PopoverInput(
      snapshot: snapshot, stamp: "Tue 16:42:07", entries: entries, sources: sources, oldestSync: "1m ago",
      killedSince: "16:42:19")
  }

  static let healthy = OSSnapshot(count: 9, fresh: true, connected: true, killed: false)

  // MARK: the extra

  @Test("five states, by precedence: kill, then connection, then freshness, then count")
  func fiveStates() {
    #expect(StatusState.allCases.count == 5)
    #expect(OSLayer.state(OSSnapshot(count: 0, fresh: true, connected: true, killed: false)) == .idle)
    #expect(OSLayer.state(Self.healthy) == .waiting)
    #expect(OSLayer.state(OSSnapshot(count: 9, fresh: false, connected: true, killed: false)) == .degraded)
    #expect(OSLayer.state(OSSnapshot(count: nil, fresh: true, connected: true, killed: false)) == .degraded)
    #expect(OSLayer.state(OSSnapshot(count: 9, fresh: false, connected: false, killed: false)) == .disconnected)
    #expect(OSLayer.state(OSSnapshot(count: 9, fresh: false, connected: false, killed: true)) == .killed)
  }

  @Test("the badge carries the state: digit capped at 9+, ! when degraded, none when idle, killed or disconnected")
  func glyphs() {
    #expect(OSLayer.glyph(OSSnapshot(count: 0, fresh: true, connected: true, killed: false)).badge == .none)
    #expect(OSLayer.glyph(OSSnapshot(count: 3, fresh: true, connected: true, killed: false)).badge == .count("3"))
    #expect(OSLayer.glyph(Self.healthy).badge == .count("9"))
    #expect(OSLayer.glyph(OSSnapshot(count: 10, fresh: true, connected: true, killed: false)).badge == .count("9+"))
    #expect(OSLayer.glyph(OSSnapshot(count: 142, fresh: true, connected: true, killed: false)).badge == .count("9+"))
    let degraded = OSLayer.glyph(OSSnapshot(count: 9, fresh: false, connected: true, killed: false))
    #expect(degraded.badge == .cannotSay && !degraded.slashed && !degraded.reducedAlpha)
    let killed = OSLayer.glyph(OSSnapshot(count: 9, fresh: true, connected: true, killed: true))
    #expect(killed.badge == .none && killed.slashed && !killed.reducedAlpha)
    let gone = OSLayer.glyph(OSSnapshot(count: 9, fresh: true, connected: false, killed: false))
    #expect(gone.badge == .none && !gone.slashed && gone.reducedAlpha)
    #expect(killed.spoken.contains("kill switch on"))
    #expect(degraded.spoken.contains("cannot say"))
  }

  @Test("the Dock shows the true number, uncapped, and is suppressed in Triage, degraded, disconnected, killed and at zero")
  func dock() {
    #expect(OSLayer.dockBadge(Self.healthy) == "9")
    #expect(OSLayer.dockBadge(OSSnapshot(count: 142, fresh: true, connected: true, killed: false)) == "142")
    #expect(OSLayer.dockBadge(OSSnapshot(count: 9, fresh: true, connected: true, killed: false, triage: true)) == nil)
    #expect(OSLayer.dockBadge(OSSnapshot(count: 9, fresh: false, connected: true, killed: false)) == nil)
    #expect(OSLayer.dockBadge(OSSnapshot(count: 9, fresh: true, connected: false, killed: false)) == nil)
    #expect(OSLayer.dockBadge(OSSnapshot(count: 9, fresh: true, connected: true, killed: true)) == nil)
    #expect(OSLayer.dockBadge(OSSnapshot(count: 0, fresh: true, connected: true, killed: false)) == nil)
    // The extra and the Dock never disagree: whenever the Dock is blank,
    // the extra prints no digit either, except in Triage, where the extra
    // keeps nothing to say and prints no digit too.
    let triage = OSLayer.glyph(OSSnapshot(count: 9, fresh: true, connected: true, killed: false, triage: true))
    #expect(triage.badge == .none)
  }

  // MARK: the popover

  @Test("oldest four: drafts before messages, each oldest first, and the rest as a sentence")
  func oldestFour() {
    let content = PopoverRules.content(Self.input(Self.healthy))
    #expect(content.mode == .healthy)
    #expect(content.rows.map(\.entry.id) == ["d2", "d3", "d1", "m5"])
    #expect(content.rows.count == PopoverRules.maxRows)
    #expect(content.more == "5 more in the app.")
    #expect(PopoverRules.shown(Array(Self.nine.prefix(2))).map(\.id) == ["d1", "m1"])
    let three = PopoverRules.content(Self.input(OSSnapshot(count: 3, fresh: true, connected: true, killed: false), entries: Array(Self.nine.prefix(3))))
    #expect(three.more == nil)
  }

  @Test("drafts before DMs even when every DM is older")
  func draftsFirst() {
    let entries = [Self.entry("old", .message, minutes: -600), Self.entry("new", .draft, minutes: 0)]
    #expect(PopoverRules.shown(entries).map(\.id) == ["new", "old"])
  }

  @Test("healthy header: the dated counter and its one line")
  func header() {
    let content = PopoverRules.content(Self.input(Self.healthy))
    #expect(content.title == "9 left")
    #expect(content.stamp == "Tue 16:42:07")
    #expect(content.line == "3 drafts ready \u{00B7} 6 unanswered \u{00B7} 4 sources synced, oldest 1m ago")
    #expect(content.sources.isEmpty && content.notes.isEmpty)
  }

  @Test("header degrades: Cannot say, no number, the freshness table and the warning, no rows")
  func degrades() {
    var sources = Self.sources
    sources[1] = SourceLine(channel: "WhatsApp", live: false, age: "6h 12m ago")
    let content = PopoverRules.content(
      Self.input(OSSnapshot(count: 9, fresh: false, connected: true, killed: false), sources: sources))
    #expect(content.mode == .degraded)
    #expect(content.title == "Cannot say")
    #expect(content.line == "3 of 4 sources synced. No count shown.")
    #expect(!content.title.contains("9") && !content.line.contains("9"))
    #expect(content.rows.isEmpty && content.more == nil)
    #expect(content.sources.map(\.printed) == [
      "IMESSAGE live \u{00B7} 4s ago", "WHATSAPP STALE \u{00B7} 6h 12m ago", "LINKEDIN live \u{00B7} 1m ago",
      "EMAIL live \u{00B7} 30s ago",
    ])
    #expect(content.notes.first == "WhatsApp has not synced in 6h 12m. You may be missing messages.")
  }

  @Test("killed: no draft rows, the held count, and release is in the app")
  func killed() {
    let content = PopoverRules.content(Self.input(OSSnapshot(count: 9, fresh: true, connected: true, killed: true)))
    #expect(content.mode == .killed)
    #expect(content.rows.isEmpty)
    #expect(content.line == "Kill switch on since 16:42:19. Nothing can send.")
    #expect(content.notes == ["9 held. Reading continues on all four channels.", "Open WeMessage to release"])
  }

  @Test("row verbs: Done, Snooze, Mute, Open; no Mute on Stream; Open only when stale; never Approve or Reply")
  func verbs() {
    #expect(PopoverRules.verbs(for: Self.entry("a", .message, minutes: 0)) == [.done, .snooze, .mute, .open])
    #expect(PopoverRules.verbs(for: Self.entry("a", .message, minutes: 0, stream: true)) == [.done, .snooze, .open])
    #expect(PopoverRules.verbs(for: Self.entry("a", .draft, minutes: 0, stale: true)) == [.open])
    #expect(PopoverVerb.allCases.map(\.hint) == ["E", "H", "M", "\u{21B5}"])
    #expect(!PopoverVerb.allCases.map(\.title).contains("Approve"))
    #expect(!PopoverVerb.allCases.map(\.title).contains("Reply"))
  }

  @Test("the handoff lands on the thread with the list focused and the lens unchanged")
  func handoff() {
    let entry = PopoverEntry(
      id: "itm-7", threadGuid: "+15555550123", name: "A", channel: "whatsapp", preview: "p", kind: .message,
      arrivedAt: Self.t0)
    let hand = Handoff.open(entry)
    #expect(hand.url == "wemessage://thread/wa/+15555550123?item=itm-7")
    #expect(hand.focus == .list)
    #expect(hand.changesLens == false)
    #expect(Handoff.open(entry, reply: true).focus == .composer)
  }

  @Test("the kill confirm states four facts in order, with the held draft count")
  func killConfirm() {
    let facts = KillConfirmText.facts(held: 3)
    #expect(facts.map(\.label) == ["Stops", "Holds", "Keeps", "Tells"])
    #expect(facts[1].text == "3 drafts. They are kept, not discarded.")
    #expect(KillConfirmText.facts(held: 1)[1].text == "1 draft. They are kept, not discarded.")
  }
}
