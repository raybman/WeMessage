import Foundation
import Observation
import WeMessageKit

/// The shell's state. `start()` asks the daemon for its status once, then
/// follows the kit's event stream; `apply` folds each status into the
/// connection line. Nothing here sends anything.
@MainActor
@Observable
public final class ShellModel {
  public enum Connection: Equatable, Sendable {
    case idle
    case connected(state: String)
    case reconnecting(attempt: Int)
    case down(reason: String)
  }

  /// The channel the rail has selected.
  public enum Scope: String, CaseIterable, Sendable {
    case all, imessage, whatsapp, linkedin, email

    /// The rail tile's short label (D-UI-1, provisional).
    public var label: String { ProvisionalUI.railShortLabels[rawValue] ?? rawValue }

    /// The full channel name, for accessibility.
    public var fullLabel: String {
      switch self {
      case .all: "All channels"
      case .imessage: "iMessage"
      case .whatsapp: "WhatsApp"
      case .linkedin: "LinkedIn"
      case .email: "Email"
      }
    }
  }

  /// The sidebar's lens.
  public enum Lens: String, CaseIterable, Sendable {
    case recent, needsYou, triage

    public var label: String {
      switch self {
      case .recent: "Recent"
      case .needsYou: "Needs You"
      case .triage: "Triage"
      }
    }
  }

  /// Settable inside the module so the reducer rows can start from any case.
  public internal(set) var connection: Connection = .idle
  public var scope: Scope = .all
  public var lens: Lens = .recent

  private let client: GatewayClient
  private var task: Task<Void, Never>?

  public init(client: GatewayClient) {
    self.client = client
  }

  /// One task, however often it is called: read status, then follow the
  /// event stream until `stop()` or the model goes away.
  public func start() {
    guard task == nil else { return }
    let client = self.client
    task = Task { [weak self] in
      do {
        let status = try await client.status()
        self?.connection = .connected(state: status.connectionState)
      } catch {
        if Task.isCancelled { return }
        self?.connection = .down(reason: "unreachable")
      }
      for await action in EventStream.live(client: client).run() {
        guard let self else { return }
        self.apply(action)
      }
    }
  }

  /// Cancels the task `start()` made; the stream ends with it.
  public func stop() {
    task?.cancel()
    task = nil
  }

  /// The reducer (§4.3). "Reconnecting" is only ever said about a
  /// connection the window actually had (P0-2): the kit's stream retries on
  /// a refused connection, and from `.idle` or `.down` that retry is still
  /// "not reachable", never "reconnecting".
  public func apply(_ action: AppAction) {
    guard case .status(let status) = action else { return }
    switch status {
    case .connected:
      if case .connected = connection { return }
      connection = .connected(state: "connected")
    case .reconnecting(let attempt):
      switch connection {
      case .connected, .reconnecting: connection = .reconnecting(attempt: attempt)
      case .idle: connection = .down(reason: "unreachable")
      case .down: return
      }
    case .down(let reason):
      connection = .down(reason: reason)
    }
  }

  /// The connection line, in words (D-UI-3, provisional).
  public var connectionLine: String {
    switch connection {
    case .idle: ProvisionalUI.idleLine
    case .connected(let state): ProvisionalUI.connectedLine(state: state)
    case .reconnecting(let attempt): ProvisionalUI.reconnectingLine(attempt: attempt)
    case .down: ProvisionalUI.downLine
    }
  }
}
