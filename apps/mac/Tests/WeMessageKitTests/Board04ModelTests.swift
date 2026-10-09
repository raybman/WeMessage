import Foundation
import Testing

@testable import WeMessageKit

/// v2 B3, board 04: the typed readings of the LinkedIn `meta` carrier, the
/// ladder, the three inboxes, the request capabilities, the category tabs,
/// and the preview-linkedin fixtures they are drawn from.
@Suite("Board 04 model")
struct Board04ModelTests {
  static let dir = "fixtures/scenarios/preview-linkedin/responses/"
  static let paused = "fixtures/scenarios/preview-linkedin-ratelimited/responses/"

  static func body<T: Decodable>(_ type: T.Type, _ path: String) throws -> T {
    let json = try Repo.json(path)
    let body = try #require(json["body"])
    return try JSONDecoder().decode(type, from: try body.canonicalData())
  }

  static func threads() throws -> [ThreadSummary] {
    try body(ThreadsPage.self, dir + "threads.list.json").threads
  }

  static func pages() throws -> [String: ThreadMessagesPage] {
    var out: [String: ThreadMessagesPage] = [:]
    for name in try Repo.files(under: dir).filter({ $0.hasPrefix("threads.messages.") }) {
      let page = try body(ThreadMessagesPage.self, dir + name)
      out[page.chatGuid] = page
    }
    return out
  }

  static func meta(_ slug: String) throws -> LinkedInThreadMeta {
    let t = try #require(try threads().first { $0.chatGuid == "linkedin;-;" + slug }, "no thread \(slug)")
    return LinkedInThreadMeta(t)
  }

  // MARK: 04.B the ladder

  @Test("the ladder reads every step 0 to 4, and anything else is the bottom rung")
  func ladderSteps() {
    #expect(LinkedInRung(wire: 0) == .message)
    #expect(LinkedInRung(wire: 1) == .openProfile)
    #expect(LinkedInRung(wire: 2) == .inMail)
    #expect(LinkedInRung(wire: 3) == .request)
    #expect(LinkedInRung(wire: 4) == .none)
    #expect(LinkedInRung(wire: nil) == .none)
    #expect(LinkedInRung(wire: 5) == .none)
    #expect(LinkedInRung(wire: -1) == .none)
    #expect(LinkedInThreadMeta(meta: ["eligibility": "0"]).rung == .none)
    #expect(LinkedInRung.allCases.map(\.rawValue) == [0, 1, 2, 3, 4])
    #expect(LinkedInRung.message < LinkedInRung.none)
  }

  @Test("each step's cost, form and attachments")
  func ladderProperties() {
    #expect(LinkedInRung.allCases.filter(\.costsCredit) == [.inMail])
    #expect(LinkedInRung.allCases.filter(\.hasSubject) == [.openProfile, .inMail])
    #expect(LinkedInRung.allCases.filter(\.allowsAttachments) == [.message, .openProfile, .inMail])
    #expect(LinkedInRung.allCases.filter { !$0.hasComposer } == [.none])
  }

  @Test("one composer per rung, and none at the bottom")
  func composerPerRung() {
    for rung in LinkedInRung.allCases {
      let meta = LinkedInThreadMeta(meta: ["eligibility": .number(Double(rung.rawValue))])
      let c = LinkedInComposer.resolve(meta, commercial: nil, paused: false)
      #expect(c == (rung == .none ? .absent(.noRung) : .composer(rung)), "\(rung)")
      #expect(c.allowsDraft == rung.hasComposer, "\(rung)")
    }
  }

  @Test("the composer precedence: sponsored, then the pause, then the request, then the ladder")
  func composerPrecedence() {
    let open = LinkedInThreadMeta(meta: ["eligibility": 0])
    let pending = LinkedInThreadMeta(meta: ["eligibility": 0, "requestState": "pending"])
    let declined = LinkedInThreadMeta(meta: ["eligibility": 0, "requestState": "declined"])
    let accepted = LinkedInThreadMeta(meta: ["eligibility": 0, "requestState": "accepted"])
    #expect(LinkedInComposer.resolve(open, commercial: .sponsored, paused: true) == .absent(.sponsored))
    #expect(LinkedInComposer.resolve(open, commercial: .recruiter, paused: true) == .absent(.paused))
    #expect(LinkedInComposer.resolve(pending, commercial: nil, paused: true) == .absent(.paused))
    #expect(LinkedInComposer.resolve(pending, commercial: nil, paused: false) == .absent(.requestPending))
    #expect(LinkedInComposer.resolve(declined, commercial: nil, paused: false) == .absent(.requestDeclined))
    #expect(LinkedInComposer.resolve(accepted, commercial: nil, paused: false) == .composer(.message))
    #expect(LinkedInComposer.resolve(open, commercial: .job, paused: false) == .composer(.message))
    for rung in LinkedInRung.allCases {
      let m = LinkedInThreadMeta(meta: ["eligibility": .number(Double(rung.rawValue))])
      #expect(!LinkedInComposer.resolve(m, commercial: nil, paused: true).allowsDraft, "paused \(rung)")
    }
  }

  // MARK: 04.E three inboxes

  @Test("three inboxes, read from the wire, unknown folding to messaging")
  func inboxes() {
    #expect(LinkedInInbox.allCases.count == 3)
    #expect(Set(LinkedInInbox.allCases.map(\.tag)) == ["MSG", "SN", "REC"])
    #expect(LinkedInInbox(wire: "personal") == .personal)
    #expect(LinkedInInbox(wire: "salesNav") == .salesNav)
    #expect(LinkedInInbox(wire: "recruiter") == .recruiter)
    #expect(LinkedInInbox(wire: nil) == .personal)
    #expect(LinkedInInbox(wire: "talent") == .personal)
  }

  @Test("routing: a reply goes back to the inbox the thread was born in, across all three")
  func routing() throws {
    #expect(LinkedInRoute.replyInbox(try Self.meta("marcus-tan")) == .personal)
    #expect(LinkedInRoute.replyInbox(try Self.meta("grace-moreno")) == .salesNav)
    #expect(LinkedInRoute.replyInbox(try Self.meta("tomas-kral")) == .recruiter)
    let counts = LinkedInRoute.counts(try Self.threads())
    #expect(counts == [.personal: 5, .salesNav: 1, .recruiter: 1])
    #expect(Set(try Self.threads().map { LinkedInRoute.replyInbox(LinkedInThreadMeta($0)) }).count == 3)
  }

  @Test("the inbox switch narrows to one inbox, and drops the origin tags when it does")
  func inboxFilter() throws {
    let threads = try Self.threads()
    func shown(_ f: LinkedInFilter) -> [String] {
      threads.filter { f.admits($0) }.map(\.chatGuid).sorted()
    }
    #expect(shown(LinkedInFilter(category: .focused, inbox: .salesNav)) == ["linkedin;-;grace-moreno"])
    #expect(shown(LinkedInFilter(category: .focused, inbox: .recruiter)) == ["linkedin;-;tomas-kral"])
    #expect(
      shown(LinkedInFilter(category: .focused, inbox: .personal)) == ["linkedin;-;dana-whitfield", "linkedin;-;marcus-tan"])
    #expect(shown(LinkedInFilter(category: .other, inbox: .salesNav)).isEmpty)
    #expect(LinkedInFilter().showsOriginTags)
    #expect(!LinkedInFilter(inbox: .personal).showsOriginTags)
    for inbox in LinkedInInbox.allCases {
      let union = LinkedInCategory.allCases.flatMap { shown(LinkedInFilter(category: $0, inbox: inbox)) }
      #expect(union.count == LinkedInRoute.counts(threads)[inbox], "\(inbox)")
    }
  }

  // MARK: 04.A categories

  @Test("Focused shows only Focused threads and Other only Other, never both")
  func categoryFilter() throws {
    let threads = try Self.threads()
    let focused = threads.filter { LinkedInFilter(category: .focused).admits($0) }.map(\.chatGuid).sorted()
    let other = threads.filter { LinkedInFilter(category: .other).admits($0) }.map(\.chatGuid).sorted()
    #expect(focused == ["linkedin;-;dana-whitfield", "linkedin;-;grace-moreno", "linkedin;-;marcus-tan", "linkedin;-;tomas-kral"])
    #expect(other == ["linkedin;-;contoso-talent", "linkedin;-;priya-raman", "linkedin;-;riya-kapoor"])
    #expect(Set(focused).isDisjoint(with: other))
    #expect(focused.count + other.count == threads.count)
    #expect(LinkedInCategory(wire: nil) == .focused)
    #expect(LinkedInCategory(wire: "archived") == .focused)
    #expect(LinkedInFilter().category == .focused)
  }

  @Test("a thread on another channel is never filtered out by LinkedIn's tabs")
  func otherChannelsPass() throws {
    let json: JSONValue = [
      "chatGuid": "iMessage;-;+15555550100", "channel": "imessage", "title": "Test", "isGroup": false,
      "lastLine": "Hi", "lastFromMe": false, "lastAt": "2026-09-01T12:00:00.000Z", "unread": 0,
    ]
    let thread = try? JSONDecoder().decode(ThreadSummary.self, from: try json.canonicalData())
    if let thread {
      #expect(LinkedInFilter(category: .other, inbox: .recruiter).admits(thread))
    }
    let page = try Self.threads()
    #expect(page.allSatisfy { $0.channel == "linkedin" })
  }

  // MARK: 04.D requests

  @Test("request capability flags: pending, declined, accepted, none")
  func requestCapabilities() {
    let pending = LinkedInCapabilities(request: .pending, rung: .message)
    #expect(!pending.canReply && !pending.canReact && !pending.canAttach)
    #expect(pending.canAccept && pending.canDeclinePrivately)
    let declined = LinkedInCapabilities(request: .declined, rung: .message)
    #expect(!declined.canReply && !declined.canReact && !declined.canAttach)
    #expect(declined.canAccept && !declined.canDeclinePrivately)
    for state in [LinkedInRequestState.none, .accepted] {
      let c = LinkedInCapabilities(request: state, rung: .message)
      #expect(c.canReply && c.canReact && c.canAttach, "\(state)")
      #expect(!c.canAccept && !c.canDeclinePrivately, "\(state)")
    }
    let viaRequest = LinkedInCapabilities(request: .none, rung: .request)
    #expect(viaRequest.canReply && !viaRequest.canAttach)
    let nobody = LinkedInCapabilities(request: .none, rung: .none)
    #expect(!nobody.canReply && !nobody.canAttach)
  }

  @Test("request state: absent is none, unknown is pending")
  func requestStates() {
    #expect(LinkedInRequestState(nil) == .none)
    #expect(LinkedInRequestState(.string("none")) == .none)
    #expect(LinkedInRequestState(.string("pending")) == .pending)
    #expect(LinkedInRequestState(.string("accepted")) == .accepted)
    #expect(LinkedInRequestState(.string("declined")) == .declined)
    #expect(LinkedInRequestState(.string("withdrawn")) == .pending)
  }

  // MARK: 04.C and 04.F turn meta

  @Test("InMail needs a subject; credits never go below zero")
  func inMail() {
    #expect(LinkedInInMail(nil) == nil)
    #expect(LinkedInInMail(["credits": 1]) == nil)
    let m = LinkedInInMail(["subject": "Hello", "credits": 1])
    #expect(m?.subject == "Hello")
    #expect(m?.credits == 1)
    #expect(LinkedInInMail(["subject": "Hello", "credits": -3])?.credits == 0)
    #expect(LinkedInInMail(["subject": "Hello"])?.credits == 0)
  }

  @Test("commercial payloads read three kinds and refuse the rest")
  func commercial() {
    #expect(LinkedInCommercial(["kind": "sponsored"])?.kind == .sponsored)
    #expect(LinkedInCommercial(["kind": "recruiter"])?.kind == .recruiter)
    #expect(LinkedInCommercial(["kind": "job", "fileBytes": 188_416])?.fileBytes == 188_416)
    #expect(LinkedInCommercial(["kind": "event"]) == nil)
    #expect(LinkedInCommercial(nil) == nil)
    #expect(LinkedInCommercialKind.allCases.map(\.tag) == ["SPONSORED", "RECRUITER", "JOB"])
  }

  @Test("InMail caps: 200 and 2000, clamped at the cap")
  func caps() {
    #expect(LinkedInCaps.subject == 200)
    #expect(LinkedInCaps.body == 2000)
    let long = String(repeating: "a", count: 250)
    #expect(LinkedInCaps.clamp(long, LinkedInCaps.subject).count == 200)
    #expect(LinkedInCaps.left(long, LinkedInCaps.subject) == 0)
    #expect(LinkedInCaps.left("abc", LinkedInCaps.subject) == 197)
  }

  // MARK: thread meta defaults

  @Test("absent meta reads safe defaults: personal, Focused, no request, no composer")
  func threadDefaults() {
    let m = LinkedInThreadMeta(meta: nil)
    #expect(m.inbox == .personal)
    #expect(m.category == .focused)
    #expect(m.requestState == .none)
    #expect(m.rung == .none)
    #expect(m.degree == nil && m.headline == nil && m.alsoReachable == nil)
    #expect(m.history.isEmpty)
    #expect(m.historyRows.map(\.channel) == [.linkedin, .email, .whatsapp, .imessage])
    #expect(m.historyRows.allSatisfy { $0.line == nil })
    #expect(!m.capabilities.canReply)
  }

  // MARK: status meta

  @Test("status meta: dated counters per inbox, and the pause")
  func statusMeta() throws {
    let calm = try Self.body(StatusPayload.self, Self.dir + "status.json")
    let s = LinkedInStatusMeta(status: calm)
    #expect(!s.paused)
    #expect(s.pausedUntil == nil)
    #expect(s.account == "Avery Park")
    #expect(s.plan == "Business")
    #expect(s.sendsLeft == 14)
    #expect(s.asOf != nil && s.resetsAt != nil)
    #expect(s.credits == [.personal: 4, .salesNav: 38, .recruiter: 21])
    #expect(s.unread == [.personal: 3, .salesNav: 1, .recruiter: 1])
    #expect(s.totalUnread == 5)
    let hot = LinkedInStatusMeta(status: try Self.body(StatusPayload.self, Self.paused + "status.json"))
    #expect(hot.paused)
    #expect(hot.pausedUntil != nil)
    #expect(hot.credits == s.credits)
  }

  @Test("a pause that does not parse still pauses; absent and null do not")
  func pauseIsSafe() {
    #expect(LinkedInStatusMeta(["pausedUntil": "soon"]).paused)
    #expect(LinkedInStatusMeta(["pausedUntil": 3]).paused)
    #expect(!LinkedInStatusMeta(["pausedUntil": nil]).paused)
    #expect(!LinkedInStatusMeta(nil).paused)
    #expect(!LinkedInStatusMeta(status: nil).paused)
  }

  // MARK: the fixtures

  @Test("preview-linkedin: seven threads, each with a page that agrees with it")
  func fixturesDecode() throws {
    let threads = try Self.threads()
    let pages = try Self.pages()
    #expect(threads.count == 7)
    #expect(pages.count == 7)
    for t in threads {
      #expect(t.channel == "linkedin", "\(t.chatGuid)")
      let page = try #require(pages[t.chatGuid], "no page for \(t.chatGuid)")
      let last = try #require(page.turns.last)
      #expect(t.lastAt == last.at)
      #expect(t.lastFromMe == (last.from == "me"))
      #expect(page.turns.map(\.at) == page.turns.map(\.at).sorted())
    }
    let metas = threads.map(LinkedInThreadMeta.init)
    #expect(Set(metas.map(\.inbox)) == Set(LinkedInInbox.allCases))
    #expect(Set(metas.map(\.category)) == Set(LinkedInCategory.allCases))
    #expect(Set(metas.map(\.rung)) == Set(LinkedInRung.allCases))
    #expect(metas.filter { $0.requestState == .pending }.count == 1)
  }

  @Test("the fixtures carry an InMail with credits, and every commercial kind")
  func fixtureTurns() throws {
    let pages = try Self.pages()
    let turns = pages.values.flatMap(\.turns).map(LinkedInTurnMeta.init)
    let inMails = turns.compactMap(\.inMail)
    #expect(inMails.count == 2)
    #expect(inMails.contains { $0.credits > 0 })
    #expect(Set(turns.compactMap { $0.commercial?.kind }) == Set(LinkedInCommercialKind.allCases))
    let contoso = try #require(pages["linkedin;-;contoso-talent"])
    #expect(LinkedInTurnMeta.commercial(in: contoso.turns)?.kind == .sponsored)
    let riya = try Self.meta("riya-kapoor")
    #expect(LinkedInComposer.resolve(riya, commercial: nil, paused: false) == .absent(.noRung))
    let priya = try Self.meta("priya-raman")
    #expect(LinkedInComposer.resolve(priya, commercial: nil, paused: false) == .absent(.requestPending))
    #expect(priya.historyRows.first { $0.channel == .email }?.line != nil)
    #expect(priya.historyRows.first { $0.channel == .whatsapp }?.line == nil)
  }
}
