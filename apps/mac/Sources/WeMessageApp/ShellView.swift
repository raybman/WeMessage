import SwiftUI
import WeMessageKit

/// The accessibility identifiers that are the contract with the UI tests
/// (AppHygieneTests H-A5 and arch R-A15 hold this file, the UI tests and
/// apps/mac/README.md to the same list). Every literal lives here, so the
/// board views under Boards/ name them through this enum.
enum ShellID {
  static let shell = "wemessage.shell"
  static let rail = "wemessage.rail"
  static let sidebar = "wemessage.sidebar"
  static let sidebarEmpty = "wemessage.sidebar.empty"
  static let connection = "wemessage.connection"
  static let title = "wemessage.title"
  static let titleCounter = "wemessage.title.counter"
  static let lens = "wemessage.lens"
  static let lensRecent = "wemessage.lens.recent"
  static let lensNeedsYou = "wemessage.lens.needsyou"
  static let lensTriage = "wemessage.lens.triage"
  static let killChip = "wemessage.kill.chip"
  static let content = "wemessage.content"
  static let contentEmpty = "wemessage.content.empty"
  static let inspector = "wemessage.inspector"
  static let inspectorToggle = "wemessage.inspector.toggle"
  /// A list row is this prefix and its chatGuid.
  static let rowPrefix = "wemessage.sidebar.row."
  // v2 S4d, board 02.
  static let thread = "wemessage.thread"
  static let threadBanner = "wemessage.thread.banner"
  static let capabilityNote = "wemessage.thread.capability.note"
  static let inv5 = "wemessage.thread.inv5"
  static let draft = "wemessage.thread.draft"
  static let draftApprove = "wemessage.thread.draft.approve"
  static let draftEdit = "wemessage.thread.draft.edit"
  static let draftHold = "wemessage.thread.draft.hold"
  static let composer = "wemessage.composer"
  static let composerField = "wemessage.composer.field"
  static let composerSend = "wemessage.composer.send"
  /// Hold until (02.I). Never placed while D-UI-17 is absent-with-reason;
  /// the UI tests assert it does not exist.
  static let composerHold = "wemessage.composer.hold"
  /// The send in its undo window, sending, parked or sent (14.F); its value
  /// is the phase.
  static let composerOutbox = "wemessage.composer.outbox"
  /// A transcript bubble is this prefix and its message guid.
  static let bubblePrefix = "wemessage.thread.bubble."
  /// A day separator is this prefix and the day as yyyy-mm-dd.
  static let dayPrefix = "wemessage.thread.day."
  /// A held agent draft is this prefix and the draft id.
  static let heldPrefix = "wemessage.thread.held."
  // v2 S4e, board 08: the specimen sheet. Only WEMESSAGE_UI_BOARD=08 under
  // the UI-test flag reaches it (H-S4-4).
  static let atlas = "wemessage.atlas"
  /// One page of the sheet is this prefix and its slug (08.A is "anatomy").
  static let atlasPagePrefix = "wemessage.atlas."
  /// A reaction chip is this prefix, the message guid, a dot and its index.
  static let reactionPrefix = "wemessage.bubble.reaction."
  /// The delivery state inside an outbound bubble: this prefix and its guid.
  static let deliveryPrefix = "wemessage.bubble.delivery."
  /// An agent draft specimen: this prefix and the draft id.
  static let draftSpecimenPrefix = "wemessage.bubble.draft."
  /// A message sent over SMS (D-UI-39): this prefix and its guid.
  static let smsPrefix = "wemessage.bubble.sms."
  /// A message sent with an effect: this prefix and its guid.
  static let effectPrefix = "wemessage.bubble.effect."
  /// The honest fallback for a type the app cannot render.
  static let unsupportedPrefix = "wemessage.bubble.unsupported."
  // v2 S4f, boards 06 and 09.
  /// Triage's list header (06.C): the counter and the burn-down bar; its
  /// value is the counter's sentence.
  static let triageBar = "wemessage.triage.bar"
  /// Needs You's bulk strip (09.D) and its two buttons.
  static let bulkStrip = "wemessage.bulk.strip"
  static let bulkOpen = "wemessage.bulk.open"
  static let auditOpen = "wemessage.audit.open"
  /// The bulk confirm card (09.D): the one place bare Return approves.
  static let bulkSheet = "wemessage.bulk.sheet"
  static let bulkConfirm = "wemessage.bulk.confirm"
  static let bulkCancel = "wemessage.bulk.cancel"
  /// One included or excluded draft on the card: the prefix and its id.
  static let bulkIncludedPrefix = "wemessage.bulk.included."
  static let bulkExcludedPrefix = "wemessage.bulk.excluded."
  /// The batch's one undo (09.D); its value is the seconds left.
  static let undoRing = "wemessage.undo.ring"
  /// Triage's verb row (06.C) and its queue verbs.
  static let verbs = "wemessage.verbs"
  static let verbReply = "wemessage.verb.reply"
  static let verbDone = "wemessage.verb.done"
  static let verbSnooze = "wemessage.verb.snooze"
  static let verbMute = "wemessage.verb.mute"
  /// A draft's own verbs, rationale and meta outside Recent (09.A): the
  /// prefix, the draft id, then .approve, .edit, .hold, .why or .meta.
  static let draftPrefix = "wemessage.draft."
  /// Release to awaiting on a held draft (09.B).
  static let release = "wemessage.thread.release"
  /// The kill banner (09.F) and its click-only Disengage (D-UI-50).
  static let killBanner = "wemessage.kill.banner"
  static let killDisengage = "wemessage.kill.disengage"
  /// The zero screen (06.E); its value is which zero it is.
  static let zero = "wemessage.zero"
  static let zeroReceipt = "wemessage.zero.receipt"
  static let zeroVerify = "wemessage.zero.verify"
  /// The not-connected zero's card (09.H, D-UI-48).
  static let connectCard = "wemessage.connect.card"
  /// The audit view (09.G), one row per seq, and its close.
  static let audit = "wemessage.audit"
  static let auditClose = "wemessage.audit.close"
  static let auditRowPrefix = "wemessage.audit.row."

  static func draftVerb(_ draftId: String, _ verb: String) -> String { draftPrefix + draftId + "." + verb }

  static func rail(_ scope: ShellModel.Scope) -> String {
    switch scope {
    case .all: "wemessage.rail.all"
    case .imessage: "wemessage.rail.imessage"
    case .whatsapp: "wemessage.rail.whatsapp"
    case .linkedin: "wemessage.rail.linkedin"
    case .email: "wemessage.rail.email"
    }
  }
}

/// The first window, board 01 (wireframe 01.B): the title bar across the
/// top, then the channel rail, the conversation list and the content pane,
/// with the inspector beside the content when it is open. Since S4a the
/// panes are transparent over one window frost (FrostBackground), divided
/// by 0.5 pt hairlines. The panes come first in the view tree and the title
/// bar is laid over them; SwiftUI's key loop follows reading order, so Tab
/// reaches the lens and the kill chip in the title band, then the rail.
struct ShellView: View {
  /// The client reads WEMESSAGE_PORT and WEMESSAGE_DIR/daemon.token from the
  /// environment, as the shipped app does (H10-H12).
  @State private var model = ShellModel(client: GatewayClient())
  /// The system's display options, with a UI test's forced values on top.
  @State private var mirror = AccessibilityMirror.live()
  @Environment(\.colorScheme) private var scheme

  /// The title band the hidden title bar leaves to the traffic lights.
  static let titleBand: CGFloat = 52
  /// The conversation list (wireframe .listcol).
  static let sidebarWidth: CGFloat = 300

  private var palette: Tokens.Palette { Tokens.palette(dark: scheme == .dark) }
  private var dark: Bool { scheme == .dark }

  var body: some View {
    ZStack(alignment: .top) {
      HStack(spacing: 0) {
        RailView(model: model, palette: palette, mirror: mirror, dark: dark)
        Hairline(mirror: mirror, palette: palette, dark: dark)
        SidebarView(model: model, palette: palette, dark: dark)
        Hairline(mirror: mirror, palette: palette, dark: dark)
        ContentPane(model: model, palette: palette)
        if model.inspectorShown, let thread = model.selected {
          Hairline(mirror: mirror, palette: palette, dark: dark)
          InspectorPane(thread: thread, palette: palette)
        }
      }
      .padding(.top, Self.titleBand + 0.5)
      VStack(spacing: 0) {
        TitleBar(model: model, palette: palette)
        Hairline(mirror: mirror, palette: palette, dark: dark, horizontal: true)
      }
      if TestHooks.isUITest {
        // Under the UI-test flag only: cmd-opt-R reads status, threads and
        // drafts again, so one launch can show several fake-daemon
        // scenarios. Not a control: zero size and hidden.
        Button("") { Task { await model.refresh() } }
          .keyboardShortcut("r", modifiers: [.command, .option])
          .frame(width: 0, height: 0)
          .opacity(0)
          .accessibilityHidden(true)
      }
    }
    .frame(minWidth: ProvisionalUI.windowMinWidth, minHeight: ProvisionalUI.windowMinHeight)
    .ignoresSafeArea()
    .modifier(FrostBackground(mirror: mirror, palette: palette))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier(ShellID.shell)
    // Under the UI-test flag only, the pinned geometry. Measured (run
    // 37553425686): a SwiftUI container's value never reaches AX on macOS,
    // so it rides the label too, and the delegate sets it on the window.
    .accessibilityValue(TestHooks.geometry.value ?? "")
    .accessibilityLabel(Text(TestHooks.geometry.value ?? ""))
    // Under the UI-test flag only, no animation: a snapshot is one settled
    // frame, never a mid-transition one (H-S1).
    .transaction { if TestHooks.isUITest { $0.disablesAnimations = true } }
    .task { model.start() }
  }
}

/// The channel rail (wireframe .rail): one tile per scope, a rule after
/// ALL, and each tile's mark (digit, clear baseline, "!" or nothing).
private struct RailView: View {
  let model: ShellModel
  let palette: Tokens.Palette
  let mirror: AccessibilityMirror
  let dark: Bool

  var body: some View {
    VStack(spacing: 8) {
      ForEach(ShellModel.Scope.allCases, id: \.self) { scope in
        RailTile(scope: scope, selected: model.scope == scope, mark: model.board.mark(scope), palette: palette) {
          model.scope = scope
        }
        .accessibilityLabel(scope.fullLabel)
        .keyboardShortcut(KeyEquivalent(scope.shortcutDigit), modifiers: .command)
        .accessibilityIdentifier(ShellID.rail(scope))
        if scope == .all {
          Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.35)).frame(width: 26, height: 1)
            .padding(4)
            .accessibilityHidden(true)
        }
      }
      Spacer(minLength: 0)
    }
    .padding(.vertical, 12)
    .frame(width: ProvisionalUI.railWidth)
    .frame(maxHeight: .infinity)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier(ShellID.rail)
  }
}

/// One rail tile (wireframe .rail-btn: 38 pt, radius 9, a rule border; the
/// selected tile per D-UI-6). The mark is drawn on the tile and published as
/// its accessibility value: the digit, "clear", "stale", or nothing.
private struct RailTile: View {
  let scope: ShellModel.Scope
  let selected: Bool
  let mark: RailMark
  let palette: Tokens.Palette
  let action: () -> Void

  static let side: CGFloat = 38

  private var labelColor: Color {
    guard selected else { return Tokens.color(palette.ink) }
    switch ProvisionalUI.selectedTile {
    case .filledTint: return .white
    case .tintLabel, .tintBar: return Tokens.color(Tokens.tint)
    }
  }

  private var markValue: String {
    switch mark {
    case .digit(let n): String(n)
    case .baseline: "clear"
    case .stale: "stale"
    case .none: ""
    }
  }

  private var dot: String? {
    switch mark {
    case .digit(let n): String(n)
    case .stale: "!"
    case .baseline, .none: nil
    }
  }

  var body: some View {
    Button(action: action) {
      Text(scope.label)
        .font(.system(size: 10, weight: .bold))
        .foregroundStyle(labelColor)
        .frame(width: Self.side, height: Self.side)
        .background {
          RoundedRectangle(cornerRadius: 9)
            .fill(selected && ProvisionalUI.selectedTile == .filledTint ? Tokens.color(Tokens.tint) : Tokens.color(palette.layer1))
        }
        .overlay(alignment: .bottom) {
          if mark == .baseline {
            Rectangle().fill(Tokens.color(palette.ink)).frame(height: 3)
          }
        }
        .clipShape(RoundedRectangle(cornerRadius: 9))
        .overlay {
          RoundedRectangle(cornerRadius: 9)
            .strokeBorder(Tokens.color(palette.inkDim, opacity: 0.35), lineWidth: 1)
        }
        .overlay(alignment: .leading) {
          if selected && ProvisionalUI.selectedTile == .tintBar {
            Rectangle().fill(Tokens.color(Tokens.tint)).frame(width: 3)
          }
        }
        .overlay(alignment: .topTrailing) {
          if let dot {
            Text(dot)
              .font(.system(size: 8, weight: .bold))
              .foregroundStyle(Tokens.color(palette.layer1))
              .fixedSize()
              .padding(.horizontal, 3)
              .frame(minWidth: 15, minHeight: 15)
              .background(Capsule().fill(Tokens.color(palette.ink)))
              .offset(x: 2, y: -2)
          }
        }
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    // A plain-style button is not a Tab stop on macOS; this makes each tile one.
    .focusable()
    .accessibilityValue(markValue)
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}

/// The conversation list (wireframe .listcol): the filter chip row with the
/// list's "as of", the rows for the scope and lens, or the empty state, and
/// the connection line at the foot.
private struct SidebarView: View {
  @Bindable var model: ShellModel
  let palette: Tokens.Palette
  let dark: Bool

  private var asOf: Date? { model.threads.flatMap { WireDate.parse($0.asOf) } }

  private var chipFill: Color {
    switch ProvisionalUI.lensOn {
    case .filledTint: Tokens.color(Tokens.tint)
    case .filledInk: Tokens.color(palette.ink)
    }
  }

  private var chipLabel: Color {
    switch ProvisionalUI.lensOn {
    case .filledTint: .white
    case .filledInk: Tokens.color(palette.layer1)
    }
  }

  /// The row's queue note (06.C, 09.D), or nil in Recent.
  private func note(_ guid: String) -> String? {
    if let until = model.snoozedThreads[guid] {
      return "Snoozed until " + QueueStateStore.snoozeLabel(until)
    }
    guard model.lens != .recent, let draft = model.pendingDraft(for: guid), !model.thread.held.contains(draft.id) else {
      return nil
    }
    if model.lens == .triage { return "Draft ready" }
    if model.hasUnsavedEdit(guid) { return QueueStateStore.reasonText(.unsavedEdit) }
    if let opened = model.outbound.renderedAt[draft.id] { return "opened " + ShellText.shortClock(opened) }
    return QueueStateStore.reasonText(.notRendered)
  }

  /// The Triage and Needs You keys' claim: a new value whenever the list
  /// should take the keyboard back.
  private var keysToken: String {
    "\(model.lens.rawValue)-\(model.triageClaim)-\(model.selectedThread ?? "")-\(model.bulkSheetShown)-\(model.auditShown)"
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 5) {
        Text("All")
          .font(.system(size: 10, weight: .medium))
          .foregroundStyle(chipLabel)
          .fixedSize()
          .padding(.vertical, 5)
          .padding(.horizontal, 8)
          .background(Capsule().fill(chipFill))
        if let asOf {
          Text("as of " + ShellText.shortClock(asOf))
            .font(.system(size: 9))
            .foregroundStyle(Tokens.color(palette.inkDim))
            .fixedSize()
        }
        Spacer(minLength: 0)
      }
      .padding(.vertical, 6)
      .padding(.horizontal, 12)
      // One element, "All, as of 16:42": the 9pt stamp (wireframe .tiny,
      // --t-caption) stays the wireframe size and is read with its chip.
      .accessibilityElement(children: .combine)
      Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.2)).frame(height: 0.5).accessibilityHidden(true)
      switch model.lens {
      case .triage: TriageBar(model: model, palette: palette)
      case .needsYou: BulkStrip(model: model, palette: palette)
      case .recent: EmptyView()
      }
      if !model.outbound.countingBatch.isEmpty {
        UndoRing(model: model, palette: palette)
      }
      let rows = model.rows
      if rows.isEmpty {
        Spacer(minLength: 0)
        Text(ProvisionalUI.sidebarEmpty)
          .font(.system(size: 13))
          .foregroundStyle(Tokens.color(palette.inkDim))
          .frame(maxWidth: .infinity)
          .accessibilityIdentifier(ShellID.sidebarEmpty)
        Spacer(minLength: 0)
      } else {
        ScrollView {
          LazyVStack(spacing: 0) {
            ForEach(rows, id: \.chatGuid) { thread in
              ListRow(
                thread: thread, showsChannel: model.scope == .all, selected: model.selectedThread == thread.chatGuid,
                asOf: asOf, palette: palette, dark: dark, note: note(thread.chatGuid),
                dimmed: model.snoozedThreads[thread.chatGuid] != nil,
                checked: model.queue.selection.contains(thread.chatGuid)
              ) { model.selectedThread = thread.chatGuid }
              .accessibilityIdentifier(ShellID.rowPrefix + thread.chatGuid)
            }
          }
          .accessibilityElement(children: .contain)
          .accessibilityLabel("Threads")
        }
        .scrollIndicators(.never)
      }
      Text(model.connectionLine)
        .font(.system(size: ProvisionalUI.connectionFontSize))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .accessibilityValue(model.connectionLine)
        .accessibilityIdentifier(ShellID.connection)
        .padding(12)
    }
    .frame(width: ShellView.sidebarWidth)
    .frame(maxHeight: .infinity)
    .background {
      if model.lens != .recent {
        TriageKeys(model: model, token: keysToken).frame(width: 0, height: 0).accessibilityHidden(true)
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier(ShellID.sidebar)
  }
}
