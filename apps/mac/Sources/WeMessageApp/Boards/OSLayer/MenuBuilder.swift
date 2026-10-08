import AppKit
import Foundation
import WeMessageKit

/// v2 S4l, board 16.G: turns the kit's menu table into NSMenu items and
/// nothing else. Every item's identifier is its 16.G id; a standard command
/// keeps its responder selector; every other command routes through the hub
/// by id and is enabled only while the window has registered it (D-UI-113).
/// The hub never names the application: the delegate installs the result.
@MainActor
enum MenuBuilder {
  /// The menu's one target for routed commands.
  static let router = MenuRouter()

  static func build(_ items: [MenuItemSpec], title: String = "Main Menu") -> NSMenu {
    let menu = NSMenu(title: title)
    for spec in items {
      if let item = item(spec) { menu.addItem(item) }
    }
    return menu
  }

  /// One item, or nil for a row macOS inserts on its own (D-UI-119).
  static func item(_ spec: MenuItemSpec) -> NSMenuItem? {
    switch spec.kind {
    case .separator:
      return .separator()
    case .system:
      return nil
    case .note:
      let item = NSMenuItem(title: spec.title, action: nil, keyEquivalent: "")
      item.identifier = NSUserInterfaceItemIdentifier(spec.id)
      item.isEnabled = false
      return item
    case .submenu(let children):
      let item = NSMenuItem(title: spec.title, action: nil, keyEquivalent: "")
      item.identifier = NSUserInterfaceItemIdentifier(spec.id)
      item.submenu = build(children, title: spec.title)
      decorate(item, hint: spec.hint)
      return item
    case .command(let action):
      let item = NSMenuItem(title: spec.title, action: nil, keyEquivalent: spec.key)
      configure(item, spec: spec, action: action)
      return item
    case .toggle(let action, let on):
      let item = NSMenuItem(title: spec.title, action: nil, keyEquivalent: spec.key)
      configure(item, spec: spec, action: action)
      item.state = on ? .on : .off
      return item
    }
  }

  private static func configure(_ item: NSMenuItem, spec: MenuItemSpec, action: String?) {
    item.identifier = NSUserInterfaceItemIdentifier(spec.id)
    item.keyEquivalentModifierMask = mask(spec.modifiers)
    if let action {
      item.action = NSSelectorFromString(action)
    } else {
      item.action = #selector(MenuRouter.route(_:))
      item.target = router
    }
    decorate(item, hint: spec.hint)
  }

  /// D-UI-115: a hint is drawn after a tab, dim, and is never a binding.
  private static func decorate(_ item: NSMenuItem, hint: String?) {
    guard let hint else { return }
    switch ProvisionalUI.menuHintStyle {
    case .dimTrailingHint:
      let text = NSMutableAttributedString(
        string: item.title, attributes: [.font: NSFont.menuFont(ofSize: 0)])
      text.append(
        NSAttributedString(
          string: "\t" + hint,
          attributes: [.font: NSFont.menuFont(ofSize: 0), .foregroundColor: NSColor.secondaryLabelColor]))
      let style = NSMutableParagraphStyle()
      style.tabStops = [NSTextTab(textAlignment: .right, location: 220)]
      text.addAttribute(.paragraphStyle, value: style, range: NSRange(location: 0, length: text.length))
      item.attributedTitle = text
      item.toolTip = "Key: " + hint
    }
  }

  static func mask(_ modifiers: [Keymap.Modifier]) -> NSEvent.ModifierFlags {
    var flags: NSEvent.ModifierFlags = []
    for modifier in modifiers {
      switch modifier {
      case .control: flags.insert(.control)
      case .option: flags.insert(.option)
      case .shift: flags.insert(.shift)
      case .command: flags.insert(.command)
      case .function: flags.insert(.function)
      }
    }
    return flags
  }

  /// The menu as lines a test can read without a screenshot:
  /// "<path> | <id> | <title> | <chord> | <state>", depth first.
  static func dump(_ menu: NSMenu?, path: String = "") -> [String] {
    guard let menu else { return [] }
    var out: [String] = []
    for item in menu.items where !item.isSeparatorItem {
      let id = item.identifier?.rawValue ?? ""
      // The title without its D-UI-115 hint, which follows a tab.
      let title = item.title.components(separatedBy: "\t").first ?? item.title
      let here = path.isEmpty ? title : path + " > " + title
      let state = item.state == .on ? "on" : (item.action == nil && item.submenu == nil ? "text" : "")
      out.append([here, id, title, chord(item), state].joined(separator: " | "))
      out += dump(item.submenu, path: here)
    }
    return out
  }

  /// The binding as macOS prints it, read back from the item itself.
  static func chord(_ item: NSMenuItem) -> String {
    guard !item.keyEquivalent.isEmpty else { return "" }
    let flags = item.keyEquivalentModifierMask
    var mods: [Keymap.Modifier] = []
    if flags.contains(.control) { mods.append(.control) }
    if flags.contains(.option) { mods.append(.option) }
    if flags.contains(.shift) { mods.append(.shift) }
    if flags.contains(.command) { mods.append(.command) }
    return Keymap.Chord(key: item.keyEquivalent, modifiers: mods).printed
  }

  /// The Dock menu (16.E): the header lines disabled, the per-channel rows
  /// and the four commands routed by id. Kill Switch carries no chord.
  static func dock(_ lines: [DockMenu.Line]) -> NSMenu {
    let menu = NSMenu(title: "Dock")
    var commands = false
    for line in lines {
      if line.id == "dock:open" && !commands {
        menu.addItem(.separator())
        commands = true
      }
      let item = NSMenuItem(title: line.title, action: nil, keyEquivalent: "")
      item.identifier = NSUserInterfaceItemIdentifier(line.id)
      if line.enabled {
        item.action = #selector(MenuRouter.route(_:))
        item.target = router
      } else {
        item.isEnabled = false
      }
      if !line.chord.isEmpty { item.toolTip = line.chord }
      menu.addItem(item)
    }
    return menu
  }

  /// The command a menu or Dock id runs: a Dock line runs the main menu's
  /// command of the same meaning, a channel line picks that scope.
  static func command(for id: String) -> String {
    switch id {
    case "dock:triage": return "view:lens-triage"
    case "dock:new": return "file:new"
    case "dock:kill": return "agent:kill"
    default:
      if id.hasPrefix("dock:channel-") { return "view:scope-" + id.dropFirst("dock:channel-".count) }
      return id
    }
  }
}

/// The menu's target for every command without a standard selector.
@MainActor
final class MenuRouter: NSObject, NSMenuItemValidation {
  @objc func route(_ sender: NSMenuItem) {
    guard let id = sender.identifier?.rawValue else { return }
    OSLayerHub.shared.perform(MenuBuilder.command(for: id))
  }

  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    guard let id = item.identifier?.rawValue else { return false }
    return OSLayerHub.shared.canPerform(MenuBuilder.command(for: id))
  }
}
