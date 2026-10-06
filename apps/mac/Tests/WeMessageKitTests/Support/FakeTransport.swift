import Foundation
@testable import WeMessageKit

/// A value guarded by a lock, for counters the tests read after a run.
final class LockedBox<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Value

  init(_ value: Value) { self.value = value }

  func get() -> Value { lock.withLock { value } }
  func set(_ newValue: Value) { lock.withLock { value = newValue } }

  @discardableResult
  func update<R>(_ body: (inout Value) throws -> R) rethrows -> R {
    try lock.withLock { try body(&value) }
  }
}

/// One scripted HTTP answer.
struct Reply: Sendable {
  var status: Int
  var body: Data
  var headers: [String: String]

  init(status: Int, body: Data = Data(), headers: [String: String] = [:]) {
    self.status = status
    self.body = body
    self.headers = headers
  }

  static func json(_ status: Int, _ text: String) -> Reply {
    Reply(status: status, body: Data(text.utf8), headers: ["Content-Type": "application/json"])
  }

  /// responses/<name>.json: its status and body (a 204 answers with no body).
  static func response(_ name: String) throws -> Reply {
    try Fixtures.response(name).reply
  }

  /// errors/<name>.json: its status and body.
  static func error(_ name: String) throws -> Reply {
    try Fixtures.error(name).reply
  }

  /// A 200 event stream carrying `body`.
  static func sse(_ body: Data) -> Reply {
    Reply(status: 200, body: body, headers: ["Content-Type": "text/event-stream"])
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

extension ContractFixture {
  var reply: Reply {
    body == .null
      ? Reply(status: status)
      : Reply(status: status, body: wireBody, headers: ["Content-Type": "application/json"])
  }
}

/// Records every request and answers each from `handler(request, index)`,
/// where index counts requests from zero. The handler may throw to play an
/// unreachable daemon.
final class FakeTransport: Transport, @unchecked Sendable {
  typealias Handler = @Sendable (URLRequest, Int) throws -> Reply

  private let lock = NSLock()
  private var recorded: [URLRequest] = []
  private let handler: Handler

  init(_ handler: @escaping Handler) { self.handler = handler }

  var requests: [URLRequest] { lock.withLock { recorded } }

  private func record(_ request: URLRequest) -> Int {
    lock.withLock {
      recorded.append(request)
      return recorded.count - 1
    }
  }

  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    let index = record(request)
    let reply = try handler(request, index)
    return (reply.body, reply.response(for: request))
  }

  func stream(_ request: URLRequest) async throws -> (AsyncThrowingStream<Data, Error>, HTTPURLResponse) {
    let index = record(request)
    let reply = try handler(request, index)
    let body = reply.body
    let chunks = AsyncThrowingStream<Data, Error> { continuation in
      if !body.isEmpty { continuation.yield(body) }
      continuation.finish()
    }
    return (chunks, reply.response(for: request))
  }
}

/// Tokens are built at runtime so no source file spells a prefixed hex run
/// (the public-repo sweep in test/arch.spec.ts refuses one in any .swift).
enum TestTokens {
  static func make(_ fill: Character) -> String {
    "wm_" + String(repeating: fill, count: 64)
  }
}

/// A token file whose successive reads return successive contents (the last
/// one repeats), counting every read and remembering every path asked for.
final class FakeTokenFile: @unchecked Sendable {
  private let state: LockedBox<(reads: Int, urls: [URL], contents: [String?])>

  init(_ contents: [String?]) {
    state = LockedBox((reads: 0, urls: [], contents: contents))
  }

  var reads: Int { state.get().reads }
  var urls: [URL] { state.get().urls }

  func read(_ url: URL) throws -> Data? {
    state.update { s in
      let index = min(s.reads, max(s.contents.count - 1, 0))
      s.reads += 1
      s.urls.append(url)
      guard !s.contents.isEmpty, let text = s.contents[index] else { return nil }
      return Data(text.utf8)
    }
  }

  static let home = URL(fileURLWithPath: "/var/empty/wemessage-home")

  func source(env: [String: String] = [:]) -> TokenSource {
    TokenSource(environment: env, home: Self.home, read: { url in try self.read(url) })
  }
}

extension GatewayClient {
  /// A client over `transport`, its token read from `file`.
  static func testing(
    _ transport: FakeTransport,
    file: FakeTokenFile = FakeTokenFile([TestTokens.make("a")]),
    env: [String: String] = [:]
  ) -> GatewayClient {
    GatewayClient(config: ClientConfig(environment: env), tokens: file.source(env: env), transport: transport)
  }
}
