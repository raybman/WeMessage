import SwiftUI
import WeMessageKit

/// The streak's ribbon (17.C): one cell per day, oldest first, each in its
/// own mark and never a mark without its word, so the key under it spells
/// all five out. Cleared is filled; nothing arrived is a thin grey border;
/// not opened is dashed; opened and left unclear is a heavy border with a
/// slash; a degraded day is dotted (D-UI-124). One image to a screen
/// reader, labelled day by day.
struct StreakRibbon: View {
  let labels: [Int]
  let days: [Day]
  let palette: Tokens.Palette

  static let cell: CGFloat = 20

  /// The day's word, as the key and the screen reader say it.
  static func word(_ day: Day) -> String {
    switch day {
    case .cleared: "cleared"
    case .nothingArrived: "nothing arrived"
    case .notOpened: "app not opened"
    case .leftUnclear: "opened, left unclear"
    case .degraded: "a source was stale all day"
    }
  }

  static let keyOrder: [Day] = [.cleared, .nothingArrived, .notOpened, .leftUnclear, .degraded]

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 3) {
        ForEach(Array(days.enumerated()), id: \.offset) { index, day in
          DayCell(day: day, label: index < labels.count ? String(labels[index]) : "", palette: palette)
        }
      }
      .accessibilityElement(children: .ignore)
      .accessibilityAddTraits(.isImage)
      .accessibilityLabel(spoken)
      .accessibilityIdentifier(ShellID.streakRibbon)
      HStack(spacing: 14) {
        ForEach(Self.keyOrder, id: \.self) { day in
          HStack(spacing: 5) {
            DayCell(day: day, label: "", palette: palette)
              .scaleEffect(0.8)
              .frame(width: Self.cell * 0.8, height: Self.cell * 0.8)
            Text(Self.word(day))
              .font(.system(size: 11))
              .foregroundStyle(Tokens.color(palette.inkDim))
          }
        }
      }
      .accessibilityElement(children: .ignore)
      .accessibilityAddTraits(.isStaticText)
      .accessibilityLabel("Key: " + Self.keyOrder.map(Self.word).joined(separator: "; "))
    }
  }

  private var spoken: String {
    days.enumerated().map { index, day in
      (index < labels.count ? "Sep \(labels[index]) " : "") + Self.word(day)
    }.joined(separator: "; ")
  }
}

/// One day's cell.
private struct DayCell: View {
  let day: Day
  let label: String
  let palette: Tokens.Palette

  private var side: CGFloat { StreakRibbon.cell }

  var body: some View {
    ZStack {
      Rectangle().fill(Tokens.color(day == .cleared ? palette.ink : palette.layer1))
      border
      if day == .leftUnclear {
        Rectangle()
          .fill(Tokens.color(palette.ink))
          .frame(width: side * 1.3, height: 2)
          .rotationEffect(.degrees(-45))
      } else {
        Text(label)
          .font(.system(size: 8, weight: .bold, design: .monospaced))
          .foregroundStyle(Tokens.color(day == .cleared ? palette.layer1 : palette.inkDim))
      }
    }
    .frame(width: side, height: side)
  }

  @ViewBuilder
  private var border: some View {
    switch day {
    case .cleared:
      Rectangle().strokeBorder(Tokens.color(palette.ink), lineWidth: 1)
    case .nothingArrived:
      Rectangle().strokeBorder(Tokens.color(palette.inkDim, opacity: 0.45), lineWidth: 1)
    case .notOpened:
      Rectangle().strokeBorder(Tokens.color(palette.inkDim), style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
    case .leftUnclear:
      Rectangle().strokeBorder(Tokens.color(palette.ink), lineWidth: 2)
    case .degraded:
      Rectangle().strokeBorder(Tokens.color(palette.inkDim), style: StrokeStyle(lineWidth: 1.5, dash: [1, 2]))
    }
  }
}

/// The streak block (17.C): the ribbon, the two runs (current and longest,
/// which never resets), and the evidence in words. The run is computed by
/// ProgressRules from the days (D-UI-125); nothing here types a number.
struct StreakPanelView: View {
  let panel: StreakPanel
  let palette: Tokens.Palette

  var body: some View {
    let streak = panel.streak
    VStack(alignment: .leading, spacing: 12) {
      Text(panel.caption.uppercased())
        .font(.system(size: 10, weight: .semibold))
        .tracking(1.2)
        .foregroundStyle(Tokens.color(palette.ink))
        .accessibilityAddTraits(.isHeader)
      StreakRibbon(labels: panel.labels, days: panel.days, palette: palette)
      HStack(alignment: .top, spacing: 40) {
        run(days: streak.current, words: panel.currentSince, id: ShellID.streakCurrent, name: "Current run")
        run(days: streak.longest, words: panel.longestSpan, id: ShellID.streakLongest, name: "Longest run")
      }
      Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.35)).frame(height: 1).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 4) {
        if !panel.broken {
          line("Cleared \(streak.current) days in a row.", bold: true)
        }
        ForEach(panel.evidence, id: \.self) { words in
          line(words, bold: false)
        }
        if panel.broken, let ended = streak.runBeforeBreak {
          line("The run ended at \(ended) days.", bold: true)
        }
      }
    }
    .padding(16)
    .frame(maxWidth: 580, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 8).fill(Tokens.color(palette.layer1)))
    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Streak: \(streak.current) days, longest \(streak.longest)")
    .accessibilityIdentifier(ShellID.streak)
  }

  private func run(days: Int, words: String, id: String, name: String) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text("\(days) days")
        .font(.system(size: 26, weight: .bold, design: .monospaced))
        .foregroundStyle(Tokens.color(palette.ink))
      Text(words)
        .font(.system(size: 11))
        .foregroundStyle(Tokens.color(palette.inkDim))
    }
    .accessibilityElement(children: .ignore)
    .accessibilityAddTraits(.isStaticText)
    .accessibilityLabel("\(name): \(days) days. \(words)")
    .accessibilityIdentifier(id)
  }

  private func line(_ words: String, bold: Bool) -> some View {
    Text(words)
      .font(.system(size: 11, weight: bold ? .semibold : .regular))
      .foregroundStyle(Tokens.color(bold ? palette.ink : palette.inkDim))
      .fixedSize(horizontal: false, vertical: true)
  }
}
