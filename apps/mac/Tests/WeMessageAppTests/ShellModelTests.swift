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
}
