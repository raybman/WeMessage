import SwiftUI
import WeMessageKit

// v2 B1, board 03 over fixtures: an open WhatsApp chat. Top to bottom: the
// channel banner with its chip, the thread head with board 03's line
// (D-UI-148), in a group the INV-5 strip and who may send, the linked
// device's line (D-UI-141, D-UI-142), then the transcript or the re-link
// card, and the phone panel where a composer would be (D-UI-144). It reads
// only: no composer, no send, and nothing is fetched, not even the media
// the phone has not sent (D-UI-149). Monochrome plus the one blue tint.

/// The content pane while a WhatsApp chat is open.
struct WhatsAppThreadPane: View {
  @Bindable var model: ShellModel
  let thread: ThreadSummary
  let board: WhatsAppBoardModel
  let palette: Tokens.Palette

  var body: some View {
    let meta = WhatsAppThreadMeta.parse(thread.meta)
    let clock = model.thread.asOf.map { ShellText.shortClock($0) }
    VStack(spacing: 0) {
      WhatsAppBanner(board: board, palette: palette)
      ThreadHeader(
        thread: thread, image: model.avatars.image(for: thread), asOf: model.thread.asOf,
        subline: WhatsAppThreadLayout.subline(
          isGroup: thread.isGroup, meta: meta, handle: threadHandle(thread), clock: clock),
        palette: palette
      ) {
        model.inspectorShown.toggle()
      }
      Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.2)).frame(height: 0.5).accessibilityHidden(true)
      WhatsAppThreadView(model: model, thread: thread, meta: meta, palette: palette)
    }
    .task(id: model.selectedThread) { await model.thread.open(model.selectedThread) }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityElement(children: .contain)
    .accessibilityLabel(thread.title)
    .accessibilityIdentifier(ShellID.content)
  }
}

/// Everything under the head: the strips, the transcript or the re-link
/// card, and the phone panel.
struct WhatsAppThreadView: View {
  @Bindable var model: ShellModel
  let thread: ThreadSummary
  let meta: WhatsAppThreadMeta
  let palette: Tokens.Palette

  private var loadValue: String {
    switch model.thread.load {
    case .idle: "idle"
    case .loading: "loading"
    case .loaded: "loaded"
    case .unknownChat: "unknown chat"
    case .failed: "failed"
    }
  }

  private var turns: [WhatsAppTurn] {
    guard model.thread.guid == thread.chatGuid, case .loaded(let page) = model.thread.load else { return [] }
    return WhatsAppTurn.turns(page)
  }

  /// Before the transcript says when it was read, no day count is drawn.
  private var panel: WhatsAppDevicePanel {
    WhatsAppDevicePanel.make(meta, asOf: model.thread.asOf ?? .distantPast)
  }

  /// The linked device's line: its days and, from D-UI-141's day, the
  /// re-link warning; or that the session expired or is being re-linked.
  private var deviceLine: String? {
    switch panel {
    case .linked(let days?, let warn):
      let clock = ShellText.shortClock(model.thread.asOf ?? .distantPast)
      let linked = ProvisionalUI.whatsAppLinkedLine(days: days, clock: clock)
      return warn.map { linked + " \u{00B7} " + ProvisionalUI.whatsAppRelinkWarning(daysLeft: $0) } ?? linked
    case .linked: return nil
    case .relink(.relinking): return ProvisionalUI.whatsAppRelinkingLine
    case .relink: return ProvisionalUI.whatsAppExpiredLine
    case .unknown: return nil
    }
  }

  var body: some View {
    VStack(spacing: 0) {
      if thread.isGroup {
        Inv5Strip(palette: palette)
        if meta.adminOnly, let admins = meta.admins {
          WhatsAppStrip(
            text: ProvisionalUI.whatsAppAdminOnlyLine(admins: admins), strong: false, id: ShellID.whatsAppAdmins,
            palette: palette)
        }
      }
      if let line = deviceLine {
        WhatsAppStrip(text: line, strong: panel.replacesTranscript, id: ShellID.whatsAppLinked, palette: palette)
      }
      if case .relink(let state) = panel {
        WhatsAppRelinkCard(state: state, palette: palette)
      } else {
        WhatsAppTranscript(model: model, thread: thread, meta: meta, turns: turns, palette: palette)
      }
      WhatsAppPhonePanel(phone: meta.phonePanel, palette: palette)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityElement(children: .contain)
    // As board 02's: a container's value never reaches AX on macOS, so the
    // load state rides the label too.
    .accessibilityLabel("Conversation: " + loadValue)
    .accessibilityValue(loadValue)
    .accessibilityIdentifier(ShellID.thread)
  }
}

/// One line under the head, text only, with a hairline under it.
struct WhatsAppStrip: View {
  let text: String
  /// Ink and semibold for a state that stops the chat; inkDim otherwise.
  let strong: Bool
  let id: String
  let palette: Tokens.Palette

  var body: some View {
    Text(text)
      .font(.system(size: 10, weight: strong ? .semibold : .regular))
      .foregroundStyle(Tokens.color(strong ? palette.ink : palette.inkDim))
      .lineLimit(2)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.vertical, 6)
      .padding(.horizontal, 12)
      .overlay(alignment: .bottom) {
        Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.2)).frame(height: 0.5).accessibilityHidden(true)
      }
      .accessibilityLabel(text)
      .accessibilityAddTraits(.isStaticText)
      .accessibilityIdentifier(id)
  }
}

/// D-UI-142: the re-link card in place of the transcript. The QR frame
/// holds a drawn placeholder, never a code: nothing is fetched.
struct WhatsAppRelinkCard: View {
  let state: WhatsAppLinkedDevice
  let palette: Tokens.Palette

  var body: some View {
    VStack(spacing: 10) {
      Text(ProvisionalUI.whatsAppScanTitle)
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
        .accessibilityAddTraits(.isHeader)
      WhatsAppQRPlaceholder(palette: palette)
      Text(ProvisionalUI.whatsAppScanSteps)
        .font(.system(size: 10))
        .foregroundStyle(Tokens.color(palette.ink))
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
      Text(ProvisionalUI.whatsAppSlotsLine)
        .font(.system(size: 9))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(16)
    .frame(width: ProvisionalUI.whatsAppRelinkCardWidth)
    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Tokens.color(palette.ink, opacity: 0.35), lineWidth: 1))
    .accessibilityElement(children: .contain)
    .accessibilityLabel(ProvisionalUI.whatsAppScanTitle)
    .accessibilityValue(state.rawValue)
    .accessibilityIdentifier(ShellID.whatsAppRelink)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

/// A QR frame: three finder squares drawn in ink round a dashed square,
/// and the words that say it is a placeholder.
struct WhatsAppQRPlaceholder: View {
  let palette: Tokens.Palette

  var body: some View {
    let side = ProvisionalUI.whatsAppQRSide
    ZStack {
      RoundedRectangle(cornerRadius: 6)
        .strokeBorder(Tokens.color(palette.inkDim), style: BubbleStroke.placeholder)
      Canvas { context, size in
        let finder = size.width * 0.22
        let inset = size.width * 0.08
        for origin in [
          CGPoint(x: inset, y: inset), CGPoint(x: size.width - inset - finder, y: inset),
          CGPoint(x: inset, y: size.height - inset - finder),
        ] {
          context.stroke(
            Path(CGRect(origin: origin, size: CGSize(width: finder, height: finder))),
            with: .color(Tokens.color(palette.ink)), lineWidth: 3)
          context.fill(
            Path(CGRect(x: origin.x + finder * 0.3, y: origin.y + finder * 0.3, width: finder * 0.4, height: finder * 0.4)),
            with: .color(Tokens.color(palette.ink)))
        }
      }
      Text(ProvisionalUI.whatsAppQRPlaceholder)
        .font(.system(size: 9))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .multilineTextAlignment(.center)
        .frame(width: side * 0.5)
        .offset(x: side * 0.12, y: side * 0.12)
    }
    .frame(width: side, height: side)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(ProvisionalUI.whatsAppQRPlaceholder)
    .accessibilityAddTraits(.isImage)
    .accessibilityIdentifier(ShellID.whatsAppQR)
  }
}

/// The transcript, anchored to the bottom: the end-to-end line, the
/// history horizon (D-UI-143), board 02's day separators, and each turn as
/// board 03 draws it.
struct WhatsAppTranscript: View {
  @Bindable var model: ShellModel
  let thread: ThreadSummary
  let meta: WhatsAppThreadMeta
  let turns: [WhatsAppTurn]
  let palette: Tokens.Palette

  private var rows: [WhatsAppRow] {
    guard let asOf = model.thread.asOf, model.thread.guid == thread.chatGuid else { return [] }
    return WhatsAppThreadLayout.rows(
      turns, horizon: meta.historyHorizon, asOf: asOf, calendar: .current, isGroup: thread.isGroup,
      senderName: { WhatsAppThreadLayout.memberName($0, resolved: model.senderName(handle: $0)) })
  }

  var body: some View {
    GeometryReader { geometry in
      let maxWidth = TranscriptLayout.maxBubbleWidth(paneWidth: geometry.size.width)
      ScrollView {
        VStack(spacing: 0) {
          ForEach(rows) { row in
            switch row {
            case .encrypted:
              SystemLine(text: ProvisionalUI.whatsAppE2ELine, palette: palette)
                .accessibilityLabel(ProvisionalUI.whatsAppE2ELine)
                .accessibilityIdentifier(ShellID.whatsAppEncrypted)
            case .horizon(let line):
              WhatsAppHorizon(line: line, palette: palette)
            case .day(let id, let label):
              DaySeparator(label: label, palette: palette)
                .accessibilityIdentifier(ShellID.dayPrefix + id)
            case .turn(let bubble, let turn):
              WhatsAppTurnRow(bubble: bubble, turn: turn, title: thread.title, maxWidth: maxWidth, palette: palette)
            }
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

/// D-UI-143: where the history this Mac holds begins, centred, with the
/// partial history caveat.
struct WhatsAppHorizon: View {
  let line: String
  let palette: Tokens.Palette

  var body: some View {
    VStack(spacing: 2) {
      Text(line)
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
      Text(ProvisionalUI.whatsAppHorizonDetail)
        .font(.system(size: 9))
        .foregroundStyle(Tokens.color(palette.inkDim))
    }
    .multilineTextAlignment(.center)
    .frame(maxWidth: .infinity)
    .padding(.vertical, 8)
    .overlay(alignment: .top) {
      Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.3)).frame(height: 0.5).accessibilityHidden(true)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(line + " " + ProvisionalUI.whatsAppHorizonDetail)
    .accessibilityIdentifier(ShellID.whatsAppHorizon)
  }
}

/// One turn: a bubble (a voice note in board 08's specimen body), a media
/// tile never fetched, or a not-shown card, with its reactions under it.
struct WhatsAppTurnRow: View {
  let bubble: TranscriptLayout.Bubble
  let turn: WhatsAppTurn
  let title: String
  let maxWidth: Double
  let palette: Tokens.Palette

  private var outbound: Bool { turn.turn.direction == .outbound }
  private var guid: String { turn.turn.guid }

  var body: some View {
    VStack(alignment: outbound ? .trailing : .leading, spacing: 4) {
      switch turn.display {
      case .bubble:
        if case .voice(let transcript, let seconds) = turn.turn.kind {
          voice(transcript: transcript, seconds: seconds)
        } else {
          BubbleView(bubble: bubble, sms: false, title: title, maxWidth: maxWidth, palette: palette)
            .accessibilityIdentifier(ShellID.bubblePrefix + guid)
        }
      case .onDemand(let kind, let bytes):
        sender
        WhatsAppMediaTile(guid: guid, kind: kind, bytes: bytes, palette: palette)
          .padding(.top, bubble.gap)
      case .notShown(let hidden):
        sender
        WhatsAppNotShownCard(guid: guid, hidden: hidden, palette: palette)
          .padding(.top, bubble.gap)
      }
      if !turn.meta.reactions.isEmpty {
        ReactionRow(
          guid: guid, reactions: turn.meta.reactions.map { MessageTurn.Reaction(glyph: $0.emoji, count: $0.count) },
          ink: Tokens.color(palette.ink), fill: Tokens.color(WhatsAppLook.reactionFill))
      }
    }
    .frame(maxWidth: .infinity, alignment: outbound ? .trailing : .leading)
  }

  @ViewBuilder private var sender: some View {
    if let name = bubble.senderName {
      Text(name)
        .font(.system(size: 9, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .padding(.horizontal, 12)
    }
  }

  /// D-UI-145: the transcript and the duration in board 08's voice body; a
  /// sent note adds that its played state is unknown here.
  private func voice(transcript: String?, seconds: Int?) -> some View {
    let duration = SpecimenText.duration(seconds ?? 0)
    let words = transcript ?? ProvisionalUI.whatsAppVoiceNoTranscript
    let spoken = [duration, words, outbound ? ProvisionalUI.whatsAppVoicePlayed : nil].compactMap { $0 }
    return VStack(alignment: outbound ? .trailing : .leading, spacing: 2) {
      BubbleView(bubble: bubble, sms: false, title: title, maxWidth: maxWidth, palette: palette, style: .specimen)
        .accessibilityIdentifier(ShellID.bubblePrefix + guid)
      if outbound {
        Text(ProvisionalUI.whatsAppVoicePlayed)
          .font(.system(size: 9))
          .foregroundStyle(Tokens.color(palette.inkDim))
          .accessibilityHidden(true)
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(spoken.joined(separator: ", "))
    .accessibilityIdentifier(ShellID.whatsAppVoicePrefix + guid)
  }
}

/// D-UI-149: media the phone has not sent. A dashed tile with a down arrow,
/// its kind and size; pressing it says why nothing happened. It never
/// fetches, and it has no play glyph or duration.
struct WhatsAppMediaTile: View {
  let guid: String
  let kind: WhatsAppMediaKind
  let bytes: Int?
  let palette: Tokens.Palette
  @State private var asked = false

  private var caption: String {
    let word = kind == .video ? "Video" : "Photo"
    return bytes.map { word + " \u{00B7} " + SpecimenText.size($0) } ?? word
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Button {
        asked = true
      } label: {
        HStack(spacing: 8) {
          Text(ProvisionalUI.whatsAppMediaArrow)
            .font(.system(size: 15, weight: .semibold))
            .accessibilityHidden(true)
          Text(caption)
            .font(.system(size: 11, weight: .medium))
        }
        .foregroundStyle(Tokens.color(palette.ink))
        .padding(.vertical, 12)
        .padding(.horizontal, 14)
        .frame(minWidth: 170, alignment: .leading)
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Tokens.color(palette.ink), style: BubbleStroke.placeholder))
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .focusable()
      .accessibilityLabel(caption)
      .accessibilityIdentifier(ShellID.whatsAppMediaPrefix + guid)
      if asked {
        Text(ProvisionalUI.whatsAppMediaNote)
          .font(.system(size: 9))
          .foregroundStyle(Tokens.color(palette.inkDim))
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: 220, alignment: .leading)
          .accessibilityLabel(ProvisionalUI.whatsAppMediaNote)
          .accessibilityIdentifier(ShellID.whatsAppFetchNote)
      }
    }
  }
}

/// D-UI-147: a kind this board names and does not draw. A dashed card with
/// a title and a reason, and no control to open it.
struct WhatsAppNotShownCard: View {
  let guid: String
  let hidden: WhatsAppNotShown
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(hidden.title)
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
      Text(hidden.detail)
        .font(.system(size: 10))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(10)
    .frame(width: 260, alignment: .leading)
    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Tokens.color(palette.inkDim), style: BubbleStroke.placeholder))
    .accessibilityElement(children: .combine)
    .accessibilityLabel(hidden.title + ". " + hidden.detail)
    .accessibilityIdentifier(ShellID.whatsAppNotShownPrefix + guid)
  }
}

/// D-UI-144: the phone panel at the foot of the chat, where a composer
/// would be: the phone's state, WhatsApp's own sentence, and that nothing
/// sends from here.
struct WhatsAppPhonePanel: View {
  let phone: WhatsAppPhone
  let palette: Tokens.Palette

  private var line: String {
    switch phone {
    case .online: ProvisionalUI.whatsAppPhoneOnline
    case .offline: ProvisionalUI.whatsAppPhoneOffline
    case .unknown: ProvisionalUI.whatsAppPhoneUnknown
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(ProvisionalUI.whatsAppPhoneTitle)
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
      Text(line)
        .font(.system(size: 10))
        .foregroundStyle(Tokens.color(palette.ink))
      Text(ProvisionalUI.whatsAppPhoneQuote)
        .font(.system(size: 10))
        .italic()
        .foregroundStyle(Tokens.color(palette.inkDim))
      Text(ProvisionalUI.whatsAppReadsOnly)
        .font(.system(size: 10))
        .foregroundStyle(Tokens.color(palette.inkDim))
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(10)
    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Tokens.color(palette.inkDim, opacity: 0.5), lineWidth: 1))
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .overlay(alignment: .top) {
      Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.2)).frame(height: 0.5).accessibilityHidden(true)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(ProvisionalUI.whatsAppPhoneTitle + ": " + line + " " + ProvisionalUI.whatsAppReadsOnly)
    .accessibilityIdentifier(ShellID.whatsAppPhone)
  }
}
