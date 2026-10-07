import Foundation
import Testing
import WeMessageKit

@testable import WeMessageApp

/// Board 02's transcript (plan 1.2, S4d): grouping stride 4/8, the max
/// width rule, the squared tail corner, day separators measured from the
/// page's as-of, group sender names, and the model's one read per selection.
@Suite("ThreadModel")
@MainActor
struct ThreadModelTests {
  static var utc: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    return calendar
  }

  static func page(_ name: String) throws -> ThreadMessagesPage {
    let reply = try Reply.scenario("rich", "threads.messages." + name + ".json")
    return try JSONDecoder().decode(ThreadMessagesPage.self, from: reply.body)
  }

  static func bubbles(_ rows: [TranscriptLayout.Row]) -> [TranscriptLayout.Bubble] {
    rows.compactMap { if case .bubble(let b) = $0 { b } else { nil } }
  }

  static let asOf = WireDate.parse("2026-09-01T12:00:43.000Z")!

  @Test("S4 02: 4 pt between one sender's turns, 8 pt where the sender changes, 0 under a day separator")
  func stride() throws {
    let daniel = try Self.page("daniel")
    let rows = TranscriptLayout.rows(MessageTurn.turns(daniel), asOf: Self.asOf, calendar: Self.utc, isGroup: false)
    #expect(rows.first == .day(id: "2026-09-01", label: "Today"))
    let b = Self.bubbles(rows)
    // me, them, them.
    #expect(b.map(\.gap) == [0, 8, 4])
    #expect(b.map(\.continuesRun) == [false, false, true])
    #expect(b.map(\.showsTime) == [true, true, false])
    #expect(b.allSatisfy { $0.senderName == nil }, "a one-to-one chat named a sender")
  }

  @Test("S4 02: radius 17, the tail corner squared to 5 on a turn that continues a run, on the sender's side")
  func corners() {
    let first = TranscriptLayout.corners(.inbound, continuesRun: false)
    #expect(first == .init(topLeading: 17, topTrailing: 17, bottomLeading: 17, bottomTrailing: 17))
    let inbound = TranscriptLayout.corners(.inbound, continuesRun: true)
    #expect(inbound == .init(topLeading: 17, topTrailing: 17, bottomLeading: 5, bottomTrailing: 17))
    let outbound = TranscriptLayout.corners(.outbound, continuesRun: true)
    #expect(outbound == .init(topLeading: 17, topTrailing: 17, bottomLeading: 17, bottomTrailing: 5))
  }

  @Test("S4 02: a bubble is at most min(64% of the row, 56ch)")
  func maxWidth() {
    // The CI pane: 1024 - 58 - 300 - two hairlines = 665 pt, row 641 pt.
    #expect(abs(TranscriptLayout.maxBubbleWidth(paneWidth: 665) - 0.64 * 641) < 0.001)
    // A wide pane is capped by 56ch.
    #expect(TranscriptLayout.maxBubbleWidth(paneWidth: 2000) == 56 * TranscriptLayout.characterWidth)
    #expect(TranscriptLayout.maxBubbleWidth(paneWidth: 0) == 0)
  }

  @Test("S4 02 / D-UI-31: a separator at each new day, labelled from the page's as-of, ids yyyy-mm-dd")
  func days() throws {
    let flat = try Self.page("flat")
    let rows = TranscriptLayout.rows(MessageTurn.turns(flat), asOf: Self.asOf, calendar: Self.utc, isGroup: true)
    let days = rows.compactMap { if case .day(let id, let label) = $0 { "\(id) \(label)" } else { nil } }
    #expect(days == ["2026-08-30 Sun, Aug 30", "2026-08-31 Yesterday"])
  }

  @Test("S4 02.E / D-UI-35: a group's inbound run names its sender once; a new sender is a new run at 8 pt")
  func groupNames() throws {
    let flat = try Self.page("flat")
    let names = ["+15550100005": "Lena Brandt"]
    let rows = TranscriptLayout.rows(
      MessageTurn.turns(flat), asOf: Self.asOf, calendar: Self.utc, isGroup: true, senderName: { names[$0] })
    let b = Self.bubbles(rows)
    // them(06), them(05), me, [new day] them(06).
    #expect(b.map(\.senderName) == ["+15550100006", "Lena Brandt", nil, "+15550100006"])
    #expect(b.map(\.gap) == [0, 8, 8, 0])
  }

  @Test("S4 02: selecting a thread reads its transcript once; an unknown chat says so")
  func open() async throws {
    let transport = FakeTransport { request in
      if request.url?.path.contains("+15550100002") == true { return try Reply.scenario("rich", "threads.messages.daniel.json") }
      return try Reply.golden("errors/404.unknown-chat.json")
    }
    let model = ThreadModel(client: testClient(transport))
    await model.open("iMessage;-;+15550100002")
    #expect(model.turns.map(\.guid) == ["msg-0012", "msg-0013", "msg-0014"])
    #expect(model.asOf == Self.asOf)
    #expect(transport.requests.count == 1)
    await model.open("iMessage;-;+15550100099")
    #expect(model.load == .unknownChat)
    #expect(model.turns.isEmpty)
    await model.open(nil)
    #expect(model.load == .idle)
    #expect(transport.requests.count == 2)
    // Every read was a GET: the transcript never writes.
    #expect(transport.requests.allSatisfy { $0.httpMethod == "GET" })
  }

  @Test("S4 02.J / D-UI-36: holding a draft is local; no request is made")
  func holdIsLocal() {
    let transport = FakeTransport { _ in throw Unreachable() }
    let model = ThreadModel(client: testClient(transport))
    model.hold("drf-0102")
    #expect(model.held == ["drf-0102"])
    #expect(transport.requests.isEmpty)
  }
}
