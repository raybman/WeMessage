import SwiftUI
import WeMessageKit

/// One meter row (17.A): the channel's box, its name, one mark (a count,
/// CLEAR, "?" or a dashed empty slot), the track filled by what was cleared
/// of today's arrivals, and the evidence line under it ending in the
/// freshness. CLEAR rows carry the 3 pt baseline; the global row a 2 pt
/// rule on top. Remaining only: the row prints no fraction of its own.
struct MeterRowView: View {
  let scope: ShellModel.Scope
  let row: MeterRow
  let evidence: String
  let live: String
  let note: String
  let palette: Tokens.Palette

  static let markWidth: CGFloat = 92
  static let trackWidth: CGFloat = 136

  private var global: Bool { scope == .all }

  /// The mark's words, as a screen reader says them.
  static func stateWords(_ state: MeterState) -> String {
    switch state {
    case .count(let n): "\(n) left"
    case .clear: "clear"
    case .cannotTell: "cannot tell"
    case .notConnected:
      "not connected"
    }
  }

  private var clear: Bool { row.state == .clear }
  private var connected: Bool { row.state != .notConnected }

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(spacing: 12) {
        Text(global ? "\u{2211}" : scope.label)
          .font(.system(size: 10, weight: .bold))
          .foregroundStyle(Tokens.color(palette.ink))
          .frame(width: 26, height: 20)
          .overlay(
            RoundedRectangle(cornerRadius: 4)
              .strokeBorder(Tokens.color(connected ? palette.ink : palette.inkDim), lineWidth: 1)
          )
          .accessibilityHidden(true)
        Text(scope.fullLabel)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(Tokens.color(connected ? palette.ink : palette.inkDim))
          .frame(maxWidth: .infinity, alignment: .leading)
          .accessibilityHidden(true)
        mark
          .frame(width: Self.markWidth, alignment: .leading)
          .accessibilityElement(children: .ignore)
          .accessibilityAddTraits(.isStaticText)
          .accessibilityLabel(Self.stateWords(row.state))
          .accessibilityIdentifier(
            (global ? ShellID.meterAll : ShellID.meterPrefix + scope.rawValue) + ".state")
        track
          .frame(width: Self.trackWidth, height: 4)
          .accessibilityHidden(true)
      }
      evidenceLine
        .font(.system(size: 11))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .fixedSize(horizontal: false, vertical: true)
        .padding(.leading, 38)
        .accessibilityLabel(plainLine)
    }
    .padding(.vertical, 8)
    .padding(.bottom, clear ? 3 : 0)
    .overlay(alignment: .bottom) {
      if clear {
        Rectangle().fill(Tokens.color(palette.ink)).frame(height: 3).accessibilityHidden(true)
      }
    }
    .overlay(alignment: .top) {
      if global {
        Rectangle().fill(Tokens.color(palette.ink)).frame(height: 2).accessibilityHidden(true)
      }
    }
    .padding(.top, global ? 6 : 0)
    .accessibilityElement(children: .contain)
    .accessibilityLabel(scope.fullLabel + ": " + Self.stateWords(row.state))
    .accessibilityIdentifier(global ? ShellID.meterAll : ShellID.meterPrefix + scope.rawValue)
  }

  private var plainLine: String {
    [evidence, live, note].filter { !$0.isEmpty }.joined(separator: " ")
  }

  /// The evidence, then the freshness in the ink at semibold, then the note.
  private var evidenceLine: Text {
    let live = Text(self.live.isEmpty ? "" : " " + self.live)
      .font(.system(size: 11, weight: .semibold))
      .foregroundColor(Tokens.color(palette.ink))
    let note = Text(self.note.isEmpty ? "" : " " + self.note)
    return Text("\(Text(evidence))\(live)\(note)")
  }

  @ViewBuilder
  private var mark: some View {
    switch row.state {
    case .count(let n):
      Text("\(Text(String(n)).font(.system(size: 17, weight: .bold, design: .monospaced))) LEFT")
        .font(.system(size: 11, weight: .bold, design: .monospaced))
        .foregroundStyle(Tokens.color(palette.ink))
        .fixedSize()
    case .clear:
      Text("CLEAR")
        .font(.system(size: 15, weight: .bold, design: .monospaced))
        .tracking(0.9)
        .foregroundStyle(Tokens.color(palette.ink))
        .fixedSize()
    case .cannotTell:
      Text("?")
        .font(.system(size: 15, weight: .bold, design: .monospaced))
        .foregroundStyle(Tokens.color(palette.ink))
    case .notConnected:
      Rectangle()
        .fill(Tokens.color(palette.layer2))
        .frame(width: 46, height: 15)
        .overlay(
          Rectangle().strokeBorder(
            Tokens.color(palette.inkDim), style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
        )
    }
  }

  @ViewBuilder
  private var track: some View {
    if let fill = row.fill {
      GeometryReader { box in
        ZStack(alignment: .leading) {
          Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.25))
          Rectangle().fill(Tokens.color(palette.ink)).frame(width: box.size.width * fill)
        }
      }
    } else {
      TrackHatch(palette: palette)
        .opacity(connected ? 1 : 0.4)
    }
  }
}

/// The hatched track (17.A): nothing to fill, drawn as 45 degree strokes so
/// it cannot be mistaken for an empty bar.
struct TrackHatch: View {
  let palette: Tokens.Palette

  var body: some View {
    Canvas { context, size in
      var path = Path()
      var x: CGFloat = -size.height
      while x < size.width {
        path.move(to: CGPoint(x: x, y: size.height))
        path.addLine(to: CGPoint(x: x + size.height, y: 0))
        x += 4
      }
      context.stroke(path, with: .color(Tokens.color(palette.inkDim)), lineWidth: 1)
    }
    .background(Tokens.color(palette.layer2))
    .clipped()
  }
}

/// A panel of meters (17.A, 17.B): its caption, the channel rows, and the
/// global row computed from them.
struct MeterPanelView: View {
  let panel: MeterPanel
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(panel.caption.uppercased())
        .font(.system(size: 10, weight: .semibold))
        .tracking(1.2)
        .foregroundStyle(Tokens.color(palette.ink))
        .accessibilityAddTraits(.isHeader)
      VStack(alignment: .leading, spacing: 0) {
        ForEach(Array(panel.lines.enumerated()), id: \.offset) { index, line in
          MeterRowView(
            scope: line.scope, row: line.row, evidence: line.evidence, live: line.live, note: line.note,
            palette: palette)
          if index < panel.lines.count - 1 {
            Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.2)).frame(height: 1).accessibilityHidden(true)
          }
        }
        MeterRowView(
          scope: .all, row: panel.global, evidence: panel.globalEvidence, live: panel.globalSynced,
          note: panel.globalNote, palette: palette)
      }
      .padding(14)
      .background(RoundedRectangle(cornerRadius: 8).fill(Tokens.color(palette.layer1)))
      .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
    }
  }
}
