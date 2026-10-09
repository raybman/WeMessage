import Foundation

/// A channel a thread can arrive on, in rail order. One type for what used
/// to be three parallel enums: the compose cards, the rail's scopes and the
/// board's per-scope filter all map through it (v2 B0).
public enum Channel: String, Codable, CaseIterable, Sendable {
  case imessage, whatsapp, linkedin, email

  /// The wire's channel string. A string this version does not know folds to
  /// iMessage, the one channel every thread can be read on today: a new
  /// channel from a newer daemon draws as iMessage, never crashes.
  public init(wire: String) { self = Channel(rawValue: wire) ?? .imessage }
}

/// Why a channel is not connected. The wire spells each in snake case.
public enum NotConnectedReason: String, Codable, Sendable {
  /// Today's copy: the only reason the real daemon gives.
  case notInThisVersion = "not_in_this_version"
  /// Reserved for adapters; nothing produces these until one exists.
  case adapterMissing = "adapter_missing"
  case linkExpired = "link_expired"
  case authRequired = "auth_required"
}

/// What the app may do with a channel.
public enum ChannelAvailability: Equatable, Sendable {
  /// This version reads the channel.
  case connected
  /// The board renders over fixture data. Only the fake daemon serves this
  /// state, and only an open `PreviewGate` reads it (see `table`).
  case preview(scenario: String)
  /// The board shows the not-connected card, for `reason`.
  case notConnected(reason: NotConnectedReason)

  /// Whether the rail draws a mark for the channel: connected and preview
  /// do, not connected says nothing.
  public var drawsMark: Bool {
    if case .notConnected = self { return false }
    return true
  }

  /// The availability of every channel, from a status payload's `channels`.
  ///
  /// A channel the list does not name is not connected in this version; so
  /// is a state this version does not know. The fixture state reads as
  /// preview only through an open gate, and the scenario's name rides in
  /// `reason`; through a closed gate it is a state like any other unknown
  /// one. An entry naming a channel this version does not know is skipped,
  /// never folded onto iMessage. The first entry for a channel wins.
  public static func table(_ entries: [ChannelStatusPayload]?, gate: PreviewGate) -> [Channel: ChannelAvailability] {
    var out: [Channel: ChannelAvailability] = [:]
    for entry in entries ?? [] {
      guard let channel = Channel(rawValue: entry.channel), out[channel] == nil else { continue }
      out[channel] = availability(entry, gate: gate)
    }
    for channel in Channel.allCases where out[channel] == nil {
      out[channel] = .notConnected(reason: .notInThisVersion)
    }
    return out
  }

  static func availability(_ entry: ChannelStatusPayload, gate: PreviewGate) -> ChannelAvailability {
    if entry.state == ChannelWire.connected { return .connected }
    if let opened = gate.state, entry.state == opened { return .preview(scenario: entry.reason ?? "") }
    let reason = entry.reason.flatMap(NotConnectedReason.init(rawValue:)) ?? .notInThisVersion
    return .notConnected(reason: reason)
  }
}

/// One channel and what the app may do with it.
public struct ChannelStatus: Equatable, Sendable {
  public let channel: Channel
  public let availability: ChannelAvailability

  public init(channel: Channel, availability: ChannelAvailability) {
    self.channel = channel
    self.availability = availability
  }
}

/// The one door to the fixture state. Closed, the reducer cannot produce
/// `.preview`: the kit never spells the fixture state's wire word, so
/// nothing a daemon sends can open a board over fixtures. The app opens the
/// gate under its UI-test flag only, by handing it the word.
public struct PreviewGate: Equatable, Sendable {
  /// The wire state that reads as preview; nil when closed.
  public let state: String?

  public init(state: String?) { self.state = state }

  /// The released app's gate.
  public static let closed = PreviewGate(state: nil)
}

/// The two states the real daemon sends.
enum ChannelWire {
  static let connected = "connected"
  static let notConnected = "not_connected"
}
