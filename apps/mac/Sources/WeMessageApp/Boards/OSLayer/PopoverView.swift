import SwiftUI
import WeMessageKit

/// v2 S4l, board 16.B, 16.C and 16.H: the menu bar extra's popover, 360 by
/// 480. A vibrant 76 pt header with the dated counter (or "Cannot say"), up
/// to four rows that never scroll, and a fixed footer: Open WeMessage, Kill
/// switch..., Settings. No Approve, no Reply, no draft text: the popover
/// says a draft exists and shows the inbound line it answers.
struct PopoverView: View {
  static let width: Double = 360
  static let height: Double = 480
  static let headerHeight: Double = 76

  let content: PopoverContent
  let palette: Tokens.Palette
  let mirror: AccessibilityMirror
  let dark: Bool
  /// Shows the kill confirm in place of the body (16.H).
  var confirming = false
  /// Everything waiting, for the degraded "N held" line.
  var held = 0
  /// Pending drafts, for the confirm's Holds line.
  var drafts = 0
  var onVerb: (PopoverVerb, PopoverEntry) -> Void = { _, _ in }
  var onOpenApp: () -> Void = {}
  var onKill: () -> Void = {}
  var onEngage: () -> Void = {}
  var onCancel: () -> Void = {}
  var onSettings: () -> Void = {}
  var onRelink: () -> Void = {}
  var onVerify: () -> Void = {}

  private var ink: Color { Tokens.color(palette.ink) }
  private var dim: Color { Tokens.color(palette.inkDim) }

  var body: some View {
    VStack(spacing: 0) {
      header
      Hairline(mirror: mirror, palette: palette, dark: dark, horizontal: true)
      Group {
        if confirming {
          KillConfirmView(held: drafts, palette: palette, onEngage: onEngage, onCancel: onCancel)
            .padding(14)
        } else {
          bodyContent
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      Hairline(mirror: mirror, palette: palette, dark: dark, horizontal: true)
      footer
    }
    .frame(width: Self.width, height: Self.height)
    .background(Tokens.color(palette.layer1))
    .accessibilityElement(children: .contain)
    .accessibilityLabel(Self.modeWord(content.mode) + (confirming ? " confirm" : ""))
    .accessibilityIdentifier(ShellID.popover)
  }

  static func modeWord(_ mode: PopoverContent.Mode) -> String {
    switch mode {
    case .healthy: "healthy"
    case .degraded: "degraded"
    case .killed: "killed"
    case .disconnected: "disconnected"
    }
  }

  // MARK: header

  private var header: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .firstTextBaseline) {
        Text(content.title)
          .font(.system(size: 22, weight: .semibold))
          .foregroundStyle(ink)
          .accessibilityIdentifier(ShellID.popoverTitle)
        Spacer(minLength: 8)
        Text(content.stamp)
          .font(.system(size: 11, weight: .semibold, design: .monospaced))
          .foregroundStyle(dim)
          .accessibilityIdentifier(ShellID.popoverStamp)
      }
      Text(content.line)
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(dim)
        .lineLimit(2)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier(ShellID.popoverLine)
    }
    .padding(.horizontal, 14)
    .frame(height: Self.headerHeight)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(headerFill)
  }

  /// Vibrant over the desktop; the opaque layer with Reduce Transparency.
  @ViewBuilder
  private var headerFill: some View {
    if mirror.reduceTransparency {
      Rectangle().fill(Tokens.color(palette.layer2)).accessibilityHidden(true)
    } else {
      Rectangle().fill(.regularMaterial).accessibilityHidden(true)
    }
  }

  // MARK: body

  @ViewBuilder
  private var bodyContent: some View {
    switch content.mode {
    case .healthy:
      VStack(alignment: .leading, spacing: 0) {
        ForEach(content.rows, id: \.entry.id) { row in
          PopoverRow(row: row, palette: palette, onVerb: onVerb)
          Hairline(mirror: mirror, palette: palette, dark: dark, horizontal: true)
        }
        if let more = content.more {
          Text(more + " This list does not scroll.")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(dim)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .accessibilityIdentifier(ShellID.popoverMore)
        }
        if content.rows.isEmpty {
          Text("Nothing waiting.")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(ink)
            .padding(14)
        }
      }
    case .degraded:
      VStack(alignment: .leading, spacing: 10) {
        VStack(alignment: .leading, spacing: 4) {
          ForEach(content.sources, id: \.channel) { source in
            HStack(spacing: 8) {
              Text(source.channel.uppercased())
                .font(.system(size: 10, weight: .semibold))
                .tracking(0.8)
                .foregroundStyle(ink)
                .frame(width: 84, alignment: .leading)
              Text(source.live ? "live" : "STALE")
                .font(.system(size: 10, weight: source.live ? .semibold : .bold))
                .foregroundStyle(source.live ? dim : ink)
              Text("\u{00B7} " + source.age)
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .foregroundStyle(dim)
              Spacer(minLength: 0)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(source.printed)
            .accessibilityIdentifier(ShellID.popoverSourcePrefix + source.channel.lowercased())
          }
        }
        notes
        HStack(spacing: 8) {
          footerButton("Re-link WhatsApp", id: nil, action: onRelink)
          footerButton("Verify now", id: nil, action: onVerify)
          Spacer(minLength: 0)
          Text("\(held) held")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(dim)
        }
      }
      .padding(14)
    case .killed, .disconnected:
      VStack(alignment: .leading, spacing: 10) {
        notes
      }
      .padding(14)
    }
  }

  private var notes: some View {
    VStack(alignment: .leading, spacing: 6) {
      ForEach(Array(content.notes.enumerated()), id: \.offset) { index, note in
        Text(note)
          .font(.system(size: index == 0 ? 12 : 11, weight: .semibold))
          .foregroundStyle(index == 0 ? ink : dim)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(content.notes.joined(separator: " "))
    .accessibilityIdentifier(ShellID.popoverNotes)
  }

  // MARK: footer

  private var footer: some View {
    HStack(spacing: 8) {
      footerButton("Open WeMessage", id: ShellID.popoverOpen, action: onOpenApp)
      footerButton("Kill switch\u{2026}", id: ShellID.popoverKill, action: onKill)
      Spacer(minLength: 0)
      Button(action: onSettings) {
        HStack(spacing: 4) {
          Text("Settings")
            .font(.system(size: 12, weight: .semibold))
          Image(systemName: "gearshape")
            .font(.system(size: 12, weight: .semibold))
            .accessibilityHidden(true)
        }
        .foregroundStyle(ink)
        .padding(.vertical, 4)
        .padding(.horizontal, 8)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Settings")
      .accessibilityIdentifier(ShellID.popoverSettings)
    }
    .padding(.horizontal, 10)
    .frame(height: 44)
  }

  private func footerButton(_ title: String, id: String?, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Text(title)
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(ink)
        .padding(.vertical, 4)
        .padding(.horizontal, 10)
        .background(Capsule().fill(Tokens.color(palette.layer2)))
        .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(title)
    .accessibilityIdentifier(id ?? "")
  }
}

/// One waiting thing: the person, the channel, the inbound line, why it is
/// here, and the verbs this row may take.
struct PopoverRow: View {
  let row: PopoverContent.Row
  let palette: Tokens.Palette
  let onVerb: (PopoverVerb, PopoverEntry) -> Void

  private var entry: PopoverEntry { row.entry }

  var body: some View {
    HStack(spacing: 0) {
      // A draft is marked by the tint bar, the one accent (no green).
      Rectangle()
        .fill(entry.kind == .draft ? Tokens.color(Tokens.tint) : Color.clear)
        .frame(width: 3)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 6) {
          Text(entry.name)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(Tokens.color(palette.ink))
            .lineLimit(1)
          Text(ProvisionalUI.railShortLabels[entry.channel] ?? entry.channel)
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(Tokens.color(palette.inkDim))
          Spacer(minLength: 4)
          Text(ShellText.shortClock(entry.arrivedAt))
            .font(.system(size: 10, weight: .semibold, design: .monospaced))
            .foregroundStyle(Tokens.color(palette.inkDim))
        }
        Text(entry.preview)
          .font(.system(size: 12))
          .foregroundStyle(Tokens.color(palette.ink))
          .lineLimit(1)
        HStack(spacing: 6) {
          Text(entry.reason)
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(Tokens.color(palette.inkDim))
          Spacer(minLength: 4)
          ForEach(row.verbs, id: \.self) { verb in
            Button {
              onVerb(verb, entry)
            } label: {
              Text("\(Text(verb.title).font(.system(size: 10, weight: .semibold))) \(Text(verb.hint).font(.system(size: 10, weight: .semibold, design: .monospaced)))")
                .foregroundStyle(Tokens.color(palette.ink))
                .padding(.vertical, 2)
                .padding(.horizontal, 6)
                .background(Capsule().fill(Tokens.color(palette.layer2)))
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(verb.title)
          }
        }
      }
      .padding(.horizontal, 11)
      .padding(.vertical, 8)
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("\(entry.name), \(entry.reason)")
    .accessibilityIdentifier(ShellID.popoverRowPrefix + entry.id)
  }
}

/// 16.H: what engaging does, in four facts, then Engage or Cancel. Release
/// is in the app, never here.
struct KillConfirmView: View {
  let held: Int
  let palette: Tokens.Palette
  let onEngage: () -> Void
  let onCancel: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(KillConfirmText.title)
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
      VStack(alignment: .leading, spacing: 8) {
        ForEach(KillConfirmText.facts(held: held), id: \.label) { fact in
          HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(fact.label.uppercased())
              .font(.system(size: 10, weight: .semibold))
              .tracking(0.8)
              .foregroundStyle(Tokens.color(palette.inkDim))
              .frame(width: 52, alignment: .leading)
            Text(fact.text)
              .font(.system(size: 12, weight: .medium))
              .foregroundStyle(Tokens.color(palette.ink))
              .fixedSize(horizontal: false, vertical: true)
          }
          .accessibilityElement(children: .combine)
        }
      }
      HStack(spacing: 8) {
        Text(KillConfirmText.releaseNote)
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.inkDim))
        Spacer(minLength: 8)
        Button(action: onCancel) {
          Text("\(Text(KillConfirmText.cancel).font(.system(size: 12, weight: .semibold))) \(Text("Esc").font(.system(size: 10, weight: .semibold, design: .monospaced)))")
            .foregroundStyle(Tokens.color(palette.ink))
            .padding(.vertical, 5)
            .padding(.horizontal, 10)
            .background(Capsule().fill(Tokens.color(palette.layer2)))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(KillConfirmText.cancel)
        .accessibilityIdentifier(ShellID.killConfirmCancel)
        // Engage is never the default button: Return does not engage.
        Button(action: onEngage) {
          Text(KillConfirmText.engage)
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(Tokens.color(palette.ink))
            .padding(.vertical, 5)
            .padding(.horizontal, 12)
            .background(Capsule().fill(Tokens.color(palette.layer1)))
            .overlay(Capsule().strokeBorder(Tokens.color(palette.ink), lineWidth: 2))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(KillConfirmText.engage)
        .accessibilityIdentifier(ShellID.killConfirmEngage)
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(KillConfirmText.title)
    .accessibilityIdentifier(ShellID.killConfirm)
    // Esc cancels; nothing binds Return, so Return never engages.
    .onExitCommand(perform: onCancel)
  }
}

/// The extra's glyph (16.A, D-UI-120): the symbol, a diagonal stroke for
/// the kill switch, the badge as text beside it, and reduced alpha when
/// disconnected. The status item renders this same view.
struct StatusGlyphView: View {
  let glyph: StatusGlyph
  let ink: Color
  var size: Double = 14

  var body: some View {
    HStack(spacing: size * 0.15) {
      Image(systemName: ProvisionalUI.statusSymbol)
        .font(.system(size: size, weight: .semibold))
        .overlay {
          if glyph.slashed {
            GeometryReader { box in
              Path { path in
                path.move(to: CGPoint(x: 0, y: box.size.height))
                path.addLine(to: CGPoint(x: box.size.width, y: 0))
              }
              .stroke(ink, style: StrokeStyle(lineWidth: max(1.5, size * 0.12), lineCap: .round))
            }
          }
        }
        .accessibilityHidden(true)
      switch glyph.badge {
      case .none: EmptyView()
      case .count(let text):
        Text(text).font(.system(size: size * 0.86, weight: .bold, design: .rounded))
      case .cannotSay:
        Text("!").font(.system(size: size * 0.86, weight: .heavy, design: .rounded))
      }
    }
    .foregroundStyle(ink)
    .opacity(glyph.reducedAlpha ? ProvisionalUI.statusDisconnectedAlpha : 1)
  }
}
