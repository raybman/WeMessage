import Foundation
import Observation
import WeMessageKit

/// The one send funnel (plan 2.2). Every send and every approval the window
/// makes goes through `perform(_:gesture:)`, and this is the only file that
/// calls the client's send or approve (AppHygiene H-S4-2). It:
///
/// - refuses while the kill switch is on, or while status has not said it
///   is off (unknown is not off);
/// - refuses an approval whose body was not drawn on screen this session
///   (09.D);
/// - refuses bare Return by construction: no Gesture case is a bare key, and
///   the composer binds only cmd-Return and the Send button;
/// - writes the undo entry before anything reaches the client, then counts
///   the undo window down (4 s for a typed message, 10 s for an agent
///   approval, 14.F) and only then calls the daemon, checking the kill
///   switch again at that minute.
///
/// A 409 parked (the fake daemon parks every send) is shown as parked,
/// never as sent.
@MainActor
@Observable
public final class Outbound {
  public enum Intent: Equatable, Sendable {
    /// A message the human typed, to one handle.
    case send(chatGuid: String, handle: String, body: String)
    /// An agent draft the human approved, possibly edited.
    case approve(draftId: String, chatGuid: String, editedBody: String?)

    public var chatGuid: String {
      switch self {
      case .send(let chatGuid, _, _), .approve(_, let chatGuid, _): chatGuid
      }
    }

    /// The undo window in seconds (14.F).
    public var window: Int {
      switch self {
      case .send: Outbound.typedWindow
      case .approve: Outbound.approveWindow
      }
    }
  }

  /// What the human did. There is no bare-Return case.
  public enum Gesture: Sendable {
    case commandReturn
    case sendButton
    case approveButton
  }

  public enum Refusal: Equatable, Sendable {
    case killSwitch
    case notRendered
    case empty
    /// The gesture does not belong to the intent (an approve key on a send).
    case wrongGesture
  }

  public enum Phase: Equatable, Sendable {
    /// Inside the undo window: nothing has left this Mac.
    case counting(remaining: Int)
    /// The window closed and the request is out.
    case sending
    case sent
    /// The daemon approved the draft and owns the send from here.
    case approved
    /// 409 parked: sending is parked on this daemon.
    case parked
    /// The daemon, or the kill switch at the minute, said no.
    case refused(String)
    case failed(String)
    /// The human took it back inside the window.
    case undone
  }

  public struct Entry: Equatable, Identifiable, Sendable {
    public let id: Int
    public let intent: Intent
    public internal(set) var phase: Phase
  }

  public nonisolated static let typedWindow = 4
  public nonisolated static let approveWindow = 10

  /// Every send and approval this window has made, oldest first.
  public private(set) var entries: [Entry] = []

  private let client: GatewayClient
  private let killSwitch: @MainActor () -> Bool?
  private let sleep: @Sendable (Duration) async throws -> Void
  private var rendered: Set<String> = []
  private var tasks: [Int: Task<Void, Never>] = [:]
  private var nextID = 1

  public init(
    client: GatewayClient, killSwitch: @escaping @MainActor () -> Bool?,
    sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
  ) {
    self.client = client
    self.killSwitch = killSwitch
    self.sleep = sleep
  }

  /// The draft's body is on screen (09.D).
  public func markRendered(_ draftId: String) {
    rendered.insert(draftId)
  }

  /// Starts `intent`'s undo window, or says why not. Nothing reaches the
  /// client before the window closes.
  @discardableResult
  public func perform(_ intent: Intent, gesture: Gesture) -> Refusal? {
    switch (intent, gesture) {
    case (.send(_, _, let body), .commandReturn), (.send(_, _, let body), .sendButton):
      if body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .empty }
    case (.approve(let id, _, _), .approveButton):
      if !rendered.contains(id) { return .notRendered }
    default:
      return .wrongGesture
    }
    guard killSwitch() == false else { return .killSwitch }
    let id = nextID
    nextID += 1
    // The undo entry first: the record exists before any request can.
    entries.append(Entry(id: id, intent: intent, phase: .counting(remaining: intent.window)))
    tasks[id] = Task { [weak self] in await self?.run(id) }
    return nil
  }

  /// Takes back the newest send still inside its window (cmd-Z), in
  /// `chatGuid` when one is given. False when there is none: once the window
  /// has closed there is nothing to undo.
  @discardableResult
  public func undo(in chatGuid: String? = nil) -> Bool {
    guard
      let index = entries.lastIndex(where: {
        guard chatGuid == nil || $0.intent.chatGuid == chatGuid else { return false }
        if case .counting = $0.phase { return true } else { return false }
      })
    else {
      return false
    }
    let id = entries[index].id
    entries[index].phase = .undone
    tasks[id]?.cancel()
    tasks[id] = nil
    return true
  }

  /// The newest entry for `chatGuid`.
  public func latest(for chatGuid: String) -> Entry? {
    entries.last { $0.intent.chatGuid == chatGuid }
  }

  private func phase(_ id: Int) -> Phase? {
    entries.first { $0.id == id }?.phase
  }

  private func set(_ id: Int, _ phase: Phase) {
    guard let index = entries.firstIndex(where: { $0.id == id }) else { return }
    entries[index].phase = phase
  }

  private func run(_ id: Int) async {
    guard let entry = entries.first(where: { $0.id == id }) else { return }
    var remaining = entry.intent.window
    while remaining > 0 {
      do { try await sleep(.seconds(1)) } catch { return }
      guard case .counting = phase(id) else { return }
      remaining -= 1
      set(id, remaining > 0 ? .counting(remaining: remaining) : .sending)
    }
    defer { tasks[id] = nil }
    // The kill switch is read again at the minute the request would go.
    guard killSwitch() == false else {
      set(id, .refused("kill switch on"))
      return
    }
    set(id, .sending)
    do {
      switch entry.intent {
      case .send(_, let handle, let body):
        let result = try await client.send(to: handle, body: body)
        set(id, result.outcome == "sent" ? .sent : .refused(result.outcome))
      case .approve(let draftId, _, let editedBody):
        switch try await client.approveDraft(draftId, editedBody: editedBody) {
        case .ok: set(id, .approved)
        case .refused(let refusal): set(id, Self.phase(for: refusal))
        }
      }
    } catch let error as GatewayError {
      if let refusal = error.refusal {
        set(id, Self.phase(for: refusal))
      } else {
        set(id, .failed(String(describing: error)))
      }
    } catch {
      set(id, .failed(String(describing: error)))
    }
  }

  static func phase(for refusal: WeMessageKit.Refusal) -> Phase {
    switch refusal {
    case .conflict(let code, _, _): code == "parked" ? .parked : .refused(code)
    case .denied(let reason): .refused(reason)
    case .sourceUnavailable: .refused("source unavailable")
    case .unknownChat: .refused("unknown chat")
    }
  }
}
