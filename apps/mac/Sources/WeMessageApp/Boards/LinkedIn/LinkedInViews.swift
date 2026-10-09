import SwiftUI
import WeMessageKit

// v2 B3, board 04 over fixtures: LinkedIn. Top to bottom: the channel
// banner whose scope opens the inbox switch (04.E), the Focused and Other
// tabs while the tile is selected (04.A), the pause banner while LinkedIn
// pushes back (04.H), then the open thread or the empty state. A thread is
// its head, the transcript with the InMail and commercial cards (04.C,
// 04.F), and at its foot the composer its step of the ladder allows (04.B)
// or the reason there is none (04.D). Make draft ends in a pending draft;
// nothing on this board sends. Monochrome plus the one blue tint.

/// Board 04: the empty board while no LinkedIn thread is open, or the open
/// thread, under the same banner.
struct LinkedInPane: View {
  let model: ShellModel
  let board: LinkedInBoardModel
  let thread: ThreadSummary?
  let palette: Tokens.Palette

  private var status: LinkedInStatusMeta { model.linkedInStatus }

  var body: some View {
    VStack(spacing: 0) {
      LinkedInBanner(model: model, board: board, palette: palette)
      if model.scope == .linkedin {
        LinkedInTabs(desk: model.linkedIn, palette: palette)
      }
      if status.paused {
        LinkedInPauseBanner(until: status.pausedUntil, palette: palette)
      }
      if let thread {
        LinkedInThreadPane(model: model, thread: thread, palette: palette)
      } else {
        empty
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier(ShellID.linkedInBoard)
  }

  private var empty: some View {
    VStack(spacing: 8) {
      Text(board.headline)
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
        .multilineTextAlignment(.center)
        .accessibilityLabel(board.headline)
        .accessibilityAddTraits([.isHeader, .isStaticText])
        .accessibilityIdentifier(ShellID.linkedInEmpty)
      Text(board.detail)
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityLabel(board.detail)
        .accessibilityAddTraits(.isStaticText)
    }
    .frame(maxWidth: 360)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

/// D-UI-160: the banner in boards 03 and 05's register. Its line is the
/// inbox switch: pressing it opens the popover of D-UI-161.
struct LinkedInBanner: View {
  let model: ShellModel
  let board: LinkedInBoardModel
  let palette: Tokens.Palette

  private var shown: Binding<Bool> {
    Binding(get: { model.linkedIn.switchShown }, set: { model.linkedIn.switchShown = $0 })
  }

  var body: some View {
    HStack(spacing: 10) {
      Button {
        model.linkedIn.switchShown.toggle()
      } label: {
        Text(board.banner + " " + ProvisionalUI.linkedInSwitchMark)
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.ink))
          .lineLimit(1)
          .truncationMode(.tail)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .focusable()
      .accessibilityLabel(board.banner)
      .accessibilityValue(board.scope)
      .accessibilityIdentifier(ShellID.linkedInBanner)
      .popover(isPresented: shown, arrowEdge: .bottom) {
        LinkedInInboxSwitch(model: model, palette: palette)
      }
      Spacer(minLength: 8)
      if let chip = board.chip {
        BoardChip(text: chip, palette: palette)
      }
    }
    .padding(.horizontal, 12)
    .frame(height: KillBanner.height)
    .frame(maxWidth: .infinity)
    .background(Tokens.color(palette.layer1))
    .overlay(alignment: .leading) { Rectangle().fill(Tokens.color(Tokens.tint)).frame(width: 3).accessibilityHidden(true) }
  }
}

/// D-UI-161: All 3 inboxes, then each inbox with its thread count. The
/// one shown is marked on.
struct LinkedInInboxSwitch: View {
  let model: ShellModel
  let palette: Tokens.Palette

  var body: some View {
    let counts = LinkedInRoute.counts(model.threads?.threads ?? [])
    let all = counts.values.reduce(0, +)
    VStack(alignment: .leading, spacing: 2) {
      Text(ProvisionalUI.linkedInSwitchTitle)
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .padding(.horizontal, 8)
        .padding(.bottom, 4)
      row(nil, title: ProvisionalUI.linkedInInboxRow(ProvisionalUI.linkedInAllInboxes, threads: all), id: "all")
      ForEach(LinkedInInbox.allCases, id: \.self) { inbox in
        row(inbox, title: ProvisionalUI.linkedInInboxRow(inbox.title, threads: counts[inbox] ?? 0), id: inbox.rawValue)
      }
    }
    .padding(10)
    .frame(minWidth: 220, alignment: .leading)
    .accessibilityElement(children: .contain)
    .accessibilityLabel(ProvisionalUI.linkedInSwitchTitle)
    .accessibilityIdentifier(ShellID.linkedInSwitch)
  }

  private func row(_ inbox: LinkedInInbox?, title: String, id: String) -> some View {
    let on = model.linkedIn.filter.inbox == inbox
    return Button {
      model.linkedIn.setInbox(inbox)
    } label: {
      HStack(spacing: 6) {
        Rectangle().fill(Tokens.color(Tokens.tint, opacity: on ? 1 : 0)).frame(width: 3, height: 14)
          .accessibilityHidden(true)
        Text(title)
          .font(.system(size: 12, weight: on ? .semibold : .regular))
          .foregroundStyle(Tokens.color(palette.ink))
        Spacer(minLength: 0)
      }
      .padding(.vertical, 4)
      .padding(.horizontal, 6)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(title)
    .accessibilityValue(on ? "on" : "off")
    .accessibilityAddTraits(on ? .isSelected : [])
    .accessibilityIdentifier(ShellID.linkedInInboxPrefix + id)
  }
}

/// D-UI-137: Focused and Other as two capsules, left-aligned under the
/// banner, with nothing drawn across the rest of the pane.
struct LinkedInTabs: View {
  let desk: LinkedInDesk
  let palette: Tokens.Palette

  var body: some View {
    HStack(spacing: 4) {
      ForEach(LinkedInCategory.allCases, id: \.self) { category in
        let on = desk.filter.category == category
        Button {
          desk.setCategory(category)
        } label: {
          Text(category.title)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(Tokens.color(on ? palette.layer1 : palette.ink))
            .fixedSize()
            .padding(.vertical, 4)
            .padding(.horizontal, 10)
            .background(Capsule().fill(Tokens.color(on ? palette.ink : palette.layer1)))
            .overlay(Capsule().strokeBorder(Tokens.color(palette.inkDim, opacity: on ? 0 : 0.4), lineWidth: 1))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(category.title)
        .accessibilityValue(on ? "on" : "off")
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier(ShellID.linkedInTabPrefix + category.rawValue)
      }
      Spacer(minLength: 0)
    }
    .padding(.vertical, 6)
    .padding(.horizontal, 12)
    .accessibilityElement(children: .contain)
    .accessibilityLabel(ProvisionalUI.linkedInCategoriesLabel)
    .accessibilityIdentifier(ShellID.linkedInTabs)
  }
}

/// D-UI-169: LinkedIn pushing back. A blocking line in the danger colour
/// across the board; reading goes on under it.
struct LinkedInPauseBanner: View {
  let until: Date?
  let palette: Tokens.Palette

  private var line: String { ProvisionalUI.linkedInPausedLine(until: until.map { ShellText.shortClock($0) }) }

  var body: some View {
    Text(line)
      .font(.system(size: 11, weight: .semibold))
      .foregroundStyle(Tokens.color(palette.ink))
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.vertical, 8)
      .padding(.leading, 15)
      .padding(.trailing, 12)
      .background(Tokens.color(Tokens.danger, opacity: 0.12))
      .overlay(alignment: .leading) {
        Rectangle().fill(Tokens.color(Tokens.danger)).frame(width: 3).accessibilityHidden(true)
      }
      .accessibilityLabel(line)
      .accessibilityValue("paused")
      .accessibilityAddTraits(.isStaticText)
      .accessibilityIdentifier(ShellID.linkedInPaused)
  }
}

/// An open LinkedIn thread: the head, the transcript, and its foot.
struct LinkedInThreadPane: View {
  let model: ShellModel
  let thread: ThreadSummary
  let palette: Tokens.Palette

  private var meta: LinkedInThreadMeta { LinkedInThreadMeta(thread) }

  /// D-UI-162: where a reply goes, the degree and the headline.
  private var subline: String {
    [ProvisionalUI.linkedInReplyingVia(LinkedInRoute.replyInbox(meta).title), meta.degree, meta.headline]
      .compactMap { $0 }.joined(separator: " \u{00B7} ")
  }

  var body: some View {
    VStack(spacing: 0) {
      ThreadHeader(
        thread: thread, image: model.avatars.image(for: thread), asOf: model.thread.asOf, subline: subline,
        palette: palette
      ) {
        model.inspectorShown.toggle()
      }
      Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.2)).frame(height: 0.5).accessibilityHidden(true)
      LinkedInTranscript(model: model, thread: thread, palette: palette)
      LinkedInFoot(model: model, thread: thread, meta: meta, palette: palette)
    }
    .task(id: model.selectedThread) { await model.thread.open(model.selectedThread) }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityElement(children: .contain)
    .accessibilityLabel(thread.title)
    .accessibilityIdentifier(ShellID.linkedInThread)
  }
}

/// The transcript, anchored to the bottom: board 02's day separators and
/// bubbles, with an InMail or a commercial payload drawn as its card.
struct LinkedInTranscript: View {
  let model: ShellModel
  let thread: ThreadSummary
  let palette: Tokens.Palette

  private var page: ThreadMessagesPage? {
    guard model.thread.guid == thread.chatGuid, case .loaded(let page) = model.thread.load,
      page.chatGuid == thread.chatGuid
    else { return nil }
    return page
  }

  var body: some View {
    let page = page
    let metas = Dictionary(
      (page?.turns ?? []).map { ($0.guid, LinkedInTurnMeta($0)) }, uniquingKeysWith: { first, _ in first })
    let rows: [TranscriptLayout.Row] =
      if let page, let asOf = model.thread.asOf {
        TranscriptLayout.rows(MessageTurn.turns(page), asOf: asOf, calendar: .current, isGroup: false)
      } else { [] }
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
              LinkedInTurnRow(
                bubble: bubble, display: metas[bubble.turn.guid].map(LinkedInDisplay.of) ?? .bubble,
                inMail: metas[bubble.turn.guid]?.inMail, title: thread.title, maxWidth: maxWidth, palette: palette)
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

/// One turn: a bubble, an InMail card or a commercial card, on its side.
struct LinkedInTurnRow: View {
  let bubble: TranscriptLayout.Bubble
  let display: LinkedInDisplay
  /// The InMail form a commercial payload arrived in, for its subject.
  let inMail: LinkedInInMail?
  let title: String
  let maxWidth: Double
  let palette: Tokens.Palette

  private var outbound: Bool { bubble.turn.direction == .outbound }
  private var guid: String { bubble.turn.guid }

  var body: some View {
    Group {
      switch display {
      case .bubble:
        BubbleView(bubble: bubble, sms: false, title: title, maxWidth: maxWidth, palette: palette)
          .accessibilityIdentifier(ShellID.bubblePrefix + guid)
      case .inMail(let mail):
        LinkedInInMailCard(guid: guid, mail: mail, text: bubble.turn.text, outbound: outbound, palette: palette)
          .padding(.top, bubble.gap)
      case .commercial(let payload):
        LinkedInCommercialCard(
          guid: guid, payload: payload, subject: inMail?.subject, text: bubble.turn.text, palette: palette
        )
        .padding(.top, bubble.gap)
      }
    }
    .frame(maxWidth: .infinity, alignment: outbound ? .trailing : .leading)
  }
}

/// D-UI-164: an InMail on its sender's side: the tag, the subject over the
/// body, and what it cost. One element, its cost as its value.
struct LinkedInInMailCard: View {
  let guid: String
  let mail: LinkedInInMail
  let text: String?
  let outbound: Bool
  let palette: Tokens.Palette

  var body: some View {
    let cost = ProvisionalUI.linkedInInMailCost(mail.credits)
    VStack(alignment: .leading, spacing: 5) {
      LinkedInTag(text: ProvisionalUI.linkedInInMailTag, palette: palette)
      Text(mail.subject)
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
        .fixedSize(horizontal: false, vertical: true)
      if let text, !text.isEmpty {
        Text(text)
          .font(.system(size: 13))
          .foregroundStyle(Tokens.color(palette.ink))
          .fixedSize(horizontal: false, vertical: true)
      }
      Text(cost)
        .font(.system(size: 10))
        .foregroundStyle(Tokens.color(palette.inkDim))
    }
    .padding(12)
    .frame(width: 300, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 12).fill(Tokens.color(palette.layer1)))
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Tokens.color(palette.inkDim, opacity: 0.35), lineWidth: 1))
    .overlay(alignment: outbound ? .trailing : .leading) {
      Rectangle().fill(Tokens.color(Tokens.tint)).frame(width: 3).padding(.vertical, 8).accessibilityHidden(true)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(mail.subject)
    .accessibilityValue(cost)
    .accessibilityIdentifier(ShellID.linkedInInMailPrefix + guid)
  }
}

/// D-UI-166: a commercial payload as a card. The recruiter's templated
/// answers are drawn inert; a job application's file is never fetched.
struct LinkedInCommercialCard: View {
  let guid: String
  let payload: LinkedInCommercial
  let subject: String?
  let text: String?
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      LinkedInTag(text: payload.kind.tag, palette: palette)
      ForEach([subject, payload.title].compactMap { $0 }, id: \.self) { line in
        Text(line)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.ink))
          .fixedSize(horizontal: false, vertical: true)
      }
      if let detail = payload.detail {
        Text(detail)
          .font(.system(size: 11))
          .foregroundStyle(Tokens.color(palette.inkDim))
          .fixedSize(horizontal: false, vertical: true)
      }
      if let text, !text.isEmpty {
        Text(text)
          .font(.system(size: 13))
          .foregroundStyle(Tokens.color(palette.ink))
          .fixedSize(horizontal: false, vertical: true)
      }
      extra
    }
    .padding(12)
    .frame(width: 320, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 12).fill(Tokens.color(palette.layer1)))
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Tokens.color(palette.inkDim, opacity: 0.35), lineWidth: 1))
    .accessibilityElement(children: .combine)
    .accessibilityLabel([payload.kind.tag, subject ?? payload.title].compactMap { $0 }.joined(separator: ", "))
    .accessibilityValue(payload.kind.rawValue)
    .accessibilityIdentifier(ShellID.linkedInCommercialPrefix + guid)
  }
}

extension LinkedInCommercialCard {
  /// What a kind adds under the body: the recruiter's inert answers, or the
  /// job application's file, never fetched.
  @ViewBuilder var extra: some View {
    switch payload.kind {
    case .recruiter:
      LinkedInInertPair(
        first: ProvisionalUI.linkedInInterestedLabel, second: ProvisionalUI.linkedInNoThanksLabel,
        reason: ProvisionalUI.linkedInTemplated, palette: palette)
    case .job:
      VStack(alignment: .leading, spacing: 4) {
        if let file = payload.file {
          fileBox(file)
        }
        Text(ProvisionalUI.linkedInNotFetched)
          .font(.system(size: 10))
          .foregroundStyle(Tokens.color(palette.inkDim))
          .fixedSize(horizontal: false, vertical: true)
      }
    case .sponsored:
      EmptyView()
    }
  }

  private func fileBox(_ file: String) -> some View {
    let size: String = SizeText.megabytes(payload.fileBytes)
    let name: String = file + " \u{00B7} " + size
    return Text(name)
      .font(.system(size: 11, weight: .medium))
      .foregroundStyle(Tokens.color(palette.ink))
      .padding(.vertical, 6)
      .padding(.horizontal, 10)
      .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Tokens.color(palette.inkDim), style: BubbleStroke.placeholder))
  }
}

/// A small capsule tag (INMAIL, SPONSORED, RECRUITER, JOB) in the tint.
struct LinkedInTag: View {
  let text: String
  let palette: Tokens.Palette

  var body: some View {
    Text(text)
      .font(.system(size: 8, weight: .bold, design: .monospaced))
      .foregroundStyle(Tokens.color(palette.ink))
      .padding(.vertical, 2)
      .padding(.horizontal, 6)
      .background(Capsule().fill(Tokens.color(Tokens.tint, opacity: 0.18)))
      .fixedSize()
  }
}

/// Two controls drawn and inert with the reason beside them, read as one
/// element (the hold pattern of D-UI-139): nothing here can be pressed.
struct LinkedInInertPair: View {
  let first: String
  let second: String
  let reason: String
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 6) {
        ForEach([first, second], id: \.self) { title in
          Text(title)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(Tokens.color(palette.inkDim))
            .padding(.vertical, 4)
            .padding(.horizontal, 10)
            .overlay(Capsule().strokeBorder(Tokens.color(palette.inkDim), style: StrokeStyle(lineWidth: 1, dash: [3, 3])))
        }
      }
      Text(reason)
        .font(.system(size: 10))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .fixedSize(horizontal: false, vertical: true)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(first + ", " + second)
    .accessibilityValue(reason)
    .disabled(true)
  }
}

/// The thread's foot: the composer its step allows, or the reason there is
/// none, with the request card or the ad's inert controls above it.
struct LinkedInFoot: View {
  let model: ShellModel
  let thread: ThreadSummary
  let meta: LinkedInThreadMeta
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      switch model.linkedInComposer(thread) {
      case .composer(let rung):
        LinkedInComposerView(model: model, thread: thread, rung: rung, degree: meta.degree, palette: palette)
          .id(thread.chatGuid)
      case .absent(let reason):
        if reason == .requestPending {
          LinkedInRequestCard(shared: meta.shared, palette: palette)
        }
        if reason == .sponsored {
          LinkedInInertPair(
            first: ProvisionalUI.linkedInDeleteLabel, second: ProvisionalUI.linkedInReportLabel,
            reason: ProvisionalUI.linkedInAdInert, palette: palette)
        }
        Text(line(reason))
          .font(.system(size: 11, weight: reason == .paused ? .semibold : .regular))
          .foregroundStyle(Tokens.color(reason == .paused ? palette.ink : palette.inkDim))
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading)
          .accessibilityLabel(line(reason))
          .accessibilityValue(reason.rawValue)
          .accessibilityAddTraits(.isStaticText)
          .accessibilityIdentifier(ShellID.linkedInNoComposer)
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .overlay(alignment: .top) {
      Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.2)).frame(height: 0.5).accessibilityHidden(true)
    }
  }

  private func line(_ reason: LinkedInComposer.Reason) -> String {
    switch reason {
    case .sponsored: ProvisionalUI.linkedInSponsoredLine
    case .paused: ProvisionalUI.linkedInPausedComposer
    case .requestPending: ProvisionalUI.linkedInRequestNoComposer
    case .requestDeclined: ProvisionalUI.linkedInDeclinedLine
    case .noRung: ProvisionalUI.linkedInNoRungLine
    }
  }
}

/// D-UI-165: a pending request in place of the composer.
struct LinkedInRequestCard: View {
  let shared: String?
  let palette: Tokens.Palette

  var body: some View {
    let line = ProvisionalUI.linkedInRequestLine(shared)
    VStack(alignment: .leading, spacing: 6) {
      Text(ProvisionalUI.linkedInRequestTitle)
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
      Text(line)
        .font(.system(size: 11))
        .foregroundStyle(Tokens.color(palette.ink))
        .fixedSize(horizontal: false, vertical: true)
      LinkedInInertPair(
        first: ProvisionalUI.linkedInAcceptLabel, second: ProvisionalUI.linkedInDeclineLabel,
        reason: ProvisionalUI.linkedInRequestInert, palette: palette)
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 10).fill(Tokens.color(palette.layer1)))
    .overlay(alignment: .leading) {
      Rectangle().fill(Tokens.color(Tokens.tint)).frame(width: 3).accessibilityHidden(true)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(ProvisionalUI.linkedInRequestTitle)
    .accessibilityValue(line)
    .accessibilityIdentifier(ShellID.linkedInRequest)
  }
}

/// D-UI-168: the composer for one step of the ladder. The InMail steps
/// carry a subject; both fields stop at the caps and print what is left.
/// Make draft is the only control that writes, and it writes a draft.
struct LinkedInComposerView: View {
  let model: ShellModel
  let thread: ThreadSummary
  let rung: LinkedInRung
  let degree: String?
  let palette: Tokens.Palette
  @State private var subject = ""
  @State private var text = ""

  private var phase: LinkedInDraftPhase { model.linkedIn.phase(thread.chatGuid) }
  private var capped: Bool { rung.hasSubject }
  private var canDraft: Bool {
    !phase.busy && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  private var pacing: String? {
    let status = model.linkedInStatus
    guard let left = status.sendsLeft, let asOf = status.asOf else { return nil }
    return ProvisionalUI.linkedInPacing(
      left: left, clock: ShellText.shortClock(asOf), resets: status.resetsAt.map { ShellText.shortClock($0) })
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(ProvisionalUI.linkedInComposerMeta(rung.rawValue, degree: degree))
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.inkDim))
      if rung.hasSubject {
        HStack(spacing: 8) {
          TextField(ProvisionalUI.linkedInSubjectLabel, text: $subject)
            .textFieldStyle(.plain)
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(Tokens.color(palette.ink))
            .disabled(phase.busy)
            .accessibilityLabel(ProvisionalUI.linkedInSubjectLabel)
            .accessibilityIdentifier(ShellID.linkedInComposeSubject)
          counter(subject, cap: LinkedInCaps.subject)
        }
        .padding(.vertical, 2)
        .overlay(alignment: .bottom) {
          Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.2)).frame(height: 0.5).accessibilityHidden(true)
        }
      }
      ZStack(alignment: .topLeading) {
        if text.isEmpty {
          Text(ProvisionalUI.linkedInBodyPrompt)
            .font(.system(size: 13))
            .foregroundStyle(Tokens.color(palette.inkDim))
            .padding(.horizontal, 11)
            .padding(.vertical, 6)
            .accessibilityHidden(true)
        }
        TextEditor(text: $text)
          .font(.system(size: 13))
          .foregroundStyle(Tokens.color(palette.ink))
          .scrollContentBackground(.hidden)
          .padding(6)
          .disabled(phase.busy)
          .background(KeyboardClaim(token: model.lens == .recent ? "linkedin-" + thread.chatGuid : nil))
          .accessibilityLabel(ProvisionalUI.linkedInBodyPrompt)
          .accessibilityIdentifier(ShellID.linkedInComposeBody)
      }
      .frame(minHeight: 56, maxHeight: 120)
      .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
      if capped {
        HStack {
          Spacer(minLength: 0)
          counter(text, cap: LinkedInCaps.body)
        }
      }
      Text(ProvisionalUI.linkedInHoldLine)
        .font(.system(size: 10))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityLabel(ProvisionalUI.linkedInHoldLine)
        .accessibilityAddTraits(.isStaticText)
        .accessibilityIdentifier(ShellID.linkedInComposeHold)
      if let pacing {
        Text(pacing)
          .font(.system(size: 10))
          .foregroundStyle(Tokens.color(palette.inkDim))
          .accessibilityLabel(pacing)
          .accessibilityAddTraits(.isStaticText)
          .accessibilityIdentifier(ShellID.linkedInComposePacing)
      }
      HStack(spacing: 8) {
        SettingsButton(title: ProvisionalUI.linkedInDraftLabel, palette: palette, id: ShellID.linkedInComposeDraft) {
          let body = text
          Task { await model.draftLinkedIn(body: body) }
        }
        .disabled(!canDraft)
        .opacity(canDraft ? 1 : 0.55)
        .accessibilityValue(canDraft ? "enabled" : "inert")
        Text(phase.line)
          .font(.system(size: 11))
          .foregroundStyle(Tokens.color(palette.inkDim))
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityLabel(phase.line)
          .accessibilityValue(phase.value)
          .accessibilityIdentifier(ShellID.linkedInComposeState)
        Spacer(minLength: 0)
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 10).fill(Tokens.color(palette.layer1)))
    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Tokens.color(Tokens.tint), style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
    .onChange(of: subject) { _, value in
      let kept = LinkedInCaps.clamp(value, LinkedInCaps.subject)
      if kept != value { subject = kept }
    }
    .onChange(of: text) { _, value in
      guard capped else { return }
      let kept = LinkedInCaps.clamp(value, LinkedInCaps.body)
      if kept != value { text = kept }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier(ShellID.linkedInCompose)
  }

  private func counter(_ value: String, cap: Int) -> some View {
    Text(ProvisionalUI.linkedInLeft(LinkedInCaps.left(value, cap), of: cap))
      .font(.system(size: 10, design: .monospaced))
      .foregroundStyle(Tokens.color(palette.inkDim))
      .fixedSize()
  }
}
