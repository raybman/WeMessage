import Foundation
import Testing
import WeMessageKit

@testable import WeMessageApp

/// v2 F1b and F1c: the sidebar and the transcript page through the daemon's
/// cursors. Three pages of threads, a failed page, a stale page, a refresh
/// after scrolling; older turns above, a chat switched mid-load, the start
/// of a conversation, a reload after paging. Synthetic data only.
@Suite("Paging")
@MainActor
struct PagingTests {
  // MARK: fixtures

  nonisolated static let asOf = "2026-09-01T12:00:43.000Z"

  nonisolated static func json(_ object: Any) throws -> Reply {
    Reply(
      status: 200, body: try JSONSerialization.data(withJSONObject: object),
      headers: ["Content-Type": "application/json"])
  }

  /// Thread n: newer threads have smaller n.
  nonisolated static func threadGuid(_ n: Int) -> String { "iMessage;-;+1555" + String(format: "%07d", n) }

  nonisolated static func summary(_ n: Int) -> [String: Any] {
    let minutes = 100_000 - n
    let at = Date(timeIntervalSince1970: 1_788_000_000 + Double(minutes) * 60)
    return [
      "chatGuid": threadGuid(n), "channel": "imessage", "title": "Test User \(n)", "isGroup": false,
      "lastLine": "line \(n)", "lastFromMe": false, "lastAt": WireDate.format(at),
    ]
  }

  nonisolated static func threadsPage(_ ns: Range<Int>, next: String?, total: Int = 250) throws -> Reply {
    try json(["threads": ns.map(summary), "nextCursor": next as Any? ?? NSNull(), "total": total, "asOf": asOf])
  }

  /// Turn n: older turns have smaller n.
  nonisolated static func turn(_ chat: String, _ n: Int) -> [String: Any] {
    let at = Date(timeIntervalSince1970: 1_788_000_000 + Double(n) * 60)
    return [
      "guid": "\(chat)-msg-\(n)", "from": n % 2 == 0 ? "me" : "them", "kind": "text", "text": "turn \(n)",
      "at": WireDate.format(at), "attachments": 0,
    ]
  }

  nonisolated static func turnsPage(_ chat: String, _ ns: Range<Int>, before: String?) throws -> Reply {
    try json([
      "chatGuid": chat, "channel": "imessage", "turns": ns.map { turn(chat, $0) },
      "nextBefore": before as Any? ?? NSNull(), "asOf": asOf,
    ])
  }

  nonisolated static func query(_ request: URLRequest) -> [String: String] {
    let items = request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.queryItems } ?? []
    return Dictionary(items.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
  }

  static func shell(_ transport: GatedTransport) -> ShellModel {
    ShellModel(client: GatewayClient(
      config: ClientConfig(environment: [:]),
      tokens: TokenSource(
        environment: [:], home: URL(fileURLWithPath: "/var/empty/wemessage-home"),
        read: { _ in Data(("wm_" + String(repeating: "a", count: 64)).utf8) }),
      transport: transport))
  }

  static func threadModel(_ transport: GatedTransport) -> ThreadModel {
    ThreadModel(client: GatewayClient(
      config: ClientConfig(environment: [:]),
      tokens: TokenSource(
        environment: [:], home: URL(fileURLWithPath: "/var/empty/wemessage-home"),
        read: { _ in Data(("wm_" + String(repeating: "a", count: 64)).utf8) }),
      transport: transport))
  }

  /// The common daemon: status and drafts from the rich scenario, the
  /// thread list from `threads(cursor)`.
  static func sidebar(
    gate: Gate? = nil, threads: @escaping @Sendable (String?) throws -> Reply
  ) throws -> GatedTransport {
    let status = try Reply.scenario("rich", "status.json")
    let drafts = try Reply.scenario("rich", "drafts.list.json")
    return GatedTransport { request in
      switch request.url?.path {
      case "/v1/status": return status
      case "/v1/drafts": return drafts
      case "/v1/threads":
        let cursor = query(request)["cursor"]
        if cursor != nil, let gate { await gate.wait() }
        return try threads(cursor)
      default: throw Unreachable()
      }
    }
  }

  /// Waits, without sleeping on a clock, until `transport` has seen a
  /// request matching `match`.
  static func waitFor(_ transport: GatedTransport, _ match: (URLRequest) -> Bool) async {
    for _ in 0..<10_000 {
      if transport.requests.contains(where: match) { return }
      await Task.yield()
    }
    Issue.record("the request never came")
  }

  static func cursorReads(_ t: GatedTransport) -> [String] {
    t.requests.filter { $0.url?.path == "/v1/threads" }.compactMap { query($0)["cursor"] }
  }

  // MARK: F1b, the sidebar

  @Test("F1b: three pages of threads, read one at a time as the end of the list is drawn, then nothing more")
  func threePages() async throws {
    let t = try Self.sidebar { cursor in
      switch cursor {
      case nil: try Self.threadsPage(0..<100, next: "o100")
      case "o100": try Self.threadsPage(100..<200, next: "o200")
      case "o200": try Self.threadsPage(200..<250, next: nil)
      default: throw Unreachable()
      }
    }
    let m = Self.shell(t)
    await m.refresh()
    #expect(m.threads?.threads.count == 100)
    #expect(m.rows.count == 100, "the rows drawn are not the threads read")
    #expect(m.threads?.nextCursor == "o100")
    // Page 1's read is unchanged: no cursor, no limit.
    let first = t.requests.first { $0.url?.path == "/v1/threads" }
    #expect(first.map(Self.query) == [:])

    // Far from the end: nothing is read.
    await m.threadRowAppeared(Self.threadGuid(10))
    await m.threadRowAppeared(Self.threadGuid(79))
    #expect(Self.cursorReads(t).isEmpty)
    // Within 20 rows of the end: the next page.
    await m.threadRowAppeared(Self.threadGuid(80))
    #expect(Self.cursorReads(t) == ["o100"])
    #expect(m.threads?.threads.count == 200)
    #expect(m.threads?.threads.map(\.chatGuid) == (0..<200).map(Self.threadGuid))
    #expect(m.threads?.nextCursor == "o200")
    #expect(m.threads?.asOf == Self.asOf)
    #expect(!m.loadingMoreThreads)
    // Row 150 of 200 is far again.
    await m.threadRowAppeared(Self.threadGuid(150))
    #expect(Self.cursorReads(t) == ["o100"])
    await m.threadRowAppeared(Self.threadGuid(199))
    #expect(Self.cursorReads(t) == ["o100", "o200"])
    #expect(m.threads?.threads.count == 250)
    #expect(m.threads?.nextCursor == nil)
    // The last page: the end of the list asks for nothing.
    await m.threadRowAppeared(Self.threadGuid(249))
    #expect(Self.cursorReads(t) == ["o100", "o200"])
  }

  @Test("F1b: a failed page keeps the list and its cursor; the next approach asks again")
  func failedPage() async throws {
    let fails = Counter()
    let t = try Self.sidebar { cursor in
      switch cursor {
      case nil: return try Self.threadsPage(0..<100, next: "o100")
      case "o100":
        if fails.next() == 0 { return Reply(status: 500, body: Data(#"{"error":"internal"}"#.utf8)) }
        return try Self.threadsPage(100..<150, next: nil)
      default: throw Unreachable()
      }
    }
    let m = Self.shell(t)
    await m.refresh()
    await m.threadRowAppeared(Self.threadGuid(99))
    #expect(Self.cursorReads(t) == ["o100"])
    #expect(m.threads?.threads.count == 100)
    #expect(m.threads?.nextCursor == "o100")
    #expect(!m.loadingMoreThreads, "a failed page stayed in flight")
    await m.threadRowAppeared(Self.threadGuid(99))
    #expect(Self.cursorReads(t) == ["o100", "o100"])
    #expect(m.threads?.threads.count == 150)
  }

  @Test("F1b: one page in flight; a page whose cursor a refresh replaced is dropped")
  func stalePage() async throws {
    let gate = Gate()
    let refreshed = Counter()
    let t = try Self.sidebar(gate: gate) { cursor in
      switch cursor {
      case nil:
        // The second read of page 1 (a refresh) answers with a new cursor.
        return refreshed.next() == 0
          ? try Self.threadsPage(0..<100, next: "o100") : try Self.threadsPage(0..<100, next: "o100b")
      case "o100": return try Self.threadsPage(100..<200, next: "o200")
      default: throw Unreachable()
      }
    }
    let m = Self.shell(t)
    await m.refresh()
    let paging = Task { await m.threadRowAppeared(Self.threadGuid(99)) }
    await Self.waitFor(t) { Self.query($0)["cursor"] == "o100" }
    #expect(m.loadingMoreThreads)
    // A second approach while the page is on its way reads nothing.
    await m.threadRowAppeared(Self.threadGuid(98))
    #expect(Self.cursorReads(t) == ["o100"])
    await m.refresh()
    #expect(m.threads?.nextCursor == "o100b")
    await gate.release()
    await paging.value
    #expect(m.threads?.threads.count == 100, "a page for a cursor the list no longer holds was appended")
    #expect(m.threads?.nextCursor == "o100b")
    #expect(!m.loadingMoreThreads)
  }

  @Test("F1b: a refresh after scrolling merges page 1 and keeps every older page read")
  func refreshKeepsTail() async throws {
    let refreshed = Counter()
    let t = try Self.sidebar { cursor in
      switch cursor {
      case nil:
        if refreshed.next() == 0 { return try Self.threadsPage(0..<100, next: "o100") }
        // Thread 150 came back to the top with a new line.
        var page = (0..<99).map(Self.summary)
        var moved = Self.summary(150)
        moved["lastLine"] = "back on top"
        page.insert(moved, at: 0)
        return try Self.json(["threads": page, "nextCursor": "o99", "total": 250, "asOf": Self.asOf])
      case "o100": return try Self.threadsPage(100..<200, next: "o200")
      default: throw Unreachable()
      }
    }
    let m = Self.shell(t)
    await m.refresh()
    await m.threadRowAppeared(Self.threadGuid(99))
    #expect(m.threads?.threads.count == 200)
    await m.refresh()
    let guids = m.threads?.threads.map(\.chatGuid) ?? []
    #expect(guids.count == 200, "a refresh collapsed the list read so far")
    #expect(guids.first == Self.threadGuid(150))
    #expect(m.threads?.threads.first?.lastLine == "back on top")
    #expect(Set(guids).count == guids.count, "a thread is listed twice")
    #expect(guids.last == Self.threadGuid(199))
    // The cursor stays the one the scrolled list was following.
    #expect(m.threads?.nextCursor == "o200")
  }

  // MARK: F1c, the transcript

  static let chatA = "iMessage;-;+15550000001"
  static let chatB = "iMessage;-;+15550000002"

  static func transcript(gate: Gate? = nil, _ read: @escaping @Sendable (String, String?) throws -> Reply)
    -> GatedTransport
  {
    GatedTransport { request in
      let path = request.url?.path ?? ""
      guard path.hasPrefix("/v1/threads/"), path.hasSuffix("/messages") else { throw Unreachable() }
      let chat = path.dropFirst("/v1/threads/".count).dropLast("/messages".count)
      let before = query(request)["before"]
      if before != nil, let gate { await gate.wait() }
      return try read(String(chat).removingPercentEncoding ?? String(chat), before)
    }
  }

  static func beforeReads(_ t: GatedTransport) -> [String] {
    t.requests.compactMap { query($0)["before"] }
  }

  @Test("F1c: older turns go above, the old top is the anchor, and the start of the conversation stops paging")
  func olderTurns() async throws {
    let t = Self.transcript { chat, before in
      switch before {
      case nil: try Self.turnsPage(chat, 300..<500, before: "b300")
      case "b300": try Self.turnsPage(chat, 100..<300, before: "b100")
      case "b100": try Self.turnsPage(chat, 0..<100, before: nil)
      default: throw Unreachable()
      }
    }
    let m = Self.threadModel(t)
    await m.open(Self.chatA)
    #expect(m.turns.count == 200)
    #expect(Self.query(t.requests[0]) == ["limit": "200"], "the first read changed")
    // Far from the top: nothing.
    await m.turnAppeared(Self.chatA + "-msg-450")
    #expect(Self.beforeReads(t).isEmpty)
    await m.turnAppeared(Self.chatA + "-msg-310")
    #expect(Self.beforeReads(t) == ["b300"])
    #expect(Self.query(t.requests[1])["limit"] == "200")
    #expect(m.turns.count == 400)
    #expect(m.turns.first?.guid == Self.chatA + "-msg-100")
    #expect(m.turns.last?.guid == Self.chatA + "-msg-499")
    #expect(m.anchorTurn == Self.chatA + "-msg-300")
    #expect(!m.loadingOlder)
    await m.turnAppeared(Self.chatA + "-msg-100")
    #expect(m.turns.count == 500)
    #expect(m.anchorTurn == Self.chatA + "-msg-100")
    guard case .loaded(let page) = m.load else {
      Issue.record("not loaded")
      return
    }
    #expect(page.nextBefore == nil)
    // The first turn of the conversation asks for nothing.
    await m.turnAppeared(Self.chatA + "-msg-0")
    #expect(Self.beforeReads(t) == ["b300", "b100"])
  }

  @Test("F1c: a page that lands after the chat was switched is dropped")
  func switchMidLoad() async throws {
    let gate = Gate()
    // Both chats' newest pages carry the same cursor, as two chats can.
    let t = Self.transcript(gate: gate) { chat, before in
      switch before {
      case nil: try Self.turnsPage(chat, 300..<310, before: "b300")
      case "b300": try Self.turnsPage(chat, 290..<300, before: nil)
      default: throw Unreachable()
      }
    }
    let m = Self.threadModel(t)
    await m.open(Self.chatA)
    let paging = Task { await m.turnAppeared(Self.chatA + "-msg-300") }
    await Self.waitFor(t) { Self.query($0)["before"] == "b300" }
    await m.open(Self.chatB)
    await gate.release()
    await paging.value
    #expect(m.guid == Self.chatB)
    #expect(m.turns.count == 10)
    #expect(m.turns.allSatisfy { $0.guid.hasPrefix(Self.chatB) }, "chat A's older turns landed in chat B")
    #expect(m.anchorTurn == nil)
    #expect(!m.loadingOlder)
  }

  @Test("F1c: a reload after paging merges the newest page below and keeps the older turns")
  func reloadKeepsOlder() async throws {
    let newer = Counter()
    let t = Self.transcript { chat, before in
      switch before {
      case nil:
        // The reload sees one new turn.
        newer.next() == 0
          ? try Self.turnsPage(chat, 300..<500, before: "b300") : try Self.turnsPage(chat, 301..<501, before: "b301")
      case "b300": try Self.turnsPage(chat, 100..<300, before: "b100")
      default: throw Unreachable()
      }
    }
    let m = Self.threadModel(t)
    await m.open(Self.chatA)
    await m.turnAppeared(Self.chatA + "-msg-300")
    #expect(m.turns.count == 400)
    await m.reload()
    #expect(m.turns.count == 401, "a reload collapsed the older turns")
    #expect(m.turns.first?.guid == Self.chatA + "-msg-100")
    #expect(m.turns.last?.guid == Self.chatA + "-msg-500")
    guard case .loaded(let page) = m.load else {
      Issue.record("not loaded")
      return
    }
    #expect(page.nextBefore == "b100", "a reload moved the cursor of a transcript already paged")
  }

  @Test("F1c: a failed older page keeps the transcript and lets the next approach ask again")
  func failedOlder() async throws {
    let fails = Counter()
    let t = Self.transcript { chat, before in
      switch before {
      case nil: return try Self.turnsPage(chat, 300..<310, before: "b300")
      case "b300":
        if fails.next() == 0 { return Reply(status: 500, body: Data(#"{"error":"internal"}"#.utf8)) }
        return try Self.turnsPage(chat, 290..<300, before: nil)
      default: throw Unreachable()
      }
    }
    let m = Self.threadModel(t)
    await m.open(Self.chatA)
    await m.turnAppeared(Self.chatA + "-msg-300")
    #expect(m.turns.count == 10)
    #expect(!m.loadingOlder)
    await m.turnAppeared(Self.chatA + "-msg-300")
    #expect(m.turns.count == 20)
    #expect(Self.beforeReads(t) == ["b300", "b300"])
  }
}

// MARK: support

/// A transport whose answers may wait: a page held until the test lets it
/// land.
final class GatedTransport: Transport, @unchecked Sendable {
  typealias Handler = @Sendable (URLRequest) async throws -> Reply
  private let lock = NSLock()
  private var recorded: [URLRequest] = []
  private let handler: Handler

  init(_ handler: @escaping Handler) { self.handler = handler }

  var requests: [URLRequest] { lock.withLock { recorded } }

  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    lock.withLock { recorded.append(request) }
    let reply = try await handler(request)
    return (reply.body, reply.response(for: request))
  }

  func stream(_ request: URLRequest) async throws -> (AsyncThrowingStream<Data, any Error>, HTTPURLResponse) {
    throw Unreachable()
  }
}

/// Holds every waiter until released.
actor Gate {
  private var open = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func wait() async {
    if open { return }
    await withCheckedContinuation { waiters.append($0) }
  }

  func release() {
    open = true
    for waiter in waiters { waiter.resume() }
    waiters = []
  }
}

/// 0, 1, 2, ... across calls.
final class Counter: @unchecked Sendable {
  private let lock = NSLock()
  private var n = 0
  func next() -> Int {
    lock.withLock {
      defer { n += 1 }
      return n
    }
  }
}
