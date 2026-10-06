import Foundation

/// One dispatched server-sent event.
public struct SSEFrame: Equatable, Sendable {
  /// This frame's own `id:` field as an integer; nil when the frame had no
  /// id line or a non-integer one. The decoder's `lastEventId` carries the
  /// stream-wide value.
  public var id: Int?
  /// The `event:` field, "message" when the frame named none.
  public var event: String
  /// The `data:` lines joined with "\n".
  public var data: String

  public init(id: Int?, event: String, data: String) {
    self.id = id
    self.event = event
    self.data = data
  }
}

/// An incremental text/event-stream parser, following the WHATWG HTML
/// event-stream interpretation rules: lines end at CRLF, LF or CR (a CRLF
/// split across two chunks is still one line end); a line starting with ":"
/// is a comment, which is how the daemon's keepalives arrive; a field without
/// a colon has an empty value; one leading space is stripped from a value;
/// data lines are joined with "\n"; a blank line dispatches the frame, but
/// only when it carried data. Bytes are buffered per line and decoded as
/// UTF-8 only once the line is complete, so a chunk boundary inside a
/// multi-byte character is harmless.
public struct SSEDecoder: Sendable {
  /// The last `id:` the stream set, as of the last dispatched (or empty)
  /// frame. It persists across frames that carry no id, and an id containing
  /// NUL is ignored, as the spec says.
  public private(set) var lastEventId: String?

  private var line: [UInt8] = []
  private var pendingCR = false
  private var sawFirstLine = false
  private var idBuffer: String?
  private var frameId: String?
  private var eventType = ""
  private var data = ""

  public init() {}

  /// Feeds one chunk; returns every frame it completed, in order.
  public mutating func feed(_ chunk: Data) -> [SSEFrame] {
    var frames: [SSEFrame] = []
    for byte in chunk {
      if pendingCR {
        pendingCR = false
        if byte == 0x0A { continue }
      }
      switch byte {
      case 0x0D:
        pendingCR = true
        if let frame = endLine() { frames.append(frame) }
      case 0x0A:
        if let frame = endLine() { frames.append(frame) }
      default:
        line.append(byte)
      }
    }
    return frames
  }

  /// True when a Content-Type names text/event-stream, ignoring case and
  /// parameters such as "; charset=utf-8".
  public static func isEventStream(contentType: String?) -> Bool {
    guard let contentType else { return false }
    let essence = contentType.split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false).first ?? ""
    return essence.trimmingCharacters(in: .whitespaces).lowercased() == "text/event-stream"
  }

  private mutating func endLine() -> SSEFrame? {
    var bytes = line
    line.removeAll(keepingCapacity: true)
    if !sawFirstLine {
      sawFirstLine = true
      if bytes.starts(with: [0xEF, 0xBB, 0xBF]) { bytes.removeFirst(3) }
    }
    if bytes.isEmpty { return dispatch() }
    if bytes[0] == 0x3A { return nil }
    let name: String
    var value: ArraySlice<UInt8>
    if let colon = bytes.firstIndex(of: 0x3A) {
      name = String(decoding: bytes[..<colon], as: UTF8.self)
      value = bytes[(colon + 1)...]
      if value.first == 0x20 { value = value.dropFirst() }
    } else {
      name = String(decoding: bytes, as: UTF8.self)
      value = []
    }
    let text = String(decoding: value, as: UTF8.self)
    switch name {
    case "event":
      eventType = text
    case "data":
      data += text
      data += "\n"
    case "id":
      if !value.contains(0) {
        idBuffer = text
        frameId = text
      }
    default:
      break
    }
    return nil
  }

  private mutating func dispatch() -> SSEFrame? {
    lastEventId = idBuffer
    defer {
      eventType = ""
      data = ""
      frameId = nil
    }
    guard !data.isEmpty else { return nil }
    var body = data
    if body.unicodeScalars.last == "\n" { body.unicodeScalars.removeLast() }
    let id = frameId.flatMap { Int($0) }
    return SSEFrame(id: id, event: eventType.isEmpty ? "message" : eventType, data: body)
  }
}
