import Foundation

/// v2 F1: one list read a page at a time (the sidebar's threads, a
/// transcript's turns). Pure: it holds the items, the daemon's cursor for
/// the next page and whether a page is on its way; the models that own it
/// do the reading. Nothing here calls a client.
///
/// A list grows at one edge. The thread list grows at its tail (older
/// chats below), a transcript at its head (older turns above). The page a
/// refresh re-reads, "page 1", is always the opposite edge: the newest.
struct PagedList<Item: Sendable, Key: Hashable & Sendable>: Sendable {
  enum Edge: Sendable {
    /// Older pages go after the items (the thread list).
    case tail
    /// Older pages go before the items (a transcript).
    case head
  }

  private(set) var items: [Item]
  /// The daemon's cursor for the next older page; nil when there is none.
  private(set) var cursor: String?
  /// True from `begin()` until the page lands or fails.
  private(set) var inFlight = false
  /// Pages folded in since the list was last read from page 1.
  private(set) var pages: Int
  let edge: Edge
  let key: @Sendable (Item) -> Key

  init(edge: Edge, items: [Item] = [], cursor: String? = nil, key: @escaping @Sendable (Item) -> Key) {
    self.edge = edge
    self.key = key
    self.items = []
    self.cursor = cursor
    self.pages = items.isEmpty && cursor == nil ? 0 : 1
    self.items = Self.unique(items, key: key)
  }

  /// Claims the one page a list may have in flight. False when one is
  /// already on its way or there is nothing more to ask for.
  mutating func begin() -> Bool {
    guard cursor != nil, !inFlight else { return false }
    inFlight = true
    return true
  }

  /// A failed page: what is shown stays, and the next approach asks again.
  mutating func fail() {
    inFlight = false
  }

  /// The next older page, after the items (the thread list). A key already
  /// listed is refreshed in place with the newer copy and not listed twice.
  mutating func appendPage(_ page: [Item], next: String?) {
    let fresh = fold(page)
    items.append(contentsOf: fresh)
    land(next)
  }

  /// The next older page, before the items (a transcript): older turns
  /// go first. A key already listed keeps its place.
  mutating func prependPage(_ page: [Item], next: String?) {
    let fresh = fold(page)
    items.insert(contentsOf: fresh, at: 0)
    land(next)
  }

  /// A refresh re-read page 1: its items replace their keys and sit at the
  /// newest edge; every item it does not hold (the older pages the user
  /// already opened) is kept. The cursor moves only when nothing past
  /// page 1 was ever read, so a refresh never collapses an opened list.
  mutating func mergeHead(_ page: [Item], next: String?) {
    let head = Self.unique(page, key: key)
    let keys = Set(head.map(key))
    let kept = items.filter { !keys.contains(key($0)) }
    switch edge {
    case .tail: items = head + kept
    case .head: items = kept + head
    }
    if pages <= 1 { cursor = next }
    pages = max(pages, 1)
  }

  /// True when `index` (of `count` rows drawn, the items by default) is
  /// within `threshold` rows of the growing edge, a cursor is set and no
  /// page is in flight.
  func shouldFetch(nearIndex index: Int, of count: Int? = nil, threshold: Int) -> Bool {
    guard cursor != nil, !inFlight, index >= 0 else { return false }
    let total = count ?? items.count
    let distance = edge == .tail ? total - 1 - index : index
    return distance < threshold
  }

  // MARK: private

  /// Refreshes listed keys in place; returns the page's new items, once each.
  private mutating func fold(_ page: [Item]) -> [Item] {
    var at: [Key: Int] = [:]
    for (i, item) in items.enumerated() { at[key(item)] = i }
    var fresh: [Item] = []
    var seen = Set<Key>()
    for item in page {
      let k = key(item)
      guard seen.insert(k).inserted else { continue }
      if let i = at[k] { items[i] = item } else { fresh.append(item) }
    }
    return fresh
  }

  private mutating func land(_ next: String?) {
    cursor = next
    inFlight = false
    pages += 1
  }

  private static func unique(_ page: [Item], key: (Item) -> Key) -> [Item] {
    var seen = Set<Key>()
    return page.filter { seen.insert(key($0)).inserted }
  }
}
