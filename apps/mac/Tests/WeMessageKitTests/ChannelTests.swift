import Foundation
import Testing
@testable import WeMessageKit

/// v2 B0: the channel model. A wire string folds onto `Channel`, unknown to
/// iMessage; a status payload's `channels` fold to one availability per
/// channel; and the fixture state reads as preview only through a gate the
/// kit never opens itself.
@Suite("Channel")
struct ChannelTests {
  /// The word the fake daemon serves for the fixture state. The test spells
  /// it; the kit's sources never do.
  static let fixtureWord = "pre" + "view"
  static let open = PreviewGate(state: fixtureWord)

  static func entry(_ channel: String, _ state: String, _ reason: String? = nil) -> ChannelStatusPayload {
    ChannelStatusPayload(channel: channel, state: state, reason: reason)
  }

  /// What the real daemon says in this version.
  static let real: [ChannelStatusPayload] = [
    entry("imessage", "connected"),
    entry("whatsapp", "not_connected", "not_in_this_version"),
    entry("linkedin", "not_connected", "not_in_this_version"),
    entry("email", "not_connected", "not_in_this_version"),
  ]

  @Test("C1: the four channels in rail order, each its own wire string")
  func railOrder() {
    #expect(Channel.allCases == [.imessage, .whatsapp, .linkedin, .email])
    #expect(Channel.allCases.map(\.rawValue) == ["imessage", "whatsapp", "linkedin", "email"])
    for channel in Channel.allCases { #expect(Channel(wire: channel.rawValue) == channel) }
  }

  @Test("C2: a wire string this version does not know folds to iMessage and never crashes")
  func unknownFoldsToIMessage() {
    for raw in ["sms", "", "WhatsApp", "telegram", "imessage "] {
      #expect(Channel(wire: raw) == .imessage, "\(raw)")
    }
  }

  @Test("C3: the reasons are snake case on the wire")
  func reasonsOnTheWire() throws {
    let pairs: [(NotConnectedReason, String)] = [
      (.notInThisVersion, "not_in_this_version"), (.adapterMissing, "adapter_missing"),
      (.linkExpired, "link_expired"), (.authRequired, "auth_required"),
    ]
    for (reason, wire) in pairs {
      #expect(reason.rawValue == wire)
      #expect(try JSONEncoder().encode(reason) == Data("\"\(wire)\"".utf8))
    }
  }

  @Test("C4: the real daemon's answer: iMessage connected, the other three not in this version, open gate or closed")
  func realAnswer() {
    for gate in [PreviewGate.closed, Self.open] {
      let table = ChannelAvailability.table(Self.real, gate: gate)
      #expect(table == [
        .imessage: .connected,
        .whatsapp: .notConnected(reason: .notInThisVersion),
        .linkedin: .notConnected(reason: .notInThisVersion),
        .email: .notConnected(reason: .notInThisVersion),
      ])
    }
  }

  @Test("C5: no status, an empty list or a missing channel: not connected in this version")
  func missingIsNotConnected() {
    let none = ChannelAvailability.table(nil, gate: .closed)
    #expect(Set(none.keys) == Set(Channel.allCases))
    #expect(none.values.allSatisfy { $0 == .notConnected(reason: .notInThisVersion) })
    #expect(ChannelAvailability.table([], gate: Self.open) == none)
    let onlyIMessage = ChannelAvailability.table([Self.entry("imessage", "connected")], gate: .closed)
    #expect(onlyIMessage[.imessage] == .connected)
    #expect(onlyIMessage[.email] == .notConnected(reason: .notInThisVersion))
  }

  @Test("C6: the derivation table: state and reason to availability")
  func derivationTable() {
    let rows: [(ChannelStatusPayload, PreviewGate, ChannelAvailability)] = [
      (Self.entry("whatsapp", "connected"), .closed, .connected),
      (Self.entry("whatsapp", "not_connected"), .closed, .notConnected(reason: .notInThisVersion)),
      (Self.entry("whatsapp", "not_connected", "link_expired"), .closed, .notConnected(reason: .linkExpired)),
      (Self.entry("whatsapp", "not_connected", "auth_required"), .closed, .notConnected(reason: .authRequired)),
      (Self.entry("whatsapp", "not_connected", "adapter_missing"), .closed, .notConnected(reason: .adapterMissing)),
      (Self.entry("whatsapp", "not_connected", "gibberish"), .closed, .notConnected(reason: .notInThisVersion)),
      (Self.entry("whatsapp", "half_connected"), .closed, .notConnected(reason: .notInThisVersion)),
      (Self.entry("whatsapp", "half_connected"), Self.open, .notConnected(reason: .notInThisVersion)),
      (Self.entry("whatsapp", Self.fixtureWord, "preview-whatsapp"), Self.open, .preview(scenario: "preview-whatsapp")),
      (Self.entry("whatsapp", Self.fixtureWord), Self.open, .preview(scenario: "")),
    ]
    for (entry, gate, want) in rows {
      #expect(ChannelAvailability.table([entry], gate: gate)[.whatsapp] == want, "\(entry.state) \(entry.reason ?? "-")")
    }
  }

  @Test("C7: a closed gate folds the fixture state to not connected: the released app cannot open a board over fixtures")
  func closedGateRefusesPreview() {
    let served = [Self.entry("whatsapp", Self.fixtureWord, "preview-whatsapp")]
    #expect(ChannelAvailability.table(served, gate: .closed)[.whatsapp] == .notConnected(reason: .notInThisVersion))
    #expect(ChannelAvailability.table(served, gate: Self.open)[.whatsapp] == .preview(scenario: "preview-whatsapp"))
    #expect(PreviewGate.closed.state == nil)
    #expect(AppState().previewGate == .closed)
  }

  @Test("C8: an unknown channel is skipped, never folded onto iMessage; the first entry for a channel wins")
  func unknownChannelSkipped() {
    let table = ChannelAvailability.table(
      [Self.entry("telegram", "connected"), Self.entry("imessage", "not_connected"), Self.entry("imessage", "connected")],
      gate: .closed)
    #expect(table[.imessage] == .notConnected(reason: .notInThisVersion))
    #expect(table.count == Channel.allCases.count)
  }

  @Test("C9: the rail draws a mark for connected and preview, never for not connected")
  func drawsMark() {
    #expect(ChannelAvailability.connected.drawsMark)
    #expect(ChannelAvailability.preview(scenario: "x").drawsMark)
    #expect(!ChannelAvailability.notConnected(reason: .notInThisVersion).drawsMark)
    #expect(!ChannelAvailability.notConnected(reason: .linkExpired).drawsMark)
  }

  static func status(_ channels: [ChannelStatusPayload]) throws -> StatusPayload {
    var status = try JSONDecoder().decode(StatusPayload.self, from: Fixtures.response("status").bodyData)
    status.channels = channels
    return status
  }

  @Test("C10: the reducer derives AppState.channels from a status read, through the state's own gate")
  func reducerDerives() throws {
    #expect(AppState().channels == ChannelAvailability.table(nil, gate: .closed))
    let served = try Self.status([Self.entry("imessage", "connected"), Self.entry("email", Self.fixtureWord, "preview-email")])

    let (closed, closedEffects) = AppReducer.reduce(AppState(), .response(.status(served)))
    #expect(closedEffects.isEmpty)
    #expect(closed.availability(.imessage) == .connected)
    #expect(closed.availability(.email) == .notConnected(reason: .notInThisVersion))

    let (opened, _) = AppReducer.reduce(AppState(previewGate: Self.open), .response(.status(served)))
    #expect(opened.availability(.email) == .preview(scenario: "preview-email"))
    #expect(opened.availability(.whatsapp) == .notConnected(reason: .notInThisVersion))
    // The drafts queue is untouched by a status read.
    #expect(opened.order == AppState().order && opened.stale == false)
  }

  @Test("C11: the S0 status golden folds to the real answer")
  func goldenFolds() throws {
    let golden = try JSONDecoder().decode(StatusPayload.self, from: Fixtures.response("status").bodyData)
    // v2 F7: the real daemon's iMessage entry also carries its facts; the
    // availability fold reads channel, state and reason only.
    #expect(golden.channels.map { Self.entry($0.channel, $0.state, $0.reason) } == Self.real)
    #expect(golden.channels.first?.today == 0)
    #expect(golden.channels.first?.handle == "+15550100000")
    #expect(golden.channels.dropFirst().allSatisfy { $0.today == nil && $0.handle == nil && $0.lastSyncAt == nil })
    #expect(ChannelAvailability.table(golden.channels, gate: Self.open)[.imessage] == .connected)
  }
}
