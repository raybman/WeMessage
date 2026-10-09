import Foundation
import Testing

@testable import WeMessageKit

/// v2 B2, board 05: the typed readings of the email `meta` carrier, the
/// attachment wall, and the preview-email fixtures they are drawn from.
@Suite("Board 05 model")
struct Board05ModelTests {
  static let dir = "fixtures/scenarios/preview-email/responses/"
  static let me = "me@example.com"

  static func body<T: Decodable>(_ type: T.Type, _ file: String) throws -> T {
    let json = try Repo.json(dir + file)
    let body = try #require(json["body"])
    return try JSONDecoder().decode(type, from: try body.canonicalData())
  }

  static func threads() throws -> [ThreadSummary] {
    try body(ThreadsPage.self, "threads.list.json").threads
  }

  static func pages() throws -> [String: ThreadMessagesPage] {
    var out: [String: ThreadMessagesPage] = [:]
    for name in try Repo.files(under: dir).filter({ $0.hasPrefix("threads.messages.") }) {
      let page = try body(ThreadMessagesPage.self, name)
      out[page.chatGuid] = page
    }
    return out
  }

  static func p(_ name: String?, _ address: String) -> EmailParticipant {
    EmailParticipant(name: name, address: address)
  }

  // MARK: the wall

  @Test("the wall warns from 20 MB and blocks from 25 MB, both inclusive")
  func wallThresholds() {
    #expect(EmailSizeWall.state(0) == .clear)
    #expect(EmailSizeWall.state(19_999_999) == .clear)
    #expect(EmailSizeWall.state(20_000_000) == .warn)
    #expect(EmailSizeWall.state(24_999_999) == .warn)
    #expect(EmailSizeWall.state(25_000_000) == .block)
    #expect(EmailSizeWall.state(30_000_000) == .block)
    #expect(EmailSizeWall.left(22_400_000) == 2_600_000)
    #expect(EmailSizeWall.left(40_000_000) == 0)
  }

  @Test("the block is the dated email wall in the shipped table")
  func blockIsTheTableWall() throws {
    let wall = try #require(SizeWallTable.standard.wall(for: .email))
    #expect(EmailSizeWall.blockBytes == wall.bytes)
    #expect(wall.basis == .perMessage)
    #expect(EmailSizeWall.warnBytes < EmailSizeWall.blockBytes)
    #expect(SizeText.megabytes(EmailSizeWall.blockBytes) == "25.0 MB")
  }

  // MARK: thread meta

  @Test("absent meta reads safe defaults, remote images blocked")
  func threadDefaults() {
    let m = EmailThreadMeta(meta: nil)
    #expect(m.subject == nil)
    #expect(m.participants.isEmpty)
    #expect(m.category == nil)
    #expect(m.sizeBytes == 0)
    #expect(!m.hasInvite)
    #expect(m.remoteImages == .blocked)
    #expect(m.account == nil)
  }

  @Test("a wrong-shaped or unknown value never opens remote images")
  func remoteImagesDefaultBlocked() {
    #expect(EmailRemoteImages(nil) == .blocked)
    #expect(EmailRemoteImages(.string("blocked")) == .blocked)
    #expect(EmailRemoteImages(.string("maybe")) == .blocked)
    #expect(EmailRemoteImages(.bool(true)) == .blocked)
    #expect(EmailRemoteImages(.string("allowed")) == .allowed)
    let odd = EmailThreadMeta(meta: ["sizeBytes": "big", "hasInvite": "yes", "category": "spam", "participants": 4])
    #expect(odd.sizeBytes == 0)
    #expect(!odd.hasInvite)
    #expect(odd.category == nil)
    #expect(odd.participants.isEmpty)
    #expect(odd.remoteImages == .blocked)
  }

  @Test("thread meta reads every field")
  func threadReads() {
    let m = EmailThreadMeta(meta: [
      "subject": "Hello", "category": "paperTrail", "sizeBytes": 1200, "hasInvite": true,
      "remoteImages": "blocked", "account": "me@example.com",
      "participants": [["name": "Ana", "address": "ana@example.com"], ["address": "bo@example.com"], ["name": "No address"]],
    ])
    #expect(m.subject == "Hello")
    #expect(m.category == .paperTrail)
    #expect(m.sizeBytes == 1200)
    #expect(m.hasInvite)
    #expect(m.account == Self.me)
    #expect(m.participants == [Self.p("Ana", "ana@example.com"), Self.p(nil, "bo@example.com")])
    #expect(m.participants[0].printed == "Ana <ana@example.com>")
    #expect(m.participants[1].shown == "bo@example.com")
  }

  @Test("the four categories, their chips and their lanes")
  func categories() {
    #expect(EmailCategory.allCases.map(\.title) == ["People", "Feed", "Paper Trail", "New senders"])
    #expect(EmailCategory.allCases.map(\.mode) == [.queue, .stream, .muted, .unassigned])
  }

  // MARK: turn meta

  @Test("absent turn meta: empty envelope, no invite, the thirty second undo")
  func turnDefaults() {
    let t = EmailTurnMeta(meta: nil)
    #expect(t.envelope == .empty)
    #expect(t.invite == nil)
    #expect(t.undoWindowMs == 30_000)
    #expect(t.undoSeconds == 30)
    #expect(t.images.isEmpty)
    #expect(t.trackers == 0)
    #expect(t.attachments.isEmpty)
    #expect(EmailTurnMeta(meta: ["undoWindowMs": 0]).undoWindowMs == 30_000)
    #expect(EmailTurnMeta(meta: ["undoWindowMs": 5000]).undoSeconds == 5)
  }

  @Test("reply all: sender and To, then Cc, never me, never twice")
  func replyAll() {
    let nadia = Self.p("Nadia", "nadia@example.com")
    let owen = Self.p("Owen", "owen@example.com")
    let lucia = Self.p("Lucia", "lucia@example.com")
    let env = EmailEnvelope(from: nadia, to: [owen, Self.p("Me", "ME@example.com")], cc: [lucia, owen])
    let all = env.replyAll(me: Self.me)
    #expect(all.from?.address == Self.me)
    #expect(all.to == [nadia, owen])
    #expect(all.cc == [lucia])
    let one = env.reply(me: Self.me)
    #expect(one.to == [nadia])
    #expect(one.cc.isEmpty)
    let mine = EmailEnvelope(from: Self.p("Me", Self.me), to: [nadia], cc: [owen])
    #expect(mine.reply(me: Self.me).to == [nadia])
    #expect(mine.replyAll(me: Self.me).to == [nadia])
    #expect(mine.replyAll(me: Self.me).cc == [owen])
    #expect(env.forward(me: Self.me).to.isEmpty)
  }

  @Test("an invite reads its title, time, organizer and guests")
  func invite() throws {
    let value: JSONValue = [
      "title": "Review", "when": "Thursday", "place": "Video call",
      "organizer": ["name": "Felix", "address": "felix@example.com"],
      "guests": [
        ["name": "Owen", "address": "owen@example.com", "response": "accepted"],
        ["name": "Lucia", "address": "lucia@example.com"],
        ["address": "me@example.com", "response": "nonsense"],
      ],
    ]
    let invite = try #require(EmailTurnMeta(meta: ["inviteObject": value]).invite)
    #expect(invite.title == "Review")
    #expect(invite.when == "Thursday")
    #expect(invite.place == "Video call")
    #expect(invite.organizer?.name == "Felix")
    #expect(invite.guests.count == 3)
    #expect(invite.count(.accepted) == 1)
    #expect(invite.count(.awaiting) == 2)
    #expect(EmailInvite(["when": "Thursday"]) == nil)
  }

  // MARK: the fixtures

  @Test("preview-email: eight email threads, each with a page that agrees with it")
  func fixturesDecode() throws {
    let threads = try Self.threads()
    let pages = try Self.pages()
    #expect(threads.count == 8)
    #expect(pages.count == 8)
    for t in threads {
      #expect(t.channel == "email", "\(t.chatGuid)")
      let meta = EmailThreadMeta(t)
      #expect(meta.subject == t.title, "\(t.chatGuid)")
      #expect(meta.category != nil, "\(t.chatGuid)")
      #expect(meta.remoteImages == .blocked, "\(t.chatGuid)")
      #expect(meta.account == Self.me, "\(t.chatGuid)")
      #expect(meta.participants.contains { $0.address == Self.me }, "\(t.chatGuid)")
      let page = try #require(pages[t.chatGuid], "no page for \(t.chatGuid)")
      let last = try #require(page.turns.last)
      #expect(t.lastAt == last.at)
      #expect(t.lastFromMe == (last.from == "me"))
      #expect(page.turns.map(\.at) == page.turns.map(\.at).sorted())
      for turn in page.turns {
        let m = EmailTurnMeta(turn)
        #expect(m.envelope.from != nil, "\(turn.guid)")
        #expect(!m.envelope.to.isEmpty, "\(turn.guid)")
        #expect(m.undoWindowMs == 30_000, "\(turn.guid)")
        #expect(m.attachments.count == turn.attachments, "\(turn.guid)")
      }
      #expect(meta.hasInvite == page.turns.contains { EmailTurnMeta($0).invite != nil }, "\(t.chatGuid)")
    }
    #expect(Set(threads.compactMap { EmailThreadMeta($0).category }) == Set(EmailCategory.allCases))
  }

  @Test("the fixtures carry one invite, one newsletter with images, and one batch in the warning band")
  func fixtureStates() throws {
    let turns = try Self.pages().values.flatMap(\.turns).map(EmailTurnMeta.init)
    #expect(turns.filter { $0.invite != nil }.count == 1)
    let images = turns.filter { !$0.images.isEmpty }
    #expect(images.count == 1)
    #expect(images.first?.trackers == 3)
    #expect(images.first?.images.allSatisfy { $0.url.hasPrefix("https://img.example.com/") } == true)
    #expect(turns.map { EmailSizeWall.state($0.attachmentBytes) }.filter { $0 == .warn }.count == 1)
    #expect(turns.allSatisfy { EmailSizeWall.state($0.attachmentBytes) != .block })
    #expect(try Self.pages().values.contains { $0.turns.count > 3 })
  }
}
