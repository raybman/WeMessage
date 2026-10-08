import SwiftUI
import WeMessageKit

/// One statistic (17.D): its label, its number, and its caveat. The caveat
/// is a stored field with no default and the tile has no initialiser of
/// its own, so a tile cannot be drawn without one (17.D rule b, H-S4-13).
/// No trend arrow, no delta, no target.
struct StatTile: View {
  let key: String
  let label: String
  let value: String
  let caveat: String
  let emphasized: Bool
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(label.uppercased())
        .font(.system(size: 11, weight: .semibold))
        .tracking(1.1)
        .foregroundStyle(Tokens.color(palette.ink))
      Text(value)
        .font(.system(size: 26, weight: .bold))
        .foregroundStyle(Tokens.color(palette.ink))
      Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.3)).frame(height: 1)
      Text(caveat)
        .font(.system(size: 11))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(12)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .background(RoundedRectangle(cornerRadius: 6).fill(Tokens.color(palette.layer1)))
    .overlay(
      RoundedRectangle(cornerRadius: 6).strokeBorder(Tokens.color(palette.ink), lineWidth: emphasized ? 2 : 1))
    .accessibilityElement(children: .ignore)
    .accessibilityAddTraits(.isStaticText)
    .accessibilityLabel(label.uppercased() + ": " + value + ". " + caveat)
    .accessibilityIdentifier(ShellID.statPrefix + key)
  }
}
