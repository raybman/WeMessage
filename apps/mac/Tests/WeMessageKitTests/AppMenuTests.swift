import Foundation
import Testing

@testable import WeMessageKit

/// v2 S4l, board 16.G: the menu table as data, the Dock menu and the
/// notification union. The builder's half (the NSMenu it makes) is
/// MenuBuilderTests in the app's tests.
@Suite("AppMenu")
struct AppMenuTests {
  static let tree = AppMenu.top(MenuContext(scope: "imessage", posture: "Drafting on"))
  static var all: [MenuItemSpec] { AppMenu.flatten(tree) }
  static func item(_ id: String) -> MenuItemSpec? { all.first { $0.id == id } }

  @Test("the hold-until submenu exists only in the iMessage and Email scopes")
  func holdUntil() {
    for scope in ["imessage", "email"] {
      #expect(AppMenu.flatten(AppMenu.top(MenuContext(scope: scope))).contains { $0.id == "thread:hold-until:1h" })
    }
    for scope in ["all", "whatsapp", "linkedin"] {
      #expect(!AppMenu.flatten(AppMenu.top(MenuContext(scope: scope))).contains { $0.id.hasPrefix("thread:hold-until") })
    }
  }

  @Test("ids are unique and every non-separator item has one")
  func uniqueIds() {
    let ids = Self.all.map(\.id)
    #expect(!ids.contains(""))
    #expect(Set(ids).count == ids.count)
  }

  @Test("the Dock menu: dated header, sources, per channel with 'clear' for zero, and four items, kill without a chord")
  func dockMenu() {
    let lines = DockMenu.lines(
      snapshot: OSSnapshot(count: 9, fresh: true, connected: true, killed: false), drafts: 3, asOf: "16:42:07",
      sourcesLine: "4 sources synced, oldest 1m ago",
      perChannel: [("iMessage", 4), ("WhatsApp", 2), ("LinkedIn", 3), ("Email", 0)])
    #expect(lines.map(\.title) == [
      "9 left \u{00B7} 3 drafts ready \u{00B7} as of 16:42:07", "4 sources synced, oldest 1m ago", "iMessage 4",
      "WhatsApp 2", "LinkedIn 3", "Email clear", "Open WeMessage", "Triage", "New Message", "Kill Switch\u{2026}",
    ])
    #expect(lines.first { $0.id == "dock:kill" }?.chord == "")
    #expect(lines.first { $0.id == "dock:triage" }?.chord == "\u{2318}T")
    let degraded = DockMenu.lines(
      snapshot: OSSnapshot(count: 9, fresh: false, connected: true, killed: false), drafts: 3, asOf: "16:42:07",
      sourcesLine: "", perChannel: [("iMessage", 4)])
    #expect(degraded.first?.title == "Cannot say \u{00B7} as of 16:42:07")
    #expect(!degraded.contains { $0.title.contains("9") || $0.title == "iMessage 4" })
  }

  @Test("notifications: five action ids, the four kinds' sets, no agent drafts, no inline reply")
  func notifications() {
    #expect(NotificationAction.allCases.map(\.rawValue) == ["open", "draft", "snooze:1h", "mute:thread", "done"])
    #expect(NotificationKind.streamQuestion.actions == [.open, .draft, .snooze])
    #expect(NotificationKind.linkedinRequest.actions == [.open, .done])
    #expect(NotificationKind.email.actions == [.open, .draft, .done, .snooze])
    #expect(NotificationKind.groupStack.actions == [.open, .mute])
    #expect(!NotificationKind.allCases.map(\.rawValue).contains { $0.contains("draft") })
    #expect(NotificationRules.inlineReply == false)
    #expect(NotificationRules.interruption == "active")
    for action in NotificationAction.allCases {
      #expect(!NotificationRules.refusedActionTitles.contains(action.title))
    }
    #expect(NotificationRules.shouldPost(.email, muted: false))
    #expect(!NotificationRules.shouldPost(.email, muted: true))
    #expect(!NotificationRules.shouldPost(nil, muted: false))
  }
}
