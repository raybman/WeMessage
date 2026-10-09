import Foundation
import Testing
import WeMessageKit

@testable import WeMessageApp

/// v2 B3, board 04: LinkedIn over the preview-linkedin fixtures. The board
/// follows availability as boards 03 and 05 do; the Focused and Other tabs
/// and the inbox scope filter the LinkedIn list only, and origin tags show
/// only while every inbox does; Make draft on a thread a step reaches makes
/// exactly one draft through POST /v1/drafts; an ad, a pending request, a
/// thread no step reaches, and every thread while LinkedIn has pushed back,
/// write nothing at all, even when the pause arrives after the composer was
/// drawn.
@Suite("Board04Shell")
@MainActor
struct Board04ShellTests {
  static let scenario = "preview-linkedin"
  static let ratelimited = "preview-linkedin-ratelimited"
  static let account = "Avery Park"
  static let marcus = "linkedin;-;marcus-tan"
  static let priya = "linkedin;-;priya-raman"
  static let grace = "linkedin;-;grace-moreno"
  static let dana = "linkedin;-;dana-whitfield"
  static let tomas = "linkedin;-;tomas-kral"
  static let contoso = "linkedin;-;contoso-talent"
  static let riya = "linkedin;-;riya-kapoor"

  /// Serves the scenario's reads (the status from `statusScenario`) and the
  /// drafts golden on POST /v1/drafts.
  static func transport(statusScenario: String = scenario) throws -> FakeTransport {
    var pages: [String: Reply] = [:]
    for name in ["contoso", "dana", "grace", "marcus", "priya", "riya", "tomas"] {
      let reply = try Reply.scenario(scenario, "threads.messages." + name + ".json")
      pages[try ShellModelTests.decode(reply, ThreadMessagesPage.self).chatGuid] = reply
    }
    let status = try Reply.scenario(statusScenario, "status.json")
    let threads = try Reply.scenario(scenario, "threads.list.json")
    let created = try Reply.golden("responses/drafts.create.json")
    let served = pages
    return FakeTransport { request in
      let path = request.url?.path ?? ""
      if request.httpMethod == "POST" && path == "/v1/drafts" { return created }
      if path == "/v1/status" { return status }
      if path == "/v1/threads" { return threads }
      for (guid, reply) in served where path.hasPrefix("/v1/threads/") && path.hasSuffix("/messages") {
        if path.removingPercentEncoding?.contains(guid) == true || path.contains(guid) { return reply }
      }
      throw Unreachable()
    }
  }

  static func writes(_ transport: FakeTransport) -> [String] {
    transport.requests.filter { $0.httpMethod != "GET" && $0.httpMethod != nil }
      .map { ($0.httpMethod ?? "") + " " + ($0.url?.path ?? "") }
  }

  static func status(_ name: String) throws -> StatusPayload {
    try ShellModelTests.decode(Reply.scenario(name, "status.json"), StatusPayload.self)
  }

  /// A model with the gate open, the scenario's status and threads, on the
  /// LinkedIn tile.
  static func opened(_ transport: FakeTransport, statusScenario: String = scenario) throws -> ShellModel {
    let m = ShellModel(client: testClient(transport))
    m.state = AppState(previewGate: ShellBoardTests.open)
    m.status = try status(statusScenario)
    m.threads = try ShellModelTests.decode(Reply.scenario(scenario, "threads.list.json"), ThreadsPage.self)
    m.scope = .linkedin
    return m
  }

  /// Selects and loads `chatGuid` on `m`.
  static func open(_ m: ShellModel, _ chatGuid: String) async {
    m.selectedThread = chatGuid
    await m.thread.open(chatGuid)
  }

  // MARK: the board

  @Test("B4-1: the board follows availability as boards 03 and 05 do: connected draws it with no chip, the fixture state with the chip, not connected or unknown draws none; the banner names the account and the inbox scope")
  func boardModel() throws {
    let chip = TestHooks.previewChipText
    let preview = ChannelAvailability.preview(scenario: Self.scenario)
    let fixture = LinkedInBoardModel.make(preview, account: Self.account, inbox: nil, chipText: chip)
    #expect(fixture?.chip == chip)
    #expect(fixture?.scope == ProvisionalUI.linkedInAllInboxes)
    #expect(fixture?.banner == ProvisionalUI.linkedInBanner(account: Self.account, scope: ProvisionalUI.linkedInAllInboxes))
    #expect(fixture?.headline == ProvisionalUI.linkedInEmptyHeadline)
    #expect(fixture?.detail == ProvisionalUI.linkedInEmptyDetail)
    let narrowed = LinkedInBoardModel.make(preview, account: Self.account, inbox: .salesNav, chipText: chip)
    #expect(narrowed?.scope == LinkedInInbox.salesNav.shortTitle)
    #expect(narrowed?.banner.contains(LinkedInInbox.salesNav.shortTitle) == true)
    #expect(LinkedInBoardModel.make(.connected, account: nil, inbox: nil, chipText: chip)?.chip == nil)
    for reason in ShellBoardTests.reasons {
      #expect(LinkedInBoardModel.make(.notConnected(reason: reason), account: Self.account, inbox: nil, chipText: chip) == nil)
    }
    #expect(LinkedInBoardModel.make(nil, account: Self.account, inbox: nil, chipText: chip) == nil)

    let closed = ShellModel(client: testClient(FakeTransport { _ in throw Unreachable() }))
    closed.status = try Self.status(Self.scenario)
    closed.threads = try ShellModelTests.decode(Reply.scenario(Self.scenario, "threads.list.json"), ThreadsPage.self)
    closed.scope = .linkedin
    #expect(closed.linkedInBoard == nil, "a closed gate draws no board 04")
    #expect(closed.linkedInStatus.account == nil, "a closed gate reads no LinkedIn status meta")

    let m = try Self.opened(try Self.transport())
    #expect(m.availability(.linkedin) == .preview(scenario: Self.scenario))
    #expect(m.linkedInBoard?.chip == chip)
    #expect(m.linkedInBoard?.banner == ProvisionalUI.linkedInBanner(account: Self.account, scope: ProvisionalUI.linkedInAllInboxes))
    m.scope = .all
    #expect(m.linkedInBoard == nil, "the empty board 04 is drawn on the LinkedIn tile only")
    let marcus = try #require(m.threads?.threads.first { $0.chatGuid == Self.marcus })
    #expect(m.linkedInBoard(for: marcus) != nil, "a LinkedIn thread opened from All still reads as board 04")
  }

  // MARK: 04.A, the tabs

  @Test("B4-2: Focused is on at launch and shows the focused threads only; Other shows the rest; no other tile is filtered")
  func categoryTabs() throws {
    let m = try Self.opened(try Self.transport())
    #expect(m.linkedIn.filter.category == .focused)
    #expect(Set(m.rows.map(\.chatGuid)) == [Self.marcus, Self.grace, Self.dana, Self.tomas])
    m.linkedIn.setCategory(.other)
    #expect(Set(m.rows.map(\.chatGuid)) == [Self.priya, Self.contoso, Self.riya])
    #expect(!m.rows.contains { $0.chatGuid == Self.marcus }, "a Focused thread never shows under Other")
    m.scope = .all
    #expect(m.rows.count == 7, "the tabs filter the LinkedIn tile only")
  }

  // MARK: 04.E, the inboxes

  @Test("B4-3: the inbox switch narrows the list to one of three inboxes and closes; All brings all three back; origin tags show only under All and only on the LinkedIn tile; replies go to the origin inbox")
  func inboxScope() throws {
    let m = try Self.opened(try Self.transport())
    let threads = try #require(m.threads?.threads)
    #expect(LinkedInRoute.counts(threads) == [.personal: 5, .salesNav: 1, .recruiter: 1])
    let grace = try #require(threads.first { $0.chatGuid == Self.grace })
    let tomas = try #require(threads.first { $0.chatGuid == Self.tomas })
    let marcus = try #require(threads.first { $0.chatGuid == Self.marcus })
    #expect(m.linkedInOriginTag(marcus) == LinkedInInbox.personal.tag)
    #expect(m.linkedInOriginTag(grace) == LinkedInInbox.salesNav.tag)
    #expect(m.linkedInOriginTag(tomas) == LinkedInInbox.recruiter.tag)

    m.linkedIn.switchShown = true
    m.linkedIn.setInbox(.salesNav)
    #expect(!m.linkedIn.switchShown, "choosing an inbox closes the switch")
    #expect(m.rows.map(\.chatGuid) == [Self.grace])
    #expect(m.linkedInOriginTag(grace) == nil, "narrowed to one inbox, the tag is dropped")
    #expect(m.linkedInBoard?.scope == LinkedInInbox.salesNav.shortTitle)
    m.linkedIn.setInbox(.recruiter)
    #expect(m.rows.map(\.chatGuid) == [Self.tomas])
    m.linkedIn.setInbox(.personal)
    #expect(Set(m.rows.map(\.chatGuid)) == [Self.marcus, Self.dana])
    m.linkedIn.setInbox(nil)
    #expect(m.rows.count == 4)
    #expect(m.linkedInBoard?.scope == ProvisionalUI.linkedInAllInboxes)

    m.scope = .all
    #expect(m.linkedInOriginTag(grace) == nil, "origin tags belong to the LinkedIn tile")
    #expect(LinkedInRoute.replyInbox(LinkedInThreadMeta(grace)) == .salesNav)
    #expect(LinkedInRoute.replyInbox(LinkedInThreadMeta(tomas)) == .recruiter)
  }

  // MARK: 04.B, 04.D, 04.F, 04.H, the composer and the one write

  @Test("B4-4: Make draft on a thread a step reaches makes exactly one draft through POST /v1/drafts with the chat and the body; a second press writes nothing more; an empty body writes nothing")
  func draftMakesOne() async throws {
    let transport = try Self.transport()
    let m = try Self.opened(transport)
    #expect(m.linkedInComposer(try #require(m.threads?.threads.first { $0.chatGuid == Self.marcus })) == .absent(.noRung),
      "before the page is read no composer is offered")
    await Self.open(m, Self.marcus)
    let marcus = try #require(m.selected)
    #expect(m.linkedInComposer(marcus) == .composer(.message))
    await m.draftLinkedIn(body: "   ")
    #expect(Self.writes(transport).isEmpty, "an empty body cannot become a draft")
    await m.draftLinkedIn(body: "Thursday works, send the invite.")
    guard case .drafted(let id) = m.linkedIn.phase(Self.marcus) else {
      Issue.record("phase \(m.linkedIn.phase(Self.marcus))")
      return
    }
    #expect(!id.isEmpty)
    #expect(Self.writes(transport) == ["POST /v1/drafts"])
    let post = try #require(transport.requests.first { $0.httpMethod == "POST" })
    let body = try #require(post.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] })
    #expect(body["chatGuid"] as? String == Self.marcus)
    #expect(body["body"] as? String == "Thursday works, send the invite.")
    await m.draftLinkedIn(body: "Again.")
    #expect(Self.writes(transport).count == 1, "a drafted composer does not draft again")
    #expect(!transport.requests.contains { $0.url?.path.contains("/send") == true })
  }

  @Test("B4-5: an InMail step carries a subject; an ad, a pending request and a thread no step reaches get no composer and write nothing")
  func noComposerWritesNothing() async throws {
    let transport = try Self.transport()
    let m = try Self.opened(transport)
    await Self.open(m, Self.grace)
    #expect(m.linkedInComposer(try #require(m.selected)) == .composer(.openProfile))
    await Self.open(m, Self.dana)
    #expect(m.linkedInComposer(try #require(m.selected)) == .composer(.inMail))
    let absent: [(String, LinkedInComposer.Reason)] = [
      (Self.contoso, .sponsored), (Self.priya, .requestPending), (Self.riya, .noRung),
    ]
    for (guid, reason) in absent {
      await Self.open(m, guid)
      #expect(m.linkedInComposer(try #require(m.selected)) == .absent(reason), "\(guid)")
      await m.draftLinkedIn(body: "This reaches nobody.")
      #expect(m.linkedIn.phase(guid) == .composing)
    }
    #expect(Self.writes(transport).isEmpty)
  }

  @Test("B4-6: while LinkedIn has pushed back every thread is paused: no composer, and Make draft writes nothing, not even when the pause arrives after the composer was drawn")
  func pausedWritesNothing() async throws {
    let transport = try Self.transport(statusScenario: Self.ratelimited)
    let m = try Self.opened(transport, statusScenario: Self.ratelimited)
    #expect(m.linkedInStatus.paused)
    for guid in [Self.marcus, Self.grace, Self.dana, Self.tomas, Self.priya, Self.riya] {
      await Self.open(m, guid)
      #expect(m.linkedInComposer(try #require(m.selected)) == .absent(.paused), "\(guid)")
      await m.draftLinkedIn(body: "Held back.")
    }
    await Self.open(m, Self.contoso)
    #expect(m.linkedInComposer(try #require(m.selected)) == .absent(.sponsored), "an ad stays an ad, paused or not")
    #expect(Self.writes(transport).isEmpty, "the fake daemon receives nothing under the pause")

    // The composer was drawn, then the pause arrived: the press re-reads it.
    let late = try Self.transport()
    let n = try Self.opened(late)
    await Self.open(n, Self.marcus)
    #expect(n.linkedInComposer(try #require(n.selected)) == .composer(.message))
    n.status = try Self.status(Self.ratelimited)
    await n.draftLinkedIn(body: "Typed before the pause.")
    #expect(Self.writes(late).isEmpty)
    #expect(n.linkedIn.phase(Self.marcus) == .composing)

    // The desk alone, handed a closed gate, writes nothing either.
    let desk = LinkedInDesk(client: testClient(late))
    await desk.makeDraft(chatGuid: Self.marcus, body: "Straight to the desk.", gate: .absent(.paused))
    #expect(Self.writes(late).isEmpty)
  }
}
