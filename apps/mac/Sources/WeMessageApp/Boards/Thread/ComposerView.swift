import SwiftUI
import WeMessageKit

/// The composer (02.A, 02.I). The field is a text editor, so bare Return
/// is a newline and never a send: the one send gesture is cmd-Return (or
/// the Send button), and both go to Outbound, which writes the undo entry,
/// counts 4 s and only then asks the daemon. The composer never reaches the
/// client itself (H-S4-2b).
///
/// Absent, with the reason printed, rather than greyed: Send while the kill
/// switch is on or unknown (02.I d) and in a group (D-UI-34), Hold until
/// always (D-UI-17), and every draft verb under the kill switch.
struct ComposerView: View {
  @Bindable var model: ShellModel
  let thread: ThreadSummary
  let palette: Tokens.Palette

  @FocusState private var focused: Bool

  static let fieldHint = "Message\u{2026}"
  static let draftHint = "Or just start typing. Your keystrokes always win."
  static let killNote =
    "No Send and no Hold until while the kill switch is on. Both are absent rather than greyed: a send verb that cannot reach a wire is an invitation to a click that can never succeed. Release the switch in the menu bar and both come back."
  static let killHint = "Sending is off while the kill switch is on. You can still read."
  static let killKept = "Your text is still here. Nothing was deleted and nothing was queued."

  private var guid: String { thread.chatGuid }
  private var killOff: Bool { model.killSwitch == false }
  private var canSend: Bool { killOff && !thread.isGroup && threadHandle(thread) != nil }

  private var text: Binding<String> {
    Binding(get: { model.composerText[guid] ?? "" }, set: { model.composerText[guid] = $0 })
  }

  private var draft: DraftPayload? {
    guard let draft = model.pendingDraft(for: guid), !model.thread.held.contains(draft.id) else { return nil }
    return draft
  }

  /// A send or approval from this thread still inside its window or out.
  private var busy: Bool {
    switch model.outbound.latest(for: guid)?.phase {
    case .counting, .sending: true
    default: false
    }
  }

  /// The composer's draft verbs are Recent's (02.A); Needs You draws them
  /// under the draft and Triage in its verb row.
  private var showsVerbs: Bool { draft != nil && killOff && !busy && model.lens == .recent }
  /// Outside Recent the field takes the keyboard only when R or Edit asks.
  /// The find bar's field holds the keyboard while it is up; when it
  /// closes the claim is new again and the field takes it back.
  private var claimToken: String? {
    guard !model.find.shown else { return nil }
    return model.lens == .recent || model.composerClaim == guid ? guid : nil
  }
  private var borderless: Bool { draft != nil && ProvisionalUI.draftComposer == .verbsAboveField }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if let draft, showsVerbs {
        DraftVerbs(
          palette: palette,
          approve: { approve(draft) },
          edit: {
            model.composerText[guid] = draft.body
            model.editedFrom[guid] = draft.id
            focused = true
          },
          hold: ProvisionalUI.draftHold == .localPark ? { model.thread.hold(draft.id) } : nil)
        if ProvisionalUI.draftComposer == .verbsOnly {
          caption(Self.draftHint)
        }
      }
      if draft == nil || ProvisionalUI.draftComposer == .verbsAboveField {
        HStack(alignment: .top, spacing: 8) {
          field
          if canSend && (draft == nil || !text.wrappedValue.isEmpty) {
            sendButton
          }
          if !killOff {
            Text(Self.killNote)
              .font(.system(size: 10))
              .foregroundStyle(Tokens.color(palette.inkDim))
              .fixedSize(horizontal: false, vertical: true)
              .frame(maxWidth: 260, alignment: .leading)
              .padding(.leading, 8)
              .overlay(alignment: .leading) {
                Rectangle().fill(Tokens.color(palette.ink)).frame(width: 2)
              }
          }
        }
      }
      if !killOff && !text.wrappedValue.isEmpty {
        caption(Self.killKept)
      }
      CapabilityNote(isGroup: thread.isGroup, palette: palette)
    }
    .padding(.vertical, 10)
    .padding(.horizontal, 12)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Composer")
    .accessibilityIdentifier(ShellID.composer)
  }

  private func caption(_ words: String) -> some View {
    Text(words)
      .font(.system(size: 10))
      .foregroundStyle(Tokens.color(palette.inkDim))
      .fixedSize(horizontal: false, vertical: true)
  }

  private var field: some View {
    ZStack(alignment: .topLeading) {
      if text.wrappedValue.isEmpty {
        Text(killOff ? (borderless ? Self.draftHint : Self.fieldHint) : Self.killHint)
          .font(.system(size: borderless ? 10 : 13))
          .foregroundStyle(Tokens.color(palette.inkDim))
          .padding(.vertical, borderless ? 2 : 7)
          .padding(.horizontal, borderless ? 0 : 12)
          .allowsHitTesting(false)
          .accessibilityHidden(killOff)
      }
      TextEditor(text: text)
        .font(.system(size: 13))
        .foregroundStyle(Tokens.color(palette.ink))
        .scrollContentBackground(.hidden)
        .scrollIndicators(.never)
        .padding(.vertical, borderless ? 0 : 6)
        .padding(.horizontal, borderless ? 0 : 7)
        .focused($focused)
        // The draft hint promises that plain typing lands here, so the field
        // takes the keyboard when a thread opens, the first one included.
        .background(KeyboardClaim(token: claimToken))
        // Outside Recent, Escape hands the keyboard back to the list (06.C).
        // In any lens it first climbs board 11: the find bar, the scrubber,
        // a jump back to its results (11.D).
        // Board 11's chords, which the text view can keep from the hidden
        // buttons: search, the switcher, find and the scrubber.
        .onKeyPress(phases: .down) { press in Board11Keys.route(press, model: model) }
        .onKeyPress(.escape) {
          guard model.lens != .recent || model.escapeIsBoard11 else { return .ignored }
          model.escape(fromComposer: true)
          return .handled
        }
        // Measured (run 37594298009): with the text view first responder the
        // hidden cmd-Return button never fires, so the field hears cmd-Return
        // itself. Anything without cmd falls through to the editor: a newline.
        .onKeyPress(.return, phases: .down) { press in
          guard press.modifiers.contains(.command) else { return .ignored }
          // Board 07: an armed voice card takes cmd-Return first, through
          // approvePending; anywhere else it is the typed send.
          if model.voiceCommit(in: guid) { return .handled }
          send(gesture: .commandReturn)
          return .handled
        }
        .accessibilityLabel("Message")
        .accessibilityIdentifier(ShellID.composerField)
    }
    .frame(minHeight: 32, maxHeight: 72)
    .fixedSize(horizontal: false, vertical: true)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background {
      if !borderless {
        RoundedRectangle(cornerRadius: 16).fill(Tokens.color(palette.layer1))
      }
    }
    .overlay {
      if !borderless {
        RoundedRectangle(cornerRadius: 16).strokeBorder(Tokens.color(palette.inkDim, opacity: 0.5), lineWidth: 1)
      }
    }
  }

  private var sendButton: some View {
    Button { send(gesture: .sendButton) } label: {
      Text("Send")
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.layer1))
        .padding(.horizontal, 14)
        .frame(height: 32)
        .background(Capsule().fill(Tokens.color(palette.ink)))
        .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .focusable()
    // cmd-Return, the one keyboard send, lives on Send itself. Measured
    // (run 37596258225): a zero-sized shortcut button in the composer's
    // background never fired. Where Send is absent, a send would be refused
    // anyway (kill switch, group, or a draft with an empty field).
    .keyboardShortcut(.return, modifiers: .command)
    .accessibilityLabel("Send")
    .accessibilityIdentifier(ShellID.composerSend)
  }

  /// cmd-Return or Send: hands the field to the funnel, which refuses under
  /// the kill switch, in a group, or with nothing typed.
  private func send(gesture: Outbound.Gesture) {
    guard canSend, let handle = threadHandle(thread) else { return }
    let body = text.wrappedValue
    let refused = model.outbound.perform(.send(chatGuid: guid, handle: handle, body: body), gesture: gesture)
    guard refused == nil else { return }
    model.composerText[guid] = ""
    model.editedFrom[guid] = nil
  }

  /// Approve: the funnel's 10 s window, then the daemon's approve route.
  /// After Edit, the field rides along as the edited body.
  private func approve(_ draft: DraftPayload) {
    let typed = text.wrappedValue
    let edited = model.editedFrom[guid] == draft.id && !typed.isEmpty && typed != draft.body ? typed : nil
    let refused = model.outbound.perform(
      .approve(draftId: draft.id, chatGuid: guid, editedBody: edited), gesture: .approveButton)
    guard refused == nil else { return }
    if model.editedFrom[guid] == draft.id {
      model.composerText[guid] = ""
      model.editedFrom[guid] = nil
    }
  }

  /// cmd-Z inside the window: the send comes back, and a typed message
  /// returns to the field it left.
  static func undo(model: ShellModel, chatGuid: String) {
    guard let entry = model.outbound.latest(for: chatGuid), case .counting = entry.phase else { return }
    guard model.outbound.undo(in: chatGuid) else { return }
    if case .send(_, _, let body) = entry.intent, (model.composerText[chatGuid] ?? "").isEmpty {
      model.composerText[chatGuid] = body
    }
  }
}

/// The newest send from this window, in the transcript (14.F): dashed while
/// it counts down with nothing sent, dashed while it is out, dotted when it
/// was parked or refused (D-UI-33), filled only once the daemon says sent.
/// Its accessibility value is the phase.
struct OutboxBubble: View {
  let entry: Outbound.Entry
  let maxWidth: Double
  let palette: Tokens.Palette
  let undo: () -> Void

  private var body_: String? {
    switch entry.intent {
    case .send(_, _, let body): body
    case .approve(_, _, let edited): edited
    }
  }

  private var phaseValue: String {
    switch entry.phase {
    case .counting(let remaining): "counting " + String(remaining)
    case .sending: "sending"
    case .sent: "sent"
    case .approved: "approved"
    case .parked: "parked"
    case .refused(let why): "refused " + why
    case .failed: "failed"
    case .undone: "undone"
    }
  }

  private var headline: String? {
    switch entry.phase {
    case .counting(let remaining): "SENDING in " + String(remaining) + "s"
    case .sending, .approved: "SENDING on iMessage"
    case .parked: ProvisionalUI.parkedLine
    case .refused(let why): "Not sent: " + why
    case .failed(let why): "Not sent: " + why
    case .sent, .undone: nil
    }
  }

  private var sent: Bool { entry.phase == .sent }

  private var stroke: StrokeStyle? {
    switch entry.phase {
    case .counting, .sending, .approved: BubbleStroke.dashed
    case .parked: ProvisionalUI.parkedBorder == .dotted ? BubbleStroke.dotted : BubbleStroke.dashed
    case .refused, .failed: BubbleStroke.dotted
    case .sent, .undone: nil
    }
  }

  var body: some View {
    HStack(spacing: 0) {
      Spacer(minLength: 0)
      VStack(alignment: .leading, spacing: 6) {
        if let headline {
          Text(headline)
            .font(.system(size: 9, weight: .bold))
            .tracking(1.2)
            .foregroundStyle(Tokens.color(palette.inkDim))
        }
        if let body_ {
          Text(body_)
            .font(.system(size: 13))
            .foregroundStyle(Tokens.color(sent ? palette.layer1 : palette.ink))
            .fixedSize(horizontal: false, vertical: true)
        }
        if case .counting(let remaining) = entry.phase {
          HStack(spacing: 8) {
            Button(action: undo) {
              Text("Undo \u{00B7} " + String(remaining) + "s \u{2318}Z")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(Tokens.color(palette.ink))
                .padding(.vertical, 3)
                .padding(.horizontal, 8)
                .overlay(Capsule().strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .keyboardShortcut("z", modifiers: .command)
            Text("Nothing has left this Mac.")
              .font(.system(size: 10))
              .foregroundStyle(Tokens.color(palette.inkDim))
          }
        }
      }
      .frame(maxWidth: max(0, maxWidth - 2 * TranscriptLayout.horizontalPadding), alignment: .leading)
      .padding(.vertical, 8)
      .padding(.horizontal, TranscriptLayout.horizontalPadding)
      .background {
        RoundedRectangle(cornerRadius: TranscriptLayout.radius)
          .fill(sent ? Tokens.color(palette.ink) : Tokens.color(palette.layer1))
      }
      .overlay {
        if let stroke {
          RoundedRectangle(cornerRadius: TranscriptLayout.radius).strokeBorder(Tokens.color(palette.ink), style: stroke)
        }
      }
    }
    // A group, so the label (which leads with the phase) reaches AX and the
    // Undo button stays reachable inside it.
    .accessibilityElement(children: .contain)
    .accessibilityLabel([headline ?? "Sent", body_].compactMap { $0 }.joined(separator: ", "))
    .accessibilityValue(phaseValue)
    .accessibilityIdentifier(ShellID.composerOutbox)
    .accessibilityAction(named: "Undo") { undo() }
  }
}

/// The controls this composer does not have, and why (02.H, D-UI-17,
/// D-UI-34). Printed, never greyed.
struct CapabilityNote: View {
  let isGroup: Bool
  let palette: Tokens.Palette

  private var lines: [String] {
    var lines: [String] = []
    if isGroup { lines.append(ProvisionalUI.groupSendReason) }
    if ProvisionalUI.holdUntil == .absentWithReason { lines.append(ProvisionalUI.holdUntilReason) }
    return lines
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      ForEach(lines, id: \.self) { line in
        Text(line)
          .font(.system(size: 10))
          .foregroundStyle(Tokens.color(palette.inkDim))
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    // A combined group's label arrives empty (run 37591391142); say it.
    .accessibilityElement(children: .contain)
    .accessibilityLabel(lines.joined(separator: " "))
    .accessibilityIdentifier(ShellID.capabilityNote)
  }
}
