import Foundation

/// The one seam between the client and the network. The tests swap in a fake
/// that records every request; the app uses URLSessionTransport.
public protocol Transport: Sendable {
  /// One request, one complete response.
  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
  /// One request whose body arrives in chunks (the event stream).
  func stream(_ request: URLRequest) async throws -> (AsyncThrowingStream<Data, any Error>, HTTPURLResponse)
}

/// URLSession over loopback. Calls use an ephemeral session; the event
/// stream gets its own session that never caches, always asks for
/// text/event-stream and tolerates the daemon's 15 s keepalive gaps.
public final class URLSessionTransport: Transport, @unchecked Sendable {
  public let session: URLSession
  public let streamSession: URLSession

  public init(
    session: URLSession = URLSession(configuration: .ephemeral),
    streamSession: URLSession = URLSession(configuration: URLSessionTransport.sseConfiguration())
  ) {
    self.session = session
    self.streamSession = streamSession
  }

  /// The event stream's session configuration.
  public static func sseConfiguration() -> URLSessionConfiguration {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.urlCache = nil
    configuration.httpAdditionalHeaders = ["Accept": "text/event-stream"]
    configuration.timeoutIntervalForRequest = 60
    return configuration
  }

  public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
    return (data, http)
  }

  public func stream(_ request: URLRequest) async throws -> (AsyncThrowingStream<Data, any Error>, HTTPURLResponse) {
    let (bytes, response) = try await streamSession.bytes(for: request)
    guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
    let chunks = AsyncThrowingStream<Data, any Error> { continuation in
      let pump = Task {
        do {
          var buffer = Data()
          for try await byte in bytes {
            buffer.append(byte)
            // A line end is a natural boundary: frames reach the decoder
            // as soon as their blank line arrives.
            if byte == 0x0A || buffer.count >= 4096 {
              continuation.yield(buffer)
              buffer.removeAll(keepingCapacity: true)
            }
          }
          if !buffer.isEmpty { continuation.yield(buffer) }
          continuation.finish()
        } catch {
          continuation.finish(throwing: error)
        }
      }
      continuation.onTermination = { _ in pump.cancel() }
    }
    return (chunks, http)
  }
}
