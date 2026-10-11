import Foundation
import Observation
import WeMessageKit

// v2 S4j, board 13: the settings window's state. Seven panes in the plan's
// order (D-UI-88). The window reads the daemon's settings once and writes
// nothing: no patch, no disconnect, no toggle. The one control path it
// reaches is the kill switch's release, through ShellModel's own
// disengage path, behind a confirm (13.H). Auto-send and schedules
// are drawn as parked rows that hold no control at all (13.C, H-S4-9).

/// The panes, in the order the sidebar lists them.
enum SettingsPane: String, CaseIterable, Sendable {
  case accounts, drafting, notifications, appearance, keyboard, storage, confirm

  var title: String {
    switch self {
    case .accounts: "Accounts"
    case .drafting: "Drafting"
    case .notifications: "Notifications"
    case .appearance: "Appearance"
    case .keyboard: "Keyboard"
    case .storage: "Storage"
    case .confirm: "Confirmations"
    }
  }
}

/// One accessibility setting the app mirrors from macOS. Never a control
/// here: the switch lives in System Settings (13.E).
struct MirroredOption: Equatable, Sendable {
  let id: String
  let title: String
  let on: Bool
  let effect: String
  /// Always false; the row says where the switch is instead.
  let editable: Bool
}

/// A feature the daemon refuses in this version (409), drawn as its empty
/// slot with the reason in words. There is no switch to flip, so a future
/// build, a config file or a tired human cannot arm it from here.
struct ParkedFeature: Equatable, Sendable {
  let id: String
  let title: String
  let copy: String
  /// Always false (H-S4-9).
  let armable: Bool
}

/// A read-only number from the daemon's settings, printed with its range.
struct SettingLine: Equatable, Sendable {
  let key: String
  let title: String
  let value: String
}

@MainActor
@Observable
final class SettingsModel {
  /// What a confirm card is asking about.
  enum Confirm: String, Sendable {
    /// Delete the local copy (13.G). Not in this version: the card names
    /// what would go and its go control is disabled (D-UI-92).
    case deleteCopy
    /// Turn sending back on (13.H: disengaging confirms, engaging never).
    case releaseKill
  }

  let shell: ShellModel
  @ObservationIgnored private let client: GatewayClient

  var pane: SettingsPane = .accounts
  private(set) var envelope: SettingsEnvelope?
  private(set) var loaded = false
  var confirm: Confirm?

  init(client: GatewayClient, shell: ShellModel) {
    self.client = client
    self.shell = shell
  }

  /// One read of the daemon's settings. The only client call this model
  /// makes (H-S4-9).
  func load() async {
    envelope = try? await client.settings()
    loaded = true
  }

  // MARK: panes

  /// The keymap the daemon holds, or the default (keymap.bindings is not
  /// served yet: D-UI-90).
  var keymap: Keymap { Keymap.from(envelope?.settings ?? [:]) }

  /// The sidebar's second line per pane: the state a user needs before
  /// picking one (13.A).
  func stateLine(_ pane: SettingsPane) -> String {
    switch pane {
    case .accounts: "iMessage on this Mac"
    case .drafting: draftOnly ? "draft only" : "mode not reported"
    case .notifications: "none in this version"
    case .appearance: "follows system"
    case .keyboard: "\(Keymap.editableVerbs.count) verbs, \(keymap.reboundCount) rebound"
    case .storage: storage.map(\.size) ?? Self.storageUnreported
    case .confirm: killLine
    }
  }

  /// send.globalMode reads draft-only (it is read-only on the wire).
  var draftOnly: Bool {
    guard case .string(let mode)? = envelope?.settings["send.globalMode"]?.value else { return false }
    return mode == "draft-only"
  }

  /// The pacing caps and the undo window, read-only, as the daemon serves
  /// them (D-UI-91).
  var limits: [SettingLine] {
    let rows: [(String, String, String)] = [
      ("send.undoGraceSeconds", "Undo window after approve", "s"),
      ("send.capContactPer2Min", "Sends to one person, per 2 minutes", ""),
      ("send.capContactPerHour", "Sends to one person, per hour", ""),
      ("send.capGlobalPerHour", "Sends to everyone, per hour", ""),
    ]
    return rows.map { key, title, unit in
      SettingLine(key: key, title: title, value: Self.printed(envelope?.settings[key], unit: unit))
    }
  }

  static func printed(_ entry: SettingEntry?, unit: String) -> String {
    guard let entry else { return "not reported by this daemon" }
    let value: String
    switch entry.value {
    case .number(let n): value = Self.number(n) + unit
    case .bool(let b): value = b ? "on" : "off"
    case .string(let s): value = s
    default: value = "not set"
    }
    guard let floor = entry.floor, let ceiling = entry.ceiling else { return value }
    return value + "  (" + Self.number(floor) + " to " + Self.number(ceiling) + ")"
  }

  static func number(_ n: Double) -> String {
    n.rounded() == n ? String(Int(n)) : String(n)
  }

  // MARK: parked and mirrored

  /// Auto-send and schedules: refused by the daemon in this version, drawn
  /// as absences (13.C). Neither has a control.
  static let parked: [ParkedFeature] = [
    ParkedFeature(
      id: "autosend", title: "Auto-send",
      copy:
        "Parked. There is no switch for it in this version. Every message, yours or an agent's, waits for your approve, and the daemon refuses a send that skips one.",
      armable: false),
    ParkedFeature(
      id: "schedules", title: "Scheduled sends",
      copy: "Parked. The daemon refuses a schedule in this version, so nothing in this window can arm one.",
      armable: false),
  ]

  /// D-UI-13 (b): the sentence the Appearance pane prints under the three
  /// mirrored rows.
  static let frostSentence = ProvisionalUI.appearanceSentence

  /// Reduce Transparency, Increase Contrast and Reduce Motion as macOS has
  /// them now, read-only, each with what it changes here.
  static func mirrored(_ flags: AccessibilityMirror.Flags) -> [MirroredOption] {
    [
      MirroredOption(
        id: "reducetransparency", title: "Reduce Transparency", on: flags.reduceTransparency,
        effect: "The frost behind the panes becomes the opaque layer.", editable: false),
      MirroredOption(
        id: "increasecontrast", title: "Increase Contrast", on: flags.increaseContrast,
        effect: "Rules and outlines draw at full ink.", editable: false),
      MirroredOption(
        id: "reducemotion", title: "Reduce Motion", on: flags.reduceMotion,
        effect: "Rows and sheets appear without sliding.", editable: false),
    ]
  }

  /// The mirrored rows' shared footnote: where the switch actually is.
  static let mirroredWhere = "Set in System Settings, Accessibility, Display. Mirrored here, never changed here."

  // MARK: storage

  /// G-13a: what the pane says when the daemon serves no size for the
  /// local copy (a daemon older than v2 F7, or no status read yet).
  static let storageUnreported = "not reported by this daemon"

  /// v2 F7e (D-UI-214): the local copy as the daemon counted it.
  struct Storage: Equatable, Sendable {
    /// "178 MB · ~/Library/…/wemessage.db"
    let line: String
    /// "527,147 messages in 3,953 chats since 2014-03-02, counted 12:00."
    let detail: String
    /// "178 MB": the sidebar's state line and the row's trailing word.
    let size: String
  }

  /// The pane's words from the status's `mirror`; nil when it carries none.
  /// Megabytes are decimal (10^6 bytes), rounded to the nearest whole one.
  static func storage(mirror: MirrorStatusPayload?, zone: TimeZone = .current) -> Storage? {
    guard let mirror else { return nil }
    let megabytes = Int((Double(mirror.bytes) / 1_000_000).rounded())
    let since = mirror.historyFrom.flatMap { WireDate.parse($0) }.map { ShellText.format($0, "yyyy-MM-dd", zone) }
    let counted = WireDate.parse(mirror.countedAt).map { ShellText.shortClock($0, zone: zone) } ?? mirror.countedAt
    return Storage(
      line: ProvisionalUI.storageLine(megabytes: megabytes, path: mirror.path),
      detail: ProvisionalUI.storageDetail(
        messages: SearchText.grouped(mirror.messages), chats: SearchText.grouped(mirror.chats), since: since,
        counted: counted),
      size: ProvisionalUI.storageSize(megabytes: megabytes))
  }

  /// The local copy, from the shell's last status read.
  var storage: Storage? { Self.storage(mirror: shell.status?.mirror) }

  /// The confirm card's three lines for deleting the local copy (09.C's
  /// removed, revoked, untouched), and why its go control is disabled.
  static let deleteCopyLines = [
    "Removes: the copy of your messages WeMessage keeps on this Mac.",
    "Revokes: nothing. Your Messages account and Full Disk Access stay as they are.",
    "Untouched: Messages itself, your phone, and the audit log.",
  ]
  static let deleteCopyNotHere =
    "Not in this version. From Terminal, wemessage disconnect --purge does this, and asks again."

  // MARK: kill switch

  /// "on", "off" or "unknown", as the status read last said.
  var killState: String {
    switch shell.killSwitch {
    case true?: "on"
    case false?: "off"
    case nil: "unknown"
    }
  }

  var killLine: String {
    switch shell.killSwitch {
    case true?: "kill switch on"
    case false?: "sending on"
    case nil: "kill switch unknown"
    }
  }

  /// The pane's sentence for the state.
  var killSentence: String {
    switch shell.killSwitch {
    case true?: "Sending is off. Nothing leaves this Mac until you release it."
    case false?: "Sending is on. \(Keymap.killChord.printed) turns it off from anywhere, with no confirm."
    case nil: "The daemon has not said. Nothing here assumes either way."
    }
  }

  static let releaseLines = [
    "Turns sending back on.",
    "Held drafts return to awaiting your approve; nothing is sent by releasing.",
    "Nothing refused while it was on is resent.",
  ]

  // MARK: confirm

  func ask(_ what: Confirm) { confirm = what }

  func cancel() { confirm = nil }

  /// The confirm card's go. Releasing the kill switch is the existing
  /// control path; deleting the copy is not in this version, so its go is
  /// disabled in the view and does nothing here either.
  func go() async {
    guard let what = confirm else { return }
    confirm = nil
    switch what {
    case .releaseKill: await shell.disengageKillSwitch()
    case .deleteCopy: break
    }
  }

  /// Whether the card's go control can be pressed.
  func canGo(_ what: Confirm) -> Bool { what == .releaseKill && shell.killSwitch == true }
}
