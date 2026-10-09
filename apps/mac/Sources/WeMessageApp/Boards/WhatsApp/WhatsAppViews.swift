import SwiftUI
import WeMessageKit

// v2 B0, board 03: the WhatsApp board. The channel banner, in the trust
// banner's register (tint rule, layer1, ink), with the fixture chip at its
// trailing edge, and the New here empty state under it. Monochrome plus the
// app's one blue tint: never the channel's brand colour, never green.

/// Board 03 while the WhatsApp tile is selected and its channel draws one.
struct WhatsAppBoardView: View {
  let board: WhatsAppBoardModel
  let palette: Tokens.Palette

  var body: some View {
    VStack(spacing: 0) {
      WhatsAppBanner(board: board, palette: palette)
      VStack(spacing: 8) {
        Text(board.headline)
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.ink))
          .multilineTextAlignment(.center)
          .accessibilityLabel(board.headline)
          .accessibilityAddTraits([.isHeader, .isStaticText])
          .accessibilityIdentifier(ShellID.whatsAppEmpty)
        Text(board.detail)
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.inkDim))
          .multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityLabel(board.detail)
          .accessibilityAddTraits(.isStaticText)
      }
      .frame(maxWidth: 360)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier(ShellID.whatsAppBoard)
  }
}

/// Board 03's channel banner (D-UI-135): the channel named in ink on
/// layer1 with the tint rule at its leading edge, and the fixture chip at
/// its trailing edge (D-UI-132). The empty board and an open chat share it.
struct WhatsAppBanner: View {
  let board: WhatsAppBoardModel
  let palette: Tokens.Palette

  var body: some View {
    HStack(spacing: 10) {
      Text(board.banner)
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
        .lineLimit(1)
        .truncationMode(.tail)
        .accessibilityLabel(board.banner)
        .accessibilityAddTraits(.isStaticText)
        .accessibilityIdentifier(ShellID.whatsAppBanner)
      Spacer(minLength: 8)
      if let chip = board.chip {
        BoardChip(text: chip, palette: palette)
      }
    }
    .padding(.horizontal, 12)
    .frame(height: KillBanner.height)
    .frame(maxWidth: .infinity)
    .background(Tokens.color(palette.layer1))
    .overlay(alignment: .leading) { Rectangle().fill(Tokens.color(Tokens.tint)).frame(width: 3).accessibilityHidden(true) }
  }
}

/// The chip a board drawn over fixtures carries (D-UI-132): ink on the
/// tint at low alpha, a capsule, never a watermark.
struct BoardChip: View {
  let text: String
  let palette: Tokens.Palette

  var body: some View {
    Text(text)
      .font(.system(size: ProvisionalUI.fixtureChipSize, weight: .semibold))
      .foregroundStyle(Tokens.color(palette.ink))
      .padding(.vertical, 2)
      .padding(.horizontal, 8)
      .background(Capsule().fill(Tokens.color(Tokens.tint, opacity: ProvisionalUI.fixtureChipTintAlpha)))
      .fixedSize()
      .accessibilityLabel(text)
      .accessibilityAddTraits(.isStaticText)
      .accessibilityIdentifier(ShellID.fixtureChip)
  }
}
