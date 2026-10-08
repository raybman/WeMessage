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
  /// A model over a fake daemon that answers the create golden, an instant
  /// undo window unless `tick` says otherwise, and the transport.
  static func model(
    failing: Bool = false, tick: @escaping @Sendable () async throws -> Void = {}
  ) -> (ComposeModel, FakeTransport) {
    let transport = FakeTransport { request in
      let path = request.url?.path ?? ""
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
  func defaultChannel() {
    let (model, _) = Self.model()
    model.choose(Self.person("maya"))
    #expect(model.channels.map(\.channel) == [.imessage, .whatsapp, .linkedin, .email])
    #expect(model.channels.map(\.kind) == [.default, .notConnected, .notConnected, .notConnected])
    #expect(model.defaultChannel == .imessage)
    #expect(model.chatGuid == "iMessage;-;+15550100001")
    #expect(model.banner == "Sending on iMessage to +1 555 010 0001 \u{00B7} free")
    #expect(ComposeModel.bannerTail.contains("Needs You"))
  }

  @Test("a person with no handle: no default, no banner, no composer; iMessage says no handle, not unreachable")
  func noHandle() {
    let (model, _) = Self.model()
    model.choose(Self.person("marta"))
    #expect(model.defaultChannel == nil)
    #expect(model.banner == nil)
    #expect(model.channels.first?.kind == .noHandle)
    #expect(model.channels.first?.detail.contains("which we have not checked") == true)
    model.askForDraft()
    #expect(model.proposal == .empty)
    model.body = "hi"
    #expect(!model.canSend)
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

  @Test("the proposal never touches the input; Approve moves it, Hold drops it, and the input is untouched")
  func proposal() {
    let (model, transport) = Self.model()
    model.choose(Self.person("maya"))
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
    #expect(transport.requests.isEmpty, "the proposal reached the daemon")
  }

  @Test("Send then Undo inside the window: nothing is written and the text is back")
  func undoWritesNothing() async throws {
    let (model, transport) = Self.model(tick: { try await Task.sleep(nanoseconds: 100_000_000) })
    model.choose(Self.person("maya"))
    model.body = "On my way."
    model.send()
    #expect(model.phase == .undo(secondsLeft: 4))
    #expect(model.busy)
    #expect(!model.canSend)
    model.undo()
    #expect(model.phase == .composing)
    try await Task.sleep(nanoseconds: 700_000_000)
    #expect(transport.requests.isEmpty, "undo still wrote: \(Self.calls(transport))")
    #expect(model.body == "On my way.")
    #expect(model.phase == .composing)
  }

  @Test("Send after the window: exactly one POST /v1/drafts on the person's chat, a pending draft, and never a send")
  func sendCreatesADraft() async throws {
    let (model, transport) = Self.model()
    model.choose(Self.person("maya"))
    model.body = "On my way."
    model.send()
    await model.settle()
    #expect(Self.calls(transport) == ["POST /v1/drafts"])
    #expect(model.phase == .drafted("id-0001"))
    #expect(model.sending == "On my way.")
    #expect(model.body == "", "the input still holds what went to Needs You")
    let sent = try #require(transport.requests.first?.httpBody)
    let json = try #require(try JSONSerialization.jsonObject(with: sent) as? [String: Any])
    #expect(json["chatGuid"] as? String == "iMessage;-;+15550100001")
    #expect(json["body"] as? String == "On my way.")
  }

  @Test("a daemon that refuses the create: failed, in words, the text kept, and nothing retried")
  func failure() async {
    let (model, transport) = Self.model(failing: true)
    model.choose(Self.person("daniel"))
    model.body = "Running late."
    model.send()
    await model.settle()
    #expect(model.phase == .failed(ComposeModel.failure))
    #expect(model.body == "Running late.")
    #expect(Self.calls(transport) == ["POST /v1/drafts"])
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

  @Test("phone numbers print in groups; anything else as given")
  func printing() {
    #expect(ComposeModel.printed("+15550100001") == "+1 555 010 0001")
    #expect(ComposeModel.printed("sam.whitfield@example.com") == "sam.whitfield@example.com")
  }
}
