import Foundation
import Observation
import WeMessageKit

/// The shell's state. `start()` reads status, the thread list and the draft
/// queue once, then follows the kit's event stream; `apply` folds each
/// status into the connection line and every frame into the kit's AppState.
/// `board` is board 01's marks, counter and list, folded from all of it.
/// Nothing here sends anything: the one write is the kill switch, and it
/// only ever turns sending off.
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

    /// The digit cmd binds to this tile, in rail order: cmd-1 is ALL.
    public var shortcutDigit: Character {
      let index = Self.allCases.firstIndex(of: self) ?? 0
      return Character(String(index + 1))
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
  /// The thread the list has selected, by chatGuid.
  public var selectedThread: String?
  /// The inspector column beside the thread (toggled by its button; no key).
  public var inspectorShown = false

  /// The last status read; nil until one succeeds.
  public internal(set) var status: StatusPayload?
  /// The last thread list read.
  public internal(set) var threads: ThreadsPage?
  /// The kit's state: the draft queue, folded by AppReducer.
  public internal(set) var state = AppState()

  private let client: GatewayClient
  private var task: Task<Void, Never>?

  /// Board 01, folded from status, threads and the queue (D-UI-18 window).
  public var board: ShellBoard {
    ShellBoard.fold(
      status: status, threads: threads, drafts: state.queue,
      window: QueueWindow(days: ProvisionalUI.queueWindowDays))
  }

  /// The channel the counter speaks for: the selected one, or under ALL the
  /// first channel that is stale (the one that makes ALL unable to say).
  public var counterChannel: String {
    guard scope == .all else { return scope.fullLabel }
    let stale = Scope.allCases.first { $0 != .all && board.mark($0) == .stale }
    return (stale ?? .imessage).fullLabel
  }

  /// The title counter's sentence for the selected scope; nil when hidden.
  public var counterSentence: String? { ShellText.counter(board.counter(scope), channel: counterChannel) }

  /// The kill switch as status last said it: nil when status has not said.
  public var killSwitch: Bool? { status?.killSwitch }

  /// The threads the list shows for the current scope and lens.
  public var rows: [ThreadSummary] { board.rows(threads?.threads ?? [], scope: scope, lens: lens) }

  /// The selected thread's summary, when it is still listed.
  public var selected: ThreadSummary? {
    guard let selectedThread else { return nil }
    return threads?.threads.first { $0.chatGuid == selectedThread }
  }

  public init(client: GatewayClient) {
    self.client = client
  }

  /// One task, however often it is called: read status, then follow the
  /// event stream until `stop()` or the model goes away.
  public func start() {
    guard task == nil else { return }
    let client = self.client
    task = Task { [weak self] in
      await self?.refresh()
      if Task.isCancelled { return }
      for await action in EventStream.live(client: client).run() {
        guard let self else { return }
        self.apply(action)
      }
    }
  }

  /// Reads status, the thread list and the draft queue once. The first read
  /// decides connected or down; a later one (the UI tests' reload key after
  /// a scenario switch) updates what a connected window says and leaves a
  /// lost connection to the stream.
  public func refresh() async {
    do {
      let status = try await client.status()
      self.status = status
      switch connection {
      case .idle, .connected: connection = .connected(state: status.connectionState)
      case .reconnecting, .down: break
      }
    } catch {
      if Task.isCancelled { return }
      if case .idle = connection { connection = .down(reason: "unreachable") }
      return
    }
    if case .ok(let page)? = try? await client.listThreads() { threads = page }
    if let envelope = try? await client.listDrafts() { fold(.response(.drafts(envelope.drafts))) }
  }

  /// Turns sending off (shift-cmd-K). Only ever this direction: turning it
  /// back on is S4f's disengage, behind its own confirmation. The status
  /// read after it is what the chip shows; a refusal leaves the chip as it
  /// was.
  public func engageKillSwitch() async {
    guard killSwitch != true else { return }
    _ = try? await client.setKillSwitch(true)
    if let status = try? await client.status() { self.status = status }
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
    fold(action)
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

  /// Folds `action` into the kit's state and runs the one effect the shell
  /// acts on: a fresh read of the draft queue.
  func fold(_ action: AppAction) {
    let (next, effects) = AppReducer.reduce(state, action)
    state = next
    guard effects.contains(.listDrafts) else { return }
    let client = self.client
    Task { [weak self] in
      if let envelope = try? await client.listDrafts() { self?.fold(.response(.drafts(envelope.drafts))) }
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
