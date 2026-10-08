import Foundation
import Testing
import WeMessageKit

@testable import WeMessageApp

/// v2 S4j, board 13: the settings window's model. Seven panes in the plan's
/// order; the mirrored accessibility rows are read-only; auto-send and
/// schedules are parked and never armable; the window reads settings once
/// and writes nothing but the kill switch's release, behind a confirm.
@Suite("SettingsModel")
@MainActor
struct SettingsModelTests {
  /// A model over a fake daemon that answers with `scenario`'s files, and
  /// the transport, so a test can read what was asked.
  static func model(_ scenario: String = "rich") -> (SettingsModel, FakeTransport) {
    let transport = FakeTransport { request in
      let path = request.url?.path ?? ""
      let method = request.httpMethod ?? "GET"
      switch (method, path) {
      case ("GET", "/v1/settings"): return try Reply.scenario(scenario, "settings.list.json")
      case ("GET", "/v1/status"): return try Reply.scenario(scenario, "status.json")
      case ("POST", "/v1/toggles/kill-switch"): return try Reply.golden("responses/toggles.killswitch.off.json")
      default: throw Unreachable()
      }
    }
    let client = testClient(transport)
    return (SettingsModel(client: client, shell: ShellModel(client: client)), transport)
  }

  static func calls(_ transport: FakeTransport) -> [String] {
    transport.requests.map { ($0.httpMethod ?? "GET") + " " + ($0.url?.path ?? "") }
  }

  @Test("the seven panes, in the plan's order, with their names")
  func panes() {
    #expect(SettingsPane.allCases.map(\.rawValue) == [
      "accounts", "drafting", "notifications", "appearance", "keyboard", "storage", "confirm",
    ])
    #expect(SettingsPane.allCases.map(\.title) == [
      "Accounts", "Drafting", "Notifications", "Appearance", "Keyboard", "Storage", "Confirmations",
    ])
  }

  @Test("the accessibility rows mirror macOS read-only, each with what it changes, and the frost sentence is D-UI-13 (b)")
  func mirroredReadOnly() {
    let on = SettingsModel.mirrored(.init(reduceTransparency: true, increaseContrast: false, reduceMotion: true))
    #expect(on.map(\.id) == ["reducetransparency", "increasecontrast", "reducemotion"])
    #expect(on.map(\.on) == [true, false, true])
    #expect(on.allSatisfy { !$0.editable && !$0.effect.isEmpty })
    let off = SettingsModel.mirrored(.init(reduceTransparency: false, increaseContrast: false, reduceMotion: false))
    #expect(off.allSatisfy { !$0.editable && !$0.on })
    #expect(SettingsModel.frostSentence.hasPrefix("Frost sits on the window behind the panes."))
    #expect(SettingsModel.frostSentence.contains("the opaque rendering is the one we designed first"))
    #expect(SettingsModel.mirroredWhere.contains("never changed here"))
  }

  @Test("auto-send and schedules are parked: never armable, and the copy says so in words")
  func parkedNeverArmable() {
    #expect(SettingsModel.parked.map(\.id) == ["autosend", "schedules"])
    #expect(SettingsModel.parked.allSatisfy { !$0.armable })
    #expect(SettingsModel.parked.allSatisfy { $0.copy.hasPrefix("Parked.") })
  }

  @Test("load reads settings once and nothing else; the pane lines come from what it read")
  func loadReadsOnly() async {
    let (model, transport) = Self.model()
    await model.load()
    #expect(Self.calls(transport) == ["GET /v1/settings"])
    #expect(model.loaded)
    #expect(model.draftOnly)
    #expect(model.limits.map(\.value) == ["10s  (0 to 300)", "1  (1 to 60)", "10  (1 to 600)", "30  (1 to 10000)"])
    #expect(model.keymap == .default, "keymap.bindings is not served yet: the default")
    #expect(model.stateLine(.keyboard) == "5 verbs, 0 rebound")
    #expect(model.stateLine(.storage) == "not reported by this daemon")
  }

  @Test("a daemon that does not answer leaves every line honest, never a zero")
  func unreachable() async {
    let transport = FakeTransport { _ in throw Unreachable() }
    let client = testClient(transport)
    let model = SettingsModel(client: client, shell: ShellModel(client: client))
    await model.load()
    #expect(!model.draftOnly)
    #expect(model.limits.allSatisfy { $0.value == "not reported by this daemon" })
    #expect(model.killState == "unknown")
    #expect(model.stateLine(.drafting) == "mode not reported")
  }

  @Test("release asks first; go is the shell's own disengage, and nothing else is written")
  func releaseThroughConfirm() async {
    let (model, transport) = Self.model("kill")
    await model.shell.refresh()
    #expect(model.killState == "on")
    let before = Self.calls(transport).filter { !$0.hasPrefix("GET ") }
    #expect(before == [])
    model.ask(.releaseKill)
    #expect(model.confirm == .releaseKill)
    #expect(model.canGo(.releaseKill))
    await model.go()
    #expect(model.confirm == nil)
    let writes = Self.calls(transport).filter { !$0.hasPrefix("GET ") }
    #expect(writes == ["POST /v1/toggles/kill-switch"])
  }

  @Test("cancel writes nothing, and delete's go is disabled and inert")
  func deleteIsInert() async {
    let (model, transport) = Self.model("kill")
    model.ask(.releaseKill)
    model.cancel()
    #expect(model.confirm == nil)
    model.ask(.deleteCopy)
    #expect(!model.canGo(.deleteCopy))
    await model.go()
    #expect(model.confirm == nil)
    #expect(transport.requests.isEmpty)
    #expect(SettingsModel.deleteCopyLines.count == 3)
    #expect(SettingsModel.deleteCopyNotHere.hasPrefix("Not in this version."))
  }
}
