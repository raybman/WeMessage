import Foundation
import XCTest

/// The accessibility identifiers the app publishes (the contract in
/// Sources/WeMessageApp/ShellView.swift; AppHygieneTests H-A5 holds the two
/// lists equal).
enum ID {
  static let shell = "wemessage.shell"
  static let rail = "wemessage.rail"
  static let railAll = "wemessage.rail.all"
  static let railIMessage = "wemessage.rail.imessage"
  static let railWhatsApp = "wemessage.rail.whatsapp"
  static let railLinkedIn = "wemessage.rail.linkedin"
  static let railEmail = "wemessage.rail.email"
  static let sidebar = "wemessage.sidebar"
  static let lens = "wemessage.lens"
  static let sidebarEmpty = "wemessage.sidebar.empty"
  static let connection = "wemessage.connection"
  static let contentEmpty = "wemessage.content.empty"
  // v2 S4c, board 01.
  static let title = "wemessage.title"
  static let titleCounter = "wemessage.title.counter"
  static let lensRecent = "wemessage.lens.recent"
  static let lensNeedsYou = "wemessage.lens.needsyou"
  static let lensTriage = "wemessage.lens.triage"
  static let killChip = "wemessage.kill.chip"
  static let content = "wemessage.content"
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
  /// Never placed while D-UI-17 is absent-with-reason: tests assert it is not.
  static let composerHold = "wemessage.composer.hold"
  static let composerOutbox = "wemessage.composer.outbox"
  /// A transcript bubble is this prefix and its message guid.
  static let bubblePrefix = "wemessage.thread.bubble."
  /// A day separator is this prefix and its day key (yyyy-MM-dd).
  static let dayPrefix = "wemessage.thread.day."
  /// A held draft is this prefix and its draft id.
  static let heldPrefix = "wemessage.thread.held."
  // v2 S4e, board 08: the specimen sheet and its specimens.
  static let atlas = "wemessage.atlas"
  /// A page of the sheet is this prefix and its section slug.
  static let atlasPagePrefix = "wemessage.atlas."
  static let reactionPrefix = "wemessage.bubble.reaction."
  static let deliveryPrefix = "wemessage.bubble.delivery."
  static let draftSpecimenPrefix = "wemessage.bubble.draft."
  static let smsPrefix = "wemessage.bubble.sms."
  static let effectPrefix = "wemessage.bubble.effect."
  static let unsupportedPrefix = "wemessage.bubble.unsupported."
  // v2 S4f, boards 06 and 09.
  static let triageBar = "wemessage.triage.bar"
  static let bulkStrip = "wemessage.bulk.strip"
  static let bulkOpen = "wemessage.bulk.open"
  static let auditOpen = "wemessage.audit.open"
  static let bulkSheet = "wemessage.bulk.sheet"
  static let bulkConfirm = "wemessage.bulk.confirm"
  static let bulkCancel = "wemessage.bulk.cancel"
  static let bulkIncludedPrefix = "wemessage.bulk.included."
  static let bulkExcludedPrefix = "wemessage.bulk.excluded."
  static let undoRing = "wemessage.undo.ring"
  static let verbs = "wemessage.verbs"
  static let verbReply = "wemessage.verb.reply"
  static let verbDone = "wemessage.verb.done"
  static let verbSnooze = "wemessage.verb.snooze"
  static let verbMute = "wemessage.verb.mute"
  /// A draft's verbs outside Recent: the prefix, the id, then the verb.
  static let draftPrefix = "wemessage.draft."
  static let release = "wemessage.thread.release"
  static let killBanner = "wemessage.kill.banner"
  static let killDisengage = "wemessage.kill.disengage"
  static let zero = "wemessage.zero"
  static let zeroReceipt = "wemessage.zero.receipt"
  static let zeroVerify = "wemessage.zero.verify"
  static let connectCard = "wemessage.connect.card"
  static let audit = "wemessage.audit"
  static let auditClose = "wemessage.audit.close"
  static let auditRowPrefix = "wemessage.audit.row."
  // v2 S4h, board 10.
  static let trustBanner = "wemessage.trust.banner"
  static let trustAction = "wemessage.trust.action"
  static let freshness = "wemessage.freshness"
  /// A row of the age table: the prefix and the scope.
  static let freshnessRowPrefix = "wemessage.freshness.row."
  static let freshnessFooter = "wemessage.freshness.footer"
  static let revokedBanner = "wemessage.revoked.banner"
  static let revokedFix = "wemessage.revoked.fix"
  static let fda = "wemessage.fda"
  static let fdaOpen = "wemessage.fda.open"
  static let fdaSkip = "wemessage.fda.skip"
  static let states = "wemessage.states"
  static let statesTabPrefix = "wemessage.states.tab."
  static let statesPagePrefix = "wemessage.states.page."
  /// An empty: the prefix and its case; its action adds ".action".
  static let emptyPrefix = "wemessage.empty."
  static let pacing = "wemessage.pacing"
  static let collision = "wemessage.collision"
  // v2 S4h, board 12: onboarding.
  static let onboarding = "wemessage.onboarding"
  static let onboardingStep = "wemessage.onboarding.step"
  /// A page: the prefix and the step's slug (1, 2a, 2b, 2c, 2c-copy, 3, 4,
  /// 5, 6, done).
  static let onboardingPagePrefix = "wemessage.onboarding.page."
  static let onboardingCardPrefix = "wemessage.onboarding.card."
  static let onboardingConnectPrefix = "wemessage.onboarding.connect."
  static let onboardingSkipPrefix = "wemessage.onboarding.skip."
  static let onboardingNext = "wemessage.onboarding.next"
  static let onboardingOpenAgain = "wemessage.onboarding.again"
  static let onboardingSizing = "wemessage.onboarding.sizing"
  static let onboardingProgress = "wemessage.onboarding.progress"
  static let onboardingNotBuilt = "wemessage.onboarding.notbuilt"
  static let onboardingAgentOff = "wemessage.onboarding.agent.off"
  static let onboardingAgentDraft = "wemessage.onboarding.agent.draft"
  static let onboardingAgentChannelPrefix = "wemessage.onboarding.agent.channel."
  static let onboardingKill = "wemessage.onboarding.kill"
  static let onboardingDone = "wemessage.onboarding.done"
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

  // v2 S4j, board 13.
  static let settings = "wemessage.settings"
  static let settingsPanePrefix = "wemessage.settings.pane."
  static let settingsPagePrefix = "wemessage.settings.page."
  static let settingsTheme = "wemessage.settings.appearance.theme"
  static let settingsAppearancePrefix = "wemessage.settings.appearance."
  static let settingsReduceTransparency = "wemessage.settings.appearance.reducetransparency"
  static let settingsKeyboardRowPrefix = "wemessage.settings.keyboard.row."
  static let settingsParkedAutosend = "wemessage.settings.parked.autosend"
  static let settingsParkedSchedules = "wemessage.settings.parked.schedules"
  static let settingsStorage = "wemessage.settings.storage"
  static let settingsStorageDelete = "wemessage.settings.storage.delete"
  static let settingsConfirmSheet = "wemessage.settings.confirm.sheet"
  static let settingsConfirmCancel = "wemessage.settings.confirm.cancel"
  static let settingsConfirmGo = "wemessage.settings.confirm.go"
  static let settingsKillState = "wemessage.settings.kill.state"
  static let settingsKillRelease = "wemessage.settings.kill.release"

  // v2 S4j, board 14.
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
  // v2 S4m, board 17: progress, reachable only with WEMESSAGE_UI_BOARD=17
  // under the UI-test flag (D-UI-121, D-UI-123). The board window and its
  // tabs (this prefix and the page), a meter row per channel (this prefix
  // and the scope; its mark adds ".state", label the state in words) and
  // the global row, the streak block with its two runs and the ribbon
  // (label its days), a stat tile per key (this prefix and the key), the
  // card with Copy, Save and Share and its export status (label the png
  // size, bytes, pasteboard, where Save wrote, numeral boxes), and the
  // zero screen's kind (label "<kind>: <heading>"), Progress link and
  // streak line.
  static let progress = "wemessage.progress"
  static let progressTabPrefix = "wemessage.progress.tab."
  static let meterPrefix = "wemessage.meter."
  static let meterAll = "wemessage.meter.all"
  static let streak = "wemessage.streak"
  static let streakCurrent = "wemessage.streak.current"
  static let streakLongest = "wemessage.streak.longest"
  static let streakRibbon = "wemessage.streak.ribbon"
  static let statPrefix = "wemessage.stat."
  static let card = "wemessage.card"
  static let cardCopy = "wemessage.card.copy"
  static let cardSave = "wemessage.card.save"
  static let cardShare = "wemessage.card.share"
  static let cardStatus = "wemessage.card.status"
  static let zeroKind = "wemessage.zero.kind"
  static let zeroProgress = "wemessage.zero.progress"
  static let zeroStreak = "wemessage.zero.streak"
  // v2 B0, board 03.
  static let whatsAppBoard = "wemessage.board.whatsapp"
  static let whatsAppBanner = "wemessage.board.whatsapp.banner"
  static let whatsAppEmpty = "wemessage.board.whatsapp.empty"
  static let fixtureChip = "wemessage.board.chip"
  // v2 B2, board 05: the board, its banner, the open thread and a card per
  // message (this prefix and the turn guid), the images row per message
  // (value "blocked" or "loaded") and its Load images, the invite, the
  // verbs, the inline compose (value the mode) and its parts (Send's value
  // "enabled" or "inert", the state line's value the phase, the wall's
  // "warn" or "block"), and the category chips (value "on" or "off").
  static let emailBoard = "wemessage.board.email"
  static let emailBanner = "wemessage.board.email.banner"
  static let emailEmpty = "wemessage.board.email.empty"
  static let emailThread = "wemessage.email.thread"
  static let emailCardPrefix = "wemessage.email.card."
  static let emailImagesPrefix = "wemessage.email.images."
  static let emailLoadPrefix = "wemessage.email.load."
  static let emailInvite = "wemessage.email.invite"
  static let emailReplyAll = "wemessage.email.replyall"
  static let emailForward = "wemessage.email.forward"
  static let emailCompose = "wemessage.email.compose"
  static let emailComposeTo = "wemessage.email.compose.to"
  static let emailComposeBody = "wemessage.email.compose.body"
  static let emailComposeHold = "wemessage.email.compose.hold"
  static let emailComposeWall = "wemessage.email.compose.wall"
  static let emailComposeSend = "wemessage.email.compose.send"
  static let emailComposeUndo = "wemessage.email.compose.undo"
  static let emailComposeDiscard = "wemessage.email.compose.discard"
  static let emailComposeState = "wemessage.email.compose.state"
  static let emailChipPrefix = "wemessage.email.chip."

  static func draftVerb(_ draftId: String, _ verb: String) -> String { draftPrefix + draftId + "." + verb }

  /// Never placed: no typing indicator is drawn either way (08.J). Tests
  /// assert it is absent; the app never spells it.
  static let typing = "wemessage.typing"
  /// Never placed: no react affordance exists on any bubble (08.C).
  static let reactAffordancePrefix = "wemessage.bubble.react."

  static let railTiles = [railAll, railIMessage, railWhatsApp, railLinkedIn, railEmail]
}

@MainActor
enum UITestApp {
  /// Every wait in the bundle.
  nonisolated static let timeout: TimeInterval = 20

  /// The app under test, configured from the runner's environment. Every
  /// WEMESSAGE_* key the job exported with a TEST_RUNNER_ prefix arrives in
  /// ProcessInfo here and is copied to the app explicitly: nothing is
  /// forwarded wholesale.
  ///
  /// `reduceTransparency` forces the app's copy of the Reduce Transparency
  /// display option ("1" on, "0" off); nil leaves the system's value.
  ///
  /// `board` opens a board's specimen sheet (WEMESSAGE_UI_BOARD; "08" is
  /// the message atlas) in place of the shell.
  static func make(appearance: String, reduceTransparency: Bool? = nil, board: String? = nil) -> XCUIApplication {
    let env = ProcessInfo.processInfo.environment
    let app = XCUIApplication()
    app.launchArguments = ["-ApplePersistenceIgnoreState", "YES", "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
    var launch: [String: String] = ["WEMESSAGE_UI_TEST": "1", "WEMESSAGE_UI_APPEARANCE": appearance]
    if let reduceTransparency { launch["WEMESSAGE_UI_REDUCE_TRANSPARENCY"] = reduceTransparency ? "1" : "0" }
    if let board { launch["WEMESSAGE_UI_BOARD"] = board }
    for key in ["WEMESSAGE_DIR", "WEMESSAGE_PORT", "TZ"] {
      if let value = env[key], !value.isEmpty { launch[key] = value }
    }
    app.launchEnvironment = launch
    return app
  }

  static func shellElement(_ app: XCUIApplication) -> XCUIElement {
    app.descendants(matching: .any)[ID.shell]
  }

  // No snapshot directory: the ad hoc-signed runner is sandboxed and cannot
  // write under the job's temp dir. PNGs leave only as .keepAlways attachments.

  /// Where the app's geometry string arrived, and the string. A SwiftUI
  /// container's value is dropped on macOS (measured, run 37553425686), so
  /// the app publishes on the shell's value and label and on the window's
  /// value; the first that carries it wins.
  static func geometryText(_ app: XCUIApplication) -> (channel: String, raw: String)? {
    let shell = shellElement(app)
    let atlas = app.descendants(matching: .any)[ID.atlas]
    var candidates: [(String, String?)] = []
    // Board 08's sheet stands in for the shell and publishes the same way.
    // A property read on an element that is not there fails the test, so
    // each root is read only when it exists.
    if atlas.exists {
      candidates += [("atlas.value", atlas.value as? String), ("atlas.label", atlas.label)]
    } else {
      candidates += [("shell.value", shell.value as? String), ("shell.label", shell.label)]
    }
    candidates.append(("window.value", app.windows.firstMatch.value as? String))
    for (channel, raw) in candidates {
      if let raw, raw.hasPrefix("frame=") { return (channel, raw) }
    }
    return nil
  }

  /// Parses "frame=WxH visible=WxH" from the shell root's accessibility
  /// value: the window size the APP computed and the visible frame the APP
  /// saw. Nil until the app has published it.
  static func shellGeometry(_ app: XCUIApplication) -> (frame: CGSize, visible: CGSize)? {
    guard let raw = geometryText(app)?.raw else { return nil }
    var sizes: [String: CGSize] = [:]
    for field in raw.split(separator: " ") {
      let pair = field.split(separator: "=", maxSplits: 1)
      guard pair.count == 2 else { continue }
      let dims = pair[1].split(separator: "x")
      guard dims.count == 2, let w = Double(dims[0]), let h = Double(dims[1]) else { continue }
      sizes[String(pair[0])] = CGSize(width: w, height: h)
    }
    guard let frame = sizes["frame"], let visible = sizes["visible"] else { return nil }
    return (frame, visible)
  }
}
