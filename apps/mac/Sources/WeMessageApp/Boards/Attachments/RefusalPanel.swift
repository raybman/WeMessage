import SwiftUI
import WeMessageKit

// v2 S4k, board 15.H: the refusal panel and the iMessage column of the
// matrix (D-UI-111). Four parts, in this order, every time: the platform's
// rule in the platform's terms, the thread it applies to, what WeMessage
// still does, and the thing that works without leaving the desk. Not a
// toast, not a greyed control, not an apology. Its fourth part moves the
// drafted words into the composer; it sends nothing (D-UI-106).

struct RefusalPage: View {
  let model: AttachmentsModel
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      RefusalPanel(model: model, palette: palette)
      MediaMatrix(palette: palette)
    }
  }
}

struct RefusalPanel: View {
  let model: AttachmentsModel
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("No voice note from here")
        .font(.system(size: 16, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
      part(1, title: "The rule", body: model.record.reason ?? "")
      part(
        2, title: "For this thread",
        body: model.content.recipient + " \u{00B7} iMessage \u{00B7} " + ComposeModel.printed(model.content.handle))
      part(
        3, title: "What WeMessage still does",
        body: "Her voice messages still arrive in this thread, in order, and nothing about this takes the thread out of the queue.")
      VStack(alignment: .leading, spacing: 6) {
        Text("4 \u{00B7} What works right now")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.inkDim))
        Text(model.content.draftedWords)
          .font(.system(size: 13))
          .foregroundStyle(Tokens.color(palette.ink))
          .fixedSize(horizontal: false, vertical: true)
          .padding(10)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(RoundedRectangle(cornerRadius: 8).fill(Tokens.color(palette.layer1)))
        HStack(spacing: 8) {
          SettingsButton(title: "Move to the composer", palette: palette, id: ShellID.mediaRefusalTake) {
            model.takeDraftedWords()
            model.page = .thread
          }
          Text("You press Send there. Nothing sends from this panel.")
            .font(.system(size: 11))
            .foregroundStyle(Tokens.color(palette.inkDim))
        }
      }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier(ShellID.mediaRefusalPartPrefix + "4")
    }
    .padding(16)
    .frame(maxWidth: .infinity, alignment: .leading)
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Refusal")
    .accessibilityIdentifier(ShellID.mediaRefusal)
  }

  private func part(_ n: Int, title: String, body: String) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      Text("\(n) \u{00B7} " + title)
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.inkDim))
      Text(body)
        .font(.system(size: 13))
        .foregroundStyle(Tokens.color(palette.ink))
        .fixedSize(horizontal: false, vertical: true)
    }
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier(ShellID.mediaRefusalPartPrefix + "\(n)")
  }
}

/// 15.H's iMessage column: each media act, what iMessage allows, and what
/// WeMessage draws for it.
struct MediaMatrix: View {
  let palette: Tokens.Palette

  static let rows: [(String, String, String)] = [
    ("stage by drop, paste or pick", "R+W", "one tray, one send path"),
    ("send an image", "R+W", "the tray, against the dated wall"),
    ("send an album as one message", "R+W", "the recipient's grid, before the send"),
    ("HEIC to JPEG on the way out", "R+W", "always, and always printed"),
    ("strip location metadata", "R+W", "always, on by default"),
    ("send a video inline", "R+W ~100MB", "duration always shown"),
    ("compress before send", "R+W", "a table of targets, never automatic"),
    ("record a voice note", "ABSENT", "no control; the reason where it would be"),
    ("record an audio file", "R+W", "named for what it makes, not a note"),
    ("agent generates audio", "NEVER", "no control, no setting, no opt in"),
    ("react to a photo", "R only", "no hook on iMessage"),
    ("delete a sent attachment", "ABSENT", "not drawn in the viewer"),
    ("mark played by viewing", "NO", "the viewer never writes back"),
  ]

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text("iMessage, act by act")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
      ForEach(Array(Self.rows.enumerated()), id: \.offset) { index, row in
        HStack(spacing: 10) {
          Text(row.0).frame(width: 220, alignment: .leading)
          Text(row.1).fontWeight(.semibold).frame(width: 100, alignment: .leading)
          Text(row.2).foregroundStyle(Tokens.color(palette.inkDim))
        }
        .font(.system(size: 11).monospacedDigit())
        .foregroundStyle(Tokens.color(palette.ink))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(ShellID.mediaMatrixPrefix + "\(index)")
      }
    }
  }
}
