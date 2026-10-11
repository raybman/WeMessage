import Foundation

/// v2 F6c: one attachment's bytes as GET /v1/attachments/:id served them.
/// `mime` is the daemon's magic-byte sniff, never the sender's stored type;
/// `total` is the whole file's size (Content-Range's total on a 206).
public struct AttachmentBytes: Equatable, Sendable {
  public let data: Data
  public let mime: String
  public let etag: String?
  public let total: Int

  public init(data: Data, mime: String, etag: String?, total: Int) {
    self.data = data
    self.mime = mime
    self.etag = etag
    self.total = total
  }
}

/// v2 F6c: why the bytes route could not serve a file. The first five are
/// the 404 `attachment-not-local` reasons; the last is a 503 (chat.db is
/// unreadable, Full Disk Access). Never a path.
public enum AttachmentFailure: String, Error, Equatable, Sendable, CaseIterable {
  case unknownAttachment = "unknown-attachment"
  case noLocalPath = "no-local-path"
  case notOnThisMac = "not-on-this-mac"
  case outsideRoot = "outside-root"
  case changed
  case sourceUnavailable = "source-unavailable"

  /// The 404 or 503 body the daemon answered, or nil when it is neither.
  static func from(status: Int, body: JSONValue) -> AttachmentFailure? {
    switch status {
    case 404 where body["error"]?.stringValue == "attachment-not-local":
      return body["reason"]?.stringValue.flatMap(AttachmentFailure.init(rawValue:))
    case 503 where body["error"]?.stringValue == "source-unavailable":
      return .sourceUnavailable
    default:
      return nil
    }
  }
}
