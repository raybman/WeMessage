import Foundation

// v2 F3c (G-06a): the seam the app's queue store writes Done, Snooze and
// Mute through. The daemon is the record; the app is a cache over it.
// Reading a thread is never an act (06.A), so nothing here can say seen,
// read or mark: the only write is an act, or clearing one.

/// One conversation's state as the board reads it.
public struct SyncedThreadState: Equatable, Sendable {
  /// Nil when no act is stored, or when the stored act is one this build
  /// cannot read (a vocabulary the daemon widened reads as none).
  public var act: ThreadAct?
  /// Nil means the derived default (06.B: 1:1 queue, group stream).
  public var mode: ThreadMode?
  /// The daemon's stamp, sent back as `ifUpdatedAt` on the next write.
  public var updatedAt: String

  public init(act: ThreadAct?, mode: ThreadMode?, updatedAt: String) {
    self.act = act
    self.mode = mode
    self.updatedAt = updatedAt
  }
}

public protocol ThreadStateSync: Sendable {
  /// Every stored record, by chatGuid.
  func load() async throws -> [String: SyncedThreadState]
  /// Writes `act` on `guid` (nil clears the act). `expected` is the
  /// updatedAt the caller last saw, nil for "I expect no record"; another
  /// window's write in between is a `.conflict` refusal. `restore` (undo)
  /// sends the act's own instant; a fresh act lets the daemon stamp it.
  /// Answers the new updatedAt, nil when the record was cleared. A refusal
  /// is an answer (Outcome), an unreachable daemon throws.
  func write(_ guid: String, act: ThreadAct?, expected: String?, restore: Bool) async throws -> Outcome<String?>
}

extension ThreadStateSync {
  public func write(_ guid: String, act: ThreadAct?, expected: String?) async throws -> Outcome<String?> {
    try await write(guid, act: act, expected: expected, restore: false)
  }
}

extension ThreadStateRecord {
  /// The stored act, read as the board's ThreadAct. Nil on an unknown act,
  /// an instant that does not parse, or a snooze with no end.
  public var threadAct: ThreadAct? {
    guard let act, let actAt, let at = WireDate.parse(actAt) else { return nil }
    switch act {
    case "done": return .done(at: at)
    case "muted": return .muted(at: at)
    case "snoozed":
      guard let snoozedUntil, let until = WireDate.parse(snoozedUntil) else { return nil }
      return .snoozed(at: at, until: until)
    default: return nil
    }
  }

  /// The stored attention, read as the board's ThreadMode; nil is the default.
  public var threadMode: ThreadMode? {
    switch attention {
    case "queue": .queue
    case "stream": .stream
    case "muted": .muted
    default: nil
    }
  }

  public var synced: SyncedThreadState {
    SyncedThreadState(act: threadAct, mode: threadMode, updatedAt: updatedAt)
  }
}

extension ThreadStateInput {
  /// The PUT body for `act`. Attention is never sent: F3 draws no picker
  /// (D-F3-4), so the daemon keeps whatever the CLI set.
  public static func writing(_ act: ThreadAct?, expected: String?, restore: Bool) -> ThreadStateInput {
    let ifUpdatedAt: Nullable<String> = expected.map { .value($0) } ?? .null
    guard let act else { return ThreadStateInput(act: nil, ifUpdatedAt: ifUpdatedAt) }
    let actAt = restore ? WireDate.format(act.at) : nil
    switch act {
    case .done: return ThreadStateInput(act: "done", actAt: actAt, ifUpdatedAt: ifUpdatedAt)
    case .muted: return ThreadStateInput(act: "muted", actAt: actAt, ifUpdatedAt: ifUpdatedAt)
    case .snoozed(_, let until):
      return ThreadStateInput(
        act: "snoozed", actAt: actAt, snoozedUntil: WireDate.format(until), ifUpdatedAt: ifUpdatedAt)
    }
  }
}

/// A refusal on a read the board cannot do without.
public struct ThreadStateLoadRefused: Error, Equatable, Sendable {
  public var refusal: Refusal
}

/// The daemon-backed sync: `GET /v1/threads/state` and
/// `PUT /v1/threads/:guid/state` under the operator bearer.
public struct GatewayThreadStateSync: ThreadStateSync {
  public let client: GatewayClient

  public init(client: GatewayClient) {
    self.client = client
  }

  public func load() async throws -> [String: SyncedThreadState] {
    switch try await client.listThreadStates() {
    case .ok(let page):
      var out: [String: SyncedThreadState] = [:]
      for record in page.states { out[record.chatGuid] = record.synced }
      return out
    case .refused(let refusal):
      throw ThreadStateLoadRefused(refusal: refusal)
    }
  }

  public func write(_ guid: String, act: ThreadAct?, expected: String?, restore: Bool) async throws -> Outcome<String?> {
    let input = ThreadStateInput.writing(act, expected: expected, restore: restore)
    switch try await client.setThreadState(guid, input) {
    case .ok(let envelope): return .ok(envelope.state?.updatedAt)
    case .refused(let refusal): return .refused(refusal)
    }
  }
}

/// A sync with no daemon, for tests and previews. It keeps the daemon's
/// rules that matter to a caller: the ifUpdatedAt check, a cleared act
/// deleting the record, and a fresh stamp on every write.
public actor InMemoryThreadStateSync: ThreadStateSync {
  public struct Write: Equatable, Sendable {
    public var guid: String
    public var act: ThreadAct?
    public var expected: String?
    public var restore: Bool

    public init(guid: String, act: ThreadAct?, expected: String?, restore: Bool) {
      self.guid = guid
      self.act = act
      self.expected = expected
      self.restore = restore
    }
  }

  public struct Unreachable: Error, Equatable, Sendable {}

  public private(set) var records: [String: SyncedThreadState]
  public private(set) var writes: [Write] = []
  public private(set) var loads = 0
  private var refusal: Refusal?
  private var failing = false
  private var failingLoad = false
  private var stamp: Date

  public init(records: [String: SyncedThreadState] = [:], start: Date = Date(timeIntervalSince1970: 1_788_264_042)) {
    self.records = records
    self.stamp = start
  }

  /// The next write answers this refusal and changes nothing.
  public func refuseNext(_ refusal: Refusal) { self.refusal = refusal }
  /// The next write throws, as an unreachable daemon does.
  public func failNext() { failing = true }
  /// The next load throws.
  public func failNextLoad() { failingLoad = true }

  /// Another window's write: changes the record without going through `write`.
  public func set(_ guid: String, _ state: SyncedThreadState?) {
    records[guid] = state
  }

  public func load() async throws -> [String: SyncedThreadState] {
    loads += 1
    if failingLoad {
      failingLoad = false
      throw Unreachable()
    }
    return records
  }

  public func write(_ guid: String, act: ThreadAct?, expected: String?, restore: Bool) async throws -> Outcome<String?> {
    writes.append(Write(guid: guid, act: act, expected: expected, restore: restore))
    if failing {
      failing = false
      throw Unreachable()
    }
    if let refusal {
      self.refusal = nil
      return .refused(refusal)
    }
    let current = records[guid]
    guard current?.updatedAt == expected else {
      return .refused(.conflict(code: "conflict", from: nil, requested: nil))
    }
    let mode = current?.mode
    if act == nil && mode == nil {
      records[guid] = nil
      return .ok(nil)
    }
    stamp = stamp.addingTimeInterval(0.001)
    let updatedAt = WireDate.format(stamp)
    records[guid] = SyncedThreadState(act: act, mode: mode, updatedAt: updatedAt)
    return .ok(updatedAt)
  }
}
