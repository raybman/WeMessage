import Foundation
import Observation
import WeMessageKit

/// v2 S4l, board 16: the one place the OS surfaces read from. The window
/// pushes its snapshot here; the menu bar extra, the Dock badge, the Dock
/// menu and the main menu read it, so the extra and the Dock never disagree
/// (16.F legend 1). Commands from the menu, the popover and a notification
/// land here as ids and run the handler the window registered; an id with
/// no handler is disabled in the menu (D-UI-113).
@MainActor
@Observable
final class OSLayerHub {
  static let shared = OSLayerHub()

  /// The fold every surface reads.
  var snapshot = OSSnapshot(count: nil, fresh: false, connected: false, killed: false) {
    didSet { if snapshot != oldValue { changed() } }
  }
  /// What the popover is drawn from.
  var popover: PopoverInput? {
    didSet { if popover != oldValue { changed() } }
  }
  /// The main menu's context: scope (Hold Until) and the posture line.
  var menuContext = MenuContext() {
    didSet { if menuContext != oldValue { changed() } }
  }
  /// The kill confirm (16.H) is up in the window.
  var killConfirmShown = false
  /// Under the UI-test flag only: the live main menu, as the delegate read
  /// it back from the application (testMenuTitlesAndIds).
  var menuDump: [String] = []

  /// Commands by id. The window registers its own when it is shown.
  private var handlers: [String: @MainActor () -> Void] = [:]
  /// Listeners outside SwiftUI (the delegate's Dock and extra).
  private var listeners: [@MainActor () -> Void] = []

  func register(_ id: String, _ handler: @escaping @MainActor () -> Void) { handlers[id] = handler }
  func canPerform(_ id: String) -> Bool { handlers[id] != nil }

  @discardableResult
  func perform(_ id: String) -> Bool {
    guard let handler = handlers[id] else { return false }
    handler()
    return true
  }

  func listen(_ listener: @escaping @MainActor () -> Void) { listeners.append(listener) }

  private func changed() {
    for listener in listeners { listener() }
  }

  /// The handoff (16.C): the thread, never the inbox root. Runs the
  /// window's registered "handoff" route with the target parked here.
  private(set) var pendingHandoff: Handoff?

  func handoff(_ target: Handoff) {
    pendingHandoff = target
    perform("handoff")
  }

  /// A popover row's verb: Open hands off; Done, Snooze and Mute act on
  /// the row's thread through the same gates the keys use.
  func popoverVerb(_ verb: PopoverVerb, _ entry: PopoverEntry) {
    switch verb {
    case .open: handoff(.open(entry))
    case .done, .snooze, .mute: actOn(entry.threadGuid, "popover:" + verb.rawValue)
    }
  }

  /// Done, Snooze or Mute on one thread, from outside the window.
  func actOn(_ thread: String, _ id: String) {
    pendingHandoff = Handoff(url: "", threadGuid: thread, channel: "", focus: .list)
    perform(id)
  }

  func takeHandoff() -> Handoff? {
    defer { pendingHandoff = nil }
    return pendingHandoff
  }
}

// MARK: The window's side

extension ShellModel {
  /// The fold the OS layer reads: ALL's counter, the connection, the kill
  /// switch and the lens.
  var osSnapshot: OSSnapshot {
    let connected = status.map { $0.connectionState != "disconnected" } ?? false
    let triage = lens == .triage
    switch board.counter(.all) {
    case .left(let n, _): return OSSnapshot(count: n, fresh: true, connected: connected, killed: killSwitch == true, triage: triage)
    case .clear: return OSSnapshot(count: 0, fresh: true, connected: connected, killed: killSwitch == true, triage: triage)
    case .cannotSay: return OSSnapshot(count: nil, fresh: false, connected: connected, killed: killSwitch == true, triage: triage)
    case .hidden: return OSSnapshot(count: nil, fresh: false, connected: false, killed: killSwitch == true, triage: triage)
    }
  }

  /// The popover's input: what is waiting, named and previewed by the
  /// inbound line, and the per-channel ages.
  var popoverInput: PopoverInput {
    let clock = board.asOf
    let listed = Dictionary((threads?.threads ?? []).map { ($0.chatGuid, $0) }, uniquingKeysWith: { a, _ in a })
    let staleChannels = Set(
      ShellModel.Scope.allCases.filter { $0 != .all && board.mark($0) == .stale }.map(\.rawValue))
    let entries = board.queue.map { item in
      let thread = listed[item.threadGuid]
      return PopoverEntry(
        id: item.draftId ?? item.threadGuid, threadGuid: item.threadGuid, name: thread?.title ?? item.threadGuid,
        channel: item.channel, preview: thread.flatMap { $0.lastFromMe ? nil : $0.lastLine } ?? "",
        kind: item.draftId == nil ? .message : .draft, stream: false,
        sourceStale: staleChannels.contains(item.channel), arrivedAt: item.arrivedAt)
    }
    // A channel that was never connected is left out, not counted as stale.
    let sources = freshnessRows.compactMap { row -> SourceLine? in
      if case .live(let at) = row.state {
        return SourceLine(channel: row.scope.fullLabel, live: true, age: OSText.age(from: at, to: clock))
      }
      if case .stale(let since) = row.state {
        return SourceLine(channel: row.scope.fullLabel, live: false, age: OSText.age(from: since, to: clock))
      }
      return nil
    }
    let oldest = sources.filter(\.live).last?.age ?? ""
    return PopoverInput(
      snapshot: osSnapshot, stamp: clock.map(OSText.stamp) ?? "", entries: entries, sources: sources,
      oldestSync: oldest, killedSince: nil)
  }

  /// The Agent menu's posture line (16.G).
  var menuContext: MenuContext {
    let drafts = state.queue.filter { $0.state == .pending }.count
    let synced = board.lastScan.map { " \u{00B7} synced " + ShellText.clock($0) } ?? ""
    let posture =
      killSwitch == true
      ? "Kill switch on \u{00B7} nothing can send"
      : "Drafting on \u{00B7} \(drafts) \(drafts == 1 ? "draft" : "drafts") ready\(synced)"
    return MenuContext(scope: scope.rawValue, posture: posture)
  }

  /// Registers the window's commands with the hub, so the main menu, the
  /// Dock menu, the popover and a notification all reach the same model
  /// methods the keys reach. Only what this version can do is registered;
  /// everything else stays disabled (D-UI-113).
  func bindOSLayer(_ hub: OSLayerHub = .shared) {
    hub.register("view:lens-recent") { self.choose(.recent) }
    hub.register("view:lens-needs") { self.choose(.needsYou) }
    hub.register("view:lens-triage") { self.toggleTriage() }
    for scope in ShellModel.Scope.allCases {
      hub.register("view:scope-\(scope.rawValue)") { self.scope = scope }
    }
    hub.register("view:inspector") { self.inspectorShown.toggle() }
    hub.register("thread:next") { self.step(1) }
    hub.register("thread:prev") { self.step(-1) }
    hub.register("thread:switcher") { self.openSwitcher() }
    hub.register("thread:undo") { _ = self.undoLast() }
    hub.register("thread:done") { if let guid = self.selectedThread { self.act(.done, on: [guid]) } }
    hub.register("thread:mute:thread") { if let guid = self.selectedThread { self.act(.mute, on: [guid]) } }
    hub.register("thread:reply") { if let guid = self.selectedThread { self.replyOrEdit(in: guid) } }
    hub.register("edit:find") { self.openFind() }
    hub.register("edit:find-all") { self.openSearch() }
    hub.register("agent:kill") { hub.killConfirmShown = true }
    hub.register("kill:engage") {
      hub.killConfirmShown = false
      Task { await self.engageKillSwitch() }
    }
    hub.register("kill:cancel") { hub.killConfirmShown = false }
    hub.register("handoff") {
      guard let target = hub.takeHandoff() else { return }
      if let scope = ShellModel.Scope(rawValue: target.channel) { self.scope = scope }
      // The lens is left as it is; the list, not the composer, takes the
      // keys unless the user asked to reply.
      self.open(target.threadGuid)
      if target.focus == .composer { self.replyOrEdit(in: target.threadGuid) } else { self.triageClaim += 1 }
    }
    for kind in [QueueStateStore.Kind.done, .snooze, .mute] {
      let id = "popover:" + (kind == .done ? "done" : kind == .snooze ? "snooze" : "mute")
      hub.register(id) { if let target = hub.takeHandoff() { self.act(kind, on: [target.threadGuid]) } }
    }
  }
}

/// Board 16's times: the popover's stamp and the source ages.
enum OSText {
  /// "Tue 16:42:07".
  static func stamp(_ date: Date) -> String { ShellText.format(date, "EEE", .current) + " " + ShellText.clock(date) }

  /// "4s ago", "1m ago", "6h 12m ago", measured against the queue's clock,
  /// never the wall clock; "never" with no sync.
  static func age(from: Date?, to clock: Date?) -> String {
    guard let from else { return "never" }
    let seconds = max(0, Int((clock ?? from).timeIntervalSince(from)))
    if seconds < 60 { return "\(seconds)s ago" }
    if seconds < 3600 { return "\(seconds / 60)m ago" }
    let minutes = (seconds % 3600) / 60
    return minutes == 0 ? "\(seconds / 3600)h ago" : "\(seconds / 3600)h \(minutes)m ago"
  }
}
