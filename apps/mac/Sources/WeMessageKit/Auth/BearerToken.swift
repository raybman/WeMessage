import Foundation

/// The daemon's bearer: "wm_" and 64 lowercase hex digits. The raw text is
/// reachable only through `headerValue`; every description, the reflection
/// mirror and every Encodable output say "wm_[redacted]".
public struct BearerToken: Equatable, Sendable {
  /// What every output says in place of the token.
  public static let redacted = "wm_[redacted]"

  private let raw: String

  /// Trims whitespace and newlines (a token file usually ends in one), then
  /// accepts exactly "wm_" followed by 64 lowercase hex digits.
  public init?(raw: String) {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    let bytes = Array(trimmed.utf8)
    guard bytes.count == 67, bytes.starts(with: Array("wm_".utf8)) else { return nil }
    for byte in bytes.dropFirst(3) {
      let digit = (0x30...0x39).contains(byte)
      let lowerHex = (0x61...0x66).contains(byte)
      guard digit || lowerHex else { return nil }
    }
    self.raw = trimmed
  }

  /// "Bearer <token>", for the Authorization header and nothing else.
  public var headerValue: String {
    "Bearer " + raw
  }
}

extension BearerToken: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String { Self.redacted }

  public var debugDescription: String { Self.redacted }

  public var customMirror: Mirror {
    Mirror(self, children: [:])
  }
}

extension BearerToken: Encodable {
  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(Self.redacted)
  }
}
