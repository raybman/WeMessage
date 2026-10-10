import Foundation
import XCTest

/// v2 S4b: the UI tests' handle on tools/swift/fake-daemon.mjs, which the
/// ci-swift `ui` job starts with --control on WEMESSAGE_PORT. Four loopback
/// routes, no bearer (the sandboxed runner cannot read the token file):
///   POST /v1/_scenario {"name"}  serve a scenario from fixtures/scenarios
///   POST /v1/_reset              back to the S0 goldens, journal cleared
///   GET  /v1/_journal            every request the app made since the reset
///   POST /v1/_emit {"state"}     one connection.state frame to open streams (S7a)
/// Every UI test class resets in setUp, so no test sees another's scenario
/// or requests.
enum FakeDaemon {
  struct Failure: Error, CustomStringConvertible {
    let description: String
  }

  /// One request the app made, as the fake daemon journaled it.
  struct Request: Decodable, Equatable, Sendable, CustomStringConvertible {
    let method: String
    let path: String
    let query: String
    let status: Int
    var description: String { "\(method) \(path) \(status)" }
  }

  struct Journal: Decodable, Sendable {
    let scenario: String
    let requests: [Request]
  }

  private struct Switched: Decodable, Sendable {
    let scenario: String
  }

  /// The fake daemon's base URL, from the port the job exported.
  static func base() throws -> URL {
    let env = ProcessInfo.processInfo.environment
    guard let port = env["WEMESSAGE_PORT"], !port.isEmpty, let url = URL(string: "http://127.0.0.1:\(port)") else {
      throw Failure(description: "WEMESSAGE_PORT is not set for the UI test runner")
    }
    return url
  }

  private static func call(_ method: String, _ path: String, body: Data? = nil) async throws -> Data {
    var request = URLRequest(url: try base().appendingPathComponent(path))
    request.httpMethod = method
    request.timeoutInterval = 10
    if let body {
      request.httpBody = body
      request.setValue("application/json", forHTTPHeaderField: "content-type")
    }
    let (data, response) = try await URLSession.shared.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard status == 200 else {
      let text = String(decoding: data, as: UTF8.self)
      throw Failure(description: "\(method) \(path) answered \(status): \(text)")
    }
    return data
  }

  /// Back to the S0 goldens, with an empty journal.
  static func reset() async throws {
    let switched = try JSONDecoder().decode(Switched.self, from: try await call("POST", "/v1/_reset"))
    guard switched.scenario == "default" else {
      throw Failure(description: "reset left scenario \(switched.scenario)")
    }
  }

  /// Serve fixtures/scenarios/<name>. The journal is kept.
  static func scenario(_ name: String) async throws {
    let body = try JSONEncoder().encode(["name": name])
    let switched = try JSONDecoder().decode(Switched.self, from: try await call("POST", "/v1/_scenario", body: body))
    guard switched.scenario == name else {
      throw Failure(description: "asked for scenario \(name), got \(switched.scenario)")
    }
  }

  private struct Emitted: Decodable, Sendable {
    let emitted: String
    let state: String
    let id: Int
  }

  /// v2 S7a: POST /v1/_emit {"state"} writes one connection.state frame to
  /// every open event stream. Returns the frame's id.
  @discardableResult
  static func emit(state: String) async throws -> Int {
    let body = try JSONEncoder().encode(["state": state])
    let out = try JSONDecoder().decode(Emitted.self, from: try await call("POST", "/v1/_emit", body: body))
    guard out.emitted == "connection.state", out.state == state else {
      throw Failure(description: "asked to emit \(state), got \(out.emitted) \(out.state)")
    }
    return out.id
  }

  static func journal() async throws -> Journal {
    try JSONDecoder().decode(Journal.self, from: try await call("GET", "/v1/_journal"))
  }

  /// Polls the journal until every `method path` in `wanted` has been
  /// requested, or the timeout passes. Returns the last journal read.
  static func waitForRequests(
    _ wanted: [String], timeout: TimeInterval = UITestApp.timeout
  ) async throws -> Journal {
    let deadline = Date().addingTimeInterval(timeout)
    var last = try await journal()
    while Date() < deadline {
      let seen = Set(last.requests.map { "\($0.method) \($0.path)" })
      if wanted.allSatisfy(seen.contains) { return last }
      try await Task.sleep(nanoseconds: 250_000_000)
      last = try await journal()
    }
    return last
  }

  /// The window sent nothing: no request reached POST /v1/send.
  static func assertNoSend(file: StaticString = #filePath, line: UInt = #line) async throws {
    let sends = try await journal().requests.filter { $0.method == "POST" && $0.path == "/v1/send" }
    XCTAssertEqual(sends, [], "the app asked to send", file: file, line: line)
  }
}
