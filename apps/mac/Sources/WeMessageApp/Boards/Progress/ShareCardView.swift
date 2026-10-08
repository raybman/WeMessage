import SwiftUI
import struct WeMessageKit.ShareCard

/// The shareable card (17.E) at its export size, 640 by 400 at 1x. Its only
/// input is ShareCard: four integers and two dates. Every word below is a
/// literal in this file, so no message body, name, number or clock time
/// can reach a pixel. The file imports SwiftUI and that one struct and
/// names no other type of the app or the kit (H-S4-13).
///
/// Laid out absolutely (D-UI-127): each number sits in a fixed, clipped box
/// listed in `numeralBoxes`, so a render of the same card with every number
/// at 0 differs from this one only inside those boxes. Black on white in
/// both appearances, because the image leaves the app.
struct ShareCardView: View {
  let card: ShareCard

  static let width: CGFloat = 640
  static let height: CGFloat = 400

  /// The four number boxes, in card points, top-left origin: the run, the
  /// threads cleared, the days at zero and the longest run.
  static let numeralBoxes: [CGRect] = [
    CGRect(x: 36, y: 58, width: 300, height: 128),
    CGRect(x: 40, y: 236, width: 200, height: 44),
    CGRect(x: 330, y: 236, width: 200, height: 44),
    CGRect(x: 520, y: 336, width: 44, height: 24),
  ]

  private static let ink = Color.black
  private static let dim = Color.black.opacity(0.6)

  private var period: String {
    let day = Date.FormatStyle().month(.abbreviated).day()
    let year = Date.FormatStyle().year()
    return card.periodStart.formatted(day) + " to " + card.periodEnd.formatted(day) + ", "
      + card.periodEnd.formatted(year)
  }

  var body: some View {
    ZStack(alignment: .topLeading) {
      Color.white
      RoundedRectangle(cornerRadius: 14)
        .strokeBorder(Self.ink, lineWidth: 2)
      caption("WEMESSAGE \u{00B7} INBOX ZERO")
        .place(x: 40, y: 32, width: 400, height: 16)
      numeral(card.streakDays, size: 110, box: 0)
      Text("days cleared in a row")
        .font(.system(size: 24, weight: .semibold))
        .foregroundStyle(Self.ink)
        .place(x: 40, y: 190, width: 400, height: 32)
      numeral(card.clearedThisWeek, size: 34, box: 1)
      caption("THREADS CLEARED")
        .place(x: 40, y: 284, width: 260, height: 16)
      numeral(card.daysAtZeroInMonth, size: 34, box: 2)
      caption("DAYS AT ZERO THIS MONTH")
        .place(x: 330, y: 284, width: 270, height: 16)
      Rectangle()
        .fill(Self.ink)
        .place(x: 40, y: 322, width: Self.width - 80, height: 1)
      Text(period)
        .font(.system(size: 13))
        .foregroundStyle(Self.dim)
        .place(x: 40, y: 339, width: 300, height: 18)
      Text("longest run")
        .font(.system(size: 13))
        .foregroundStyle(Self.dim)
        .frame(width: 140, height: 18, alignment: .trailing)
        .place(x: 374, y: 339, width: 140, height: 18)
      numeral(card.longestRunDays, size: 15, box: 3)
      Text("days")
        .font(.system(size: 13))
        .foregroundStyle(Self.dim)
        .place(x: 566, y: 339, width: 40, height: 18)
    }
    .frame(width: Self.width, height: Self.height)
    .environment(\.colorScheme, .light)
  }

  private func caption(_ text: String) -> some View {
    Text(text)
      .font(.system(size: 11, weight: .semibold))
      .tracking(1.6)
      .foregroundStyle(Self.dim)
  }

  private func numeral(_ value: Int, size: CGFloat, box: Int) -> some View {
    let rect = Self.numeralBoxes[box]
    return Text(String(value))
      .font(.system(size: size, weight: .bold, design: .monospaced))
      .foregroundStyle(Self.ink)
      .lineLimit(1)
      .fixedSize()
      .frame(width: rect.width, height: rect.height, alignment: .leading)
      .clipped()
      .offset(x: rect.minX, y: rect.minY)
  }
}

extension View {
  /// A fixed box at a fixed place on the card, clipped to itself.
  fileprivate func place(x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat) -> some View {
    frame(width: width, height: height, alignment: .leading)
      .clipped()
      .offset(x: x, y: y)
  }
}
