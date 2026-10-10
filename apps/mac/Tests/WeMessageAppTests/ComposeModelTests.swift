import Foundation
import Testing
import WeMessageKit

@testable import WeMessageApp

/// v2 S4j, board 14: compose's model. Person-first: no channel and no
/// composer before a person. Rows are ordered by recency, never by name,
/// and a bare handle is never given a name. The proposal never writes the
/// input; Approve does. Send waits out the undo window and then creates a
/// pending draft, and that one POST is the only write compose can make.
@Suite("ComposeModel")
@MainActor
struct ComposeModelTests {
  /// v2 F5: what the fake daemon's by-handle route answers per handle.
  enum Found: Sendable {
    case conversation(chatGuid: String, service: String, isGroup: Bool)
    case none
    /// 503 source-unavailable.
    case unavailable
    case unreachable
  }

  /// Maya and Daniel each have an iMessage 1:1, on the daemon's own guids
  /// (macOS 26's any;-; for Maya); every other handle has nothing.
  nonisolated static let mac: [String: Found] = [
    "+15550100001": .conversation(chatGuid: "any;-;+15550100001", service: "imessage", isGroup: false),
    "+15550100002": .conversation(chatGuid: "iMessage;-;+15550100002", service: "imessage", isGroup: false),
  ]

  nonisolated static let lookupPrefix = "/v1/threads/by-handle/"

  /// The by-handle answer for `handle` under `found`.
  nonisolated static func lookup(_ handle: String, _ found: Found?) throws -> Reply {
    let conversation: Any
    switch found ?? .none {
    case .conversation(let guid, let service, let isGroup):
      conversation = ["chatGuid": guid, "service": service, "isGroup": isGroup]
    case .none: conversation = NSNull()
    case .unavailable: return try Reply.golden("errors/503.source-unavailable.json")
    case .unreachable: throw Unreachable()
    }
    let body: [String: Any] = ["handle": handle, "conversation": conversation, "asOf": "2026-09-01T12:00:00.000Z"]
    return Reply(
      status: 200, body: try JSONSerialization.data(withJSONObject: body),
      headers: ["Content-Type": "application/json"])
  }

  /// A model over a fake daemon that answers the create golden and the
  /// by-handle lookup from `mac`, an instant undo window unless `tick` says
  /// otherwise, and the transport.
  static func model(
    failing: Bool = false, mac: [String: Found] = Self.mac,
    delay: @escaping @Sendable (String) -> Void = { _ in },
    tick: @escaping @Sendable () async throws -> Void = {}
  ) -> (ComposeModel, FakeTransport) {
    let transport = FakeTransport { request in
      let path = request.url?.path ?? ""
      if request.httpMethod ?? "GET" == "GET", path.hasPrefix(Self.lookupPrefix) {
        let handle = String(path.dropFirst(Self.lookupPrefix.count))
        delay(handle)
        return try Self.lookup(handle, mac[handle])
      }
      switch (request.httpMethod ?? "GET", path) {
      case ("POST", "/v1/drafts"):
        if failing { throw Unreachable() }
        return try Reply.golden("responses/drafts.create.json")
      default: throw Unreachable()
      }
    }
    let model = ComposeModel(
      client: testClient(transport), people: FixtureCompose.people,
      propose: { FixtureCompose.proposal(for: $0) }, tick: tick)
    return (model, transport)
  }

  static func calls(_ transport: FakeTransport) -> [String] {
    transport.requests.map { ($0.httpMethod ?? "GET") + " " + ($0.url?.path ?? "") }
  }

  /// The writes only: the lookup is a read.
  static func writes(_ transport: FakeTransport) -> [String] {
    calls(transport).filter { !$0.hasPrefix("GET ") }
  }

  /// Chooses `id` and waits for the lookup.
  static func chosen(_ model: ComposeModel, _ id: String) async {
    model.choose(person(id))
    await model.lookedUp()
  }

  static func person(_ id: String) -> ComposePerson {
    FixtureCompose.people.first { $0.id == id }!
  }

  @Test("no person: no channel, no banner, no composer, and nothing to send")
  func nothingBeforeAPerson() {
    let (model, transport) = Self.model()
    #expect(model.person == nil)
    #expect(model.channels.isEmpty)
    #expect(model.defaultChannel == nil)
    #expect(model.banner == nil)
    #expect(model.chatGuid == nil)
    model.body = "hello"
    #expect(!model.canSend)
    model.send()
    #expect(model.phase == .composing)
    #expect(transport.requests.isEmpty)
  }

  @Test("resolution: name or handle digits, ordered by last exchange, never alphabetically; a handle keeps no name")
  func resolution() {
    let (model, _) = Self.model()
    model.query = "a"
    #expect(model.matches.map(\.id) == ["daniel", "maya", "marta"])
    model.query = "MA"
    #expect(model.matches.map(\.id) == ["maya", "marta"], "alphabetical would put Marta first")
    model.query = "0100007"
    let handle = model.matches
    #expect(handle.map(\.id) == ["handle0007"])
    #expect(handle.first?.name == nil)
    #expect(handle.first?.title == "+1 555 010 0007")
    model.query = "55"
    #expect(model.matches.isEmpty, "two digits match no handle")
    #expect(FixtureCompose.people.allSatisfy { !$0.evidence.isEmpty })
    model.query = "ma"
    model.choose(Self.person("maya"))
    #expect(model.query == "")
    #expect(model.matches.isEmpty, "rows go once a person is chosen")
  }

  @Test("a person with a handle: iMessage is the default and the banner names it and the handle; the rest are not connected")
  func defaultChannel() async {
    let (model, _) = Self.model()
    await Self.chosen(model, "maya")
    #expect(model.channels.map(\.channel) == [.imessage, .whatsapp, .linkedin, .email])
    #expect(model.channels.map(\.kind) == [.default, .notConnected, .notConnected, .notConnected])
    #expect(model.defaultChannel == .imessage)
    #expect(model.chatGuid == "any;-;+15550100001")
    #expect(model.banner == "Sending on iMessage to +1 555 010 0001 \u{00B7} free")
    #expect(ComposeModel.bannerTail.contains("Needs You"))
  }

  @Test("a person with no handle: no default, no banner, no composer; iMessage says no handle, not unreachable")
  func noHandle() {
    let (model, transport) = Self.model()
    model.choose(Self.person("marta"))
    #expect(model.resolution == .idle, "a person with no handle was looked up")
    #expect(model.refusal == nil)
    #expect(model.defaultChannel == nil)
    #expect(model.banner == nil)
    #expect(model.channels.first?.kind == .noHandle)
    #expect(model.channels.first?.detail.contains("which we have not checked") == true)
    model.askForDraft()
    #expect(model.proposal == .empty)
    model.body = "hi"
    #expect(!model.canSend)
    #expect(transport.requests.isEmpty)
  }

  @Test("the strip: twelve slots in one order, Emoji the only one iMessage can do here, the rest struck")
  func strip() {
    let slots = ComposeModel.capabilities
    #expect(slots.map(\.title) == [
      "Attach", "Emoji", "Rich text", "Quote-reply", "Voice note", "Send reaction",
      "Edit after send", "Unsend", "Envelope", "Typing shown", "Send later", "Hold until",
    ])
    #expect(slots.filter(\.can).map(\.id) == ["emoji"])
  }

  @Test("D-UI-101: no label compose speaks repeats the role 'text', and the strip still shows 14.C's words")
  func noLabelRepeatsItsRole() async {
    // The audit fails "Label duplicates role description" on a static text
    // whose label says "text" (run 37781688313).
    let (model, _) = Self.model(mac: Self.mac.merging([
      "+15550100007": .conversation(chatGuid: "SMS;-;+15550100007", service: "sms", isGroup: false)
    ]) { a, _ in a })
    model.choose(Self.person("maya"))
    var spoken = model.channels.map { $0.headline + " " + $0.detail }
    await model.lookedUp()
    spoken += ComposeModel.capabilities.map(\.spoken)
    spoken += model.channels.map { $0.headline + " " + $0.detail }
    // v2 F5: the refusals the card and the line can say.
    for id in ["handle0007", "daniel"] {
      model.clearPerson()
      await Self.chosen(model, id)
      spoken += model.channels.map { $0.headline + " " + $0.detail }
      spoken += [model.refusal].compactMap { $0 }
    }
    spoken += SendState.allCases.map(\.caption)
    for label in spoken {
      #expect(!label.lowercased().contains("text"), "\(label)")
    }
    #expect(ComposeModel.capabilities.first { $0.id == "richtext" }?.title == "Rich text")
    #expect(ComposeModel.capabilities.first { $0.id == "richtext" }?.spoken == "Rich formatting")
  }

  @Test("the proposal never touches the input; Approve moves it, Hold drops it, and the input is untouched")
  func proposal() async {
    let (model, transport) = Self.model()
    await Self.chosen(model, "maya")
    model.body = "typed by hand"
    model.askForDraft()
    #expect(model.proposal == .ready("Saturday works for me. Same trailhead at 9?"))
    #expect(model.body == "typed by hand", "the proposal wrote the input")
    model.dropProposal()
    #expect(model.proposal == .empty)
    #expect(model.body == "typed by hand")
    model.body = ""
    model.askForDraft()
    #expect(model.body == "")
    model.takeProposal()
    #expect(model.body == "Saturday works for me. Same trailhead at 9?")
    #expect(model.proposal == .moved("Saturday works for me. Same trailhead at 9?"))
    #expect(Self.writes(transport).isEmpty, "the proposal reached the daemon")
  }

  /// Counts ticks across the model's task.
  actor Ticks {
    var count = 0
    func bump() -> Int {
      count += 1
      return count
    }
  }

  @Test("the window is real: a tick in, nothing is written yet, and Undo still holds")
  func windowRuns() async throws {
    // The first tick passes at once; the second holds until cancelled, so
    // the window is provably open and a tick in, with no timing guess.
    let ticks = Ticks()
    let (model, transport) = Self.model(tick: {
      if await ticks.bump() > 1 { try await Task.sleep(nanoseconds: 30_000_000_000) }
    })
    await Self.chosen(model, "maya")
    model.body = "On my way."
    model.send()
    for _ in 0..<200 where model.phase != .undo(secondsLeft: 3) {
      try await Task.sleep(nanoseconds: 10_000_000)
    }
    #expect(model.phase == .undo(secondsLeft: 3), "the window did not tick: \(model.phase)")
    #expect(Self.writes(transport).isEmpty, "wrote inside the window: \(Self.calls(transport))")
    model.undo()
    await model.settle()
    try await Task.sleep(nanoseconds: 100_000_000)
    #expect(Self.writes(transport).isEmpty, "undo a tick in still wrote: \(Self.calls(transport))")
    #expect(model.phase == .composing)
  }

  @Test("Send then Undo inside the window: nothing is written and the text is back")
  func undoWritesNothing() async throws {
    let (model, transport) = Self.model(tick: { try await Task.sleep(nanoseconds: 100_000_000) })
    await Self.chosen(model, "maya")
    model.body = "On my way."
    model.send()
    #expect(model.phase == .undo(secondsLeft: 4))
    #expect(model.busy)
    #expect(!model.canSend)
    model.undo()
    #expect(model.phase == .composing)
    try await Task.sleep(nanoseconds: 700_000_000)
    #expect(Self.writes(transport).isEmpty, "undo still wrote: \(Self.calls(transport))")
    #expect(model.body == "On my way.")
    #expect(model.phase == .composing)
  }

  @Test("Send after the window: exactly one POST /v1/drafts on the person's chat, a pending draft, and never a send")
  func sendCreatesADraft() async throws {
    let (model, transport) = Self.model()
    await Self.chosen(model, "maya")
    model.body = "On my way."
    model.send()
    await model.settle()
    #expect(Self.calls(transport) == ["GET /v1/threads/by-handle/+15550100001", "POST /v1/drafts"])
    #expect(model.phase == .drafted("id-0001"))
    #expect(model.sending == "On my way.")
    #expect(model.body == "", "the input still holds what went to Needs You")
    let sent = try #require(transport.requests.last?.httpBody)
    let json = try #require(try JSONSerialization.jsonObject(with: sent) as? [String: Any])
    #expect(json["chatGuid"] as? String == "any;-;+15550100001", "the draft is not on the daemon's guid")
    #expect(json["body"] as? String == "On my way.")
  }

  @Test("a daemon that refuses the create: failed, in words, the text kept, and nothing retried")
  func failure() async {
    let (model, transport) = Self.model(failing: true)
    await Self.chosen(model, "daniel")
    model.body = "Running late."
    model.send()
    await model.settle()
    #expect(model.phase == .failed(ComposeModel.failure))
    #expect(model.body == "Running late.")
    #expect(Self.writes(transport) == ["POST /v1/drafts"])
    #expect(model.canSend, "a failed create cannot be tried again by hand")
  }

  @Test("the six send states: dashed before sent, filled only when sent, dotted when failed")
  func sendStates() {
    #expect(SendState.allCases.map(\.rawValue) == ["composed", "undo", "queued", "sending", "sent", "failed"])
    #expect(SendState.allCases.map(\.border) == [.none, .dashed, .dashed, .dashed, .filled, .dotted])
    #expect(SendState.allCases.filter { $0.border == .filled } == [.sent])
    #expect(SendState.allCases.allSatisfy { !$0.caption.isEmpty && !$0.tag.isEmpty })
    #expect(ComposeModel.undoSeconds == 4)
  }

  // MARK: v2 F5, a new conversation by handle

  /// A typed handle as the row compose draws for it.
  static func typed(_ model: ComposeModel, _ query: String) -> ComposePerson? {
    model.query = query
    return model.typed
  }

  @Test("v2 F5: an existing iMessage 1:1 drafts on the guid the daemon named, URL-encoded on the way out, never a synthesised iMessage;-;")
  func testExistingUsesDaemonGuid() async throws {
    let (model, transport) = Self.model()
    model.choose(Self.person("maya"))
    #expect(model.resolution == .checking)
    #expect(model.chatGuid == nil, "a guid before the daemon answered")
    await model.lookedUp()
    #expect(model.resolution == .existing(chatGuid: "any;-;+15550100001"))
    #expect(model.chatGuid == "any;-;+15550100001")
    #expect(model.refusal == nil)
    let raw = try #require(transport.requests.first?.url?.absoluteString)
    #expect(raw.hasSuffix("/v1/threads/by-handle/%2B15550100001"), "\(raw)")
    model.body = "On my way."
    model.send()
    await model.settle()
    let sent = try #require(transport.requests.last?.httpBody)
    let json = try #require(try JSONSerialization.jsonObject(with: sent) as? [String: Any])
    #expect(json["chatGuid"] as? String == "any;-;+15550100001")
  }

  @Test("v2 F5: no conversation on this Mac: refused in words before any draft; Send and opt-cmd-D both refuse; the card says why")
  func testNoConversationRefusesSendAndProposal() async throws {
    let (model, transport) = Self.model()
    let typed = try #require(Self.typed(model, "+15550100099"))
    model.choose(typed)
    #expect(model.channels.first?.kind == .checking)
    #expect(model.channels.first?.headline == ProvisionalUI.composeChecking)
    #expect(!model.canSend)
    await model.lookedUp()
    #expect(model.resolution == .none)
    let words = ProvisionalUI.composeNoConversation("+1 555 010 0099")
    #expect(model.refusal == words.headline + " " + words.detail)
    #expect(model.refusal?.hasPrefix("No conversation with +1 555 010 0099 on this Mac yet.") == true)
    #expect(model.channels.first?.kind == .noConversation)
    #expect(model.channels.first?.headline == words.headline)
    #expect(model.defaultChannel == nil)
    #expect(model.banner == nil)
    #expect(model.chatGuid == nil)
    model.body = "hi"
    #expect(!model.canSend)
    model.send()
    model.askForDraft()
    #expect(model.proposal == .empty, "opt-cmd-D drafted where Send is refused")
    #expect(model.phase == .composing)
    #expect(Self.writes(transport).isEmpty, "\(Self.calls(transport))")
  }

  @Test("v2 F5: an SMS-only 1:1 has no default channel (never one that costs), and so does RCS or a service never recorded")
  func testSmsOnlyHasNoDefaultChannel() async {
    for service in ["sms", "rcs", "unknown"] {
      let (model, transport) = Self.model(mac: [
        "+15550100002": .conversation(chatGuid: "SMS;-;+15550100002", service: service, isGroup: false)
      ])
      await Self.chosen(model, "daniel")
      #expect(model.resolution == .smsOnly, "\(service)")
      #expect(model.defaultChannel == nil, "\(service)")
      #expect(model.chatGuid == nil, "\(service)")
      #expect(model.refusal == ProvisionalUI.composeSMSOnly.headline + " " + ProvisionalUI.composeSMSOnly.detail)
      model.body = "hi"
      #expect(!model.canSend)
      model.send()
      #expect(Self.writes(transport).isEmpty)
    }
  }

  @Test("v2 F5: a handle only in group threads is refused: compose writes 1:1 only")
  func testGroupOnlyRefuses() async {
    let (model, transport) = Self.model(mac: [
      "+15550100002": .conversation(chatGuid: "iMessage;+;chat000000000000000001", service: "imessage", isGroup: true)
    ])
    await Self.chosen(model, "daniel")
    #expect(model.resolution == .groupOnly)
    let words = ProvisionalUI.composeGroupOnly("+1 555 010 0002")
    #expect(model.refusal == words.headline + " " + words.detail)
    #expect(model.chatGuid == nil, "a group guid reached the composer")
    model.body = "hi"
    #expect(!model.canSend)
    model.askForDraft()
    #expect(model.proposal == .empty)
    #expect(Self.writes(transport).isEmpty)
  }

  /// Fails every lookup until `heal` is called.
  final class Flaky: @unchecked Sendable {
    private let lock = NSLock()
    private var healed = false
    func heal() { lock.withLock { healed = true } }
    var ok: Bool { lock.withLock { healed } }
  }

  @Test("v2 F5: a failed check is refused and says nothing was sent; choosing again asks again")
  func testUnavailableThenRechooseRetries() async {
    for broken in [Found.unavailable, .unreachable] {
      let flaky = Flaky()
      let mac = Self.mac
      let healing = FakeTransport { request in
        let path = request.url?.path ?? ""
        let handle = String(path.dropFirst(Self.lookupPrefix.count))
        return try Self.lookup(handle, flaky.ok ? mac[handle] : broken)
      }
      let live = ComposeModel(
        client: testClient(healing), people: FixtureCompose.people,
        propose: { FixtureCompose.proposal(for: $0) }, tick: {})
      await Self.chosen(live, "maya")
      #expect(live.resolution == .unavailable, "\(broken)")
      #expect(live.refusal == ProvisionalUI.composeCheckFailed)
      #expect(live.channels.first?.kind == .noConversation)
      #expect(!live.canSend)
      flaky.heal()
      live.clearPerson()
      #expect(live.resolution == .idle)
      await Self.chosen(live, "maya")
      #expect(live.resolution == .existing(chatGuid: "any;-;+15550100001"), "re-choosing did not retry")
      #expect(healing.requests.map { $0.httpMethod ?? "GET" } == ["GET", "GET"])
    }
  }

  @Test("v2 F5: a slow answer for a person since replaced is dropped")
  func testStaleLookupDropped() async throws {
    let (model, _) = Self.model(
      mac: Self.mac.merging(["+15550100001": .conversation(chatGuid: "SMS;-;+15550100001", service: "sms", isGroup: false)]) { _, b in b },
      delay: { handle in if handle == "+15550100001" { usleep(300_000) } })
    model.choose(Self.person("maya"))
    // Let Maya's lookup reach the daemon before Daniel replaces her.
    try await Task.sleep(nanoseconds: 50_000_000)
    model.choose(Self.person("daniel"))
    await model.lookedUp()
    #expect(model.resolution == .existing(chatGuid: "iMessage;-;+15550100002"))
    // Maya's answer lands after Daniel's, and must not win.
    try await Task.sleep(nanoseconds: 600_000_000)
    #expect(model.person?.id == "daniel")
    #expect(model.resolution == .existing(chatGuid: "iMessage;-;+15550100002"), "a stale answer replaced Daniel's")
    #expect(model.chatGuid == "iMessage;-;+15550100002")
  }

  @Test("v2 F5: only + and 8 to 15 digits, or an address, is a typed handle; it gets one row, first, # and never a name")
  func testTypedHandleOnlyForPlusOrEmail() throws {
    #expect(ComposeModel.typedHandle("+15550100099") == "+15550100099")
    #expect(ComposeModel.typedHandle(" +1 (555) 010-0099 ") == "+15550100099")
    #expect(ComposeModel.typedHandle("Sam@Example.com") == "sam@example.com")
    for no in [
      "5550100099", "15550100099", "+1555010", "+1555010009912345", "+1555a100099", "+", "sam@", "@example.com",
      "sam@example", "sam@.com", "sam @example.com", "a;b@example.com", "maya", "",
    ] {
      #expect(ComposeModel.typedHandle(no) == nil, "\(no)")
    }
    let (model, _) = Self.model()
    let row = try #require(Self.typed(model, "+15550100099"))
    #expect(row.id == "typed:+15550100099")
    #expect(row.name == nil, "a typed handle was given a name")
    #expect(row.initials == ProvisionalUI.composeTypedInitials)
    #expect(row.title == "+1 555 010 0099")
    #expect(row.title + " \u{00B7} " + row.evidence == "+1 555 010 0099 \u{00B7} not in Contacts \u{00B7} typed")
    #expect(model.matches.isEmpty)
    #expect(model.hint == nil)
    // A handle a person already has is that person's row, not a typed one.
    #expect(Self.typed(model, "+15550100001") == nil)
    #expect(model.matches.map(\.id) == ["maya"])
    #expect(Self.typed(model, "sam@example.com")?.imessage == "sam@example.com")
    #expect(Self.typed(model, "maya") == nil)
  }

  @Test("v2 F5: ten bare digits get the country-code hint and no row; the code is never guessed")
  func testBareTenDigitsGetsHint() {
    let (model, transport) = Self.model()
    model.query = "5550100099"
    #expect(model.typed == nil)
    #expect(model.matches.isEmpty)
    #expect(model.hint == ProvisionalUI.composeCountryCodeHint)
    model.query = "+15550100099"
    #expect(model.hint == nil)
    #expect(model.typed != nil)
    model.query = "555010009"
    #expect(model.hint == nil, "nine digits are not a bare number")
    // Ten digits that are someone's are that someone.
    model.query = "5550100001"
    #expect(model.matches.map(\.id) == ["maya"])
    #expect(model.hint == nil)
    #expect(transport.requests.isEmpty, "typing looked something up")
  }

  @Test("phone numbers print in groups; anything else as given")
  func printing() {
    #expect(ComposeModel.printed("+15550100001") == "+1 555 010 0001")
    #expect(ComposeModel.printed("sam.whitfield@example.com") == "sam.whitfield@example.com")
  }
}
