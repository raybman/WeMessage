import Foundation
import UserNotifications
import WeMessageKit

/// v2 S4l, board 16.D: the one file that reaches the notification center
/// (AppHygieneTests H-A1 and H-S4-12). Categories are built from the kit's
/// closed union of five action ids; every switch over it is exhaustive with
/// no default, so a sixth id cannot ride in. No action takes text: an
/// inline reply would skip the thread, the draft state and the kill
/// switch's preflight. Nothing is Time Sensitive or critical, and an agent
/// draft is not a kind, so it never posts.
@MainActor
enum Notifications {
  /// Whoever receives a post. Under the UI-test flag, and in `swift test`,
  /// this is the recorder: the notification center is never touched.
  static var poster: any NotificationPoster = RecordedPoster()

  /// The category id for a kind.
  static func categoryId(_ kind: NotificationKind) -> String { "wemessage." + kind.rawValue }

  /// One action, built from the closed union.
  static func action(_ action: NotificationAction) -> UNNotificationAction {
    let options: UNNotificationActionOptions
    switch action {
    case .open: options = [.foreground]
    case .draft: options = [.foreground]
    case .snooze: options = []
    case .mute: options = []
    case .done: options = []
    }
    return UNNotificationAction(identifier: action.rawValue, title: action.title, options: options)
  }

  static func category(_ kind: NotificationKind) -> UNNotificationCategory {
    UNNotificationCategory(
      identifier: categoryId(kind), actions: kind.actions.map(action), intentIdentifiers: [], options: [])
  }

  static var categories: [UNNotificationCategory] { NotificationKind.allCases.map(category) }

  /// The action ids a kind's banner offers, read back from its category.
  static func actionIds(_ kind: NotificationKind) -> [String] { category(kind).actions.map(\.identifier) }

  /// No action in any category takes text.
  static var anyTextInput: Bool {
    categories.contains { $0.actions.contains { $0 is UNTextInputNotificationAction } }
  }

  /// A banner's response, routed to the hub by the union. An id outside the
  /// union, and the system's own dismiss, do nothing.
  static func route(_ actionId: String, thread: String, channel: String) {
    let hub = OSLayerHub.shared
    let target = Handoff(
      url: "", threadGuid: thread, channel: channel, focus: .list)
    if actionId == UNNotificationDefaultActionIdentifier {
      hub.handoff(target)
      return
    }
    guard let action = NotificationAction(rawValue: actionId) else { return }
    switch action {
    case .open: hub.handoff(target)
    case .draft: hub.handoff(Handoff(url: "", threadGuid: thread, channel: channel, focus: .composer))
    case .snooze: hub.actOn(thread, "popover:snooze")
    case .mute: hub.actOn(thread, "popover:mute")
    case .done: hub.actOn(thread, "popover:done")
    }
  }

  /// Posts one banner when the rules allow it. Nothing calls this yet
  /// (D-UI-116); it is the one door when something does.
  static func post(_ kind: NotificationKind?, title: String, body: String, thread: String, channel: String, muted: Bool)
  {
    guard NotificationRules.shouldPost(kind, muted: muted), let kind else { return }
    poster.post(
      PostedNotification(
        category: categoryId(kind), title: title, body: body, thread: thread, channel: channel,
        actions: actionIds(kind)))
  }
}

/// What one post carries.
struct PostedNotification: Equatable, Sendable {
  var category: String
  var title: String
  var body: String
  var thread: String
  var channel: String
  var actions: [String]
}

@MainActor
protocol NotificationPoster: AnyObject {
  func register(_ categories: [UNNotificationCategory])
  func post(_ note: PostedNotification)
}

/// The recorder: what would have posted, kept in memory.
@MainActor
final class RecordedPoster: NotificationPoster {
  private(set) var registered: [String] = []
  private(set) var posted: [PostedNotification] = []

  func register(_ categories: [UNNotificationCategory]) { registered = categories.map(\.identifier) }
  func post(_ note: PostedNotification) { posted.append(note) }
}

/// The notification center, for a bundled app outside the UI-test flag
/// only. The delegate builds it; nothing else does.
@MainActor
final class SystemPoster: NSObject, NotificationPoster, UNUserNotificationCenterDelegate {
  private let center: UNUserNotificationCenter

  init(center: UNUserNotificationCenter) {
    self.center = center
    super.init()
    center.delegate = self
  }

  func register(_ categories: [UNNotificationCategory]) { center.setNotificationCategories(Set(categories)) }

  func post(_ note: PostedNotification) {
    let content = UNMutableNotificationContent()
    content.title = note.title
    content.body = note.body
    content.categoryIdentifier = note.category
    content.threadIdentifier = note.thread
    content.userInfo = ["thread": note.thread, "channel": note.channel]
    content.interruptionLevel = .active
    let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
    center.add(request)
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
  ) async {
    let info = response.notification.request.content.userInfo
    let actionId = response.actionIdentifier
    let thread = info["thread"] as? String ?? ""
    let channel = info["channel"] as? String ?? ""
    await MainActor.run { Notifications.route(actionId, thread: thread, channel: channel) }
  }
}
