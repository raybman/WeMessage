import Foundation
import Testing
@testable import WeMessageKit

/// R3: the /v1/events/sse wire against fixtures/contract/sse.
@Suite("SSEDecoder")
struct SSEDecoderTests {
  static func decodeAll(_ data: Data) -> (frames: [SSEFrame], decoder: SSEDecoder) {
    var decoder = SSEDecoder()
    let frames = decoder.feed(data)
    return (frames, decoder)
  }

  /// Feeds `data` in two pieces cut at `cut`.
  static func split(_ data: Data, at cut: Int) -> [SSEFrame] {
    var decoder = SSEDecoder()
    return decoder.feed(data.prefix(cut)) + decoder.feed(data.dropFirst(cut))
  }

  @Test("greeting.txt decodes to connection.state id 1")
  func greeting() throws {
    let (frames, decoder) = Self.decodeAll(try Fixtures.sse("greeting"))
    #expect(frames.count == 1)
    let frame = try #require(frames.first)
    #expect(frame.id == 1)
    #expect(frame.event == "connection.state")
    #expect(decoder.lastEventId == "1")
    let payload = try JSONValue.parse(Data(frame.data.utf8))
    let want: JSONValue = ["event": "connection.state", "state": "fully-connected"]
    #expect(payload == want)
    let event = try GatewayEvent(frame: frame)
    #expect(event == .connectionState(ConnectionStateEvent(state: "fully-connected")))
  }

  @Test("all 21 sse/<event>.txt decode and payload == fixtures/events")
  func allEvents() throws {
    var ids: [Int] = []
    for name in EventName.allCases.map(\.rawValue) {
      let (frames, _) = Self.decodeAll(try Fixtures.sse(name))
      #expect(frames.count == 1, "\(name): \(frames.count) frames")
      guard let frame = frames.first else { continue }
      #expect(frame.event == name)
      if let id = frame.id { ids.append(id) }

      let want = try Fixtures.event(name)
      #expect(try JSONValue.parse(Data(frame.data.utf8)) == want, "\(name): the SSE payload is not fixtures/events/\(name).json")

      let event = try GatewayEvent(frame: frame)
      #expect(event.name == name)
      #expect(event.eventName?.rawValue == name)
      if case .unknown = event { Issue.record("\(name) decoded as an unknown event") }
      let again = try JSONValue.parse(try JSONEncoder().encode(event))
      #expect(again == want, "\(name): the typed event re-encodes as \(again)")
    }
    #expect(ids == Array(2...22), "frame ids: \(ids)")
  }

  @Test("every known event refuses an unknown key at any depth and an event field that disagrees with the frame")
  func eventStrictness() throws {
    var refused = 0
    for name in EventName.allCases.map(\.rawValue) {
      let payload = try Fixtures.event(name)
      for path in payload.objectPaths() {
        let data = try payload.injecting("zzUnknown", 1, at: path).canonicalData()
        #expect(throws: GatewayError.self, "\(name) \(path.rendered)") {
          try GatewayEvent.decode(name: name, data: data)
        }
        refused += 1
      }
      let missing = try payload.replacing("event", with: .null).canonicalData()
      #expect(throws: GatewayError.self, "\(name) with a null event field") {
        try GatewayEvent.decode(name: name, data: missing)
      }
    }
    #expect(refused > 21, "injections attempted: \(refused)")

    // Same shape, other name: only the event field tells them apart.
    let expired = try Fixtures.event("draft.expired").canonicalData()
    #expect(throws: GatewayError.self) { try GatewayEvent.decode(name: "draft.requeued", data: expired) }
    #expect(throws: GatewayError.self) { try GatewayEvent.decode(name: "draft.sent", data: Data("not json".utf8)) }
  }

  @Test("an event name outside wire.json decodes to .unknown(name), never throws")
  func unknownName() throws {
    let event = try GatewayEvent.decode(name: "draft.teleported", data: Data(#"{"event":"draft.teleported","x":1}"#.utf8))
    #expect(event == .unknown(name: "draft.teleported"))
    #expect(event.eventName == nil)
    #expect(try GatewayEvent.decode(name: "message", data: Data("anything".utf8)) == .unknown(name: "message"))
  }

  @Test("keepalive.txt yields no event and resets nothing")
  func keepalive() throws {
    let keep = try Fixtures.sse("keepalive")
    var fresh = SSEDecoder()
    #expect(fresh.feed(keep).isEmpty)
    #expect(fresh.lastEventId == nil)

    var decoder = SSEDecoder()
    #expect(decoder.feed(try Fixtures.sse("greeting")).map(\.id) == [1])
    #expect(decoder.lastEventId == "1")
    #expect(decoder.feed(keep).isEmpty)
    #expect(decoder.feed(keep + keep).isEmpty)
    #expect(decoder.lastEventId == "1")
    let approved = decoder.feed(try Fixtures.sse("draft.approved"))
    #expect(approved.map(\.id) == [5])
    #expect(approved.first?.event == "draft.approved")
    #expect(decoder.lastEventId == "5")
  }

  @Test("frames split across chunk boundaries at every byte offset")
  func splits() throws {
    let whole =
      try Fixtures.sse("greeting") + Fixtures.sse("draft.created") + Fixtures.sse("keepalive")
      + Fixtures.sse("draft.sent")
    let want = Self.decodeAll(whole).frames
    #expect(want.map(\.id) == [1, 6, 14])
    #expect(want.map(\.event) == ["connection.state", "draft.created", "draft.sent"])

    for cut in 0...whole.count {
      #expect(Self.split(whole, at: cut) == want, "LF cut at \(cut)")
    }

    var bytewise = SSEDecoder()
    var oneByOne: [SSEFrame] = []
    for byte in whole { oneByOne += bytewise.feed(Data([byte])) }
    #expect(oneByOne == want, "one byte at a time")

    let text = String(decoding: whole, as: UTF8.self)
    for (label, ending) in [("CRLF", "\r\n"), ("CR", "\r")] {
      let variant = Data(text.replacingOccurrences(of: "\n", with: ending).utf8)
      #expect(Self.decodeAll(variant).frames == want, "\(label) whole")
      for cut in 0...variant.count {
        #expect(Self.split(variant, at: cut) == want, "\(label) cut at \(cut)")
      }
    }

    let edited = "id: 30\nevent: message.edited\ndata: {\"event\":\"message.edited\",\"guid\":\"g\",\"newText\":\"caf\u{E9} \u{1F600}\"}\n\n"
    let multibyte = Data(edited.utf8)
    let wantText = Self.decodeAll(multibyte).frames
    #expect(wantText.count == 1)
    #expect(wantText.first?.data.contains("caf\u{E9} \u{1F600}") == true)
    for cut in 0...multibyte.count {
      #expect(Self.split(multibyte, at: cut) == wantText, "UTF-8 cut at \(cut)")
    }
  }

  @Test("data: spanning two lines is joined with \\n")
  func multiline() {
    var two = SSEDecoder()
    #expect(two.feed(Data("data: a\ndata: b\n\n".utf8)) == [SSEFrame(id: nil, event: "message", data: "a\nb")])

    var json = SSEDecoder()
    let frames = json.feed(Data("id: 7\nevent: draft.expired\ndata: {\"event\":\"draft.expired\",\ndata: \"draftId\":\"d1\"}\n\n".utf8))
    #expect(frames == [SSEFrame(id: 7, event: "draft.expired", data: "{\"event\":\"draft.expired\",\n\"draftId\":\"d1\"}")])

    var mixed = SSEDecoder()
    let mixedFrames = mixed.feed(Data("event: x\ndata:one\ndata: two\ndata\n\n".utf8))
    #expect(mixedFrames == [SSEFrame(id: nil, event: "x", data: "one\ntwo\n")])
  }

  @Test("a blank line with no data dispatches nothing, and fields after a frame start fresh")
  func blankAndReset() {
    var decoder = SSEDecoder()
    #expect(decoder.feed(Data("event: lonely\n\n".utf8)).isEmpty)
    #expect(decoder.feed(Data("data: x\n\n".utf8)) == [SSEFrame(id: nil, event: "message", data: "x")])
    #expect(decoder.feed(Data("id: 3\nevent: a\ndata: 1\n\ndata: 2\n\n".utf8)) == [
      SSEFrame(id: 3, event: "a", data: "1"), SSEFrame(id: nil, event: "message", data: "2"),
    ])
    #expect(decoder.lastEventId == "3")
  }

  @Test("headers.json: content-type text/event-stream is required")
  func headers() async throws {
    let headers = try Repo.json("fixtures/contract/sse/headers.json")
    let contentType = try #require(headers["content-type"]?.stringValue)
    #expect(SSEDecoder.isEventStream(contentType: contentType))
    #expect(SSEDecoder.isEventStream(contentType: "text/event-stream; charset=utf-8"))
    #expect(SSEDecoder.isEventStream(contentType: "Text/Event-Stream"))
    #expect(!SSEDecoder.isEventStream(contentType: "application/json"))
    #expect(!SSEDecoder.isEventStream(contentType: "text/event-streamx"))
    #expect(!SSEDecoder.isEventStream(contentType: nil))

    let json = FakeTransport { _, _ in Reply.json(200, #"{"status":"ok"}"#) }
    do {
      for try await _ in GatewayClient.testing(json).events() {}
      Issue.record("a JSON 200 was read as an event stream")
    } catch let error as GatewayError {
      guard case .decoding(let path, _) = error else {
        Issue.record("want a content-type decoding error, got \(error)")
        return
      }
      #expect(path == "content-type")
    }

    var recorded: [String: String] = [:]
    for (key, value) in headers.objectValue ?? [:] { recorded[key] = value.stringValue }
    let fields = recorded
    let greeting = try Fixtures.sse("greeting")
    let sse = FakeTransport { _, _ in Reply(status: 200, body: greeting, headers: fields) }
    var frames: [SSEFrame] = []
    for try await frame in GatewayClient.testing(sse).events() { frames.append(frame) }
    #expect(frames.map(\.id) == [1])
  }
}
