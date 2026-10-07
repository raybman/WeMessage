import Foundation

// PROVISIONAL pending Eric's D-UI-1..42 decisions (D-UI-1..6:
// docs/plans/v2-swift-S3.md §7.2; D-UI-7..21: docs/plans/v2-swift-S4.md
// section 5 and the S4a.0 spike results; D-UI-22..26: the S4c build, where
// the board 01 wireframe left a choice open; D-UI-27..38: the S4d build,
// where board 02 left one open or the daemon cannot yet say what it draws;
// D-UI-39..42: the S4e build, where board 08 and the plan disagree or the
// wireframe leaves a choice open). Every value below is the
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
}
