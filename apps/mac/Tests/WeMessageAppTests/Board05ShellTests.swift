import Foundation
import Testing
import WeMessageKit

@testable import WeMessageApp

/// v2 B2, board 05: the Email board over the preview-email fixtures. The
/// board follows availability as board 03 does (the rail mark too); the
/// chips filter the Email list only; a thread reads as cards with the
/// earlier ones folded; compose prefills its envelope, opens the message's
/// own undo window on Send and, only when it runs out, makes one draft;
/// the wall warns at 20 MB and blocks Send at 25 MB; a remote image goes to
/// the fake daemon under the flag and nowhere but http or https.
@Suite("Board05Shell")
@MainActor
struct Board05ShellTests {
  static let scenario = "preview-email"
  static let terms = "email;-;q3-terms"
  static let photos = "email;-;site-photos"
  static let weekly = "email;-;contoso-weekly"
  static let me = "me@example.com"

  static func page(_ file: String) throws -> ThreadMessagesPage {
    try ShellModelTests.decode(Reply.scenario(scenario, "threads.messages." + file + ".json"), ThreadMessagesPage.self)
  }

  static func cards(_ file: String) throws -> [EmailCard] { EmailCard.cards(try page(file)) }

  /// Serves the scenario's reads and the drafts golden on POST /v1/drafts.
  static func transport() throws -> FakeTransport {
    var pages: [String: Reply] = [:]
    for name in ["hello", "offsite", "photos", "receipt", "review", "statement", "terms", "weekly"] {
      let reply = try Reply.scenario(scenario, "threads.messages." + name + ".json")
      pages[try ShellModelTests.decode(reply, ThreadMessagesPage.self).chatGuid] = reply
    }
    let status = try Reply.scenario(scenario, "status.json")
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

  /// A model with the gate open, the scenario's status and threads, on
  /// the Email tile.
  static func opened(_ transport: FakeTransport) throws -> ShellModel {
    let m = ShellModel(client: testClient(transport))
    m.state = AppState(previewGate: ShellBoardTests.open)
    m.status = try ShellModelTests.decode(Reply.scenario(scenario, "status.json"), StatusPayload.self)
    m.threads = try ShellModelTests.decode(Reply.scenario(scenario, "threads.list.json"), ThreadsPage.self)
    m.scope = .email
    return m
  }

  /// A desk whose ticks wait until cancelled: Send opens the window and
  /// it stays open.
  static func stuck(_ transport: FakeTransport) -> EmailDesk {
    EmailDesk(client: testClient(transport), tick: { try await Task.sleep(nanoseconds: 3_600_000_000_000) })
  }

  final class Ticks: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    func bump() { lock.withLock { n += 1 } }
    var count: Int { lock.withLock { n } }
  }

  // MARK: the board and the rail

  @Test("B5-1: the board follows availability as board 03 does: connected draws it with no chip, the fixture state with the chip, not connected or unknown draws none")
  func boardModel() {
    let chip = TestHooks.previewChipText
    let fixture = EmailBoardModel.make(.preview(scenario: Self.scenario), account: Self.me, chipText: chip)
    #expect(fixture?.chip == chip)
    #expect(fixture?.banner == ProvisionalUI.emailBannerName + " " + Self.me)
    #expect(fixture?.headline == ProvisionalUI.emailEmptyHeadline)
    #expect(fixture?.detail == ProvisionalUI.emailEmptyDetail)
    #expect(EmailBoardModel.make(.connected, chipText: chip)?.chip == nil)
    #expect(EmailBoardModel.make(.connected, chipText: chip)?.banner == ProvisionalUI.emailBannerName)
    for reason in ShellBoardTests.reasons {
      #expect(EmailBoardModel.make(.notConnected(reason: reason), chipText: chip) == nil)
    }
    #expect(EmailBoardModel.make(nil, chipText: chip) == nil)
    #expect(ProvisionalUI.emailBanner(account: "") == ProvisionalUI.emailBannerName)
  }

  @Test("B5-2: the Email rail mark follows availability: the fixture state through an open gate draws the clear baseline a connected quiet channel would; a closed gate, or any not-connected reason, draws nothing")
  func railFollowsAvailability() throws {
    let f = try ShellBoardTests.fixture(Self.scenario)
    let preview = ShellBoardTests.fold(f, ShellBoardTests.table(.email, .preview(scenario: Self.scenario)))
    #expect(preview.mark(.email) == .baseline)
    #expect(preview.mark(.whatsapp) == RailMark.none)
    let connected = ShellBoardTests.fold(f, ShellBoardTests.table(.email, .connected))
    #expect(connected.mark(.email) == preview.mark(.email), "the rail shows no difference; the chip does")
    for reason in ShellBoardTests.reasons {
      #expect(ShellBoardTests.fold(f, ShellBoardTests.table(.email, .notConnected(reason: reason))).mark(.email) == RailMark.none)
    }

    let closed = ShellModel(client: testClient(FakeTransport { _ in throw Unreachable() }))
    closed.status = f.status
    closed.threads = f.threads
    #expect(closed.availability(.email) == .notConnected(reason: .notInThisVersion))
    #expect(closed.board.mark(.email) == RailMark.none)
    closed.scope = .email
    #expect(closed.emailBoard == nil, "a closed gate draws no board 05")

    let m = try Self.opened(try Self.transport())
    #expect(m.availability(.email) == .preview(scenario: Self.scenario))
    #expect(m.board.mark(.email) == .baseline)
    #expect(m.emailBoard?.chip == TestHooks.previewChipText)
    #expect(m.emailBoard?.banner == ProvisionalUI.emailBanner(account: Self.me))
    m.scope = .all
    #expect(m.emailBoard == nil, "board 05 is drawn on the Email tile only")
    m.scope = .whatsapp
    #expect(m.emailBoard == nil)
  }

  // MARK: 05.G, the chips

  @Test("B5-3: a chip filters the Email list to its category, the same chip again clears it, and no other tile is filtered")
  func chipsFilter() throws {
    let m = try Self.opened(try Self.transport())
    #expect(m.rows.count == 8)
    m.email.toggle(.paperTrail)
    #expect(m.email.category == .paperTrail)
    #expect(m.rows.map(\.chatGuid) .sorted() == ["email;-;northwind-receipt", "email;-;woodgrove-statement"])
    m.email.toggle(.feed)
    #expect(m.rows.map(\.chatGuid) == [Self.weekly])
    m.email.toggle(.people)
    #expect(m.rows.count == 4)
    m.scope = .all
    #expect(m.rows.count == 8, "the chip filters the Email tile only")
    m.scope = .email
    m.email.toggle(.people)
    #expect(m.email.category == nil)
    #expect(m.rows.count == 8)
  }

  // MARK: 05.A, the cards

  @Test("B5-4: a thread reads as cards oldest first; five messages show the last three and fold two; unfolded, all five")
  func cardsAndFold() throws {
    let cards = try Self.cards("terms")
    #expect(cards.count == 5)
    #expect(cards.map(\.id) == ["mail-0100", "mail-0101", "mail-0102", "mail-0103", "mail-0104"])
    let at = cards.compactMap(\.at)
    #expect(at.count == 5 && at == at.sorted())
    let fold = EmailCard.fold(cards, expanded: false)
    #expect(fold.folded == 2)
    #expect(fold.shown.map(\.id) == ["mail-0102", "mail-0103", "mail-0104"])
    #expect(EmailCard.fold(cards, expanded: true).folded == 0)
    #expect(EmailCard.fold(Array(cards.prefix(3)), expanded: false).folded == 0)
    let last = try #require(cards.last)
    #expect(last.from == "Nadia Brooks")
    #expect(last.fromPrinted == "Nadia Brooks <nadia.brooks@example.com>")
    #expect(last.toLine == ProvisionalUI.emailFieldTo + ": Owen Hale, Me")
    #expect(last.ccLine == ProvisionalUI.emailFieldCc + ": Lucia Ferrer")
    #expect(ProvisionalUI.emailMeasureChars == 68)
  }

  // MARK: 05.B, compose

  @Test("B5-5: Reply all on the open thread (and shift-R's replyAllEmail) prefills sender and To, then Cc, never me, with Re: once; Reply goes to the sender only; Forward to nobody, carrying the files")
  func composePrefill() async throws {
    let transport = try Self.transport()
    let m = try Self.opened(transport)
    #expect(m.openEmail == nil)
    m.selectedThread = Self.terms
    await m.thread.open(Self.terms)
    #expect(m.openEmail?.thread.chatGuid == Self.terms)

    m.replyAllEmail()
    let all = try #require(m.email.compose)
    #expect(all.mode == .replyAll)
    #expect(all.replyTo == "mail-0104")
    #expect(all.to == "nadia.brooks@example.com, owen.hale@example.com")
    #expect(all.cc == "lucia.ferrer@example.com")
    #expect(all.subject == "Re: Q3 terms, revised")
    #expect(all.undoSeconds == 30)
    #expect(all.attachments.isEmpty)

    m.composeEmail(.reply)
    let one = try #require(m.email.compose)
    #expect(one !== all, "a compose already open is replaced")
    #expect(one.to == "nadia.brooks@example.com")
    #expect(one.cc.isEmpty)

    m.composeEmail(.forward)
    let fwd = try #require(m.email.compose)
    #expect(fwd.to.isEmpty)
    #expect(fwd.subject == "Fwd: Q3 terms, revised")
    #expect(fwd.attachments.map(\.name) == ["Q3-terms-v3.pdf", "payment-schedule.xlsx"])

    #expect(EmailComposeModel.subject("Re: Q3", mode: .reply) == "Re: Q3")
    #expect(EmailComposeModel.subject("re: Q3", mode: .replyAll) == "re: Q3")
    #expect(EmailComposeModel.subject("Re: Q3", mode: .forward) == "Fwd: Re: Q3")

    m.email.closeCompose()
    m.scope = .all
    #expect(m.openEmail == nil, "off the Email tile there is no open email thread")
    m.replyAllEmail()
    #expect(m.email.compose == nil)
    #expect(Self.writes(transport).isEmpty)
  }

  @Test("B5-6: Send opens the message's own window and, when its 30 ticks run out, makes exactly one draft through POST /v1/drafts with the chat and the body")
  func sendMakesOneDraft() async throws {
    let transport = try Self.transport()
    let ticks = Ticks()
    let desk = EmailDesk(client: testClient(transport), tick: { ticks.bump() })
    let card = try #require(try Self.cards("terms").last)
    desk.startCompose(.replyAll, chatGuid: Self.terms, card: card, account: Self.me, subject: "Q3 terms, revised")
    let compose = try #require(desk.compose)
    #expect(!compose.canSend, "an empty body cannot become a draft")
    compose.body = "Signed copy attached by end of day."
    #expect(compose.canSend)
    compose.send()
    #expect(compose.phase == .undo(secondsLeft: 30))
    #expect(Self.writes(transport).isEmpty, "nothing is written when the window opens")
    await compose.settle()
    #expect(ticks.count == 30)
    guard case .drafted(let id) = compose.phase else {
      Issue.record("phase \(compose.phase)")
      return
    }
    #expect(!id.isEmpty)
    #expect(Self.writes(transport) == ["POST /v1/drafts"])
    let post = try #require(transport.requests.first { $0.httpMethod == "POST" })
    let body = try #require(post.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] })
    #expect(body["chatGuid"] as? String == Self.terms)
    #expect(body["body"] as? String == "Signed copy attached by end of day.")
    #expect(compose.phaseLine == ProvisionalUI.emailDraftedLine)
    compose.send()
    await compose.settle()
    #expect(Self.writes(transport).count == 1, "a drafted compose does not draft again")
  }

  @Test("B5-7: Undo inside the window writes nothing and gives the text back; Discard inside the window writes nothing")
  func undoAndDiscardWriteNothing() async throws {
    let transport = try Self.transport()
    let desk = Self.stuck(transport)
    let card = try #require(try Self.cards("terms").last)
    desk.startCompose(.reply, chatGuid: Self.terms, card: card, account: Self.me, subject: nil)
    let compose = try #require(desk.compose)
    compose.body = "Holding this one."
    // The state line is never empty: an empty Text has no element, so the
    // compose's state would read as missing.
    #expect(compose.phaseLine == ProvisionalUI.emailComposingLine)
    compose.send()
    #expect(compose.busy)
    #expect(!compose.canSend)
    #expect(compose.phaseLine == ProvisionalUI.emailUndoLine(30))
    compose.undo()
    await compose.settle()
    #expect(compose.phase == .composing)
    #expect(compose.phaseLine == ProvisionalUI.emailComposingLine)
    #expect(compose.body == "Holding this one.")
    #expect(Self.writes(transport).isEmpty)

    compose.send()
    desk.closeCompose()
    await compose.settle()
    #expect(desk.compose == nil)
    #expect(compose.phase == .composing)
    #expect(Self.writes(transport).isEmpty)
  }

  // MARK: 05.D, the wall

  @Test("B5-8: forwarding 22.4 MB of photos warns and can still become a draft; over 25 MB Send is inert and send() does nothing; taking a file off clears the block")
  func wall() async throws {
    let transport = try Self.transport()
    let desk = Self.stuck(transport)
    let photos = try #require(try Self.cards("photos").last)
    desk.startCompose(.forward, chatGuid: Self.photos, card: photos, account: Self.me, subject: "Site photos, batch 2")
    let warn = try #require(desk.compose)
    #expect(warn.attachmentBytes == 22_400_000)
    #expect(warn.wall == .warn)
    #expect(warn.wallLine?.isEmpty == false)
    warn.to = "qa-bookings@example.com"
    warn.body = "Forwarding the batch."
    #expect(warn.canSend)

    // The same message with one more 4.2 MB file: 26.6 MB, over the cap.
    var json = try #require(
      try JSONSerialization.jsonObject(with: Reply.scenario(Self.scenario, "threads.messages.photos.json").body)
        as? [String: Any])
    var turns = try #require(json["turns"] as? [[String: Any]])
    let index = try #require(turns.firstIndex { $0["guid"] as? String == photos.id })
    var meta = try #require(turns[index]["meta"] as? [String: Any])
    var files = try #require(meta["attachments"] as? [[String: Any]])
    files.append(["name": "site-north-04.jpg", "mime": "image/jpeg", "bytes": 4_200_000])
    meta["attachments"] = files
    turns[index]["meta"] = meta
    json["turns"] = turns
    let page = try JSONDecoder().decode(ThreadMessagesPage.self, from: JSONSerialization.data(withJSONObject: json))
    let heavy = try #require(EmailCard.cards(page).last)
    desk.startCompose(.forward, chatGuid: Self.photos, card: heavy, account: Self.me, subject: nil)
    let block = try #require(desk.compose)
    block.to = "qa-bookings@example.com"
    block.body = "Forwarding the batch."
    #expect(block.wall == .block)
    #expect(!block.canSend)
    #expect(block.wallLine == ProvisionalUI.emailWallBlock(
      SizeText.megabytes(26_600_000), limit: SizeText.megabytes(EmailSizeWall.blockBytes)))
    block.send()
    #expect(block.phase == .composing)
    let last = try #require(block.attachments.last)
    block.remove(last)
    #expect(block.wall == .warn)
    #expect(block.canSend)
    #expect(Self.writes(transport).isEmpty)
  }

  // MARK: 05.E, remote images

  @Test("B5-9: images start blocked on every message; a reveal lifts one message only; under the flag an image goes to the fake daemon's /remote-image/, otherwise to its own address, and never anywhere but http or https")
  func remoteImages() throws {
    let desk = Self.stuck(try Self.transport())
    let weekly = try #require(try Self.cards("weekly").last)
    #expect(weekly.meta.images.count == 3)
    #expect(weekly.meta.trackers == 3)
    for card in try Self.cards("terms") + [weekly] { #expect(!desk.isRevealed(card.id)) }
    desk.reveal(weekly.id)
    #expect(desk.isRevealed(weekly.id))
    #expect(!desk.isRevealed("mail-0104"))

    let image = try #require(weekly.meta.images.first)
    let own = try #require(URL(string: image.url))
    #expect(RemoteImageLoader.address(image, uiTest: false) == own)
    let fake = try #require(RemoteImageLoader.address(image, uiTest: true))
    #expect(fake.path == "/remote-image/" + own.lastPathComponent)
    #expect(fake.host == ClientConfig().baseURL.host)
    let odd = EmailTurnMeta(meta: [
      "images": .array([
        .object(["url": .string("ftp://images.example.com/a.png")]),
        .object(["url": .string("file:///etc/hosts")]),
        .object(["url": .string("data:image/png;base64,AAAA")]),
      ])
    ])
    #expect(odd.images.count == 3)
    for image in odd.images {
      #expect(RemoteImageLoader.address(image, uiTest: false) == nil, "\(image.url)")
      #expect(RemoteImageLoader.address(image, uiTest: true) == nil, "\(image.url)")
    }
  }
}
