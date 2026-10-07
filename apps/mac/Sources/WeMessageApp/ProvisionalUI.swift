import Foundation

// PROVISIONAL pending Eric's D-UI-1..26 decisions (D-UI-1..6:
// docs/plans/v2-swift-S3.md §7.2; D-UI-7..21: docs/plans/v2-swift-S4.md
// section 5 and the S4a.0 spike results; D-UI-22..26: the S4c build, where
// the board 01 wireframe left a choice open). Every value below is the
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

  // D-UI-17: "Hold until" before the daemon has a hold route.
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
}
