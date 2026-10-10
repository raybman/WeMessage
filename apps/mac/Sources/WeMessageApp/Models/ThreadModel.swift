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

  /// v2 F1: the turn that was first before an older page was put above
  /// it. The transcript scrolls it back to the top, so the reader stays
  /// where they were while the page lands.
  public private(set) var anchorTurn: String?
  /// v2 F1: the turns read so far, oldest first. Older pages go above;
  /// a reload re-reads the newest page and merges it below.
  private(set) var turnPages = PagedList<ThreadTurn, String>(edge: .head, key: { $0.guid })
  /// v2 F1: a turn this close to the top of the transcript asks for the
  /// next older page.
  static let prefetchRows = 20
  /// True while an older page is on its way (D-UI-185's caption).
  public var loadingOlder: Bool { turnPages.inFlight }

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
      turnPages = PagedList(edge: .head, key: { $0.guid })
      anchorTurn = nil
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
    if case .loaded(let page) = next {
      // v2 F1: the newest page merges below the older turns already read.
      turnPages.mergeHead(page.turns, next: page.nextBefore)
      load = .loaded(merged(page))
    } else {
      load = next
    }
  }

  /// v2 F1: a transcript turn was drawn. Within `prefetchRows` of the
  /// top, the next older page is read. Views report; they never read.
  public func turnAppeared(_ turnGuid: String) async {
    guard turnPages.cursor != nil, !turnPages.inFlight else { return }
    let shown = turns
    guard let at = shown.firstIndex(where: { $0.guid == turnGuid }),
      turnPages.shouldFetch(nearIndex: at, of: shown.count, threshold: Self.prefetchRows)
    else { return }
    await loadOlder()
  }

  /// Reads the page of turns before the oldest one shown and puts it
  /// above them. One page at a time; a failure keeps the transcript and
  /// lets the next approach ask again; a page that comes back for a chat
  /// no longer shown, or for a cursor a reload moved, is dropped.
  func loadOlder() async {
    guard let guid, let cursor = turnPages.cursor, case .loaded(let shown) = load, turnPages.begin() else { return }
    let read = try? await client.readThread(guid, limit: Self.pageLimit, before: cursor)
    guard self.guid == guid else { return }
    guard case .ok(let page)? = read, turnPages.cursor == cursor else {
      turnPages.fail()
      return
    }
    let first = MessageTurn.turns(shown).first?.guid
    turnPages.prependPage(page.turns, next: page.nextBefore)
    anchorTurn = first
    if case .loaded(let now) = load { load = .loaded(merged(now)) }
  }

  /// The page on screen, its turns and cursor rebuilt from `turnPages`.
  private func merged(_ page: ThreadMessagesPage) -> ThreadMessagesPage {
    var out = page
    out.turns = turnPages.items
    out.nextBefore = turnPages.cursor
    return out
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
