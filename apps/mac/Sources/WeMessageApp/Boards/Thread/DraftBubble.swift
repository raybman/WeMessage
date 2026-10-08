import SwiftUI
import WeMessageKit

/// An agent draft in the transcript (wireframe .bub.draft, 02.A): 2 pt
/// dashed on paper, never filled, because it has not been sent. The label
/// names the adapter that wrote it; the why line says only what the daemon
/// serves (D-UI-38).
struct DraftBubble: View {
  let draft: DraftPayload
  let isGroup: Bool
  let maxWidth: Double
  let palette: Tokens.Palette
  /// Outside Recent: the 09.B meta line, in place of the why line (the
  /// rationale has its own block in Needs You).
  var meta: String? = nil
  /// Expired or held by the kill switch: drawn muted (09.B).
  var absent = false

  private var label: String {
    var parts = ["Draft", draft.adapterId]
    if isGroup { parts.append("needs your approval") }
    return parts.joined(separator: " \u{00B7} ").uppercased()
  }

  private var why: String? {
    meta == nil ? ProvisionalUI.whyLine(proactiveReason: draft.proactiveReason, ruleId: draft.ruleId) : nil
  }

  var body: some View {
    HStack(spacing: 0) {
      Spacer(minLength: 0)
      VStack(alignment: .leading, spacing: 6) {
        Text(label)
          .font(.system(size: 9, weight: .bold))
          .tracking(1.2)
          .foregroundStyle(Tokens.color(palette.inkDim))
        Text(draft.body)
          .font(.system(size: 13))
          .foregroundStyle(Tokens.color(absent ? palette.inkDim : palette.ink))
          .fixedSize(horizontal: false, vertical: true)
        if let meta {
          Text(meta)
            .font(.system(size: 9, weight: .semibold, design: .monospaced))
            .foregroundStyle(Tokens.color(palette.inkDim))
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityLabel(meta)
            .accessibilityIdentifier(ShellID.draftVerb(draft.id, "meta"))
        }
        if let why {
          Text(why)
            .font(.system(size: 10))
            .foregroundStyle(Tokens.color(palette.inkDim))
            .fixedSize(horizontal: false, vertical: true)
            .padding(.leading, 8)
            .overlay(alignment: .leading) {
              Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.35)).frame(width: 2)
            }
        }
      }
      .frame(maxWidth: max(0, maxWidth - 2 * TranscriptLayout.horizontalPadding), alignment: .leading)
      .padding(.vertical, 8)
      .padding(.horizontal, TranscriptLayout.horizontalPadding)
      .background(RoundedRectangle(cornerRadius: TranscriptLayout.radius).fill(Tokens.color(palette.layer1)))
      .overlay {
        RoundedRectangle(cornerRadius: TranscriptLayout.radius)
          .strokeBorder(
            absent ? Tokens.color(palette.inkDim, opacity: 0.5) : Tokens.color(Tokens.draftOutline), style: BubbleStroke.dashed)
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel([label, draft.body, meta ?? why].compactMap { $0 }.joined(separator: ", "))
    .accessibilityValue(draft.id)
  }
}

/// A draft the human held for later review (D-UI-36, 02.A's Hold): muted,
/// as the wireframe's .draft.off, and saying it is still in the daemon.
struct HeldBubble: View {
  let draft: DraftPayload
  let maxWidth: Double
  let palette: Tokens.Palette
  /// Outside Recent: the 09.B meta line ("HELD by you ...").
  var meta: String? = nil
  /// Back to awaiting (09.B), when the kill switch is off.
  var release: (() -> Void)? = nil

  var body: some View {
    HStack(spacing: 0) {
      Spacer(minLength: 0)
      VStack(alignment: .leading, spacing: 6) {
        Text(ProvisionalUI.heldLine)
          .font(.system(size: 9, weight: .bold))
          .tracking(1.2)
          .foregroundStyle(Tokens.color(palette.inkDim))
        Text(draft.body)
          .font(.system(size: 13))
          .foregroundStyle(Tokens.color(palette.inkDim))
          .fixedSize(horizontal: false, vertical: true)
        if let meta {
          Text(meta)
            .font(.system(size: 9, weight: .semibold, design: .monospaced))
            .foregroundStyle(Tokens.color(palette.inkDim))
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityLabel(meta)
            .accessibilityIdentifier(ShellID.draftVerb(draft.id, "meta"))
        }
        if let release {
          QueueButton(title: "Release to awaiting", key: nil, filled: false, palette: palette, action: release)
            .accessibilityLabel("Release to awaiting")
            .accessibilityIdentifier(ShellID.release)
        }
      }
      .frame(maxWidth: max(0, maxWidth - 2 * TranscriptLayout.horizontalPadding), alignment: .leading)
      .padding(.vertical, 8)
      .padding(.horizontal, TranscriptLayout.horizontalPadding)
      .background(RoundedRectangle(cornerRadius: TranscriptLayout.radius).fill(Tokens.color(palette.layer1)))
      .overlay {
        RoundedRectangle(cornerRadius: TranscriptLayout.radius)
          .strokeBorder(Tokens.color(palette.inkDim, opacity: 0.5), style: BubbleStroke.dashed)
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(ProvisionalUI.heldLine + ", " + draft.body)
    .accessibilityValue("held")
  }
}

/// The draft's verbs in the composer (02.A): Approve filled, Edit and Hold
/// ghost, each with its keycap drawn and not bound (D-UI-29). Approve is
/// the one that reaches the daemon, through Outbound, after its 10 s undo.
/// There is no Hold until here, in any state (02.J).
struct DraftVerbs: View {
  /// The three identifiers: the composer's in Recent, or the draft's own
  /// (ShellID.draftVerb) in Needs You and Triage.
  struct IDs {
    var approve = ShellID.draftApprove
    var edit = ShellID.draftEdit
    var hold = ShellID.draftHold

    static func draft(_ id: String) -> IDs {
      IDs(approve: ShellID.draftVerb(id, "approve"), edit: ShellID.draftVerb(id, "edit"), hold: ShellID.draftVerb(id, "hold"))
    }
  }

  let palette: Tokens.Palette
  /// A nil verb is refused by its gate and is not drawn (09.F rule 1).
  let approve: (() -> Void)?
  let edit: (() -> Void)?
  let hold: (() -> Void)?
  var ids = IDs()

  var body: some View {
    HStack(spacing: 8) {
      if let approve {
        verb("Approve", key: "A", filled: true, action: approve)
          .accessibilityIdentifier(ids.approve)
      }
      if let edit {
        verb("Edit", key: "R", filled: false, action: edit)
          .accessibilityIdentifier(ids.edit)
      }
      if let hold {
        verb("Hold", key: "\u{232B}", filled: false, dim: true, action: hold)
          .accessibilityIdentifier(ids.hold)
      }
      Spacer(minLength: 0)
    }
  }

  private func verb(_ title: String, key: String, filled: Bool, dim: Bool = false, action: @escaping () -> Void)
    -> some View
  {
    Button(action: action) {
      HStack(spacing: 6) {
        Text(title)
          .font(.system(size: 11, weight: .semibold))
        if ProvisionalUI.draftKeycaps == .shownUnbound {
          Text(key)
            .font(.system(size: 9, design: .monospaced))
            .opacity(0.8)
            .accessibilityHidden(true)
        }
      }
      .foregroundStyle(filled ? Tokens.color(palette.layer1) : Tokens.color(palette.ink))
      .padding(.vertical, 6)
      .padding(.horizontal, 10)
      .background(RoundedRectangle(cornerRadius: 6).fill(filled ? Tokens.color(palette.ink) : Tokens.color(palette.layer1)))
      .overlay {
        RoundedRectangle(cornerRadius: 6)
          .strokeBorder(Tokens.color(palette.inkDim, opacity: dim ? 0.35 : 1), lineWidth: filled ? 0 : 1)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .focusable()
    .accessibilityLabel(title)
  }
}
