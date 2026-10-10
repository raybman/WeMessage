import SwiftUI

// v2 S4j, board 14's pieces. No channel control is drawn before a person
// exists (14.A); the channel rows are a report, never a picker (D-UI-97);
// the proposal region never writes the input (14.E); Send reaches the
// model's send() and nothing else (H-S4-10). Ink and layers only: no
// colour carries a state, and nothing is green.

/// 14.A to 14.E: one field, then the person, the channel, the strip, the
/// proposal and the input.
struct NewMessagePage: View {
  @Bindable var model: ComposeModel
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      toRow
      if let person = model.person {
        chosen(person)
      } else {
        resolving
      }
    }
  }

  private var toRow: some View {
    HStack(spacing: 10) {
      Text("To")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .accessibilityHidden(true)
      if let person = model.person {
        HStack(spacing: 6) {
          ComposeInitials(person: person, palette: palette)
          Text(person.title)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(Tokens.color(palette.ink))
          if person.name != nil, let handle = person.imessage {
            Text(ComposeModel.printed(handle))
              .font(.system(size: 11).monospacedDigit())
              .foregroundStyle(Tokens.color(palette.inkDim))
          }
        }
        .padding(.vertical, 2)
        .padding(.horizontal, 8)
        .overlay(Capsule().strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("To " + person.title)
        .accessibilityValue(person.id)
        .accessibilityIdentifier(ShellID.composeRecipient)
        Text("1 recipient")
          .font(.system(size: 11))
          .foregroundStyle(Tokens.color(palette.inkDim))
      } else {
        TextField("To", text: $model.query, prompt: Text("Name, number, or address\u{2026}"))
          .textFieldStyle(.plain)
          .font(.system(size: 13))
          .foregroundStyle(Tokens.color(palette.ink))
          .accessibilityLabel("To")
          .accessibilityIdentifier(ShellID.composeTo)
      }
      Spacer(minLength: 0)
    }
    .padding(.vertical, 8)
    .padding(.horizontal, 12)
    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
  }

  /// Before a person: the reason there is no composer, or the rows.
  @ViewBuilder private var resolving: some View {
    // v2 F5: a typed handle that matches no one is one row, first.
    let rows = (model.typed.map { [$0] } ?? []) + model.matches
    if model.query.trimmingCharacters(in: .whitespaces).isEmpty {
      Text("No composer yet. A composer is a function of a channel, and a channel is a function of a person.")
        .font(.system(size: 12))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .fixedSize(horizontal: false, vertical: true)
    } else {
      Text(rows.isEmpty ? "No match among the people this version knows." : "\(rows.count) \(rows.count == 1 ? "match" : "matches"), most recent first")
        .font(.system(size: 11))
        .foregroundStyle(Tokens.color(palette.inkDim))
      if let hint = model.hint {
        Text(hint)
          .font(.system(size: 11))
          .foregroundStyle(Tokens.color(palette.ink))
          .accessibilityIdentifier(ShellID.composeHint)
      }
      VStack(alignment: .leading, spacing: 4) {
        ForEach(rows) { person in
          ResolutionRow(person: person, palette: palette) { model.choose(person) }
        }
      }
    }
  }

  @ViewBuilder private func chosen(_ person: ComposePerson) -> some View {
    SettingsHeading(text: "Reachable on", palette: palette)
    VStack(alignment: .leading, spacing: 6) {
      ForEach(model.channels, id: \.channel) { card in
        ChannelRow(card: card, palette: palette)
      }
    }
    if let banner = model.banner {
      VStack(alignment: .leading, spacing: 2) {
        Text(banner)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.ink))
        Text(ComposeModel.bannerTail)
          .font(.system(size: 11))
          .foregroundStyle(Tokens.color(palette.inkDim))
          .fixedSize(horizontal: false, vertical: true)
      }
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier(ShellID.composeBanner)
      CapabilityStrip(palette: palette)
      ProposalRegion(model: model, palette: palette)
      composer(person)
      if model.phase != .composing {
        SendStateBubble(model: model, palette: palette)
      }
    } else if let refusal = model.refusal {
      // v2 F5 (D-F5-2): one static line where the composer would be.
      Text(refusal)
        .font(.system(size: 12))
        .foregroundStyle(Tokens.color(palette.ink))
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier(ShellID.composeRefusal)
    } else if model.resolution != .checking {
      Text(
        "No channel here can reach \(person.firstName) from this Mac, so there is no composer. Better to say so than to pick one badly."
      )
      .font(.system(size: 12))
      .foregroundStyle(Tokens.color(palette.ink))
      .fixedSize(horizontal: false, vertical: true)
    }
  }

  /// The input and Send. Return types a newline; cmd-Return is Send.
  private func composer(_ person: ComposePerson) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      TextEditor(text: $model.body)
        .font(.system(size: 13))
        .foregroundStyle(Tokens.color(palette.ink))
        .scrollContentBackground(.hidden)
        .frame(minHeight: 56, maxHeight: 96)
        .padding(6)
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
        .disabled(model.busy)
        .accessibilityLabel("Message " + person.firstName)
        .accessibilityIdentifier(ShellID.composeField)
      HStack(spacing: 10) {
        Text("\u{2318}\u{21A9} puts it in Needs You")
          .font(.system(size: 11))
          .foregroundStyle(Tokens.color(palette.inkDim))
        Spacer(minLength: 8)
        if case .undo(let left) = model.phase {
          SettingsButton(title: "Undo \u{00B7} \(left)s", palette: palette, id: ShellID.composeUndo) { model.undo() }
            .keyboardShortcut("z", modifiers: .command)
        }
        SettingsButton(title: "Send", palette: palette, id: ShellID.composeSend) { model.send() }
          .keyboardShortcut(.return, modifiers: .command)
          .disabled(!model.canSend)
          .opacity(model.canSend ? 1 : 0.55)
          .accessibilityValue(model.canSend ? "enabled" : "inert")
      }
    }
  }
}

/// A two-letter monogram, or # for a bare handle.
struct ComposeInitials: View {
  let person: ComposePerson
  let palette: Tokens.Palette

  var body: some View {
    Text(person.initials)
      .font(.system(size: 10, weight: .semibold))
      .foregroundStyle(Tokens.color(palette.ink))
      .frame(width: 24, height: 24)
      .background(Circle().fill(Tokens.color(palette.layer2)))
      .accessibilityHidden(true)
  }
}

/// 14.A ruling 2: a row carries evidence, not just a name.
struct ResolutionRow: View {
  let person: ComposePerson
  let palette: Tokens.Palette
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 10) {
        ComposeInitials(person: person, palette: palette)
        VStack(alignment: .leading, spacing: 1) {
          Text(person.title)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(Tokens.color(palette.ink))
          Text(person.evidence)
            .font(.system(size: 11))
            .foregroundStyle(Tokens.color(palette.inkDim))
        }
        Spacer(minLength: 0)
      }
      .padding(.vertical, 5)
      .padding(.horizontal, 8)
      .background(RoundedRectangle(cornerRadius: 6).fill(Tokens.color(palette.layer1, opacity: 0.6)))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .focusable()
    .accessibilityElement(children: .ignore)
    .accessibilityAddTraits(.isButton)
    .accessibilityLabel(person.title + ", " + person.evidence)
    // Ignoring children drops the Button's press; give it back.
    .accessibilityAction { action() }
    .accessibilityIdentifier(person.name == nil && person.id.hasPrefix("typed:") ? ShellID.composeResultTyped : ShellID.composeResultPrefix + person.id)
  }
}

/// 14.B: one channel's report. Not a button: nothing here is chosen.
struct ChannelRow: View {
  let card: ChannelCardState
  let palette: Tokens.Palette

  var body: some View {
    let live = card.kind == .default
    HStack(alignment: .top, spacing: 10) {
      Text(card.channel.tag)
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
        .frame(width: 26, height: 20)
        .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
      VStack(alignment: .leading, spacing: 2) {
        Text(card.channel.title)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.ink))
        Text(card.headline)
          .font(.system(size: 12))
          .foregroundStyle(Tokens.color(palette.ink))
        if !card.detail.isEmpty {
          Text(card.detail)
            .font(.system(size: 11))
            .foregroundStyle(Tokens.color(palette.inkDim))
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      Spacer(minLength: 8)
      Text(card.kind.rawValue)
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
        .padding(.vertical, 2)
        .padding(.horizontal, 8)
        .overlay(Capsule().strokeBorder(Tokens.color(palette.inkDim), lineWidth: 1))
    }
    .padding(8)
    .overlay(
      RoundedRectangle(cornerRadius: 8).strokeBorder(
        Tokens.color(live ? palette.ink : palette.inkDim), lineWidth: live ? 2 : 1))
    .accessibilityElement(children: .combine)
    .accessibilityValue(card.kind.rawValue)
    .accessibilityIdentifier(ShellID.composeChannelPrefix + card.channel.rawValue)
  }
}

/// 14.C: twelve slots in one order; a slot the channel lacks is a struck
/// word, never a gap.
struct CapabilityStrip: View {
  let palette: Tokens.Palette

  var body: some View {
    let slots = ComposeModel.capabilities
    VStack(alignment: .leading, spacing: 4) {
      ForEach([0, 6], id: \.self) { start in
        HStack(spacing: 10) {
          ForEach(slots[start..<min(start + 6, slots.count)], id: \.id) { slot in
            Text(slot.title)
              .font(.system(size: 11, weight: slot.can ? .semibold : .regular))
              .strikethrough(!slot.can)
              .foregroundStyle(Tokens.color(slot.can ? palette.ink : palette.inkDim))
              .accessibilityElement(children: .combine)
              .accessibilityLabel(slot.spoken + (slot.can ? ", can" : ", not in this version"))
              .accessibilityValue(slot.can ? "can" : "struck")
              .accessibilityIdentifier(ShellID.composeSlotPrefix + slot.id)
          }
        }
      }
      Text("iMessage in this version: plain text and emoji. Every other slot is struck, not dropped.")
        .font(.system(size: 11))
        .foregroundStyle(Tokens.color(palette.inkDim))
    }
    .padding(.vertical, 6)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("What this channel can do")
    .accessibilityIdentifier(ShellID.composeStrip)
  }
}

/// 14.E: dashed and unfilled, above the input. Only Approve moves its text
/// down, and nothing in it can reach Send.
struct ProposalRegion: View {
  let model: ComposeModel
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      // The region's state rides on its first line: a containing group
      // drops its value on macOS.
      Group {
        switch model.proposal {
        case .empty:
          Text("Proposal region. Empty. The input below stays yours.")
            .font(.system(size: 11))
            .foregroundStyle(Tokens.color(palette.inkDim))
        case .ready(let text):
          Text(text)
            .font(.system(size: 13))
            .foregroundStyle(Tokens.color(palette.ink))
        case .moved:
          Text("MOVED to the composer \u{00B7} no longer a proposal")
            .font(.system(size: 11))
            .foregroundStyle(Tokens.color(palette.inkDim))
        }
      }
      .accessibilityElement(children: .combine)
      .accessibilityValue(model.proposal.value)
      .accessibilityIdentifier(ShellID.composeProposal)
      switch model.proposal {
      case .empty:
        SettingsButton(title: "Ask for a draft  \u{2325}\u{2318}D", palette: palette, id: ShellID.composeProposalAsk) {
          model.askForDraft()
        }
        .keyboardShortcut("d", modifiers: [.command, .option])
      case .ready:
        Text("DRAFT \u{00B7} fixture text: no agent is connected in this version")
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.inkDim))
        HStack(spacing: 10) {
          SettingsButton(title: "Approve", palette: palette, id: ShellID.composeProposalTake) { model.takeProposal() }
          SettingsButton(title: "Hold", palette: palette, id: ShellID.composeProposalHold) { model.dropProposal() }
        }
      case .moved:
        EmptyView()
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .overlay(
      RoundedRectangle(cornerRadius: 10).strokeBorder(
        Tokens.color(model.proposal == .empty ? palette.inkDim : palette.ink),
        style: model.proposal == .empty ? BubbleStroke.placeholder : BubbleStroke.dashed))
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Proposal region")
  }
}

/// A bubble drawn by the 14.F fill rule: filled only when sent, dashed
/// before, dotted when failed.
struct StateBubble: View {
  let text: String
  let tag: String
  let border: SendState.Border
  let palette: Tokens.Palette

  private var filled: Bool { border == .filled }

  private var fill: Color {
    switch ProvisionalUI.outboundFill {
    case .ink: Tokens.color(palette.ink)
    case .tint: Tokens.color(Tokens.outbound)
    }
  }

  private var textColor: Color {
    guard filled else { return Tokens.color(palette.ink) }
    switch ProvisionalUI.outboundFill {
    case .ink: return Tokens.color(palette.layer1)
    case .tint: return .white
    }
  }

  var body: some View {
    VStack(alignment: .trailing, spacing: 3) {
      Text(text)
        .font(.system(size: 13))
        .foregroundStyle(textColor)
        .padding(.vertical, 6)
        .padding(.horizontal, 12)
        .background(RoundedRectangle(cornerRadius: 14).fill(filled ? fill : Color.clear))
        .overlay {
          switch border {
          case .dashed:
            RoundedRectangle(cornerRadius: 14).strokeBorder(Tokens.color(palette.ink), style: BubbleStroke.dashed)
          case .dotted:
            RoundedRectangle(cornerRadius: 14).strokeBorder(Tokens.color(palette.ink), style: BubbleStroke.dotted)
          case .none, .filled:
            EmptyView()
          }
        }
      Text(tag)
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.inkDim))
    }
  }
}

/// The live message after Send: dashed through the undo window and the
/// create, still dashed in Needs You (a draft is not sent), dotted on a
/// failure.
struct SendStateBubble: View {
  let model: ComposeModel
  let palette: Tokens.Palette

  private var border: SendState.Border {
    if case .failed = model.phase { return .dotted }
    return .dashed
  }

  var body: some View {
    HStack {
      Spacer(minLength: 40)
      StateBubble(text: model.sending, tag: model.phaseLine, border: border, palette: palette)
    }
    .accessibilityElement(children: .combine)
    .accessibilityValue(model.phase.value)
    .accessibilityIdentifier(ShellID.composeBubble)
  }
}

/// 14.F: the six send states as specimens, in sequence.
struct SendStatesPage: View {
  let palette: Tokens.Palette

  static let specimen = "Saturday works for me."

  var body: some View {
    SettingsHeading(text: "Six send states", palette: palette)
    Text("A bubble fills only when the transport has accepted it. Everything before that is dashed, and anything that failed is dotted.")
      .font(.system(size: 12))
      .foregroundStyle(Tokens.color(palette.ink))
      .fixedSize(horizontal: false, vertical: true)
    ForEach(Array(SendState.allCases.enumerated()), id: \.element) { index, state in
      HStack(alignment: .top, spacing: 12) {
        VStack(alignment: .leading, spacing: 2) {
          Text("\(index + 1)  \(state.title)")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(Tokens.color(palette.ink))
          Text(state.caption)
            .font(.system(size: 11))
            .foregroundStyle(Tokens.color(palette.inkDim))
            .fixedSize(horizontal: false, vertical: true)
        }
        .frame(width: 260, alignment: .leading)
        Spacer(minLength: 8)
        if state == .composed {
          Text(Self.specimen)
            .font(.system(size: 13))
            .foregroundStyle(Tokens.color(palette.ink))
            .padding(8)
            .frame(width: 220, alignment: .leading)
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
        } else {
          StateBubble(text: Self.specimen, tag: state.tag, border: state.border, palette: palette)
        }
      }
      .padding(.vertical, 6)
      .accessibilityElement(children: .combine)
      .accessibilityValue(String(describing: state.border))
      .accessibilityIdentifier(ShellID.composeStatePrefix + state.rawValue)
    }
  }
}
