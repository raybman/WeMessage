import Foundation

/// Where the daemon listens: always loopback, on WEMESSAGE_PORT or 47100.
///
/// The port follows JavaScript parseInt (leading whitespace, an optional
/// sign, then leading digits) and must land in 1...65535, else 47100.
/// [diverges from TS: desktop auth.ts takes any positive parseInt]
public struct ClientConfig: Sendable {
  public let port: Int
  public let baseURL: URL
  /// The environment's token, pinned for display; the client itself asks
  /// its TokenSource on every resolve.
  public let token: BearerToken?

  public init(environment: [String: String] = ProcessInfo.processInfo.environment) {
    let port = Self.port(from: environment["WEMESSAGE_PORT"])
    self.port = port
    self.baseURL = URL(string: "http://127.0.0.1:\(port)")!
    if let raw = environment["WEMESSAGE_TOKEN"], !raw.isEmpty {
      self.token = BearerToken(raw: raw)
    } else {
      self.token = nil
    }
  }

  static func port(from text: String?) -> Int {
    guard let text else { return Defaults.port }
    var rest = Substring(text).drop(while: { $0.isWhitespace })
    var sign = 1
    if let first = rest.first, first == "+" || first == "-" {
      sign = first == "-" ? -1 : 1
      rest = rest.dropFirst()
    }
    var value = 0
    var digits = 0
    for character in rest {
      guard character.isASCII, let digit = character.wholeNumberValue else { break }
      value = value * 10 + digit
      digits += 1
      if value > 65535 { return Defaults.port }
    }
    let port = sign * value
    guard digits > 0, port > 0, port <= 65535 else { return Defaults.port }
    return port
  }
}

extension ClientConfig: Encodable {
  enum CodingKeys: String, CodingKey {
    case baseURL, port, token
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(baseURL.absoluteString, forKey: .baseURL)
    try c.encode(port, forKey: .port)
    try c.encodeIfPresent(token, forKey: .token)
  }
}

extension ClientConfig: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  private var tokenSummary: String {
    token == nil ? "none" : BearerToken.redacted
  }

  public var description: String {
    "ClientConfig(baseURL: \(baseURL.absoluteString), port: \(port), token: \(tokenSummary))"
  }

  public var debugDescription: String { description }

  public var customMirror: Mirror {
    Mirror(
      self, children: ["baseURL": baseURL.absoluteString, "port": port, "token": tokenSummary],
      displayStyle: .struct)
  }
}
