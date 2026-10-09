import SwiftUI
import WeMessageKit

/// Board 07's voice dock (v2 B4): one chip, the caption, the mic indicator,
/// a failure line when the state names one, and at the confirm size the
/// card. Drawn bottom-centre over the transcript by ThreadView, which
/// measures it and insets the reader so nothing sits under it (D-UI-179).
/// It draws what the voice state says and nothing more: there is no
/// microphone, no speech engine and no send here. The card's Send is
/// cmd-Return through ShellModel.voiceCommit, the approve path A uses.
struct VoiceDockView: View {
  let model: ShellModel
  let dock: VoiceDockModel
  let thread: ThreadSummary
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        VoiceChip(chip: dock.chip, palette: palette)
        Spacer(minLength: 8)
        VoiceMic(dock: dock, palette: palette)
      }
      // D-UI-172: always drawn, in every state; no switch hides it.
      Text(dock.caption)
        .font(.system(size: ProvisionalUI.voiceCaptionSize))
        .foregroundStyle(Tokens.color(palette.ink))
        .lineLimit(ProvisionalUI.voiceCaptionLines)
        .truncationMode(.tail)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityLabel(dock.caption)
        .accessibilityIdentifier(ShellID.voiceDockCaption)
      if let line = dock.failureLine {
        Text(line)
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.ink))
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.leading, 8)
          .overlay(alignment: .leading) {
            Rectangle().fill(Tokens.color(palette.ink)).frame(width: 2)
          }
          .accessibilityLabel(line)
          .accessibilityValue(dock.failure?.rawValue ?? "")
          .accessibilityIdentifier(ShellID.voiceDockFailure)
      }
      if dock.size == .confirm, let draft = model.pendingDraft(for: thread.chatGuid), draft.id == dock.draftId {
        VoiceConfirmCard(model: model, dock: dock, thread: thread, draft: draft, palette: palette)
      }
    }
    .padding(12)
    .frame(width: dock.size.width)
    .background {
      RoundedRectangle(cornerRadius: ProvisionalUI.voiceDockCorner).fill(Tokens.color(palette.layer1))
    }
    .overlay {
      RoundedRectangle(cornerRadius: ProvisionalUI.voiceDockCorner)
        .strokeBorder(Tokens.color(palette.inkDim), lineWidth: ProvisionalUI.voiceDockRule)
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Voice dock, " + dock.size.rawValue)
    .accessibilityValue(dock.size.rawValue)
    .accessibilityIdentifier(ShellID.voiceDockBoard07)
  }
}

/// D-UI-170 and D-UI-171: one chip, told apart by glyph, word, outline and
/// weight. Ink on layer1, or inverted for Muted by you; never a colour.
struct VoiceChip: View {
  let chip: VoiceDockModel.Chip
  let palette: Tokens.Palette

  var body: some View {
    Text(chip.label)
      .font(.system(size: ProvisionalUI.voiceChipFontSize, weight: chip.bold ? .bold : .regular))
      .foregroundStyle(Tokens.color(chip.inverted ? palette.layer1 : palette.ink))
      .padding(.horizontal, 8)
      .padding(.vertical, 3)
      .background {
        if chip.inverted { Capsule().fill(Tokens.color(palette.ink)) }
      }
      .overlay {
        if chip.dashed {
          Capsule().strokeBorder(
            Tokens.color(palette.ink),
            style: StrokeStyle(lineWidth: chip.border, dash: ProvisionalUI.voiceChipDash.map { CGFloat($0) }))
        } else if !chip.inverted {
          Capsule().strokeBorder(Tokens.color(palette.ink), lineWidth: chip.border)
        }
      }
      .fixedSize()
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(chip.label)
      .accessibilityValue(chip.rawValue)
      .accessibilityIdentifier(ShellID.voiceDockChip)
  }
}

/// D-UI-175: what the voice state says about the mic, in words. There is
/// no microphone in this version; the indicator never asks for one.
struct VoiceMic: View {
  let dock: VoiceDockModel
  let palette: Tokens.Palette

  var body: some View {
    Text(dock.micLine)
      .font(.system(size: 10, weight: dock.micMuted ? .bold : .regular))
      .foregroundStyle(Tokens.color(palette.inkDim))
      .fixedSize()
      .accessibilityLabel(dock.micLine)
      .accessibilityValue(dock.micMuted ? "muted" : "open")
      .accessibilityIdentifier(ShellID.voiceDockMic)
  }
}

/// D-UI-173: the confirm card. A spoken approve only arms it: the card
/// names the recipient, the channel, the readback token and the draft
/// verbatim, and its one way forward is cmd-Return, through voiceCommit.
/// Cancel, a click (D-UI-177), disarms it and leaves the draft pending.
struct VoiceConfirmCard: View {
  let model: ShellModel
  let dock: VoiceDockModel
  let thread: ThreadSummary
  let draft: DraftPayload
  let palette: Tokens.Palette

  private var channel: String { isSMSChat(thread.chatGuid) ? "SMS" : "iMessage" }
  private var token: String { dock.readbackToken.map { "\u{201C}" + $0 + "\u{201D} " + ProvisionalUI.voiceCardMatched } ?? "" }
  private var stateLine: String { dock.armed ? ProvisionalUI.voiceCardArmedLine : ProvisionalUI.voiceCardDisarmedLine }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      row("To", thread.title)
      row(ProvisionalUI.voiceCardOn, channel)
      if !token.isEmpty { row(ProvisionalUI.voiceCardToken, token) }
      Text(draft.body)
        .font(.system(size: 13))
        .foregroundStyle(Tokens.color(palette.ink))
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 8).fill(Tokens.color(palette.layer2)))
      Text(stateLine)
        .font(.system(size: 11, weight: dock.armed ? .bold : .regular))
        .foregroundStyle(Tokens.color(palette.ink))
      HStack(spacing: 8) {
        Spacer(minLength: 0)
        Button { model.voiceCancel() } label: {
          Text("Cancel")
            .font(.system(size: 12))
            .foregroundStyle(Tokens.color(palette.ink))
            .padding(.horizontal, 12)
            .frame(height: 28)
            .overlay(Capsule().strokeBorder(Tokens.color(palette.inkDim), lineWidth: 1))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!dock.armed)
        .accessibilityLabel("Cancel")
        .accessibilityIdentifier(ShellID.voiceDockCancel)
        if dock.armed {
          Button { model.voiceCommit(in: thread.chatGuid) } label: {
            Text(ProvisionalUI.voiceCardSend)
              .font(.system(size: 12, weight: .semibold))
              .foregroundStyle(Tokens.color(palette.layer1))
              .padding(.horizontal, 14)
              .frame(height: 28)
              .background(Capsule().fill(Tokens.color(palette.ink)))
              .contentShape(Capsule())
          }
          .buttonStyle(.plain)
          .keyboardShortcut(.return, modifiers: .command)
          .accessibilityLabel(ProvisionalUI.voiceCardSend)
          .accessibilityIdentifier(ShellID.voiceDockSend)
        }
      }
    }
    .padding(10)
    .overlay {
      RoundedRectangle(cornerRadius: 10).strokeBorder(Tokens.color(palette.ink), lineWidth: dock.armed ? 3 : 1)
    }
    // The card draws the body verbatim: it is the draft on screen, so A's
    // drawn-before-approved gate counts it.
    .onAppear { model.outbound.markRendered(draft.id) }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(stateLine)
    .accessibilityValue(dock.armed ? "armed" : "disarmed")
    .accessibilityIdentifier(ShellID.voiceDockCard)
  }

  private func row(_ key: String, _ value: String) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(key)
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .frame(width: 96, alignment: .leading)
      Text(value)
        .font(.system(size: 12))
        .foregroundStyle(Tokens.color(palette.ink))
        .lineLimit(1)
    }
  }
}
