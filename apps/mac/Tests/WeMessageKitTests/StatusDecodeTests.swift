import Foundation
import Testing
@testable import WeMessageKit

/// v2 F7d: status grows the facts the window needs (lastSyncAt, today and
/// handle on the iMessage entry; asOf and mirror at the top). Every status a
/// scenario or an older daemon sends without them still decodes, a key the
/// kit does not know still throws, and the new shape round-trips exactly.
@Suite("Status decode")
struct StatusDecodeTests {
  static func decode(_ text: String) throws -> StatusPayload {
    try JSONDecoder().decode(StatusPayload.self, from: Data(text.utf8))
  }

  static func scenarioStatusFiles() throws -> [String] {
    try Repo.files(under: "fixtures/scenarios/").filter { $0.hasSuffix("/responses/status.json") }
  }

  /// The shape the F7 daemon sends: synthetic numbers only.
  static let withFacts = """
    {"connectionState":"fully-connected","cursor":{"lastRowid":42,"lastScanAt":"2026-09-02T14:02:11.000Z"},
    "counts":{"messagesToday":7},"adapters":[],"killSwitch":false,
    "armed":{"armed":true,"until":null,"reason":"armed"},
    "channels":[
      {"channel":"imessage","state":"connected","lastSyncAt":"2026-09-02T14:02:11.000Z","today":7,"handle":"+15550100000"},
      {"channel":"whatsapp","state":"not_connected","reason":"not_in_this_version"}],
    "asOf":"2026-09-02T14:02:12.000Z",
    "mirror":{"path":"~/Library/Application Support/WeMessage/wemessage.db","bytes":186646528,
      "messages":527147,"chats":3953,"historyFrom":"2014-03-02T09:00:00.000Z","phase":"indexing",
      "indexed":217300,"eligible":530000,"countedAt":"2026-09-02T14:02:00.000Z"}}
    """

  @Test("every scenario status without the F7 facts still decodes, with the facts absent")
  func oldStatusWithoutFactsDecodes() throws {
    let files = try Self.scenarioStatusFiles()
    #expect(files.count >= 18, "scenario status files: \(files.count)")
    var stripped = 0
    for rel in files {
      var json = try Repo.json("fixtures/scenarios/" + rel)
      guard case .object(var top) = json, case .object(var body)? = top["body"] else {
        Issue.record("\(rel): want {body}")
        continue
      }
      // Strip anything F7 added so the row always proves the old shape.
      body["asOf"] = nil
      body["mirror"] = nil
      if case .array(let channels)? = body["channels"] {
        body["channels"] = .array(
          channels.map { entry in
            guard case .object(var e) = entry else { return entry }
            e["lastSyncAt"] = nil
            e["today"] = nil
            e["handle"] = nil
            return .object(e)
          })
      }
      top["body"] = .object(body)
      json = .object(top)
      do {
        let data = try (json["body"] ?? .null).canonicalData()
        let status = try JSONDecoder().decode(StatusPayload.self, from: data)
        #expect(status.asOf == nil, "\(rel)")
        #expect(status.mirror == nil, "\(rel)")
        for entry in status.channels {
          #expect(entry.lastSyncAt == nil && entry.today == nil && entry.handle == nil, "\(rel)")
        }
        stripped += 1
      } catch {
        Issue.record("\(rel): the old shape does not decode: \(error)")
      }
    }
    #expect(stripped >= 18, "old-shape statuses decoded: \(stripped)")
  }

  @Test("a channel key the kit does not know still throws")
  func unknownChannelKeyStillThrows() {
    let text = """
      {"connectionState":"fully-connected","cursor":null,"counts":{"messagesToday":0},"adapters":[],
      "killSwitch":false,"armed":null,
      "channels":[{"channel":"imessage","state":"connected","today":0,"lastSyncAt":null,"handle":null,"owner":"x"}]}
      """
    #expect(throws: DecodingError.self) { try Self.decode(text) }
  }

  @Test("a mirror key the kit does not know still throws")
  func unknownMirrorKeyStillThrows() throws {
    let text = Self.withFacts.replacingOccurrences(of: "\"countedAt\"", with: "\"absPath\":\"x\",\"countedAt\"")
    #expect(throws: DecodingError.self) { try Self.decode(text) }
  }

  @Test("the F7 facts decode and the shape re-encodes to the same JSON")
  func factsRoundTrip() throws {
    let status = try Self.decode(Self.withFacts)
    let imessage = try #require(status.channels.first)
    #expect(imessage.lastSyncAt == "2026-09-02T14:02:11.000Z")
    #expect(imessage.today == 7)
    #expect(imessage.handle == "+15550100000")
    #expect(status.channels[1].today == nil)
    #expect(status.asOf == "2026-09-02T14:02:12.000Z")
    let mirror = try #require(status.mirror)
    #expect(mirror.path.hasPrefix("~/"))
    #expect(mirror.bytes == 186_646_528)
    #expect(mirror.messages == 527_147 && mirror.chats == 3953)
    #expect(mirror.historyFrom == "2014-03-02T09:00:00.000Z")
    #expect(mirror.phase == "indexing" && mirror.indexed == 217_300 && mirror.eligible == 530_000)

    let again = try JSONValue.parse(try JSONEncoder().encode(status))
    let want = try JSONValue.parse(Data(Self.withFacts.utf8))
    #expect(again == want)
  }

  @Test("a connected entry with null lastSyncAt and handle keeps both keys as null on re-encode")
  func nullFactsStayPresent() throws {
    let text = """
      {"connectionState":"fully-connected","cursor":null,"counts":{"messagesToday":0},"adapters":[],
      "killSwitch":false,"armed":null,
      "channels":[{"channel":"imessage","state":"connected","lastSyncAt":null,"today":0,"handle":null}],
      "asOf":"2026-09-02T14:02:12.000Z",
      "mirror":{"path":"~/x/wemessage.db","bytes":0,"messages":0,"chats":0,"historyFrom":null,
        "phase":"empty","indexed":0,"eligible":0,"countedAt":"2026-09-02T14:02:12.000Z"}}
      """
    let status = try Self.decode(text)
    #expect(status.channels[0].today == 0)
    #expect(status.channels[0].handle == nil)
    let again = try JSONValue.parse(try JSONEncoder().encode(status))
    #expect(again == (try JSONValue.parse(Data(text.utf8))))
  }
}
