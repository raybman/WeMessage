import AppKit
import SwiftUI
import WeMessageKit

/// The channel tag (wireframe .ch: mono 700 8, ink border, radius 3).
struct ChannelTag: View {
  let channel: String
  let palette: Tokens.Palette

  var body: some View {
    Text(ShellModel.Scope(rawValue: channel)?.label ?? channel)
      .font(.system(size: 8, weight: .bold, design: .monospaced))
      .foregroundStyle(Tokens.color(palette.ink))
      .fixedSize()
      .padding(.vertical, 2)
      .padding(.horizontal, 3)
      .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
  }
}

/// One conversation in the list (wireframe .conv). One accessibility
/// element; never a Tab stop (the rows are reached with the arrows in S4d).
struct ListRow: View {
  let thread: ThreadSummary
  let showsChannel: Bool
  let selected: Bool
  let asOf: Date?
  let palette: Tokens.Palette
  let dark: Bool
  /// Boards 06 and 09: the row's queue note ("Draft ready", "opened 14:02",
  /// an exclusion reason, "Snoozed until Monday 9:00").
  var note: String? = nil
  /// A snoozed row stays listed in Triage, dimmed (06.C).
  var dimmed = false
  /// X selected this row for a bulk act (06.F).
  var checked = false
  /// The contact's photo, or nil for the initials disc (S4g).
  var image: NSImage? = nil
  let action: () -> Void

  private var spoken: String {
    let channel = ShellModel.Scope(rawValue: thread.channel)?.fullLabel ?? thread.channel
    return [checked ? "Selected" : nil, thread.title, channel, ShellText.preview(thread), note].compactMap { $0 }
      .joined(separator: ", ")
  }

  private var selectedFill: Color {
    switch ProvisionalUI.selectedRow {
    case .tintBarWash: Tokens.color(Tokens.Selection.wash(dark: dark))
    case .inkBarFill: Tokens.color(palette.layer2)
    }
  }

  private var selectedBar: Color {
    switch ProvisionalUI.selectedRow {
    case .tintBarWash: Tokens.color(Tokens.tint)
    case .inkBarFill: Tokens.color(palette.ink)
    }
  }

  var body: some View {
    Button(action: action) {
      HStack(alignment: .top, spacing: 8) {
        if checked {
          Text("\u{2713}")
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(Tokens.color(palette.ink))
            .frame(width: 12)
            .accessibilityHidden(true)
        }
        AvatarView(thread: thread, image: image, size: 36)
        VStack(alignment: .leading, spacing: 2) {
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            if showsChannel { ChannelTag(channel: thread.channel, palette: palette) }
            Text(thread.title)
              .font(.system(size: 12, weight: .semibold))
              .foregroundStyle(Tokens.color(palette.ink))
              .lineLimit(1)
              .truncationMode(.tail)
            Spacer(minLength: 4)
            Text(ShellText.rowTime(thread.lastAt, asOf: asOf))
              .font(.system(size: 9))
              .foregroundStyle(Tokens.color(palette.inkDim))
              .fixedSize()
          }
          if let preview = ShellText.preview(thread) {
            Text(preview)
              .font(.system(size: 10))
              .foregroundStyle(Tokens.color(palette.inkDim))
              .lineLimit(2)
              .multilineTextAlignment(.leading)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
          if let note {
            Text(note)
              .font(.system(size: 9, weight: .semibold, design: .monospaced))
              .foregroundStyle(Tokens.color(palette.ink))
              .lineLimit(1)
              .truncationMode(.tail)
          }
        }
      }
      .opacity(dimmed ? 0.45 : 1)
      .padding(.vertical, 8)
      .padding(.horizontal, 12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(selected ? selectedFill : Color.clear)
      .overlay(alignment: .leading) {
        if selected { Rectangle().fill(selectedBar).frame(width: 3) }
      }
      .overlay(alignment: .bottom) {
        Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.15)).frame(height: 0.5)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .focusable(false)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(spoken)
    .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    // Under the UI-test flag only: which avatar the row draws, so board 01
    // can hold both a photo and an initials disc on screen (S4g).
    .accessibilityValue(TestHooks.isUITest ? (image == nil ? "initials" : "photo") : "")
    // Ignoring children drops the Button's press; give it back so
    // VoiceOver and the audit see an action on the row.
    .accessibilityAction { action() }
  }
}

/// The content pane: the D-UI-5 empty state, or the selected thread's head
/// (wireframe .thread-head) with the inspector toggle, over board 02's
/// thread (S4d).
struct ContentPane: View {
  @Bindable var model: ShellModel
  let palette: Tokens.Palette

  var body: some View {
    VStack(spacing: 0) {
      if model.killSwitch == true {
        KillBanner(model: model, palette: palette)
      }
      // Board 10: lost access outranks a stale tile; the FDA screen takes
      // the pane while it is up (10.A, 10.C).
      if case .revoked(let at) = model.fda {
        RevokedBanner(model: model, lastReadable: at, palette: palette)
      } else if let line = model.trustLine {
        TrustBannerView(model: model, line: line, palette: palette)
      }
      if model.fdaScreenUp {
        FDAScreen(asked: model.fdaAsked, palette: palette) {
          model.openFullDiskAccess()
        } skip: {
          model.fdaSkipped = true
          model.fdaScreenShown = false
        }
      } else {
        pane
      }
    }
  }

  /// The audit, the bulk card, the thread, a zero screen outside Recent, or
  /// the empty state, in that order.
  @ViewBuilder private var pane: some View {
    if model.auditShown {
      AuditView(model: model, palette: palette)
    } else if model.bulkSheetShown {
      BulkConfirmCard(model: model, palette: palette)
    } else if let thread = model.selected {
      VStack(spacing: 0) {
        ThreadHeader(thread: thread, image: model.avatars.image(for: thread), asOf: model.thread.asOf, palette: palette) {
          model.inspectorShown.toggle()
        }
        Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.2)).frame(height: 0.5).accessibilityHidden(true)
        ThreadView(model: model, thread: thread, palette: palette)
      }
      .task(id: model.selectedThread) { await model.thread.open(model.selectedThread) }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .accessibilityElement(children: .contain)
      .accessibilityLabel(thread.title)
      .accessibilityIdentifier(ShellID.content)
    } else if model.lens != .recent && model.scopedQueue.isEmpty {
      ZeroScreen(model: model, palette: palette)
    } else {
      Text(ProvisionalUI.contentEmpty)
        .font(.system(size: 13))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .multilineTextAlignment(.center)
        .frame(maxWidth: 360)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier(ShellID.contentEmpty)
    }
  }
}

/// The handle a one-to-one chat guid carries after its service and ";-;".
func threadHandle(_ thread: ThreadSummary) -> String? {
  guard !thread.isGroup, let range = thread.chatGuid.range(of: ";-;") else { return nil }
  return String(thread.chatGuid[range.upperBound...])
}

/// The thread head: avatar, name, channel and handle, and the ⓘ toggle.
struct ThreadHeader: View {
  let thread: ThreadSummary
  var image: NSImage? = nil
  var asOf: Date? = nil
  let palette: Tokens.Palette
  let toggle: () -> Void

  var body: some View {
    HStack(spacing: 8) {
      AvatarView(thread: thread, image: image, size: 28)
      VStack(alignment: .leading, spacing: 2) {
        Text(thread.title)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.ink))
          .lineLimit(1)
        Text(subline)
          .font(.system(size: 9))
          .foregroundStyle(Tokens.color(palette.inkDim))
          .lineLimit(1)
      }
      Spacer(minLength: 0)
      Button(action: toggle) {
        Text("\u{24D8}")
          .font(.system(size: 12))
          .foregroundStyle(Tokens.color(palette.ink))
          .frame(width: 26, height: 26)
          .background(RoundedRectangle(cornerRadius: 5).fill(Tokens.color(palette.layer1)))
          .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(Tokens.color(palette.inkDim, opacity: 0.35), lineWidth: 1))
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .focusable()
      .accessibilityLabel("Inspector")
      .accessibilityIdentifier(ShellID.inspectorToggle)
    }
    .padding(.vertical, 8)
    .padding(.horizontal, 12)
    .frame(minHeight: 52)
  }

  private var subline: String {
    let channel = ShellModel.Scope(rawValue: thread.channel)?.fullLabel ?? thread.channel
    // D-UI-30: what this app knows about reading, which is only that the
    // transcript was fetched, and when.
    let read = asOf.flatMap { ProvisionalUI.readHere(clock: ShellText.shortClock($0)) }
    return [channel, threadHandle(thread), read].compactMap { $0 }.joined(separator: " \u{00B7} ")
  }
}

/// The inspector column (D-UI-24: identity only until S4d and S4g).
struct InspectorPane: View {
  let thread: ThreadSummary
  var image: NSImage? = nil
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if ProvisionalUI.inspectorContent == .identityOnly {
        AvatarView(thread: thread, image: image, size: 36)
        Text(thread.title)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.ink))
        Text(ShellModel.Scope(rawValue: thread.channel)?.fullLabel ?? thread.channel)
          .font(.system(size: 9))
          .foregroundStyle(Tokens.color(palette.inkDim))
        if let handle = threadHandle(thread) {
          Text(handle)
            .font(.system(size: 9, design: .monospaced))
            .foregroundStyle(Tokens.color(palette.inkDim))
        }
      }
      Spacer(minLength: 0)
    }
    .padding(12)
    .frame(width: ProvisionalUI.inspectorWidth)
    .frame(maxHeight: .infinity, alignment: .top)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Inspector")
    .accessibilityIdentifier(ShellID.inspector)
  }
}
