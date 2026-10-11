import SwiftUI
import WeMessageKit

// v2 S4j, board 13: the seven panes. None of them holds a switch: what is
// the user's to change in this version is drawn with its value and where
// it changes; what the product refuses is drawn as an empty slot with its
// reason (13.C); the two actions that can lose something open a confirm
// card first (13.H).

/// 13.B: the channels and how fresh each is. The age table is board 10's,
/// reused as drawn.
struct AccountsPane: View {
  let model: SettingsModel
  let palette: Tokens.Palette

  var body: some View {
    SettingsHeading(text: "Accounts", palette: palette)
    SettingsLine(
      title: "iMessage", detail: "This Mac's Messages account, read from the local file. Sends go out as you, after your approve.",
      trailing: "live", palette: palette)
    SettingsLine(
      title: "WhatsApp, LinkedIn, Email",
      detail: "Not connected in this version. Each arrives as its own adapter; none is a setting here.",
      trailing: "not connected", palette: palette)
    FreshnessTable(rows: model.shell.freshnessRows, palette: palette)
      .frame(maxWidth: 460, alignment: .topLeading)
  }
}

/// 13.C: drafting is opt-in, the pace is the daemon's, and auto-send and
/// schedules are parked rows with no control in them.
struct DraftingPane: View {
  let model: SettingsModel
  let palette: Tokens.Palette

  var body: some View {
    SettingsHeading(text: "Drafting", palette: palette)
    SettingsLine(
      title: "Mode",
      detail: model.draftOnly
        ? "Draft only. Agents write drafts; nothing leaves this Mac until you approve it."
        : "The daemon did not report its mode. Nothing here assumes one.",
      trailing: model.draftOnly ? "draft only" : "not reported", palette: palette)
    SettingsHeading(text: "Parked in this version", palette: palette)
    ForEach(SettingsModel.parked, id: \.id) { feature in
      SettingsLine(title: feature.title, detail: feature.copy, trailing: "parked", palette: palette)
        .accessibilityIdentifier(ShellID.settingsParkedPrefix + feature.id)
        .accessibilityValue("parked")
    }
    SettingsHeading(text: "Pace and undo, as the daemon holds them", palette: palette)
    ForEach(model.limits, id: \.key) { line in
      SettingsLine(title: line.title, detail: "Read-only here in this version.", trailing: line.value, palette: palette)
    }
    PacingTable(
      rows: Pacing.rows(sendsToday: nil), footer: Pacing.footer(asOf: model.shell.board.asOf), palette: palette
    )
    .frame(maxWidth: 460, alignment: .topLeading)
  }
}

/// 13.D: the rules, read-only. The queue window is the one number the badge
/// runs on (D-UI-18).
struct NotificationsPane: View {
  let palette: Tokens.Palette

  var body: some View {
    SettingsHeading(text: "Notifications", palette: palette)
    SettingsLine(
      title: "Banners", detail: "WeMessage posts no notifications in this version. The queue and the badge are where a draft waits.",
      trailing: "none", palette: palette)
    SettingsLine(
      title: "Queue window",
      detail: "An unanswered message older than this stops being a queue item and stops being counted, badge included.",
      trailing: "\(ProvisionalUI.queueWindowDays) days", palette: palette)
    SettingsLine(
      title: "Unread", detail: "Never a reason to interrupt you. Drafts and direct questions are.", trailing: "structural",
      palette: palette)
  }
}

/// 13.E: theme, text size and the three settings mirrored from macOS, with
/// the frost sentence (D-UI-13 (b)).
struct AppearancePane: View {
  let mirror: AccessibilityMirror
  let palette: Tokens.Palette

  var body: some View {
    SettingsHeading(text: "Appearance", palette: palette)
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        Text("Theme")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.ink))
        Text("Follows macOS. A theme of its own is not in this version.")
          .font(.system(size: 11))
          .foregroundStyle(Tokens.color(palette.inkDim))
      }
      Spacer(minLength: 8)
      HStack(spacing: 0) {
        ForEach(["System", "Light", "Dark"], id: \.self) { name in
          Text(name)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(Tokens.color(name == "System" ? palette.layer1 : palette.inkDim))
            .padding(.vertical, 3)
            .padding(.horizontal, 10)
            .background(name == "System" ? Tokens.color(palette.ink) : Color.clear)
        }
      }
      .clipShape(Capsule())
      .overlay(Capsule().strokeBorder(Tokens.color(palette.inkDim), lineWidth: 1))
    }
    .padding(.vertical, 6)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Theme, follows macOS")
    .accessibilityValue("system")
    .accessibilityIdentifier(ShellID.settingsTheme)
    SettingsLine(
      title: "Text size", detail: "Body text is 13 points and nothing drops below an 11 point floor. Not adjustable in this version.",
      trailing: "13 pt", palette: palette)
    SettingsHeading(text: "Mirrored from macOS", palette: palette)
    ForEach(SettingsModel.mirrored(mirror.flags), id: \.id) { option in
      SettingsLine(title: option.title, detail: option.effect, trailing: option.on ? "on" : "off", palette: palette)
        .accessibilityIdentifier(ShellID.settingsAppearancePrefix + option.id)
        .accessibilityValue(option.on ? "on" : "off")
    }
    Text(SettingsModel.mirroredWhere)
      .font(.system(size: 11))
      .foregroundStyle(Tokens.color(palette.inkDim))
    Text(SettingsModel.frostSentence)
      .font(.system(size: 12))
      .foregroundStyle(Tokens.color(palette.ink))
      .fixedSize(horizontal: false, vertical: true)
  }
}

/// 13.F: the five verbs, the movement pair and hold to talk are the
/// user's; the fixed rows say why they are fixed. Rebinding is a later
/// slice (D-UI-90): this pane is the table.
struct KeyboardPane: View {
  let keymap: Keymap
  let palette: Tokens.Palette

  struct Row: Identifiable {
    let id: String
    let action: String
    let key: String
    let editable: Bool
    let note: String
  }

  static func name(_ verb: Verb) -> String {
    switch verb {
    case .reply: "Reply"
    case .approve: "Approve"
    case .done: "Done"
    case .snooze: "Snooze"
    case .mute: "Mute"
    default: verb.rawValue
    }
  }

  var rows: [Row] {
    var rows = Keymap.editableVerbs.map { verb in
      let key = keymap.verbs[verb].map { String($0).uppercased() } ?? "none"
      let moved = keymap.verbs[verb] != Keymap.default.verbs[verb]
      return Row(id: verb.rawValue, action: Self.name(verb), key: key, editable: true, note: moved ? "rebound" : "default")
    }
    for pair in keymap.movement {
      rows.append(
        Row(
          id: "movement", action: "Next and previous thread",
          key: String(pair.next).uppercased() + " " + String(pair.previous).uppercased(), editable: true,
          note: "the arrows always work too"))
    }
    rows.append(
      Row(
        id: "hold", action: "Hold to talk", key: keymap.holdToTalk?.printed ?? "off", editable: true,
        note: "a chord, never a bare letter"))
    rows += Keymap.fixed().map { Row(id: $0.id, action: $0.action, key: $0.chord, editable: false, note: $0.reason) }
    return rows
  }

  var body: some View {
    SettingsHeading(
      text: "Keyboard \u{00B7} \(Keymap.editableVerbs.count) verbs \u{00B7} \(keymap.reboundCount) rebound from default",
      palette: palette)
    HStack(spacing: 12) {
      Text("ACTION").frame(width: 190, alignment: .leading)
      Text("KEY").frame(width: 70, alignment: .leading)
      Text("WHO SETS IT").frame(width: 80, alignment: .leading)
      Text("WHY")
    }
    .font(.system(size: 9, weight: .semibold))
    .foregroundStyle(Tokens.color(palette.inkDim))
    .accessibilityHidden(true)
    ForEach(rows) { row in
      HStack(alignment: .firstTextBaseline, spacing: 12) {
        Text(row.action)
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.ink))
          .frame(width: 190, alignment: .leading)
        Text(row.key)
          .font(.system(size: 12, weight: .semibold).monospaced())
          .foregroundStyle(Tokens.color(palette.ink))
          .frame(width: 70, alignment: .leading)
        Text(row.editable ? "you" : "fixed")
          .font(.system(size: 11))
          .foregroundStyle(Tokens.color(row.editable ? palette.ink : palette.inkDim))
          .frame(width: 80, alignment: .leading)
        Text(row.note)
          .font(.system(size: 11))
          .foregroundStyle(Tokens.color(palette.inkDim))
          .fixedSize(horizontal: false, vertical: true)
      }
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier(ShellID.settingsKeyboardRowPrefix + row.id)
      .accessibilityValue(row.editable ? "editable" : "fixed")
    }
    Text("Rebinding opens in a later version. S stays free for Star, and bare Return never sends.")
      .font(.system(size: 11))
      .foregroundStyle(Tokens.color(palette.inkDim))
  }
}

/// 13.G: where the second copy lives and how big it is, when the daemon
/// says. Deleting it opens a confirm card that names its blast radius.
struct StoragePane: View {
  let model: SettingsModel
  let palette: Tokens.Palette

  var body: some View {
    SettingsHeading(text: "Storage", palette: palette)
    VStack(alignment: .leading, spacing: 4) {
      if let storage = model.storage {
        // v2 F7e (D-UI-214): the daemon counted it.
        SettingsLine(
          title: "Local copy", detail: storage.line + "\n" + storage.detail, trailing: storage.size, palette: palette)
      } else {
        SettingsLine(
          title: "Local copy",
          detail: "WeMessage keeps a copy of what it reads on this Mac. Its size is \(SettingsModel.storageUnreported).",
          trailing: "size unknown", palette: palette)
      }
      SettingsLine(
        title: "Audit log", detail: "Append-only and hash-chained. There is no Clear; a log you can clear proves nothing.",
        trailing: "kept", palette: palette)
      HStack(spacing: 12) {
        SettingsButton(title: "Delete the local copy\u{2026}", danger: true, palette: palette, id: ShellID.settingsStorageDelete) {
          model.ask(.deleteCopy)
        }
        Text("Asks first, and says what goes.")
          .font(.system(size: 11))
          .foregroundStyle(Tokens.color(palette.inkDim))
      }
      .padding(.top, 6)
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier(ShellID.settingsStorage)
  }
}

/// 13.H: what asks and what does not, and the kill switch's state. Engaging
/// never asks; releasing does, through the banner's own path (D-UI-50).
struct ConfirmPane: View {
  let model: SettingsModel
  let palette: Tokens.Palette

  var body: some View {
    SettingsHeading(text: "Confirmations", palette: palette)
    SettingsLine(
      title: "Approve", detail: "One press, then an undo window before it leaves. No second dialog.", trailing: "undo",
      palette: palette)
    SettingsLine(
      title: "Delete the local copy", detail: "Asks, and names what is removed, revoked and untouched.", trailing: "asks",
      palette: palette)
    SettingsLine(
      title: "Engage the kill switch",
      detail: "Never asks. A safety control with a confirm is one dialog slower than the emergency.", trailing: "never asks",
      palette: palette)
    SettingsLine(
      title: "Release the kill switch", detail: "Asks. The direction that adds risk is the one that asks.",
      trailing: "asks", palette: palette)
    SettingsHeading(text: "Kill switch", palette: palette)
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      Text(model.killSentence)
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(Tokens.color(model.killState == "on" ? Tokens.danger : palette.ink))
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier(ShellID.settingsKillState)
        .accessibilityValue(model.killState)
      Spacer(minLength: 8)
      if model.killState == "on" {
        SettingsButton(title: "Release\u{2026}", palette: palette, id: ShellID.settingsKillRelease) {
          model.ask(.releaseKill)
        }
      }
    }
  }
}

/// 09.C's confirm, as a card over the window: what happens, then Cancel and
/// the one go control. Delete's go is disabled in this version.
struct ConfirmCard: View {
  let model: SettingsModel
  let what: SettingsModel.Confirm
  let palette: Tokens.Palette

  private var title: String {
    switch what {
    case .deleteCopy: "Delete the local copy?"
    case .releaseKill: "Turn sending back on?"
    }
  }

  private var lines: [String] {
    switch what {
    case .deleteCopy: SettingsModel.deleteCopyLines
    case .releaseKill: SettingsModel.releaseLines
    }
  }

  private var goTitle: String {
    switch what {
    case .deleteCopy: "Delete"
    case .releaseKill: "Release"
    }
  }

  var body: some View {
    ZStack {
      Tokens.color(palette.layer0, opacity: 0.6)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 10) {
        // The card's identity and what it asks rides on its title: a
        // containing group drops its value on macOS.
        Text(title)
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.ink))
          .accessibilityElement(children: .combine)
          .accessibilityAddTraits(.isHeader)
          .accessibilityIdentifier(ShellID.settingsConfirmSheet)
          .accessibilityValue(what.rawValue)
        ForEach(lines, id: \.self) { line in
          Text(line)
            .font(.system(size: 12))
            .foregroundStyle(Tokens.color(palette.ink))
            .fixedSize(horizontal: false, vertical: true)
        }
        if what == .deleteCopy {
          Text(SettingsModel.deleteCopyNotHere)
            .font(.system(size: 11))
            .foregroundStyle(Tokens.color(palette.inkDim))
            .fixedSize(horizontal: false, vertical: true)
        }
        HStack(spacing: 10) {
          Spacer(minLength: 0)
          SettingsButton(title: "Cancel", palette: palette, id: ShellID.settingsConfirmCancel) { model.cancel() }
          let can = model.canGo(what)
          SettingsButton(title: goTitle, danger: what == .deleteCopy, palette: palette, id: ShellID.settingsConfirmGo) {
            Task { await model.go() }
          }
          .disabled(!can)
          .opacity(can ? 1 : 0.55)
          .accessibilityValue(can ? "enabled" : "not in this version")
        }
      }
      .padding(18)
      .frame(width: 420, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: 10).fill(Tokens.color(palette.layer1)))
      .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Tokens.color(palette.ink), lineWidth: 3))
      .accessibilityElement(children: .contain)
      .accessibilityLabel(title)
    }
  }
}
