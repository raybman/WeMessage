import Foundation
import Testing
import WeMessageKit

@testable import WeMessageApp

/// v2 S4l, board 16.D: the categories the app registers, built from the
/// kit's closed union of five ids; no action takes text; a banner's
/// response routes by the union; and in tests the poster is the recorder,
/// so nothing ever reaches the notification center.
@Suite("Notifications")
@MainActor
struct NotificationsTests {
  static let five = ["open", "draft", "snooze:1h", "mute:thread", "done"]

  @Test("five ids: every category offers only ids from the union, each kind its own set, titled from the kit")
  func fiveIds() {
    #expect(NotificationAction.allCases.map(\.rawValue) == Self.five)
    var offered: Set<String> = []
    for kind in NotificationKind.allCases {
      let ids = Notifications.actionIds(kind)
      #expect(ids == kind.actions.map(\.rawValue))
      offered.formUnion(ids)
      #expect(Notifications.category(kind).identifier == "wemessage." + kind.rawValue)
      #expect(Notifications.category(kind).actions.map(\.title) == kind.actions.map(\.title))
    }
    #expect(offered == Set(Self.five))
    #expect(Notifications.categories.map(\.identifier) == [
      "wemessage.stream-question", "wemessage.linkedin-request", "wemessage.email", "wemessage.group-stack",
    ])
    for category in Notifications.categories {
      for action in category.actions {
        #expect(!NotificationRules.refusedActionTitles.contains(action.title), "\(category.identifier) offers \(action.title)")
      }
    }
  }

  @Test("the switch over the union has no default, in action() and in route()")
  func switchWithoutDefault() throws {
    let source = try Repo.text(AppHygieneTests.notesFile)
    #expect(!source.contains("default:"))
    #expect(!source.contains("@unknown"))
    #expect(source.components(separatedBy: "switch action {").count == 3)
    for action in NotificationAction.allCases {
      #expect(source.contains("case ." + String(describing: action) + ":"), "a switch skips \(action)")
    }
  }

  @Test("inline reply is false: no action in any category takes text")
  func noInlineReply() {
    #expect(NotificationRules.inlineReply == false)
    #expect(Notifications.anyTextInput == false)
  }

  @Test("tests post to the recorder only; a post obeys the rules: muted, or not a kind, posts nothing")
  func recorderOnly() {
    #expect(Notifications.poster is RecordedPoster)
    let saved = Notifications.poster
    let recorder = RecordedPoster()
    Notifications.poster = recorder
    defer { Notifications.poster = saved }
    recorder.register(Notifications.categories)
    #expect(recorder.registered.count == 4)
    Notifications.post(.email, title: "Rosa Diaz", body: "Lunch Thursday?", thread: "t1", channel: "email", muted: false)
    Notifications.post(.email, title: "Rosa Diaz", body: "Again", thread: "t1", channel: "email", muted: true)
    Notifications.post(nil, title: "Agent", body: "A draft is ready", thread: "t2", channel: "imessage", muted: false)
    #expect(recorder.posted.count == 1)
    #expect(recorder.posted.first?.category == "wemessage.email")
    #expect(recorder.posted.first?.actions == ["open", "draft", "done", "snooze:1h"])
  }

  @Test("a banner's response routes by the union: open and draft hand off to the thread, the rest act on it; an unknown id does nothing")
  func routes() {
    let hub = OSLayerHub.shared
    var seen: [String] = []
    hub.register("handoff") {
      let target = hub.takeHandoff()
      seen.append("handoff \(target?.threadGuid ?? "") \(target?.focus == .composer ? "composer" : "list")")
    }
    for id in ["popover:snooze", "popover:mute", "popover:done"] {
      hub.register(id) { seen.append("\(id) \(hub.takeHandoff()?.threadGuid ?? "")") }
    }
    for action in NotificationAction.allCases {
      Notifications.route(action.rawValue, thread: "t9", channel: "whatsapp")
    }
    Notifications.route("reply", thread: "t9", channel: "whatsapp")
    #expect(seen == [
      "handoff t9 list", "handoff t9 composer", "popover:snooze t9", "popover:mute t9", "popover:done t9",
    ])
  }
}
