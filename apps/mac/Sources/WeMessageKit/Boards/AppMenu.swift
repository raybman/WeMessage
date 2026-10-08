import Foundation

// v2 S4l, board 16.G: the main menu as data. Every item carries a stable
// id from the 16.G table, so a test can read the whole bar without a
// screenshot, and the app's builder turns this tree into NSMenu items and
// nothing else. Two rules the tree enforces by construction:
//   1. no key equivalent without a command or control modifier. The triage
//      letters (E, H, M, R, Return) are hints drawn beside a title, never
//      bindings, because a bare-letter equivalent eats keystrokes meant for
//      the composer;
//   2. the kill switch has no chord in the menu. It is one press away on its
//      chip, and a menu chord is one slip away from an engage.

public struct MenuItemSpec: Equatable, Sendable {
  public enum Kind: Equatable, Sendable {
    /// A command. `action` names a standard responder selector (cut:,
    /// undo:, orderFrontStandardAboutPanel:), or nil when the app routes
    /// it by id.
    case command(action: String?)
    /// A checkable toggle, with its initial state.
    case toggle(action: String?, on: Bool)
    /// A disabled line of text: a posture readout or a refusal.
    case note
    case submenu([MenuItemSpec])
    case separator
    /// An item macOS inserts on its own (Start Dictation, Emoji & Symbols).
    /// The builder does not add it; it is listed so the table is complete.
    case system
  }

  public var id: String
  public var title: String
  /// The key equivalent, lower case, or "" for none.
  public var key: String
  public var modifiers: [Keymap.Modifier]
  /// A key printed beside the title that is not a binding (E, H, M, R,
  /// Return, or a chord another item owns).
  public var hint: String?
  public var kind: Kind

  public init(
    _ id: String, _ title: String, key: String = "", _ modifiers: [Keymap.Modifier] = [], hint: String? = nil,
    kind: Kind = .command(action: nil)
  ) {
    self.id = id
    self.title = title
    self.key = key
    self.modifiers = modifiers.sorted()
    self.hint = hint
    self.kind = kind
  }

  static func cmd(_ id: String, _ title: String, _ key: String = "", _ mods: [Keymap.Modifier] = [], action: String? = nil, hint: String? = nil) -> MenuItemSpec {
    MenuItemSpec(id, title, key: key, mods, hint: hint, kind: .command(action: action))
  }

  static func sub(_ id: String, _ title: String, hint: String? = nil, _ children: [MenuItemSpec]) -> MenuItemSpec {
    MenuItemSpec(id, title, hint: hint, kind: .submenu(children))
  }

  static func note(_ id: String, _ title: String) -> MenuItemSpec { MenuItemSpec(id, title, kind: .note) }

  static var separator: MenuItemSpec { MenuItemSpec("", "", kind: .separator) }

  public var children: [MenuItemSpec] {
    if case .submenu(let items) = kind { return items }
    return []
  }

  public var isSeparator: Bool { kind == .separator }

  /// The binding as macOS prints it ("\u{21E7}\u{2318}Z"), or "" for none.
  public var chord: String {
    key.isEmpty ? "" : Keymap.Chord(key: key, modifiers: modifiers).printed
  }
}

/// What the menu reads from the window: the scope (Hold Until is an
/// iMessage and Email feature) and the agent's posture line.
public struct MenuContext: Equatable, Sendable {
  /// The scope's raw value: all, imessage, whatsapp, linkedin, email.
  public var scope: String
  /// "Drafting on \u{00B7} 3 drafts ready \u{00B7} synced 16:42:07".
  public var posture: String

  public init(scope: String = "all", posture: String = "Drafting on") {
    self.scope = scope
    self.posture = posture
  }

  /// Hold Until schedules a send on a channel whose sender holds it: the
  /// daemon's iMessage and Email paths only.
  public var holdUntilAvailable: Bool { scope == "imessage" || scope == "email" }
}

public enum AppMenu {
  /// The eight titles, in order. View carries no Message Atlas; there is no
  /// Go, Format or Debug menu.
  public static let titles = ["WeMessage", "File", "Edit", "View", "Thread", "Agent", "Window", "Help"]

  /// Rows the 16.G table refuses by name: browser chrome, document verbs a
  /// queue has no use for, and the two acts that never live in a menu
  /// (Approve and Release Kill Switch).
  public static let refusedTitles = [
    "Reload", "Force Reload", "Toggle Developer Tools", "Zoom In", "Zoom Out", "Actual Size", "Open Recent", "Save",
    "Print", "Export", "Approve", "Send", "Archive", "Star", "Mark Unread", "Delete Thread", "Release Kill Switch",
  ]

  public static let scopes: [(id: String, title: String)] = [
    ("all", "All"), ("imessage", "iMessage"), ("whatsapp", "WhatsApp"), ("linkedin", "LinkedIn"), ("email", "Email"),
  ]

  public static func top(_ context: MenuContext = MenuContext()) -> [MenuItemSpec] {
    [
      .sub("menu:app", "WeMessage", [
        .cmd("app:about", "About WeMessage", action: "orderFrontStandardAboutPanel:"),
        .separator,
        .cmd("app:settings", "Settings\u{2026}", ",", [.command]),
        .separator,
        MenuItemSpec("app:services", "Services", kind: .submenu([])),
        .separator,
        .cmd("app:hide", "Hide WeMessage", "h", [.command], action: "hide:"),
        .cmd("app:hide-others", "Hide Others", "h", [.option, .command], action: "hideOtherApplications:"),
        .cmd("app:unhide", "Show All", action: "unhideAllApplications:"),
        .separator,
        .cmd("app:quit", "Quit WeMessage", "q", [.command], action: "terminate:"),
      ]),
      .sub("menu:file", "File", [
        .cmd("file:new", "New Message", "n", [.command]),
        .separator,
        .cmd("file:close", "Close Window", "w", [.command], action: "performClose:"),
      ]),
      .sub("menu:edit", "Edit", edit()),
      .sub("menu:view", "View", view()),
      .sub("menu:thread", "Thread", thread(context)),
      .sub("menu:agent", "Agent", agent(context)),
      .sub("menu:window", "Window", [
        .cmd("win:minimize", "Minimize", "m", [.command], action: "performMiniaturize:"),
        .cmd("win:zoom", "Zoom", action: "performZoom:"),
        .separator,
        .cmd("win:show", "WeMessage"),
        .separator,
        .cmd("win:front", "Bring All to Front", action: "arrangeInFront:"),
      ]),
      .sub("menu:help", "Help", [
        .cmd("help:help", "WeMessage Help"),
        .cmd("help:shortcuts", "Keyboard Shortcuts"),
        .cmd("help:limits", "What the Agent Can and Cannot Do"),
        .separator,
        .cmd("help:setup", "Open the Setup Checks"),
      ]),
    ]
  }

  static func edit() -> [MenuItemSpec] {
    [
      .cmd("edit:undo", "Undo", "z", [.command], action: "undo:"),
      .cmd("edit:redo", "Redo", "z", [.shift, .command], action: "redo:"),
      .separator,
      .cmd("edit:cut", "Cut", "x", [.command], action: "cut:"),
      .cmd("edit:copy", "Copy", "c", [.command], action: "copy:"),
      .cmd("edit:paste", "Paste", "v", [.command], action: "paste:"),
      .cmd("edit:paste-plain", "Paste and Match Style", "v", [.option, .shift, .command], action: "pasteAsPlainText:"),
      .cmd("edit:delete", "Delete", action: "delete:"),
      .cmd("edit:select-all", "Select All", "a", [.command], action: "selectAll:"),
      .separator,
      .sub("edit:find-menu", "Find", [
        .cmd("edit:find", "Find\u{2026}", "f", [.command]),
        .cmd("edit:find-next", "Find Next", "g", [.command]),
        .cmd("edit:find-prev", "Find Previous", "g", [.shift, .command]),
        .cmd("edit:find-all", "Find in All Threads", "f", [.shift, .command]),
      ]),
      .sub("edit:spelling", "Spelling and Grammar", [
        .cmd("edit:spell-panel", "Show Spelling and Grammar", ":", [.command], action: "showGuessPanel:"),
        .cmd("edit:spell-now", "Check Document Now", ";", [.command], action: "checkSpelling:"),
        .separator,
        MenuItemSpec(
          "edit:autocorrect", "Correct Spelling Automatically",
          kind: .toggle(action: "toggleAutomaticSpellingCorrection:", on: false)),
      ]),
      .sub("edit:substitutions", "Substitutions", [
        MenuItemSpec(
          "edit:smart-dashes", "Smart Dashes", kind: .toggle(action: "toggleAutomaticDashSubstitution:", on: false)),
      ]),
      .sub("edit:speech", "Speech", [
        .cmd("edit:speak", "Start Speaking", action: "startSpeaking:"),
        .cmd("edit:stop-speak", "Stop Speaking", action: "stopSpeaking:"),
      ]),
      .separator,
      MenuItemSpec("edit:dictation", "Start Dictation\u{2026}", kind: .system),
      MenuItemSpec("edit:emoji", "Emoji & Symbols", key: " ", [.control, .command], kind: .system),
    ]
  }

  static func view() -> [MenuItemSpec] {
    var items: [MenuItemSpec] = [
      .cmd("view:lens-recent", "Recent", "r", [.shift, .command]),
      .cmd("view:lens-needs", "Needs You", "n", [.shift, .command]),
      .cmd("view:lens-triage", "Triage", "t", [.command]),
      .separator,
    ]
    for (index, scope) in scopes.enumerated() {
      items.append(.cmd("view:scope-\(scope.id)", scope.title, "\(index + 1)", [.command]))
    }
    items += [
      .separator,
      .cmd("view:inspector", "Show Inspector"),
      .separator,
      .cmd("view:fullscreen", "Enter Full Screen", "f", [.control, .command], action: "toggleFullScreen:"),
    ]
    return items
  }

  static func thread(_ context: MenuContext) -> [MenuItemSpec] {
    var items: [MenuItemSpec] = [
      .cmd("thread:open", "Open", hint: "\u{21A9}"),
      .cmd("thread:next", "Next Thread", "]", [.shift, .command]),
      .cmd("thread:prev", "Previous Thread", "[", [.shift, .command]),
      .cmd("thread:switcher", "Go to Thread\u{2026}", "k", [.command]),
      .separator,
      .cmd("thread:reply", "Reply", hint: "R"),
      .cmd("thread:done", "Done", hint: "E"),
      .sub("thread:snooze", "Snooze", hint: "H", [
        .cmd("thread:snooze:later-today", "Later Today"),
        .cmd("thread:snooze:tonight", "Tonight"),
        .cmd("thread:snooze:tomorrow", "Tomorrow 9:00"),
        .cmd("thread:snooze:weekend", "This Weekend"),
        .cmd("thread:snooze:next-week", "Next Week"),
        .separator,
        .cmd("thread:snooze:pick", "Pick a Time\u{2026}"),
      ]),
      .sub("thread:mute", "Mute", hint: "M", [
        .cmd("thread:mute:demote", "Demote to Stream"),
        .cmd("thread:mute:thread", "Mute This Thread"),
        .cmd("thread:mute:sender", "Mute Sender Everywhere"),
      ]),
      // Edit's Undo owns cmd-Z; this row prints it so the pairing is visible.
      .cmd("thread:undo", "Undo Last Triage Act", hint: "\u{2318}Z"),
      .separator,
      .sub("thread:mode", "Mode", [
        .cmd("thread:mode:queue", "Queue"),
        .cmd("thread:mode:stream", "Stream"),
        .cmd("thread:mode:muted", "Muted"),
      ]),
    ]
    if context.holdUntilAvailable {
      items.append(
        .sub("thread:hold-until", "Hold Until", [
          .cmd("thread:hold-until:1h", "In 1 Hour"),
          .cmd("thread:hold-until:tonight", "Tonight 8:00 PM"),
          .cmd("thread:hold-until:tomorrow", "Tomorrow 8:00 AM"),
          .cmd("thread:hold-until:monday", "Monday 9:00 AM"),
          .separator,
          .cmd("thread:hold-until:custom", "Custom\u{2026}"),
        ]))
    }
    items += [
      .separator,
      .cmd("thread:mark-read", "Mark as Read", "a", [.shift, .command]),
      .cmd("thread:copy-link", "Copy Link to Thread"),
      .separator,
      .note("thread:approve-note", "Approving a draft happens in the thread, with \u{2318}\u{21A9}, not from this menu."),
    ]
    return items
  }

  static func agent(_ context: MenuContext) -> [MenuItemSpec] {
    [
      .note("agent:posture", context.posture),
      .separator,
      .cmd("agent:draft-here", "Draft a Reply Here"),
      .cmd("agent:why", "Why Is This Here?"),
      .separator,
      .sub("agent:pause", "Pause Drafting", [
        .cmd("agent:pause:hour", "For an Hour"),
        .cmd("agent:pause:tomorrow", "Until Tomorrow Morning"),
        .cmd("agent:pause:today", "For the Rest of Today"),
        .separator,
        .cmd("agent:pause:resume", "Resume Now"),
      ]),
      .separator,
      .cmd("agent:kill", "Kill Switch\u{2026}"),
      .cmd("agent:log", "Show Agent Log"),
    ]
  }

  /// Every item in the tree, depth first, separators excluded.
  public static func flatten(_ items: [MenuItemSpec]) -> [MenuItemSpec] {
    items.flatMap { item -> [MenuItemSpec] in
      item.isSeparator ? [] : [item] + flatten(item.children)
    }
  }

  /// Items whose key equivalent carries neither command nor control: a
  /// bare letter (or a bare shift-letter) that would fire while typing.
  public static func bareKeys(_ items: [MenuItemSpec]) -> [MenuItemSpec] {
    flatten(items).filter { !$0.key.isEmpty && !$0.modifiers.contains(.command) && !$0.modifiers.contains(.control) }
  }

  /// Two items bound to the same chord: the second never fires.
  public static func collisions(_ items: [MenuItemSpec]) -> [String] {
    var seen: [String: String] = [:]
    var out: [String] = []
    for item in flatten(items) where !item.key.isEmpty {
      if let first = seen[item.chord] { out.append("\(first) and \(item.id) share \(item.chord)") } else { seen[item.chord] = item.id }
    }
    return out
  }

  /// The ids the menu routes to the window (no standard selector, no
  /// submenu, not a note or a system row).
  public static func routedIds(_ items: [MenuItemSpec]) -> [String] {
    flatten(items).compactMap { item in
      if case .command(action: nil) = item.kind { return item.id }
      return nil
    }
  }
}

// MARK: The Dock menu (16.E)

public enum DockMenu {
  public struct Line: Equatable, Sendable {
    public var id: String
    public var title: String
    /// The chord printed beside it, or "" for none.
    public var chord: String
    public var enabled: Bool
  }

  /// One count per channel. An empty channel reads "Email clear", not
  /// "Email 0"; a degraded snapshot prints no counts at all.
  public static func lines(
    snapshot: OSSnapshot, drafts: Int, asOf: String, sourcesLine: String, perChannel: [(title: String, count: Int)]
  ) -> [Line] {
    var out: [Line] = []
    switch OSLayer.state(snapshot) {
    case .killed:
      out.append(Line(id: "dock:header", title: "Kill switch on. Nothing can send.", chord: "", enabled: false))
    case .degraded, .disconnected:
      out.append(Line(id: "dock:header", title: "Cannot say \u{00B7} as of \(asOf)", chord: "", enabled: false))
    case .idle, .waiting:
      let total = snapshot.count ?? 0
      out.append(
        Line(
          id: "dock:header",
          title: "\(total) left \u{00B7} \(drafts) \(drafts == 1 ? "draft" : "drafts") ready \u{00B7} as of \(asOf)",
          chord: "", enabled: false))
      out.append(Line(id: "dock:sources", title: sourcesLine, chord: "", enabled: false))
      for channel in perChannel {
        out.append(
          Line(
            id: "dock:channel-\(channel.title.lowercased())",
            title: channel.count == 0 ? "\(channel.title) clear" : "\(channel.title) \(channel.count)", chord: "",
            enabled: channel.count > 0))
      }
    }
    out += [
      Line(id: "dock:open", title: "Open WeMessage", chord: "", enabled: true),
      Line(id: "dock:triage", title: "Triage", chord: "\u{2318}T", enabled: true),
      Line(id: "dock:new", title: "New Message", chord: "\u{2318}N", enabled: true),
      Line(id: "dock:kill", title: "Kill Switch\u{2026}", chord: "", enabled: true),
    ]
    return out
  }
}

// MARK: Notifications (16.D)

/// The closed union of notification actions. Five ids, no more: an action
/// that is not a case cannot be offered from a banner.
public enum NotificationAction: String, CaseIterable, Sendable {
  case open = "open"
  case draft = "draft"
  case snooze = "snooze:1h"
  case mute = "mute:thread"
  case done = "done"

  public var title: String {
    switch self {
    case .open: "Open"
    case .draft: "Draft a reply"
    case .snooze: "Snooze 1h"
    case .mute: "Mute thread"
    case .done: "Done"
    }
  }

  /// Open brings the app forward; the rest act from the banner.
  public var foreground: Bool { self == .open || self == .draft }
}

/// What may post a banner. An agent draft is not a case: drafts wait in the
/// queue and the extra's count, and never interrupt.
public enum NotificationKind: String, CaseIterable, Sendable {
  case streamQuestion = "stream-question"
  case linkedinRequest = "linkedin-request"
  case email = "email"
  case groupStack = "group-stack"

  public var actions: [NotificationAction] {
    switch self {
    case .streamQuestion: [.open, .draft, .snooze]
    case .linkedinRequest: [.open, .done]
    case .email: [.open, .draft, .done, .snooze]
    case .groupStack: [.open, .mute]
    }
  }
}

public enum NotificationRules {
  /// Banners carry no text field. A reply typed into a banner skips the
  /// thread, the draft state and the kill switch's preflight.
  public static let inlineReply = false
  /// Never Time Sensitive, never critical: nothing here outranks Focus.
  public static let interruption = "active"
  /// Titles a banner must never offer.
  public static let refusedActionTitles = ["Reply", "Approve", "Send"]

  /// Post or not. An agent draft never posts (it is not a kind), and a
  /// muted thread never posts. Inbound still posts under the kill switch:
  /// reading continues.
  public static func shouldPost(_ kind: NotificationKind?, muted: Bool) -> Bool {
    guard let kind, !muted else { return false }
    return kind.actions.contains(.open)
  }
}
