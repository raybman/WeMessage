import Foundation
import Testing
@testable import WeMessageKit

/// S4c: the queue's pure rules (plan 3.1, wireframe 17.G's mark legend).
/// A digit is items waiting, the baseline is clear and fresh, "!" is stale
/// and never a count, nothing is not connected, and ALL inherits the worst
/// tile.
@Suite("QueueRules")
struct QueueRulesTests {
  static let now = Date(timeIntervalSince1970: 1_788_264_042)  // 2026-09-01T12:00:42Z
  static let day: TimeInterval = 86_400

  static func item(_ ago: TimeInterval) -> QueueItem {
    QueueItem(threadGuid: "iMessage;-;+15550100001", channel: "imessage", reason: .pendingDraft, arrivedAt: now - ago)
  }

  @Test("the window holds items after now minus 14 days and up to now, and nothing else")
  func windowBounds() {
    let inside = [Self.item(0), Self.item(60), Self.item(13 * Self.day), Self.item(14 * Self.day - 1)]
    let outside = [Self.item(14 * Self.day), Self.item(30 * Self.day), Self.item(-1)]
    #expect(QueueRules.queueCount(items: inside, now: Self.now) == 4)
    #expect(QueueRules.queueCount(items: outside, now: Self.now) == 0)
    #expect(QueueRules.queueCount(items: inside + outside, now: Self.now) == 4)
    #expect(QueueWindow().days == 14)
    // A shorter window drops what the default keeps.
    #expect(QueueRules.queueCount(items: inside, now: Self.now, window: QueueWindow(days: 1)) == 2)
  }

  @Test("a tile's mark: nothing when not connected, ! when stale whatever it counted, else a digit or the baseline")
  func marks() {
    #expect(QueueRules.railMark(count: 4, fresh: true, connected: true) == .digit(4))
    #expect(QueueRules.railMark(count: 0, fresh: true, connected: true) == .baseline)
    #expect(QueueRules.railMark(count: 0, fresh: false, connected: true) == .stale)
    #expect(QueueRules.railMark(count: 0, fresh: true, connected: false) == .none)
    #expect(QueueRules.railMark(count: 7, fresh: false, connected: false) == .none)
  }

  @Test("a stale tile never shows a digit, for any count")
  func noDigitWhenStale() {
    for count in [0, 1, 4, 99] {
      #expect(QueueRules.railMark(count: count, fresh: false, connected: true) == .stale, "count \(count)")
    }
  }

  @Test("ALL inherits the worst tile: any stale tile makes it stale, else the digits sum, else clear")
  func allInheritsWorst() {
    #expect(QueueRules.allMark([.digit(4), .none, .none, .none]) == .digit(4))
    #expect(QueueRules.allMark([.digit(2), .digit(3), .baseline, .none]) == .digit(5))
    #expect(QueueRules.allMark([.baseline, .none, .baseline]) == .baseline)
    #expect(QueueRules.allMark([.digit(9), .stale, .baseline]) == .stale)
    #expect(QueueRules.allMark([.stale, .none]) == .stale)
    #expect(QueueRules.allMark([.none, .none, .none, .none]) == .none)
    #expect(QueueRules.allMark([]) == .none)
  }

  static func rich<T: Decodable>(_ file: String, _ type: T.Type) throws -> T {
    let data = try Data(contentsOf: try Repo.url("fixtures/scenarios/rich/responses/" + file))
    let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    let body = try JSONSerialization.data(withJSONObject: object?["body"] ?? [:])
    return try JSONDecoder().decode(T.self, from: body)
  }

  @Test("the rich scenario's queue: its four pending drafts, on their threads' channels, inside the window as of the last scan")
  func richQueue() throws {
    let drafts = try Self.rich("drafts.list.json", DraftsEnvelope.self).drafts
    let threads = try Self.rich("threads.list.json", ThreadsPage.self).threads
    let items = QueueRules.items(drafts: drafts, threads: threads)
    #expect(items.map(\.draftId) == ["drf-0101", "drf-0102", "drf-0103", "drf-0104"])
    #expect(items.allSatisfy { $0.reason == .pendingDraft && $0.channel == "imessage" })
    let scan = try #require(WireDate.parse("2026-09-01T12:00:42.000Z"))
    #expect(scan == Self.now)
    #expect(QueueRules.queueCount(items: items, now: scan) == 4)
    // Read against a clock a month on, the same queue is outside the window.
    #expect(QueueRules.queueCount(items: items, now: scan + 30 * Self.day) == 0)
  }

  @Test("one item per drafted thread (06.G): the newest draft carries it, held or acted drafts are left out")
  func oneItemPerThread() throws {
    let drafts = try Self.rich("drafts.list.json", DraftsEnvelope.self).drafts
    let threads = try Self.rich("threads.list.json", ThreadsPage.self).threads
    var second = try #require(drafts.first { $0.id == "drf-0103" })
    second.id = "drf-0199"
    second.createdAt = "2026-09-01T12:00:40.000Z"
    let items = QueueRules.items(drafts: drafts + [second], threads: threads)
    #expect(items.map(\.draftId) == ["drf-0101", "drf-0102", "drf-0199", "drf-0104"])
    #expect(Set(items.map(\.threadGuid)).count == items.count)
    let excluded = QueueRules.items(drafts: drafts + [second], threads: threads, excluding: ["drf-0199", "drf-0101"])
    #expect(excluded.map(\.draftId) == ["drf-0102", "drf-0103", "drf-0104"])
  }

  @Test("wire dates parse with and without fractional seconds, and garbage does not")
  func wireDates() {
    #expect(WireDate.parse("2026-09-01T12:00:42.000Z") == Self.now)
    #expect(WireDate.parse("2026-09-01T12:00:42Z") == Self.now)
    #expect(WireDate.parse("yesterday") == nil)
  }
}
