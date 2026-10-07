import Foundation
import WeMessageKit

// A trimmed copy of Tests/WeMessageKitTests/Support/FakeTransport.swift: a
// test target cannot depend on another test target's sources (plan §4.4).
// Only what ShellModelTests needs: scripted replies over the public
// Transport seam, and an event stream that can stay open.

/// One scripted HTTP answer.
struct Reply: Sendable {
  var status: Int
  var body: Data
  var headers: [String: String]
  /// For a stream: keep it open after the body, as a live daemon does.
  var holdOpen: Bool

  init(status: Int, body: Data = Data(), headers: [String: String] = [:], holdOpen: Bool = false) {
    self.status = status
    self.body = body
    self.headers = headers
    self.holdOpen = holdOpen
  }

  /// fixtures/contract/<rel>: its status and its body, re-encoded.
  static func golden(_ rel: String) throws -> Reply {
    let data = try Data(contentsOf: try Repo.url("fixtures/contract/" + rel))
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      let status = object["status"] as? Int, let body = object["body"]
    else { throw Repo.Missing(path: rel) }
    return Reply(
      status: status,
      body: try JSONSerialization.data(withJSONObject: body, options: [.fragmentsAllowed]),
      headers: ["Content-Type": "application/json"])
  }

  /// fixtures/scenarios/<name>/responses/<file>, or the same file from the
  /// scenario it extends (scenario.json "extends"), as the fake daemon
  /// serves it.
  static func scenario(_ name: String, _ file: String) throws -> Reply {
    let dir = "fixtures/scenarios/" + name + "/"
    if let url = try? Repo.url(dir + "responses/" + file), FileManager.default.fileExists(atPath: url.path) {
      let data = try Data(contentsOf: url)
      guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
        let status = object["status"] as? Int, let body = object["body"]
      else { throw Repo.Missing(path: dir + file) }
      return Reply(
        status: status,
        body: try JSONSerialization.data(withJSONObject: body, options: [.fragmentsAllowed]),
        headers: ["Content-Type": "application/json"])
    }
    let meta = try Data(contentsOf: try Repo.url(dir + "scenario.json"))
    guard let parent = (try JSONSerialization.jsonObject(with: meta) as? [String: Any])?["extends"] as? String else {
      return try golden("responses/" + file)
    }
    return try scenario(parent, file)
  }

  /// A 200 event stream carrying fixtures/contract/sse/<name>, held open.
  static func sse(_ name: String) throws -> Reply {
    Reply(
      status: 200, body: try Data(contentsOf: try Repo.url("fixtures/contract/sse/" + name)),
      headers: ["Content-Type": "text/event-stream"], holdOpen: true)
  }

  func response(for request: URLRequest) -> HTTPURLResponse {
    HTTPURLResponse(
      url: request.url ?? URL(string: "http://127.0.0.1")!,
      statusCode: status,
      httpVersion: "HTTP/1.1",
      headerFields: headers
    )!
  }
}

/// Answers each request from `handler(request)`. The handler may throw to
/// play an unreachable daemon.
final class FakeTransport: Transport, @unchecked Sendable {
  typealias Handler = @Sendable (URLRequest) throws -> Reply

  private let lock = NSLock()
  private var recorded: [URLRequest] = []
  private let handler: Handler

  init(_ handler: @escaping Handler) { self.handler = handler }

  var requests: [URLRequest] { lock.withLock { recorded } }

  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    lock.withLock { recorded.append(request) }
    let reply = try handler(request)
    return (reply.body, reply.response(for: request))
  }

  func stream(_ request: URLRequest) async throws -> (AsyncThrowingStream<Data, any Error>, HTTPURLResponse) {
    lock.withLock { recorded.append(request) }
    let reply = try handler(request)
    let body = reply.body
    let hold = reply.holdOpen
    let chunks = AsyncThrowingStream<Data, any Error> { continuation in
      if !body.isEmpty { continuation.yield(body) }
      if !hold { continuation.finish() }
    }
    return (chunks, reply.response(for: request))
  }
}

/// A client over `transport` whose token comes from a fixed in-memory file.
/// The token is built at runtime so no source spells a prefixed hex run.
func testClient(_ transport: FakeTransport) -> GatewayClient {
  let token = "wm_" + String(repeating: "a", count: 64)
  return GatewayClient(
    config: ClientConfig(environment: [:]),
    tokens: TokenSource(
      environment: [:], home: URL(fileURLWithPath: "/var/empty/wemessage-home"),
      read: { _ in Data(token.utf8) }),
    transport: transport)
}

/// An unreachable daemon.
struct Unreachable: Error {}
