import AppKit
import SwiftUI

// v2 S4h, board 12: the onboarding window. Every control here changes the
// onboarding model and nothing else: no view on this board holds a client,
// so nothing here sends, drafts, or arms (H-S4-7). Blue and the grey inks
// only.

/// The window's root while onboarding is not spent: the six steps, then the
/// first thread with its coach row (12.I).
struct OnboardingRoot: View {
  @Bindable var model: OnboardingModel

  var body: some View {
    if model.step == .firstThread {
      ShellView(handover: model)
    } else {
      OnboardingWindow(model: model)
    }
  }
}

/// Steps 1 to 6 and setup complete (12.A to 12.G), one page at a time
/// under the app's name and the step counter.
struct OnboardingWindow: View {
  @Bindable var model: OnboardingModel
  @State private var mirror = AccessibilityMirror.live()
  @Environment(\.colorScheme) private var scheme

  private var palette: Tokens.Palette { Tokens.palette(dark: scheme == .dark) }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 10) {
        Text(OnboardingCopy.app)
          .font(.system(size: 13, weight: .bold))
          .foregroundStyle(Tokens.color(palette.ink))
          .accessibilityAddTraits(.isHeader)
        Text(OnboardingCopy.stepLine(model.step))
          .font(.system(size: 11, weight: .medium))
          .foregroundStyle(Tokens.color(palette.inkDim))
          .accessibilityIdentifier(ShellID.onboardingStep)
        Spacer(minLength: 0)
      }
      .padding(.leading, 88)
      .padding(.trailing, 20)
      .frame(height: ShellView.titleBand)
      Hairline(mirror: mirror, palette: palette, dark: scheme == .dark, horizontal: true)
      page
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
    .frame(minWidth: ProvisionalUI.windowMinWidth, minHeight: ProvisionalUI.windowMinHeight)
    .ignoresSafeArea()
    .modifier(FrostBackground(mirror: mirror, palette: palette))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier(ShellID.onboarding)
    .transaction { if TestHooks.isUITest { $0.disablesAnimations = true } }
    .task { await model.resume() }
  }

  @ViewBuilder private var page: some View {
    switch model.step {
    case .channels:
      Scroll(slug: model.step.slug) { ChannelsPage(model: model, palette: palette) }
    case .fdaAsk:
      // 10.C's screen, reused verbatim, with the onboarding step line.
      VStack(spacing: 0) {
        FDAScreen(
          asked: model.asked, palette: palette, stepLine: OnboardingCopy.setUpIMessage + " \u{00B7} " + OnboardingCopy.stepLine(.fdaAsk)
        ) {
          model.openSettings()
        } skip: {
          model.skip(.imessage)
        }
      }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier(ShellID.onboardingPagePrefix + model.step.slug)
    case .fdaWaiting:
      Scroll(slug: model.step.slug) { WaitingPage(model: model, palette: palette) }
    case .fdaSized:
      Scroll(slug: model.step.slug) { SizedPage(model: model, palette: palette) }
    case .copying:
      Scroll(slug: model.step.slug) { CopyProgressPage(model: model, palette: palette) }
    case .whatsapp:
      Scroll(slug: model.step.slug) { ChannelStepPage(model: model, channel: .whatsapp, palette: palette) }
    case .linkedin:
      Scroll(slug: model.step.slug) { ChannelStepPage(model: model, channel: .linkedin, palette: palette) }
    case .email:
      Scroll(slug: model.step.slug) { ChannelStepPage(model: model, channel: .email, palette: palette) }
    case .agent:
      Scroll(slug: model.step.slug, width: ProvisionalUI.agentPageWidth) { AgentStepPage(model: model, palette: palette) }
    case .done, .firstThread:
      Scroll(slug: OnboardingStep.done.slug) { DonePage(model: model, palette: palette) }
    }
  }
}

/// A page: scrolled, centred, at most 720 pt wide (step 6: D-UI-78),
/// identified by its slug.
private struct Scroll<Content: View>: View {
  let slug: String
  var width: Double = 720
  @ViewBuilder let content: () -> Content

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) { content() }
        .padding(24)
        .frame(maxWidth: width, alignment: .leading)
        .frame(maxWidth: .infinity)
    }
    .scrollIndicators(.never)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier(ShellID.onboardingPagePrefix + slug)
  }
}

/// The house buttons: filled tint for the one default, outlined ink for a
/// peer, and plain ink text for an escape.
private struct StepButton: View {
  enum Weight { case filled, outlined, ghost }
  let title: String
  let weight: Weight
  let palette: Tokens.Palette
  let id: String
  var value: String? = nil
  var enabled = true
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Text(title)
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(weight == .filled ? Color.white : Tokens.color(palette.ink))
        .padding(.vertical, 6)
        .padding(.horizontal, 12)
        .background {
          if weight == .filled { RoundedRectangle(cornerRadius: 6).fill(Tokens.color(Tokens.tint)) }
        }
        .overlay {
          if weight == .outlined {
            RoundedRectangle(cornerRadius: 6).strokeBorder(Tokens.color(palette.inkDim, opacity: 0.6), lineWidth: 1)
          }
        }
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .focusable()
    .disabled(!enabled)
    .opacity(enabled ? 1 : 0.4)
    .accessibilityLabel(title)
    .accessibilityValue(value ?? "")
    .accessibilityIdentifier(id)
  }
}

/// A card on the page: layer 1 with a hairline rule.
private struct Card<Content: View>: View {
  let palette: Tokens.Palette
  @ViewBuilder let content: () -> Content

  var body: some View {
    VStack(alignment: .leading, spacing: 8) { content() }
      .padding(14)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: 10).fill(Tokens.color(palette.layer1)))
      .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Tokens.color(palette.inkDim, opacity: 0.35), lineWidth: 1))
  }
}

private struct Heading: View {
  let text: String
  let palette: Tokens.Palette
  var size: CGFloat = 18

  var body: some View {
    HStack(spacing: 10) {
      Rectangle().fill(Tokens.color(Tokens.tint)).frame(width: 4, height: size + 4).accessibilityHidden(true)
      Text(text)
        .font(.system(size: size, weight: .bold))
        .foregroundStyle(Tokens.color(palette.ink))
        .accessibilityAddTraits(.isHeader)
    }
  }
}

private struct Para: View {
  let text: String
  let palette: Tokens.Palette
  var dim = false

  var body: some View {
    Text(text)
      .font(.system(size: 12))
      .foregroundStyle(Tokens.color(dim ? palette.inkDim : palette.ink))
      .fixedSize(horizontal: false, vertical: true)
  }
}

// MARK: - 12.A, step 1

private struct ChannelsPage: View {
  @Bindable var model: OnboardingModel
  let palette: Tokens.Palette

  var body: some View {
    HStack(alignment: .top, spacing: 16) {
      ForEach(Array(OnboardingCopy.pitch.enumerated()), id: \.offset) { _, pair in
        VStack(alignment: .leading, spacing: 4) {
          Text(pair.0)
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(Tokens.color(palette.ink))
            .accessibilityAddTraits(.isHeader)
          Para(text: pair.1, palette: palette)
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
      }
    }
    Grid(horizontalSpacing: 12, verticalSpacing: 12) {
      GridRow {
        ChannelCard(model: model, channel: .imessage, palette: palette)
        ChannelCard(model: model, channel: .whatsapp, palette: palette)
      }
      GridRow {
        ChannelCard(model: model, channel: .linkedin, palette: palette)
        ChannelCard(model: model, channel: .email, palette: palette)
      }
    }
    HStack(spacing: 12) {
      Para(text: OnboardingCopy.anySubset, palette: palette, dim: true)
      Spacer(minLength: 8)
      StepButton(
        title: OnboardingCopy.continueWith(model.connectedCount), weight: .outlined, palette: palette, id: ShellID.onboardingNext
      ) {
        model.continueFromChannels()
      }
    }
  }
}

/// One channel's card: its monogram, its state, its cost in its own words
/// with the bold clause, then Connect and Skip (12.A legend 1). Email's
/// Connect is the one filled button (legend 6).
private struct ChannelCard: View {
  @Bindable var model: OnboardingModel
  let channel: OnboardingChannel
  let palette: Tokens.Palette

  private var declined: Bool { model.progress.declined.contains(channel) }

  private var cost: AttributedString {
    var text = AttributedString(OnboardingCopy.cost(channel))
    if let warning = OnboardingCopy.warning(channel), let range = text.range(of: warning) {
      text[range].font = .system(size: 12, weight: .bold)
    }
    return text
  }

  var body: some View {
    Card(palette: palette) {
      HStack(spacing: 8) {
        Text(channel.monogram)
          .font(.system(size: 10, weight: .bold))
          .foregroundStyle(Tokens.color(palette.ink))
          .frame(width: 28, height: 28)
          .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Tokens.color(palette.inkDim, opacity: 0.35), lineWidth: 1))
          .accessibilityHidden(true)
        Text(channel.name)
          .font(.system(size: 13, weight: .bold))
          .foregroundStyle(Tokens.color(palette.ink))
          .accessibilityAddTraits(.isHeader)
        Spacer(minLength: 4)
        Text(declined ? OnboardingCopy.skipped : OnboardingCopy.notConnected)
          .font(.system(size: 9, weight: .semibold))
          .tracking(1)
          .foregroundStyle(Tokens.color(palette.inkDim))
      }
      Text(cost)
        .font(.system(size: 12))
        .foregroundStyle(Tokens.color(palette.ink))
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxHeight: .infinity, alignment: .topLeading)
      HStack(spacing: 8) {
        StepButton(
          title: OnboardingCopy.connect, weight: channel == .email ? .filled : .outlined, palette: palette,
          id: ShellID.onboardingConnectPrefix + channel.rawValue
        ) {
          model.connect(channel)
        }
        StepButton(
          title: OnboardingCopy.skip, weight: .ghost, palette: palette, id: ShellID.onboardingSkipPrefix + channel.rawValue,
          value: declined ? "skipped" : ""
        ) {
          model.toggleSkip(channel)
        }
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(channel.name)
    .accessibilityIdentifier(ShellID.onboardingCardPrefix + channel.rawValue)
  }
}

// MARK: - 12.B, step 2

/// 2b, the in-app half of the handoff: waiting, polling every 2 s.
private struct WaitingPage: View {
  @Bindable var model: OnboardingModel
  let palette: Tokens.Palette

  var body: some View {
    Heading(text: OnboardingCopy.setUpIMessage, palette: palette)
    Card(palette: palette) {
      Text(OnboardingCopy.waiting)
        .font(.system(size: 14, weight: .bold))
        .foregroundStyle(Tokens.color(palette.ink))
        .accessibilityAddTraits(.isHeader)
      Para(text: OnboardingCopy.waitingDetail, palette: palette)
      StepButton(
        title: OnboardingCopy.openAgain, weight: .outlined, palette: palette, id: ShellID.onboardingOpenAgain,
        value: "asked \(model.asked), probes \(model.probes), polling \(model.polling ? "on" : "off")"
      ) {
        model.openSettings()
      }
    }
  }
}

/// 2c: the copy sized before it is made (12.B legend 2).
private struct SizedPage: View {
  @Bindable var model: OnboardingModel
  let palette: Tokens.Palette

  private var rows: [(String, String)] { OnboardingCopy.sizedRows(model.sizing) }

  var body: some View {
    Heading(text: OnboardingCopy.sizedHeading(model.sizing), palette: palette)
    Card(palette: palette) {
      ForEach(rows, id: \.0) { row in
        HStack(spacing: 0) {
          Text(row.0).frame(width: 120, alignment: .leading)
          Text(row.1)
        }
        .font(.system(size: 12, design: .monospaced))
        .foregroundStyle(Tokens.color(palette.ink))
        .accessibilityElement(children: .combine)
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(rows.map { $0.0 + " " + $0.1 }.joined(separator: ", "))
    .accessibilityIdentifier(ShellID.onboardingSizing)
    Para(text: OnboardingCopy.sizedFoot, palette: palette)
    HStack(spacing: 10) {
      StepButton(
        title: OnboardingCopy.makeCopy, weight: .outlined, palette: palette, id: ShellID.onboardingNext,
        value: "probes \(model.probes), polling \(model.polling ? "on" : "off")"
      ) {
        Task { await model.makeCopy() }
      }
      StepButton(
        title: FDACopy.skip, weight: .ghost, palette: palette, id: ShellID.onboardingSkipPrefix + OnboardingChannel.imessage.rawValue
      ) {
        model.skip(.imessage)
      }
    }
  }
}

/// CopyProgress: how many are left, dated, and that the app is usable now.
private struct CopyProgressPage: View {
  @Bindable var model: OnboardingModel
  let palette: Tokens.Palette

  var body: some View {
    Heading(text: OnboardingCopy.setUpIMessage, palette: palette)
    Card(palette: palette) {
      Text(OnboardingCopy.copying.uppercased())
        .font(.system(size: 9, weight: .semibold))
        .tracking(1.2)
        .foregroundStyle(Tokens.color(palette.inkDim))
      if let p = model.copyProgress {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(OnboardingCopy.count(p.left))
            .font(.system(size: 28, weight: .bold, design: .monospaced))
            .foregroundStyle(Tokens.color(palette.ink))
          Text("LEFT")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(Tokens.color(palette.inkDim))
          Text("as of " + ShellText.clock(p.asOf))
            .font(.system(size: 11))
            .foregroundStyle(Tokens.color(palette.inkDim))
        }
        Para(text: OnboardingCopy.progressLine(p), palette: palette)
      } else {
        Para(text: ProvisionalUI.auditResultUnserved, palette: palette)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier(ShellID.onboardingProgress)
    StepButton(title: OnboardingCopy.continueLabel, weight: .outlined, palette: palette, id: ShellID.onboardingNext) {
      model.continueFromCopy()
    }
  }
}

// MARK: - 12.C to 12.E, steps 3 to 5

/// A channel this version cannot connect: its disclosure, in its own words,
/// then why nothing is asked, and its one action (D-UI-71).
private struct ChannelStepPage: View {
  @Bindable var model: OnboardingModel
  let channel: OnboardingChannel
  let palette: Tokens.Palette

  var body: some View {
    Heading(text: OnboardingCopy.setUp(channel), palette: palette)
    let disclosure = OnboardingCopy.disclosure(channel)
    Card(palette: palette) {
      Text(disclosure.0)
        .font(.system(size: 13, weight: .bold))
        .foregroundStyle(Tokens.color(palette.ink))
        .accessibilityAddTraits(.isHeader)
      Para(text: disclosure.1, palette: palette)
    }
    Para(text: OnboardingCopy.notBuilt(channel), palette: palette, dim: true)
      .accessibilityIdentifier(ShellID.onboardingNotBuilt)
    StepButton(title: OnboardingCopy.skipChannel(channel), weight: .outlined, palette: palette, id: ShellID.onboardingNext) {
      model.skip(channel)
    }
  }
}

// MARK: - 12.F, step 6

/// AgentStep: off by default and drawn selected; the invariant; KillIntro
/// and the draft specimen beside them (D-UI-78).
private struct AgentStepPage: View {
  @Bindable var model: OnboardingModel
  let palette: Tokens.Palette

  var body: some View {
    HStack(alignment: .top, spacing: 20) {
      VStack(alignment: .leading, spacing: 16) { choice }
        .frame(maxWidth: .infinity, alignment: .leading)
      VStack(alignment: .leading, spacing: 12) {
        KillIntro(palette: palette)
        DraftSpecimen(palette: palette)
      }
      .frame(width: ProvisionalUI.agentSideColumnWidth)
    }
  }

  @ViewBuilder private var choice: some View {
    Heading(text: OnboardingCopy.agentTitle, palette: palette)
    Text(OnboardingCopy.agentQuestion)
      .font(.system(size: 14, weight: .bold))
      .foregroundStyle(Tokens.color(palette.ink))
    HStack(alignment: .top, spacing: 12) {
      AgentOption(
        title: OnboardingCopy.noDrafting + " (default)", detail: OnboardingCopy.noDraftingDetail, selected: !model.progress.drafting,
        palette: palette, id: ShellID.onboardingAgentOff
      ) {
        model.setDrafting(false)
      }
      AgentOption(
        title: OnboardingCopy.draftNeverSend, detail: OnboardingCopy.draftDetail, selected: model.progress.drafting, palette: palette,
        id: ShellID.onboardingAgentDraft
      ) {
        model.setDrafting(true)
      }
    }
    HStack(spacing: 10) {
      Text(OnboardingCopy.draftOn)
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.inkDim))
      ForEach(OnboardingChannel.allCases, id: \.self) { channel in
        let on = model.progress.draftChannels.contains(channel)
        StepButton(
          title: (on ? "\u{2611} " : "\u{2610} ") + channel.name, weight: .ghost, palette: palette,
          id: ShellID.onboardingAgentChannelPrefix + channel.rawValue, value: on ? "on" : "off", enabled: model.progress.drafting
        ) {
          model.toggleDraftChannel(channel)
        }
      }
    }
    Card(palette: palette) {
      Text(OnboardingCopy.invariantTitle)
        .font(.system(size: 12, weight: .bold))
        .foregroundStyle(Tokens.color(palette.ink))
        .accessibilityAddTraits(.isHeader)
      Para(text: OnboardingCopy.invariant, palette: palette)
    }
    StepButton(title: OnboardingCopy.finish, weight: .outlined, palette: palette, id: ShellID.onboardingNext) {
      model.finish()
    }
  }
}

private struct AgentOption: View {
  let title: String
  let detail: String
  let selected: Bool
  let palette: Tokens.Palette
  let id: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(alignment: .top, spacing: 8) {
        Text(selected ? "\u{25C9}" : "\u{25CB}")
          .font(.system(size: 13))
          .foregroundStyle(selected ? Tokens.color(Tokens.tint) : Tokens.color(palette.inkDim))
        VStack(alignment: .leading, spacing: 4) {
          Text(title)
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(Tokens.color(palette.ink))
          Text(detail)
            .font(.system(size: 11))
            .foregroundStyle(Tokens.color(palette.ink))
            .fixedSize(horizontal: false, vertical: true)
            .multilineTextAlignment(.leading)
        }
      }
      .padding(12)
      .frame(maxWidth: .infinity, alignment: .topLeading)
      .background(RoundedRectangle(cornerRadius: 10).fill(Tokens.color(palette.layer1)))
      .overlay(
        RoundedRectangle(cornerRadius: 10)
          .strokeBorder(selected ? Tokens.color(Tokens.tint) : Tokens.color(palette.inkDim, opacity: 0.35), lineWidth: selected ? 2 : 1)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .focusable()
    .accessibilityLabel(title)
    .accessibilityValue(selected ? "selected" : "")
    .accessibilityAddTraits(selected ? .isSelected : [])
    .accessibilityIdentifier(id)
  }
}

/// KillIntro (12.F legend 4): introduced before it is needed, drawn engaged.
/// The engaged banner is a drawing: its Disengage is not a control here.
private struct KillIntro: View {
  let palette: Tokens.Palette

  var body: some View {
    Card(palette: palette) {
      Text(OnboardingCopy.killTitle)
        .font(.system(size: 12, weight: .bold))
        .foregroundStyle(Tokens.color(palette.ink))
        .accessibilityAddTraits(.isHeader)
      Text(OnboardingCopy.killWhere)
        .font(.system(size: 10, weight: .semibold, design: .monospaced))
        .foregroundStyle(Tokens.color(palette.inkDim))
      Para(text: OnboardingCopy.killDetail, palette: palette)
      HStack(spacing: 10) {
        Text("\u{25A0} " + OnboardingCopy.killOn)
          .font(.system(size: 11, weight: .bold))
          .foregroundStyle(Tokens.color(palette.layer1))
        Spacer(minLength: 8)
        Text("Disengage")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.layer1))
          .padding(.vertical, 3)
          .padding(.horizontal, 10)
          .overlay(Capsule().strokeBorder(Tokens.color(palette.layer1), lineWidth: 1))
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .background(RoundedRectangle(cornerRadius: 6).fill(Tokens.color(palette.ink)))
      .accessibilityElement(children: .combine)
      Para(text: OnboardingCopy.killOnDetail, palette: palette, dim: true)
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier(ShellID.onboardingKill)
  }
}

/// What a draft looks like (12.F legend 5): dashed, unfilled, labelled.
private struct DraftSpecimen: View {
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .trailing, spacing: 4) {
      Text("Thursday at 3 works. I will send a calendar invite.")
        .font(.system(size: 12))
        .foregroundStyle(Tokens.color(palette.ink))
        .fixedSize(horizontal: false, vertical: true)
        .padding(.vertical, 6)
        .padding(.horizontal, 10)
        .overlay(
          RoundedRectangle(cornerRadius: 12).strokeBorder(Tokens.color(Tokens.draftOutline), style: StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
        )
      Text("DRAFT by agent \u{00B7} not sent \u{00B7} approve or discard")
        .font(.system(size: 9, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.inkDim))
    }
    .frame(maxWidth: .infinity, alignment: .trailing)
    .accessibilityElement(children: .combine)
  }
}

// MARK: - 12.G

/// Setup complete: a line per channel, never a single "connected" (12.G).
private struct DonePage: View {
  @Bindable var model: OnboardingModel
  let palette: Tokens.Palette

  private var connected: Int { model.progress.copyStarted && !model.progress.declined.contains(.imessage) ? 1 : 0 }

  var body: some View {
    Heading(text: OnboardingCopy.complete(connected), palette: palette)
    Card(palette: palette) {
      ForEach(OnboardingChannel.allCases, id: \.self) { channel in
        HStack(spacing: 0) {
          Text(channel.name.uppercased()).frame(width: 120, alignment: .leading)
          Text(OnboardingCopy.doneLine(channel, model.progress))
        }
        .font(.system(size: 12, design: .monospaced))
        .foregroundStyle(Tokens.color(palette.ink))
        .accessibilityElement(children: .combine)
      }
      Para(text: OnboardingCopy.agentLine(model.progress), palette: palette, dim: true)
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier(ShellID.onboardingDone)
    StepButton(title: OnboardingCopy.openInbox, weight: .outlined, palette: palette, id: ShellID.onboardingNext) {
      model.openInbox()
    }
  }
}

// MARK: - 12.I

/// The coach row (12.I): its own row under the panes, the four letters, and
/// the one line that says any key dismisses it.
struct CoachRow: View {
  let palette: Tokens.Palette

  var body: some View {
    HStack(spacing: 14) {
      Text(OnboardingCopy.coachLead)
        .font(.system(size: 11))
        .foregroundStyle(Tokens.color(palette.ink))
        .fixedSize(horizontal: false, vertical: true)
      ForEach(OnboardingCopy.coachKeys, id: \.0) { pair in
        HStack(spacing: 5) {
          Text(pair.0)
            .font(.system(size: 10, weight: .bold, design: .monospaced))
            .foregroundStyle(Tokens.color(palette.ink))
            .frame(minWidth: 18, minHeight: 18)
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Tokens.color(palette.inkDim, opacity: 0.6), lineWidth: 1))
          Text(pair.1)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(Tokens.color(palette.ink))
        }
        .accessibilityElement(children: .combine)
      }
      Spacer(minLength: 8)
      Text(OnboardingCopy.coachDismiss)
        .font(.system(size: 10))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Tokens.color(palette.layer1))
    .accessibilityElement(children: .contain)
    .accessibilityLabel(OnboardingCopy.coachDismiss)
    .accessibilityIdentifier(ShellID.coach)
  }
}

/// The voice dock at rest (12.I legend 7): it prints its own invocation.
/// Nothing is bound here.
struct VoiceDockIdle: View {
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text("\u{25CB} " + OnboardingCopy.voiceIdle)
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
      Text(OnboardingCopy.voiceInvocation)
        .font(.system(size: 10))
        .foregroundStyle(Tokens.color(palette.inkDim))
    }
    .padding(8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Tokens.color(palette.inkDim, opacity: 0.35), lineWidth: 1))
    .accessibilityElement(children: .combine)
    .accessibilityLabel(OnboardingCopy.voiceIdle + ", " + OnboardingCopy.voiceInvocation)
    .accessibilityIdentifier(ShellID.voiceDock)
  }
}

/// Any key, once: a local key-down monitor while the coach row is up. The
/// dismissing keystroke is the answer, so it is consumed (D-UI-74).
struct CoachKeyMonitor: View {
  let model: OnboardingModel
  @State private var monitor: Any?

  var body: some View {
    Color.clear
      .frame(width: 0, height: 0)
      .accessibilityHidden(true)
      .onAppear {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
          let typed = event.charactersIgnoringModifiers
          let consumed = MainActor.assumeIsolated { () -> Bool in
            guard model.coachShown else { return false }
            model.coachKeyDown(typed)
            return true
          }
          return consumed ? nil : event
        }
      }
      .onDisappear {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
      }
  }
}
