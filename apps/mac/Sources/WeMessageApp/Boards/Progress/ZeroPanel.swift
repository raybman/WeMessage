import SwiftUI
import WeMessageKit

/// One zero screen's body (17.H), shared by the live list column and board
/// 17: the numeral, the heading (which zero it is), the lines above the
/// rule, the receipt on the earned zero only, the lines under the rule, the
/// run on the earned zero only (at the freshness line's size), Verify on
/// the quiet zero only (D-UI-128), and Progress when there is somewhere to
/// go (D-UI-123). The celebration is the type size and nothing else.
struct ZeroPanel: View {
  let content: ZeroContent
  let palette: Tokens.Palette
  let onVerify: () -> Void
  let onProgress: (() -> Void)?

  var body: some View {
    VStack(spacing: 10) {
      Text("0")
        .font(.system(size: ProvisionalUI.zeroNumeralSize, weight: .bold, design: .monospaced))
        .foregroundStyle(Tokens.color(palette.ink))
        .minimumScaleFactor(ProvisionalUI.zeroNumeralClampsToPane ? 0.5 : 1)
        .lineLimit(1)
        .accessibilityHidden(true)
      Text(content.heading)
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
        .multilineTextAlignment(.center)
        .accessibilityAddTraits(.isHeader)
        .accessibilityLabel(ZeroWords.kindWord(content.kind) + ": " + content.heading)
        .accessibilityIdentifier(ShellID.zeroKind)
      ForEach(content.lines, id: \.self) { line in
        words(line)
      }
      if let receipt = content.receipt {
        Text(receipt)
          .font(.system(size: 12))
          .foregroundStyle(Tokens.color(palette.ink))
          .multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityLabel(receipt)
          .accessibilityIdentifier(ShellID.zeroReceipt)
      }
      Rectangle()
        .fill(Tokens.color(palette.inkDim, opacity: 0.35))
        .frame(width: 280, height: 1)
        .accessibilityHidden(true)
      ForEach(content.footer, id: \.self) { line in
        words(line)
      }
      if let run = content.streakLine {
        Text(run)
          .font(.system(size: 11, weight: .bold))
          .foregroundStyle(Tokens.color(palette.ink))
          .accessibilityAddTraits(.isStaticText)
          .accessibilityLabel(run)
          .accessibilityIdentifier(ShellID.zeroStreak)
      }
      if content.verifies || onProgress != nil {
        HStack(spacing: 8) {
          if content.verifies {
            Self.verify(palette: palette, action: onVerify)
          }
          if let onProgress {
            QueueButton(title: "Progress\u{2026}", key: nil, filled: false, palette: palette, action: onProgress)
              .accessibilityLabel("Progress")
              .accessibilityIdentifier(ShellID.zeroProgress)
          }
        }
        .padding(.top, 2)
      }
    }
    .frame(maxWidth: 360)
  }

  private func words(_ text: String) -> some View {
    Text(text)
      .font(.system(size: 11))
      .foregroundStyle(Tokens.color(palette.inkDim))
      .multilineTextAlignment(.center)
      .fixedSize(horizontal: false, vertical: true)
      .accessibilityLabel(text)
  }

  /// Verify now: the one button that asks the sources again.
  static func verify(palette: Tokens.Palette, action: @escaping () -> Void) -> some View {
    QueueButton(title: "Verify now", key: nil, filled: false, palette: palette, action: action)
      .accessibilityLabel("Verify now")
      .accessibilityIdentifier(ShellID.zeroVerify)
  }
}
