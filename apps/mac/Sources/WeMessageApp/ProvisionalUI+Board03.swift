import Foundation

// PROVISIONAL pending Eric's D-UI-141..149 decisions: the B1 build, where
// board 03 (WhatsApp, drawn over fixtures) leaves a choice open or the
// bridge cannot yet serve what it draws. Same rules as ProvisionalUI.swift:
// every value is the plan's default or the wireframe's own words, chosen so
// the board can be built and tested before the questions are answered;
// AppHygieneBoard03Tests (H-B-2) fails if any copy here is repeated as a
// literal in another app or UI test source.
//
// Foundation only: the CI-only UI test bundle compiles this file too (see
// apps/mac/project.yml), so the XCUITests read the values the app draws.
extension ProvisionalUI {
  // D-UI-141: with chats listed and none selected, board 03 keeps its banner
  // over a short line instead of the New here state. A linked device's
  // session is drawn as lasting 20 days; from day 17 the line under the
  // thread head warns, with the wireframe's words (03.B).
  public static let whatsAppPickHeadline = "Pick a chat."
  public static let whatsAppPickDetail = "Every chat this Mac holds is in the list. This board reads only."
  public static let whatsAppSessionDays = 20
  public static let whatsAppRelinkWarnDay = 17
  public static func whatsAppLinkedLine(days: Int, clock: String) -> String {
    days == 1 ? "1 day linked as of \(clock)" : "\(days) days linked as of \(clock)"
  }
  public static func whatsAppRelinkWarning(daysLeft: Int) -> String {
    daysLeft <= 1
      ? "Re-link expected in about a day. Do it before expiry, not after."
      : "Re-link expected in about \(daysLeft) days. Do it before expiry, not after."
  }

  // D-UI-142: an expired or re-linking device replaces the transcript (not
  // the whole window) with the re-link card: a QR frame holding a drawn
  // placeholder, never a real code and never a network fetch, the
  // wireframe's steps, and the device-slot caveat without a slot count the
  // bridge cannot serve.
  public static let whatsAppExpiredLine = "WhatsApp session expired. Nothing sends or arrives until you re-link."
  public static let whatsAppRelinkingLine = "Re-linking. This Mac is waiting for the phone to scan the code."
  public static let whatsAppScanTitle = "Scan from your phone"
  public static let whatsAppScanSteps =
    "WhatsApp, Settings, Linked Devices, Link a Device. This QR refreshes every 20 seconds. Your messages stay on this Mac; only the session is renewed."
  public static let whatsAppSlotsLine =
    "If the scan fails with \u{201C}device limit reached,\u{201D} remove a linked device on the phone first."
  public static let whatsAppQRSide: Double = 132
  public static let whatsAppQRPlaceholder = "QR code placeholder"
  public static let whatsAppRelinkCardWidth: Double = 300

  // D-UI-143: the history horizon is a centred line above the first message
  // at or after it (at the top when every message is), with the partial
  // history caveat; the end-to-end line sits above it, once per chat.
  public static func whatsAppHorizonLine(day: String) -> String { "History before \(day) is on your phone." }
  public static let whatsAppHorizonDetail = "A linked device receives a partial history. Older messages stay on the phone."
  public static let whatsAppHorizonDayFormat = "MMM d"
  public static let whatsAppE2ELine =
    "Messages are end-to-end encrypted. This Mac is a linked device; the keys live on your phone."

  // D-UI-144: the phone panel is a bordered card at the foot of the thread,
  // where a composer would be: the phone's state, WhatsApp's own sentence
  // quoted, and that this board does not send (03.C).
  public static let whatsAppPhoneTitle = "On your phone"
  public static let whatsAppPhoneOnline = "Phone online. Older history arrives while it stays online."
  public static let whatsAppPhoneOffline = "Phone offline. Nothing new reaches this Mac until it is back."
  public static let whatsAppPhoneUnknown = "Phone state unknown to this device."
  public static let whatsAppPhoneQuote =
    "\u{201C}This feature isn't available on Mac. Please use your primary device.\u{201D}"
  public static let whatsAppReadsOnly = "Nothing sends from this board. Reply on your phone."

  // D-UI-145: a voice note draws its transcript by default with its
  // duration (08.E's body); a sent note says its played state is unknown,
  // never that it was heard (03.D legend 2).
  public static let whatsAppVoicePlayed = "played state unknown to this device"
  public static let whatsAppVoiceNoTranscript = "Voice note, transcript not made yet"

  // D-UI-146: reactions sit under their bubble, one chip per emoji with its
  // count, in the emoji's text presentation, on the tint at .12 alpha. One
  // reaction per person: a later one from the same person replaces theirs.
  public static let whatsAppReactionAlpha: Double = 0.12
  public enum ReactionPlacement: Sendable {
    case underBubble
  }
  public static let whatsAppReactionPlacement: ReactionPlacement = .underBubble

  // D-UI-147: disappearing, view-once and poll messages are dashed "not
  // shown" cards with a title and a reason, and no control to open them
  // (03.F).
  public static let whatsAppDisappearingTitle = "Disappearing message"
  public static let whatsAppDisappearingDetail = "Disappearing messages are on. Read this chat on your phone."
  public static let whatsAppViewOnceTitle = "View-once photo, not shown"
  public static let whatsAppViewOnceDetail =
    "Opening it here would mark it viewed without your intent, and once viewed it is gone. Open on your phone."
  public static let whatsAppPollTitle = "Poll, not shown"
  public static let whatsAppPollDetail = "Vote on your phone. The bridge has no vote route yet."

  // D-UI-148: the thread head's line. One to one: the channel, the number,
  // when it was opened here and that no receipt was sent. A group: its
  // size and who may send, and its unnamed members by number (03.G).
  public static let whatsAppOpenedHere = "opened here"
  public static let whatsAppNoReceipt = "no receipt sent, still unread on your phone"
  public static func whatsAppGroupLine(members: Int, adminOnly: Bool) -> String {
    "WhatsApp group \u{00B7} \(members) members" + (adminOnly ? " \u{00B7} only admins can send" : "")
  }
  public static func whatsAppAdminOnlyLine(admins: Int) -> String {
    admins == 1
      ? "Only admins can send messages in this group. 1 admin."
      : "Only admins can send messages in this group. \(admins) admins."
  }
  public static let whatsAppNoName = "no name yet"

  // D-UI-149: media the phone has not sent is a dashed tile with a down
  // arrow, its kind and size, and never a play glyph or a duration (03.H).
  // Pressing it says why nothing happened; it never fetches.
  public static let whatsAppMediaArrow = "\u{2193}"
  public static let whatsAppMediaNote = "Download on demand is not built yet. Nothing was fetched."
}
