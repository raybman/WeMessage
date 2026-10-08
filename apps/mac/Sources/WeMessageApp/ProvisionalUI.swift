import Foundation

// PROVISIONAL pending Eric's D-UI-1..77 decisions (D-UI-1..6:
// docs/plans/v2-swift-S3.md §7.2; D-UI-7..21: docs/plans/v2-swift-S4.md
// section 5 and the S4a.0 spike results; D-UI-22..26: the S4c build, where
// the board 01 wireframe left a choice open; D-UI-27..38: the S4d build,
// where board 02 left one open or the daemon cannot yet say what it draws;
// D-UI-39..42: the S4e build, where board 08 and the plan disagree or the
// wireframe leaves a choice open; D-UI-43..53: the S4f build, where boards
// 06 and 09 leave a choice open or the daemon cannot serve what they draw;
// D-UI-54..57: the S4g build, where the avatar plan leaves a choice open;
// D-UI-58..68: the S4h build, where board 10 leaves a choice open or the
// daemon cannot serve what it draws; D-UI-69..77: the S4h2 build, where
// board 12 leaves a choice open or the daemon cannot serve what it draws).
// Every value below is the
// plan's default, chosen only so the window can be built and tested before
// the design questions are answered. They
// live in this one file on purpose: when the decisions land, this file is
// the whole edit, and AppHygieneTests fails if any of these values is copied
// as a literal into another app or UI test source.
//
// Foundation only: the CI-only UI test bundle compiles this file too (see
// apps/mac/project.yml), so the XCUITests read the same values the app draws
// and never restate them.
public enum ProvisionalUI {
  // D-UI-1: the channel rail. Collapsed to short labels by default.
  public static let railCollapsed = true
  public static let railCollapsedWidth: Double = 58
  public static let railExpandedWidth: Double = 180
  /// Short tile labels, keyed by the channel scope's raw value.
  public static let railShortLabels: [String: String] = [
    "all": "ALL",
    "imessage": "iM",
    "whatsapp": "WA",
    "linkedin": "LI",
    "email": "EM",
  ]
  public static var railWidth: Double { railCollapsed ? railCollapsedWidth : railExpandedWidth }

  // D-UI-2: the sidebar when there is nothing to list.
  public static let sidebarEmpty = "No conversations yet"

  // D-UI-3: the connection line. Words only, never a coloured dot; inkDim
  // at 11 pt.
  public static let connectionFontSize: Double = 11
  public static let idleLine = "Connecting to the daemon"
  public static let downLine = "Daemon not reachable"
  public static func connectedLine(state: String) -> String { "Connected: " + state }
  public static func reconnectingLine(attempt: Int) -> String { "Reconnecting, attempt " + String(attempt) }

  // D-UI-4: the window's default and minimum size, in points.
  public static let windowDefaultWidth: Double = 1180
  public static let windowDefaultHeight: Double = 760
  public static let windowMinWidth: Double = 870
  public static let windowMinHeight: Double = 560

  // D-UI-5: the content pane with no conversation selected. Text only.
  public static let contentEmpty =
    "No conversation selected. Pick a thread, press up/down to move, or hold shift-cmd-V and just ask."
  public static let contentEmptyGlyph = false

  // D-UI-6: how the selected rail tile is drawn.
  public enum SelectedTileStyle: Sendable {
    /// Filled tint tile with a white label.
    case filledTint
    /// Tint-coloured label on the plain rail.
    case tintLabel
    /// A tint bar on the tile's leading edge.
    case tintBar
  }
  public static let selectedTile: SelectedTileStyle = .filledTint

  // D-UI-7: the frost tint strength. The mockup's numbers by default. The app
  // draws the D-UI-21 material without this tint over it (a .58 tint over
  // the material measured too flat for the frost evidence); Tokens.Frost uses
  // it to model the frost for the luminance and contrast arithmetic.
  public enum FrostTintStrength: Sendable {
    /// .58 light, .62 dark.
    case mockup
    /// .45 light, .50 dark: the backdrop reads more.
    case lighter
    /// .70 light, .75 dark: nearer to opaque.
    case heavier

    public func alpha(dark: Bool) -> Double {
      switch self {
      case .mockup: dark ? 0.62 : 0.58
      case .lighter: dark ? 0.50 : 0.45
      case .heavier: dark ? 0.75 : 0.70
      }
    }
  }
  public static let frostTintStrength: FrostTintStrength = .mockup

  // D-UI-8: the initials avatar palette. Green is excluded in every option.
  public enum AvatarPalette: Sendable {
    /// Blue family only: hues 200 to 240, three saturations, two lightnesses.
    case blueFamily
    /// Blue, violet, orange, red, slate and a cyan at hue 190.
    case mixedNoGreen
    /// Ink discs, no hue.
    case monochrome
  }
  public static let avatarPalette: AvatarPalette = .blueFamily

  // D-UI-9: the Contacts permission copy (NSContactsUsageDescription).
  public static let contactsUsage =
    "WeMessage shows the names and photos from your Contacts next to messages. Nothing is uploaded. You can say no; initials are shown instead."

  // D-UI-10: the avatar when Contacts access is denied.
  public enum DeniedAvatar: Sendable {
    case initialsDisc
    case silhouette
    case lastFourDigits
  }
  public static let deniedAvatar: DeniedAvatar = .initialsDisc

  // D-UI-11: the saturation boost the mockup's backdrop filter implies.
  public enum SaturationBoost: Sendable {
    /// The material's own saturation; no extra layer.
    case materialDefault
    /// A saturated overlay at 8 percent over the frost.
    case overlay
    /// A Core Image backdrop filter (costly, not public for behind-window).
    case coreImage
  }
  public static let saturationBoost: SaturationBoost = .materialDefault

  // D-UI-12: the backdrop the CI snapshots frost over.
  public enum BackdropStyle: Sendable {
    /// The grey-blue two-stop gradient in Tokens.Backdrop.
    case greyBlueTwoStop
    case flatMidGrey
    case desertMultiStop
  }
  public static let backdropStyle: BackdropStyle = .greyBlueTwoStop

  // D-UI-13: the Appearance pane's sentence about frost.
  public static let appearanceSentence =
    "Frost sits on the window behind the panes. Reduce Transparency turns it off; the opaque rendering is the one we designed first. Bubbles and text fields are always opaque."

  // D-UI-14: perceptual-hash snapshot goldens (S4n).
  public enum PerceptualGoldens: Sendable {
    case now(toleranceBits: Int)
    case never
    case afterFirstPointRelease
  }
  public static let perceptualGoldens: PerceptualGoldens = .afterFirstPointRelease

  // D-UI-15: the zero screen's numeral, in points, clamped to the pane at
  // the window's minimum width.
  public static let zeroNumeralSize: Double = 72
  public static let zeroNumeralClampsToPane = true

  // D-UI-16: the draft's undo countdown under Reduce Motion.
  public enum ReducedMotionUndo: Sendable {
    /// Monospace text that ticks from 10 s to 0 s.
    case tickingText
    /// A static line, no countdown.
    case staticText
    /// The ring is kept.
    case ring
  }
  public static let reducedMotionUndo: ReducedMotionUndo = .tickingText

  // D-UI-17: Hold until, before the daemon has a hold route.
  public enum HoldUntil: Sendable {
    /// No control; the composer's capability note gives the reason.
    case absentWithReason
    case drawnWithSheet
    case localTimer
  }
  public static let holdUntil: HoldUntil = .absentWithReason
  public static let holdUntilReason = "Hold until arrives with the daemon's hold route"

  // D-UI-18: the queue window, in days.
  public static let queueWindowDays = 14

  // D-UI-19: the menu bar popover in CI snapshots.
  public enum PopoverSnapshot: Sendable {
    /// The popover's content in a plain window.
    case plainWindow
    case skipped
    case realStatusItem
  }
  public static let popoverSnapshot: PopoverSnapshot = .plainWindow

  // D-UI-20: the reply banner before the daemon knows the account's number.
  public enum ReplyingNumber: Sendable {
    case omitted
    case fromSettings
    case placeholder
  }
  public static let replyingNumber: ReplyingNumber = .omitted
  public static let replyingBanner = "Replying on iMessage"

  // D-UI-21: the window frost material (the S4a.0 spike's default). Drawn as
  // the window's container background, .containerBackground(for: .window),
  // under transparent panes; Reduce Transparency swaps it for layer0.
  public enum FrostMaterial: Sendable {
    /// SwiftUI's regular material.
    case regular
    /// AppKit's HUD window material, behind-window: transmits more.
    case hudWindow
  }
  public static let frostMaterial: FrostMaterial = .regular

  // D-UI-22: where the dated title counter shows. Board 01's frames draw no
  // counter; 06.C says it "appears" in Triage; the S4 plan puts "title and
  // dated counter" in board 01's toolbar. Default: always, for the selected
  // scope, hidden only for a channel that is not connected.
  public enum TitleCounterPlacement: Sendable {
    /// In the title bar under every lens.
    case always
    /// Only while the Triage lens is on (06.C).
    case triageOnly
  }
  public static let titleCounter: TitleCounterPlacement = .always

  // D-UI-23: the reason the cannot-say counter gives (10.A's form is a
  // channel, then stale since, then a time). With no scan at all there is no
  // time to quote.
  public static func cannotSayDetail(channel: String, staleSince: String?) -> String {
    guard let staleSince else { return channel + " has not been read yet" }
    return channel + " not fresh since " + staleSince
  }

  // D-UI-24: what the inspector shows before S4d and S4g give it more. The
  // wireframe draws a 264 pt column and no content for board 01.
  public enum InspectorContent: Sendable {
    /// Avatar, name, channel and handle only.
    case identityOnly
    /// Nothing until there is real content.
    case blank
  }
  public static let inspectorContent: InspectorContent = .identityOnly
  public static let inspectorWidth: Double = 264

  // D-UI-25: the selected lens segment and the "on" filter chip. Default:
  // ink, as the wireframe draws them (white on the tint is 3.65:1 at 10 pt,
  // under the audit's 4.5:1); the alternative is the accent, as D-UI-6 does
  // for the rail.
  public enum LensOnStyle: Sendable {
    /// Filled tint, white label.
    case filledTint
    /// Filled ink, paper label, as drawn.
    case filledInk
  }
  public static let lensOn: LensOnStyle = .filledInk

  // D-UI-26: the selected list row. The wireframe draws a fill and a 3 pt
  // ink bar on the leading edge; the app's accent is the tint.
  public enum SelectedRowStyle: Sendable {
    /// The selection wash and a 3 pt tint bar.
    case tintBarWash
    /// A neutral fill and a 3 pt ink bar, as drawn.
    case inkBarFill
  }
  public static let selectedRow: SelectedRowStyle = .tintBarWash

  // D-UI-27: the outbound bubble's fill. Fill is the only direction cue
  // (wireframe .row.out .bub). The wireframe fills with ink; plan 3.2 names
  // outbound = tint. White 13 pt text on the tint is 3.65:1, under the
  // audit's 4.5:1, so the default is ink, as drawn (the D-UI-25 precedent).
  public enum OutboundFill: Sendable {
    /// Ink fill, paper text, as drawn.
    case ink
    /// Tint fill, white text (plan 3.2; fails AA at 13 pt).
    case tint
  }
  public static let outboundFill: OutboundFill = .ink

  // D-UI-28: an outbound bubble in an SMS chat. Wireframe 02.D draws it 2 pt
  // dashed and unfilled with the transport in words ("fill is reserved for
  // sent as iMessage"); plan S4e draws an inkDim rail instead. The daemon
  // serves no per-message service, so the chat guid's service stands in.
  public enum SmsOutbound: Sendable {
    /// 2 pt dashed, unfilled, as drawn in 02.D.
    case dashedUnfilled
    /// A plain bubble with the plan's inkDim rail on its edge.
    case inkDimRail
  }
  public static let smsOutbound: SmsOutbound = .dashedUnfilled

  // D-UI-29: the draft footer's keycaps (A, R, ⌫). Drawn as the wireframe
  // draws them, but not bound: H-A2+ allows no bare-letter shortcut, and the
  // verbs' keys are S4f's.
  public enum DraftKeycaps: Sendable {
    case shownUnbound
    case hidden
  }
  public static let draftKeycaps: DraftKeycaps = .shownUnbound

  // D-UI-30: the thread head's read line. 02.A draws "read here 9:41 · still
  // unread in Messages.app"; the daemon serves no read state, so only the
  // first half is something the app knows (it read the page at its as-of).
  public enum ReadLine: Sendable {
    /// read here, and the page's as-of clock.
    case readHereOnly
    /// Both halves, as drawn, the second unverified.
    case asDrawn
    case omitted
  }
  public static let readLine: ReadLine = .readHereOnly
  /// The read line for a page read at `clock`; nil when omitted.
  public static func readHere(clock: String) -> String? {
    switch readLine {
    case .readHereOnly: "read here " + clock
    case .asDrawn: "read here " + clock + " · still unread in Messages.app"
    case .omitted: nil
    }
  }

  // D-UI-31: the day separators. Today and Yesterday are measured from
  // the page's as-of, not the Mac's clock, so a fixture reads the same on
  // any day; older days print weekday, month and day.
  public enum DayLabels: Sendable {
    case relativeToAsOf
    case absolute
  }
  public static let dayLabels: DayLabels = .relativeToAsOf

  // D-UI-32: what an attachment-only or audio bubble says. The daemon
  // serves a count, never the files, and no transcript yet (02.G draws the
  // transcript as the payload), so the bubble says exactly that.
  public static func attachmentsLine(count: Int) -> String {
    count == 1 ? "1 attachment, not shown here" : String(count) + " attachments, not shown here"
  }
  public static let voiceLine = "Audio message · no transcript from the daemon yet"

  // D-UI-33: a send the daemon refused as parked (409). 14.F keeps dotted
  // for failed and dashed for not sent; a parked send never left the Mac.
  public enum ParkedBorder: Sendable {
    case dotted
    case dashed
  }
  public static let parkedBorder: ParkedBorder = .dotted
  public static let parkedLine = "Sending is parked on this daemon"

  // D-UI-34: Send in a group. GatewayClient.send addresses one handle, and
  // the daemon answers group-send-disabled, so the composer prints why.
  public static let groupSendReason = "No Send in a group from here: this build sends to one person at a time."

  // D-UI-35: the sender name above an inbound group bubble (02.E). The
  // daemon serves the handle; the name is the title of the one-to-one
  // thread with that handle, when the list has one.
  public enum GroupSenderNames: Sendable {
    case fromOneToOneTitles
    case handles
  }
  public static let groupSenderNames: GroupSenderNames = .fromOneToOneTitles

  // D-UI-36: Hold (⌫) on an agent draft. The daemon has no hold route, so
  // the hold is local to this window: the draft is drawn muted as held for
  // later review and nothing is written. It never becomes a Hold until.
  public enum DraftHold: Sendable {
    case localPark
    case absent
  }
  public static let draftHold: DraftHold = .localPark
  public static let heldLine = "HELD for later review · not sent, still waiting in the daemon"

  // D-UI-37: the draft-pending composer. 02.A draws the verb row and the
  // line Or just start typing; the field the keystrokes go to sits under
  // the verbs, with that line as its placeholder.
  public enum DraftComposer: Sendable {
    case verbsAboveField
    case verbsOnly
  }
  public static let draftComposer: DraftComposer = .verbsAboveField

  // D-UI-38: the line under an agent draft that says why it exists (02.A
  // draws the rule's name and a sentence about past replies). The daemon
  // serves the proactive reason or a rule id, never a name or a sentence,
  // so the line says only what it serves.
  public static func whyLine(proactiveReason: String?, ruleId: String?) -> String? {
    if let proactiveReason, !proactiveReason.isEmpty { return proactiveReason }
    guard let ruleId else { return nil }
    return "Matched rule " + ruleId
  }

  // D-UI-39: an SMS message in an iMessage chat (08.I). The plan says an
  // inset rail plus a printed tag, never green and never dashed (dashed
  // means not sent, and this message was sent); 08.I draws exactly that on
  // a filled bubble. Board 02's SMS chat keeps D-UI-28; this is per message.
  public enum SMSMessage: Sendable {
    case insetRailAndTag
  }
  public static let smsMessage: SMSMessage = .insetRailAndTag
  public static let smsMessageTag = "SMS · not iMessage · unencrypted"
  public static let smsMessageNote = "History only. WeMessage did not send this and cannot."

  // D-UI-40: emoji. An emoji-only message and every reaction chip draw the
  // text presentation (U+FE0E appended), monochrome by construction: a
  // colour glyph could carry the one colour the app never shows. The 2.6x
  // scale is the plan's; whether colour emoji return in the theme pass is
  // the open question.
  public enum EmojiPresentation: Sendable {
    case textMonochrome
  }
  public static let emojiPresentation: EmojiPresentation = .textMonochrome
  public static let emojiOnlyScale: Double = 2.6

  // D-UI-41: the inbound fill. Plan 1.4 says layer-2 solid; 08.A and board
  // 02 draw paper with a 1 pt ink rule. Board 02 already ships the rule, so
  // the atlas matches it until the decision lands.
  public enum InboundFill: Sendable {
    case layer1Outlined
    case layer2Solid
  }
  public static let inboundFill: InboundFill = .layer1Outlined

  // D-UI-42: the specimen sheet's page marker (08.A..08.J, one page each
  // at the pinned window size). The wireframe is one long scroll and has no
  // marker; the sheet pages, and marks the page it shows in the tint.
  public enum AtlasPageMarker: Sendable {
    case tintDots
  }
  public static let atlasPageMarker: AtlasPageMarker = .tintDots

  // D-UI-43: the queue's clock. 06.A measures the window and the counter
  // against "now"; the daemon serves lastScan, and a draft can be newer than
  // the last scan. The clock is the later of the two, so a draft made after
  // the scan is never in the future of the board that draws it.
  public enum QueueClock: Sendable {
    case laterOfScanAndNewestDraft
    case lastScanOnly
  }
  public static let queueClock: QueueClock = .laterOfScanAndNewestDraft

  // D-UI-44: what a pending draft does to queue membership. 06.A's table
  // says "always, overrides all"; 06.C draws Done, Snooze and Mute live
  // beside a draft. Until acted on: an act clears the draft that was there,
  // and a newer draft re-queues the thread (06.G).
  public enum DraftQueueRule: Sendable {
    case untilActedOn
    case always
  }
  public static let draftQueueRule: DraftQueueRule = .untilActedOn

  // D-UI-45: the tail of a held draft's meta line (09.B). The daemon has no
  // hold route (D-UI-36), so the held draft keeps its daemon expiry; the
  // line says so instead of 09.B's "will not expire".
  public static func heldTail(expires clock: String?) -> String {
    guard let clock else { return "no expiry served" }
    return "still expires " + clock + ", daemon side"
  }

  // D-UI-46: Snooze (06.C "Snooze until Monday 9:00"). The daemon has no
  // snooze route and 06 draws no picker, so a snooze runs to the next 9:00
  // and is labelled with the weekday.
  public static let snoozeHour = 9
  public static let snoozeLabelPattern = "EEEE H:mm"

  // D-UI-47: where the verbs sit. 09.A puts Approve A / Edit R / Hold ⌫
  // under the draft bubble; 06.C puts the queue verbs in a row under the
  // Triage header. Needs You draws the per-draft verbs under each bubble,
  // Triage draws the VerbRow, every other lens keeps the composer's verbs.
  // Bulk approve is ⇧A from the list (09.D), never a ⌘ chord.
  public enum VerbPlacement: Sendable {
    case bubbleInNeedsYouRowInTriage
  }
  public static let verbPlacement: VerbPlacement = .bubbleInNeedsYouRowInTriage

  // D-UI-48: the not-connected zero (06.E) offers the connect flow, and
  // 09.H draws the iMessage card with a message count and a button. The
  // daemon serves neither the count nor a connect route the app can call,
  // so the card prints the four paragraphs and no button.
  public static let connectCardButton = false
  public static let connectCardLines: [String] = [
    "How it works. Apple offers no API for iMessage. WeMessage reads the database Messages.app keeps on this Mac (Full Disk Access) and sends through Messages.app with AppleScript.",
    "What works. Read, search, full history, send text, attachments.",
    "What does not, and cannot. Tapbacks, edit, unsend, effects, typing indicators.",
    "Risk to you. No known Apple ID risk. A macOS update can break reading until WeMessage is updated.",
  ]

  // D-UI-49: the audit view (09.G). The daemon's audit rows carry no
  // result column, so Result prints this; the view opens from the Needs
  // You strip and lists the newest row at the bottom.
  public static let auditResultUnserved = "not served"
  public enum AuditEntry: Sendable {
    case needsYouStrip
  }
  public static let auditEntry: AuditEntry = .needsYouStrip

  // D-UI-50: the kill banner (09.F). The daemon does not serve when the
  // switch went on, so the banner has no "since"; Disengage is a click only
  // (no ⇧⌘K), so no chord can turn sending back on by accident.
  public static let killBannerLine = "KILL SWITCH ON. Nothing can be sent by anything, including you."
  public enum KillDisengage: Sendable {
    case clickOnly
  }
  public static let killDisengage: KillDisengage = .clickOnly

  // D-UI-51: Done, Snooze and Mute (06.C). The daemon has no route for
  // them, so they live in this window's memory and end with it.
  public enum QueueStatePersistence: Sendable {
    case memoryOnly
  }
  public static let queueStatePersistence: QueueStatePersistence = .memoryOnly

  // D-UI-52: the zero screen (06.E). It prints the last event's clock, not
  // a relative age, and does not hand off to the next channel: the build
  // syncs one source.
  public enum ZeroHandOff: Sendable {
    case stayOnChannel
  }
  public static let zeroHandOff: ZeroHandOff = .stayOnChannel

  // D-UI-53: the rationale block (09.C). The daemon serves the rule id and
  // the proactive reason, not style evidence, the messages read, or what
  // was not done, so the block prints only the served lines.
  public enum RationaleLines: Sendable {
    case servedOnly
  }
  public static let rationaleLines: RationaleLines = .servedOnly

  // D-UI-54: when Contacts is asked for. Never at launch: the first time
  // the user opens a thread, once, and never again (S4g). The plan names no
  // moment; an inspector button or an onboarding step are the others.
  public enum ContactsPromptMoment: Sendable {
    case firstThreadOpened
    case inspectorButton
    case onboarding
  }
  public static let contactsPromptMoment: ContactsPromptMoment = .firstThreadOpened

  // D-UI-55: a group thread's avatar. The plan's avatar is one person's;
  // a group draws its title's initials on a disc keyed by the chat guid.
  public enum GroupAvatar: Sendable {
    case titleInitials
    case stackedPhotos
    case glyph
  }
  public static let groupAvatar: GroupAvatar = .titleInitials

  // D-UI-56: a title with no letters (a bare number) draws a person glyph
  // on the disc rather than digits.
  public enum LetterlessAvatar: Sendable {
    case personGlyph
    case lastTwoDigits
  }
  public static let letterlessAvatar: LetterlessAvatar = .personGlyph

  // D-UI-57: the letters on a disc are the appearance's ink (7:1 on every
  // disc), not white, which fails 7:1 on the light blue discs.
  public enum AvatarInk: Sendable {
    case paletteInk
    case white
  }
  public static let avatarInk: AvatarInk = .paletteInk

  // v2 S4h, board 10. Defaults first; each is Eric's to confirm.

  // D-UI-58: the trust banner (10.A) says since when, as a clock, not how
  // long, as a duration: a duration needs the wall clock, and the board's
  // fold reads none (rule 8: never show a number you cannot date).
  public enum TrustBannerAge: Sendable {
    case sinceClock
    case duration
  }
  public static let trustBannerAge: TrustBannerAge = .sinceClock

  // D-UI-59: the banner's one action. 10.A's is WhatsApp's Re-link device;
  // iMessage has no re-link, so the action opens the per-channel ages.
  public static let trustBannerAction = "Show ages"

  // D-UI-60: the age table's count column (10.A). The daemon serves today's
  // count, not a mirrored total, so each live row prints N today, the
  // healthy foot is Mirrored as of, and a stale row turns the foot to
  // CANNOT SAY. A channel that is not connected prints no number.
  public enum FreshnessCount: Sendable {
    case today
    case mirroredTotal
  }
  public static let freshnessCount: FreshnessCount = .today

  // D-UI-61: the same table in Settings. There is no Settings window yet,
  // so the same FreshnessTable and PacingTable views are drawn on the 10.B
  // sheet's second page; Settings places them when it lands.
  public enum StatesSettingsCopy: Sendable {
    case sheetUntilSettings
  }
  public static let statesSettingsCopy: StatesSettingsCopy = .sheetUntilSettings

  // D-UI-62: each empty offers exactly one action (10.B). The wireframe
  // draws two on inbox zero (LinkedIn next, Done for now) and two on search
  // (Include muted, Attachments too); this build keeps one each, stays on
  // the channel (D-UI-52), and drops the hold-to-ask clause from the
  // unselected empty, because voice is not built.
  // Keyed by EmptyStateCase's raw value (this file is Foundation only).
  public static let emptyActions: [String: String] = [
    "zero": "Done for now",
    "quiet": "Show yesterday",
    "unselected": "Open Needs You",
    "search": "Include muted",
    "new": "Write the first message",
  ]

  // D-UI-63: the 10.B sheet's channels. The build syncs iMessage only, so
  // the earned zero, the quiet day and the new thread are iMessage's, and
  // the not-connected empty is LinkedIn's, as 10.B draws it. The shell's
  // own empties keep their S3 and S4f lines until a slice places these.
  public enum EmptiesChannel: Sendable {
    case iMessageWithLinkedInUnconnected
  }
  public static let emptiesChannel: EmptiesChannel = .iMessageWithLinkedInUnconnected

  // D-UI-64: Full Disk Access (10.C). The screen opens nothing itself: it
  // asks FullDiskAccessSeam, whose fixture under the UI-test flag counts
  // the ask. Skip iMessage for now closes the screen for this window only.
  // The deep link itself lands with onboarding (board 12).
  public enum FDASkip: Sendable {
    case closeForThisWindow
  }
  public static let fdaSkip: FDASkip = .closeForThisWindow

  // D-UI-65: the revoked banner's up to (10.C) is the last scan this
  // window saw before the daemon said source-unavailable, held in memory.
  // The daemon does not serve when access was lost.
  public enum RevokedSince: Sendable {
    case lastScanThisWindowSaw
  }
  public static let revokedSince: RevokedSince = .lastScanThisWindowSaw

  // D-UI-66: the pacing table (10.D) draws iMessage's two rows only. The
  // daemon does not serve sends today, so the live table would print not
  // served; the 10.B sheet passes the fixture's count.
  public enum PacingChannels: Sendable {
    case iMessageOnly
  }
  public static let pacingChannels: PacingChannels = .iMessageOnly

  // D-UI-67: the collision notice (10.E) is drawn on the 10.B sheet. The
  // composer places it when the daemon serves a draft-arrived-while-typing
  // event; today it serves none.
  public enum CollisionPlacement: Sendable {
    case sheetOnly
  }
  public static let collisionPlacement: CollisionPlacement = .sheetOnly

  // D-UI-68: the age table's popover is drawn inside the window, beside the
  // rail, not as a separate popover window, so a snapshot holds it. Rail
  // hover opens it and leaving closes it; the banner's action pins it until
  // pressed again.
  public enum FreshnessPopover: Sendable {
    case inWindowOverlay
  }
  public static let freshnessPopover: FreshnessPopover = .inWindowOverlay

  // v2 S4h, board 12: onboarding.

  // D-UI-69: the wireframe's 12.I is the first-thread handover, so board
  // 12's "I" shot is that screen. The interrupted case (quit at 2c by the
  // grant, relaunched) is not a screen of its own: the relaunch resumes on
  // the step it left, which the model tests prove and the shots show as 2c.
  public enum InterruptedState: Sendable {
    case resumeOnTheSameStep
  }
  public static let interruptedState: InterruptedState = .resumeOnTheSameStep

  // D-UI-70: the handover rail (12.I legend 6) is 200 pt wide, each tile
  // with its full channel name beside it, and the voice dock's idle line at
  // its foot. Only the five scope tiles are drawn: the wireframe's Add a
  // channel, Voice and Settings tiles are not part of this rail yet. The
  // first tile click collapses it to the 58 pt rail, once.
  public static let handoverRailWidth: Double = 200

  // D-UI-71: steps 3 to 5 (WhatsApp, LinkedIn, Email) draw their
  // disclosure in full, say the channel is not in this version, and offer
  // Skip <channel> as the only forward control. No QR, no sign-in window,
  // no provider list. A card's Connect on step 1 goes to that channel's
  // step; its Skip marks the channel declined and passes over its step.
  public enum ChannelSteps: Sendable {
    case disclosureAndSkipOnly
  }
  public static let channelSteps: ChannelSteps = .disclosureAndSkipOnly

  // D-UI-72: the daemon serves no message count, chat count, size or copy
  // progress today, so the shipped seam answers nothing and 2c and
  // CopyProgress print not served (auditResultUnserved). Make the copy
  // records the choice; the copy itself is the daemon's ingest. The UI-test
  // fixture serves the wireframe's figures.
  public enum CopyFacts: Sendable {
    case notServedUntilTheDaemonCounts
  }
  public static let copyFacts: CopyFacts = .notServedUntilTheDaemonCounts

  // D-UI-73: 2b draws the in-app half only (Waiting, the 2 s line, Open
  // System Settings again). The System Settings half of the wireframe is
  // the system's own window and is never drawn by the app.
  public enum WaitingHalf: Sendable {
    case inAppOnly
  }
  public static let waitingHalf: WaitingHalf = .inAppOnly

  // D-UI-74: the coach row's dismissing keystroke is consumed (it is the
  // answer to "press any key", not a triage verb), by a local key-down
  // monitor that lives only while the row is up. Any key counts, Escape or
  // not; the monitor reads no key code.
  public enum CoachKey: Sendable {
    case anyKeyConsumed
  }
  public static let coachKey: CoachKey = .anyKeyConsumed

  // D-UI-75: onboarding takes the window on a shipped launch until its
  // handover is spent, kept in the app's defaults. Under the UI-test flag
  // only board 12 reaches it, with an in-memory store, so no other board's
  // launch ever sees it.
  public enum OnboardingGate: Sendable {
    case untilHandoverSpent
  }
  public static let onboardingGate: OnboardingGate = .untilHandoverSpent

  // D-UI-76: KillIntro's engaged specimen is drawn in ink, not red, and
  // its Disengage is drawn, not a control: it is a picture of the banner,
  // and nothing on this board touches the kill switch.
  public enum KillSpecimen: Sendable {
    case inkAndInert
  }
  public static let killSpecimen: KillSpecimen = .inkAndInert

  // D-UI-77: setup complete (12.G) prints the choices made, a line per
  // channel, with no ages: nothing has synced yet when it is drawn. 12.H
  // (disconnect and delete) is Settings' and is not built on this board.
  public enum SetupComplete: Sendable {
    case choicesOnly
  }
  public static let setupComplete: SetupComplete = .choicesOnly
}
