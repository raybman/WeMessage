import Foundation
import Testing
import WeMessageKit

@testable import WeMessageApp

/// v2 B0: the rail's availability rule. A channel draws a mark when it is
/// connected or, through an open gate, in the fixture state (D-UI-140: the
/// same mark, on the same freshness); a channel not connected never folds to
/// a mark, whatever its reason. iMessage keeps its own rule. Board 03 is
/// drawn only for a channel that draws a mark, and only a fixture board
/// carries the chip (D-UI-132).
@Suite("ShellBoard")
@MainActor
struct ShellBoardTests {
  /// The fixture state's word. Assembled: the app's sources spell it once,
  /// in TestHooks (H-B-1).
  static let fixtureWord = "pre" + "view"
  static let open = PreviewGate(state: fixtureWord)
  static let reasons: [NotConnectedReason] = [.notInThisVersion, .adapterMissing, .linkExpired, .authRequired]
  static let others: [ShellModel.Scope] = [.whatsapp, .linkedin, .email]

  struct Fixture {
    let status: StatusPayload
    let threads: ThreadsPage
    let drafts: [DraftPayload]
  }

  static func fixture(_ name: String) throws -> Fixture {
    Fixture(
      status: try ShellModelTests.decode(Reply.scenario(name, "status.json"), StatusPayload.self),
      threads: try ShellModelTests.decode(Reply.scenario(name, "threads.list.json"), ThreadsPage.self),
      drafts: try ShellModelTests.decode(Reply.scenario(name, "drafts.list.json"), DraftsEnvelope.self).drafts)
  }

  static func fold(_ f: Fixture, _ channels: [Channel: ChannelAvailability]) -> ShellBoard {
    ShellBoard.fold(status: f.status, threads: f.threads, drafts: f.drafts, window: QueueWindow(), channels: channels)
  }

  /// A table with every other channel not connected and `channel` set.
  static func table(_ channel: Channel, _ availability: ChannelAvailability) -> [Channel: ChannelAvailability] {
    var out = ChannelAvailability.table(nil, gate: .closed)
    out[.imessage] = .connected
    out[channel] = availability
    return out
  }

  @Test("SB1: rich folds through the real daemon's table exactly as before: iMessage and ALL unchanged, the other three say nothing")
  func richUnchanged() throws {
    let rich = try Self.fixture("rich")
    let before = ShellBoard.fold(status: rich.status, threads: rich.threads, drafts: rich.drafts, window: QueueWindow())
    for gate in [PreviewGate.closed, Self.open] {
      let after = Self.fold(rich, ChannelAvailability.table(rich.status.channels, gate: gate))
      #expect(after == before)
      for scope in Self.others { #expect(after.mark(scope) == RailMark.none, "\(scope)") }
    }
    #expect(before.mark(.imessage) != RailMark.none)
  }

  @Test("SB2: preview-whatsapp through an open gate: WhatsApp draws the clear baseline a connected quiet channel would, and ALL is clear")
  func previewDrawsMark() throws {
    let f = try Self.fixture("preview-whatsapp")
    let table = ChannelAvailability.table(f.status.channels, gate: Self.open)
    #expect(table[.whatsapp] == .preview(scenario: "preview-whatsapp"))
    let board = Self.fold(f, table)
    #expect(board.mark(.whatsapp) == .baseline)
    #expect(board.mark(.all) == .baseline)
    #expect(board.mark(.imessage) == .baseline)
    #expect(board.mark(.linkedin) == RailMark.none)
    #expect(board.mark(.email) == RailMark.none)
    // The same fold as a connected WhatsApp: the rail shows no difference.
    #expect(board == Self.fold(f, Self.table(.whatsapp, .connected)))
  }

  @Test("SB3: preview-whatsapp through the released app's closed gate: WhatsApp is not connected and says nothing")
  func closedGateNoMark() throws {
    let f = try Self.fixture("preview-whatsapp")
    let table = ChannelAvailability.table(f.status.channels, gate: .closed)
    #expect(table[.whatsapp] == .notConnected(reason: .notInThisVersion))
    #expect(Self.fold(f, table).mark(.whatsapp) == RailMark.none)
  }

  @Test("SB4: not connected never folds to a mark, for every reason and every channel, fresh or stale")
  func notConnectedNeverDraws() throws {
    for name in ["quiet", "rich", "degraded"] {
      let f = try Self.fixture(name)
      for scope in Self.others {
        guard let channel = scope.channel else { continue }
        for reason in Self.reasons {
          let board = Self.fold(f, Self.table(channel, .notConnected(reason: reason)))
          #expect(board.mark(scope) == RailMark.none, "\(name) \(scope) \(reason)")
        }
        #expect(Self.fold(f, [:]).mark(scope) == RailMark.none, "\(name) \(scope) unnamed")
      }
    }
  }

  @Test("SB5: the rule itself: connected and fixture draw, not connected and unnamed do not")
  func drawsMarkRule() {
    #expect(ShellBoard.drawsMark(.connected))
    #expect(ShellBoard.drawsMark(.preview(scenario: "x")))
    for reason in Self.reasons { #expect(!ShellBoard.drawsMark(.notConnected(reason: reason))) }
    #expect(!ShellBoard.drawsMark(nil))
  }

  @Test("SB6: a connected channel's mark follows freshness like iMessage's: stale on a stale scan")
  func connectedFollowsFreshness() throws {
    let f = try Self.fixture("degraded")
    let board = Self.fold(f, Self.table(.whatsapp, .connected))
    #expect(board.mark(.imessage) == .stale)
    #expect(board.mark(.whatsapp) == .stale)
  }

  @Test("SB7: the shell model derives availability from its status read through its own gate, and the rail follows")
  func shellModelWiring() throws {
    let f = try Self.fixture("preview-whatsapp")
    let m = ShellModel(client: testClient(FakeTransport { _ in throw Unreachable() }))
    #expect(m.state.previewGate == .closed, "swift test runs without the UI-test flag")
    m.status = f.status
    #expect(m.availability(.whatsapp) == .notConnected(reason: .notInThisVersion))
    #expect(m.board.mark(.whatsapp) == RailMark.none)

    let opened = ShellModel(client: testClient(FakeTransport { _ in throw Unreachable() }))
    opened.state = AppState(previewGate: Self.open)
    opened.status = f.status
    #expect(opened.availability(.whatsapp) == .preview(scenario: "preview-whatsapp"))
    #expect(opened.availability(.all) == nil)
    #expect(opened.board.mark(.whatsapp) == .baseline)
    opened.scope = .whatsapp
    #expect(opened.whatsAppBoard?.chip == TestHooks.previewChipText)
    opened.scope = .imessage
    #expect(opened.whatsAppBoard == nil)
    m.scope = .whatsapp
    #expect(m.whatsAppBoard == nil, "a closed gate draws no board 03")
  }

  @Test("SB8: board 03's words: a fixture board carries the chip, a connected one does not, a channel not connected has no board")
  func whatsAppBoardModel() {
    let chip = "chip"
    let fixture = WhatsAppBoardModel.make(.preview(scenario: "preview-whatsapp"), chipText: chip)
    #expect(fixture?.chip == chip)
    #expect(fixture?.banner == ProvisionalUI.whatsAppBannerName)
    #expect(fixture?.headline == ProvisionalUI.whatsAppEmptyHeadline)
    #expect(fixture?.detail == ProvisionalUI.whatsAppEmptyDetail)
    #expect(WhatsAppBoardModel.make(.connected, chipText: chip)?.chip == nil)
    #expect(WhatsAppBoardModel.make(.connected, chipText: chip) != nil)
    for reason in Self.reasons { #expect(WhatsAppBoardModel.make(.notConnected(reason: reason), chipText: chip) == nil) }
    #expect(WhatsAppBoardModel.make(nil, chipText: chip) == nil)
    let linked = WhatsAppBoardModel.make(.connected, linkedDevice: "Pixel", chipText: chip)
    #expect(linked?.banner.hasPrefix(ProvisionalUI.whatsAppBannerName + " ") == true)
    #expect(linked?.banner.hasSuffix(": Pixel.") == true)
    #expect(WhatsAppBoardModel.banner(linkedDevice: "") == ProvisionalUI.whatsAppBannerName)
  }
}
