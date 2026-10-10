import SwiftUI
import WeMessageKit

// Boards 06 and 09: the queue's surfaces. Every verb here is absent, never
// greyed, when its gate refuses (06.F, 09.F): a control that cannot act is
// not drawn. Nothing here reaches the client; approvals go through the
// shell model to Outbound, and Done, Snooze and Mute go through the
// QueueStateStore, which writes them to the daemon (v2 F3).

extension QueueReason {
  /// D-UI-190: the row's reason line.
  var line: String {
    switch self {
    case .ruleFired(let name): ProvisionalUI.ruleLine(name)
    case .agentFlag(let text): ProvisionalUI.agentFlagLine(text)
    case .pendingDraft: ProvisionalUI.draftReady
    }
  }
}

/// D-UI-191: the one static line a write the daemon did not take draws at
/// the queue foot, for ProvisionalUI.threadStateFailureSeconds. Never a
/// saved line (D-UI-192).
struct ThreadStateFailureLine: View {
  let text: String
  let palette: Tokens.Palette

  var body: some View {
    Text(text)
      .font(.system(size: 11))
      .foregroundStyle(Tokens.color(palette.inkDim))
      .lineLimit(2)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 12)
      .padding(.vertical, 6)
      .accessibilityIdentifier(ShellID.threadStateFailure)
  }
}

/// Triage's list header (06.C): the dated counter and a burn-down bar that
/// shrinks as the queue empties. No percentage: the count is the measure.
struct TriageBar: View {
  let model: ShellModel
  let palette: Tokens.Palette

  private var remaining: Int { model.scopedQueue.count }

  /// The bar's filled share: what is left of the queue Triage began with.
  private var share: Double {
    guard let start = model.queue.triageStart, start > 0 else { return remaining > 0 ? 1 : 0 }
    return min(1, Double(remaining) / Double(start))
  }

  var body: some View {
    let sentence = model.counterSentence ?? ""
    VStack(alignment: .leading, spacing: 6) {
      Text(sentence.isEmpty ? "Triage" : sentence)
        .font(.system(size: 11, weight: .bold, design: .monospaced))
        .foregroundStyle(Tokens.color(palette.ink))
        .lineLimit(1)
      GeometryReader { geometry in
        ZStack(alignment: .leading) {
          Capsule().fill(Tokens.color(palette.inkDim, opacity: 0.2))
          Capsule().fill(Tokens.color(palette.ink)).frame(width: geometry.size.width * share)
        }
      }
      .frame(height: 4)
      .accessibilityHidden(true)
    }
    .padding(.vertical, 8)
    .padding(.horizontal, 12)
    // A group that contains its sentence, as the bulk strip is: an ignored
    // element has no role, and the audit flags it (run 37717485936).
    .accessibilityElement(children: .contain)
    .accessibilityLabel(sentence.isEmpty ? "Triage" : sentence)
    .accessibilityIdentifier(ShellID.triageBar)
  }
}

/// Needs You's strip (09.D): how many are left, how many opened drafts the
/// bulk approve would take and how many it skips, the bulk button and the
/// audit entry (D-UI-49). The bulk button is absent under the kill switch
/// and when no opened draft is eligible.
struct BulkStrip: View {
  @Bindable var model: ShellModel
  let palette: Tokens.Palette

  var body: some View {
    let plan = model.bulkPlan
    let count = plan.included.count
    VStack(alignment: .leading, spacing: 6) {
      if let sentence = model.counterSentence {
        Text(sentence)
          .font(.system(size: 11, weight: .bold, design: .monospaced))
          .foregroundStyle(Tokens.color(palette.ink))
          .lineLimit(1)
      }
      Text(
        "Approve all (\u{21E7}A) enabled for \(count) opened draft\(count == 1 ? "" : "s") \u{00B7} \(plan.unopened) unopened skipped. Open a draft to include it."
      )
      .font(.system(size: 10))
      .foregroundStyle(Tokens.color(palette.inkDim))
      .fixedSize(horizontal: false, vertical: true)
      HStack(spacing: 8) {
        if count > 0 && model.killSwitch == false {
          QueueButton(title: "Approve \(count)", key: "\u{21E7}A", filled: true, palette: palette) {
            model.bulkSheetShown = true
          }
          .accessibilityLabel("Approve \(count) opened drafts")
          .accessibilityIdentifier(ShellID.bulkOpen)
        }
        QueueButton(title: "Audit", key: nil, filled: false, palette: palette) {
          model.bulkSheetShown = false
          model.auditShown = true
        }
        .accessibilityLabel("Audit")
        .accessibilityIdentifier(ShellID.auditOpen)
        Spacer(minLength: 0)
      }
    }
    .padding(.vertical, 8)
    .padding(.horizontal, 12)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Bulk approve")
    .accessibilityIdentifier(ShellID.bulkStrip)
  }
}

/// The batch's one undo (09.D): a ring that drains over the window and
/// "Undo all N". Z takes the whole batch back; there is no chord here.
struct UndoRing: View {
  let model: ShellModel
  let palette: Tokens.Palette

  var body: some View {
    let batch = model.outbound.countingBatch
    let first = batch.first
    let remaining: Int = {
      guard let first, case .counting(let left) = first.phase else { return 0 }
      return left
    }()
    let window = max(1, first?.window ?? 1)
    Button {
      model.undoLast()
    } label: {
      HStack(spacing: 8) {
        ZStack {
          Circle().stroke(Tokens.color(palette.inkDim, opacity: 0.25), lineWidth: 3)
          Circle()
            .trim(from: 0, to: Double(remaining) / Double(window))
            .stroke(Tokens.color(palette.ink), style: StrokeStyle(lineWidth: 3, lineCap: .round))
            .rotationEffect(.degrees(-90))
        }
        .frame(width: 18, height: 18)
        Text("Undo all \(batch.count) \u{00B7} \(remaining)s")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.ink))
        Text("Z")
          .font(.system(size: 9, design: .monospaced))
          .foregroundStyle(Tokens.color(palette.inkDim))
          .accessibilityHidden(true)
        Spacer(minLength: 0)
      }
      .padding(.vertical, 6)
      .padding(.horizontal, 12)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .focusable()
    .accessibilityLabel("Undo all \(batch.count)")
    .accessibilityValue(String(remaining))
    .accessibilityIdentifier(ShellID.undoRing)
  }
}

/// One verb button with its keycap drawn (the keys are bound by TriageKeys,
/// not by the button).
struct QueueButton: View {
  let title: String
  let key: String?
  let filled: Bool
  let palette: Tokens.Palette
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 6) {
        Text(title)
          .font(.system(size: 11, weight: .semibold))
        if let key {
          Text(key)
            .font(.system(size: 9, design: .monospaced))
            .opacity(0.8)
            .accessibilityHidden(true)
        }
      }
      .foregroundStyle(filled ? Tokens.color(palette.layer1) : Tokens.color(palette.ink))
      .padding(.vertical, 6)
      .padding(.horizontal, 10)
      .background(RoundedRectangle(cornerRadius: 6).fill(filled ? Tokens.color(palette.ink) : Tokens.color(palette.layer1)))
      .overlay {
        RoundedRectangle(cornerRadius: 6).strokeBorder(Tokens.color(palette.ink), lineWidth: filled ? 0 : 1)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .focusable()
  }
}

/// The bulk confirm card (06.F, 09.D), in the content pane: what is
/// included, what is excluded and why, the channels, and the one window.
/// Bare Return approves here and only here (TriageKeys); Escape cancels.
struct BulkConfirmCard: View {
  @Bindable var model: ShellModel
  let palette: Tokens.Palette

  private func title(_ chatGuid: String) -> String {
    model.threads?.threads.first { $0.chatGuid == chatGuid }?.title ?? chatGuid
  }

  private func channel(_ chatGuid: String) -> String {
    isSMSChat(chatGuid) ? "SMS" : "iM"
  }

  var body: some View {
    let plan = model.bulkPlan
    let count = plan.included.count
    let seconds = model.outbound.approveSeconds
    let channels = Set(plan.included.map { channel($0.chatGuid) }).sorted()
    VStack(alignment: .leading, spacing: 10) {
      Text("Approve \(count) draft\(count == 1 ? "" : "s")")
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
        .accessibilityAddTraits(.isHeader)
      section("Includes")
      ForEach(plan.included, id: \.id) { draft in
        line("\(title(draft.chatGuid)) (\(channel(draft.chatGuid)))", dim: false)
          .accessibilityIdentifier(ShellID.bulkIncludedPrefix + draft.id)
      }
      if !plan.excluded.isEmpty {
        section("Excluded")
        ForEach(plan.excluded, id: \.draftId) { exclusion in
          line("\(title(exclusion.chatGuid)) \u{00B7} \(QueueStateStore.reasonText(exclusion.reason))", dim: true)
            .accessibilityIdentifier(ShellID.bulkExcludedPrefix + exclusion.draftId)
        }
      }
      if !channels.isEmpty {
        line("Channels: " + channels.joined(separator: ", "), dim: true)
      }
      line("One \(seconds)-second window for the whole batch. Undo reverts all of it.", dim: true)
      HStack(spacing: 8) {
        if count > 0 && model.killSwitch == false {
          QueueButton(title: "Approve \(count)", key: "RETURN", filled: true, palette: palette) {
            model.approveAll()
          }
          .accessibilityLabel("Approve \(count)")
          .accessibilityIdentifier(ShellID.bulkConfirm)
        }
        QueueButton(title: "Cancel", key: "ESC", filled: false, palette: palette) {
          model.bulkSheetShown = false
        }
        .accessibilityLabel("Cancel")
        .accessibilityIdentifier(ShellID.bulkCancel)
      }
    }
    .padding(16)
    .frame(maxWidth: 420, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 12).fill(Tokens.color(palette.layer1)))
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Approve \(count) drafts")
    .accessibilityIdentifier(ShellID.bulkSheet)
  }

  private func section(_ title: String) -> some View {
    Text(title.uppercased())
      .font(.system(size: 9, weight: .bold))
      .tracking(1.2)
      .foregroundStyle(Tokens.color(palette.inkDim))
      .accessibilityAddTraits(.isHeader)
  }

  private func line(_ words: String, dim: Bool) -> some View {
    Text(words)
      .font(.system(size: 12))
      .foregroundStyle(Tokens.color(dim ? palette.inkDim : palette.ink))
      .fixedSize(horizontal: false, vertical: true)
      .accessibilityLabel(words)
  }
}

/// The kill banner (09.F): an ink band over the content pane while the
/// switch is on, with the one way back, a click on Disengage (D-UI-50: no
/// chord). Reading keeps working under it.
struct KillBanner: View {
  let model: ShellModel
  let palette: Tokens.Palette

  static let height = CGFloat(FrostProbe.killBannerHeight)

  var body: some View {
    HStack(spacing: 10) {
      Text("\u{25A0} " + ProvisionalUI.killBannerLine)
        .font(.system(size: 11, weight: .bold))
        .foregroundStyle(Tokens.color(palette.layer1))
        .lineLimit(1)
        .truncationMode(.tail)
      Spacer(minLength: 8)
      Button {
        Task { await model.disengageKillSwitch() }
      } label: {
        Text("Disengage")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.layer1))
          .padding(.vertical, 3)
          .padding(.horizontal, 10)
          .overlay(Capsule().strokeBorder(Tokens.color(palette.layer1), lineWidth: 1))
          .contentShape(Capsule())
      }
      .buttonStyle(.plain)
      .focusable()
      .accessibilityLabel("Disengage")
      .accessibilityIdentifier(ShellID.killDisengage)
    }
    .padding(.horizontal, 12)
    .frame(height: Self.height)
    .frame(maxWidth: .infinity)
    .background(Tokens.color(palette.ink))
    .accessibilityElement(children: .contain)
    .accessibilityLabel(ProvisionalUI.killBannerLine)
    .accessibilityIdentifier(ShellID.killBanner)
  }
}

/// The zero screen (06.E, 17.H): which zero it is, said plainly. Clear is
/// one of three (earned, still clear, nothing arrived) drawn by ZeroPanel;
/// cannot say comes with the reason; not connected has nothing to count
/// and the iMessage card (D-UI-48). It stays on its channel (D-UI-52).
struct ZeroScreen: View {
  @Bindable var model: ShellModel
  let palette: Tokens.Palette
  /// When this screen appeared: the praise window's start (D-UI-129).
  @State private var appearedAt = Date()

  private var counter: ShellBoard.Counter { model.board.counter(model.scope) }

  /// The clear zero's words at `now`: what was cleared is the receipt's
  /// replies, approvals and Dones; what arrived is the inbound threads
  /// since today's 04:00.
  private func clearContent(now: Date) -> ZeroContent {
    let receipt = model.receipt
    let cleared = receipt.replied + receipt.done + receipt.approved
    let start = ProgressRules.dayBoundary(now, tz: .current)
    let arrived = (model.threads?.threads ?? []).filter { thread in
      guard !thread.lastFromMe, let at = WireDate.parse(thread.lastAt) else { return false }
      return at >= start
    }.count
    let kind = ProgressRules.zeroKind(
      arrivedToday: arrived, clearedToday: cleared, lastClearAt: cleared > 0 ? appearedAt : nil, now: now,
      praiseFor: ProvisionalUI.zeroPraiseSeconds)
    let evidence = model.board.asOf.map { "Zero across 1 source, last event " + ShellText.clock($0) + "." }
    let snooze = model.queue.nextSnooze(after: model.queueClock).map {
      "Next snooze returns " + QueueStateStore.snoozeLabel($0) + "."
    }
    switch kind {
    case .earned:
      return ZeroContent(
        kind: kind, heading: ZeroWords.heading(kind), lines: [evidence].compactMap { $0 }, receipt: receipt.line,
        footer: [snooze].compactMap { $0 }, streakLine: nil)
    case .stillClear:
      return ZeroContent(
        kind: kind, heading: ZeroWords.heading(kind), lines: [evidence].compactMap { $0 }, receipt: nil,
        footer: ["\(cleared) cleared today.", snooze].compactMap { $0 }, streakLine: nil)
    case .nothingArrived:
      return ZeroContent(
        kind: kind, heading: ZeroWords.heading(kind), lines: [ZeroWords.quietLine], receipt: nil,
        footer: [evidence, ZeroWords.wrongLine].compactMap { $0 }, streakLine: nil)
    }
  }

  private var kind: String {
    switch counter {
    case .left, .clear: "clear"
    case .cannotSay: "cannot say"
    case .hidden: "not connected"
    }
  }

  var body: some View {
    VStack(spacing: 10) {
      switch counter {
      case .left, .clear:
        TimelineView(.periodic(from: appearedAt, by: 60)) { context in
          ZeroPanel(
            content: clearContent(now: context.date), palette: palette,
            onVerify: { Task { await model.refresh() } }, onProgress: nil)
        }
      case .cannotSay(let since):
        numeral("?")
        heading("We cannot tell")
        words(ProvisionalUI.cannotSayDetail(channel: model.counterChannel, staleSince: since.map { ShellText.clock($0) }))
        verify
      case .hidden:
        Rectangle().fill(Tokens.color(palette.ink)).frame(width: 48, height: 6)
          .accessibilityHidden(true)
        heading("This channel is not connected")
        words("Zero because there is nothing to count, not because you did anything.")
        if model.scope == .imessage || model.scope == .all {
          ConnectCard(palette: palette)
        }
      }
    }
    .frame(maxWidth: 360)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Zero: " + kind)
    .accessibilityValue(kind)
    .accessibilityIdentifier(ShellID.zero)
  }

  private func numeral(_ glyph: String) -> some View {
    Text(glyph)
      .font(.system(size: ProvisionalUI.zeroNumeralSize, weight: .bold, design: .monospaced))
      .foregroundStyle(Tokens.color(palette.ink))
      .minimumScaleFactor(ProvisionalUI.zeroNumeralClampsToPane ? 0.5 : 1)
      .lineLimit(1)
      .accessibilityHidden(true)
  }

  private func heading(_ words: String) -> some View {
    Text(words)
      .font(.system(size: 15, weight: .semibold))
      .foregroundStyle(Tokens.color(palette.ink))
      .multilineTextAlignment(.center)
      .accessibilityAddTraits(.isHeader)
  }

  private func words(_ text: String) -> some View {
    Text(text)
      .font(.system(size: 11))
      .foregroundStyle(Tokens.color(palette.inkDim))
      .multilineTextAlignment(.center)
      .fixedSize(horizontal: false, vertical: true)
      .accessibilityLabel(text)
  }

  private var verify: some View {
    ZeroPanel.verify(palette: palette) { Task { await model.refresh() } }
  }
}

/// The iMessage card on the not-connected zero (09.H, D-UI-48): the four
/// paragraphs, and no button while the daemon serves no connect route.
struct ConnectCard: View {
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      ForEach(ProvisionalUI.connectCardLines, id: \.self) { line in
        Text(line)
          .font(.system(size: 10))
          .foregroundStyle(Tokens.color(palette.ink))
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(12)
    .background(RoundedRectangle(cornerRadius: 10).fill(Tokens.color(palette.layer1)))
    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Tokens.color(palette.inkDim, opacity: 0.5), lineWidth: 1))
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier(ShellID.connectCard)
  }
}

/// The audit view (09.G): the daemon's hash chain, oldest first, newest at
/// the foot. Result prints what the daemon serves for it (D-UI-49).
struct AuditView: View {
  @Bindable var model: ShellModel
  let palette: Tokens.Palette

  private static let titles = ["Row", "Time", "Actor", "Verb", "Target", "Result", "Prev", "Hash"]
  private static let widths: [CGFloat] = [40, 64, 96, 120, 90, 72, 48, 48]

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text("Audit")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.ink))
          .accessibilityAddTraits(.isHeader)
        Spacer(minLength: 0)
        QueueButton(title: "Close", key: "ESC", filled: false, palette: palette) {
          model.auditShown = false
        }
        .accessibilityLabel("Close audit")
        .accessibilityIdentifier(ShellID.auditClose)
      }
      .padding(12)
      row(Self.titles, bold: true)
        .accessibilityHidden(true)
      Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.3)).frame(height: 0.5).accessibilityHidden(true)
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(model.audit, id: \.seq) { line in
            let cells = cells(line)
            row(cells, bold: false)
              .accessibilityElement(children: .ignore)
              .accessibilityLabel(zip(Self.titles, cells).map { $0 + " " + $1 }.joined(separator: ", "))
              .accessibilityIdentifier(ShellID.auditRowPrefix + String(line.seq))
          }
        }
      }
      .defaultScrollAnchor(.bottom)
      .scrollIndicators(.never)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .task { await model.loadAudit() }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Audit")
    .accessibilityIdentifier(ShellID.audit)
  }

  private func cells(_ line: AuditLine) -> [String] {
    let actor = line.actorName.map { line.actor + " " + $0 } ?? line.actor
    return [
      String(line.seq), line.at.map { ShellText.clock($0) } ?? "", actor, line.verb, line.target,
      line.result ?? ProvisionalUI.auditResultUnserved, line.prev, line.hash,
    ]
  }

  private func row(_ cells: [String], bold: Bool) -> some View {
    HStack(spacing: 6) {
      ForEach(cells.indices, id: \.self) { i in
        Text(cells[i])
          .font(.system(size: 10, weight: bold ? .bold : .regular, design: .monospaced))
          .foregroundStyle(Tokens.color(bold ? palette.inkDim : palette.ink))
          .lineLimit(1)
          .truncationMode(.tail)
          .frame(width: i < Self.widths.count ? Self.widths[i] : 48, alignment: .leading)
      }
      Spacer(minLength: 0)
    }
    .padding(.vertical, 4)
    .padding(.horizontal, 12)
  }
}

/// Triage's verb row (06.C) under the thread: the draft's verbs, or Reply
/// with no draft, then Done, Snooze and Mute. Each is drawn only when its
/// gate passes (CompletionRules.permit); a refused verb is absent.
struct VerbRow: View {
  @Bindable var model: ShellModel
  let thread: ThreadSummary
  let palette: Tokens.Palette

  var body: some View {
    let guid = thread.chatGuid
    let gates = model.gates(for: guid)
    let draft = model.pendingDraft(for: guid).flatMap { model.thread.held.contains($0.id) ? nil : $0 }
    HStack(spacing: 8) {
      if let draft {
        DraftVerbs(
          palette: palette,
          approve: CompletionRules.permit(.approve, gates) == nil ? { _ = model.approvePending(in: guid) } : nil,
          edit: CompletionRules.permit(.edit, gates) == nil ? { model.replyOrEdit(in: guid) } : nil,
          hold: CompletionRules.permit(.hold, gates) == nil ? { model.holdPending(in: guid) } : nil,
          ids: .draft(draft.id)
        )
        .fixedSize()
      } else if CompletionRules.permit(.reply, gates) == nil {
        QueueButton(title: "Reply", key: "R", filled: true, palette: palette) { model.replyOrEdit(in: guid) }
          .accessibilityLabel("Reply")
          .accessibilityIdentifier(ShellID.verbReply)
      }
      Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.35)).frame(width: 1, height: 18).accessibilityHidden(true)
      queueVerb(.done, "Done", "E", gates, ShellID.verbDone)
      queueVerb(.snooze, "Snooze", "H", gates, ShellID.verbSnooze)
      queueVerb(.mute, "Mute", "M", gates, ShellID.verbMute)
      Spacer(minLength: 0)
      Text("X select \u{00B7} Z undo")
        .font(.system(size: 9, design: .monospaced))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .fixedSize()
        // The row's hint speaks it: as its own element the 9pt glyphs are
        // too few pixels for the 1x audit to measure (run 37717485936).
        .accessibilityHidden(true)
    }
    .padding(.vertical, 6)
    .padding(.horizontal, 12)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Verbs")
    .accessibilityHint("X selects, Z undoes")
    .accessibilityIdentifier(ShellID.verbs)
  }

  @ViewBuilder
  private func queueVerb(_ kind: QueueStateStore.Kind, _ title: String, _ key: String, _ gates: VerbGates, _ id: String)
    -> some View
  {
    let verb: Verb =
      switch kind {
      case .done: .done
      case .snooze: .snooze
      case .mute: .mute
      }
    if CompletionRules.permit(verb, gates) == nil {
      QueueButton(title: title, key: key, filled: false, palette: palette) {
        model.act(kind, on: [thread.chatGuid])
      }
      .accessibilityLabel(title)
      .accessibilityIdentifier(id)
    }
  }
}

/// The rationale under an open draft in Needs You (09.C): only what the
/// daemon serves, the rule and the proactive reason (D-UI-53). Absent when
/// it serves neither.
struct RationaleBlock: View {
  let draft: DraftPayload
  let palette: Tokens.Palette

  private var lines: [String] {
    guard ProvisionalUI.rationaleLines == .servedOnly else { return [] }
    return [
      ProvisionalUI.whyLine(proactiveReason: nil, ruleId: draft.ruleId),
      ProvisionalUI.whyLine(proactiveReason: draft.proactiveReason, ruleId: nil),
    ].compactMap { $0 }
  }

  var body: some View {
    if !lines.isEmpty {
      VStack(alignment: .leading, spacing: 3) {
        Text("Why \(draft.adapterId) proposed this".uppercased())
          .font(.system(size: 9, weight: .bold))
          .tracking(1.2)
          .foregroundStyle(Tokens.color(palette.inkDim))
        ForEach(lines, id: \.self) { line in
          Text(line)
            .font(.system(size: 11))
            .foregroundStyle(Tokens.color(palette.ink))
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      .padding(.leading, 8)
      .overlay(alignment: .leading) {
        Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.35)).frame(width: 2)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier(ShellID.draftVerb(draft.id, "why"))
    }
  }
}

/// Under the open draft in Needs You (09.A): the rationale, then the
/// draft's own verbs, each drawn only when its gate passes. Under the kill
/// switch none of them exists (09.F).
struct NeedsYouDraft: View {
  @Bindable var model: ShellModel
  let draft: DraftPayload
  let palette: Tokens.Palette

  var body: some View {
    let guid = draft.chatGuid
    let gates = model.gates(for: guid)
    let carries = model.phase(of: draft)?.carriesVerbs ?? false
    VStack(alignment: .leading, spacing: 8) {
      RationaleBlock(draft: draft, palette: palette)
      if carries {
        DraftVerbs(
          palette: palette,
          approve: CompletionRules.permit(.approve, gates) == nil ? { _ = model.approvePending(in: guid) } : nil,
          edit: CompletionRules.permit(.edit, gates) == nil ? { model.replyOrEdit(in: guid) } : nil,
          hold: CompletionRules.permit(.hold, gates) == nil ? { model.holdPending(in: guid) } : nil,
          ids: .draft(draft.id))
      }
    }
    .frame(maxWidth: .infinity, alignment: .trailing)
  }
}
