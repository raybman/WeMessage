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
  /// Board 07: the room the voice dock takes at the reader's bottom
  /// (D-UI-179), so the last line is never drawn under it.
  var bottomInset: CGFloat = 0

  private var rows: [TranscriptLayout.Row] {
    guard let asOf = model.thread.asOf, model.thread.guid == thread.chatGuid else { return [] }
    return TranscriptLayout.rows(
      model.thread.turns, asOf: asOf, calendar: .current, isGroup: thread.isGroup,
      senderName: { model.senderName(handle: $0) })
  }

  var body: some View {
    GeometryReader { geometry in
      let maxWidth = TranscriptLayout.maxBubbleWidth(paneWidth: geometry.size.width)
      ScrollViewReader { proxy in
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
                .overlay { Board11Outline(guid: bubble.turn.guid, model: model, palette: palette) }
                .accessibilityIdentifier(ShellID.bubblePrefix + bubble.turn.guid)
                .id(bubble.turn.guid)
              }
            }
            if let draft = model.pendingDraft(for: thread.chatGuid) {
              let queued = model.lens != .recent
              let meta = queued ? model.metaLine(draft, long: model.lens == .needsYou) : nil
              if model.thread.held.contains(draft.id) {
                HeldBubble(
                  draft: draft, maxWidth: maxWidth, palette: palette, meta: meta,
                  release: queued && model.killSwitch == false ? { model.thread.release(draft.id) } : nil
                )
                .padding(.top, TranscriptLayout.senderChangeGap)
                .accessibilityIdentifier(ShellID.heldPrefix + draft.id)
              } else {
                DraftBubble(
                  draft: draft, isGroup: thread.isGroup, maxWidth: maxWidth, palette: palette, meta: meta,
                  absent: model.phase(of: draft)?.readsAbsent ?? false
                )
                .padding(.top, TranscriptLayout.senderChangeGap)
                .onAppear { model.outbound.markRendered(draft.id) }
                .accessibilityIdentifier(ShellID.draft)
                if model.lens == .needsYou {
                  NeedsYouDraft(model: model, draft: draft, palette: palette)
                    .padding(.top, 6)
                }
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
          .padding(.bottom, bottomInset)
          .frame(maxWidth: .infinity)
        }
        .defaultScrollAnchor(.bottom, for: .alignment)
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .defaultScrollAnchor(.bottom, for: .sizeChanges)
        .accessibilityLabel("Transcript")
        // Board 11: a result, a year or a find match scrolls its message
        // into the middle of the pane, once the rows that hold it are drawn.
        .onChange(of: model.scrollTarget) { _, target in
          if let target { proxy.scrollTo(target, anchor: .center) }
        }
        .onChange(of: rows.count) { _, _ in
          if let target = model.scrollTarget { proxy.scrollTo(target, anchor: .center) }
        }
        .onAppear {
          if let target = model.scrollTarget { proxy.scrollTo(target, anchor: .center) }
        }
      }
    }
  }
}

/// 11.C and 11.D: the message a jump landed on, or find's current match,
/// is outlined 3 pt in ink; find's other matches 1 pt. A rule, never a
/// colour.
struct Board11Outline: View {
  let guid: String
  let model: ShellModel
  let palette: Tokens.Palette

  private var width: CGFloat {
    if model.scrollTarget == guid { return 3 }
    if model.find.shown && model.find.matches.contains(guid) { return 1 }
    return 0
  }

  var body: some View {
    if width > 0 {
      RoundedRectangle(cornerRadius: TranscriptLayout.radius + 3)
        .strokeBorder(Tokens.color(palette.ink), lineWidth: width)
        .padding(-3)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
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

/// One turn (wireframe .bub). Inbound is paper with a 1 pt ink rule
/// (D-UI-41); outbound is filled (D-UI-27); an outbound turn in an SMS chat
/// is 2 pt dashed and unfilled with the transport in words (02.D, D-UI-28);
/// an unsent turn keeps its slot as a dashed italic placeholder (02.C).
/// Green is nowhere: the transport is said, never coloured.
///
/// Board 08 draws the same view in its specimen style: hugging its content
/// with no stamp beside it, the per-message facts inside the bubble (the
/// delivery state, reactions, the edit time, a quote, an SMS message's rail
/// and tag, an effect's double rule) and the richer payloads. The thread
/// style draws those facts too when a turn carries them; today's daemon
/// serves none (gap G-08a).
struct BubbleView: View {
  enum Style: Sendable {
    case thread
    case specimen
  }

  let bubble: TranscriptLayout.Bubble
  let sms: Bool
  let title: String
  let maxWidth: Double
  let palette: Tokens.Palette
  var style: Style = .thread
  /// The zone the times print in (the sheet pins UTC, as its golden does).
  var zone: TimeZone = .current

  private var turn: MessageTurn { bubble.turn }
  private var outbound: Bool { turn.direction == .outbound }
  private var look: BubbleLook { BubbleLook(turn: turn, sms: sms, style: style) }
  /// D-UI-39: one message that went over SMS in an iMessage chat.
  private var smsMessage: Bool { turn.service == .sms && !turn.isUnsent }

  private var shape: UnevenRoundedRectangle {
    let c = bubble.corners
    return UnevenRoundedRectangle(
      cornerRadii: .init(
        topLeading: c.topLeading, bottomLeading: c.bottomLeading, bottomTrailing: c.bottomTrailing,
        topTrailing: c.topTrailing))
  }

  /// D-UI-27: ink as drawn, or the tint.
  private var filled: Bool { look.filled }

  private var fill: Color {
    switch look.fill {
    case .ink: Tokens.color(palette.ink)
    case .tint: Tokens.color(Tokens.outbound)
    case .layer1: Tokens.color(palette.layer1)
    case .layer2: Tokens.color(palette.layer2)
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

  /// The small print inside a bubble: dimmed text on a filled bubble,
  /// inkDim on paper.
  private var secondary: Color { filled ? textColor.opacity(0.8) : Tokens.color(palette.inkDim) }

  /// What the bubble says.
  private var words: String {
    if turn.isUnsent { return (outbound ? "You" : (bubble.senderName ?? title)) + " unsent a message" }
    switch turn.kind {
    case .text: return turn.text ?? ""
    case .attachments(let count): return ProvisionalUI.attachmentsLine(count: count)
    case .voice(let transcript, _): return transcript ?? ProvisionalUI.voiceLine
    default: return SpecimenText.spoken(turn.kind, text: turn.text) ?? turn.text ?? ""
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
    parts.append(ShellText.shortClock(turn.sentAt, zone: zone))
    return parts.joined(separator: " \u{00B7} ")
  }

  /// What the bubble is, first, then who said what and when. The state
  /// word leads because a group's value never reaches AX on macOS (run
  /// 37591391142): the label is the one channel a reader can rely on.
  private var spoken: String {
    if turn.kind == .system { return turn.text ?? "" }
    let who = outbound ? "You" : (bubble.senderName ?? title)
    let state = turn.isUnsent ? "Unsent" : (outbound ? "Sent" : "Received")
    var facts: [String] = []
    if smsMessage { facts.append("SMS") }
    if turn.isForwarded { facts.append("Forwarded") }
    if let quote = turn.quote { facts.append("replying to " + quote) }
    if turn.isEdited { facts.append("Edited") }
    if let delivery = turn.delivery { facts.append(SpecimenText.delivery(delivery, zone: zone)) }
    if let effect = turn.effect { facts.append("sent with " + effect) }
    return ([state + ", " + who + ": " + words] + facts + [ShellText.shortClock(turn.sentAt, zone: zone)])
      .joined(separator: ", ")
  }

  var body: some View {
    Group {
      if turn.kind == .system {
        SystemLine(text: turn.text ?? "", palette: palette)
      } else if style == .specimen {
        VStack(alignment: outbound ? .trailing : .leading, spacing: 2) {
          senderLine
          HStack(alignment: .bottom, spacing: 6) {
            if outbound && bubble.showsTime { stampView }
            specimenBubble
            if !outbound && bubble.showsTime { stampView }
          }
        }
      } else {
        VStack(alignment: outbound ? .trailing : .leading, spacing: 2) {
          senderLine
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
      }
    }
    .padding(.top, bubble.gap)
    // A group, not an ignored element: an ignored one reads as an unknown
    // role in the audit and its value arrives empty (run 37591391142).
    .accessibilityElement(children: .contain)
    .accessibilityLabel(spoken)
    .accessibilityValue(turn.isUnsent ? "unsent" : turn.direction.rawValue)
  }

  @ViewBuilder private var senderLine: some View {
    if let name = bubble.senderName {
      Text(name)
        .font(.system(size: 9, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .padding(.horizontal, 12)
    }
  }

  private var stampView: some View {
    Text(stamp)
      .font(.system(size: 9))
      .foregroundStyle(Tokens.color(palette.inkDim))
      .fixedSize()
      // The sheet's bubble already speaks its time; a second, five-glyph
      // element is one the 1x audit cannot measure (run 37618816522). The
      // same holds in a thread when the stamp is the time alone (run
      // 37717485936): the bubble's label ends with it.
      .accessibilityHidden(style == .specimen || stamp == ShellText.shortClock(turn.sentAt, zone: zone))
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

  /// The rule round a bubble, as BubbleLook decides it, in either style.
  @ViewBuilder private var border: some View {
    switch look.rule {
    case .none: EmptyView()
    case .placeholder:
      shape.strokeBorder(Tokens.color(palette.inkDim), style: BubbleStroke.placeholder)
    case .dashed:
      shape.strokeBorder(Tokens.color(palette.ink), style: BubbleStroke.dashed)
    case .dotted:
      shape.strokeBorder(Tokens.color(palette.ink), style: BubbleStroke.dotted)
    case .outline:
      shape.strokeBorder(Tokens.color(palette.ink), lineWidth: 1)
    case .smsTrailingRail:
      shape.fill(Color.clear)
        .overlay(alignment: .trailing) {
          Rectangle().fill(Tokens.color(Tokens.smsRail(dark: palette == Tokens.palette(dark: true)))).frame(width: 3)
        }
        .clipShape(shape)
    case .smsInsetRail:
      // D-UI-39: an inset rail, never dashed (dashed means not sent).
      ZStack(alignment: .leading) {
        if !filled { shape.strokeBorder(Tokens.color(palette.ink), lineWidth: 1) }
        Rectangle()
          .fill(filled ? Tokens.color(palette.layer1) : Tokens.color(palette.ink))
          .frame(width: 2)
          .padding(.vertical, 8)
          .padding(.leading, 5)
      }
    case .effect:
      // An effect's double rule (08.I): a second rule 3 pt inside.
      ZStack {
        shape.strokeBorder(Tokens.color(palette.ink), lineWidth: 1)
        RoundedRectangle(cornerRadius: TranscriptLayout.radius - 3)
          .strokeBorder(Tokens.color(palette.ink), lineWidth: 1)
          .padding(3)
      }
    }
  }

  // MARK: The specimen style (board 08)

  /// The bubble hugs its content up to `maxWidth`; media is its own bubble.
  @ViewBuilder private var specimenBubble: some View {
    switch turn.kind {
    case .media(let items) where turn.text == nil:
      MediaBody(items: items, palette: palette)
    case .media(let items):
      // A caption keeps the asset in a frame filled as the direction says.
      VStack(alignment: .leading, spacing: 6) {
        MediaBody(items: items, palette: palette)
        Text(turn.text ?? "")
          .font(.system(size: 12))
          .foregroundStyle(textColor)
          .padding(.horizontal, 4)
      }
      .padding(4)
      .background(RoundedRectangle(cornerRadius: 10).fill(fill))
      .overlay {
        if !filled { RoundedRectangle(cornerRadius: 10).strokeBorder(Tokens.color(palette.ink), lineWidth: 1) }
      }
    default:
      Hug(maxWidth: max(0, maxWidth - 2 * TranscriptLayout.horizontalPadding)) { facts }
        .padding(.vertical, 7)
        .padding(.horizontal, TranscriptLayout.horizontalPadding)
        .background(shape.fill(fill))
        .overlay { border }
    }
  }

  /// Everything inside the bubble, top to bottom.
  private var facts: some View {
    VStack(alignment: .leading, spacing: 4) {
      if smsMessage {
        Text(ProvisionalUI.smsMessageTag.uppercased())
          .font(.system(size: 8, weight: .bold))
          .tracking(1)
          .foregroundStyle(secondary)
          .accessibilityHidden(true)
      }
      // The small print the bubble's label already speaks is drawn, not
      // read twice: forwarded, the tag above, the edit time, the effect.
      if turn.isForwarded {
        Text("\u{21AA} Forwarded").font(.system(size: 9)).foregroundStyle(secondary).accessibilityHidden(true)
      }
      if let quote = turn.quote {
        Text(quote)
          .font(.system(size: 10))
          .foregroundStyle(secondary)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.leading, 8)
          .overlay(alignment: .leading) { Rectangle().fill(secondary).frame(width: 2) }
      }
      payload
      if turn.isEdited {
        Text("Edited " + ShellText.shortClock(turn.sentAt, zone: zone)).font(.system(size: 9)).foregroundStyle(secondary)
          .accessibilityHidden(true)
      }
      if !turn.reactions.isEmpty {
        ReactionRow(guid: turn.guid, reactions: turn.reactions, ink: textColor)
      }
      if let delivery = turn.delivery { deliveryLine(delivery) }
      if smsMessage {
        Text(ProvisionalUI.smsMessageNote)
          .font(.system(size: 9))
          .foregroundStyle(secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if let effect = turn.effect {
        Text("sent with " + effect).font(.system(size: 9)).foregroundStyle(secondary).accessibilityHidden(true)
      }
    }
  }

  @ViewBuilder private var payload: some View {
    switch turn.kind {
    case .emojiOnly:
      Text(SpecimenText.textPresentation(turn.text ?? ""))
        .font(.system(size: 13 * ProvisionalUI.emojiOnlyScale))
        .foregroundStyle(textColor)
    case .voice(let transcript?, let seconds):
      VoiceBody(guid: turn.guid, transcript: transcript, seconds: seconds, ink: textColor, palette: palette)
    case .file(let file):
      FileBody(file: file, ink: textColor, dim: secondary, palette: palette)
    case .link(let link):
      LinkBody(link: link, ink: textColor, dim: secondary, palette: palette)
    case .location(let address):
      LocationBody(address: address, ink: textColor, palette: palette)
    case .contactCard(let card):
      ContactBody(card: card, ink: textColor, dim: secondary)
    case .poll(let poll):
      PollBody(poll: poll, ink: textColor, dim: secondary)
    case .unsupported(let name):
      UnsupportedBody(name: name, ink: textColor, dim: secondary)
    default:
      Text(SpecimenText.mentions(words))
        .font(.system(size: 13))
        .italic(turn.isUnsent)
        .foregroundStyle(textColor)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  /// The delivery state inside the bubble (08.A note 3): quiet words, or
  /// for a failure the cause and Retry, drawn and not bound (the sheet
  /// sends nothing).
  @ViewBuilder private func deliveryLine(_ delivery: Delivery) -> some View {
    if case .notDelivered(let reason) = delivery {
      HStack(spacing: 6) {
        Circle()
          .fill(Tokens.color(palette.ink))
          .overlay(Text("!").font(.system(size: 9, weight: .bold)).foregroundStyle(Tokens.color(palette.layer1)))
          .frame(width: 14, height: 14)
          .accessibilityHidden(true)
        Text(reason).font(.system(size: 9)).foregroundStyle(secondary)
        Text("Retry")
          .font(.system(size: 9, weight: .semibold))
          .foregroundStyle(textColor)
          .padding(.vertical, 2)
          .padding(.horizontal, 6)
          .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(textColor, lineWidth: 1))
          .accessibilityHidden(true)
      }
      .accessibilityElement(children: .combine)
      .accessibilityLabel(SpecimenText.delivery(delivery, zone: zone))
      .accessibilityIdentifier(ShellID.deliveryPrefix + turn.guid)
    } else {
      Text(SpecimenText.delivery(delivery, zone: zone))
        .font(.system(size: 10, weight: .medium))
        .foregroundStyle(secondary)
        .accessibilityIdentifier(ShellID.deliveryPrefix + turn.guid)
    }
  }
}

/// What a bubble's surface is, pure, so AppTests hold every decision the
/// board 08 probes read in pixels: the fill (D-UI-27 outbound, D-UI-41
/// inbound) and the rule round it (02.C, 02.D, 08.G, 08.I, D-UI-39).
struct BubbleLook: Equatable {
  enum Fill: Equatable {
    case ink, tint, layer1, layer2
  }

  enum Rule: Equatable {
    /// No rule: a filled outbound bubble, or a solid inbound one.
    case none
    /// 1 pt dashed inkDim: an unsent message, an expired or unsupported payload.
    case placeholder
    /// 2 pt dashed: an outbound turn in an SMS chat (D-UI-28).
    case dashed
    /// 2 pt dotted: not delivered.
    case dotted
    /// 1 pt ink: inbound paper (D-UI-41).
    case outline
    /// 02.D's 3 pt rail on the trailing edge (D-UI-28's alternative).
    case smsTrailingRail
    /// D-UI-39: one message that went over SMS, an inset rail and a tag.
    case smsInsetRail
    /// 08.I: an effect's double rule.
    case effect
  }

  let filled: Bool
  let fill: Fill
  let rule: Rule

  init(turn: MessageTurn, sms: Bool, style: BubbleView.Style) {
    let outbound = turn.direction == .outbound
    let failed = turn.delivery?.isFailure == true
    let placeholder: Bool
    switch turn.kind {
    case .file(let file): placeholder = file.expired == true
    case .unsupported: placeholder = true
    default: placeholder = turn.isUnsent
    }
    filled = outbound && !turn.isUnsent && !failed && !(sms && ProvisionalUI.smsOutbound == .dashedUnfilled)
    if filled {
      fill = ProvisionalUI.outboundFill == .ink ? .ink : .tint
    } else if !outbound && !placeholder && ProvisionalUI.inboundFill == .layer2Solid {
      fill = .layer2
    } else {
      fill = .layer1
    }
    let inbound: Rule = !outbound && ProvisionalUI.inboundFill == .layer1Outlined ? .outline : .none
    switch style {
    case .thread:
      if turn.isUnsent {
        rule = .placeholder
      } else if outbound && sms {
        rule = ProvisionalUI.smsOutbound == .dashedUnfilled ? .dashed : .smsTrailingRail
      } else {
        rule = inbound
      }
    case .specimen:
      if placeholder {
        rule = .placeholder
      } else if failed {
        rule = .dotted
      } else if turn.service == .sms {
        switch ProvisionalUI.smsMessage {
        case .insetRailAndTag: rule = .smsInsetRail
        }
      } else if !outbound && turn.effect != nil {
        rule = .effect
      } else {
        rule = inbound
      }
    }
  }
}
