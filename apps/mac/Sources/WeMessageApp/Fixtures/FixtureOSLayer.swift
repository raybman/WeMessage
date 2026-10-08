import Foundation
import WeMessageKit

/// Board 16's fixtures: nine waiting (three drafts, six messages) on the
/// synthetic people the other boards use, dated Tuesday 2026-09-01 16:42:07
/// in the runner's zone, so the stamp reads "Tue 16:42:07" anywhere.
enum FixtureOSLayer {
  static var t0: Date {
    let parts = DateComponents(year: 2026, month: 9, day: 1, hour: 16, minute: 42, second: 7)
    return Calendar.current.date(from: parts) ?? Date(timeIntervalSince1970: 0)
  }

  static func entry(
    _ id: String, _ name: String, _ channel: String, _ preview: String, _ kind: PopoverEntry.Kind, minutesAgo: Int,
    stream: Bool = false
  ) -> PopoverEntry {
    PopoverEntry(
      id: id, threadGuid: "fixture-" + id, name: name,
      channel: channel, preview: preview, kind: kind, stream: stream,
      arrivedAt: t0.addingTimeInterval(Double(-minutesAgo) * 60))
  }

  static var entries: [PopoverEntry] {
    [
      entry("d1", "Maya Chen", "imessage", "Can you send the deck before Thursday?", .draft, minutesAgo: 1),
      entry("d2", "Jordan Ellis", "email", "Re: invoice 1042, is the total right?", .draft, minutesAgo: 14),
      entry("d3", "Priya Raman", "linkedin", "Would you be open to a call next week?", .draft, minutesAgo: 74),
      entry("m1", "Sam Ortiz", "whatsapp", "Are we still on for dinner?", .message, minutesAgo: 4),
      entry("m2", "Lee Park", "imessage", "Did the package arrive?", .message, minutesAgo: 22),
      entry("m3", "Book club", "imessage", "Who is hosting on the 12th?", .message, minutesAgo: 47, stream: true),
      entry("m4", "Alex Kim", "email", "Quick question about the lease", .message, minutesAgo: 190),
      entry("m5", "Rosa Diaz", "whatsapp", "Can I borrow the ladder?", .message, minutesAgo: 1450),
      entry("m6", "Chris Lane", "linkedin", "Thanks for connecting. Hiring?", .message, minutesAgo: 4400),
    ]
  }

  static let liveSources = [
    SourceLine(channel: "iMessage", live: true, age: "4s ago"),
    SourceLine(channel: "WhatsApp", live: true, age: "2m ago"),
    SourceLine(channel: "LinkedIn", live: true, age: "1m ago"),
    SourceLine(channel: "Email", live: true, age: "30s ago"),
  ]

  static var healthy: PopoverInput {
    PopoverInput(
      snapshot: OSSnapshot(count: 9, fresh: true, connected: true, killed: false), stamp: OSText.stamp(t0),
      entries: entries, sources: liveSources, oldestSync: "1m ago")
  }

  static var degraded: PopoverInput {
    var sources = liveSources
    sources[1] = SourceLine(channel: "WhatsApp", live: false, age: "6h 12m ago")
    return PopoverInput(
      snapshot: OSSnapshot(count: 9, fresh: false, connected: true, killed: false), stamp: OSText.stamp(t0),
      entries: entries, sources: sources, oldestSync: "1m ago")
  }

  static var killed: PopoverInput {
    PopoverInput(
      snapshot: OSSnapshot(count: 9, fresh: true, connected: true, killed: true), stamp: OSText.stamp(t0),
      entries: entries, sources: liveSources, oldestSync: "1m ago", killedSince: "16:42:19")
  }

  /// One snapshot per extra state, for the glyph strip; twelve waiting, so
  /// the strip shows the menu bar's 9+ cap.
  static let states: [(StatusState, OSSnapshot)] = [
    (.idle, OSSnapshot(count: 0, fresh: true, connected: true, killed: false)),
    (.waiting, OSSnapshot(count: 12, fresh: true, connected: true, killed: false)),
    (.degraded, OSSnapshot(count: 9, fresh: false, connected: true, killed: false)),
    (.killed, OSSnapshot(count: 9, fresh: true, connected: true, killed: true)),
    (.disconnected, OSSnapshot(count: 9, fresh: true, connected: false, killed: false)),
  ]
}
