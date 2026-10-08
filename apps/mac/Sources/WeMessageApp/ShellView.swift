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
  // v2 S4h, board 10.
  /// The trust banner (10.A); its label is the line. Its one action pins
  /// the per-channel ages.
  static let trustBanner = "wemessage.trust.banner"
  static let trustAction = "wemessage.trust.action"
  /// The per-channel age table, a row per channel (this prefix and the
  /// scope), and its foot.
  static let freshness = "wemessage.freshness"
  static let freshnessRowPrefix = "wemessage.freshness.row."
  static let freshnessFooter = "wemessage.freshness.footer"
  /// Lost access while running (10.C) and its Fix.
  static let revokedBanner = "wemessage.revoked.banner"
  static let revokedFix = "wemessage.revoked.fix"
  /// The Full Disk Access screen (10.C); Open's value is how many times it
  /// asked the seam.
  static let fda = "wemessage.fda"
  static let fdaOpen = "wemessage.fda.open"
  static let fdaSkip = "wemessage.fda.skip"
  /// Board 10's sheet (10.B), reachable only with WEMESSAGE_UI_BOARD=10.B
  /// under the UI-test flag (H-S4-6): its tabs and pages by slug.
  static let states = "wemessage.states"
  static let statesTabPrefix = "wemessage.states.tab."
  static let statesPagePrefix = "wemessage.states.page."
  /// One empty is this prefix and its case; its one action adds ".action".
  static let emptyPrefix = "wemessage.empty."
  /// The pacing table (10.D) and the collision notice (10.E).
  static let pacing = "wemessage.pacing"
  static let collision = "wemessage.collision"
  // v2 S4j, board 13: settings, reachable only with WEMESSAGE_UI_BOARD=13
  // under the UI-test flag (D-UI-89). A sidebar row and a page per pane
  // (these prefixes and the pane: accounts, drafting, notifications,
  // appearance, keyboard, storage, confirm).
  static let settings = "wemessage.settings"
  static let settingsPanePrefix = "wemessage.settings.pane."
  static let settingsPagePrefix = "wemessage.settings.page."
  /// Appearance: the theme row and the three mirrored rows (this prefix and
  /// reducetransparency, increasecontrast, reducemotion).
  static let settingsTheme = "wemessage.settings.appearance.theme"
  static let settingsAppearancePrefix = "wemessage.settings.appearance."
  static let settingsReduceTransparency = "wemessage.settings.appearance.reducetransparency"
  /// Keyboard: a row per binding (this prefix and the verb or fixed id).
  static let settingsKeyboardRowPrefix = "wemessage.settings.keyboard.row."
  /// Drafting: the parked rows (this prefix and autosend, schedules).
  static let settingsParkedPrefix = "wemessage.settings.parked."
  static let settingsParkedAutosend = "wemessage.settings.parked.autosend"
  static let settingsParkedSchedules = "wemessage.settings.parked.schedules"
  static let settingsStorage = "wemessage.settings.storage"
  static let settingsStorageDelete = "wemessage.settings.storage.delete"
  /// The confirm card, its Cancel and its one go control.
  static let settingsConfirmSheet = "wemessage.settings.confirm.sheet"
  static let settingsConfirmCancel = "wemessage.settings.confirm.cancel"
  static let settingsConfirmGo = "wemessage.settings.confirm.go"
  /// Confirmations: the kill switch's state (value on, off or unknown) and
  /// Release, shown only while it is on.
  static let settingsKillState = "wemessage.settings.kill.state"
  static let settingsKillRelease = "wemessage.settings.kill.release"
  // v2 S4j, board 14: compose, reachable only with WEMESSAGE_UI_BOARD=14
  // under the UI-test flag (D-UI-95). The window, its two tabs and pages
  // (these prefixes and new, states), the To field, the chosen person's
  // chip, a row per match and a card per channel (these prefixes and the
  // person's id or imessage, whatsapp, linkedin, email), the banner, the
  // capability strip and a slot per capability (this prefix and the slot
  // id), the proposal region and its Ask, Approve and Hold, the input, Send,
  // Undo, the live bubble (value composing, undo, drafting, drafted,
  // failed) and a specimen per send state (this prefix and the state).
  static let compose = "wemessage.compose"
  static let composeTabPrefix = "wemessage.compose.tab."
  static let composePagePrefix = "wemessage.compose.page."
  static let composeTo = "wemessage.compose.to"
  static let composeRecipient = "wemessage.compose.recipient"
  static let composeResultPrefix = "wemessage.compose.result."
  static let composeChannelPrefix = "wemessage.compose.channel."
  static let composeBanner = "wemessage.compose.banner"
  static let composeStrip = "wemessage.compose.strip"
  static let composeSlotPrefix = "wemessage.compose.slot."
  static let composeProposal = "wemessage.compose.proposal"
  static let composeProposalAsk = "wemessage.compose.proposal.ask"
  static let composeProposalTake = "wemessage.compose.proposal.take"
  static let composeProposalHold = "wemessage.compose.proposal.hold"
  static let composeField = "wemessage.compose.field"
  static let composeSend = "wemessage.compose.send"
  static let composeUndo = "wemessage.compose.undo"
  static let composeBubble = "wemessage.compose.bubble"
  static let composeStatePrefix = "wemessage.compose.state."
  // v2 S4k, board 15: media, reachable only with WEMESSAGE_UI_BOARD=15
  // under the UI-test flag (D-UI-102). The window, its tabs and pages (these
  // prefixes and thread, walls, refusal), the rail (value refused), the
  // list row, the header, the drop target (value resting, targeted,
  // dwelling, refused), its card and printed reason, the thread (value
  // y=<offset>), a message and an attachment per id (these prefixes), the
  // tray (value its header) with a cell and a remove per item, its lines,
  // the recipient grid and the compression table (a row per target's first
  // word), the composer field, Send (value enabled or inert), the record
  // slot, the note; the viewer (value n / N) and its parts; a wall per
  // channel; the refusal panel, a part per number and its one action; a
  // matrix row per index.
  static let media = "wemessage.media"
  static let mediaTabPrefix = "wemessage.media.tab."
  static let mediaPagePrefix = "wemessage.media.page."
  static let mediaRail = "wemessage.media.rail"
  static let mediaRowPrefix = "wemessage.media.row."
  static let mediaHeader = "wemessage.media.header"
  static let mediaDrop = "wemessage.media.drop"
  static let mediaDropCard = "wemessage.media.drop.card"
  static let mediaDropReason = "wemessage.media.drop.reason"
  static let mediaThread = "wemessage.media.thread"
  static let mediaMessagePrefix = "wemessage.media.message."
  static let mediaItemPrefix = "wemessage.media.item."
  static let mediaTray = "wemessage.media.tray"
  static let mediaTrayItemPrefix = "wemessage.media.tray.item."
  static let mediaTrayRemovePrefix = "wemessage.media.tray.remove."
  static let mediaConversion = "wemessage.media.conversion"
  static let mediaLocation = "wemessage.media.location"
  static let mediaCounter = "wemessage.media.counter"
  static let mediaGrid = "wemessage.media.grid"
  static let mediaCompression = "wemessage.media.compression"
  static let mediaCompressionRowPrefix = "wemessage.media.compression.row."
  static let mediaField = "wemessage.media.field"
  static let mediaSend = "wemessage.media.send"
  static let mediaRecord = "wemessage.media.record"
  static let mediaNote = "wemessage.media.note"
  static let mediaViewer = "wemessage.media.viewer"
  static let mediaViewerPosition = "wemessage.media.viewer.position"
  static let mediaViewerMeta = "wemessage.media.viewer.meta"
  static let mediaViewerLine = "wemessage.media.viewer.line"
  static let mediaViewerOrigin = "wemessage.media.viewer.origin"
  static let mediaViewerClose = "wemessage.media.viewer.close"
  static let mediaViewerPrevious = "wemessage.media.viewer.previous"
  static let mediaViewerNext = "wemessage.media.viewer.next"
  static let mediaViewerKinds = "wemessage.media.viewer.kinds"
  static let mediaViewerSave = "wemessage.media.viewer.save"
  static let mediaViewerReveal = "wemessage.media.viewer.reveal"
  static let mediaViewerCopy = "wemessage.media.viewer.copy"
  static let mediaWallPrefix = "wemessage.media.wall."
  static let mediaRefusal = "wemessage.media.refusal"
  static let mediaRefusalPartPrefix = "wemessage.media.refusal.part."
  static let mediaRefusalTake = "wemessage.media.refusal.take"
  // v2 S4l, board 16: the OS layer, reachable only with WEMESSAGE_UI_BOARD=16
  // under the UI-test flag (D-UI-112). The board window and its tabs (this
  // prefix and healthy, degraded, killed, confirm, menu), the popover
  // (label its mode), its title, stamp and line, a row per entry (this
  // prefix and the entry id), the more line, a source line per channel
  // (this prefix and the channel), the notes, the fixed footer's three
  // items, the extra's glyph per state (this prefix and the state, label
  // its spoken words), the Dock badge and menu, the live main menu read
  // back (label its lines), and the kill confirm with Engage and Cancel.
  static let osLayer = "wemessage.oslayer"
  static let osLayerTabPrefix = "wemessage.oslayer.tab."
  static let osLayerGlyphPrefix = "wemessage.oslayer.glyph."
  static let osLayerDock = "wemessage.oslayer.dock"
  static let osLayerMenu = "wemessage.oslayer.menu"
  static let popover = "wemessage.popover"
  static let popoverTitle = "wemessage.popover.title"
  static let popoverStamp = "wemessage.popover.stamp"
  static let popoverLine = "wemessage.popover.line"
  static let popoverRowPrefix = "wemessage.popover.row."
  static let popoverMore = "wemessage.popover.more"
  static let popoverSourcePrefix = "wemessage.popover.source."
  static let popoverNotes = "wemessage.popover.notes"
  static let popoverOpen = "wemessage.popover.open"
  static let popoverKill = "wemessage.popover.kill"
  static let popoverSettings = "wemessage.popover.settings"
  static let killConfirm = "wemessage.killconfirm"
  static let killConfirmEngage = "wemessage.killconfirm.engage"
  static let killConfirmCancel = "wemessage.killconfirm.cancel"
  static let mediaMatrixPrefix = "wemessage.media.matrix."
  // v2 S4h, board 12: onboarding. The window, its step counter, and a page
  // per step (this prefix and the step's slug: 1, 2a, 2b, 2c, 2c-copy, 3,
  // 4, 5, 6, done).
  static let onboarding = "wemessage.onboarding"
  static let onboardingStep = "wemessage.onboarding.step"
  static let onboardingPagePrefix = "wemessage.onboarding.page."
  /// Step 1's cards and their two buttons: these prefixes and the channel.
  static let onboardingCardPrefix = "wemessage.onboarding.card."
  static let onboardingConnectPrefix = "wemessage.onboarding.connect."
  static let onboardingSkipPrefix = "wemessage.onboarding.skip."
  /// Each page's one forward control.
  static let onboardingNext = "wemessage.onboarding.next"
  /// 2b's Open System Settings again; its value is the asks, the probes and
  /// whether the poll runs.
  static let onboardingOpenAgain = "wemessage.onboarding.again"
  /// 2c's count and CopyProgress.
  static let onboardingSizing = "wemessage.onboarding.sizing"
  static let onboardingProgress = "wemessage.onboarding.progress"
  /// Steps 3 to 5: the channel is not built in this version (D-UI-71).
  static let onboardingNotBuilt = "wemessage.onboarding.notbuilt"
  /// AgentStep's two choices and its per-channel boxes (this prefix and the
  /// channel).
  static let onboardingAgentOff = "wemessage.onboarding.agent.off"
  static let onboardingAgentDraft = "wemessage.onboarding.agent.draft"
  static let onboardingAgentChannelPrefix = "wemessage.onboarding.agent.channel."
  /// KillIntro and setup complete.
  static let onboardingKill = "wemessage.onboarding.kill"
  static let onboardingDone = "wemessage.onboarding.done"
  /// 12.I: the coach row and the voice dock's idle line.
  static let coach = "wemessage.coach"
  static let voiceDock = "wemessage.voice.dock"
  /// Board 11 (prefixes: search.token.<n>, search.group.<channel>,
  /// search.result.<guid>, search.facet.<n>, scrubber.year.<year>,
  /// switcher.row.<id>).
  static let search = "wemessage.search"
  static let searchField = "wemessage.search.field"
  static let searchSummary = "wemessage.search.summary"
  static let searchCoverage = "wemessage.search.coverage"
  static let searchPrompt = "wemessage.search.prompt"
  static let searchFacets = "wemessage.search.facets"
  static let searchTokenPrefix = "wemessage.search.token."
  static let searchGroupPrefix = "wemessage.search.group."
  static let searchResultPrefix = "wemessage.search.result."
  static let searchFacetPrefix = "wemessage.search.facet."
  static let findBar = "wemessage.find"
  static let findField = "wemessage.find.field"
  static let findCounter = "wemessage.find.counter"
  static let scrubber = "wemessage.scrubber"
  static let scrubberLine = "wemessage.scrubber.line"
  static let scrubberYearPrefix = "wemessage.scrubber.year."
  static let switcher = "wemessage.switcher"
  static let switcherField = "wemessage.switcher.field"
  static let switcherRowPrefix = "wemessage.switcher.row."

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
  @State private var model = ShellModel(client: GatewayClient(), avatars: AvatarBook(provider: TestHooks.avatarProvider()))
  /// The system's display options, with a UI test's forced values on top.
  @State private var mirror = AccessibilityMirror.live()
  /// v2 S4l, board 16: the OS layer reads what this window pushes.
  @State private var hub = OSLayerHub.shared
  @Environment(\.colorScheme) private var scheme
  /// 12.I: the first thread after onboarding. The rail has words until its
  /// first tile click, and the coach row sits under the panes until its
  /// first keypress (D-UI-70, D-UI-74).
  let handover: OnboardingModel?

  init(handover: OnboardingModel? = nil) { self.handover = handover }

  /// The title band the hidden title bar leaves to the traffic lights.
  static let titleBand: CGFloat = 52
  /// The conversation list (wireframe .listcol).
  static let sidebarWidth: CGFloat = 300

  private var palette: Tokens.Palette { Tokens.palette(dark: scheme == .dark) }
  private var dark: Bool { scheme == .dark }

  var body: some View {
    ZStack(alignment: .top) {
      VStack(spacing: 0) {
        HStack(spacing: 0) {
          RailView(model: model, palette: palette, mirror: mirror, dark: dark, handover: handover)
          Hairline(mirror: mirror, palette: palette, dark: dark)
          if model.switcher.shown {
            // Board 11 takes the list and thread panes (D-UI-86): the
            // composer, and its Send, is not in the window while it is up.
            QuickSwitcherPane(model: model, switcher: model.switcher, palette: palette)
          } else if model.search.shown {
            SearchPane(model: model, search: model.search, palette: palette)
          } else {
            SidebarView(model: model, palette: palette, dark: dark)
            Hairline(mirror: mirror, palette: palette, dark: dark)
            ContentPane(model: model, palette: palette)
            if model.inspectorShown, let thread = model.selected {
              Hairline(mirror: mirror, palette: palette, dark: dark)
              InspectorPane(thread: thread, image: model.avatars.image(for: thread), palette: palette)
            }
          }
        }
        if let handover, handover.coachShown {
          // 12.I: its own row under the panes, never over them.
          Hairline(mirror: mirror, palette: palette, dark: dark, horizontal: true)
          CoachRow(palette: palette)
            .background(CoachKeyMonitor(model: handover))
        }
      }
      .padding(.top, Self.titleBand + 0.5)
      VStack(spacing: 0) {
        TitleBar(model: model, palette: palette)
        Hairline(mirror: mirror, palette: palette, dark: dark, horizontal: true)
      }
      if model.freshnessPinned || model.freshnessHover {
        // The per-channel ages off the rail (10.A, D-UI-68): an in-window
        // overlay beside the rail, pinned by the trust banner's action.
        FreshnessTable(rows: model.freshnessRows, palette: palette)
          .frame(width: 400)
          .padding(.leading, ProvisionalUI.railWidth + 8)
          .padding(.top, Self.titleBand + 8)
          .frame(maxWidth: .infinity, alignment: .topLeading)
      }
      // Board 11's keys, in every build: search, the switcher, find, years.
      Board11Keys(model: model)
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
    // Board 16: the extra, the Dock and the main menu read one snapshot,
    // and their commands reach this model through the hub.
    .onAppear { model.bindOSLayer(hub) }
    .onChange(of: model.osSnapshot, initial: true) { _, now in hub.snapshot = now }
    .onChange(of: model.popoverInput, initial: true) { _, now in hub.popover = now }
    .onChange(of: model.menuContext, initial: true) { _, now in hub.menuContext = now }
    .sheet(isPresented: $hub.killConfirmShown) {
      KillConfirmView(
        held: model.state.queue.filter { $0.state == .pending }.count, palette: palette,
        onEngage: { hub.perform("kill:engage") }, onCancel: { hub.perform("kill:cancel") }
      )
      .padding(18)
      .frame(width: 400)
    }
  }
}

/// The channel rail (wireframe .rail): one tile per scope, a rule after
/// ALL, and each tile's mark (digit, clear baseline, "!" or nothing).
private struct RailView: View {
  let model: ShellModel
  let palette: Tokens.Palette
  let mirror: AccessibilityMirror
  let dark: Bool
  /// 12.I: the rail has words beside its tiles until the first tile click.
  var handover: OnboardingModel? = nil

  private var expanded: Bool { handover?.railExpanded ?? false }

  var body: some View {
    VStack(alignment: expanded ? .leading : .center, spacing: 8) {
      ForEach(ShellModel.Scope.allCases, id: \.self) { scope in
        HStack(spacing: 10) {
          RailTile(scope: scope, selected: model.scope == scope, mark: model.board.mark(scope), palette: palette) {
            handover?.railTileClicked()
            model.scope = scope
          }
          .accessibilityLabel(scope.fullLabel)
          .keyboardShortcut(KeyEquivalent(scope.shortcutDigit), modifiers: .command)
          .accessibilityIdentifier(ShellID.rail(scope))
          if expanded {
            // The tile's own label already says it: drawn, not read twice.
            Text(scope.fullLabel)
              .font(.system(size: 12, weight: .semibold))
              .foregroundStyle(Tokens.color(palette.ink))
              .lineLimit(1)
              .accessibilityHidden(true)
          }
        }
        if scope == .all {
          Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.35)).frame(width: expanded ? 170 : 26, height: 1)
            .padding(4)
            .accessibilityHidden(true)
        }
      }
      Spacer(minLength: 0)
      if expanded {
        VoiceDockIdle(palette: palette)
      }
    }
    .padding(.vertical, 12)
    .padding(.horizontal, expanded ? 10 : 0)
    .frame(width: expanded ? ProvisionalUI.handoverRailWidth : ProvisionalUI.railWidth)
    .frame(maxHeight: .infinity)
    .contentShape(Rectangle())
    // Hover shows the ages (D-UI-68); never under the UI-test flag, where a
    // parked pointer would make a shot depend on where it rests.
    .onHover { inside in if !TestHooks.isUITest { model.freshnessHover = inside } }
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
                checked: model.queue.selection.contains(thread.chatGuid),
                image: model.avatars.image(for: thread)
              ) { model.open(thread.chatGuid) }
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
