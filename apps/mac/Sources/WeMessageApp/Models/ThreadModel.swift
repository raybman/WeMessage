import Foundation
import Observation
import WeMessageKit

/// The selected thread's transcript (board 02): one read of
/// GET /v1/threads/:guid/messages per selection, and again on reload. A
/// result that comes back for a thread no longer selected is dropped. The
/// model reads; it never writes (sends go through Outbound).
@MainActor
@Observable
public final class ThreadModel {
  public enum Load: Equatable, Sendable {
    case idle
    case loading
    case loaded(ThreadMessagesPage)
    /// The daemon does not know the chat (404 unknown-chat).
    case unknownChat
    /// Any other refusal or failure, in words.
    case failed(String)
  }

  /// The chat the model is showing, by guid.
  public private(set) var guid: String?
  public private(set) var load: Load = .idle
  /// Agent drafts the human parked here (D-UI-36). Local to this window:
  /// nothing is written to the daemon.
  public private(set) var held: Set<String> = []
  /// When each hold was made (09.B: "HELD by you 9:47").
  public private(set) var heldAt: [String: Date] = [:]

  private let client: GatewayClient

  public init(client: GatewayClient) {
    self.client = client
  }

  /// S7a: one read asks for the daemon's largest page, the newest 200 turns
  /// (packages/daemon/src/routes/threads.ts caps `limit` at 200). The
  /// transcript is a lazy stack, so a long page costs memory for the turns,
  /// never views for the rows off screen (G2Limits.mountedTranscriptRows).
  public static let pageLimit = 200

  /// The turns this build can draw, oldest first.
  public var turns: [MessageTurn] {
    guard case .loaded(let page) = load else { return [] }
    return MessageTurn.turns(page)
  }

  /// The page's as-of, the clock Today and the read line are measured on.
  public var asOf: Date? {
    guard case .loaded(let page) = load else { return nil }
    return WireDate.parse(page.asOf)
  }

  /// Shows `guid` (nil clears). A different chat starts from loading; the
  /// same chat keeps its page on screen until the new one arrives.
  public func open(_ guid: String?) async {
    if guid != self.guid {
      self.guid = guid
      load = guid == nil ? .idle : .loading
    }
    guard let guid else { return }
    let next: Load
    do {
      switch try await client.readThread(guid, limit: Self.pageLimit) {
      case .ok(let page): next = .loaded(page)
      case .refused(.unknownChat): next = .unknownChat
      case .refused(let refusal): next = .failed(String(describing: refusal))
      }
    } catch {
      next = .failed(String(describing: error))
    }
    guard self.guid == guid else { return }
    load = next
  }

  /// Reads the shown chat again.
  public func reload() async {
    await open(guid)
  }

  /// Parks an agent draft for later review, here only (D-UI-36).
  public func hold(_ draftId: String, at now: Date = Date()) {
    held.insert(draftId)
    if heldAt[draftId] == nil { heldAt[draftId] = now }
  }

  /// Release to awaiting (09.B): the held draft carries its verbs again.
  public func release(_ draftId: String) {
    held.remove(draftId)
    heldAt[draftId] = nil
  }
}
