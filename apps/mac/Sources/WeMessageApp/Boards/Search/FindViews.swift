import SwiftUI
import WeMessageKit

/// 11.C: find in the open thread, cmd-F. It searches the turns the thread
/// has loaded and says so; it starts at the newest match (D-UI-85). Down
/// steps to an older match, up to a newer one, wrapping; Esc closes. The
/// current match is outlined 3 pt in the transcript, the others 1 pt.
struct FindBar: View {
  let model: ShellModel
  @Bindable var find: FindBarModel
  let palette: Tokens.Palette

  var body: some View {
    HStack(spacing: 8) {
      Text("Find")
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
      TextField("", text: $find.text, prompt: Text("in this thread"))
        .textFieldStyle(.plain)
        .font(.system(size: 12))
        .foregroundStyle(Tokens.color(palette.ink))
        .padding(.vertical, 4)
        .padding(.horizontal, 8)
        .background(RoundedRectangle(cornerRadius: 6).fill(Tokens.color(palette.layer1)))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
        .frame(maxWidth: 260)
        .background(FieldClaim(token: find.shown ? "find" : nil))
        .onKeyPress(.upArrow, phases: [.down, .repeat]) { press in
          guard !press.modifiers.contains(.command) else { return Board11Keys.route(press, model: model) }
          find.step(-1)
          return .handled
        }
        .onKeyPress(.downArrow, phases: [.down, .repeat]) { press in
          guard !press.modifiers.contains(.command) else { return Board11Keys.route(press, model: model) }
          find.step(1)
          return .handled
        }
        .onKeyPress(phases: .down) { press in Board11Keys.route(press, model: model) }
        .onKeyPress(.escape) {
          model.escapeBoard11()
          return .handled
        }
        .accessibilityLabel("Find in this thread")
        .accessibilityIdentifier(ShellID.findField)
      // Ink, not inkDim: "2 of 4" in 10 pt dim drew one full-ink pixel
      // on the 1x runner (run 37756434645).
      Text(find.counter)
        .font(.system(size: 11, weight: .semibold, design: .monospaced))
        .foregroundStyle(Tokens.color(palette.ink))
        .lineLimit(1)
        .fixedSize()
        .accessibilityLabel(find.counter.isEmpty ? "No search" : find.counter)
        .accessibilityIdentifier(ShellID.findCounter)
      Spacer(minLength: 8)
      step("\u{2191} newer", "Newer match") { find.step(-1) }
      step("\u{2193} older", "Older match") { find.step(1) }
      step("Done", "Close find") { model.closeFind() }
    }
    .padding(.vertical, 6)
    .padding(.horizontal, 12)
    .overlay(alignment: .bottom) {
      Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.25)).frame(height: 0.5)
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Find in thread")
    .accessibilityIdentifier(ShellID.findBar)
  }

  private func step(_ title: String, _ spoken: String, _ action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Text(title)
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
        .padding(.vertical, 3)
        .padding(.horizontal, 8)
        .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(Tokens.color(palette.inkDim, opacity: 0.6), lineWidth: 1))
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .focusable()
    .accessibilityLabel(spoken)
  }
}

/// 11.F: the year scrubber beside the open thread (D-UI-83), opt-cmd-G or
/// after a jump. Newest year first; a year with nothing in it stays, muted.
/// Choosing a year lands on its first message, outlined; opt-cmd-up and
/// opt-cmd-down step a year. The line under it says what is loaded and how
/// much is older.
struct YearScrubberView: View {
  let model: ShellModel
  let palette: Tokens.Palette

  var body: some View {
    let scrubber = model.scrubber
    VStack(alignment: .leading, spacing: 4) {
      Text("YEARS")
        .font(.system(size: 9, weight: .semibold))
        .tracking(1.2)
        .foregroundStyle(Tokens.color(palette.inkDim))
        .accessibilityAddTraits(.isHeader)
      ForEach(scrubber.years) { year in
        YearRow(year: year, current: model.scrubberYear == year.year, palette: palette) {
          model.jump(toYear: year.year)
        }
      }
      if let viewing = model.scrubberYear {
        Text(scrubber.line(viewing: viewing))
          .font(.system(size: 9))
          .foregroundStyle(Tokens.color(palette.inkDim))
          .fixedSize(horizontal: false, vertical: true)
          .padding(.top, 6)
          .accessibilityIdentifier(ShellID.scrubberLine)
      }
      Text("\u{2325}\u{2318}\u{2191}\u{2193} a year")
        .font(.system(size: 9))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .padding(.top, 2)
        .accessibilityHidden(true)
      Spacer(minLength: 0)
    }
    .padding(10)
    .frame(width: 128)
    .frame(maxHeight: .infinity, alignment: .top)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Years")
    .accessibilityIdentifier(ShellID.scrubber)
  }
}

struct YearRow: View {
  let year: YearScrubber.Year
  let current: Bool
  let palette: Tokens.Palette
  let choose: () -> Void

  private var spoken: String {
    let noun = year.count == 1 ? "message" : "messages"
    let count = year.isEmpty ? "no messages" : "\(year.count) \(noun)"
    return "\(year.year), \(count)"
  }

  private var state: String {
    if current { return "viewing" }
    return year.isEmpty ? "empty" : ""
  }

  private var identifier: String { ShellID.scrubberYearPrefix + String(year.year) }

  private var ink: Color {
    year.isEmpty ? Tokens.color(palette.inkDim, opacity: 0.6) : Tokens.color(palette.ink)
  }

  var body: some View {
    Button(action: choose) {
      HStack(spacing: 6) {
        Group {
          if current {
            RoundedRectangle(cornerRadius: 1).fill(Tokens.color(palette.ink))
          } else {
            RoundedRectangle(cornerRadius: 1).strokeBorder(ink, lineWidth: 1)
          }
        }
        .frame(width: 7, height: 7)
        Text(String(year.year))
          .font(.system(size: 11, weight: current ? .bold : .regular, design: .monospaced))
          .foregroundStyle(ink)
        Spacer(minLength: 4)
        Text(year.isEmpty ? ProvisionalUI.scrubberEmptyCount : SearchText.grouped(year.count))
          .font(.system(size: 9, design: .monospaced))
          .italic(year.isEmpty)
          .foregroundStyle(year.isEmpty ? ink : Tokens.color(palette.inkDim))
      }
      .padding(.vertical, 3)
      .padding(.horizontal, 4)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .focusable()
    .accessibilityElement(children: .ignore)
    .accessibilityAddTraits(.isButton)
    .accessibilityLabel(spoken)
    .accessibilityValue(state)
    .accessibilityAction { choose() }
    .accessibilityIdentifier(identifier)
  }
}
