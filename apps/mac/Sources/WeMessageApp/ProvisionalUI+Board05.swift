import Foundation

// PROVISIONAL pending Eric's D-UI-136, 139 and 150..159 decisions (v2 B2,
// board 05, Email over fixtures). D-UI-136 and 139 are the plan's rows 106
// and 109 renumbered +30 past the tree's rows; D-UI-150..159 are the
// defaults this build took where board 05 leaves a choice open. The same
// rule as ProvisionalUI.swift holds here: every value is a default chosen
// so the board can be built and tested before the questions are answered,
// this file is the whole edit when they are, and Board05HygieneTests'
// H-B-3 row fails if a copy string here is repeated as a literal in another
// app or UI test source. 05.H (the open protocol moves UI budget to email) is
// recorded in apps/mac/README.md and has no UI.
extension ProvisionalUI {
  // D-UI-136: the reading pane draws each message as a card, never a
  // bubble, at a 68 character measure: the width of 68 figure zeros in the
  // 13 pt body face, plus the card's padding on both sides. Cards stack
  // oldest first and centre in the pane.
  public enum EmailLayout: Sendable {
    case cardsAtMeasure
  }
  public static let emailLayout: EmailLayout = .cardsAtMeasure
  public static let emailMeasureChars: Double = 68
  public static let emailBodySize: Double = 13
  public static let emailCardPadding: Double = 16
  public static let emailCardSpacing: Double = 10

  // D-UI-139: Hold until is parked. It is drawn in the compose row,
  // disabled, with its reason beside it; it never opens a picker.
  public static let emailHoldLabel = "Hold until\u{2026}"
  public static let emailHoldParked = "Scheduling is parked in this version."

  // D-UI-150: the Email board's banner names the channel, then the
  // mailbox the fixture thread lives in; the fixture chip (D-UI-132) sits
  // at its trailing edge, as on board 03.
  public static let emailBannerName = "Email."
  public static func emailBanner(account: String?) -> String {
    guard let account, !account.isEmpty else { return emailBannerName }
    return emailBannerName + " " + account
  }

  // D-UI-151: the category chips (05.G) sit in the sidebar under the All
  // row while the Email tile is selected and its board is drawn. One chip
  // at a time filters the list; the same chip again clears the filter.
  public enum EmailChipPlacement: Sendable {
    case sidebarUnderAll
  }
  public static let emailChipPlacement: EmailChipPlacement = .sidebarUnderAll
  public static let emailChipsLabel = "Mail categories"

  // D-UI-152: the Email board with no thread open.
  public static let emailEmptyHeadline = "Pick a thread to read it as cards."
  public static let emailEmptyDetail = "Send on this board makes a draft for Needs You. It never mails anyone."

  // D-UI-153: a long thread shows its last three messages open; the ones
  // before fold into one row that opens them all.
  public static let emailExpandedCount = 3
  public static func emailEarlier(_ count: Int) -> String {
    count == 1 ? "1 earlier message" : "\(count) earlier messages"
  }

  // D-UI-154: remote images are blocked until revealed. The line says how
  // many and how many trackers, and the reveal is one button per message.
  public static func emailImagesBlocked(_ images: Int, trackers: Int) -> String {
    let what = images == 1 ? "1 remote image blocked" : "\(images) remote images blocked"
    guard trackers > 0 else { return what + "." }
    return what + ", " + (trackers == 1 ? "1 tracker" : "\(trackers) trackers") + " among them."
  }
  public static let emailLoadImages = "Load images"
  public static let emailImagesShown = "Images loaded for this message only."

  // D-UI-155: an invite is an object card from the message's inviteObject:
  // title, when, where, organizer and the guests' answers. No RSVP control
  // exists in this version, and the card says so.
  public static let emailInviteHeader = "Invitation"
  public static let emailInviteNoAnswer = "Answering an invite from here is not in this version."
  public static func emailInviteCounts(accepted: Int, awaiting: Int, declined: Int) -> String {
    "\(accepted) going, \(awaiting) not answered, \(declined) declined"
  }

  // D-UI-156: compose opens inline under the last card, never a second
  // window: To, Cc, Bcc, Subject and the body, then the parked Hold until,
  // then Send. Send opens the message's undo window (the fixture's 30 s);
  // when it runs out, a draft is created for Needs You. Nothing is mailed.
  // The body takes the keyboard as the compose opens, so shift-R then
  // typing writes the reply.
  public enum EmailComposePlacement: Sendable {
    case inlineUnderLastCard
  }
  public static let emailComposePlacement: EmailComposePlacement = .inlineUnderLastCard
  public static let emailFieldTo = "To"
  public static let emailFieldCc = "Cc"
  public static let emailFieldBcc = "Bcc"
  public static let emailFieldSubject = "Subject"
  public static let emailBodyPrompt = "Write the reply here"
  public static let emailSendLabel = "Send"
  public static let emailUndoLabel = "Undo"
  public static let emailDiscardLabel = "Discard"
  public static func emailUndoLine(_ seconds: Int) -> String {
    "Becomes a draft in \(seconds)s. Nothing has left this Mac."
  }
  public static let emailComposingLine = "Send opens an undo window, then makes a draft. Nothing is mailed."
  public static let emailDraftingLine = "Making the draft."
  public static let emailDraftedLine = "Waiting in Needs You as a draft. Nothing was mailed."
  public static let emailDraftFailed = "The daemon did not take the draft. Nothing was mailed; the text is still here."

  // D-UI-157: the attachment wall (05.D) is a line above Send: a warning
  // from 20 MB, a block from 25 MB that disables Send. The thresholds are
  // the kit's EmailSizeWall; the words are these.
  public static func emailWallWarn(_ size: String, limit: String) -> String {
    size + " attached. Many mail servers turn away messages this large; " + limit + " is the cap here."
  }
  public static func emailWallBlock(_ size: String, limit: String) -> String {
    size + " attached, over the " + limit + " cap. Remove a file before this can become a draft."
  }

  // D-UI-158: the thread's verbs sit under the last card: Reply, Reply
  // all with its key printed (shift-R, 05.C), Forward. Reply all is also
  // shift-R wherever the list keys are heard.
  public static let emailReplyLabel = "Reply"
  public static let emailReplyAllLabel = "Reply all"
  public static let emailReplyAllKey = "\u{21E7}R"
  public static let emailForwardLabel = "Forward"

  // D-UI-159: a reveal is per message and lasts for this window only:
  // reopening the app, or another message in the same thread, starts
  // blocked again.
  public enum EmailRevealScope: Sendable {
    case perMessagePerSession
  }
  public static let emailRevealScope: EmailRevealScope = .perMessagePerSession
}
