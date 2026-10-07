import SwiftUI
import WeMessageKit

/// The transcript (wireframe .msgs): day separators and bubbles laid out by
/// TranscriptLayout, then the pending agent draft (or its held form) and the
/// newest send from this window. Anchored to the bottom, as Messages is: a
/// short thread sits on the banner, not under the head.
struct TranscriptView: View {
  @Bindable var model: ShellModel
  let thread: ThreadSummary
  let palette: Tokens.Palette

  private var rows: [TranscriptLayout.Row] {
    guard let asOf = model.thread.asOf, model.thread.guid == thread.chatGuid else { return [] }
    return TranscriptLayout.rows(
      model.thread.turns, asOf: asOf, calendar: .current, isGroup: thread.isGroup,
      senderName: { model.senderName(handle: $0) })
  }

  var body: some View {
    GeometryReader { geometry in
      let maxWidth = TranscriptLayout.maxBubbleWidth(paneWidth: geometry.size.width)
      ScrollView {
        VStack(spacing: 0) {
          ForEach(rows) { row in
            switch row {
            case .day(let id, let label):
              DaySeparator(label: label, palette: palette)
                .accessibilityIdentifier(ShellID.dayPrefix + id)
            case .bubble(let bubble):
              BubbleView(
                bubble: bubble, sms: isSMSChat(thread.chatGuid), title: thread.title, maxWidth: maxWidth,
                palette: palette
              )
              .accessibilityIdentifier(ShellID.bubblePrefix + bubble.turn.guid)
            }
          }
          if let draft = model.pendingDraft(for: thread.chatGuid) {
            if model.thread.held.contains(draft.id) {
              HeldBubble(draft: draft, maxWidth: maxWidth, palette: palette)
                .padding(.top, TranscriptLayout.senderChangeGap)
                .accessibilityIdentifier(ShellID.heldPrefix + draft.id)
            } else {
              DraftBubble(draft: draft, isGroup: thread.isGroup, maxWidth: maxWidth, palette: palette)
                .padding(.top, TranscriptLayout.senderChangeGap)
                .onAppear { model.outbound.markRendered(draft.id) }
                .accessibilityIdentifier(ShellID.draft)
            }
          }
          if let entry = model.outbound.latest(for: thread.chatGuid), entry.phase != .undone {
            OutboxBubble(entry: entry, maxWidth: maxWidth, palette: palette) {
              ComposerView.undo(model: model, chatGuid: thread.chatGuid)
            }
            .padding(.top, TranscriptLayout.senderChangeGap)
          }
        }
        .padding(.vertical, TranscriptLayout.verticalPadding)
        .padding(.horizontal, TranscriptLayout.horizontalPadding)
        .frame(maxWidth: .infinity)
      }
      .defaultScrollAnchor(.bottom, for: .alignment)
      .defaultScrollAnchor(.bottom, for: .initialOffset)
      .defaultScrollAnchor(.bottom, for: .sizeChanges)
      .accessibilityLabel("Transcript")
    }
  }
}

/// A day separator (wireframe .daysep): the day, centred, small.
struct DaySeparator: View {
  let label: String
  let palette: Tokens.Palette

  var body: some View {
    Text(label)
      .font(.system(size: 10))
      .foregroundStyle(Tokens.color(palette.inkDim))
      .frame(maxWidth: .infinity)
      .padding(.vertical, 8)
      .accessibilityAddTraits(.isHeader)
  }
}

/// The two stroke patterns board 02 and 14.F use besides a solid rule.
enum BubbleStroke {
  /// 2 pt dashed: not sent (a draft, a send in its window, an SMS).
  static let dashed = StrokeStyle(lineWidth: 2, dash: [6, 4])
  /// 2 pt dotted: refused or failed.
  static let dotted = StrokeStyle(lineWidth: 2, lineCap: .round, dash: [0.1, 4])
  /// 1 pt dashed: an unsent message's placeholder (02.C).
  static let placeholder = StrokeStyle(lineWidth: 1, dash: [4, 3])
}

/// One turn (wireframe .bub). Inbound is paper with a 1 pt ink rule;
/// outbound is filled (D-UI-27); an outbound turn in an SMS chat is 2 pt
/// dashed and unfilled with the transport in words (02.D, D-UI-28); an
/// unsent turn keeps its slot as a dashed italic placeholder (02.C). Green
/// is nowhere: the transport is said, never coloured.
struct BubbleView: View {
  let bubble: TranscriptLayout.Bubble
  let sms: Bool
  let title: String
  let maxWidth: Double
  let palette: Tokens.Palette

  private var turn: MessageTurn { bubble.turn }
  private var outbound: Bool { turn.direction == .outbound }
  private var smsOutbound: Bool { outbound && sms && !turn.isUnsent }

  private var shape: UnevenRoundedRectangle {
    let c = bubble.corners
    return UnevenRoundedRectangle(
      cornerRadii: .init(
        topLeading: c.topLeading, bottomLeading: c.bottomLeading, bottomTrailing: c.bottomTrailing,
        topTrailing: c.topTrailing))
  }

  /// D-UI-27: ink as drawn, or the tint.
  private var filled: Bool { outbound && !turn.isUnsent && !(sms && ProvisionalUI.smsOutbound == .dashedUnfilled) }

  private var fill: Color {
    guard filled else { return Tokens.color(palette.layer1) }
    switch ProvisionalUI.outboundFill {
    case .ink: return Tokens.color(palette.ink)
    case .tint: return Tokens.color(Tokens.outbound)
    }
  }

  private var textColor: Color {
    if turn.isUnsent { return Tokens.color(palette.inkDim) }
    guard filled else { return Tokens.color(palette.ink) }
    switch ProvisionalUI.outboundFill {
    case .ink: return Tokens.color(palette.layer1)
    case .tint: return .white
    }
  }

  /// What the bubble says.
  private var words: String {
    if turn.isUnsent { return (outbound ? "You" : (bubble.senderName ?? title)) + " unsent a message" }
    switch turn.kind {
    case .text: return turn.text ?? ""
    case .attachments(let count): return ProvisionalUI.attachmentsLine(count: count)
    case .voice(let transcript): return transcript ?? ProvisionalUI.voiceLine
    }
  }

  /// The stamp beside the first turn of a run: the time, and in an SMS
  /// chat the transport in words (02.D).
  private var stamp: String {
    var parts: [String] = []
    if sms && !turn.isUnsent {
      parts.append(outbound ? "Sent as SMS \u{00B7} not encrypted" : "Text Message \u{00B7} SMS")
    }
    if turn.isEdited { parts.append("Edited") }
    parts.append(ShellText.shortClock(turn.sentAt))
    return parts.joined(separator: " \u{00B7} ")
  }

  /// What the bubble is, first, then who said what and when. The state
  /// word leads because a group's value never reaches AX on macOS (run
  /// 37591391142): the label is the one channel a reader can rely on.
  private var spoken: String {
    let who = outbound ? "You" : (bubble.senderName ?? title)
    let state = turn.isUnsent ? "Unsent" : (outbound ? "Sent" : "Received")
    return state + ", " + who + ": " + words + ", " + ShellText.shortClock(turn.sentAt)
  }

  var body: some View {
    VStack(alignment: outbound ? .trailing : .leading, spacing: 2) {
      if let name = bubble.senderName {
        Text(name)
          .font(.system(size: 9, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.inkDim))
          .padding(.horizontal, 12)
      }
      HStack(alignment: .bottom, spacing: 6) {
        if outbound {
          Spacer(minLength: 0)
          if bubble.showsTime { stampView }
        }
        content
        if !outbound {
          if bubble.showsTime { stampView }
          Spacer(minLength: 0)
        }
      }
    }
    .padding(.top, bubble.gap)
    // A group, not an ignored element: an ignored one reads as an unknown
    // role in the audit and its value arrives empty (run 37591391142).
    .accessibilityElement(children: .contain)
    .accessibilityLabel(spoken)
    .accessibilityValue(turn.isUnsent ? "unsent" : turn.direction.rawValue)
  }

  private var stampView: some View {
    Text(stamp)
      .font(.system(size: 9))
      .foregroundStyle(Tokens.color(palette.inkDim))
      .fixedSize()
  }

  private var content: some View {
    Text(words)
      .font(.system(size: 13))
      .italic(turn.isUnsent || turn.kind != .text)
      .foregroundStyle(textColor)
      .multilineTextAlignment(.leading)
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: max(0, maxWidth - 2 * TranscriptLayout.horizontalPadding), alignment: .leading)
      .padding(.vertical, 7)
      .padding(.horizontal, TranscriptLayout.horizontalPadding)
      .background(shape.fill(fill))
      .overlay { border }
  }

  @ViewBuilder private var border: some View {
    if turn.isUnsent {
      shape.strokeBorder(Tokens.color(palette.inkDim), style: BubbleStroke.placeholder)
    } else if smsOutbound {
      switch ProvisionalUI.smsOutbound {
      case .dashedUnfilled:
        shape.strokeBorder(Tokens.color(palette.ink), style: BubbleStroke.dashed)
      case .inkDimRail:
        shape.fill(Color.clear)
          .overlay(alignment: .trailing) {
            Rectangle().fill(Tokens.color(Tokens.smsRail(dark: palette == Tokens.palette(dark: true)))).frame(width: 3)
          }
          .clipShape(shape)
      }
    } else if !outbound {
      shape.strokeBorder(Tokens.color(palette.ink), lineWidth: 1)
    }
  }
}
