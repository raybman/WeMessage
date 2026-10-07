import Foundation
import Testing
import WeMessageKit

@testable import WeMessageApp

/// M1-M9 (plan §4.4): the connection line is a pure reducer over the event
/// stream's status, and "reconnecting" is only ever said about a connection
/// the window actually had (P0-2). M10-M11 drive start() over a fake
/// transport: the first read decides connected or down, and a daemon that
/// was never there stays "not reachable" while the stream keeps retrying.
@Suite("ShellModel")
@MainActor
struct ShellModelTests {
  static func model(_ connection: ShellModel.Connection = .idle) -> ShellModel {
    let m = ShellModel(client: testClient(FakeTransport { _ in throw Unreachable() }))
    m.connection = connection
    return m
  }

  @Test("M1: connected from idle says the generic state")
  func connectedFromIdle() {
    let m = Self.model()
    m.apply(.status(.connected))
    #expect(m.connection == .connected(state: "connected"))
  }

  @Test("M1b: connected keeps a state the status read already knew")
  func connectedKeepsState() {
    let m = Self.model(.connected(state: "fully-connected"))
    m.apply(.status(.connected))
    #expect(m.connection == .connected(state: "fully-connected"))
  }

  @Test("M2: reconnecting after a connection says the attempt")
  func reconnectingFromConnected() {
    let m = Self.model(.connected(state: "x"))
    m.apply(.status(.reconnecting(attempt: 3)))
    #expect(m.connection == .reconnecting(attempt: 3))
  }

  @Test("M3: down carries its reason")
  func down() {
    let m = Self.model(.connected(state: "x"))
    m.apply(.status(.down(reason: "token-rejected")))
    #expect(m.connection == .down(reason: "token-rejected"))
  }

  @Test("M4: the line is the D-UI-3 words for every case")
  func lines() {
    #expect(Self.model(.idle).connectionLine == ProvisionalUI.idleLine)
    #expect(
      Self.model(.connected(state: "fully-connected")).connectionLine
        == ProvisionalUI.connectedLine(state: "fully-connected"))
    #expect(Self.model(.reconnecting(attempt: 2)).connectionLine == ProvisionalUI.reconnectingLine(attempt: 2))
    #expect(Self.model(.down(reason: "unreachable")).connectionLine == ProvisionalUI.downLine)
    #expect(Self.model(.down(reason: "token-rejected")).connectionLine == ProvisionalUI.downLine)
  }

  @Test("M5: a frame or a response leaves the connection alone")
  func nonStatus() {
    let m = Self.model(.connected(state: "x"))
    m.apply(.response(.drafts([])))
    m.apply(.frame(.snapshot(seq: 1, at: "t", missed: 0, drafts: [])))
    #expect(m.connection == .connected(state: "x"))
  }

  @Test("M6 (P0-2): reconnecting while down stays down")
  func reconnectingWhileDown() {
    let m = Self.model(.down(reason: "unreachable"))
    m.apply(.status(.reconnecting(attempt: 1)))
    #expect(m.connection == .down(reason: "unreachable"))
  }

  @Test("M7 (P0-2): reconnecting before any connection is down, unreachable")
  func reconnectingFromIdle() {
    let m = Self.model(.idle)
    m.apply(.status(.reconnecting(attempt: 1)))
    #expect(m.connection == .down(reason: "unreachable"))
  }

  @Test("M8: reconnecting follows reconnecting")
  func reconnectingFollows() {
    let m = Self.model(.reconnecting(attempt: 1))
    m.apply(.status(.reconnecting(attempt: 2)))
    #expect(m.connection == .reconnecting(attempt: 2))
  }

  @Test("M9: a connection recovers from down")
  func recovers() {
    let m = Self.model(.down(reason: "unreachable"))
    m.apply(.status(.connected))
    #expect(m.connection == .connected(state: "connected"))
  }

  @Test("M12: the rail's scopes carry their full names and cmd-1..5 in rail order")
  func scopeNamesAndDigits() {
    #expect(ShellModel.Scope.allCases.map(\.fullLabel) == ["All channels", "iMessage", "WhatsApp", "LinkedIn", "Email"])
    #expect(ShellModel.Scope.allCases.map(\.shortcutDigit) == ["1", "2", "3", "4", "5"])
  }

  /// Polls the model until `done` or two seconds pass.
  static func settle(_ m: ShellModel, until done: (ShellModel.Connection) -> Bool) async {
    for _ in 0..<200 {
      if done(m.connection) { return }
      try? await Task.sleep(for: .milliseconds(10))
    }
  }

  @Test("M10: start() reads status, says its connectionState, and the stream's greeting keeps it")
  func startConnected() async throws {
    let status = try Reply.golden("responses/status.json")
    let drafts = try Reply.golden("responses/drafts.list.empty.json")
    let sse = try Reply.sse("greeting.txt")
    let transport = FakeTransport { request in
      switch request.url?.path {
      case "/v1/status": return status
      case "/v1/drafts": return drafts
      case "/v1/events/sse": return sse
      default: throw Unreachable()
      }
    }
    let m = ShellModel(client: testClient(transport))
    m.start()
    m.start()  // idempotent: one task
    await Self.settle(m) { _ in transport.requests.contains { $0.url?.path == "/v1/drafts" } }
    #expect(m.connection == .connected(state: "fully-connected"))
    #expect(m.connectionLine.contains("fully-connected"))
    #expect(transport.requests.filter { $0.url?.path == "/v1/status" }.count == 1)
    m.stop()
  }

  @Test("M11 (P0-2): with nothing listening the line says down and stays down while the stream retries")
  func startUnreachable() async throws {
    let transport = FakeTransport { _ in throw Unreachable() }
    let m = ShellModel(client: testClient(transport))
    m.start()
    await Self.settle(m) { $0 != .idle }
    #expect(m.connection == .down(reason: "unreachable"))
    // Long enough for the stream to fail and send its first reconnecting.
    await Self.settle(m) { _ in transport.requests.filter { $0.url?.path == "/v1/events/sse" }.count >= 2 }
    #expect(transport.requests.filter { $0.url?.path == "/v1/events/sse" }.count >= 2)
    #expect(m.connection == .down(reason: "unreachable"))
    #expect(m.connectionLine == ProvisionalUI.downLine)
    m.stop()
  }

  // MARK: S4c, board 01

  /// A transport that serves fixtures/scenarios/<name> for status, threads
  /// and drafts, and a stream that greets and stays open.
  static func scenarioTransport(_ name: String) throws -> FakeTransport {
    let status = try Reply.scenario(name, "status.json")
    let threads = try Reply.scenario(name, "threads.list.json")
    let drafts = try Reply.scenario(name, "drafts.list.json")
    let sse = try Reply.sse("greeting.txt")
    return FakeTransport { request in
      switch request.url?.path {
      case "/v1/status": return status
      case "/v1/threads": return threads
      case "/v1/drafts": return drafts
      case "/v1/events/sse": return sse
      default: throw Unreachable()
      }
    }
  }

  static func decode<T: Decodable>(_ reply: Reply, _ type: T.Type) throws -> T {
    try JSONDecoder().decode(T.self, from: reply.body)
  }

  /// The board a scenario folds to, straight from its fixtures.
  static func board(_ name: String) throws -> (ShellBoard, ThreadsPage) {
    let status = try decode(Reply.scenario(name, "status.json"), StatusPayload.self)
    let threads = try decode(Reply.scenario(name, "threads.list.json"), ThreadsPage.self)
    let drafts = try decode(Reply.scenario(name, "drafts.list.json"), DraftsEnvelope.self).drafts
    return (ShellBoard.fold(status: status, threads: threads, drafts: drafts, window: QueueWindow()), threads)
  }

  static let utc = TimeZone(identifier: "UTC")!

  @Test("countsFoldFromStatus: start() reads status, threads and drafts, and the board says 4 waiting on iMessage and on ALL as of the last scan")
  func countsFoldFromStatus() async throws {
    let transport = try Self.scenarioTransport("rich")
    let m = ShellModel(client: testClient(transport))
    m.start()
    await Self.settle(m) { _ in m.state.queue.count == 5 && m.threads != nil }
    #expect(m.connection == .connected(state: "fully-connected"))
    let board = m.board
    #expect(board.mark(.imessage) == .digit(4))
    #expect(board.mark(.all) == .digit(4))
    for scope in [ShellModel.Scope.whatsapp, .linkedin, .email] {
      #expect(board.mark(scope) == RailMark.none, "\(scope) is not connected and says nothing")
      #expect(board.counter(scope) == .hidden)
    }
    let scan = try #require(WireDate.parse("2026-09-01T12:00:42.000Z"))
    #expect(board.counter(.all) == .left(4, asOf: scan))
    #expect(ShellText.counter(board.counter(.all), channel: "iMessage", zone: Self.utc) == "4 left as of 12:00:42")
    #expect(board.needsYou(.all) == 4)
    #expect(m.killSwitch == false)
    #expect(m.rows.count == 8)
    m.lens = .needsYou
    #expect(m.rows.map(\.chatGuid) == ["iMessage;-;+15550100001", "iMessage;+;chat5550100103", "SMS;-;+15550100004", "iMessage;-;+15550100007"])
    m.scope = .whatsapp
    #expect(m.rows.isEmpty)
    m.stop()
  }

  @Test("empty-earned: the queue is empty and the channel fresh, so iMessage and ALL show the clear baseline and CLEAR with the time")
  func clearWhenEarned() throws {
    let (board, _) = try Self.board("empty-earned")
    #expect(board.mark(.imessage) == .baseline)
    #expect(board.mark(.all) == .baseline)
    #expect(ShellText.counter(board.counter(.all), channel: "iMessage", zone: Self.utc) == "Clear 12:00:42")
    #expect(board.needsYou(.all) == nil)
  }

  @Test("degraded: a read-only daemon is stale, so iMessage and ALL show !, the counter says cannot say, and no total appears anywhere")
  func noTotalWhileDegraded() throws {
    let (board, _) = try Self.board("degraded")
    #expect(board.mark(.imessage) == .stale)
    #expect(board.mark(.all) == .stale)
    #expect(board.needsYou(.all) == nil)
    #expect(board.needsYou(.imessage) == nil)
    let scan = try #require(WireDate.parse("2026-09-01T12:00:42.000Z"))
    #expect(board.counter(.all) == .cannotSay(staleSince: scan))
    let line = try #require(ShellText.counter(board.counter(.all), channel: "iMessage", zone: Self.utc))
    #expect(line.hasPrefix("Cannot say"))
    #expect(line == "Cannot say, " + ProvisionalUI.cannotSayDetail(channel: "iMessage", staleSince: "12:00:42"))
    // The four drafts are still there; the number is withheld, not zero.
    #expect(board.queue.count == 4)
    #expect(!line.contains("left"))
    let digits = line.replacingOccurrences(of: "12:00:42", with: "").filter { $0.isNumber }
    #expect(digits.isEmpty)
  }

  @Test("quiet: a fresh install that has never scanned is stale, never clear, and its reason says it has not been read")
  func quietNeverScanned() throws {
    let (board, threads) = try Self.board("quiet")
    #expect(threads.threads.isEmpty)
    #expect(board.mark(.imessage) == .stale)
    #expect(board.mark(.all) == .stale)
    #expect(board.counter(.all) == .cannotSay(staleSince: nil))
    #expect(
      ShellText.counter(board.counter(.all), channel: "iMessage", zone: Self.utc)
        == "Cannot say, " + ProvisionalUI.cannotSayDetail(channel: "iMessage", staleSince: nil))
  }

  @Test("kill: the chip reads the status's kill switch, and the counts are unchanged")
  func killReadsStatus() async throws {
    let transport = try Self.scenarioTransport("kill")
    let m = ShellModel(client: testClient(transport))
    m.start()
    await Self.settle(m) { _ in m.state.queue.count == 5 && m.threads != nil }
    #expect(m.killSwitch == true)
    #expect(m.board.mark(.all) == .digit(4))
    // Already on: engaging again asks the daemon for nothing.
    let before = transport.requests.count
    await m.engageKillSwitch()
    #expect(transport.requests.count == before)
    m.stop()
  }

  @Test("engaging the kill switch posts the kill-switch toggle on, re-reads status, and never touches the send route")
  func engageKill() async throws {
    let status = try Reply.scenario("rich", "status.json")
    let toggled = try Reply.golden("responses/toggles.killswitch.json")
    let transport = FakeTransport { request in
      switch request.url?.path {
      case "/v1/status": return status
      case "/v1/toggles/kill-switch": return toggled
      default: throw Unreachable()
      }
    }
    let m = ShellModel(client: testClient(transport))
    await m.refresh()
    await m.engageKillSwitch()
    let toggles = transport.requests.filter { $0.url?.path == "/v1/toggles/kill-switch" }
    #expect(toggles.count == 1)
    #expect(toggles.first?.httpMethod == "POST")
    let body = toggles.first?.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    #expect(body?["on"] as? Bool == true)
    #expect(transport.requests.allSatisfy { $0.url?.path != "/v1/send" })
  }

  @Test("the wall clock never ages the queue out: the fold's clock is the last scan, else the thread list's asOf")
  func queueClockIsTheData() throws {
    let (board, _) = try Self.board("rich")
    #expect(board.asOf == WireDate.parse("2026-09-01T12:00:42.000Z"))
    let threads = try Self.decode(Reply.scenario("rich", "threads.list.json"), ThreadsPage.self)
    let drafts = try Self.decode(Reply.scenario("rich", "drafts.list.json"), DraftsEnvelope.self).drafts
    let noStatus = ShellBoard.fold(status: nil, threads: threads, drafts: drafts, window: QueueWindow())
    #expect(noStatus.asOf == WireDate.parse(threads.asOf))
    #expect(noStatus.mark(.imessage) == RailMark.none, "no status: not connected, says nothing")
    #expect(noStatus.mark(.all) == RailMark.none)
  }

  @Test("row text: time against the list's asOf, initials, and the You: prefix")
  func rowText() throws {
    let asOf = WireDate.parse("2026-09-01T12:00:43.000Z")
    #expect(ShellText.rowTime("2026-09-01T11:58:00.000Z", asOf: asOf, zone: Self.utc) == "11:58")
    #expect(ShellText.rowTime("2026-09-01T09:05:00.000Z", asOf: asOf, zone: Self.utc) == "9:05")
    #expect(ShellText.rowTime("2026-08-31T18:20:00.000Z", asOf: asOf, zone: Self.utc) == "Yest")
    #expect(ShellText.rowTime("2026-08-29T16:45:00.000Z", asOf: asOf, zone: Self.utc) == "Sat")
    #expect(ShellText.rowTime("2026-08-01T16:45:00.000Z", asOf: asOf, zone: Self.utc) == "8/1")
    #expect(ShellText.initials("Maya Okafor") == "MO")
    #expect(ShellText.initials("Saturday hike") == "SH")
    #expect(ShellText.initials("Flat 4B") == "F")
    #expect(ShellText.initials("+15550100007") == "")
    let (_, threads) = try Self.board("rich")
    let sam = try #require(threads.threads.first { $0.lastFromMe })
    #expect(ShellText.preview(sam) == "You: " + (sam.lastLine ?? ""))
    let daniel = try #require(threads.threads.first { $0.lastLine == nil })
    #expect(ShellText.preview(daniel) == nil)
  }
}
