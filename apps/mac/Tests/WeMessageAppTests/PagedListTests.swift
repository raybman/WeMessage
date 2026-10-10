import Foundation
import Testing

@testable import WeMessageApp

/// v2 F1a: the pure paged list both lists page through. Append, prepend,
/// the refresh merge, de-duplication across pages, the prefetch threshold
/// and the one-page-in-flight rule.
@Suite("PagedList")
struct PagedListTests {
  struct Row: Equatable, Sendable {
    var id: String
    var v: Int = 0
  }

  static func rows(_ ids: String...) -> [Row] { ids.map { Row(id: $0) } }
  static func tail(_ ids: [String] = [], cursor: String? = nil) -> PagedList<Row, String> {
    PagedList(edge: .tail, items: ids.map { Row(id: $0) }, cursor: cursor, key: { $0.id })
  }
  static func head(_ ids: [String] = [], cursor: String? = nil) -> PagedList<Row, String> {
    PagedList(edge: .head, items: ids.map { Row(id: $0) }, cursor: cursor, key: { $0.id })
  }

  @Test("F1a: appendPage adds the older page after the items and takes its cursor; the last page clears it")
  func append() {
    var list = Self.tail(["a", "b"], cursor: "c1")
    do { let began = list.begin(); #expect(began) }
    list.appendPage(Self.rows("c", "d"), next: "c2")
    #expect(list.items.map(\.id) == ["a", "b", "c", "d"])
    #expect(list.cursor == "c2")
    #expect(!list.inFlight)
    do { let began = list.begin(); #expect(began) }
    list.appendPage(Self.rows("e"), next: nil)
    #expect(list.items.map(\.id) == ["a", "b", "c", "d", "e"])
    #expect(list.cursor == nil)
    // The last page: nothing more to ask for.
    do { let began = list.begin(); #expect(!began) }
    #expect(!list.shouldFetch(nearIndex: 4, threshold: 20))
  }

  @Test("F1a: prependPage puts older turns first, oldest at the top")
  func prepend() {
    var list = Self.head(["m3", "m4"], cursor: "b1")
    do { let began = list.begin(); #expect(began) }
    list.prependPage(Self.rows("m1", "m2"), next: nil)
    #expect(list.items.map(\.id) == ["m1", "m2", "m3", "m4"])
    #expect(list.cursor == nil)
    #expect(!list.inFlight)
  }

  @Test("F1a: a key on two pages is listed once; the newer copy wins and keeps its place")
  func dedup() {
    var list = PagedList<Row, String>(edge: .tail, items: [Row(id: "a"), Row(id: "b", v: 1)], cursor: "c1", key: { $0.id })
    _ = list.begin()
    list.appendPage([Row(id: "b", v: 2), Row(id: "c"), Row(id: "c", v: 9)], next: "c2")
    #expect(list.items.map(\.id) == ["a", "b", "c"])
    #expect(list.items[1].v == 2)
    #expect(list.items[2].v == 0)
    var turns = Self.head(["m2", "m3"], cursor: "b1")
    _ = turns.begin()
    turns.prependPage(Self.rows("m1", "m2"), next: nil)
    #expect(turns.items.map(\.id) == ["m1", "m2", "m3"])
    // A page that repeats itself on init is listed once too.
    #expect(Self.tail(["x", "x", "y"]).items.map(\.id) == ["x", "y"])
  }

  @Test("F1a: mergeHead replaces page 1's keys at the newest edge and keeps the opened tail and its cursor")
  func mergeHead() {
    var list = Self.tail(["a", "b", "c"], cursor: "c1")
    _ = list.begin()
    list.appendPage(Self.rows("d", "e"), next: "c2")
    // A refresh: "d" moved to the top, "z" is new, "a" is still there.
    list.mergeHead([Row(id: "d", v: 5), Row(id: "z"), Row(id: "a")], next: "fresh")
    #expect(list.items.map(\.id) == ["d", "z", "a", "b", "c", "e"])
    #expect(list.items[0].v == 5)
    #expect(list.cursor == "c2", "a refresh moved the cursor of a list already scrolled open")
    // Never paged past page 1: the refresh's cursor is the one to follow.
    var fresh = Self.tail(["a"], cursor: "c1")
    fresh.mergeHead(Self.rows("b", "a"), next: "c9")
    #expect(fresh.items.map(\.id) == ["b", "a"])
    #expect(fresh.cursor == "c9")
    // A transcript's newest page sits at the bottom; older turns stay above.
    var turns = Self.head(["m3", "m4"], cursor: "b1")
    _ = turns.begin()
    turns.prependPage(Self.rows("m1", "m2"), next: nil)
    turns.mergeHead(Self.rows("m3", "m4", "m5"), next: "b7")
    #expect(turns.items.map(\.id) == ["m1", "m2", "m3", "m4", "m5"])
    #expect(turns.cursor == nil)
  }

  @Test("F1a: shouldFetch is true within the threshold of the growing edge, with a cursor and nothing in flight")
  func threshold() {
    let ids = (0..<100).map { "t\($0)" }
    var list = Self.tail(ids, cursor: "c1")
    #expect(!list.shouldFetch(nearIndex: 0, threshold: 20))
    #expect(!list.shouldFetch(nearIndex: 79, threshold: 20))
    #expect(list.shouldFetch(nearIndex: 80, threshold: 20))
    #expect(list.shouldFetch(nearIndex: 99, threshold: 20))
    // Against the rows drawn, when a filter shows fewer than the items.
    #expect(list.shouldFetch(nearIndex: 9, of: 10, threshold: 20))
    #expect(!list.shouldFetch(nearIndex: -1, threshold: 20))
    let turns = Self.head(ids, cursor: "b1")
    #expect(turns.shouldFetch(nearIndex: 0, threshold: 20))
    #expect(turns.shouldFetch(nearIndex: 19, threshold: 20))
    #expect(!turns.shouldFetch(nearIndex: 20, threshold: 20))
    #expect(!turns.shouldFetch(nearIndex: 99, threshold: 20))
    _ = list.begin()
    #expect(!list.shouldFetch(nearIndex: 99, threshold: 20))
  }

  @Test("F1a: one page in flight per list; a failed page keeps the items and lets the next approach ask again")
  func inFlight() {
    var list = Self.tail(["a"], cursor: "c1")
    do { let began = list.begin(); #expect(began) }
    #expect(list.inFlight)
    do { let began = list.begin(); #expect(!began, "a second page was let in flight") }
    list.fail()
    #expect(!list.inFlight)
    #expect(list.items.map(\.id) == ["a"])
    #expect(list.cursor == "c1")
    do { let began = list.begin(); #expect(began) }
    // Nothing to ask for: an empty list without a cursor never begins.
    var empty = Self.tail()
    do { let began = empty.begin(); #expect(!began) }
  }
}
