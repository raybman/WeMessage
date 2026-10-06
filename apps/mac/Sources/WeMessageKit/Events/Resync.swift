import Foundation

/// What a (re)connect reads before it trusts live events again: the drafts
/// list, and after a gap, how many audit rows the gap covered.
public enum Resync {
  /// The result of one resync.
  public struct Snapshot: Equatable, Sendable {
    /// Audit rows written since the previous sync; 0 on a first connect.
    public var missed: Int
    /// The drafts list, as the daemon returned it.
    public var drafts: [DraftPayload]

    public init(missed: Int, drafts: [DraftPayload]) {
      self.missed = missed
      self.drafts = drafts
    }
  }

  /// The reads a resync makes, in order: with no previous sync, only the
  /// drafts list; after one, the audit rows since it (capped at
  /// Backoff.auditGapLimit), then the drafts list.
  public static func plan(since: String?) -> [Effect] {
    guard let since else { return [.listDrafts] }
    return [.listAudit(since: since, limit: Backoff.auditGapLimit), .listDrafts]
  }

  /// Runs `plan(since:)` against `client`.
  public static func run(since: String?, client: GatewayClient) async throws -> Snapshot {
    var missed = 0
    var drafts: [DraftPayload] = []
    for effect in plan(since: since) {
      switch effect {
      case .listAudit(let since, let limit):
        missed = try await client.listAudit(since: since, limit: limit).count
      case .listDrafts:
        drafts = try await client.listDrafts().drafts
      case .log:
        break
      }
    }
    return Snapshot(missed: missed, drafts: drafts)
  }
}
