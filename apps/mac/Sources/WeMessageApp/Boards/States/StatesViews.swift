import SwiftUI
import WeMessageKit

// v2 S4h, board 10: the states that decide whether a user trusts the app.
// Ink and the grey family carry every state; the tint marks only where to
// act. No system colour is named here (H-S4-6).

/// The trust banner (10.A): which channel is stale and since when, in
/// words, and its one action, which pins the per-channel ages (D-UI-59).
/// Exactly the kill banner's height, so the banner layout's frost patch
/// sits on bare pane under it.
struct TrustBannerView: View {
  @Bindable var model: ShellModel
  let line: String
  let palette: Tokens.Palette

  var body: some View {
    HStack(spacing: 10) {
      Text("!")
        .font(.system(size: 10, weight: .bold))
        .foregroundStyle(Tokens.color(palette.layer1))
        .frame(width: 16, height: 16)
        .background(Circle().fill(Tokens.color(palette.ink)))
        .accessibilityHidden(true)
      Text(line)
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
        .lineLimit(1)
        .truncationMode(.tail)
      Button {
        model.freshnessPinned.toggle()
      } label: {
        Text(ProvisionalUI.trustBannerAction)
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.ink))
          .underline()
          .padding(.vertical, 3)
          .padding(.horizontal, 6)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .focusable()
      .accessibilityLabel(ProvisionalUI.trustBannerAction)
      .accessibilityValue(model.freshnessPinned ? "open" : "closed")
      .accessibilityIdentifier(ShellID.trustAction)
      Spacer(minLength: 8)
    }
    .padding(.horizontal, 12)
    .frame(height: KillBanner.height)
    .frame(maxWidth: .infinity)
    .background(Tokens.color(palette.layer1))
    .overlay(alignment: .leading) { Rectangle().fill(Tokens.color(Tokens.tint)).frame(width: 3).accessibilityHidden(true) }
    .overlay(alignment: .bottom) {
      Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.35)).frame(height: 0.5).accessibilityHidden(true)
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(line)
    .accessibilityIdentifier(ShellID.trustBanner)
  }
}

/// The per-channel age table (10.A): one row per channel, monospaced, the
/// foot the clock it was computed at or CANNOT SAY. A channel that is not
/// connected says so and shows no number. The same view is the rail's
/// popover and the Settings copy (D-UI-61, D-UI-68).
struct FreshnessTable: View {
  let rows: [FreshnessRow]
  let palette: Tokens.Palette
  var zone: TimeZone = .current

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("PER-CHANNEL AGES")
        .font(.system(size: 9, weight: .semibold))
        .tracking(1.2)
        .foregroundStyle(Tokens.color(palette.inkDim))
      ForEach(rows, id: \.scope) { row in
        HStack(spacing: 12) {
          Text(row.name)
            .frame(width: 84, alignment: .leading)
          Text(row.age(zone: zone))
            .fontWeight(row.state == .notConnected ? .regular : .semibold)
            .frame(width: 170, alignment: .leading)
          Text(row.count)
            .frame(minWidth: 70, alignment: .trailing)
        }
        .font(.system(size: 11, design: .monospaced))
        .foregroundStyle(Tokens.color(row.state == .notConnected ? palette.inkDim : palette.ink))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.sentence(zone: zone))
        .accessibilityValue(row.sentence(zone: zone))
        .accessibilityIdentifier(ShellID.freshnessRowPrefix + row.scope.rawValue)
      }
      Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.35)).frame(height: 0.5).accessibilityHidden(true)
      if let footer = Freshness.footer(rows, zone: zone) {
        Text(footer)
          .font(.system(size: 11, weight: .bold, design: .monospaced))
          .foregroundStyle(Tokens.color(palette.ink))
          .accessibilityLabel(footer)
          .accessibilityValue(footer)
          .accessibilityIdentifier(ShellID.freshnessFooter)
      }
    }
    .padding(14)
    .background(RoundedRectangle(cornerRadius: 8).fill(Tokens.color(palette.layer1)))
    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Tokens.color(palette.inkDim, opacity: 0.35), lineWidth: 1))
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Per-channel ages")
    .accessibilityIdentifier(ShellID.freshness)
  }
}

/// Lost access while running (10.C): the banner, the history still
/// readable up to the last scan this window saw (D-UI-65), and Fix, which
/// opens the FDA screen. Nothing reaches the daemon.
struct RevokedBanner: View {
  @Bindable var model: ShellModel
  let lastReadable: Date
  let palette: Tokens.Palette

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 10) {
        Text("\u{25B2} " + FDACopy.revokedLine)
          .font(.system(size: 11, weight: .bold))
          .foregroundStyle(Tokens.color(palette.layer1))
          .lineLimit(1)
          .truncationMode(.tail)
        Spacer(minLength: 8)
        Button {
          model.fdaScreenShown = true
        } label: {
          Text("Fix")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(Tokens.color(palette.ink))
            .padding(.vertical, 3)
            .padding(.horizontal, 12)
            .background(Capsule().fill(Tokens.color(palette.layer1)))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .focusable()
        .accessibilityLabel("Fix")
        .accessibilityIdentifier(ShellID.revokedFix)
      }
      .padding(.horizontal, 12)
      .frame(height: KillBanner.height)
      .background(Tokens.color(palette.ink))
      Text(FDACopy.revokedDetail(lastReadable))
        .font(.system(size: 11))
        .foregroundStyle(Tokens.color(palette.ink))
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Tokens.color(palette.layer1))
    }
    .frame(maxWidth: .infinity)
    .accessibilityElement(children: .contain)
    .accessibilityLabel(FDACopy.revokedLine)
    .accessibilityIdentifier(ShellID.revokedBanner)
  }
}

/// Full Disk Access required (10.C): the step, the title, the four
/// headings and what each says, Open System Settings and Skip. Open asks
/// the seam and nothing else: under the UI-test flag that is a count.
struct FDAScreen: View {
  @Bindable var model: ShellModel
  let palette: Tokens.Palette

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        Text(FDACopy.step.uppercased())
          .font(.system(size: 9, weight: .semibold))
          .tracking(1.2)
          .foregroundStyle(Tokens.color(palette.inkDim))
        HStack(spacing: 10) {
          Rectangle().fill(Tokens.color(Tokens.tint)).frame(width: 4, height: 22).accessibilityHidden(true)
          Text(FDACopy.title)
            .font(.system(size: 18, weight: .bold))
            .foregroundStyle(Tokens.color(palette.ink))
            .accessibilityAddTraits(.isHeader)
        }
        ForEach(Array(FDACopy.headings.enumerated()), id: \.offset) { index, heading in
          VStack(alignment: .leading, spacing: 4) {
            Text(heading)
              .font(.system(size: 12, weight: .bold))
              .foregroundStyle(Tokens.color(palette.ink))
              .accessibilityAddTraits(.isHeader)
            Text(FDACopy.bodies[index])
              .font(.system(size: 12))
              .foregroundStyle(Tokens.color(palette.ink))
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        HStack(spacing: 10) {
          Button {
            model.openFullDiskAccess()
          } label: {
            Text(FDACopy.open)
              .font(.system(size: 12, weight: .semibold))
              .foregroundStyle(Tokens.color(palette.layer1))
              .padding(.vertical, 6)
              .padding(.horizontal, 12)
              .background(RoundedRectangle(cornerRadius: 6).fill(Tokens.color(palette.ink)))
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .focusable()
          .accessibilityLabel(FDACopy.open)
          .accessibilityValue("asked \(model.fdaAsked)")
          .accessibilityIdentifier(ShellID.fdaOpen)
          Button {
            model.fdaSkipped = true
            model.fdaScreenShown = false
          } label: {
            Text(FDACopy.skip)
              .font(.system(size: 12, weight: .semibold))
              .foregroundStyle(Tokens.color(palette.ink))
              .padding(.vertical, 6)
              .padding(.horizontal, 12)
              .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Tokens.color(palette.inkDim, opacity: 0.6), lineWidth: 1))
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .focusable()
          .accessibilityLabel(FDACopy.skip)
          .accessibilityIdentifier(ShellID.fdaSkip)
        }
        .padding(.top, 4)
      }
      .padding(20)
      .frame(maxWidth: 540, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: 10).fill(Tokens.color(palette.layer1)))
      .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Tokens.color(palette.inkDim, opacity: 0.35), lineWidth: 1))
      .padding(20)
      .frame(maxWidth: .infinity)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityElement(children: .contain)
    .accessibilityLabel(FDACopy.title)
    .accessibilityIdentifier(ShellID.fda)
  }
}

/// One empty (10.B): the glyph, what happened, why, the dated line when
/// it carries numbers, and exactly one action. The action is drawn and
/// announced; on the sheet it changes nothing.
struct EmptyStateView: View {
  let copy: EmptyStateCopy
  let palette: Tokens.Palette

  var body: some View {
    VStack(spacing: 8) {
      Text(copy.glyph)
        .font(.system(size: copy.kind == .inboxZero ? 44 : 22, weight: .bold))
        .foregroundStyle(Tokens.color(palette.ink))
        .frame(width: 56, height: 56)
        .background {
          if copy.kind != .inboxZero {
            RoundedRectangle(cornerRadius: 10).strokeBorder(Tokens.color(palette.inkDim, opacity: 0.45), lineWidth: 1)
          }
        }
        .accessibilityHidden(true)
      Text(copy.headline)
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
        .multilineTextAlignment(.center)
        .accessibilityAddTraits(.isHeader)
      Text(copy.detail)
        .font(.system(size: 11))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
      if let dated = copy.dated {
        Text(dated)
          .font(.system(size: 10, weight: .semibold, design: .monospaced))
          .foregroundStyle(Tokens.color(palette.ink))
      }
      ForEach(copy.actions, id: \.slug) { action in
        Button {
        } label: {
          Text(action.label)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(Tokens.color(palette.ink))
            .padding(.vertical, 4)
            .padding(.horizontal, 12)
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .focusable()
        .accessibilityLabel(action.label)
        .accessibilityIdentifier(ShellID.emptyPrefix + copy.kind.rawValue + ".action")
      }
    }
    .padding(16)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(RoundedRectangle(cornerRadius: 10).fill(Tokens.color(palette.layer1)))
    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Tokens.color(palette.inkDim, opacity: 0.35), lineWidth: 1))
    .accessibilityElement(children: .contain)
    .accessibilityLabel(copy.headline)
    .accessibilityIdentifier(ShellID.emptyPrefix + copy.kind.rawValue)
  }
}

/// The pacing table (10.D), iMessage's rows only (D-UI-66), and its foot.
struct PacingTable: View {
  let rows: [PacingRow]
  let footer: String
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("CHANNEL PACING")
        .font(.system(size: 9, weight: .semibold))
        .tracking(1.2)
        .foregroundStyle(Tokens.color(palette.inkDim))
      HStack(spacing: 12) {
        Text("CHANNEL").frame(width: 84, alignment: .leading)
        Text("ACTION").frame(width: 60, alignment: .leading)
        Text("PACE").frame(width: 170, alignment: .leading)
        Text("TODAY").frame(minWidth: 70, alignment: .trailing)
      }
      .font(.system(size: 9, weight: .semibold))
      .foregroundStyle(Tokens.color(palette.inkDim))
      .accessibilityHidden(true)
      ForEach(rows, id: \.action) { row in
        HStack(spacing: 12) {
          Text(row.channel).fontWeight(.semibold).frame(width: 84, alignment: .leading)
          Text(row.action).frame(width: 60, alignment: .leading)
          Text(row.pace).frame(width: 170, alignment: .leading)
          Text(row.today).frame(minWidth: 70, alignment: .trailing)
        }
        .font(.system(size: 11))
        .foregroundStyle(Tokens.color(palette.ink))
        .accessibilityElement(children: .combine)
      }
      Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.35)).frame(height: 0.5).accessibilityHidden(true)
      Text(footer)
        .font(.system(size: 10))
        .foregroundStyle(Tokens.color(palette.inkDim))
    }
    .padding(14)
    .background(RoundedRectangle(cornerRadius: 8).fill(Tokens.color(palette.layer1)))
    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Tokens.color(palette.inkDim, opacity: 0.35), lineWidth: 1))
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Channel pacing")
    .accessibilityIdentifier(ShellID.pacing)
  }
}

/// The agent drafted while you typed (10.E): your typing wins, and the
/// draft waits behind this notice (D-UI-67).
struct CollisionNoticeView: View {
  let agent: String
  let palette: Tokens.Palette

  var body: some View {
    HStack(spacing: 10) {
      Text("1")
        .font(.system(size: 10, weight: .bold))
        .foregroundStyle(Tokens.color(palette.layer1))
        .frame(width: 18, height: 18)
        .background(Circle().fill(Tokens.color(palette.ink)))
        .accessibilityHidden(true)
      Text(CollisionNotice.line(agent: agent))
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
      Spacer(minLength: 8)
      ForEach(CollisionNotice.actions, id: \.self) { action in
        Button {
        } label: {
          Text(action)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(Tokens.color(palette.ink))
            .padding(.vertical, 3)
            .padding(.horizontal, 10)
            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(Tokens.color(palette.inkDim, opacity: 0.6), lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .focusable()
        .accessibilityLabel(action)
      }
    }
    .padding(12)
    .background(RoundedRectangle(cornerRadius: 8).fill(Tokens.color(palette.layer1)))
    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Tokens.color(palette.inkDim, opacity: 0.35), lineWidth: 1))
    .accessibilityElement(children: .contain)
    .accessibilityLabel(CollisionNotice.line(agent: agent))
    .accessibilityIdentifier(ShellID.collision)
  }
}
