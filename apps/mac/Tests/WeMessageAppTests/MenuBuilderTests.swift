import Foundation
import Testing
import WeMessageKit

@testable import WeMessageApp

/// v2 S4l, board 16.G: the main menu as the app builds it, read back from
/// the built items (their identifiers, titles, key equivalents and state),
/// never from the table alone. No application is touched: the menu is
/// built and read, never installed.
@Suite("MenuBuilder")
@MainActor
struct MenuBuilderTests {
  static let context = MenuContext(scope: "imessage", posture: "Drafting on \u{00B7} 3 drafts ready")
  static var spec: [MenuItemSpec] { AppMenu.top(context) }

  /// "path | id | title | chord | state", split.
  static func rows(_ context: MenuContext = context) -> [[String]] {
    MenuBuilder.dump(MenuBuilder.build(AppMenu.top(context))).map { $0.components(separatedBy: " | ") }
  }

  static func row(_ id: String) -> [String]? { rows().first { $0[1] == id } }

  /// Every accelerator the 16.G table binds, by id. Anything not here has
  /// no key equivalent.
  static let accelerators: [String: String] = [
    "app:settings": "\u{2318},",
    "app:hide": "\u{2318}H",
    "app:hide-others": "\u{2325}\u{2318}H",
    "app:quit": "\u{2318}Q",
    "file:new": "\u{2318}N",
    "file:close": "\u{2318}W",
    "edit:undo": "\u{2318}Z",
    "edit:redo": "\u{21E7}\u{2318}Z",
    "edit:cut": "\u{2318}X",
    "edit:copy": "\u{2318}C",
    "edit:paste": "\u{2318}V",
    "edit:paste-plain": "\u{2325}\u{21E7}\u{2318}V",
    "edit:select-all": "\u{2318}A",
    "edit:find": "\u{2318}F",
    "edit:find-next": "\u{2318}G",
    "edit:find-prev": "\u{21E7}\u{2318}G",
    "edit:find-all": "\u{21E7}\u{2318}F",
    "edit:spell-panel": "\u{2318}:",
    "edit:spell-now": "\u{2318};",
    "view:lens-recent": "\u{21E7}\u{2318}R",
    "view:lens-needs": "\u{21E7}\u{2318}N",
    "view:lens-triage": "\u{2318}T",
    "view:scope-all": "\u{2318}1",
    "view:scope-imessage": "\u{2318}2",
    "view:scope-whatsapp": "\u{2318}3",
    "view:scope-linkedin": "\u{2318}4",
    "view:scope-email": "\u{2318}5",
    "view:fullscreen": "\u{2303}\u{2318}F",
    "thread:next": "\u{21E7}\u{2318}]",
    "thread:prev": "\u{21E7}\u{2318}[",
    "thread:switcher": "\u{2318}K",
    "thread:mark-read": "\u{21E7}\u{2318}A",
    "win:minimize": "\u{2318}M",
  ]

  @Test("ids and accelerators: the built menu binds exactly the 16.G table, and the table says the same")
  func accelerators() {
    let built = Dictionary(Self.rows().filter { !$0[3].isEmpty }.map { ($0[1], $0[3]) }, uniquingKeysWith: { a, _ in a })
    #expect(built == Self.accelerators)
    let table = Dictionary(
      AppMenu.flatten(Self.spec).filter { !$0.key.isEmpty && $0.kind != .system }.map { ($0.id, $0.chord) },
      uniquingKeysWith: { a, _ in a })
    #expect(table == Self.accelerators)
    #expect(AppMenu.collisions(Self.spec).isEmpty, "\(AppMenu.collisions(Self.spec))")
  }

  @Test("every 16.G id is in the built menu once, under the eight titles in order; rows macOS inserts are left to it")
  func ids() {
    let rows = Self.rows()
    let ids = rows.map { $0[1] }
    #expect(!ids.contains(""))
    #expect(Set(ids).count == ids.count)
    let expected = AppMenu.flatten(Self.spec).filter { $0.kind != .system }.map(\.id)
    #expect(ids == expected)
    #expect(ids.count >= 90, "built ids: \(ids.count)")
    let top = rows.filter { !$0[0].contains(" > ") }.map { $0[2] }
    #expect(top == AppMenu.titles)
    #expect(!ids.contains("edit:dictation") && !ids.contains("edit:emoji"))
    for id in [
      "menu:app", "app:about", "app:services", "file:new", "edit:paste-plain", "edit:smart-dashes", "edit:autocorrect",
      "view:inspector", "thread:open", "thread:undo", "thread:hold-until:1h", "thread:approve-note", "agent:posture",
      "agent:kill", "agent:pause:resume", "win:show", "help:limits",
    ] {
      #expect(ids.contains(id), "\(id) is not in the built menu")
    }
  }

  @Test("no bare-letter key equivalent anywhere: every bound key carries command or control, in every scope")
  func noBareLetters() {
    for scope in AppMenu.scopes.map(\.id) {
      let context = MenuContext(scope: scope, posture: "")
      #expect(AppMenu.bareKeys(AppMenu.top(context)).isEmpty, "\(AppMenu.bareKeys(AppMenu.top(context)).map(\.id))")
      for row in Self.rows(context) where !row[3].isEmpty {
        #expect(row[3].contains("\u{2318}") || row[3].contains("\u{2303}"), "\(row[1]) binds a bare \(row[3])")
      }
    }
    // The single-letter verbs print as hints, after a tab, and bind nothing.
    for (id, hint) in [("thread:reply", "R"), ("thread:done", "E"), ("thread:snooze", "H"), ("thread:mute", "M")] {
      let spec = AppMenu.flatten(Self.spec).first { $0.id == id }!
      let item = MenuBuilder.item(spec)
      #expect(item?.keyEquivalent == "", "\(id) binds a key")
      #expect(item?.toolTip == "Key: " + hint)
      #expect(item?.attributedTitle?.string == spec.title + "\t" + hint)
      #expect(Self.row(id)?[2] == spec.title)
    }
  }

  @Test("the kill switch carries no accelerator, in the main menu or the Dock menu")
  func noKillAccelerator() {
    let kill = AppMenu.flatten(Self.spec).first { $0.id == "agent:kill" }
    #expect(kill?.key == "")
    #expect(kill?.modifiers == [])
    #expect(Self.row("agent:kill")?[3] == "")
    #expect(Self.row("agent:kill")?[2] == "Kill Switch\u{2026}")
    for row in Self.rows() where row[2].localizedCaseInsensitiveContains("kill") {
      #expect(row[3].isEmpty, "\(row[1]) binds \(row[3])")
    }
    let dock = DockMenu.lines(
      snapshot: OSSnapshot(count: 3, fresh: true, connected: true, killed: false), drafts: 1, asOf: "16:42:07",
      sourcesLine: "4 sources synced", perChannel: [("iMessage", 3)])
    #expect(dock.first { $0.id == "dock:kill" }?.chord == "")
    let built = MenuBuilder.dump(MenuBuilder.dock(dock)).map { $0.components(separatedBy: " | ") }
    #expect(built.first { $0[1] == "dock:kill" }?[3] == "")
  }

  @Test("Approve is absent: no row offers it, the one line that names it is disabled text, and no refused title is built")
  func approveAbsent() {
    let rows = Self.rows()
    let naming = rows.filter { $0[2].contains("Approv") }
    #expect(naming.map { $0[1] } == ["thread:approve-note"])
    #expect(naming.first?[4] == "text")
    #expect(naming.first?[3] == "")
    for title in AppMenu.refusedTitles {
      #expect(!rows.contains { $0[2] == title }, "the menu offers \(title)")
    }
    let words = AppMenu.routedIds(Self.spec).flatMap { $0.split(whereSeparator: { ":-".contains($0) }).map(String.init) }
    #expect(!words.contains("approve") && !words.contains("send") && !words.contains("release"))
  }

  @Test("Paste and Match Style is opt-shift-cmd-V; Smart Dashes and autocorrect are present and off")
  func editMenu() {
    #expect(Self.row("edit:paste-plain")?[2] == "Paste and Match Style")
    #expect(Self.row("edit:paste-plain")?[3] == "\u{2325}\u{21E7}\u{2318}V")
    #expect(Self.row("edit:smart-dashes")?[4] == "")
    #expect(Self.row("edit:autocorrect")?[4] == "")
    let spec = AppMenu.flatten(Self.spec)
    #expect(spec.first { $0.id == "edit:smart-dashes" }?.kind == .toggle(action: "toggleAutomaticDashSubstitution:", on: false))
    #expect(spec.first { $0.id == "edit:autocorrect" }?.kind == .toggle(action: "toggleAutomaticSpellingCorrection:", on: false))
  }

  @Test("standard commands keep their responder selector; the rest route through the hub by id and are disabled until registered")
  func routing() {
    let spec = AppMenu.flatten(Self.spec)
    let paste = MenuBuilder.item(spec.first { $0.id == "edit:paste" }!)
    #expect(paste?.action == NSSelectorFromString("paste:"))
    #expect(paste?.target == nil)
    let copyLink = MenuBuilder.item(spec.first { $0.id == "thread:copy-link" }!)
    #expect(copyLink?.target === MenuBuilder.router)
    #expect(MenuBuilder.router.validateMenuItem(copyLink!) == false)
    let posture = MenuBuilder.item(spec.first { $0.id == "agent:posture" }!)
    #expect(posture?.isEnabled == false)
    #expect(posture?.title == Self.context.posture)
    // The Dock's lines run the main menu's commands of the same meaning.
    #expect(MenuBuilder.command(for: "dock:triage") == "view:lens-triage")
    #expect(MenuBuilder.command(for: "dock:new") == "file:new")
    #expect(MenuBuilder.command(for: "dock:kill") == "agent:kill")
    #expect(MenuBuilder.command(for: "dock:channel-whatsapp") == "view:scope-whatsapp")
  }
}
